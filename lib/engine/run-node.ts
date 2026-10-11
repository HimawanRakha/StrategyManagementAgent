import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { EvidenceChunk, NodeRunStatus } from "@/lib/db/schema";
import { chunksByLabel, chunksOfInputs, retrieve } from "@/lib/rag/retrieve";
import type { CheckResult, Failure, LlmSession, NodeContext, NodeDef } from "@/lib/nodes/types";
import { pretty } from "@/lib/nodes/prompt";
import { createLlmSession } from "./llm-session";
import { canvasNodeOf, connectedInputIds, labelOf as labelOfKey, normalizeGraph } from "./canvas";
import { resolveNode } from "./resolve";

export const MAX_REPAIR_ATTEMPTS = Number(process.env.MAX_REPAIR_ATTEMPTS ?? 2);

export type ValidationReport = { passed: boolean; checks: CheckResult[]; failures: Failure[] };

export async function runValidators(def: NodeDef, out: unknown, ctx: NodeContext, llm: LlmSession): Promise<ValidationReport> {
  const checks = def.validate ? await def.validate(out, ctx, llm) : [];
  const failures = checks.flatMap((c) => c.failures);
  return { passed: failures.length === 0, checks, failures };
}

export async function logValidation(nodeRunId: string, attempt: number, report: ValidationReport, injectionId?: string) {
  if (!report.checks.length) return;
  const db = await getDb();
  await db.insert(schema.validationEvents).values(
    report.checks.map((c) => ({
      nodeRunId,
      injectionId: injectionId ?? null,
      attempt,
      checkName: c.check,
      passed: c.passed,
      detail: { kind: c.kind, failures: c.failures, ...(c.label ? { label: c.label } : {}) },
    })),
  );
}

/** Prompt perbaikan: pola prompt node + daftar kegagalan validator; hanya item yang ditolak yang diperbaiki. */
export async function repair(def: NodeDef, ctx: NodeContext, out: unknown, failures: Failure[], llm: LlmSession) {
  if (!def.prompt) return out;
  const p = def.prompt(ctx);
  const user = `${p.user}

OUTPUT SEBELUMNYA:
${pretty(out)}

KEGAGALAN DARI VALIDATOR:
${failures.map((f) => `- ${f.message}`).join("\n")}

${def.repairHint ?? "Perbaiki hanya item yang ditolak; item lain salin apa adanya."}
Balas dengan JSON LENGKAP (semua item) sesuai skema.`;
  return llm.json("repair", p.system, user, def.schema, () => (def.mock ? def.mock(ctx) : out));
}

/** Muat konteks node: output semua node yang sudah selesai di run ini + info proyek. */
export async function loadContext(nodeRunId: string) {
  const db = await getDb();
  const [nr] = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.id, nodeRunId));
  if (!nr) throw new Error("node run tidak ditemukan");
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, nr.runId));
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId));
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, wf.projectId));
  const done = await db
    .select({ nodeKey: schema.nodeRuns.nodeKey, output: schema.nodeRuns.output })
    .from(schema.nodeRuns)
    .where(and(eq(schema.nodeRuns.runId, nr.runId), eq(schema.nodeRuns.status, "done")));
  const inputs = Object.fromEntries(done.filter((d) => d.nodeKey !== nr.nodeKey).map((d) => [d.nodeKey, d.output]));
  const ctx: NodeContext = {
    projectId: project.id,
    projectName: project.name,
    orgType: project.orgType,
    description: project.description,
    runId: run.id,
    nodeRunId: nr.id,
    inputs,
    evidence: nr.input?.evidence ?? [],
  };
  const graph = normalizeGraph(wf.graph);
  return { nr, run, wf, project, ctx, graph };
}

async function nextQuestionLabel(projectId: string) {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`coalesce(max(substring(${schema.agentQuestions.label} from 2)::int), 0)` })
    .from(schema.agentQuestions)
    .where(eq(schema.agentQuestions.projectId, projectId));
  return Number(n);
}

