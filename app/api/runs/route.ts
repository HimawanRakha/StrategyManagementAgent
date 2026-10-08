import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { handle, projectOfWorkflow, requireProject } from "@/lib/access";
import { createRun } from "@/lib/engine/run-workflow";
import { startAuto } from "@/lib/engine/queue";
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
    return { runs: await db.select().from(schema.runs).where(eq(schema.runs.workflowId, workflowId)).orderBy(desc(schema.runs.createdAt)) };
  }
  if (projectId) {
    await requireProject(projectId);
    const wfs = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.projectId, projectId));
    if (!wfs.length) return { runs: [] };
    return {
      runs: await db.select().from(schema.runs).where(inArray(schema.runs.workflowId, wfs.map((w) => w.id))).orderBy(desc(schema.runs.createdAt)),
    };
  }
  throw new Error("Sertakan workflowId atau projectId");
});
