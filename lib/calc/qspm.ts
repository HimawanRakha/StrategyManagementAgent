// QSPM (Quantitative Strategic Planning Matrix) — modul murni.
// TAS = Bobot × AS per sel (Excel: IF(AND(ISNUMBER($C11), ISNUMBER(H11)), $C11*H11, "")); AS kosong → TAS kosong (tidak ikut SUM).
// Total TAS per strategi = Σ TAS kolom (SUM Excel mengabaikan sel kosong). Peringkat 1 = total terbesar (RANK.EQ).

/** Bulatkan sisa galat floating point (0,1 + 0,2 = 0,30000000000000004 → 0,3); tidak mengubah angka bermakna. */
export const round10 = (x: number) => Math.round(x * 1e10) / 1e10;

/** TAS satu sel: kosong (null) bila bobot atau AS bukan angka, seperti rumus IF(AND(ISNUMBER…)) di Excel. */
export function tasCell(bobot: number | null | undefined, as: number | null | undefined): number | null {
  if (typeof bobot !== "number" || !Number.isFinite(bobot)) return null;
  if (typeof as !== "number" || !Number.isFinite(as)) return null;
  return round10(bobot * as);
}

/** Total TAS per strategi: Σ bobot × AS atas faktor yang AS-nya terisi. */
export function qspmTotal(factors: { id: string; bobot: number }[], as: Record<string, number | null | undefined> | undefined): number {
  let s = 0;
  for (const f of factors) {
    const t = tasCell(f.bobot, as?.[f.id]);
    if (t !== null) s += t;
  }
  return round10(s);
}

/** Peringkat kompetisi seperti RANK.EQ Excel (urutan menurun): 1 + banyaknya nilai yang lebih besar. Nilai seri mendapat peringkat sama. */
export function rankDesc(values: number[], eps = 1e-9): number[] {
  return values.map((v) => 1 + values.filter((x) => x > v + eps).length);
}

/**
 * Kerapuhan peringkat: turunkan SATU nilai AS strategi `topId` sebanyak 1 poin (dicoba untuk setiap faktor yang AS-nya ≥ 1)
 * lalu hitung ulang peringkatnya. Mengembalikan peringkat terburuk dan faktor penyebabnya.
 */
export function singleChangeWorst(
  factors: { id: string; bobot: number }[],
  strategies: { id: string; as: Record<string, number | null | undefined> }[],
  topId: string,
  eps = 1e-9,
): { worstRank: number; factorId: string | null } {
  const top = strategies.find((s) => s.id === topId);
  if (!top) return { worstRank: 1, factorId: null };
  const totalTop = qspmTotal(factors, top.as);
  const others = strategies.filter((s) => s.id !== topId).map((s) => qspmTotal(factors, s.as));
  let worst = { worstRank: 1 + others.filter((t) => t > totalTop + eps).length, factorId: null as string | null };
  for (const f of factors) {
    const v = top.as?.[f.id];
    if (typeof v !== "number" || v < 1 || !Number.isFinite(f.bobot)) continue;
    const t = totalTop - f.bobot;
    const rank = 1 + others.filter((o) => o > t + eps).length;
    if (rank > worst.worstRank) worst = { worstRank: rank, factorId: f.id };
  }
  return worst;
}

// ---------- API lama (tetap diekspor) ----------

/** TAS_k = Σ_j w_j · AS_jk (AS null = faktor tidak memengaruhi pilihan, dihitung 0). */
export function tas(weights: Record<string, number>, as: Record<string, number | null>) {
  return Object.entries(as).reduce((s, [id, v]) => s + (weights[id] ?? 0) * (v ?? 0), 0);
}

export function rankStrategies(
  weights: Record<string, number>,
  scores: { factorId: string; strategyId: string; as: number | null }[],
  strategyIds: string[],
) {
  const totals = strategyIds.map((sid) => {
    const as: Record<string, number | null> = {};
    for (const s of scores) if (s.strategyId === sid) as[s.factorId] = s.as;
    return { strategyId: sid, tas: tas(weights, as) };
  });
  const sorted = [...totals].sort((a, b) => b.tas - a.tas);
  return totals.map((t) => ({ ...t, rank: sorted.findIndex((s) => s.strategyId === t.strategyId) + 1 }));
}

/** Kendall's tau-a antara dua peringkat (dipakai untuk mengukur stabilitas peringkat QSPM antar-run). */
export function kendallTau(a: string[], b: string[]) {
  const items = a.filter((x) => b.includes(x));
  const n = items.length;
  if (n < 2) return 1;
  const pa = new Map(a.map((x, i) => [x, i]));
  const pb = new Map(b.map((x, i) => [x, i]));
  let c = 0;
  let d = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = Math.sign(pa.get(items[i])! - pa.get(items[j])!) * Math.sign(pb.get(items[i])! - pb.get(items[j])!);
      if (s > 0) c++;
      else if (s < 0) d++;
    }
  return (c - d) / ((n * (n - 1)) / 2);
}
