// Embedding tiruan untuk mode mock: hashing kata (unigram + bigram) ke vektor berdimensi tetap.
// Tidak semantik, tetapi cukup agar kueri berisi kata kunci menemukan potongan yang memuat kata itu.

const STOP = new Set(
  "yang dan di ke dari untuk pada dengan dalam ini itu atau juga karena oleh sebagai akan ada tidak telah sudah masih lebih para serta bagi agar adalah the of a an to in".split(" "),
);

function tokens(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(nya|kan|lah|an|i)$/, "") || w);
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mockEmbedding(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  const ws = tokens(text);
  const add = (t: string, w: number) => {
    const h = hash(t);
    v[h % dim] += h & 1 ? w : -w;
  };
  ws.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(ws[i - 1] + "_" + w, 0.5);
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // vektor nol tidak bisa dipakai untuk jarak kosinus; beri satu komponen
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}
