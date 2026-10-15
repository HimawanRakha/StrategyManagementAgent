import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { Placement, RunConfig } from "@/lib/db/schema";
import { Graph } from "./graph";
import { engineGraph, normalizeGraph } from "./canvas";
import { recoverStuckNodes, refreshRunStatus, runNode } from "./run-node";

export async function loadRunGraph(runId: string) {
  const db = await getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error("Run tidak ditemukan");
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId));
  const eg = engineGraph(normalizeGraph(wf.graph));
  return { run, wf, graph: new Graph(eg), engine: eg };
}

/** Buat run dengan experiment_tag dan penempatan validator/tinjauan per node, beserta node_runs-nya. */
export async function createRun(input: {
  workflowId: string;
  experimentTag: string;
  placement?: Placement;
  model?: string;
  temperature?: number;
  mode?: "manual" | "auto";
  createdBy?: string;
  /** Memori inti organisasi (bawaan: aktif). */
  contextMemory?: boolean;
}) {
  const db = await getDb();
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, input.workflowId));
  if (!wf) throw new Error("Alur tidak ditemukan");
  const eg = engineGraph(normalizeGraph(wf.graph));
  if (!eg.nodes.length) throw new Error("Canvas belum punya node analisis");
  const placement: Placement = {};
  for (const n of eg.nodes) {
    const key = n.key!;
    placement[key] = {
      validator: input.placement?.[key]?.validator ?? n.validator ?? false,
      human: input.placement?.[key]?.human ?? n.human ?? false,
    };
  }
  const config: RunConfig = {
    placement,
    model: input.model || undefined,
    temperature: input.temperature,
    mode: input.mode ?? "manual",
    contextMemory: input.contextMemory ?? true,
  };
  const [run] = await db
    .insert(schema.runs)
    .values({ workflowId: wf.id, experimentTag: input.experimentTag || "baseline", config, createdBy: input.createdBy })
    .returning();
  await db.insert(schema.nodeRuns).values(
    eg.nodes.map((n) => ({
      runId: run.id,
      nodeKey: n.key!,
      validatorEnabled: placement[n.key!].validator,
      humanEnabled: placement[n.key!].human,
    })),
  );
  return run;
}

/** Node yang siap dijalankan: belum selesai/berjalan/menunggu tinjauan dan semua induknya done. */
export async function readyNodes(runId: string, until?: string) {
  const db = await getDb();
  await recoverStuckNodes(runId);
  const { graph } = await loadRunGraph(runId);
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  const status = new Map(nrs.map((n) => [n.nodeKey, n.status]));
  // Mode "sampai node tertentu" hanya menjalankan leluhur node target (dan target itu sendiri).
  const scope = until ? new Set([...graph.ancestors(until), until]) : new Set(graph.keys);
  return graph
    .topoOrder()
    .filter((k) => scope.has(k))
    .filter((k) => ["pending", "failed"].includes(status.get(k) ?? "pending"))
    .filter((k) => graph.parents(k).every((p) => status.get(p) === "done"));
}

/**
 * Jalankan SATU node per request (agar tidak terkena batas waktu fungsi serverless):
 * node tertentu bila `node` diberikan, atau node siap berikutnya menuju `until`.
 * UI memanggil lagi sampai `remaining` kosong. Node yang sudah done dilewati, sehingga run bisa dilanjutkan.
 */
export async function executeStep(runId: string, opts: { node?: string; until?: string }) {
  const db = await getDb();
  const { graph } = await loadRunGraph(runId);
  let target: string | undefined;
  if (opts.node) {
    if (!graph.keys.includes(opts.node)) throw new Error(`Node ${opts.node} tidak ada di alur ini`);
    const ready = await readyNodes(runId);
    if (!ready.includes(opts.node)) {
      const [nr] = await db
        .select()
        .from(schema.nodeRuns)
        .where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.nodeKey, opts.node)));
      return { ran: null, status: nr?.status, remaining: await readyNodes(runId, opts.until), message: `Node ${opts.node} belum siap (status ${nr?.status}, atau induknya belum selesai)` };
    }
    target = opts.node;
  } else {
    target = (await readyNodes(runId, opts.until))[0];
  }
  if (!target) {
    return { ran: null, status: await refreshRunStatus(runId), remaining: [], message: "Tidak ada node yang siap dijalankan" };
  }
  const [nr] = await db
    .select()
    .from(schema.nodeRuns)
    .where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.nodeKey, target)));
  const status = await runNode(nr.id);
  const remaining = opts.node ? [] : await readyNodes(runId, opts.until);
  return { ran: target, status, remaining, message: null as string | null };
}

/** Ulangi node: kosongkan output node itu dan semua turunannya. */
export async function resetNode(runId: string, nodeKey: string) {
  const db = await getDb();
  const { graph } = await loadRunGraph(runId);
  const keys = [nodeKey, ...graph.descendants(nodeKey)];
  await db
    .update(schema.nodeRuns)
    .set({ status: "pending", output: null, raw: null, edits: [], editedAt: null, error: null, validationPassed: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.nodeRuns.runId, runId), inArray(schema.nodeRuns.nodeKey, keys)));
  await db.delete(schema.jobs).where(and(eq(schema.jobs.runId, runId), inArray(schema.jobs.nodeKey, keys)));
  await refreshRunStatus(runId);
  return keys;
}
