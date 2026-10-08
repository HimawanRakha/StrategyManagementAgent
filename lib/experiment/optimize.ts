import { effectiveError, predictP, type Choice, type Stage } from "./propagation";

export const OPTIONS: Choice[] = [
  { validator: false, human: false },
  { validator: true, human: false },
  { validator: false, human: true },
  { validator: true, human: true },
];

const EPS = 1e-12;

/**
 * Coba semua 4^n penempatan yang muat anggaran dan pilih prediksi P tertinggi.
 * Deterministik: bila P sama (selisih ≤ 1e-12), pilih yang pemeriksaannya lebih sedikit, lalu token lebih kecil,
 * lalu menit lebih kecil; sisanya menurut urutan pencacahan (tahap pertama berubah paling cepat).
 */
export function optimize(stages: Stage[], dh: number, bTok: number, bMin: number) {
  let best = { p: -1, place: {} as Record<string, Choice> };
  let bestKey = { checks: Infinity, tok: Infinity, min: Infinity };
  const total = OPTIONS.length ** stages.length;
  if (total > 5_000_000) throw new Error("Terlalu banyak kombinasi; pakai optimizeDP");
  for (let code = 0; code < total; code++) {
    const place: Record<string, Choice> = {};
    let tok = 0;
    let min = 0;
    let checks = 0;
    let k = code;
    for (const s of stages) {
      const c = OPTIONS[k % 4];
      k = Math.floor(k / 4);
      place[s.key] = c;
      if (c.validator) {
        tok += s.cTok;
        checks++;
      }
      if (c.human) {
        min += s.cMin;
        checks++;
      }
    }
    if (tok > bTok || min > bMin) continue;
    const p = predictP(stages, place, dh);
    const better =
      p > best.p + EPS ||
      (Math.abs(p - best.p) <= EPS &&
        (checks < bestKey.checks || (checks === bestKey.checks && (tok < bestKey.tok || (tok === bestKey.tok && min < bestKey.min)))));
    if (better) {
      best = { p, place };
      bestKey = { checks, tok, min };
    }
  }
  return best;
}

/**
 * Pemrograman dinamis untuk alur lengkap (multiple-choice knapsack dengan dua anggaran).
 * Karena log P adalah penjumlahan nilai per tahap, tabel diisi tahap demi tahap.
 * Token dibulatkan ke satuan `unit` dan menit ke satuan `minUnit` (dibulatkan ke atas, jadi konservatif: hasil selalu muat anggaran).
 * Bila nilai sama, pilihan yang lebih murah (urutan OPTIONS: tanpa cek, validator, manusia, keduanya) yang dipakai — deterministik.
 */
export function optimizeDP(stages: Stage[], dh: number, bTok: number, bMin: number, unit = 500, minUnit = 1) {
  const T = Math.max(0, Math.floor(bTok / unit));
  const M = Math.max(0, Math.floor(bMin / minUnit));
  const grid = (v: number) => Array.from({ length: T + 1 }, () => new Array<number>(M + 1).fill(v));
  const costT = (s: Stage, c: Choice) => (c.validator ? (Number.isFinite(s.cTok) ? Math.ceil(s.cTok / unit) : Infinity) : 0);
  const costM = (s: Stage, c: Choice) => (c.human ? Math.ceil(s.cMin / minUnit) : 0);
  let best = grid(0); // V_0 = 0 untuk semua anggaran
  const picks: number[][][] = [];
  for (const s of stages) {
    const next = grid(-Infinity);
    const pick = grid(0);
    OPTIONS.forEach((c, o) => {
      const ct = costT(s, c);
      const cm = costM(s, c);
      if (!Number.isFinite(ct) || ct > T || cm > M) return;
      const v = Math.log(Math.max(1e-300, 1 - effectiveError(s, c, dh)));
      for (let t = ct; t <= T; t++)
        for (let m = cm; m <= M; m++) {
          const cand = best[t - ct][m - cm] + v;
          if (cand > next[t][m] + EPS) {
            next[t][m] = cand;
            pick[t][m] = o;
          }
        }
    });
    picks.push(pick);
    best = next;
  }
  // Telusuri mundur untuk mendapatkan pilihan per tahap
  const place: Record<string, Choice> = {};
  let t = T;
  let m = M;
  for (let i = stages.length - 1; i >= 0; i--) {
    const c = OPTIONS[picks[i][t][m]];
    const s = stages[i];
    place[s.key] = c;
    t -= costT(s, c);
    m -= costM(s, c);
  }
  return { p: Math.exp(best[T][M]), place };
}
