// Simulasi Monte Carlo untuk graf bercabang dengan pemulihan (h_i > 0):
// ribuan run virtual mengikuti urutan topologis; proporsi run dengan dokumen akhir bersih = prediksi P.

export type SimGraph = { topoOrder(): string[]; parents(k: string): string[] };

export function simulateP(
  graph: SimGraph,
  par: Record<string, { e: number; h: number }>, // e = galat efektif setelah pengecekan
  trials = 100_000,
  sink?: string,
  rng: () => number = Math.random,
) {
  const order = graph.topoOrder();
  const end = sink ?? order[order.length - 1];
  // Bila tidak ada node sink tunggal, dokumen akhir bersih = semua node bersih.
  const allMustBeClean = !sink && !order.includes("grand_design");
  const target = sink ?? (order.includes("grand_design") ? "grand_design" : end);
  let ok = 0;
  for (let k = 0; k < trials; k++) {
    const clean: Record<string, boolean> = {};
    for (const n of order) {
      const p = par[n] ?? { e: 0, h: 0 };
      const inputClean = graph.parents(n).every((x) => clean[x]);
      clean[n] = inputClean ? rng() >= p.e : rng() < p.h; // peluang memulihkan galat dari input
    }
    if (allMustBeClean ? order.every((n) => clean[n]) : clean[target]) ok++;
  }
  return ok / trials;
}

/** RNG deterministik (mulberry32) agar hasil simulasi bisa direproduksi. */
export function seededRng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