/** Pertanyaan agen ke pengguna saat bukti kurang (gagal validasi setelah perbaikan maksimum, atau faktor "unsupported"). */
export async function askUser(ctx: NodeContext, questions: string[]) {
  const uniq = [...new Set(questions)].slice(0, 6);
  if (!uniq.length) return;
  const db = await getDb();
  const existing = await db
    .select({ q: schema.agentQuestions.question })
    .from(schema.agentQuestions)
    .where(eq(schema.agentQuestions.nodeRunId, ctx.nodeRunId));
  const have = new Set(existing.map((e) => e.q));
  let n = await nextQuestionLabel(ctx.projectId);
  const rows = uniq.filter((q) => !have.has(q)).map((question) => ({
    nodeRunId: ctx.nodeRunId,
    projectId: ctx.projectId,
    label: `U${++n}`,
    question,
  }));
  if (rows.length) await db.insert(schema.agentQuestions).values(rows);
}

function questionsFromFailures(def: NodeDef, out: unknown, failures: Failure[]) {
  const items = new Map(def.items(out).map((i) => [i.id, i.text]));
  return failures
    .filter((f) => f.itemId)
    .map((f) => `${def.label} – ${f.itemId}${items.has(f.itemId!) ? ` ("${items.get(f.itemId!)}")` : ""}: ${f.message} Mohon beri bukti, konfirmasi, atau koreksi.`);
}

async function gatherEvidence(
  def: NodeDef,
  ctx: NodeContext,
  inputIds: string[] = [],
  scopeSetting?: "tersambung" | "semua",
): Promise<EvidenceChunk[]> {
  const queries = def.queries?.(ctx) ?? [];
  const extra = def.extraChunkIds?.(ctx) ?? [];
  // Dokumen dari node input yang panahnya masuk ke node ini SELALU dibaca, termasuk untuk analisis yang biasanya
  // tidak membaca dokumen (mis. IFAS/EFAS, TOWS). Bila ada input tersambung, node HANYA membaca input itu
  // (panah di canvas = sumber bacaan) kecuali diatur "semua dokumen"; tanpa input tersambung, node membaca semua dokumen proyek.
  const direct = def.kind === "code" ? [] : await chunksOfInputs(ctx.projectId, inputIds, queries.length ? 10 : 14);
  const onlyLinked = direct.length > 0 && (scopeSetting ?? "tersambung") === "tersambung";
  if (!queries.length && !extra.length && !direct.length) return [];
  const found = queries.length
    ? await retrieve(ctx.projectId, queries, onlyLinked ? { inputNodeIds: inputIds } : {})
    : [];
  const have = new Set(found.map((c) => c.id));
  const parentChunks = (await chunksByLabel(ctx.projectId, extra)).filter((c) => !have.has(c.id));
  parentChunks.forEach((c) => have.add(c.id));
  const directNew = direct.filter((c) => !have.has(c.id));
  // Bukti yang sudah ditemukan lewat pencarian tetap dipakai, tetapi ditandai bila juga berasal dari input tersambung.
  const directIds = new Set(direct.map((c) => c.id));
  const marked = found.map((c) => (directIds.has(c.id) ? { ...c, focus: "input tersambung" } : c));
  return [...marked, ...parentChunks, ...directNew];
}

/**
 * Siklus satu node: ambil bukti → hasilkan JSON → cek → perbaiki bila perlu → tinjau bila diaktifkan → simpan.
 * Ketika validator dimatikan, output langsung lanjut ke tinjauan atau disimpan (kondisi baseline eksperimen).
 */
/** Catat tahap yang sedang dikerjakan (untuk animasi progres di canvas). */
async function setPhase(nodeRunId: string, phase: string | null) {
  const db = await getDb();
  await db.update(schema.nodeRuns).set({ phase }).where(eq(schema.nodeRuns.id, nodeRunId));
}

/** Node run yang sedang dikerjakan proses server INI (disimpan di globalThis agar tahan muat ulang modul saat dev). */
const ACTIVE: Set<string> = ((globalThis as { __activeNodeRuns?: Set<string> }).__activeNodeRuns ??= new Set<string>());

