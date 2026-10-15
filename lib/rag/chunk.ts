// Pecah teks per paragraf, lalu gabungkan hingga ~800 karakter dengan tumpang-tindih ~100 karakter.
// Batas paragraf dipertahankan supaya poin notulensi tidak terbelah. Ukuran dan tumpang-tindih bisa diatur
// (dipakai evaluasi RAG untuk membandingkan konfigurasi); platform memakai CHUNK_DEFAULT.

export type RawChunk = { idx: number; content: string; paragraphs: [number, number] };

/** Konfigurasi bawaan platform. */
export const CHUNK_DEFAULT = { target: 800, overlap: 100 };
export type ChunkOptions = { target: number; overlap: number };

function splitLong(p: string, target: number): string[] {
  if (p.length <= target) return [p];
  const sentences = p.match(/[^.!?;]+[.!?;]+["')\]]*\s*|[^.!?;]+$/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > target) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > target) {
      for (let i = 0; i < s.length; i += target) out.push(s.slice(i, i + target).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Ekor ~overlap karakter dari teks, dipotong di awal kalimat atau kata agar tidak terbelah. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0) return "";
  if (text.length <= overlap) return text;
  const slice = text.slice(-overlap * 1.5);
  const sentence = slice.search(/[.!?]\s+\S/);
  if (sentence >= 0 && slice.length - sentence - 2 >= overlap / 2) return slice.slice(sentence + 2).trim();
  const word = text.slice(-overlap).indexOf(" ");
  return text.slice(-overlap).slice(word + 1).trim();
}

export function normalizeText(raw: string) {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/ /g, " ");
}

/** Paragraf dokumen (nomor 1, 2, …) persis seperti yang dipakai chunkText — satuan label relevansi evaluasi RAG. */
export function paragraphsOf(raw: string): string[] {
  const text = normalizeText(raw);
  // Paragraf dipisah baris kosong; bila dokumen tanpa baris kosong, tiap baris dianggap paragraf.
  let paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  if (paras.length <= 1) paras = text.split(/\n/).map((p) => p.trim()).filter(Boolean);
  return paras;
}

export function chunkText(raw: string, opts: ChunkOptions = CHUNK_DEFAULT): RawChunk[] {
  const { target, overlap } = opts;
  const units: { text: string; para: number }[] = [];
  paragraphsOf(raw).forEach((p, i) => splitLong(p, target).forEach((t) => units.push({ text: t, para: i + 1 })));

  const chunks: RawChunk[] = [];
  let cur: string[] = [];
  let start = 1;
  let end = 1;
  let prefix = "";
  const flush = () => {
    if (!cur.length) return;
    const body = cur.join("\n");
    chunks.push({ idx: chunks.length, content: (prefix ? prefix + "\n" : "") + body, paragraphs: [start, end] });
    prefix = tail(body, overlap);
    cur = [];
  };
  for (const u of units) {
    const len = cur.reduce((s, x) => s + x.length + 1, 0) + prefix.length;
    if (cur.length && len + u.text.length > target) flush();
    if (!cur.length) start = u.para;
    cur.push(u.text);
    end = u.para;
  }
  flush();
  return chunks;
}
