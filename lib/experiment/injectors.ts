// Penyuntik galat GENERIK: menyisipkan SATU galat yang diketahui ke output mentah analisis APA PUN tanpa mengetahui skemanya,
// lalu validator + siklus perbaikan dijalankan untuk mengukur d_i (terdeteksi) dan r_i (diperbaiki).
// Penyuntik mencari pola umum di JSON: bukti {chunkId, quote}, rujukan (…Ref/…Refs), angka penilaian (rating, as, score, p, i, e1…),
// himpunan AHP {items, pairs:[{a,b,v}]}, dan daftar butir ber-id. Setiap penyuntikan melaporkan lokasinya (path JSON).
// Modul murni (aman di client dan di uji).
import type { EvidenceChunk } from "@/lib/db/schema";
import { ahp, type AhpPair } from "@/lib/calc/ahp";
import { sentencesOf } from "@/lib/nodes/heuristics";
import { norm } from "@/lib/validators/common";

type Path = (string | number)[];
type Obj = Record<string, unknown>;
/** Kegagalan validator (subset dari Failure). */
export type FailureLike = { check?: string; itemId?: string; message: string };

export type Injection = {
  injected: unknown;
  /** ID butir yang disuntik (butir ber-id terdekat), atau lokasi bila tidak ada. */
  itemId: string;
  /** Lokasi yang disuntik, mis. "factors[2].evidence[0].quote". */
  location: string;
  description: string;
  /** Apakah sebuah kegagalan validator menyangkut galat suntikan ini (dasar "terdeteksi"). */
  matches(f: FailureLike): boolean;
  /** Setelah perbaikan, apakah galat suntikan sudah hilang. */
  isRepaired(after: unknown): boolean;
};

export type InjectorInfo = {
  type: string;
  label: string;
  /** Pemeriksaan yang diharapkan menangkap galat ini (petunjuk, bukan nama cek pasti). */
  check: string;
  description: string;
};

export type Injector = InjectorInfo & {
  /** Apakah output ini punya bagian yang bisa disuntik jenis galat ini. */
  applicable(out: unknown): boolean;
  inject(out: unknown, evidence: EvidenceChunk[], seed: number): Injection | null;
};

// ---------------------------------------------------------------------------------------------
// Penelusuran JSON

const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const pick = <T,>(xs: T[], seed: number): T => xs[((Math.floor(seed) % xs.length) + xs.length) % xs.length];

type Visit = { value: unknown; path: Path; parents: unknown[] };

/** Semua nilai di JSON (pre-order), dengan path dan rantai induk. */
function walk(root: unknown): Visit[] {
  const out: Visit[] = [];
  const go = (value: unknown, path: Path, parents: unknown[]) => {
    out.push({ value, path, parents });
    if (Array.isArray(value)) value.forEach((v, i) => go(v, [...path, i], [...parents, value]));
    else if (isObj(value)) for (const [k, v] of Object.entries(value)) go(v, [...path, k], [...parents, value]);
  };
  go(root, [], []);
  return out;
}

/** "factors[2].evidence[0].quote" */
export function pathText(path: Path): string {
  let s = "";
  for (const p of path) s += typeof p === "number" ? `[${p}]` : s ? `.${p}` : p;
  return s || "(akar)";
}

