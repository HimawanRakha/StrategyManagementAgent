import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { PlacementSchema } from "@/lib/api-schemas";
import { computeParameters } from "@/lib/experiment/parameters";
import { effectiveError, predictMarkov, predictP } from "@/lib/experiment/propagation";
import { seededRng, simulateP } from "@/lib/experiment/simulate";
import { Graph, defaultGraph } from "@/lib/engine/graph";
import { engineGraph, normalizeGraph } from "@/lib/engine/canvas";

const Body = z.object({
  workflowId: z.string().uuid().optional(),
  graph: z.enum(["mvp", "full"]).default("full"),
  placement: PlacementSchema.default({}),
  overrides: z.record(z.string(), z.object({ e: z.number().optional(), dr: z.number().optional(), h: z.number().optional() })).optional(),
  dh: z.number().min(0).max(1).optional(),
  trials: z.number().int().min(1000).max(500_000).default(100_000),
  useH: z.boolean().default(true),
  seed: z.number().int().optional(),
});

/** Prediksi P dengan simulasi Monte Carlo pada graf bercabang (dengan pemulihan h_i), dibandingkan dengan rumus. */
export const POST = handle(async (req: Request) => {
  await requireResearcher();
  const body = Body.parse(await req.json());
  let g = defaultGraph(body.graph);
  if (body.workflowId) {
    const db = await getDb();
    const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, body.workflowId));
    if (wf) g = engineGraph(normalizeGraph(wf.graph));
  }
  const graph = new Graph(g);
  const params = await computeParameters();
  const dh = body.dh ?? params.dh;
  const stages = graph.topoOrder().map((k) => {
    const p = params.stages.find((s) => s.key === k);
    const o = body.overrides?.[k] ?? {};
    return {
      key: k,
      e: o.e ?? (p && Number.isFinite(p.e.p) ? p.e.p : 0),
      dr: o.dr ?? p?.dr ?? 0,
      h: body.useH ? (o.h ?? (p && Number.isFinite(p.h.p) ? p.h.p : 0)) : 0,
      cTok: p?.cTok ?? 0,
      cMin: p?.cMin ?? 0,
    };
  });
  const par = Object.fromEntries(
    stages.map((s) => [s.key, { e: effectiveError(s, body.placement[s.key] ?? { validator: false, human: false }, dh), h: s.h }]),
  );
  const simulated = simulateP(graph, par, body.trials, undefined, body.seed !== undefined ? seededRng(body.seed) : Math.random);
  return {
    stages,
    simulated,
    product: predictP(stages, body.placement, dh), // rumus perkalian (h = 0)
    markov: predictMarkov(stages, body.placement, dh), // rantai lurus dengan pemulihan
    trials: body.trials,
  };
});
