import { handle, projectOfRun, requireProject } from "@/lib/access";
import { pauseRun } from "@/lib/engine/queue";

type Ctx = { params: Promise<{ id: string }> };

/** Hentikan sementara run eksperimen; lanjutkan lagi lewat POST /api/runs/[id]/start. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  await pauseRun(id);
  return { ok: true };
});
