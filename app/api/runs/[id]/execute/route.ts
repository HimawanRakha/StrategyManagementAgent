import { z } from "zod";
import { handle, projectOfRun, requireProject } from "@/lib/access";
import { executeStep } from "@/lib/engine/run-workflow";

// Satu analisis bisa butuh beberapa panggilan AI (masing-masing ≤ LLM_CALL_TIMEOUT_MS). 300 dtk = batas Vercel (Fluid Compute) paket Hobby.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ node: z.string().optional(), until: z.string().optional() });

/**
 * Menjalankan SATU node: node tertentu ({node}) atau node siap berikutnya menuju target ({until: "qspm"}).
 * UI memanggil berulang selama `remaining` tidak kosong, agar tidak terkena batas waktu serverless.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const body = Body.parse(await req.json().catch(() => ({})));
  return executeStep(id, body);
});
