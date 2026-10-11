import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { handle, projectOfWorkflow, requireProject } from "@/lib/access";
import { createRun } from "@/lib/engine/run-workflow";
import { queueBackend, startAuto } from "@/lib/engine/queue";
import { RunBody } from "@/lib/api-schemas";

/** Membuat run dengan experiment_tag dan penempatan per node. */
export const POST = handle(async (req: Request) => {
  const body = RunBody.parse(await req.json());
  const { user } = await requireProject(await projectOfWorkflow(body.workflowId));
  const run = await createRun({ ...body, createdBy: user.id });
  const queued = body.mode === "auto" ? await startAuto(run.id) : [];
  return { run, queued };
});

/** Daftar run per proyek atau per alur. */
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const workflowId = url.searchParams.get("workflowId");
  const projectId = url.searchParams.get("projectId");
  const db = await getDb();
  if (workflowId) {
    await requireProject(await projectOfWorkflow(workflowId));
    return { backend: queueBackend(), runs: await db.select().from(schema.runs).where(eq(schema.runs.workflowId, workflowId)).orderBy(desc(schema.runs.createdAt)) };
  }
  if (projectId) {
    await requireProject(projectId);
    const wfs = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.projectId, projectId));
    if (!wfs.length) return { backend: queueBackend(), runs: [] };
    const runs = await db.select().from(schema.runs).where(inArray(schema.runs.workflowId, wfs.map((w) => w.id))).orderBy(desc(schema.runs.createdAt));
    // Keterangan run yang belum selesai: analisis yang sedang berjalan/gagal, keterangan terkini, dan jawaban AI terakhir.
    const open = runs.filter((r) => r.status !== "done").map((r) => r.id);
    const diag: Record<string, unknown> = {};
    if (open.length) {
      const rows = await queryRows<{
        run_id: string; node_key: string; status: string; phase: string | null; notice: string | null; notice_at: string | null;
        started_at: string | null; error: string | null; last_call: string | null;
      }>(sql`
        SELECT nr.run_id, nr.node_key, nr.status, nr.phase, nr.notice, nr.notice_at, nr.started_at, nr.error,
               (SELECT max(l.created_at) FROM llm_calls l WHERE l.node_run_id = nr.id) AS last_call
        FROM node_runs nr
        WHERE nr.run_id IN (${sql.join(open.map((x) => sql`${x}`), sql`, `)}) AND nr.status IN ('running', 'failed', 'needs_review')`);
      for (const id of open) {
        const mine = rows.filter((x) => x.run_id === id);
        diag[id] = {
          now: new Date().toISOString(),
          running: mine.filter((x) => x.status === "running").map((x) => ({ key: x.node_key, phase: x.phase, notice: x.notice, noticeAt: x.notice_at, startedAt: x.started_at, lastCall: x.last_call })),
          failed: mine.filter((x) => x.status === "failed").map((x) => ({ key: x.node_key, error: x.error })),
          review: mine.filter((x) => x.status === "needs_review").map((x) => x.node_key),
        };
      }
    }
    return { backend: queueBackend(), runs, diag };
  }
  throw new Error("Sertakan workflowId atau projectId");
});
