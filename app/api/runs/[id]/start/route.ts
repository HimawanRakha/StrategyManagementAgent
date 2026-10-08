import { handle, projectOfRun, requireProject } from "@/lib/access";
import { queueBackend, startAuto } from "@/lib/engine/queue";

// Satu analisis bisa butuh beberapa panggilan AI (masing-masing ≤ LLM_CALL_TIMEOUT_MS). 300 dtk = batas Vercel (Fluid Compute) paket Hobby.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Memulai mode otomatis penuh: semua node yang induknya selesai masuk tabel jobs dan antrean. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const queued = await startAuto(id);
  return { queued, backend: queueBackend() };
});
