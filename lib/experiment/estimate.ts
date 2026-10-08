// Estimasi e_i: hanya dari run yang inputnya benar.
// verdicts[runId][nodeKey] = { own: boolean, carried: boolean }

export type Verdicts = Record<string, Record<string, { own: boolean; carried: boolean }>>;

export function estimateE(verdicts: Verdicts, node: string, parents: string[]) {
  let clean = 0;
  let err = 0;
  for (const run of Object.values(verdicts)) {
    if (!run[node]) continue;
    // Run tanpa putusan lengkap untuk induknya tidak bisa dipastikan bersih.
    if (!parents.every((p) => run[p])) continue;
    const inputClean = parents.every((p) => !run[p].own && !run[p].carried);
    if (!inputClean) continue;
    clean++;
    if (run[node].own) err++;
  }
  return { e: clean ? err / clean : NaN, k: err, n: clean };
}

/**
 * Peluang tahap i memulihkan galat dari input yang salah (h_i) — dipakai bila asumsi independensi gagal.
 * Dihitung dari run yang inputnya salah: proporsi node yang tetap bersih (tanpa galat sendiri maupun terbawa).
 */
export function estimateH(verdicts: Verdicts, node: string, parents: string[]) {
  let dirty = 0;
  let recovered = 0;
  for (const run of Object.values(verdicts)) {
    if (!run[node] || !parents.every((p) => run[p])) continue;
    const inputClean = parents.every((p) => !run[p].own && !run[p].carried);
    if (inputClean) continue;
    dirty++;
    if (!run[node].own && !run[node].carried) recovered++;
  }
  return { h: dirty ? recovered / dirty : 0, k: recovered, n: dirty };
}
