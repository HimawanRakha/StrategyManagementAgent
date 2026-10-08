// Interval Wilson 95% untuk proporsi dengan n kecil (z = 1,96).
export function wilson(k: number, n: number, z = 1.96) {
  if (n <= 0) return { p: NaN, lo: 0, hi: 1, n: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom), n };
}
