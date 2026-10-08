// Cohen's kappa: a, b = label boolean dua penilai untuk item yang sama.
export function cohenKappa(a: boolean[], b: boolean[]) {
  const n = a.length;
  if (n === 0 || n !== b.length) return NaN;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe === 1) return po === 1 ? 1 : 0; // kedua penilai seragam total
  return (po - pe) / (1 - pe);
}
