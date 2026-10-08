// Helper bersama node Decision, Change & Risk Management (DM-CRM). Modul murni (aman di client).
// Membaca output analisis sebelumnya dari ctx.inputs (bertipe lewat contracts.ts bila ada, selain itu dibaca longgar).
import type { EvidenceChunk } from "@/lib/db/schema";
import type {
  CascadingComputed,
  FactorComputed,
  FaktorComputed,
  KontinuitasComputed,
  MatrixScoreComputed,
  PosisiComputed,
  QspmComputedV2,
  RenstraComputed,
  StakeholderComputed,
  StakeholderRole,
} from "../contracts";
import type { Evidence } from "../schemas";
import { num } from "@/lib/sheets/grid";
import { chunkMap, norm, quoteFound } from "@/lib/validators/common";

export type Inputs = Partial<Record<string, unknown>>;

export const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x : "");

/** Daftar bernomor seperti isi sel Excel: "1. …\n2. …". */
export const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");

/** Potong teks menjadi label pendek (n kata pertama). */
export function shortLabel(s: string, words = 5) {
  const w = s.replace(/[.;:,]+$/, "").split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ")}…`;
}

/** Huruf pertama kecil (untuk menyambung kalimat). */
export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ---------- Output hulu bertipe (contracts.ts) ----------

export function factorsOf(inputs: Inputs, key: "faktor_internal" | "faktor_eksternal"): FactorComputed[] {
  const f = inputs[key] as FaktorComputed | undefined;
  return arr<FactorComputed>(f?.factors).filter((x) => isObj(x) && typeof x.id === "string" && typeof x.text === "string");
}

/** Skor IFAS/EFAS per ID faktor (negatif untuk W dan T, seperti Excel). */
export function factorScores(inputs: Inputs): Map<string, number> {
  const m = new Map<string, number>();
  for (const key of ["ifas", "efas"]) {
    for (const r of arr<MatrixScoreComputed["rows"][number]>((inputs[key] as MatrixScoreComputed | undefined)?.rows)) {
      if (isObj(r) && typeof r.id === "string" && Number.isFinite(r.score)) m.set(r.id, r.score);
    }
  }
  return m;
}

/** Faktor kuadran tertentu, urut dari pengaruh terbesar (|skor IFAS/EFAS|, lalu bobot). */
export function rankedFactors(inputs: Inputs, quadrants: ("S" | "W" | "O" | "T")[]): (FactorComputed & { score: number | null })[] {
  const scores = factorScores(inputs);
  return [...factorsOf(inputs, "faktor_internal"), ...factorsOf(inputs, "faktor_eksternal")]
    .filter((f) => quadrants.includes(f.quadrant))
    .map((f) => ({ ...f, score: scores.get(f.id) ?? null }))
    .sort((a, b) => Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0) || (b.bobot ?? 0) - (a.bobot ?? 0));
}

export function stakeholderRoles(inputs: Inputs): StakeholderRole[] {
  return arr<StakeholderRole>((inputs.stakeholder_internal as StakeholderComputed | undefined)?.roles).filter(
    (r) => isObj(r) && typeof r.jabatan === "string",
  );
}

export const factorLine = (f: FactorComputed & { score?: number | null }) =>
  `${f.id}: ${f.text}${f.score !== null && f.score !== undefined ? ` (skor ${num(f.score)})` : ""}`;

// ---------- Pembacaan longgar (node tanpa kontrak, mis. MSDM) ----------

const TEXT_KEYS = ["text", "teks", "name", "nama", "judul", "aksi", "program", "kegiatan", "deskripsi", "masalah", "label", "jabatan", "tahap"];

