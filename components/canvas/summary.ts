// Ringkasan satu baris per analisis (ditampilkan di node dan panel), kelompok node, dan label status yang ramah.
import { NODE_GROUPS, groupOf } from "@/lib/nodes/groups";
import { NODE_KEYS, NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { customKeyOf, isCustomKey } from "@/lib/nodes/custom";
import type { NodeGroup } from "@/lib/nodes/types";
import { summaryOf } from "@/components/sheets/node-sheets";
import type { FlowData } from "./types";

/** Kunci mesin node proses di canvas: node_key bawaan, atau "custom_<id>" untuk proses kustom. */
export function flowKey(id: string, d: Pick<FlowData, "gtype" | "key" | "custom">): string | null {
  if (d.gtype !== "process") return null;
  if (d.key === "custom" || d.custom) return customKeyOf(id);
  return d.key ?? null;
}

/** Label tahap berjalan untuk animasi dan bilah progres. */
export const PHASE_LABEL: Record<string, string> = {
  retrieve: "Mengambil bukti",
  generate: "Menulis analisis",
  validate: "Memeriksa",
  repair: "Memperbaiki",
  review: "Menunggu tinjauan",
};
export const phaseLabel = (p: string | null | undefined) => (p ? (PHASE_LABEL[p] ?? p) : "Menyiapkan");

export const STATUS_INFO: Record<string, { label: string; cls: string }> = {
  none: { label: "belum dijalankan", cls: "bg-surface-2 text-muted" },
  pending: { label: "belum dijalankan", cls: "bg-surface-2 text-muted" },
  queued: { label: "antre", cls: "bg-surface-2 text-muted" },
  running: { label: "berjalan", cls: "bg-info-soft text-info" },
  done: { label: "selesai", cls: "bg-ok-soft text-ok" },
  needs_review: { label: "perlu ditinjau", cls: "bg-warn-soft text-warn" },
  failed: { label: "gagal", cls: "bg-danger-soft text-danger" },
};
export const statusInfo = (s: string | null | undefined) => STATUS_INFO[s ?? "none"] ?? { label: s ?? "–", cls: "bg-surface-2 text-muted" };

/** Hasil utama dalam satu kalimat (summary() node; cadangan: jumlah butir). */
export function keyResult(key: string, output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (key === "grand_design") {
    const s = (output as { executiveSummary?: unknown }).executiveSummary;
    if (Array.isArray(s)) return `${s.length} kalimat ringkasan eksekutif`;
  }
  return summaryOf(key, output);
}

/** Kode kelompok (ES, SGS, …) untuk sebuah analisis; null untuk kustom. */
export function groupCodeOf(key: string): string | null {
  if (isCustomKey(key)) return null;
  const g = NODE_META[key as NodeKey]?.group;
  return g && g !== "custom" ? (groupOf(g as NodeGroup)?.code ?? null) : null;
}

/** Kelompok palet proses: urutan dan kunci mengikuti tab Excel framework (grand design lewat elemen Output). */
export const PROCESS_GROUPS: { id: NodeGroup; code: string; label: string; hint: string; keys: NodeKey[] }[] = NODE_GROUPS.filter((g) => g.id !== "output" && g.id !== "custom")
  .map((g) => ({ ...g, keys: NODE_KEYS.filter((k) => k !== "grand_design" && NODE_META[k].group === g.id) }))
  .filter((g) => g.keys.length > 0);

/** Urutan analisis bawaan (sesuai daftar tab Excel). */
export const ORDER: string[] = [...NODE_KEYS];
