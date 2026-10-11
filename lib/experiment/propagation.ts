// Model propagasi galat:  e_i' = e_i (1 − x_i d_i r_i)(1 − y_i d^h),   P = Π (1 − e_i')

export type Stage = { key: string; e: number; dr: number; cTok: number; cMin: number };
export type Choice = { validator: boolean; human: boolean };

export function effectiveError(s: Stage, c: Choice, dh: number) {
  return s.e * (c.validator ? 1 - s.dr : 1) * (c.human ? 1 - dh : 1);
}

export function predictP(stages: Stage[], place: Record<string, Choice>, dh: number) {
  return stages.reduce((p, s) => {
    const c = place[s.key] ?? { validator: false, human: false };
    return p * (1 - effectiveError(s, c, dh));
  }, 1);
}

/** Model dengan pemulihan: P_i = P_{i−1}(1 − e_i') + (1 − P_{i−1}) h_i ; sama dengan predictP bila semua h = 0. */
export function predictMarkov(stages: (Stage & { h: number })[], place: Record<string, Choice>, dh: number) {
  let p = 1;
  for (const s of stages) {
    const c = place[s.key] ?? { validator: false, human: false };
    const err = effectiveError(s, c, dh);
    p = p * (1 - err) + (1 - p) * s.h;
  }
  return p;
}

export function placementCost(stages: Stage[], place: Record<string, Choice>) {
  let tok = 0;
  let min = 0;
  for (const s of stages) {
    const c = place[s.key];
    if (c?.validator) tok += s.cTok;
    if (c?.human) min += s.cMin;
  }
  return { tok, min };
}

/** Gamma(shape, 1) — Marsaglia–Tsang; shape < 1 lewat Gamma(shape + 1) · U^(1/shape). */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Normal baku (Box–Muller)
      x = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const sampleBeta = (a: number, b: number, rng: () => number) => {
  const x = sampleGamma(a, rng);
  return x / (x + sampleGamma(b, rng));
};

/**
 * Rentang keyakinan 95% untuk P: setiap eᵢ yang terukur dengan k ≥ 1 keliru dari n diambil acak dari Beta(k + 0,5, n − k + 0,5)
 * (prior Jeffreys); eᵢ asumsi dan eᵢ = 0 terukur tetap (yang terakhir diberi tanda "data sedikit" di laporan bila n kecil). Mengembalikan persentil 2,5 dan 97,5 dari nSim simulasi. Deterministik (RNG berbenih).
 */
export function predictInterval(stages: (Stage & { k?: number; n?: number })[], place: Record<string, Choice>, dh: number, nSim = 5000, rng = mulberry(7)) {
  const ps: number[] = [];
  for (let i = 0; i < nSim; i++) {
    let p = 1;
    for (const s of stages) {
      const e = s.n && s.n > 0 && s.k ? sampleBeta(s.k + 0.5, s.n - s.k + 0.5, rng) : s.e;
      p *= 1 - effectiveError({ ...s, e }, place[s.key] ?? { validator: false, human: false }, dh);
    }
    ps.push(p);
  }
  ps.sort((a, b) => a - b);
  const q = (f: number) => ps[Math.min(ps.length - 1, Math.max(0, Math.floor(f * ps.length)))];
  return { lo: q(0.025), hi: q(0.975) };
}

/** RNG berbenih (mulberry32), salinan lokal agar modul ini tetap murni tanpa impor simulasi. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
