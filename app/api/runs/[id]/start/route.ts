import { handle, projectOfRun, requireProject } from "@/lib/access";
import { queueBackend, startAuto } from "@/lib/engine/queue";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** Memulai mode otomatis penuh: semua node yang induknya selesai masuk tabel jobs dan antrean. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const queued = await startAuto(id);
  return { queued, backend: queueBackend() };
});
