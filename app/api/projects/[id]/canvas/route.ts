import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { handle, requireProject } from "@/lib/access";
import { GraphSchema } from "@/lib/api-schemas";
import { canvasWarnings, normalizeGraph } from "@/lib/engine/canvas";
import { ensureMainRun, getCanvas, getMainRun } from "@/lib/engine/main-run";

type Ctx = { params: Promise<{ id: string }> };

/** Simpan canvas (node input/proses/output + panah). Node run untuk analisis baru dibuat otomatis. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const { graph } = (await req.json()) as { graph: unknown };
  const parsed = normalizeGraph(GraphSchema.parse(graph));
  const wf = await getCanvas(id);
  // Pengaman: tab lama (versi editor sebelumnya) bisa mengirim node kustom tanpa spesifikasinya — jangan sampai hilang.
  for (const n of parsed.nodes) {
    if (n.type !== "process" || n.key !== "custom" || n.custom) continue;
    const prev = wf.graph.nodes.find((p) => p.id === n.id);
    if (prev?.custom) {
      n.custom = prev.custom;
      n.label ??= prev.label;
      n.settings ??= prev.settings;
    }
  }
  const db = await getDb();
  await db.update(schema.workflows).set({ graph: parsed, updatedAt: new Date() }).where(eq(schema.workflows.id, wf.id));
  if (await getMainRun(wf.id)) await ensureMainRun(wf.id, parsed);
  return { canvas: parsed, warnings: canvasWarnings(parsed) };
});