/**
 * Pulihkan node yang tertinggal berstatus "running" karena prosesnya mati (server dimulai ulang, koneksi putus):
 * - basis data lokal (PGlite, satu proses): langsung, bila node itu tidak sedang dikerjakan proses ini;
 * - Postgres/serverless: bila sudah berjalan lebih lama dari STUCK_AFTER_MS (bawaan 15 menit).
 * Node ditandai gagal agar bisa diklik "Coba lagi" / ikut "Jalankan semua".
 */
export async function recoverStuckNodes(runId: string) {
  const db = await getDb();
  const running = await db.select().from(schema.nodeRuns).where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.status, "running")));
  const local = (process.env.DATABASE_URL ?? "pglite").startsWith("pglite");
  // Di Vercel fungsi dihentikan paksa setelah maxDuration (300 dtk) → node yang masih "running" setelah ±6 menit pasti terhenti.
  const limit = Number(process.env.STUCK_AFTER_MS ?? (process.env.VERCEL ? 6 * 60 * 1000 : 15 * 60 * 1000));
  const stuck = running.filter((n) => !ACTIVE.has(n.id) && (local || Date.now() - +new Date(n.startedAt ?? 0) > limit));
  for (const n of stuck)
    await db
      .update(schema.nodeRuns)
      .set({
        status: "failed",
        phase: null,
        finishedAt: new Date(),
        error: "Proses analisis ini terhenti sebelum selesai (server dimulai ulang atau koneksi terputus). Klik “Coba lagi”.",
      })
      .where(eq(schema.nodeRuns.id, n.id));
  if (stuck.length) await refreshRunStatus(runId);
  return stuck.length;
}

export async function runNode(nodeRunId: string): Promise<NodeRunStatus> {
  ACTIVE.add(nodeRunId);
  try {
    return await runNodeInner(nodeRunId);
  } finally {
    ACTIVE.delete(nodeRunId);
  }
}