/** Butir {id, teks} dari output apa pun (objek dengan `id` string dan field teks), dibatasi kedalaman dan jumlah. */
export function looseItems(x: unknown, limit = 8): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.length >= limit || depth > 4) return;
    if (Array.isArray(v)) {
      for (const e of v) walk(e, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    const id = str(v.id);
    const key = TEXT_KEYS.find((k) => str(v[k]).trim());
    if (id && key && !seen.has(id)) {
      seen.add(id);
      out.push({ id, text: str(v[key]).trim().slice(0, 200) });
    }
    for (const [k, val] of Object.entries(v)) if (k !== "evidence" && k !== "ahp" && typeof val === "object") walk(val, depth + 1);
  };
  walk(x, 0);
  return out;
}

/** Semua nilai field `id` (string) di output hulu — himpunan ID yang sah untuk rujukan. */
export function upstreamIds(inputs: Inputs, exclude: string[] = []): Set<string> {
  const ids = new Set<string>();
  let budget = 50000;
  const walk = (v: unknown, depth: number) => {
    if (budget-- <= 0 || depth > 7) return;
    if (Array.isArray(v)) {
      for (const e of v) walk(e, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.id === "string" && v.id.trim()) ids.add(v.id.trim());
    for (const val of Object.values(v)) if (val && typeof val === "object") walk(val, depth + 1);
  };
  for (const [k, v] of Object.entries(inputs)) if (!exclude.includes(k)) walk(v, 0);
  return ids;
}

/** Label potongan (chunkId) yang dikutip di sebuah output (untuk extraChunkIds). */
export function citedChunkIds(x: unknown, limit = 12): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.size >= limit || depth > 6) return;
    if (Array.isArray(v)) {
      for (const e of v) walk(e, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.chunkId === "string") out.add(v.chunkId);
    for (const val of Object.values(v)) if (val && typeof val === "object") walk(val, depth + 1);
  };
  walk(x, 0);
  return [...out].slice(0, limit);
}

// ---------- Ringkasan hulu untuk prompt ----------

/** Bagian prompt dari analisis sebelumnya (hanya yang tersedia). `skip` = kunci yang sudah diringkas engine. */
export function upstreamSections(
  inputs: Inputs,
  opts: { quadrants?: ("S" | "W" | "O" | "T")[]; skip?: string[]; perFactor?: number } = {},
): string[] {
  const skip = new Set(opts.skip ?? []);
  const sections: string[] = [];
  const quads = opts.quadrants ?? ["W", "T"];
  const QL: Record<string, string> = { S: "Kekuatan (S)", W: "Kelemahan (W)", O: "Peluang (O)", T: "Ancaman (T)" };
  for (const q of quads) {
    const fs = rankedFactors(inputs, [q]).slice(0, opts.perFactor ?? 8);
    if (fs.length) sections.push(`## ${QL[q]} — hasil faktor ${q === "S" || q === "W" ? "internal (IFAS)" : "eksternal (EFAS)"}\n${fs.map(factorLine).join("\n")}`);
  }
  const pos = inputs.posisi_organisasi as PosisiComputed | undefined;
  if (pos && typeof pos.kuadran === "string")
    sections.push(`## Posisi organisasi\nKuadran ${pos.kuadran} — ${pos.strategi} (IFAS ${num(pos.x)}, EFAS ${num(pos.y)})`);
  const q = arr<QspmComputedV2["ranking"][number]>((inputs.qspm as QspmComputedV2 | undefined)?.ranking)
    .filter((r) => isObj(r) && typeof r.id === "string")
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
  if (q.length) sections.push(`## Strategi terpilih (QSPM)\n${q.map((r) => `${r.id}: ${r.text} (TAS ${num(r.tas)}, peringkat ${r.rank})`).join("\n")}`);
  const cas = inputs.cascading as CascadingComputed | undefined;
  if (cas && typeof cas.visi === "string") {
    const objs = arr<CascadingComputed["aspects"][number]>(cas.aspects).flatMap((a) => arr<{ id: string; text: string }>(a?.objectives));
    sections.push(`## Visi & sasaran (cascading)\nVisi: ${cas.visi}${objs.length ? `\n${objs.slice(0, 8).map((o) => `${o.id}: ${o.text}`).join("\n")}` : ""}`);
  }
  const ren = inputs.renstra as RenstraComputed | undefined;
  if (ren && typeof ren.sasaranUmum === "string") sections.push(`## Renstra\nSasaran umum: ${ren.sasaranUmum}`);
  const kon = arr<KontinuitasComputed["proker"][number]>((inputs.kontinuitas_proker as KontinuitasComputed | undefined)?.proker).filter((p) => isObj(p));
  if (kon.length) sections.push(`## Kontinuitas program kerja\n${kon.slice(0, 10).map((p) => `${p.id}: ${p.name} → ${p.rekomendasi}`).join("\n")}`);
  for (const key of Object.keys(inputs).filter((k) => k.startsWith("msdm_") && !skip.has(k)).sort()) {
    const items = looseItems(inputs[key], 6);
    if (items.length) sections.push(`## ${key.replace("msdm_", "MSDM ")}\n${items.map((i) => `${i.id}: ${i.text}`).join("\n")}`);
  }
  return sections;
}

