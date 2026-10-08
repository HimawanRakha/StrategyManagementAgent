// Penyusun satu bagian dokumen grand design dari node run (memakai sheets/blocks/summary/items/formulas node).
// Modul murni (aman di client), tetapi memuat registry node.
import type { AnnotItem, CheckResult, NodeDef, NodeGroup, SheetContext } from "@/lib/nodes/types";
import { GridBuilder, type Block, type Grid } from "@/lib/sheets/grid";
import { getNode } from "@/lib/nodes/registry";
import { isCustomKey, type CustomOutput } from "@/lib/nodes/custom";
import type { NodeEdit } from "@/lib/db/schema";
import { STATUS_LABEL, groupCodeOf, summarizeEdits, type DocCheck, type DocSection, type SectionStatus } from "./doc";

export type SectionInput = {
  key: string;
  label: string;
  status: SectionStatus;
  /** Output setelah kalkulator (dipakai hanya bila status selesai). */
  output?: unknown;
  /** Output semua analisis selesai di run (untuk SheetContext). */
  inputs?: Record<string, unknown>;
  error?: string | null;
  edits?: NodeEdit[];
  validatorEnabled?: boolean;
  validationPassed?: boolean | null;
  /** Hasil pemeriksaan pada percobaan terakhir. */
  checks?: CheckResult[];
  questions?: { label: string; question: string }[];
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

function defOf(key: string): NodeDef | null {
  try {
    return getNode(key);
  } catch {
    return null;
  }
}

/** Sheet sederhana dari daftar butir (untuk analisis yang belum punya sheet sendiri). */
export function itemsGrid(label: string, sheetName: string, items: AnnotItem[], summary?: string | null): Grid {
  const g = new GridBuilder("butir", sheetName || label, label);
  g.set(0, 0, label, { style: "title", cs: 3 });
  let r = 1;
  if (summary) g.set(r++, 0, summary, { style: "note", cs: 3 });
  r++;
  g.row(r, 0, ["ID", "Butir", "Rincian"], { style: "header" });
  items.forEach((it, i) => {
    g.set(r + 1 + i, 0, it.id, { style: "label" });
    g.set(r + 1 + i, 1, it.text, { style: "text", src: "ai" });
    g.set(r + 1 + i, 2, it.detail ?? "", { style: "muted" });
  });
  if (!items.length) g.set(r + 1, 0, "(tidak ada butir)", { style: "muted", cs: 3 });
  return g.build({
    cols: [10, 60, 50],
    freeze: { rows: r + 1, cols: 0 },
    notes: ["Sheet ini disusun dari daftar butir hasil analisis karena tampilan tabel khusus untuk analisis ini belum tersedia."],
  });
}

/** Tabel ringkas dari daftar butir (untuk analisis yang belum punya blok dokumen sendiri). */
export function itemsBlocks(items: AnnotItem[]): Block[] {
  if (!items.length) return [{ type: "note", text: "Tidak ada butir." }];
  return [{ type: "table", head: ["ID", "Butir", "Rincian"], widths: [10, 50, 40], rows: items.map((i) => [i.id, i.text, i.detail ?? ""]) }];
}

const cites = (ev: { chunkId: string }[] | undefined) => (ev ?? []).map((e) => `[${e.chunkId}]`).join(" ");

/** Blok untuk node kustom (bentuk tabel pengguna atau daftar butir). */
export function customBlocks(out: CustomOutput): Block[] {
  const b: Block[] = [];
  if (out.summary) b.push({ type: "p", text: out.summary });
  const cols = (out.columns ?? []).slice(0, 5);
  const items = out.items ?? [];
  if (cols.length)
    b.push({
      type: "table",
      head: ["ID", ...cols, "Bukti"],
      rows: items.map((i) => [i.id, ...cols.map((_, j) => i.cells?.[j] ?? ""), cites(i.evidence)]),
    });
  else
    b.push({
      type: "table",
      head: ["ID", "Butir", "Dasar", "Bukti"],
      widths: [8, 56, 16, 20],
      rows: items.map((i) => [i.id, i.text, (i.refs ?? []).join(", "), cites(i.evidence)]),
    });
  return b;
}

/** Susun satu bagian dokumen dari node run. Tidak pernah melempar galat: masalah dicatat di `renderErrors`. */
export function buildSection(input: SectionInput): DocSection {
  const def = defOf(input.key);
  const custom = isCustomKey(input.key);
  const group: NodeGroup = custom ? "custom" : (def?.group ?? "custom");
  const sheetName = custom ? input.label.toUpperCase() : (def?.sheetName ?? input.label);
  const available = input.status === "done" && input.output !== undefined && input.output !== null;
  const ctx: SheetContext = { label: input.label, inputs: input.inputs ?? {} };
  const renderErrors: string[] = [];
  const out = available ? input.output : null;

  let items: AnnotItem[] = [];
  let summary: string | null = null;
  let grids: Grid[] = [];
  let blocks: Block[] = [];
  const fallback = { sheets: false, blocks: false };
  if (available && def) {
    try {
      items = def.items(out) ?? [];
    } catch (e) {
      renderErrors.push(`Daftar butir tidak dapat dibaca: ${errMsg(e)}`);
    }
    try {
      summary = def.summary?.(out) ?? (custom ? ((out as CustomOutput)?.summary ?? null) : null);
    } catch (e) {
      renderErrors.push(`Ringkasan tidak dapat dibuat: ${errMsg(e)}`);
    }
    try {
      grids = def.sheets?.(out, ctx) ?? [];
    } catch (e) {
      renderErrors.push(`Sheet tidak dapat dibuat: ${errMsg(e)}`);
      grids = [];
    }
    if (!grids.length) {
      grids = [itemsGrid(input.label, sheetName, items, summary)];
      fallback.sheets = true;
    }
    try {
      blocks = def.blocks?.(out, ctx) ?? (custom ? customBlocks(out as CustomOutput) : []);
    } catch (e) {
      renderErrors.push(`Blok dokumen tidak dapat dibuat: ${errMsg(e)}`);
      blocks = [];
    }
    if (!blocks.length) {
      blocks = itemsBlocks(items);
      fallback.blocks = true;
    }
  } else if (available && !def) {
    renderErrors.push(`Analisis "${input.key}" tidak dikenal oleh versi aplikasi ini.`);
  }

  const checkLabel = (c: CheckResult) => c.label ?? def?.checks.find((x) => x.name === c.check)?.description ?? c.check;
  const checks: DocCheck[] = (input.checks ?? []).map((c) => ({
    check: c.check,
    label: checkLabel(c),
    kind: c.kind,
    passed: c.passed,
    failures: c.failures ?? [],
  }));
  return {
    key: input.key,
    label: input.label,
    group,
    groupCode: groupCodeOf(group),
    sheetName,
    status: input.status,
    statusLabel: STATUS_LABEL[input.status] ?? input.status,
    available,
    error: input.error ?? null,
    summary,
    output: out,
    grids,
    sheets: grids.map((g) => ({ id: g.id, name: g.name, title: g.title })),
    blocks,
    formulas: def?.formulas ?? [],
    items,
    edits: summarizeEdits(input.edits),
    validation: {
      enabled: !!input.validatorEnabled,
      passed: input.validationPassed ?? null,
      checks,
      failed: checks.filter((c) => !c.passed).length,
      passedChecks: checks.filter((c) => c.passed).length,
    },
    questions: input.questions ?? [],
    renderErrors,
    fallback,
  };
}

