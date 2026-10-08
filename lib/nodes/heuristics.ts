// Heuristik kata kunci untuk mode mock (tanpa API key). Tidak dipakai saat LLM sungguhan aktif,
// kecuali sebagai cadangan pemeriksa di mock. Hasilnya sengaja sederhana dan bisa salah.

const NEG =
  /\b(kendala|persaingan|memangkas|mengeluhkan|keluhan|lemah|kelemahan|kurang|rendah|lambat|belum|minim|turun|menurun|tidak|terbatas|sulit|masalah|hambatan|ancaman|risiko|tertunda|terlambat|mangkrak|sepi|bentrok|berkurang|pesaing|saingan|pemotongan|dipangkas|ketat|mendadak|terpusat|jarang)\b/i;
const EXT =
  /\b(kampus|rektorat|universitas|fakultas|pemerintah|kebijakan|regulasi|peraturan|tren|pasar|pesaing|saingan|persaingan|komunitas|organisasi lain|himpunan lain|ukm|mitra|sponsor|perusahaan|industri|eksternal|mahasiswa baru|ekonomi|teknologi|media sosial|platform|alumni|masyarakat|dikti|kemendikbud|pandemi|inflasi|bootcamp)\b/i;
const INT =
  /\b(pengurus|staf|anggota aktif|divisi|program kerja|proker|rapat|internal|kas|anggaran internal|dokumentasi|sop|regenerasi|kaderisasi|kepengurusan|ketua|struktur|lpj|kegiatan kami|kami|bendahara|himsi)\b/i;

export function isNegative(text: string) {
  return NEG.test(text);
}

export function isExternal(text: string) {
  const e = (text.match(new RegExp(EXT.source, "gi")) ?? []).length;
  const i = (text.match(new RegExp(INT.source, "gi")) ?? []).length;
  return e > i;
}

export function guessQuadrant(text: string, hint?: "internal" | "external"): "S" | "W" | "O" | "T" {
  const ext = hint ? hint === "external" : isExternal(text);
  const neg = isNegative(text);
  if (ext) return neg ? "T" : "O";
  return neg ? "W" : "S";
}

/** Kalimat utuh (berakhir tanda baca) dari potongan; judul/heading tanpa titik diabaikan. */
export function sentencesOf(content: string) {
  return content
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 300 && /[.!?]$/.test(s));
}

/** Ambil kalimat ke-`skip` dari potongan sebagai kutipan persis. */
export function firstSentence(content: string, skip = 0): string {
  const sentences = sentencesOf(content);
  return (sentences[skip] ?? sentences[0] ?? content.slice(0, 120)).slice(0, 220).trim();
}

/** Kategori dengan kata kunci kueri paling banyak muncul di kalimat (pencocokan awalan kata). */
export function bestCategory<K extends string>(sentence: string, queries: Record<K, string>): { key: K; score: number } {
  const words = sentence.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  let best = { key: Object.keys(queries)[0] as K, score: -1 };
  for (const [k, q] of Object.entries(queries) as [K, string][]) {
    const score = q
      .toLowerCase()
      .split(/\s+/)
      .filter((kw) => kw.length > 3 && words.some((w) => w.startsWith(kw.slice(0, 5)))).length;
    if (score > best.score) best = { key: k, score };
  }
  return best;
}

/** Kalimat dalam potongan yang paling banyak memuat kata dari kueri (kutipan persis untuk mock). */
export function bestSentence(
  content: string,
  query: string,
  exclude: Set<string> = new Set(),
  accept: (s: string) => boolean = () => true,
): string | null {
  const q = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let best: string | null = null;
  let bestScore = -1;
  for (const s of sentencesOf(content)) {
    if (exclude.has(s) || !accept(s)) continue;
    const score = s.toLowerCase().split(/\W+/).filter((w) => q.has(w)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** Hash deterministik kecil untuk mock (nilai stabil antar-run). */
export function pick(seed: string, n: number) {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % n;
}

/** Ringkas kutipan menjadi kalimat faktor. */
export function toClaim(quote: string) {
  const s = quote
    .replace(/^(Bagian\s+\w+\.|Poin\s+\d+\.|Temuan\s+\d+\.|Pasal\s+\d+\.|\d+\.)\s*/i, "")
    .replace(/^[-•*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 140 ? s.slice(0, 137) + "…" : s;
}
