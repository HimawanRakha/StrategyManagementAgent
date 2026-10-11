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

/** Satu putusan node run beserta pemeriksaan yang aktif saat itu. */
export type VerdictRow = { node_key: string; own_error: boolean; validator_enabled: boolean };

/**
 * d×r NYATA dari run sungguhan: dr = 1 − (proporsi keliru saat validator aktif) ÷ (proporsi keliru tanpa validator),
 * dibatasi ke [0, 1]. Butuh ≥ minN node run di masing-masing kondisi dan ≥ minErrors kekeliruan tanpa validator; selain itu null.
 * Melengkapi d×r uji sisip, yang tidak mencakup kesalahan makna (mis. klaim tanpa dukungan dokumen).
 */
export function estimateDrObserved(rows: VerdictRow[], key: string, minN = 5, minErrors = 2) {
  const on = rows.filter((r) => r.node_key === key && r.validator_enabled);
  const off = rows.filter((r) => r.node_key === key && !r.validator_enabled);
  const kOn = on.filter((r) => r.own_error).length;
  const kOff = off.filter((r) => r.own_error).length;
  if (on.length < minN || off.length < minN || kOff < Math.max(1, minErrors)) return null;
  const dr = Math.min(1, Math.max(0, 1 - kOn / on.length / (kOff / off.length)));
  return { dr, kOn, nOn: on.length, kOff, nOff: off.length };
}

/** Rata-rata menit tinjauan dari durasi (detik); tinjauan di bawah `minSec` tidak dihitung (bukan membaca sungguhan). */
export function reviewMinutesFrom(durationsSec: number[], minSec = 30) {
  const ok = durationsSec.filter((s) => Number.isFinite(s) && s >= minSec);
  return { minutes: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length / 60 : 0, n: ok.length, ignored: durationsSec.length - ok.length };
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
