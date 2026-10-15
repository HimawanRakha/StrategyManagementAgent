// Penggabungan peringkat pencarian hybrid (modul murni, bisa dites tanpa basis data).

/** Reciprocal Rank Fusion (k = 60): skor = Σ 1 / (60 + peringkat) dari setiap daftar. */
export function rrf(lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
