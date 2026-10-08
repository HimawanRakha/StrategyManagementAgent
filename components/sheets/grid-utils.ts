// Helper murni untuk menggambar Grid (sheet ala Excel) di UI: tata letak sel gabungan, format angka gaya Indonesia,
// rumus dengan rujukan antar-sheet, penanda "diubah manusia", nilai masukan pengguna, dan konteks sel.
// Tanpa React — diuji di tests/ui-helpers.test.ts.
import { addr, gridSize, pathKey, type CellEdit, type CellSource, type Grid, type GridCell } from "@/lib/sheets/grid";

// ---------- Tata letak sel gabungan ----------

export type LayoutCell = { cell: GridCell; rs: number; cs: number };
/** Satu slot tabel: sel (pojok kiri-atas gabungan), "covered" (tertutup gabungan), atau null (kosong). */
export type LayoutSlot = LayoutCell | "covered" | null;
export type GridLayout = { rows: number; cols: number; slots: LayoutSlot[][] };

/**
 * Susun sel ke matriks baris × kolom untuk <table> (rowSpan/colSpan).
 * Sel yang tumpang tindih dengan gabungan sebelumnya dibuang (seperti Excel: hanya sel kiri-atas gabungan yang terlihat);
 * gabungan yang menabrak sel lain dipersempit agar tabel tetap rapi.
 */
export function layoutGrid(g: Pick<Grid, "cells">): GridLayout {
  const { rows, cols } = gridSize(g as Grid);
  const slots: LayoutSlot[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null as LayoutSlot));
  const cells = [...g.cells].filter((x) => x.r >= 0 && x.c >= 0).sort((a, b) => a.r - b.r || a.c - b.c);
  for (const cell of cells) {
    const { r, c } = cell;
    if (slots[r][c] !== null) continue;
    let cs = 1;
    const wantCs = Math.max(1, Math.floor(cell.cs ?? 1));
    while (cs < wantCs && c + cs < cols && slots[r][c + cs] === null) cs++;
    let rs = 1;
    const wantRs = Math.max(1, Math.floor(cell.rs ?? 1));
    while (rs < wantRs && r + rs < rows) {
      const row = slots[r + rs];
      let free = true;
      for (let j = c; j < c + cs; j++) if (row[j] !== null) free = false;
      if (!free) break;
      rs++;
    }
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) slots[i][j] = "covered";
    slots[r][c] = { cell, rs, cs };
  }
  return { rows, cols, slots };
}

// ---------- Format angka (gaya Indonesia: koma desimal) ----------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function loc(n: number, minD: number, maxD: number, grouping: boolean) {
  return n.toLocaleString("id-ID", { minimumFractionDigits: minD, maximumFractionDigits: Math.max(minD, maxD), useGrouping: grouping });
}

