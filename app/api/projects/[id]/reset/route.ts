import { and, eq, inArray } from "drizzle-orm";
import { handle, requireProject } from "@/lib/access";
import { getDb, schema } from "@/lib/db/client";
import { ARCHIVE_TAG, ensureMainRun, getCanvas, getMainRun } from "@/lib/engine/main-run";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "Ulang dari awal": run utama diarsipkan (tag "arsip", tetap tersimpan sebagai data eksperimen/TA beserta log AI-nya)
 * lalu run utama baru dibuat kosong. Dokumen input dan jawaban pertanyaan agen tidak berubah.
 */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const wf = await getCanvas(id);
  const db = await getDb();
  const old = await getMainRun(wf.id);
  if (old) {
    await db
      .update(schema.jobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(schema.jobs.runId, old.id), inArray(schema.jobs.status, ["queued", "running"])));
    await db.update(schema.runs).set({ experimentTag: ARCHIVE_TAG, archivedAt: new Date() }).where(eq(schema.runs.id, old.id));
  }
  const run = await ensureMainRun(wf.id, wf.graph);
  return { runId: run.id, archivedRunId: old?.id ?? null };
});
