import { handle } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { computeParameters, predictedVsActual, toStages } from "@/lib/experiment/parameters";
import { getDb, schema } from "@/lib/db/client";
import { defaultModel } from "@/lib/llm/provider";

/**
 * Menghitung e, d, r, h, biaya, kappa, interval Wilson, serta perbandingan prediksi vs hasil nyata.
 * `?model=<nama>` membatasi ke run model itu (profil parameter); `?model=default` = model yang dipakai canvas (LLM_MODEL).
 */
export const GET = handle(async (req: Request) => {
  await requireResearcher();
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag") || undefined;
  const m = url.searchParams.get("model")?.trim();
  const model = m === "default" ? defaultModel() : m || undefined;
  const params = await computeParameters({ tag, model });
  const comparison = await predictedVsActual(toStages(params.stages), params.dh);
  const db = await getDb();
  const tags = [...new Set((await db.select({ t: schema.runs.experimentTag }).from(schema.runs)).map((r) => r.t))];
  return { ...params, comparison, tags };
});
