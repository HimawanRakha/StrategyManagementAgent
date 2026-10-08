import { handle } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { computeParameters, predictedVsActual, toStages } from "@/lib/experiment/parameters";
import { getDb, schema } from "@/lib/db/client";

/** Menghitung e, d, r, h, biaya, kappa, interval Wilson, serta perbandingan prediksi vs hasil nyata. */
export const GET = handle(async (req: Request) => {
  await requireResearcher();
  const tag = new URL(req.url).searchParams.get("tag") || undefined;
  const params = await computeParameters({ tag });
  const comparison = await predictedVsActual(toStages(params.stages), params.dh);
  const db = await getDb();
  const tags = [...new Set((await db.select({ t: schema.runs.experimentTag }).from(schema.runs)).map((r) => r.t))];
  return { ...params, comparison, tags };
});
