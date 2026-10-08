import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { NODES, NODE_KEYS, type NodeKey } from "@/lib/nodes/registry";
import type { Placement } from "@/lib/db/schema";
import { cohenKappa } from "./kappa";
import { estimateE, estimateH, type Verdicts } from "./estimate";
import { wilson } from "./wilson";
import { predictP, type Stage } from "./propagation";
import { kendallTau } from "@/lib/calc/qspm";
import { qspmRankIds } from "./stability";

export type StageParams = {
  key: NodeKey;
  label: string;
  e: ReturnType<typeof wilson>;
  d: ReturnType<typeof wilson>;
  r: ReturnType<typeof wilson>;
  dr: number;
  h: ReturnType<typeof wilson>;
  cTok: number; // c_i^v: rata-rata token validasi + perbaikan per node run yang validatornya aktif
  cTokN: number;
  cMin: number; // c_i^h: rata-rata menit tinjauan manusia
  cMinN: number;
  genTok: number; // rata-rata token generate (biaya dasar node)
  kappa: number | null;
  kappaN: number;
  formatFailures: number;
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  return (row?.value as T) ?? fallback;
}

/** Verdict per run per node; opsional dibatasi experiment_tag dan hanya node tanpa cek (baseline). */
async function loadVerdicts(opts: { tag?: string; baselineOnly?: boolean }) {
  const rows = await queryRows<{
    run_id: string; node_key: string; own_error: boolean; carried_error: boolean;
    validator_enabled: boolean; human_enabled: boolean; experiment_tag: string;
  }>(sql`
    SELECT nr.run_id, nr.node_key, v.own_error, v.carried_error, nr.validator_enabled, nr.human_enabled, r.experiment_tag
    FROM node_run_verdicts v
    JOIN node_runs nr ON nr.id = v.node_run_id
    JOIN runs r ON r.id = nr.run_id
    ${opts.tag ? sql`WHERE r.experiment_tag = ${opts.tag}` : sql``}`);
  const all: Verdicts = {};
  const baseline: Verdicts = {};
  for (const r of rows) {
    (all[r.run_id] ??= {})[r.node_key] = { own: r.own_error, carried: r.carried_error };
    if (!r.validator_enabled && !r.human_enabled) (baseline[r.run_id] ??= {})[r.node_key] = { own: r.own_error, carried: r.carried_error };
  }
  return { all, baseline, rows };
}

/** Hitung e, d, r, h, biaya, kappa, dan interval Wilson per tahap. */
export async function computeParameters(opts: { tag?: string } = {}) {
  const db = await getDb();
  const { all, baseline } = await loadVerdicts({ tag: opts.tag });

  // e_i dihitung dari node tanpa validator/tinjauan (galat mentah), tetapi status input memakai semua putusan.

  const inj = await queryRows<{ node_key: string; n: number; detected: number; repaired: number }>(sql`
    SELECT node_key, COUNT(*)::int AS n,
           SUM(CASE WHEN detected THEN 1 ELSE 0 END)::int AS detected,
           SUM(CASE WHEN detected AND repaired THEN 1 ELSE 0 END)::int AS repaired
    FROM injections WHERE detected IS NOT NULL GROUP BY node_key`);

  const cv = await queryRows<{ node_key: string; avg_tokens: number; n: number }>(sql`
    SELECT nr.node_key, AVG(t.tokens)::float AS avg_tokens, COUNT(*)::int AS n
    FROM node_runs nr
    JOIN (
      SELECT node_run_id, SUM(tokens_in + tokens_out) AS tokens
      FROM llm_calls
      WHERE purpose IN ('validate', 'repair') AND injection_id IS NULL
      GROUP BY node_run_id
    ) t ON t.node_run_id = nr.id
    WHERE nr.validator_enabled
    GROUP BY nr.node_key`);

  const gen = await queryRows<{ node_key: string; avg_tokens: number }>(sql`
    SELECT nr.node_key, AVG(t.tokens)::float AS avg_tokens
    FROM node_runs nr
    JOIN (SELECT node_run_id, SUM(tokens_in + tokens_out) AS tokens FROM llm_calls WHERE purpose = 'generate' GROUP BY node_run_id) t
      ON t.node_run_id = nr.id
    GROUP BY nr.node_key`);

  const ch = await queryRows<{ node_key: string; avg_minutes: number; n: number }>(sql`
    SELECT nr.node_key, AVG(EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) / 60)::float AS avg_minutes, COUNT(*)::int AS n
    FROM reviews r
    JOIN node_runs nr ON nr.id = r.node_run_id
    WHERE r.ended_at IS NOT NULL
    GROUP BY nr.node_key`);

  const fmt = await queryRows<{ node_key: string; n: number }>(sql`
    SELECT node_key, SUM(format_failures)::int AS n FROM node_runs GROUP BY node_key`);

  // Kappa: pasangan dua penilai pertama yang paling banyak menilai item yang sama.
  const ann = await db
    .select({ nodeRunId: schema.annotations.nodeRunId, annotator: schema.annotations.annotator, itemId: schema.annotations.itemId, isError: schema.annotations.isError, nodeKey: schema.nodeRuns.nodeKey })
    .from(schema.annotations)
    .innerJoin(schema.nodeRuns, eq(schema.nodeRuns.id, schema.annotations.nodeRunId));
  const kappaBy = new Map<string, { k: number | null; n: number }>();
  const overall: { a: boolean[]; b: boolean[] } = { a: [], b: [] };
  for (const key of NODE_KEYS) {
    const rows = ann.filter((a) => a.nodeKey === key);
    const byItem = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      const id = `${r.nodeRunId}:${r.itemId}`;
      if (!byItem.has(id)) byItem.set(id, new Map());
      byItem.get(id)!.set(r.annotator, r.isError);
    }
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (const m of byItem.values()) {
      if (m.size < 2) continue;
      const [x, y] = [...m.values()];
      a.push(x);
      b.push(y);
    }
    overall.a.push(...a);
    overall.b.push(...b);
    kappaBy.set(key, { k: a.length ? cohenKappa(a, b) : null, n: a.length });
  }

  const stages: StageParams[] = NODE_KEYS.map((key) => {
    const def = NODES[key];
    const est = estimateE(baselineOnlyFor(all, baseline, key), key, def.deps);
    const hEst = estimateH(all, key, def.deps);
    const i = inj.find((x) => x.node_key === key);
    const d = wilson(i?.detected ?? 0, i?.n ?? 0);
    const r = wilson(i?.repaired ?? 0, i?.detected ?? 0);
    return {
      key,
      label: def.label,
      e: wilson(est.k, est.n),
      d,
      r,
      dr: (Number.isFinite(d.p) ? d.p : 0) * (Number.isFinite(r.p) ? r.p : 0),
      h: wilson(hEst.k, hEst.n),
      cTok: Math.round(cv.find((x) => x.node_key === key)?.avg_tokens ?? 0),
      cTokN: cv.find((x) => x.node_key === key)?.n ?? 0,
      cMin: Number((ch.find((x) => x.node_key === key)?.avg_minutes ?? 0).toFixed(2)),
      cMinN: ch.find((x) => x.node_key === key)?.n ?? 0,
      genTok: Math.round(gen.find((x) => x.node_key === key)?.avg_tokens ?? 0),
      kappa: kappaBy.get(key)?.k ?? null,
      kappaN: kappaBy.get(key)?.n ?? 0,
      formatFailures: fmt.find((x) => x.node_key === key)?.n ?? 0,
    };
  });

  return {
    stages,
    kappa: overall.a.length ? cohenKappa(overall.a, overall.b) : null,
    kappaN: overall.a.length,
    dh: await getSetting<number>("dh", 0.85),
    qspmTau: await qspmStability(opts.tag),
  };
}

