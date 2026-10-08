// AHP (Analytic Hierarchy Process, Saaty) — bobot dari perbandingan berpasangan. Modul murni (aman di client).
//
// Masukan: perbandingan setiap pasangan butir {a, b, v}: v = a_ab = seberapa penting a dibanding b pada skala Saaty
// (9, 8, …, 2, 1, 1/2, …, 1/9; v = 3 → a sedikit lebih penting; v = 1/3 → b sedikit lebih penting). Nilai lain dibulatkan
// ke skala Saaty terdekat. Matriks A: a_ab = v, a_ba = 1/v, diagonal 1.
//
// Bobot memakai metode rata-rata geometrik baris (RGMM) agar sama persis dengan rumus Excel:
//   g_i = (Π_j a_ij)^(1/n)          → Excel: =GEOMEAN(baris i)
//   w_i = g_i / Σ g                 → Excel: =g_i/SUM(g)
//   λmax = Σ_j (Σ_i a_ij) · w_j     (jumlah kolom × bobot)
//   CI = (λmax − n) / (n − 1),  CR = CI / RI(n);  konsisten bila CR ≤ 0,10.
// RI: tabel Saaty untuk n ≤ 15; di atasnya pendekatan Alonso & Lamata (2006): RI = (1,7699·n − 4,3513) / (n − 1).

export type AhpPair = { a: string; b: string; v: number };

export const SAATY_SCALE: { value: number; label: string }[] = [
  { value: 1, label: "Sama penting" },
  { value: 2, label: "Antara sama dan sedikit lebih penting" },
  { value: 3, label: "Sedikit lebih penting" },
  { value: 4, label: "Antara sedikit dan jelas lebih penting" },
  { value: 5, label: "Jelas lebih penting" },
  { value: 6, label: "Antara jelas dan sangat jelas lebih penting" },
  { value: 7, label: "Sangat jelas lebih penting" },
  { value: 8, label: "Antara sangat jelas dan mutlak lebih penting" },
  { value: 9, label: "Mutlak lebih penting" },
];

const RI_TABLE = [0, 0, 0, 0.58, 0.9, 1.12, 1.24, 1.32, 1.41, 1.45, 1.49, 1.51, 1.48, 1.56, 1.57, 1.59];

/** Random Index untuk matriks n×n. */
export function randomIndex(n: number): number {
  if (n < RI_TABLE.length) return RI_TABLE[Math.max(0, n)];
  return (1.7699 * n - 4.3513) / (n - 1);
}

/** Nilai skala Saaty yang sah: 1/9 … 1/2, 1, 2 … 9. */
export const SAATY_VALUES: number[] = [9, 8, 7, 6, 5, 4, 3, 2].map((x) => 1 / x).concat([1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** Bulatkan ke nilai Saaty terdekat (skala log); nilai tidak sah → 1 (sama penting). */
export function snapSaaty(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  let best = 1;
  for (const s of SAATY_VALUES) if (Math.abs(Math.log(s) - Math.log(v)) < Math.abs(Math.log(best) - Math.log(v))) best = s;
  return best;
}

/** Nilai a_ab dari satu perbandingan. */
export function pairValue(p: Pick<AhpPair, "v">): number {
  return snapSaaty(p.v);
}

/** Semua pasangan (i < j) untuk daftar ID, urut seperti segitiga atas matriks. */
export function allPairs(ids: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return out;
}

export type AhpResult = {
  ids: string[];
  /** Matriks perbandingan lengkap (baris i, kolom j = seberapa penting i dibanding j). */
  matrix: number[][];
  /** Rata-rata geometrik tiap baris. */
  geo: number[];
  /** Bobot lokal (jumlah = 1). */
  weights: number[];
  colSums: number[];
  lambdaMax: number;
  ci: number;
  ri: number;
  cr: number;
  /** CR ≤ 0,10 (atau n ≤ 2). */
  consistent: boolean;
  /** Pasangan yang tidak diisi (dianggap sama penting = 1). */
  missing: [string, string][];
};

/** Hitung AHP untuk butir `ids` dari daftar perbandingan. Pasangan yang hilang dianggap sama penting. */
export function ahp(ids: string[], pairs: AhpPair[]): AhpResult {
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const matrix = ids.map((_, i) => ids.map((__, j) => (i === j ? 1 : NaN)));
  for (const p of pairs) {
    const i = idx.get(p.a);
    const j = idx.get(p.b);
    if (i === undefined || j === undefined || i === j) continue;
    const v = pairValue(p);
    matrix[i][j] = v;
    matrix[j][i] = 1 / v;
  }
  const missing: [string, string][] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Number.isNaN(matrix[i][j])) {
        missing.push([ids[i], ids[j]]);
        matrix[i][j] = 1;
        matrix[j][i] = 1;
      }
  if (n === 0) return { ids, matrix, geo: [], weights: [], colSums: [], lambdaMax: 0, ci: 0, ri: 0, cr: 0, consistent: true, missing };
  const geo = matrix.map((row) => Math.pow(row.reduce((p, x) => p * x, 1), 1 / n));
  const gs = geo.reduce((s, x) => s + x, 0);
  const weights = geo.map((g) => g / gs);
  const colSums = ids.map((_, j) => matrix.reduce((s, row) => s + row[j], 0));
  const lambdaMax = colSums.reduce((s, c, j) => s + c * weights[j], 0);
  const ci = n > 2 ? (lambdaMax - n) / (n - 1) : 0;
  const ri = randomIndex(n);
  const cr = n > 2 && ri > 0 ? ci / ri : 0;
  return { ids, matrix, geo, weights, colSums, lambdaMax, ci, ri, cr, consistent: cr <= 0.1 + 1e-9, missing };
}

/** Bobot berdasarkan ID. */
export function weightMap(r: AhpResult): Record<string, number> {
  return Object.fromEntries(r.ids.map((id, i) => [id, r.weights[i]]));
}

/**
 * Perbandingan yang paling menyumbang ketidakkonsistenan (untuk saran perbaikan):
 * selisih terbesar antara a_ij dan rasio bobot w_i/w_j (dalam skala log).
 */
export function worstPairs(r: AhpResult, k = 3): { a: string; b: string; given: number; implied: number }[] {
  const out: { a: string; b: string; given: number; implied: number; d: number }[] = [];
  for (let i = 0; i < r.ids.length; i++)
    for (let j = i + 1; j < r.ids.length; j++) {
      const implied = r.weights[i] / r.weights[j];
      out.push({ a: r.ids[i], b: r.ids[j], given: r.matrix[i][j], implied, d: Math.abs(Math.log(r.matrix[i][j] / implied)) });
    }
  return out
    .sort((x, y) => y.d - x.d)
    .slice(0, k)
    .map(({ a, b, given, implied }) => ({ a, b, given, implied }));
}

/** Tulis nilai matriks sebagai pecahan Saaty ("3", "1/5"). */
export function saatyText(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "–";
  if (v >= 1) return String(Math.round(v * 100) / 100).replace(".", ",");
  const inv = 1 / v;
  return Math.abs(inv - Math.round(inv)) < 1e-6 ? `1/${Math.round(inv)}` : String(Math.round(v * 1000) / 1000).replace(".", ",");
}
