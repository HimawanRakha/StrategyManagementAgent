// Pecah teks per paragraf, lalu gabungkan hingga ~800 karakter dengan tumpang-tindih ~100 karakter.
// Batas paragraf dipertahankan supaya poin notulensi tidak terbelah.

export type RawChunk = { idx: number; content: string; paragraphs: [number, number] };

const TARGET = 800;
const OVERLAP = 100;

function splitLong(p: string): string[] {
  if (p.length <= TARGET) return [p];
  const sentences = p.match(/[^.!?;]+[.!?;]+["')\]]*\s*|[^.!?;]+$/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > TARGET) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > TARGET) {
      for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Ekor ~100 karakter dari teks, dipotong di awal kalimat atau kata agar tidak terbelah. */
function tail(text: string): string {
  if (text.length <= OVERLAP) return text;
  const slice = text.slice(-OVERLAP * 1.5);
  const sentence = slice.search(/[.!?]\s+\S/);
  if (sentence >= 0 && slice.length - sentence - 2 >= OVERLAP / 2) return slice.slice(sentence + 2).trim();
  const word = text.slice(-OVERLAP).indexOf(" ");
  return text.slice(-OVERLAP).slice(word + 1).trim();
}

export function normalizeText(raw: string) {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/ /g, " ");
}

export function chunkText(raw: string): RawChunk[] {
  const text = normalizeText(raw);
  // Paragraf dipisah baris kosong; bila dokumen tanpa baris kosong, tiap baris dianggap paragraf.
  let paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  if (paras.length <= 1) paras = text.split(/\n/).map((p) => p.trim()).filter(Boolean);

  const units: { text: string; para: number }[] = [];
  paras.forEach((p, i) => splitLong(p).forEach((t) => units.push({ text: t, para: i + 1 })));

  const chunks: RawChunk[] = [];
  let cur: string[] = [];
  let start = 1;
  let end = 1;
  let prefix = "";
  const flush = () => {
    if (!cur.length) return;
    const body = cur.join("\n");
    chunks.push({ idx: chunks.length, content: (prefix ? prefix + "\n" : "") + body, paragraphs: [start, end] });
    prefix = tail(body);
    cur = [];
  };
  for (const u of units) {
    const len = cur.reduce((s, x) => s + x.length + 1, 0) + prefix.length;
    if (cur.length && len + u.text.length > TARGET) flush();
    if (!cur.length) start = u.para;
    cur.push(u.text);
    end = u.para;
  }
  flush();
  return chunks;
}
