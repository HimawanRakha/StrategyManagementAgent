import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { handle, requireProject } from "@/lib/access";
import { getCanvas, getMainRun } from "@/lib/engine/main-run";
import { canvasWarnings } from "@/lib/engine/canvas";
import { recoverStuckNodes } from "@/lib/engine/run-node";
import { loadRunNodes } from "@/lib/engine/run-report";

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

  const documents = await queryRows<{
    id: string; filename: string; input_node: string | null; is_values: boolean; created_at: string; chars: number; chunks: number;
    reviewed_at: string | null; quality: unknown;
  }>(sql`
    SELECT d.id, d.filename, d.input_node, d.is_values, d.created_at, d.reviewed_at, d.quality, length(d.raw_text)::int AS chars,
           (SELECT COUNT(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunks
    FROM documents d WHERE d.project_id = ${id} ORDER BY d.created_at`);

  const nodes = await loadRunNodes(run?.id ?? null);
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
