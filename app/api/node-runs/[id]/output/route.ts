import { z } from "zod";
import { HttpError, handle, projectOfNodeRun, requireProject } from "@/lib/access";
import { EditError, applyEdits, revertEdits } from "@/lib/engine/edit";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.union([
  z.object({
    edits: z
      .array(z.object({ path: z.array(z.union([z.string(), z.number()])).min(1), value: z.unknown() }))
      .min(1)
      .max(200),
  }),
  z.object({ action: z.literal("revert") }),
]);

/**
 * Ubah hasil analisis (sel tabel yang bisa diedit): {edits:[{path, value}]} → hitung ulang node ini dan analisis sesudahnya.
 * {action:"revert"} → kembalikan semua perubahan ke usulan AI semula.
 */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfNodeRun(id));
  const body = Body.parse(await req.json());
  try {
    return "action" in body ? await revertEdits(id) : await applyEdits(id, body.edits);
  } catch (e) {
    if (e instanceof EditError) throw new HttpError(400, e.message);
    throw e;
  }
});
