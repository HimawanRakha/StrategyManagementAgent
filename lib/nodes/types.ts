import type { z } from "zod";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { RetrievalQuery } from "@/lib/rag/retrieve";
import type { Block, FormulaDoc, Grid } from "@/lib/sheets/grid";

export const NODE_KEYS = [
  // Environmental Scanning (ES)
  "stakeholder_internal",
  "stakeholder_eksternal",
  "faktor_internal",
  "faktor_eksternal",
  "ifas",
  "efas",
  // Strategy Generation & Selection (SGS)
  "posisi_organisasi",
  "swot_matrix",
  "qspm",
  "cascading",
  // Strategy Implementation (SI)
  "kontinuitas_proker",
  // Long-Term Vision (LTV)
  "renstra",
  // Manajemen SDM
  "msdm_attraction",
  "msdm_recruitment",
  "msdm_onboarding",
  "msdm_development",
  "msdm_penilaian",
  "msdm_retention",
  "msdm_separation",
  // Decision, Change & Risk Management
  "decision_making",
  "change_management",
  "risk_management",
  // Kompilasi
  "grand_design",
] as const;
export type NodeKey = (typeof NODE_KEYS)[number];

/** Kelompok node = awalan tab di Excel framework. */
export type NodeGroup = "es" | "sgs" | "si" | "ltv" | "msdm" | "dmcrm" | "custom" | "output";

/** Konteks untuk membuat sheet/blok dari output node (tanpa akses basis data). */
export type SheetContext = {
  /** Label node di canvas (bisa diganti pengguna). */
  label: string;
  /** Output (setelah kalkulator) node lain di run yang sama — untuk menampilkan teks butir yang dirujuk. */
  inputs: Partial<Record<string, unknown>>;
};

export type NodeContext = {
  projectId: string;
  projectName: string;
  orgType: string | null;
  description?: string | null;
  runId: string;
  nodeRunId: string;
  /** Output (setelah kalkulator) semua node yang sudah selesai di run ini. */
  inputs: Partial<Record<NodeKey, unknown>>;
  evidence: EvidenceChunk[];
  /** Analisis yang panahnya masuk ke node ini (termasuk node kustom). */
  parents?: string[];
};

export type Failure = { check: string; itemId?: string; message: string };
export type CheckResult = { check: string; kind: "code" | "llm"; passed: boolean; failures: Failure[]; label?: string };

/** Antarmuka LLM yang dicatat biayanya; disediakan engine untuk node dan validator. */
export interface LlmSession {
  /** Panggil LLM, parse JSON, validasi Zod (dengan satu kali percobaan ulang format). */
  json<T>(
    purpose: "generate" | "validate" | "repair" | "judge",
    system: string,
    user: string,
    schema: z.ZodType<T>,
    mock: () => T,
  ): Promise<T>;
}

export type CheckSpec = { name: string; kind: "code" | "llm"; description: string };
export type AnnotItem = { id: string; text: string; detail?: string };

export interface NodeDef<T = unknown> {
  key: NodeKey;
  label: string;
  /** 1 = analisis lingkungan & perumusan strategi (ES + SGS); 2 = sisanya. */
  phase: 1 | 2;
  group: NodeGroup;
  /** Nama tab di Excel framework (mis. "ESIFAS") — juga nama sheet di ekspor XLSX. */
  sheetName: string;
  /** Dependensi WAJIB (harus ada di canvas dan selesai lebih dulu). Panah di canvas menambah induk lain sebagai konteks. */
  deps: NodeKey[];
  /** llm = LLM menghasilkan output; code = kalkulator kode (ie_matrix) atau templat (grand_design). */
  kind: "llm" | "code";
  description: string;
  /** Siapa menghitung (tabel library node di brief). */
  computedBy: string;
  schema: z.ZodType<T>;
  checks: CheckSpec[];
  queries?(ctx: NodeContext): RetrievalQuery[];
  /** Label potongan yang wajib ikut sebagai bukti (mis. yang dikutip node induk). */
  extraChunkIds?(ctx: NodeContext): string[];
  prompt?(ctx: NodeContext): { system: string; user: string };
  mock?(ctx: NodeContext): T;
  /** Untuk node kind=code: hasilkan output langsung (boleh memanggil LLM, mis. ringkasan eksekutif). */
  run?(ctx: NodeContext, llm: LlmSession): Promise<T>;
  validate?(out: T, ctx: NodeContext, llm: LlmSession): Promise<CheckResult[]>;
  /** Kalkulator kode yang dijalankan sebelum output disimpan. */
  compute?(out: T, ctx: NodeContext): unknown;
  /** Daftar item yang dinilai penilai anotasi. */
  items(out: unknown): AnnotItem[];
  /** Petunjuk perbaikan: ambil ulang hanya item yang gagal. */
  repairHint?: string;
  /** Tabel ala Excel dari output setelah compute (satu Grid = satu tab). Sel `edit` menunjuk path di output mentah. */
  sheets?(out: unknown, ctx: SheetContext): Grid[];
  /** Blok ringkas untuk dokumen DOCX/PDF dan pratinjau dokumen hasil. */
  blocks?(out: unknown, ctx: SheetContext): Block[];
  /** Rumus yang dipakai (panel Perhitungan, laporan, dokumen). */
  formulas?: FormulaDoc[];
  /** Ringkasan satu kalimat hasil (kartu node & panel Perhitungan), mis. "Total IFAS 0,57 — kekuatan lebih besar". */
  summary?(out: unknown): string;
}
