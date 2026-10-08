import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { handle, requireProject } from "@/lib/access";
import { getCanvas, getMainRun } from "@/lib/engine/main-run";
import { canvasWarnings } from "@/lib/engine/canvas";
import { recoverStuckNodes } from "@/lib/engine/run-node";
import { isNodeKey } from "@/lib/nodes/registry";
import { isCustomKey } from "@/lib/nodes/custom";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Semua yang dibutuhkan halaman canvas: proyek, graf canvas, dokumen per node input,
 * hasil terakhir setiap analisis (run utama) beserta bukti, riwayat validasi, biaya, tinjauan, dan pertanyaan agen.
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const db = await getDb();
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  const wf = await getCanvas(id);
  const run = await getMainRun(wf.id);
  if (run) await recoverStuckNodes(run.id); // node "berjalan" yang prosesnya sudah mati → gagal, bisa dicoba lagi

  const documents = await queryRows<{ id: string; filename: string; input_node: string | null; is_values: boolean; created_at: string; chars: number; chunks: number }>(sql`
    SELECT d.id, d.filename, d.input_node, d.is_values, d.created_at, length(d.raw_text)::int AS chars,
           (SELECT COUNT(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunks
    FROM documents d WHERE d.project_id = ${id} ORDER BY d.created_at`);

  // Hasil analisis yang sudah tidak dikenal (node bawaan lama sebelum penggantian node) tidak ditampilkan.
  const nodeRuns = (run ? await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, run.id)) : []).filter(
    (n) => isNodeKey(n.nodeKey) || isCustomKey(n.nodeKey),
  );
  const ids = nodeRuns.map((n) => n.id);
  const validation = ids.length
    ? await db
        .select()
        .from(schema.validationEvents)
        .where(and(inArray(schema.validationEvents.nodeRunId, ids), isNull(schema.validationEvents.injectionId)))
        .orderBy(schema.validationEvents.attempt)
    : [];
  const costs = ids.length
    ? await queryRows<{ node_run_id: string; purpose: string; tokens: number; calls: number }>(sql`
        SELECT node_run_id, purpose, SUM(tokens_in + tokens_out)::int AS tokens, COUNT(*)::int AS calls
        FROM llm_calls WHERE injection_id IS NULL AND node_run_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
        GROUP BY node_run_id, purpose`)
    : [];
  const reviews = ids.length ? await db.select().from(schema.reviews).where(inArray(schema.reviews.nodeRunId, ids)) : [];
  const questions = await db
    .select({
      id: schema.agentQuestions.id,
      nodeRunId: schema.agentQuestions.nodeRunId,
      nodeKey: schema.nodeRuns.nodeKey,
      label: schema.agentQuestions.label,
      question: schema.agentQuestions.question,
      answer: schema.agentQuestions.answer,
      answeredAt: schema.agentQuestions.answeredAt,
      createdAt: schema.agentQuestions.createdAt,
    })
    .from(schema.agentQuestions)
    .innerJoin(schema.nodeRuns, eq(schema.nodeRuns.id, schema.agentQuestions.nodeRunId))
    .where(eq(schema.agentQuestions.projectId, id))
    .orderBy(desc(schema.agentQuestions.createdAt));

  const nodes = Object.fromEntries(
    nodeRuns.map((n) => [
      n.nodeKey,
      {
        nodeRunId: n.id,
        status: n.status,
        phase: n.phase, // tahap berjalan untuk animasi: retrieve|generate|validate|repair|review
        output: n.output,
        evidence: n.input?.evidence ?? [],
        validationPassed: n.validationPassed,
        validatorEnabled: n.validatorEnabled,
        humanEnabled: n.humanEnabled,
        error: n.error,
        attempts: n.attempts,
        formatFailures: n.formatFailures,
        startedAt: n.startedAt,
        finishedAt: n.finishedAt,
        // Perubahan manusia pada hasil (path sel yang diubah) — sel ditandai "diubah manusia" di tabel.
        edits: n.edits ?? [],
        editedAt: n.editedAt,
        tokens: Object.fromEntries(costs.filter((c) => c.node_run_id === n.id).map((c) => [c.purpose, c.tokens])),
        validation: validation.filter((v) => v.nodeRunId === n.id),
        review: reviews.filter((r) => r.nodeRunId === n.id).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] ?? null,
      },
    ]),
  );

  return {
    project,
    workflowId: wf.id,
    canvas: wf.graph,
    warnings: canvasWarnings(wf.graph),
    runId: run?.id ?? null,
    nodes,
    documents,
    questions,
  };
});

const Patch = z.object({ name: z.string().min(2).optional(), orgType: z.string().nullable().optional(), description: z.string().nullable().optional() });

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = Patch.parse(await req.json());
  const db = await getDb();
  const [project] = await db.update(schema.projects).set(body).where(eq(schema.projects.id, id)).returning();
  return { project };
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const db = await getDb();
  await db.delete(schema.projects).where(eq(schema.projects.id, id));
  return { ok: true };
});