async function runNodeInner(nodeRunId: string): Promise<NodeRunStatus> {
  const db = await getDb();
  const { nr, run, ctx, graph } = await loadContext(nodeRunId);
  await db
    .update(schema.nodeRuns)
    .set({
      status: "running",
      phase: "retrieve",
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      // Hasil baru dari AI menggantikan hasil lama beserta perubahan manusia di atasnya.
      edits: [],
      editedAt: null,
      notice: null,
      noticeAt: null,
      attempts: sql`${schema.nodeRuns.attempts} + 1`,
    })
    .where(eq(schema.nodeRuns.id, nodeRunId));
  // Riwayat pemeriksaan hanya untuk eksekusi terakhir (biaya tetap tercatat di llm_calls); hasil uji penyuntikan tidak dihapus.
  await db.delete(schema.validationEvents).where(and(eq(schema.validationEvents.nodeRunId, nodeRunId), isNull(schema.validationEvents.injectionId)));

  try {
    // Definisi efektif: bawaan/kustom + pengaturan pengguna di canvas
    const [lastReview] = await db
      .select({ approved: schema.reviews.approved, changes: schema.reviews.changes })
      .from(schema.reviews)
      .where(eq(schema.reviews.nodeRunId, nodeRunId))
      .orderBy(desc(schema.reviews.startedAt))
      .limit(1);
    const rejectNote = lastReview?.approved === false ? ((lastReview.changes as { note?: string } | null)?.note ?? null) : null;
    const { def, settings, validator, parents, label } = resolveNode(nr.nodeKey, graph, rejectNote);
    ctx.parents = parents;
    const llm = createLlmSession({
      nodeRunId,
      model: settings.model || run.config.model,
      temperature: settings.temperature ?? run.config.temperature,
    });
    const maxRepair = validator?.maxRepair ?? MAX_REPAIR_ATTEMPTS;
    const required = [...def.deps, ...parents];
    const missing = [...new Set(required)].filter((d) => ctx.inputs[d as keyof typeof ctx.inputs] === undefined);
    if (missing.length) throw new Error(`${label}: analisis sebelumnya belum selesai (${missing.map((m) => labelOfKey(graph, m)).join(", ")})`);

    const cnode = canvasNodeOf(graph, nr.nodeKey);
    ctx.evidence = await gatherEvidence(def, ctx, cnode ? connectedInputIds(graph, cnode.id) : [], settings.sourceScope);
    await db
      .update(schema.nodeRuns)
      .set({ input: { evidence: ctx.evidence, parents: Object.keys(ctx.inputs) } })
      .where(eq(schema.nodeRuns.id, nodeRunId));

    await setPhase(nodeRunId, "generate");
    let out: unknown;
    if (def.kind === "code") {
      out = await def.run!(ctx, llm);
    } else {
      const p = def.prompt!(ctx);
      out = await llm.json("generate", p.system, p.user, def.schema, () => def.mock!(ctx)); // purpose: generate
    }

    let passed: boolean | null = null;
    if (nr.validatorEnabled && def.validate) {
      for (let attempt = 0; ; attempt++) {
        await setPhase(nodeRunId, "validate");
        const report = await runValidators(def, out, ctx, llm); // kode + LLM
        await logValidation(nodeRunId, attempt, report);
        if (report.passed) {
          passed = true;
          break;
        }
        if (attempt >= maxRepair || def.kind === "code") {
          passed = false;
          await askUser(ctx, questionsFromFailures(def, out, report.failures)); // tanya pengguna
          break;
        }
        await setPhase(nodeRunId, "repair");
        out = await repair(def, ctx, out, report.failures, llm); // purpose: repair
      }
    }

    const unsupported = (out as { unsupported?: string[] }).unsupported;
    if (unsupported?.length) await askUser(ctx, unsupported.map((u) => `${def.label}: ${u}`));

    if (nr.humanEnabled) {
      // Simpan output mentah; kalkulator dijalankan setelah peninjau menyetujui.
      await db
        .update(schema.nodeRuns)
        .set({ status: "needs_review", phase: "review", output: out, raw: out, validationPassed: passed })
        .where(eq(schema.nodeRuns.id, nodeRunId));
      await refreshRunStatus(nr.runId);
      return "needs_review";
    }

    const final = def.compute ? def.compute(out, ctx) : out; // kalkulator kode
    await db
      .update(schema.nodeRuns)
      .set({ status: "done", phase: null, output: final, raw: out, validationPassed: passed, finishedAt: new Date() })
      .where(eq(schema.nodeRuns.id, nodeRunId));
    await refreshRunStatus(nr.runId);
    return "done";
  } catch (e) {
    await db
      .update(schema.nodeRuns)
      .set({ status: "failed", phase: null, error: (e as Error).message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(schema.nodeRuns.id, nodeRunId));
    await refreshRunStatus(nr.runId);
    return "failed";
  }
}

/** Setujui (opsional dengan perubahan peninjau), jalankan kalkulator, tandai done. */
export async function approveNodeRun(nodeRunId: string, changedOutput?: unknown) {
  const db = await getDb();
  const { nr, ctx, graph } = await loadContext(nodeRunId);
  const def = resolveNode(nr.nodeKey, graph).def;
  let out = changedOutput ?? nr.raw ?? nr.output;
  if (changedOutput !== undefined) {
    const parsed = def.schema.safeParse(changedOutput);
    if (!parsed.success) throw new Error("Perubahan peninjau tidak sesuai skema: " + parsed.error.issues[0]?.message);
    out = parsed.data;
  }
  const final = def.compute ? def.compute(out, ctx) : out;
  await db
    .update(schema.nodeRuns)
    .set({ status: "done", phase: null, output: final, raw: out, finishedAt: new Date() })
    .where(eq(schema.nodeRuns.id, nodeRunId));
  await refreshRunStatus(nr.runId);
  return nr;
}

export async function refreshRunStatus(runId: string) {
  const db = await getDb();
  const rows = await db.select({ status: schema.nodeRuns.status }).from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  const s = rows.map((r) => r.status);
  const status = s.every((x) => x === "done")
    ? "done"
    : s.includes("failed")
      ? "failed"
      : s.includes("running")
        ? "running"
        : s.includes("needs_review")
          ? "waiting_review"
          : s.some((x) => x === "done")
            ? "running"
            : "pending";
  await db.update(schema.runs).set({ status }).where(eq(schema.runs.id, runId));
  return status;
}
