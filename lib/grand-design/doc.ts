// Model dokumen grand design (tipe + fungsi murni kecil). Modul AMAN di client dan TIDAK mengimpor registry node,
// sehingga pengekspor (blocks/xlsx) bisa dipakai tanpa memuat semua node. Penyusun bagian ada di ./section.ts.
import type { EvidenceChunk, NodeEdit, NodeRunStatus } from "@/lib/db/schema";
import type { AnnotItem, Failure, NodeGroup } from "@/lib/nodes/types";
import { pathKey, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { NODE_GROUPS } from "@/lib/nodes/groups";
import type { TraceChain } from "./trace";

/** Status bagian: status node run, atau "absent" bila analisis belum punya node run di run ini. */
export type SectionStatus = NodeRunStatus | "absent";

export const STATUS_LABEL: Record<SectionStatus, string> = {
  done: "selesai",
  pending: "belum dijalankan",
  running: "sedang berjalan",
  needs_review: "menunggu tinjauan manusia",
  failed: "gagal",
  absent: "belum dijalankan",
};

/** Hasil satu pemeriksaan pada percobaan TERAKHIR (lolos maupun gagal). */
export type DocCheck = { check: string; label: string; kind: "code" | "llm"; passed: boolean; failures: Failure[] };

/** Riwayat perubahan manusia per sel (kunci = pathKey(path)): nilai semula (usulan AI) → nilai sekarang. */
export type CellEditInfo = { from: unknown; to: unknown; at: string; times: number };

export type DocSection = {
  key: string;
  label: string;
  group: NodeGroup;
  /** Kode kelompok tab Excel: ES, SGS, SI, LTV, MSDM, DM-CRM, KUSTOM. */
  groupCode: string;
  sheetName: string;
  status: SectionStatus;
  statusLabel: string;
  /** Output tersedia (status selesai). */
  available: boolean;
  /** Pesan galat node run (status gagal). */
  error: string | null;
  summary: string | null;
  /** Output setelah kalkulator (null bila belum tersedia). */
  output: unknown;
  /** Sheet ala Excel (satu Grid = satu tab). */
  grids: Grid[];
  /** Ringkas: daftar sheet (tetap ada walau `grids` dibuang dari respons JSON). */
  sheets: { id: string; name: string; title: string }[];
  /** Blok dokumen DOCX/PDF untuk analisis ini. */
  blocks: Block[];
  formulas: FormulaDoc[];
  items: AnnotItem[];
  edits: { count: number; total: number; lastAt: string | null; byPath: Record<string, CellEditInfo> };
  validation: { enabled: boolean; passed: boolean | null; checks: DocCheck[]; failed: number; passedChecks: number };
  /** Pertanyaan agen yang belum dijawab untuk analisis ini. */
  questions: { label: string; question: string }[];
  /** Galat saat menyusun sheet/blok/ringkasan dari output (mis. output lama tidak cocok dengan versi node sekarang). */
  renderErrors: string[];
  /** Sheet/blok disusun dari daftar butir karena node belum punya bentuk sendiri. */
  fallback: { sheets: boolean; blocks: boolean };
};

export type GrandDesignDoc = {
  projectName: string;
  orgType: string | null;
  runId: string;
  experimentTag: string;
  generatedAt: string;
  /** Kalimat ringkasan eksekutif (node grand design); null bila belum tersedia. */
  executiveSummary: { text: string; refs: string[] }[] | null;
  /** Status node grand design (ringkasan eksekutif), bahasa Indonesia. */
  executiveStatus: string;
  /** Ringkasan satu kalimat tiap analisis yang tersedia (urut alur). */
  keyResults: { key: string; label: string; text: string }[];
  /** Satu bagian per analisis dalam URUTAN ALUR canvas (node kustom ikut di posisinya; grand_design tidak). */
  sections: DocSection[];
  unavailable: { key: string; label: string; status: string }[];
  trace: { total: number; complete: number; broken: { id: string; reason: string }[]; chains: TraceChain[] };
  /** Potongan yang dikutip, berlabel C… (dokumen) atau U… (jawaban pengguna). */
  sources: Record<string, { source: string; kind: EvidenceChunk["kind"]; content: string }>;
  /** Pertanyaan agen yang belum dijawab (semua analisis dalam cakupan). */
  questions: { label: string; nodeKey: string; nodeLabel: string; question: string }[];
  /** Kunci analisis dalam cakupan dokumen (urut alur). */
  keys: string[];
};

/** Bentuk `doc` di respons JSON pratinjau: tanpa `grids` dan `output` (berat; UI bisa memakai getNode(key).sheets). */
export type GrandDesignDocJson = Omit<GrandDesignDoc, "sections"> & { sections: Omit<DocSection, "grids" | "output">[] };

export function docForJson(doc: GrandDesignDoc): GrandDesignDocJson {
  return {
    ...doc,
    sections: doc.sections.map((s) => {
      const { grids: _g, output: _o, ...rest } = s;
      void _g;
      void _o;
      return rest;
    }),
  };
}

// ---------- Fungsi kecil ----------

export function groupCodeOf(group: NodeGroup): string {
  if (group === "custom") return "KUSTOM";
  return NODE_GROUPS.find((g) => g.id === group)?.code ?? group.toUpperCase();
}

/** Ringkas riwayat edit: per path, nilai semula (edit pertama) dan nilai sekarang (edit terakhir). */
export function summarizeEdits(edits: NodeEdit[] | null | undefined): DocSection["edits"] {
  const byPath: Record<string, CellEditInfo> = {};
  let lastAt: string | null = null;
  for (const e of edits ?? []) {
    if (!Array.isArray(e?.path)) continue;
    const k = pathKey(e.path);
    const prev = byPath[k];
    byPath[k] = prev ? { from: prev.from, to: e.to, at: e.at, times: prev.times + 1 } : { from: e.from, to: e.to, at: e.at, times: 1 };
    if (!lastAt || (e.at && e.at > lastAt)) lastAt = e.at ?? lastAt;
  }
  return { count: Object.keys(byPath).length, total: (edits ?? []).length, lastAt, byPath };
}

// ---------- Kutipan ----------

const CHUNK_ID = /^[CU]\d+$/;

/** Kumpulkan ID potongan yang dikutip di mana pun dalam output (Evidence.chunkId dan refs berlabel C…/U…). */
export function collectCitations(x: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || x === null || typeof x !== "object") return into;
  if (Array.isArray(x)) {
    for (const v of x) collectCitations(v, into, depth + 1);
    return into;
  }
  const o = x as Record<string, unknown>;
  if (typeof o.chunkId === "string" && CHUNK_ID.test(o.chunkId)) into.add(o.chunkId);
  for (const [k, v] of Object.entries(o)) {
    if (/^refs$|Refs$/.test(k) && Array.isArray(v)) for (const r of v) if (typeof r === "string" && CHUNK_ID.test(r)) into.add(r);
    if (v && typeof v === "object") collectCitations(v, into, depth + 1);
  }
  return into;
}

/** Kutipan di sel sheet (refs). */
export function gridCitations(grids: Grid[], into = new Set<string>()): Set<string> {
  for (const g of grids) for (const c of g.cells) for (const r of c.refs ?? []) if (CHUNK_ID.test(r)) into.add(r);
  return into;
}

/** Nilai untuk teks penjelasan: angka koma desimal, teks dikutip, kosong = "kosong". */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "kosong";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
  if (typeof v === "string") return `"${v.length > 80 ? v.slice(0, 80) + "…" : v}"`;
  try {
    return JSON.stringify(v).slice(0, 80);
  } catch {
    return String(v);
  }
}
