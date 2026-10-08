import { z } from "zod";
import { handle, projectOfRun, requireProject } from "@/lib/access";
import { executeStep } from "@/lib/engine/run-workflow";

export const maxDuration = 60;

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
