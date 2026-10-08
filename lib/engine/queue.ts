import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { after } from "next/server";
import { getDb, schema } from "@/lib/db/client";
import { loadRunGraph } from "./run-workflow";
import { runNode } from "./run-node";

// Mode otomatis penuh: setiap node dijalankan sebagai satu job di antrean.
// Dengan QSTASH_TOKEN → Upstash QStash memanggil POST /api/jobs/step.
// Tanpa QStash (pengembangan lokal) → job dijalankan di proses yang sama setelah respons dikirim.

export const MAX_JOB_ATTEMPTS = 3;

export function queueBackend(): "qstash" | "local" {
  return process.env.QSTASH_TOKEN ? "qstash" : "local";
}

async function insertJobIfAbsent(runId: string, nodeKey: string) {
  const db = await getDb();
  // UNIQUE (run_id, node_key) mencegah satu node dijalankan dua kali ketika dua induknya selesai bersamaan.
  const rows = await db.insert(schema.jobs).values({ runId, nodeKey }).onConflictDoNothing().returning();
  return rows.length > 0;
}

async function publish(runId: string, nodeKey: string) {
  if (queueBackend() === "qstash") {
    const { Client } = await import("@upstash/qstash");
    const client = new Client({ token: process.env.QSTASH_TOKEN! });
    await client.publishJSON({ url: `${process.env.APP_URL}/api/jobs/step`, body: { runId, nodeKey }, retries: MAX_JOB_ATTEMPTS - 1 });
    return;
  }
  const task = () => processJob(runId, nodeKey).catch((e) => console.error("[queue] job gagal", e));
  try {
    after(task);
  } catch {
    void task(); // di luar konteks request (mis. dari dalam job lain)
  }
}

/** Masukkan semua node yang induknya sudah done ke antrean (idempoten). */
export async function enqueueReady(runId: string) {
  const db = await getDb();
  const { run, graph } = await loadRunGraph(runId);
  if (run.config.mode !== "auto") return [];
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  const status = new Map(nrs.map((n) => [n.nodeKey, n.status]));
  const done = new Set(nrs.filter((n) => n.status === "done").map((n) => n.nodeKey));
  const ready = graph.nodes.filter(
    (n) => !done.has(n.key!) && status.get(n.key!) === "pending" && graph.parents(n.key!).every((p) => done.has(p)),
  );
  const queued: string[] = [];
  for (const n of ready) {
    const inserted = await insertJobIfAbsent(runId, n.key!);
    if (inserted) {
      await publish(runId, n.key!);
      queued.push(n.key!);
    }
  }
  return queued;
}

/** POST /api/runs/[id]/start: alihkan run ke mode otomatis dan antrekan node yang siap. */
export async function startAuto(runId: string) {
  const db = await getDb();
  const { run } = await loadRunGraph(runId);
  await db.update(schema.runs).set({ config: { ...run.config, mode: "auto" }, status: "running" }).where(eq(schema.runs.id, runId));
  // Job gagal sebelumnya dihapus agar node bisa dilanjutkan dari titik terakhir.
  await db.delete(schema.jobs).where(and(eq(schema.jobs.runId, runId), inArray(schema.jobs.status, ["failed", "queued"])));
  await db
    .update(schema.nodeRuns)
    .set({ status: "pending", error: null })
    .where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.status, "failed")));
  return enqueueReady(runId);
}

/**
 * Jalankan satu job. Mengembalikan "retry" bila gagal tetapi masih boleh dicoba ulang
 * (route mengembalikan 500 agar QStash mengulang), "failed" setelah 3 percobaan.
 */
export async function processJob(runId: string, nodeKey: string): Promise<"done" | "waiting_review" | "retry" | "failed" | "skipped"> {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.runId, runId), eq(schema.jobs.nodeKey, nodeKey)));
  if (!job || job.status === "done" || job.status === "waiting_review" || job.status === "running") return "skipped";
  await db
    .update(schema.jobs)
    .set({ status: "running", attempts: job.attempts + 1, updatedAt: new Date() })
    .where(eq(schema.jobs.id, job.id));
  const [nr] = await db
    .select()
    .from(schema.nodeRuns)
    .where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.nodeKey, nodeKey)));
  if (nr.status === "done") {
    await db.update(schema.jobs).set({ status: "done", updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    await enqueueReady(runId);
    return "done";
  }
  const status = await runNode(nr.id);
  if (status === "done") {
    await db.update(schema.jobs).set({ status: "done", updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    await enqueueReady(runId); // anak-anak yang semua induknya done masuk antrean; strategi fungsional paralel
    return "done";
  }
  if (status === "needs_review") {
    // Node dengan tinjauan aktif berhenti di sini; route tinjauan mengantrekan anak-anaknya setelah disetujui.
    await db.update(schema.jobs).set({ status: "waiting_review", updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    return "waiting_review";
  }
  const [fresh] = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.id, nr.id));
  if (job.attempts + 1 < MAX_JOB_ATTEMPTS) {
    await db.update(schema.jobs).set({ status: "queued", lastError: fresh.error, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    await db.update(schema.nodeRuns).set({ status: "pending" }).where(eq(schema.nodeRuns.id, nr.id));
    if (queueBackend() === "local") await processJob(runId, nodeKey);
    return "retry";
  }
  await db.update(schema.jobs).set({ status: "failed", lastError: fresh.error, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
  return "failed";
}
