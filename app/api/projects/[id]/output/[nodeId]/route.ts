import { HttpError, handle, requireProject } from "@/lib/access";
import { getCanvas, getMainRun } from "@/lib/engine/main-run";
import { labelOf, processKeys, upstreamProcesses } from "@/lib/engine/canvas";
import { composeGrandDesign, docForJson } from "@/lib/grand-design/compose";
import { docToBlocks } from "@/lib/export/blocks";
import { grandDesignDocx } from "@/lib/export/docx";
import { grandDesignPdf } from "@/lib/export/pdf";
import { grandDesignXlsx } from "@/lib/export/xlsx";
import { getDb, schema } from "@/lib/db/client";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string; nodeId: string }> };

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
type Format = keyof typeof MIME;

/** Analisis yang disusun node output: hulu panah ke node itu, atau semua analisis di canvas — dalam urutan alur. */
async function load(projectId: string, nodeId: string) {
  const wf = await getCanvas(projectId);
  const node = wf.graph.nodes.find((n) => n.id === nodeId && n.type === "output");
  if (!node) throw new HttpError(404, "Node output tidak ditemukan di canvas");
  const run = await getMainRun(wf.id);
  const flow = processKeys(wf.graph).filter((k) => k !== "grand_design");
  const up = new Set(upstreamProcesses(wf.graph, nodeId));
  const keys = up.size ? [...flow.filter((k) => up.has(k)), ...[...up].filter((k) => !flow.includes(k))] : flow;
  const labels = Object.fromEntries(keys.map((k) => [k, labelOf(wf.graph, k)]));
  return { node, run, keys, labels };
}

/**
 * GET              → pratinjau: { title, keys, runId, blocks, unavailable, doc } (doc tanpa grids/output).
 * GET ?format=docx → unduh DOCX;  ?format=pdf → PDF;  ?format=xlsx → buku kerja Excel (satu sheet per analisis).
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, nodeId } = await ctx.params;
  await requireProject(id);
  const { node, run, keys, labels } = await load(id, nodeId);
  const format = new URL(req.url).searchParams.get("format");
  const title = node.label ?? "Dokumen hasil";
  if (format && !Object.hasOwn(MIME, format)) throw new HttpError(400, "format harus docx, pdf, atau xlsx");
  if (!run) {
    if (format) throw new HttpError(409, "Belum ada analisis yang dijalankan");
    return {
      title,
      keys,
      runId: null,
      blocks: [],
      unavailable: keys.map((k) => ({ key: k, label: labels[k] ?? k, status: "belum dijalankan" })),
      doc: null,
    };
  }
  const doc = await composeGrandDesign(run.id, keys, labels);
  if (!format) return { title, keys: doc.keys, runId: run.id, blocks: docToBlocks(doc), unavailable: doc.unavailable, doc: docForJson(doc) };

  const f = format as Format;
  const buf = f === "docx" ? await grandDesignDocx(doc) : f === "pdf" ? await grandDesignPdf(doc) : await grandDesignXlsx(doc);
  const db = await getDb();
  await db.insert(schema.grandDesignExports).values({ runId: run.id, format: f, createdBy: "tim" });
  const safe = doc.projectName.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "dokumen";
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": MIME[f],
      "content-disposition": `attachment; filename="${safe}-grand-design.${f}"`,
      "cache-control": "no-store",
    },
  });
});