function getAt(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

function setAt(root: unknown, path: Path, value: unknown) {
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

/** ID butir terdekat (objek induk ber-`id` teks) untuk sebuah lokasi. */
function ownerId(v: Visit): string | null {
  const chain = [...v.parents, v.value].reverse();
  for (const p of chain) if (isObj(p) && typeof p.id === "string" && p.id) return p.id;
  return null;
}

/** Semua ID butir di sepanjang rantai induk (untuk mencocokkan kegagalan validator). */
function ownerIds(v: Visit): string[] {
  return [...v.parents, v.value].filter((p): p is Obj => isObj(p) && typeof p.id === "string" && !!p.id).map((p) => p.id as string);
}

function allStrings(root: unknown): Set<string> {
  const s = new Set<string>();
  for (const v of walk(root)) if (typeof v.value === "string") s.add(v.value);
  return s;
}

const containsString = (root: unknown, x: string) => walk(root).some((v) => v.value === x);

/** ID palsu yang belum dipakai: "S2" → "S99", "SO1" → "SO99", "risk-a" → "risk-a99". */
export function fakeId(orig: string, taken: Set<string>): string {
  const m = /^(.*?)(\d+)$/.exec(orig);
  const base = m ? m[1] : orig;
  for (const suffix of ["99", "98", "97", "999", "998", "9999"]) {
    const c = `${base}${suffix}`;
    if (!taken.has(c)) return c;
  }
  let i = 10000;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

const mentions = (msg: string, id: string) => new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(msg);

// ---------------------------------------------------------------------------------------------
// (a) Kutipan bukti ditukar

type EvidenceRef = { chunkId: string; quote: string };
const isEvidence = (x: unknown): x is EvidenceRef & Obj => isObj(x) && typeof x.chunkId === "string" && typeof x.quote === "string";

const FABRICATED_SENTENCE = "Rektorat menjanjikan dana hibah satu miliar rupiah untuk setiap organisasi kemahasiswaan setiap bulan.";

function quoteFound(ev: EvidenceRef, evidence: EvidenceChunk[]) {
  const c = evidence.find((e) => e.id === ev.chunkId);
  return !!c && norm(c.content).includes(norm(ev.quote));
}

const swapQuote: Injector = {
  type: "swapped_quote",
  label: "Kutipan bukti diganti kalimat yang tidak ada di potongan sumbernya",
  check: "quote_exists (kutipan harus ada di potongan yang dirujuk)",
  description: "Mencari objek {chunkId, quote} di mana pun di output lalu mengganti kutipannya dengan kalimat dari potongan lain.",
  applicable: (out) => walk(out).some((v) => isEvidence(v.value)),
  inject(out, evidence, seed) {
    const o = clone(out);
    const cands = walk(o).filter((v) => isEvidence(v.value));
    if (!cands.length) return null;
    const target = pick(cands, seed);
    const ev = target.value as EvidenceRef;
    const own = evidence.find((e) => e.id === ev.chunkId);
    const ownText = norm(own?.content ?? "");
    // Kalimat dari potongan LAIN yang tidak termuat di potongan yang dirujuk.
    const others = evidence.filter((e) => e.id !== ev.chunkId);
    let sentence: string | null = null;
    let from: string | null = null;
    for (let i = 0; i < others.length && !sentence; i++) {
      const c = others[(seed + i) % others.length];
      const s = sentencesOf(c.content).find((x) => !ownText.includes(norm(x)) && norm(x) !== norm(ev.quote));
      if (s) {
        sentence = s.slice(0, 220);
        from = c.id;
      }
    }
    if (!sentence) {
      if (ownText.includes(norm(FABRICATED_SENTENCE))) return null;
      sentence = FABRICATED_SENTENCE;
    }
    const before = ev.quote;
    ev.quote = sentence;
    const path = [...target.path, "quote"];
    const itemId = ownerId(target) ?? pathText(path);
    const ids = ownerIds(target);
    const injectedQuote = sentence;
    const chunkId = ev.chunkId;
    return {
      injected: o,
      itemId,
      location: pathText(path),
      description: `Kutipan di ${pathText(path)} (butir ${itemId}, potongan ${chunkId}) diganti ${from ? `kalimat dari ${from}` : "kalimat karangan"}: "${injectedQuote.slice(0, 80)}" (semula "${before.slice(0, 60)}")`,
      matches: (f) => (!!f.itemId && idMatch(f.itemId, ids)) || norm(f.message).includes(norm(injectedQuote.slice(0, 40))),
      isRepaired: (after) =>
        !walk(after).some((v) => isEvidence(v.value) && v.value.chunkId === chunkId && norm(v.value.quote) === norm(injectedQuote) && !quoteFound(v.value, evidence)),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// (b) Rujukan ke ID yang tidak ada

/** ID butir pada kegagalan validator cocok dengan butir yang disuntik (juga bentuk berlabel, mis. "MISI A" untuk aspek "A"). */
function idMatch(failureId: string, ids: string[]) {
  return ids.includes(failureId) || ids.includes(failureId.trim().split(/s+/).pop() ?? "");
}

/** Nama field rujukan: refs, ref, factorRefs, strategyRef, objective_refs, … */
const REF_KEY = /(^refs?$|Refs?$|_refs?$)/;

type RefSpot = { path: Path; visit: Visit; value: string };

function refSpots(root: unknown): RefSpot[] {
  const out: RefSpot[] = [];
  for (const v of walk(root)) {
    const key = v.path[v.path.length - 1];
    if (typeof key === "string" && REF_KEY.test(key)) {
      if (typeof v.value === "string" && v.value) out.push({ path: v.path, visit: v, value: v.value });
    } else if (typeof key === "number" && typeof v.value === "string" && v.value) {
      const parentKey = v.path[v.path.length - 2];
      if (typeof parentKey === "string" && REF_KEY.test(parentKey)) out.push({ path: v.path, visit: v, value: v.value });
    }
  }
  return out;
}

const breakRef: Injector = {
  type: "invalid_ref",
  label: "Rujukan diganti ID yang tidak ada",
  check: "ref_exists (rujukan harus menunjuk butir yang ada)",
  description: "Mencari field bernama …Ref/…Refs (mis. factorRefs, strategyRef) lalu mengganti satu nilainya dengan ID yang tidak ada.",
  applicable: (out) => refSpots(out).length > 0,
  inject(out, _evidence, seed) {
    const o = clone(out);
    const spots = refSpots(o);
    if (!spots.length) return null;
    const s = pick(spots, seed);
    const fake = fakeId(s.value, allStrings(o));
    setAt(o, s.path, fake);
    const itemId = ownerId(s.visit) ?? pathText(s.path);
    const ids = ownerIds(s.visit);
    return {
      injected: o,
      itemId,
      location: pathText(s.path),
      description: `Rujukan di ${pathText(s.path)} (butir ${itemId}) diganti dari ${s.value} ke ${fake} yang tidak ada`,
      matches: (f) => (!!f.itemId && (idMatch(f.itemId, ids) || f.itemId === fake)) || mentions(f.message, fake),
      isRepaired: (after) => !containsString(after, fake),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// (c) Angka di luar rentang

/** Nama field angka penilaian yang punya rentang wajar (rating 1–4, AS, skor, probabilitas, dampak, e1…, i1…). */
const NUM_KEY =
  /^(rating|ratings|as|score|scores|skor|nilai|p|i|prob|probability|probabilitas|impact|dampak|effort|likelihood|severity|kemungkinan|urgensi|urgency|[eisrk]\d{1,2})$/i;

type NumSpot = { path: Path; visit: Visit; key: string; value: number };

function numSpots(root: unknown): NumSpot[] {
  const out: NumSpot[] = [];
  for (const v of walk(root)) {
    if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
    const last = v.path[v.path.length - 1];
    const key = typeof last === "number" ? v.path[v.path.length - 2] : last;
    if (typeof key !== "string" || !NUM_KEY.test(key)) continue;
    // Perbandingan AHP {a, b, v} punya penyuntik sendiri.
    const parent = v.parents[v.parents.length - 1];
    if (isObj(parent) && "a" in parent && "b" in parent) continue;
    out.push({ path: v.path, visit: v, key, value: v.value });
  }
  return out;
}

const outOfRange: Injector = {
  type: "out_of_range",
  label: "Angka penilaian diubah ke luar rentang wajar",
  check: "cek rentang nilai (mis. rating 1–4, skor 1–5, peluang 0–1)",
  description: "Mencari angka di field seperti rating, as, score, p, i, e1… lalu menggantinya dengan nilai jauh di atas skala yang dipakai.",
  applicable: (out) => numSpots(out).length > 0,
  inject(out, _evidence, seed) {
    const o = clone(out);
    const spots = numSpots(o);
    if (!spots.length) return null;
    const s = pick(spots, seed);
    const same = spots.filter((x) => x.key === s.key).map((x) => Math.abs(x.value));
    const max = Math.max(...same);
    let bad = Math.max(10, Math.ceil(max) * 3 + 1);
    while (same.includes(bad)) bad++;
    setAt(o, s.path, bad);
    const itemId = ownerId(s.visit) ?? pathText(s.path);
    const ids = ownerIds(s.visit);
    const key = s.key;
    return {
      injected: o,
      itemId,
      location: pathText(s.path),
      description: `Nilai ${key} di ${pathText(s.path)} (butir ${itemId}) diubah dari ${s.value} ke ${bad} (skala yang dipakai paling tinggi ${max})`,
      matches: (f) => (!!f.itemId && idMatch(f.itemId, ids)) || new RegExp(`(^|[^0-9.,])${bad}([^0-9]|$)`).test(f.message),
      isRepaired: (after) => !numSpots(after).some((x) => x.key === key && x.value === bad),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// (d) AHP tidak konsisten

type AhpSpot = { visit: Visit; id: string; items: string[]; pairs: AhpPair[] };

function ahpSpots(root: unknown): AhpSpot[] {
  const out: AhpSpot[] = [];
  for (const v of walk(root)) {
    const x = v.value;
    if (!isObj(x) || !Array.isArray(x.items) || !Array.isArray(x.pairs)) continue;
    const items = x.items.filter((i): i is string => typeof i === "string");
    const pairs = (x.pairs as unknown[]).filter((p): p is AhpPair => isObj(p) && typeof p.a === "string" && typeof p.b === "string" && typeof p.v === "number");
    if (items.length < 3 || !pairs.length) continue;
    out.push({ visit: v, id: typeof x.id === "string" ? x.id : pathText(v.path), items, pairs });
  }
  return out;
}

const ahpInconsistent: Injector = {
  type: "ahp_inconsistent",
  label: "Satu perbandingan AHP dibalik ekstrem sehingga tidak konsisten",
  check: "ahp_consistency (CR harus ≤ 0,10)",
  description: "Mencari himpunan AHP {items, pairs:[{a,b,v}]} lalu membalik satu perbandingan ke nilai ekstrem (9 ↔ 1/9) sampai CR > 0,10.",
  applicable: (out) => ahpSpots(out).length > 0,
  inject(out, _evidence, seed) {
    const o = clone(out);
    const spots = ahpSpots(o).filter((s) => ahp(s.items, s.pairs).consistent);
    if (!spots.length) return null;
    const s = pick(spots, seed);
    const set = s.visit.value as { pairs: unknown[] };
    const pairIdx = set.pairs.map((p, i) => ({ p, i })).filter((x): x is { p: AhpPair; i: number } => isObj(x.p) && typeof (x.p as AhpPair).v === "number");
    for (let k = 0; k < pairIdx.length; k++) {
      const { p, i } = pairIdx[(seed + k) % pairIdx.length];
      const before = p.v;
      const after = before >= 1 ? 0.111 : 9;
      p.v = after;
      const pairs = set.pairs.filter((x): x is AhpPair => isObj(x) && typeof (x as AhpPair).v === "number");
      const r = ahp(s.items, pairs);
      if (!r.consistent) {
        const path = [...s.visit.path, "pairs", i, "v"];
        const setId = s.id;
        const pairText = `${p.a} vs ${p.b}`;
        return {
          injected: o,
          itemId: setId,
          location: pathText(path),
          description: `Perbandingan AHP ${pairText} di himpunan ${setId} (${pathText(path)}) dibalik dari ${before} ke ${after}; CR menjadi ${r.cr.toFixed(3)} (> 0,10)`,
          matches: (f) => f.itemId === setId || (/ahp|konsist|consist/i.test(`${f.check ?? ""} ${f.message}`) && mentions(f.message, setId)),
          isRepaired: (afterOut) => {
            const sets = ahpSpots(afterOut).filter((x) => x.id === setId);
            return sets.length > 0 && sets.every((x) => ahp(x.items, x.pairs).consistent);
          },
        };
      }
      p.v = before; // coba pasangan lain
    }
    return null;
  },
};

// ---------------------------------------------------------------------------------------------
// (e) Butir karangan (salinan dengan ID baru dan teks yang tidak didukung dokumen)

const FABRICATED_TEXT = "Rektorat menjanjikan dana hibah satu miliar rupiah untuk setiap organisasi kemahasiswaan";
const FABRICATED_QUOTE = "Rektorat menjanjikan dana hibah satu miliar rupiah";
const TEXT_KEYS = ["text", "teks", "name", "nama", "jabatan", "judul", "title", "program", "kegiatan", "deskripsi", "description", "uraian", "aspek", "misi", "risiko", "risk"];
const SKIP_TEXT = /^(id|chunkId|quote|type|quadrant|kuadran|category|kategori|group|kelompok)$|Refs?$|Id$/;

type ListSpot = { path: Path; list: Obj[] };

function textKeyOf(x: Obj): string | null {
  for (const k of TEXT_KEYS) if (typeof x[k] === "string" && (x[k] as string).length >= 3) return k;
  let best: string | null = null;
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== "string" || v.length < 8 || SKIP_TEXT.test(k)) continue;
    if (!best || v.length > (x[best] as string).length) best = k;
  }
  return best;
}

function listSpots(root: unknown): ListSpot[] {
  const out: ListSpot[] = [];
  for (const v of walk(root)) {
    if (!Array.isArray(v.value) || !v.value.length) continue;
    const list = v.value;
    const ok = list.every((x) => isObj(x) && typeof x.id === "string" && !Array.isArray(x.pairs)) && list.some((x) => textKeyOf(x as Obj));
    if (ok) out.push({ path: v.path, list: list as Obj[] });
  }
  return out;
}

const fabricatedItem: Injector = {
  type: "fabricated_item",
  label: "Butir karangan ditambahkan (salinan dengan ID baru dan isi tidak didukung dokumen)",
  check: "quote_exists / grounded (butir harus didukung bukti dokumen)",
  description: "Mencari daftar butir ber-id lalu menyalin satu butir dengan ID baru, teks karangan, dan kutipan bukti yang tidak ada di dokumen.",
  applicable: (out) => listSpots(out).length > 0,
  inject(out, evidence, seed) {
    const o = clone(out);
    const spots = listSpots(o);
    if (!spots.length) return null;
    const s = pick(spots, seed);
    const withText = s.list.map((x, i) => ({ x, i })).filter(({ x }) => textKeyOf(x));
    const { x: orig, i: idx } = pick(withText, seed);
    const copy = clone(orig);
    const newId = fakeId(String(orig.id), allStrings(o));
    copy.id = newId;
    const tk = textKeyOf(copy)!;
    copy[tk] = FABRICATED_TEXT;
    for (const v of walk(copy)) if (isEvidence(v.value)) v.value.quote = FABRICATED_QUOTE;
    s.list.splice(idx + 1, 0, copy);
    const location = pathText([...s.path, idx + 1]);
    const hasEvidence = walk(copy).some((v) => isEvidence(v.value));
    return {
      injected: o,
      itemId: newId,
      location,
      description: `Butir karangan ${newId} (salinan ${String(orig.id)}) disisipkan di ${location}: ${tk} = "${FABRICATED_TEXT}"${hasEvidence ? `, kutipan "${FABRICATED_QUOTE}"` : ""}`,
      matches: (f) => f.itemId === newId || mentions(f.message, newId),
      isRepaired: (after) => !walk(after).some((v) => typeof v.value === "string" && norm(v.value).includes(norm(FABRICATED_QUOTE)) && !quoteFoundAnywhere(v, evidence)),
    };
  },
};

/** Kutipan karangan dianggap sah hanya bila memang ada di potongan yang dirujuk (tidak pernah, kecuali dokumennya memuat kalimat itu). */
function quoteFoundAnywhere(v: Visit, evidence: EvidenceChunk[]) {
  const parent = v.parents[v.parents.length - 1];
  return isEvidence(parent) && quoteFound(parent, evidence);
}

// ---------------------------------------------------------------------------------------------

export const INJECTORS: Injector[] = [swapQuote, breakRef, outOfRange, ahpInconsistent, fabricatedItem];

const info = ({ type, label, check, description }: Injector): InjectorInfo => ({ type, label, check, description });

/** Penyuntik untuk sebuah output. Tanpa contoh output: semua penyuntik (ketersediaan belum diketahui). */
export function injectorsFor(sample?: unknown): InjectorInfo[] {
  const list = sample === undefined || sample === null ? INJECTORS : INJECTORS.filter((i) => i.applicable(sample));
  return list.map(info);
}

/** Suntikkan satu galat jenis `errorType` ke output mentah (node apa pun). */
export function inject(nodeKey: string, errorType: string, out: unknown, evidence: EvidenceChunk[], seed: number): Injection | null {
  const inj = INJECTORS.find((i) => i.type === errorType);
  if (!inj) throw new Error(`Tidak ada penyuntik ${errorType} (analisis ${nodeKey})`);
  if (!inj.applicable(out)) return null;
  return inj.inject(out, evidence, seed);
}