/** Untuk node `key`, gunakan putusan node itu hanya dari run di mana node itu baseline; induk dari semua putusan. */
function baselineOnlyFor(all: Verdicts, baseline: Verdicts, key: string): Verdicts {
  const out: Verdicts = {};
  for (const [runId, nodes] of Object.entries(all)) {
    if (!baseline[runId]?.[key]) continue;
    out[runId] = nodes;
  }
  return out;
}

/** Stabilitas peringkat QSPM antar-run: rata-rata Kendall's tau antar pasangan run. */
async function qspmStability(tag?: string) {
  const rows = await queryRows<{ output: unknown }>(sql`
    SELECT nr.output FROM node_runs nr JOIN runs r ON r.id = nr.run_id
    WHERE nr.node_key = 'qspm' AND nr.status = 'done' ${tag ? sql`AND r.experiment_tag = ${tag}` : sql``}`);
  const ranks = rows.map((r) => qspmRankIds(r.output)).filter((r) => r.length >= 2);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < ranks.length; i++)
    for (let j = i + 1; j < ranks.length; j++) {
      sum += kendallTau(ranks[i], ranks[j]);
      n++;
    }
  return n ? { tau: sum / n, pairs: n } : null;
}

/** Ubah parameter terukur menjadi tahap model; tahap tanpa data e diabaikan kecuali `include`. */
export function toStages(params: StageParams[], keys?: string[]): Stage[] {
  return params
    .filter((p) => (keys ? keys.includes(p.key) : Number.isFinite(p.e.p)))
    .map((p) => ({ key: p.key, e: Number.isFinite(p.e.p) ? p.e.p : 0, dr: p.dr, cTok: p.cTok, cMin: p.cMin }));
}

/** Perbandingan prediksi dan hasil nyata per experiment_tag. */
export async function predictedVsActual(stages: Stage[], dh: number) {
  const db = await getDb();
  const runs = await db.select().from(schema.runs);
  const tags = [...new Set(runs.map((r) => r.experimentTag))];
  const { all } = await loadVerdicts({});
  const out: { tag: string; runs: number; annotated: number; actual: ReturnType<typeof wilson>; predicted: number; placement: Placement }[] = [];
  for (const tag of tags) {
    const tagRuns = runs.filter((r) => r.experimentTag === tag);
    const nrs = await db.select({ runId: schema.nodeRuns.runId, nodeKey: schema.nodeRuns.nodeKey }).from(schema.nodeRuns).where(inArray(schema.nodeRuns.runId, tagRuns.map((r) => r.id)));
    let annotated = 0;
    let clean = 0;
    for (const r of tagRuns) {
      const keys = nrs.filter((n) => n.runId === r.id).map((n) => n.nodeKey);
      const v = all[r.id];
      if (!v || !keys.every((k) => v[k])) continue; // hanya run yang semua node-nya sudah diputus
      annotated++;
      if (keys.every((k) => !v[k].own && !v[k].carried)) clean++;
    }
    const placement = tagRuns[0]?.config.placement ?? {};
    const relevant = stages.filter((s) => placement[s.key]);
    out.push({ tag, runs: tagRuns.length, annotated, actual: wilson(clean, annotated), predicted: predictP(relevant, placement, dh), placement });
  }
  return out;
}
