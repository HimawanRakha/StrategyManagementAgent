import { asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { handle, HttpError, requireProject } from "@/lib/access";
import { getCanvas, MAIN_TAG } from "@/lib/engine/main-run";
import { loadRunNodes, loadRunQuestions } from "@/lib/engine/run-report";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Run yang bisa dipilih di panel Laporan, dikelompokkan per tag (run utama dulu, lalu tag eksperimen menurut waktu).
 * `?runIds=a,b` mengembalikan data laporan run tersebut (bentuk sama dengan data canvas: nodes + questions).
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const db = await getDb();
  const wf = await getCanvas(id);
  const runs = await db
    .select({ id: schema.runs.id, tag: schema.runs.experimentTag, status: schema.runs.status, createdAt: schema.runs.createdAt })
    .from(schema.runs)
    .where(eq(schema.runs.workflowId, wf.id))
    .orderBy(asc(schema.runs.createdAt));

  const ids = new URL(req.url).searchParams.get("runIds")?.split(",").map((x) => x.trim()).filter(Boolean);
  if (ids?.length) {
    if (ids.length > 50) throw new HttpError(400, "Terlalu banyak run sekaligus (maks. 50)");
    const allowed = new Set(runs.map((r) => r.id));
    if (!ids.every((x) => allowed.has(x))) throw new HttpError(404, "Run tidak ditemukan di proyek ini");
    const out = [];
    for (const runId of ids) {
      const nodes = await loadRunNodes(runId);
      const questions = await loadRunQuestions(Object.values(nodes).map((n) => n.nodeRunId));
      out.push({ runId, nodes, questions });
    }
    return { runs: out };
  }

  const order: string[] = [];
  for (const r of runs) if (!order.includes(r.tag)) order.push(r.tag);
  order.sort((a, b) => (a === MAIN_TAG ? -1 : b === MAIN_TAG ? 1 : 0));
  // Daftar ringan: jumlah node run per run, agar dropdown bisa menulis "26/26 selesai".
  const counts = runs.length
    ? await db
        .select({ runId: schema.nodeRuns.runId, status: schema.nodeRuns.status })
        .from(schema.nodeRuns)
        .where(inArray(schema.nodeRuns.runId, runs.map((r) => r.id)))
    : [];
  return {
    groups: order.map((tag) => ({
      tag,
      runs: runs
        .filter((r) => r.tag === tag)
        .map((r) => ({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          done: counts.filter((c) => c.runId === r.id && c.status === "done").length,
          total: counts.filter((c) => c.runId === r.id).length,
        })),
    })),
  };
});