/** Format angka menurut format Excel sederhana ("0.000", "0%", "#,##0.00", "General"). */
export function formatNumber(v: number, fmt?: string, style?: GridCell["style"]): string {
  if (!Number.isFinite(v)) return "–";
  const f = (fmt ?? "").split(";")[0].replace(/"[^"]*"|\[[^\]]*\]/g, "").trim();
  if (f && f.toLowerCase() !== "general") {
    const pct = f.includes("%");
    const dec = /\.([0#]+)/.exec(f)?.[1] ?? "";
    const minD = (dec.match(/0/g) ?? []).length;
    const maxD = dec.length;
    const grouping = /[#0],[#0]/.test(f);
    const s = loc(pct ? v * 100 : v, minD, maxD, grouping);
    return pct ? `${s}%` : s;
  }
  if (style === "int") return loc(Math.round(v), 0, 0, false);
  if (style === "pct") return `${loc(v * 100, 0, 1, false)}%`;
  if (Number.isInteger(v)) return loc(v, 0, 0, false);
  return loc(v, 0, 3, false);
}

/** Teks tampilan sel: `display` bila ada, angka diformat, teks apa adanya. */
export function formatCellValue(cell: Pick<GridCell, "v" | "display" | "fmt" | "style">): string {
  if (cell.display !== undefined && cell.display !== null) return cell.display;
  const v = cell.v;
  if (v === null || v === undefined) return "";
  if (isNum(v)) return formatNumber(v, cell.fmt, cell.style);
  return String(v);
}

/** Nilai mentah (dari riwayat edit, bisa apa saja) sebagai teks pendek, mis. untuk "semula: 3". */
export function formatAny(v: unknown, edit?: Pick<CellEdit, "options">): string {
  if (v === null || v === undefined || v === "") return "(kosong)";
  if (edit?.options?.length) {
    const i = optionIndex(edit.options, v);
    if (i >= 0) return normOptions(edit.options)[i].label;
  }
  if (isNum(v)) return formatNumber(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ---------- Rumus ----------

export type FormulaPart = { type: "text"; text: string } | { type: "ref"; key: string; anchor: string };

const REF = /\{\{([^!{}]+)!([^{}]+)\}\}/g;

/** Pecah rumus menjadi teks biasa dan rujukan antar-sheet {{nodeKey!anchor}}. */
export function formulaParts(f: string): FormulaPart[] {
  const out: FormulaPart[] = [];
  let last = 0;
  for (const m of f.matchAll(REF)) {
    if (m.index! > last) out.push({ type: "text", text: f.slice(last, m.index) });
    out.push({ type: "ref", key: m[1].trim(), anchor: m[2].trim() });
    last = m.index! + m[0].length;
  }
  if (last < f.length) out.push({ type: "text", text: f.slice(last) });
  return out;
}

/** Rumus Excel yang mudah dibaca: "=" + rumus, rujukan {{ifas!total}} → "IFAS › total". */
export function formulaText(f: string, labelOf: (key: string) => string = (k) => k): string {
  return `=${formulaParts(f)
    .map((p) => (p.type === "text" ? p.text : `${labelOf(p.key)} › ${p.anchor}`))
    .join("")}`;
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "D6" / "$D$6" → { r: 5, c: 3 } (0-based). */
export function parseA1(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim());
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) };
}

export type CellRange = { r1: number; c1: number; r2: number; c2: number };

/**
 * Rentang sel di sheet yang sama yang dirujuk rumus (untuk menyorot sel asal angka, seperti Excel).
 * Rujukan antar-sheet ({{node!anchor}}, 'Sheet'!A1) dan teks dalam tanda kutip diabaikan.
 */
export function formulaRanges(f: string): CellRange[] {
  const clean = f
    .replace(REF, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g, " ")
    .replace(/[A-Za-z_][\w.]*!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g, " ");
  const out: CellRange[] = [];
  const re = /(?<![A-Za-z0-9_$.])(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(?![A-Za-z0-9_(])/g;
  for (const m of clean.matchAll(re)) {
    const a = parseA1(m[1]);
    const b = m[2] ? parseA1(m[2]) : a;
    if (!a || !b) continue;
    out.push({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });
  }
  return out;
}

// ---------- Pilihan & masukan pengguna ----------

export type EditOption = { label: string; value: string | number };

export function normOptions(options: CellEdit["options"]): EditOption[] {
  return (options ?? []).map((o) => (typeof o === "object" && o !== null ? { label: o.label, value: o.value } : { label: String(o), value: o }));
}

/** Indeks pilihan yang cocok dengan nilai (angka dibandingkan dengan toleransi, mis. 0,3333 ≈ 1/3). */
export function optionIndex(options: CellEdit["options"], v: unknown): number {
  const opts = normOptions(options);
  const exact = opts.findIndex((o) => o.value === v || String(o.value) === String(v));
  if (exact >= 0) return exact;
  if (!isNum(v)) return -1;
  let best = -1;
  let bestD = Infinity;
  opts.forEach((o, i) => {
    if (!isNum(o.value)) return;
    const d = Math.abs(o.value - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 && bestD <= Math.max(0.005, Math.abs(v) * 0.01) ? best : -1;
}

/** Baca angka yang diketik pengguna: "0,5", "0.5", "1.250,75", "1/3". NaN bila tidak valid, null bila kosong. */
export function parseNumberInput(s: string): number | null {
  const t = s.trim().replace(/\s+/g, "").replace("−", "-");
  if (!t) return null;
  const frac = /^(-?\d+(?:[.,]\d+)?)\/(\d+(?:[.,]\d+)?)$/.exec(t);
  if (frac) {
    const a = Number(frac[1].replace(",", "."));
    const b = Number(frac[2].replace(",", "."));
    return b ? a / b : NaN;
  }
  let n = t;
  if (n.includes(",") && n.includes(".")) n = n.replace(/\./g, "").replace(",", ".");
  else if (n.includes(",")) n = n.replace(",", ".");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(n)) return NaN;
  return Number(n);
}

/** Pesan galat untuk angka di luar aturan sel (min/max/step), atau null bila sah. */
export function numberError(v: number | null, edit: Pick<CellEdit, "min" | "max" | "step" | "allowEmpty">): string | null {
  if (v === null) return edit.allowEmpty ? null : "Wajib diisi";
  if (Number.isNaN(v)) return "Bukan angka";
  if (edit.min !== undefined && v < edit.min - 1e-9) return `Minimal ${formatNumber(edit.min)}`;
  if (edit.max !== undefined && v > edit.max + 1e-9) return `Maksimal ${formatNumber(edit.max)}`;
  if (edit.step) {
    const k = (v - (edit.min ?? 0)) / edit.step;
    if (Math.abs(k - Math.round(k)) > 1e-6) return `Kelipatan ${formatNumber(edit.step)}`;
  }
  return null;
}

/** Dua nilai sel dianggap sama (angka dengan toleransi kecil; kosong = null). */
export function sameValue(a: unknown, b: unknown): boolean {
  const na = a === "" || a === undefined ? null : a;
  const nb = b === "" || b === undefined ? null : b;
  if (isNum(na) && isNum(nb)) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  if (na === null || nb === null) return na === nb;
  if (typeof na === "object" || typeof nb === "object") return JSON.stringify(na) === JSON.stringify(nb);
  return na === nb;
}

// ---------- Riwayat edit ----------

export type EditLog = { path: (string | number)[]; from: unknown; to: unknown; at?: string };

/**
 * Path yang saat ini berbeda dari usulan AI → { from: nilai AI semula, to: nilai terakhir }.
 * Perubahan yang dikembalikan lagi ke nilai semula tidak dihitung.
 */
export function editedPaths(edits: EditLog[] | null | undefined): Map<string, { from: unknown; to: unknown }> {
  const m = new Map<string, { from: unknown; to: unknown }>();
  for (const e of edits ?? []) {
    if (!Array.isArray(e?.path)) continue;
    const k = pathKey(e.path);
    const prev = m.get(k);
    m.set(k, { from: prev ? prev.from : e.from, to: e.to });
  }
  for (const [k, v] of m) if (sameValue(v.from, v.to)) m.delete(k);
  return m;
}

// ---------- Sumber sel ----------

export const SOURCE_INFO: Record<CellSource, { label: string; long: string; color: string }> = {
  ai: { label: "AI", long: "Diusulkan AI (dengan alasan)", color: "var(--accent)" },
  manusia: { label: "diubah manusia", long: "Diubah/diisi pengguna", color: "var(--warn)" },
  ahp: { label: "AHP", long: "Bobot hasil perbandingan berpasangan (AHP)", color: "var(--info)" },
  hitung: { label: "hitung", long: "Dihitung sistem dengan rumus", color: "var(--primary)" },
  tetap: { label: "tetap", long: "Konstanta metode (tidak berubah)", color: "var(--muted)" },
  dokumen: { label: "dokumen", long: "Diambil dari dokumen input", color: "var(--ok)" },
};
export const SOURCE_ORDER: CellSource[] = ["ai", "manusia", "dokumen", "ahp", "hitung", "tetap"];

/** Sumber efektif sel: "manusia" bila path edit-nya ada di riwayat perubahan. */
export function effectiveSource(cell: GridCell, edited: Map<string, unknown>): CellSource | undefined {
  if (cell.edit && edited.has(pathKey(cell.edit.path))) return "manusia";
  return cell.src;
}

// ---------- Konteks sel (label baris/kolom) ----------

const isLabelText = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Label baris (sel teks terdekat di kiri) dan judul kolom (sel kepala terdekat di atas) untuk sebuah sel. */
export function cellContext(layout: GridLayout, cell: GridCell): { row: string | null; col: string | null } {
  let row: string | null = null;
  for (let j = cell.c - 1; j >= 0 && !row; j--) {
    const s = layout.slots[cell.r]?.[j];
    if (s && s !== "covered" && isLabelText(s.cell.v) && s.cell.style !== "title") row = String(s.cell.v);
  }
  let col: string | null = null;
  for (let i = cell.r - 1; i >= 0 && !col; i--) {
    // sel yang menutupi kolom ini di baris i (bisa gabungan dari kiri)
    for (let j = cell.c; j >= 0; j--) {
      const s = layout.slots[i]?.[j];
      if (s === "covered") continue;
      if (s && j + s.cs > cell.c && (s.cell.style === "header" || s.cell.style === "subheader") && isLabelText(s.cell.v)) col = String(s.cell.v);
      break;
    }
  }
  return { row, col };
}

/** Sel kunci untuk panel Perhitungan: sel berumus/berpenjelasan yang berupa total atau anchor; cadangan = sel berumus terakhir. */
export function keyCells(g: Grid, max = 4): GridCell[] {
  const anchors = new Set(Object.values(g.anchors ?? {}));
  const withCalc = g.cells.filter((x) => x.f || x.explain);
  const main = withCalc.filter((x) => x.explain && (x.style === "total" || anchors.has(addr(x.r, x.c))));
  const picked = main.length ? main : withCalc.filter((x) => x.explain).slice(-max);
  return picked.slice(0, max);
}

// ---------- Baris/kolom beku ----------

const HEAD_STYLES = new Set<GridCell["style"]>(["header", "subheader"]);

/**
 * Baris yang menempel di atas saat tabel digulir: `freeze.rows` bila ada; kalau tidak, baris kepala tabel pertama
 * (semua selnya bergaya header) beserta paling banyak satu baris kepala tepat di bawahnya.
 */
export function stickyRowsOf(g: Pick<Grid, "freeze">, layout: GridLayout): number[] {
  if (g.freeze?.rows) return Array.from({ length: Math.min(g.freeze.rows, layout.rows) }, (_, i) => i);
  const isHead = (i: number) => {
    const cells = layout.slots[i]?.filter((s): s is LayoutCell => !!s && s !== "covered") ?? [];
    return cells.length > 0 && cells.every((s) => HEAD_STYLES.has(s.cell.style)) && cells.some((s) => s.cell.style === "header");
  };
  for (let i = 0; i < Math.min(layout.rows, 12); i++) {
    if (!isHead(i)) continue;
    return isHead(i + 1) ? [i, i + 1] : [i];
  }
  return [];
}

/** Jumlah kolom beku di kiri: `freeze.cols`, atau 1 untuk tabel lebar (≥ 6 kolom). */
export function stickyColsOf(g: Pick<Grid, "freeze">, layout: GridLayout): number {
  if (g.freeze) return Math.min(g.freeze.cols, layout.cols);
  return layout.cols >= 6 ? 1 : 0;
}

// ---------- Kolom ----------

/** Lebar kolom dalam piksel dari satuan karakter Excel (bawaan 10 karakter). */
export function colWidths(g: Pick<Grid, "cols">, n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const ch = g.cols?.[i];
    const chars = typeof ch === "number" && ch > 0 ? ch : 10;
    return Math.round(Math.min(60, Math.max(3, chars)) * 7 + 12);
  });
}

/** Warna teks yang terbaca di atas warna isi (hex tanpa #). */
export function textOnFill(hex: string): string {
  const h = hex.replace("#", "").padEnd(6, "0").slice(-6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? "#1c2128" : "#ffffff";
}

// ---------- Kebasian (stale) ----------

type TimeState = { finishedAt?: string | null; editedAt?: string | null; status?: string } | undefined;

/**
 * Analisis hulu (induk mesin, berantai) yang diubah manusia SETELAH analisis `key` selesai:
 * angka `key` sudah dihitung ulang, tetapi isi teks dari AI belum mengikuti perubahan itu.
 */
export function staleSources(key: string, parentsOf: (k: string) => string[], stateOf: (k: string) => TimeState): string[] {
  const me = stateOf(key);
  if (!me?.finishedAt) return [];
  const mine = +new Date(me.finishedAt);
  if (!Number.isFinite(mine)) return [];
  const out: string[] = [];
  const seen = new Set<string>([key]);
  const stack = [...parentsOf(key)];
  while (stack.length) {
    const k = stack.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const st = stateOf(k);
    if (st?.editedAt && +new Date(st.editedAt) > mine) out.push(k);
    stack.push(...parentsOf(k));
  }
  return out;
}