// ---------- Bukti ----------

export const docChunks = (evidence: EvidenceChunk[]) => evidence.filter((e) => e.kind === "document");

/** Bukti yang kutipannya benar-benar ada di potongan yang tersedia. */
export function validEvidence(evs: Evidence[] | undefined, evidence: EvidenceChunk[]): Evidence[] {
  const m = chunkMap(evidence);
  return (evs ?? []).filter((e) => quoteFound(e, m));
}

// ---------- Unit kerja (struktur organisasi) ----------

const UNIT_RE =
  /\b(Biro|biro|Divisi|divisi|Departemen|departemen|Kementerian|kementerian|Bidang|bidang|Unit|Kompartemen)\s+((?:[A-Z][\w&-]*)(?:\s+(?:&\s+|dan\s+)?[A-Z][\w&-]*){0,3})/g;
const UNIT_GENERIC = new Set(["biro", "divisi", "departemen", "kementerian", "bidang", "unit", "kompartemen", "kepala", "ketua", "staf", "staff", "wakil", "asisten", "sekretaris", "koordinator", "anggota", "dan"]);

const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();

/** Nama unit kerja (Biro X, Divisi Y, …) yang disebut di teks, urut kemunculan, tanpa duplikat. */
export function unitsFromText(texts: string[], limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(UNIT_RE)) {
      const name = `${cap(m[1])} ${m[2].trim()}`;
      const k = norm(name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Kata pembeda nama unit (tanpa kata umum seperti "biro", "kepala"). */
const distinctive = (s: string) =>
  norm(s)
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length > 2 && !UNIT_GENERIC.has(w));

/**
 * Unit kerja dikenal bila: sama dengan nama organisasi, disebut di potongan dokumen, atau kata pembedanya
 * ada di daftar jabatan stakeholder internal. `null` = tidak bisa diperiksa (tidak ada dokumen maupun jabatan).
 */
export function unitKnown(unit: string, opts: { projectName: string; evidence: EvidenceChunk[]; jabatan: string[] }): boolean | null {
  const u = norm(unit);
  if (!u) return false;
  if (u === norm(opts.projectName) || norm(opts.projectName).includes(u)) return true;
  const docs = docChunks(opts.evidence);
  if (!docs.length && !opts.jabatan.length) return null;
  if (docs.some((d) => norm(d.content).includes(u))) return true;
  const words = distinctive(unit);
  if (!words.length) return false;
  const jab = opts.jabatan.map((j) => new Set(distinctive(j)));
  if (jab.some((set) => words.every((w) => set.has(w)))) return true;
  // Nama unit yang ditulis sedikit berbeda (mis. "Divisi Media & Informasi" vs "Divisi Media"): semua kata pembeda ada di satu potongan.
  return docs.some((d) => {
    const set = new Set(distinctive(d.content));
    return words.every((w) => set.has(w));
  });
}
