// Stabilitas peringkat QSPM antar-run. Modul murni.

/** Urutan ID strategi QSPM dari output (kontrak QspmComputedV2: ranking[].id urut rank; output lama: totals[].strategyId). */
export function qspmRankIds(output: unknown): string[] {
  const o = (output ?? {}) as { ranking?: { id?: unknown; rank?: unknown }[]; totals?: { strategyId?: unknown; rank?: unknown }[] };
  const rows = Array.isArray(o.ranking)
    ? o.ranking.map((r) => ({ id: r?.id, rank: r?.rank }))
    : Array.isArray(o.totals)
      ? o.totals.map((t) => ({ id: t?.strategyId, rank: t?.rank }))
      : [];
  return rows
    .filter((r): r is { id: string; rank: number } => typeof r.id === "string" && typeof r.rank === "number" && Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((r) => r.id);
}
