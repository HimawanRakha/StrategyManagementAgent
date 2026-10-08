import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { HttpError, handle } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { computeParameters, toStages } from "@/lib/experiment/parameters";
import { optimize, optimizeDP } from "@/lib/experiment/optimize";
import { predictP, type Stage } from "@/lib/experiment/propagation";

const StageOverride = z.object({ e: z.number().min(0).max(1).optional(), dr: z.number().min(0).max(1).optional(), cTok: z.number().min(0).optional(), cMin: z.number().min(0).optional() });

const Body = z.object({
  experimentTag: z.string().min(1).default("opt"),
  keys: z.array(z.string()).optional(), // tahap yang dioptimasi (default: yang punya data e)
  overrides: z.record(z.string(), StageOverride).optional(), // ubah parameter manual (analisis sensitivitas)
  dh: z.number().min(0).max(1).optional(),
  budgets: z.array(z.object({ tokens: z.number().min(0), minutes: z.number().min(0) })).min(1).max(60),
  method: z.enum(["auto", "brute", "dp"]).default("auto"),
  unit: z.number().int().min(1).default(500),
  save: z.boolean().default(true),
});

/** Menjalankan optimasi penempatan validasi untuk sederet anggaran; hasil disimpan ke optimization_results. */
export const POST = handle(async (req: Request) => {
  await requireResearcher();
  const body = Body.parse(await req.json());
  const params = await computeParameters();
  let stages: Stage[] = toStages(params.stages, body.keys);
  stages = stages.map((s) => ({ ...s, ...(body.overrides?.[s.key] ?? {}) }));
  if (!stages.length) throw new HttpError(409, "Belum ada tahap dengan parameter e. Anotasi dan putusan dibutuhkan, atau isi parameter manual.");
  const dh = body.dh ?? params.dh;
  const method = body.method === "auto" ? (stages.length <= 8 ? "brute" : "dp") : body.method;

  const db = await getDb();
  const results = [];
  for (const b of body.budgets) {
    const best = method === "brute" ? optimize(stages, dh, b.tokens, b.minutes) : optimizeDP(stages, dh, b.tokens, b.minutes, body.unit);
    // Untuk alur kecil, cek silang brute force vs DP (uji kebenaran kode DP)
    const check = stages.length <= 8 ? optimizeDP(stages, dh, b.tokens, b.minutes, body.unit) : null;
    const row = {
      experimentTag: body.experimentTag,
      method,
      budgetTokens: b.tokens,
      budgetMinutes: b.minutes,
      placement: best.place,
      predictedP: best.p,
      params: { stages, dh },
    };
    if (body.save) await db.insert(schema.optimizationResults).values(row);
    results.push({ ...row, dpP: check?.p ?? null, baselineP: predictP(stages, {}, dh) });
  }
  return { stages, dh, method, results };
});

export const GET = handle(async (req: Request) => {
  await requireResearcher();
  const tag = new URL(req.url).searchParams.get("tag");
  const db = await getDb();
  const q = db.select().from(schema.optimizationResults).orderBy(desc(schema.optimizationResults.createdAt)).limit(500);
  const rows = tag ? await q.where(eq(schema.optimizationResults.experimentTag, tag)) : await q;
  return { results: rows };
});

export const DELETE = handle(async (req: Request) => {
  await requireResearcher();
  const tag = new URL(req.url).searchParams.get("tag");
  if (!tag) throw new HttpError(400, "Sertakan tag");
  const db = await getDb();
  await db.delete(schema.optimizationResults).where(eq(schema.optimizationResults.experimentTag, tag));
  return { ok: true };
});
