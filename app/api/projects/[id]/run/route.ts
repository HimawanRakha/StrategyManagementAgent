import { z } from "zod";
import { handle, HttpError, requireProject } from "@/lib/access";
import { ensureMainRun, getCanvas } from "@/lib/engine/main-run";
import { canvasNodeOf, canvasWarnings, engineGraph, labelOf } from "@/lib/engine/canvas";
import { executeStep } from "@/lib/engine/run-workflow";
import { isNodeKey } from "@/lib/nodes/registry";
import { isCustomKey } from "@/lib/nodes/custom";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ key: z.string().optional() });

/**
 * Jalankan SATU analisis per request (agar aman dari batas waktu serverless):
 * - {key}: analisis berikutnya yang dibutuhkan untuk mencapai `key` (termasuk analisis sebelumnya bila belum selesai);
 * - tanpa key: analisis siap berikutnya di seluruh canvas.
 * UI memanggil berulang selama `remaining` tidak kosong.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const { key } = Body.parse(await req.json().catch(() => ({})));
  const wf = await getCanvas(id);
  if (!engineGraph(wf.graph).nodes.length) throw new HttpError(409, "Tambahkan minimal satu node proses ke canvas.");
  const warnings = canvasWarnings(wf.graph);
  if (warnings.some((w) => w.message.startsWith("Ada panah melingkar"))) throw new HttpError(409, "Ada panah melingkar antar-analisis; hapus salah satu panah dulu.");
  if (key) {
    if (!isNodeKey(key) && !isCustomKey(key)) throw new HttpError(400, "Analisis tidak dikenal");
    const node = canvasNodeOf(wf.graph, key);
    if (!node && key !== "grand_design") throw new HttpError(404, "Analisis ini tidak ada di canvas.");
    const w = warnings.find((x) => node && x.nodeId === node.id);
    if (w) throw new HttpError(409, `${labelOf(wf.graph, key)}: ${w.message.charAt(0).toLowerCase()}${w.message.slice(1)}.`);
  }
  const run = await ensureMainRun(wf.id, wf.graph);
  return { runId: run.id, ...(await executeStep(run.id, key ? { until: key } : {})) };
});
