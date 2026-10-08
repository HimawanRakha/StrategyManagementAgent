import { z } from "zod";
import { handle, projectOfRun, requireProject } from "@/lib/access";
import { resetNode } from "@/lib/engine/run-workflow";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ node: z.string() });

/** Mengulang node: output node itu dan semua turunannya dikosongkan agar bisa dijalankan lagi. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const { node } = Body.parse(await req.json());
  return { reset: await resetNode(id, node) };
});
