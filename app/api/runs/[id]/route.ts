import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { handle, projectOfRun, requireProject } from "@/lib/access";
import { Graph } from "@/lib/engine/graph";
import { engineGraph, normalizeGraph } from "@/lib/engine/canvas";

type Ctx = { params: Promise<{ id: string }> };

/** Detail run: output per node, bukti, riwayat validasi, biaya, tinjauan, pertanyaan agen, status antrean. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const projectId = await projectOfRun(id);
  const { user } = await requireProject(projectId);
  const db = await getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, id));
  const [workflow] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId));
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  const nodeRuns = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, id));
  const ids = nodeRuns.map((n) => n.id);
  const order = new Graph(engineGraph(normalizeGraph(workflow.graph))).topoOrder();
  nodeRuns.sort((a, b) => order.indexOf(a.nodeKey) - order.indexOf(b.nodeKey));

  const validation = ids.length
    ? await db
        .select()
        .from(schema.validationEvents)
        .where(and(inArray(schema.validationEvents.nodeRunId, ids), isNull(schema.validationEvents.injectionId)))
        .orderBy(schema.validationEvents.attempt)
    : [];
  const costs = ids.length
    ? await queryRows<{ node_run_id: string; purpose: string; calls: number; tokens_in: number; tokens_out: number; latency_ms: number; format_errors: number }>(sql`
        SELECT node_run_id, purpose, COUNT(*)::int AS calls, SUM(tokens_in)::int AS tokens_in, SUM(tokens_out)::int AS tokens_out,
               SUM(latency_ms)::int AS latency_ms, SUM(CASE WHEN format_error THEN 1 ELSE 0 END)::int AS format_errors
        FROM llm_calls WHERE injection_id IS NULL AND node_run_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
        GROUP BY node_run_id, purpose`)
    : [];
  const reviews = ids.length ? await db.select().from(schema.reviews).where(inArray(schema.reviews.nodeRunId, ids)) : [];
  const questions = ids.length ? await db.select().from(schema.agentQuestions).where(inArray(schema.agentQuestions.nodeRunId, ids)) : [];
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.runId, id));

  return { run, workflow, project, user: { id: user.id, name: user.name }, nodeRuns, validation, costs, reviews, questions, jobs, order };
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const db = await getDb();
  await db.delete(schema.runs).where(eq(schema.runs.id, id));
  return { ok: true };
});
