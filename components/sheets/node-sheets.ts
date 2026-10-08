// Sheet (Grid[]) untuk hasil sebuah analisis: dari `sheets()` node bila ada, atau tabel sederhana dari `items()`.
// Dipakai panel proses, tinjauan, dan panel Perhitungan. Aman di client (file node bebas server).
import { GridBuilder, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import type { AnnotItem, SheetContext } from "@/lib/nodes/types";
import { getNode } from "@/lib/nodes/registry";

type DefLike = {
  label?: string;
  sheets?: (out: unknown, ctx: SheetContext) => Grid[];
  items?: (out: unknown) => AnnotItem[];
};

export type SheetsResult = {
  grids: Grid[];
  /** true = node belum punya sheet; ditampilkan daftar butir sederhana. */
  fallback: boolean;
  /** Pesan bila sheet node gagal dibuat (mis. hasil lama yang bentuknya berbeda). */
  error?: string;
};

/** Tabel sederhana ID | Butir | Keterangan dari items() — cadangan bila node belum punya sheet. */
export function itemsGrid(items: AnnotItem[], label: string): Grid {
  const g = new GridBuilder("butir", label, label);
  g.set(0, 0, label, { style: "title", cs: 3 });
  g.row(2, 0, ["ID", "Butir", "Keterangan"], { style: "header" });
  items.forEach((it, i) => {
    g.set(3 + i, 0, it.id, { style: "label" });
    g.set(3 + i, 1, it.text, { style: "text", src: "ai" });
    g.set(3 + i, 2, it.detail ?? "", { style: "muted" });
  });
  if (!items.length) g.set(3, 0, "Belum ada butir.", { style: "note", cs: 3 });
  return g.build({ cols: [8, 48, 30] });
}

/** Sheet dari definisi node (bisa definisi tiruan di uji). Tidak pernah melempar galat. */
export function sheetsFromDef(def: DefLike | null, output: unknown, ctx: SheetContext): SheetsResult {
  if (output === null || output === undefined) return { grids: [], fallback: false };
  let error: string | undefined;
  if (def?.sheets) {
    try {
      const grids = def.sheets(output, ctx).filter((g) => g && Array.isArray(g.cells));
      if (grids.length) return { grids, fallback: false };
    } catch (e) {
      error = `Tabel analisis ini belum bisa ditampilkan: ${(e as Error).message}`;
    }
  }
  try {
    const items = def?.items ? def.items(output) : [];
    return { grids: [itemsGrid(Array.isArray(items) ? items : [], ctx.label)], fallback: true, error };
  } catch (e) {
    return { grids: [], fallback: true, error: error ?? `Hasil tidak bisa dibaca: ${(e as Error).message}` };
  }
}

function defOf(key: string): DefLike | null {
  try {
    return getNode(key);
  } catch {
    return null;
  }
}

/** Sheet untuk analisis `key` (bawaan atau kustom). */
export function sheetsFor(key: string, output: unknown, ctx: SheetContext): SheetsResult {
  return sheetsFromDef(defOf(key), output, ctx);
}

/** Rumus yang dipakai analisis `key` (kosong untuk kustom / node yang belum menuliskannya). */
export function formulasOf(key: string): FormulaDoc[] {
  const d = defOf(key) as { formulas?: FormulaDoc[] } | null;
  return Array.isArray(d?.formulas) ? d.formulas : [];
}

/** Ringkasan satu kalimat hasil analisis (summary() node), atau jumlah butir sebagai cadangan. */
export function summaryOf(key: string, output: unknown): string | null {
  if (output === null || output === undefined) return null;
  const d = defOf(key) as (DefLike & { summary?: (o: unknown) => string }) | null;
  if (d?.summary) {
    try {
      const s = d.summary(output);
      if (s && s.trim()) return s.trim();
    } catch {
      /* jatuh ke cadangan */
    }
  }
  try {
    const items = d?.items?.(output);
    if (Array.isArray(items)) return `${items.length} butir`;
  } catch {
    /* abaikan */
  }
  return null;
}
