import "server-only";
// Ekspor grand design ke XLSX (exceljs): satu sheet per tab analisis (sama dengan sheet di aplikasi) dengan rumus hidup,
// sel gabungan, gaya, format angka, komentar sel (cara menghitung / alasan AI / bukti), penanda sel yang diubah manusia,
// ditambah sheet RINGKASAN (status, ringkasan eksekutif, legenda warna, daftar sheet), SUMBER, dan PEMERIKSAAN.
import ExcelJS from "exceljs";
import type { CellSource, CellStyle, Grid, GridCell, GridChart } from "@/lib/sheets/grid";
import { addr, gridSize, num, pathKey } from "@/lib/sheets/grid";
import type { DocSection, GrandDesignDoc } from "@/lib/grand-design/doc";
import { valueText } from "@/lib/grand-design/doc";
import { TRACE_KIND_LABEL } from "@/lib/grand-design/trace";
import { NODE_GROUPS } from "@/lib/nodes/groups";

type WS = ExcelJS.Worksheet;
type XCell = ExcelJS.Cell;

// ---------- Warna dan gaya ----------

const COLOR = {
  headerFill: "1F4E78",
  headerFont: "FFFFFF",
  subFill: "D9E1F2",
  totalFill: "F2F2F2",
  border: "BFBFBF",
  note: "595959",
  muted: "808080",
  link: "0563C1",
  pass: "E2EFDA",
  fail: "F8D7DA",
  warn: "FFF2CC",
};

/** Warna latar menurut asal isi sel (legenda di sheet RINGKASAN). */
export const SRC_FILL: Record<CellSource, string> = {
  ai: "FFF2CC", // kuning muda — usulan AI
  manusia: "F8CBAD", // jingga — diubah manusia
  ahp: "DDEBF7", // biru muda — bobot AHP
  hitung: "E2EFDA", // hijau muda — dihitung rumus
  tetap: "EDEDED", // abu — konstanta metode
  dokumen: "E4DFEC", // ungu muda — dari dokumen
};
const SRC_LABEL: Record<CellSource, string> = {
  ai: "Diusulkan AI — angka/teks usulan AI; bisa diubah di aplikasi (alasan AI ada di komentar sel)",
  manusia: "Diubah manusia — nilai usulan AI yang sudah diganti pengguna (nilai semula ada di komentar sel)",
  ahp: "Bobot AHP — dihitung dari perbandingan berpasangan (sheet AHP)",
  hitung: "Dihitung — hasil rumus; arahkan kursor ke sel untuk melihat cara menghitungnya",
  tetap: "Tetap — konstanta metode dari framework Excel (mis. bobot indikator)",
  dokumen: "Dokumen — diambil dari dokumen organisasi (bukti di komentar sel)",
};

const GROUP_TAB: Record<string, string> = {
  es: "2E75B6",
  sgs: "548235",
  si: "BF8F00",
  ltv: "7030A0",
  msdm: "C55A11",
  dmcrm: "C00000",
  custom: "7F7F7F",
  output: "404040",
};

const argb = (hex: string) => {
  const h = hex.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{8}$/.test(h)) return h;
  if (/^[0-9A-F]{6}$/.test(h)) return `FF${h}`;
  return null;
};
const solid = (hex: string): ExcelJS.Fill | undefined => {
  const c = argb(hex);
  return c ? { type: "pattern", pattern: "solid", fgColor: { argb: c } } : undefined;
};
const thin = { style: "thin" as const, color: { argb: `FF${COLOR.border}` } };
const BOX: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };

// ---------- Teks aman ----------

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const clean = (s: string, max = 32000) => {
  const t = s.replace(CONTROL, "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const cleanValue = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "ya" : "tidak";
  return clean(String(v));
};

// ---------- Nama sheet ----------

class SheetNames {
  private used = new Set<string>();
  constructor(reserved: string[] = []) {
    reserved.forEach((r) => this.used.add(r.toLowerCase()));
  }
  /** Nama unik (≤ 31 karakter, tanpa []:*?/\'"), tidak sama dengan nama lain tanpa membedakan huruf besar. */
  take(raw: string): string {
    let base = raw.replace(/[[\]:*?/\\'"]/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
    if (base.toLowerCase() === "history") base = "History 1";
    let name = base;
    for (let n = 2; this.used.has(name.toLowerCase()); n++) {
      const suf = ` (${n})`;
      name = base.slice(0, 31 - suf.length).trimEnd() + suf;
    }
    this.used.add(name.toLowerCase());
    return name;
  }
}

/** Rujukan sheet di rumus: 'Nama Sheet'. */
const sheetRef = (name: string) => `'${name.replace(/'/g, "''")}'`;
/** Literal teks rumus Excel. */
const strLit = (s: string) => `"${s.replace(/"/g, '""')}"`;

// ---------- Rumus ----------

const XLFN = /(?<![\w.])(CONCAT|TEXTJOIN|IFS|SWITCH|MAXIFS|MINIFS|XLOOKUP|XMATCH|IFNA|STDEV\.S|STDEV\.P|VAR\.S|VAR\.P|RANK\.EQ|RANK\.AVG|PERCENTILE\.INC|PERCENTILE\.EXC|QUARTILE\.INC|QUARTILE\.EXC|MODE\.SNGL|CEILING\.MATH|FLOOR\.MATH|NORM\.DIST|NORM\.INV)\s*\(/gi;

/**
 * Rapikan rumus untuk file XLSX: buang "=", pemisah ";" → ",", awalan _xlfn. untuk fungsi Excel baru.
 * Mengembalikan null bila rumus tampak rusak (kurung/tanda kutip tidak seimbang) — sel ditulis sebagai nilai saja
 * agar Excel tidak menolak file.
 */
export function normalizeFormula(f: string): string | null {
  let s = f.trim().replace(/^=+/, "").trim();
  if (!s || s.includes("{{")) return null;
  const parts = s.split('"');
  if (parts.length % 2 === 0) return null; // tanda kutip tidak seimbang
  let depth = 0;
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/;/g, ",").replace(XLFN, (_m, fn: string) => `_xlfn.${fn.toUpperCase()}(`);
    for (const ch of parts[i]) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) return null;
    }
  }
  if (depth !== 0) return null;
  s = parts.join('"');
  return s;
}

type AnchorIndex = Map<string, { sheet: string; anchors: Record<string, string> }[]>;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*!\s*([^}\s]+)\s*\}\}/g;

/** Ganti {{nodeKey!anchor}} dengan 'Sheet'!A1 dari grid node tujuan; `missing` berisi placeholder yang tidak ada. */
export function resolvePlaceholders(f: string, index: AnchorIndex): { formula: string; missing: string[] } {
  const missing: string[] = [];
  const formula = f.replace(PLACEHOLDER, (m, key: string, anchor: string) => {
    const hit = (index.get(key) ?? []).find((g) => g.anchors[anchor]);
    if (!hit) {
      missing.push(m);
      return m;
    }
    return `${sheetRef(hit.sheet)}!${hit.anchors[anchor]}`;
  });
  return { formula, missing };
}

// ---------- Komentar sel ----------

type NotePart = { title: string; body: string };

/**
 * Tulis komentar sel (tampil saat kursor diarahkan ke sel). Kotak komentar diperbesar sesuai panjang teks
 * (exceljs selalu memakai kotak 2×4 sel; ukuran diatur lewat model internal, aman bila versi exceljs berubah).
 */
function setNote(cell: XCell, parts: NotePart[], colWidths: (c: number) => number) {
  const ps = parts.filter((p) => p.body.trim());
  if (!ps.length) return;
  const texts: ExcelJS.RichText[] = [];
  ps.forEach((p, i) => {
    texts.push({ text: `${i ? "\n" : ""}${p.title}\n`, font: { bold: true, size: 9, name: "Tahoma" } });
    texts.push({ text: clean(p.body, 3000), font: { size: 9, name: "Tahoma" } });
  });
  cell.note = { texts, editAs: "absolute" };
  try {
    const col = Number(cell.col);
    const row = Number(cell.row);
    let width = 0;
    let span = 0;
    while (width < 48 && span < 8) width += colWidths(col + 1 + span++) || 9;
    const perLine = Math.max(20, Math.round(width * 1.15));
    const lines = ps.reduce(
      (n, p) => n + 1 + p.body.split("\n").reduce((m, l) => m + Math.max(1, Math.ceil(l.length / perLine)), 0),
      0,
    );
    const top = Math.max(row - 2, 0) + 0.75;
    const anchor = { left: col + 0.1, top, right: col + span + 0.1, bottom: top + Math.min(40, Math.max(4, Math.ceil(lines * 0.85) + 1)) };
    const note = (cell as unknown as { _comment?: { model: unknown } })._comment;
    if (note) {
      const base = note.model as Record<string, unknown>;
      Object.defineProperty(note, "model", { configurable: true, get: () => ({ ...base, anchor }) });
    }
  } catch {
    // kotak komentar bawaan
  }
}

// ---------- Gaya sel grid ----------

function applyStyle(cell: XCell, x: GridCell) {
  const style: CellStyle | undefined = x.style;
  const font: Partial<ExcelJS.Font> = { name: "Calibri", size: 10 };
  const align: Partial<ExcelJS.Alignment> = { vertical: "top", wrapText: true };
  let border: Partial<ExcelJS.Borders> | undefined;
  let fill: string | undefined;
  let fmt = x.fmt;
  switch (style) {
    case "title":
      font.bold = true;
      font.size = 14;
      align.wrapText = false;
      align.vertical = "middle";
      break;
    case "header":
      font.bold = true;
      font.color = { argb: `FF${COLOR.headerFont}` };
      fill = COLOR.headerFill;
      border = BOX;
      align.horizontal = "center";
      align.vertical = "middle";
      break;
    case "subheader":
      font.bold = true;
      fill = COLOR.subFill;
      border = BOX;
      align.vertical = "middle";
      break;
    case "label":
      font.bold = true;
      border = BOX;
      break;
    case "text":
      border = BOX;
      break;
    case "num":
      border = BOX;
      fmt ??= "0.000";
      break;
    case "int":
      border = BOX;
      fmt ??= "0";
      break;
    case "pct":
      border = BOX;
      fmt ??= "0.0%";
      break;
    case "total":
      font.bold = true;
      fill = COLOR.totalFill;
      border = { ...BOX, top: { style: "medium", color: { argb: "FF595959" } } };
      break;
    case "note":
      font.italic = true;
      font.color = { argb: `FF${COLOR.note}` };
      break;
    case "muted":
      font.color = { argb: `FF${COLOR.muted}` };
      font.size = 9;
      break;
    default:
      if (typeof x.v === "number" || x.f) border = BOX;
  }
  if (typeof x.v === "number" && style !== "title" && style !== "header") align.horizontal ??= "right";
  if (x.center) align.horizontal = "center";
  if (!fmt && typeof x.v === "number" && x.display && /^\d+\/\d+$/.test(x.display.trim())) fmt = "?/?";
  cell.font = font;
  cell.alignment = align;
  if (border) cell.border = border;
  if (fmt) cell.numFmt = fmt;
  return { fill, style };
}

// ---------- Sheet grid ----------

type GridPlan = { section: DocSection; grid: Grid; sheet: string };

function writeGrid(ws: WS, plan: GridPlan, index: AnchorIndex) {
  const { grid, section } = plan;
  const widths = grid.cols ?? [];
  widths.forEach((w, i) => {
    if (Number.isFinite(w) && w > 0) ws.getColumn(i + 1).width = Math.min(120, w);
  });
  const colWidth = (c1: number) => ws.getColumn(c1).width ?? 9;

  for (const x of grid.cells) {
    if (x.r < 0 || x.c < 0) continue;
    const cell = ws.getCell(x.r + 1, x.c + 1);
    const notes: NotePart[] = [];
    const value = cleanValue(x.v);

    if (x.f) {
      const { formula, missing } = resolvePlaceholders(x.f, index);
      const norm = missing.length ? null : normalizeFormula(formula);
      if (norm) {
        cell.value = value === null ? { formula: norm } : { formula: norm, result: value };
      } else {
        cell.value = value;
        notes.push({
          title: "Rumus tidak ditulis sebagai rumus hidup",
          body: missing.length
            ? `Rumus aslinya merujuk sheet yang tidak ada di file ini (${missing.join(", ")}): =${x.f}`
            : `Rumus aslinya tidak bisa dibaca Excel: =${x.f}`,
        });
      }
    } else cell.value = value;

    const { fill: styleFill, style } = applyStyle(cell, x);

    // Warna: diubah manusia > warna sel > kepala tabel > asal isi > baris total
    const editKey = x.edit ? pathKey(x.edit.path) : null;
    const edited = editKey ? section.edits.byPath[editKey] : undefined;
    let fill: string | undefined;
    if (edited) fill = SRC_FILL.manusia;
    else if (x.fill) fill = x.fill;
    else if (style === "header" || style === "subheader") fill = styleFill;
    else if (x.src && SRC_FILL[x.src]) fill = SRC_FILL[x.src];
    else fill = styleFill;
    const f = fill ? solid(fill) : undefined;
    if (f) cell.fill = f;
    if (edited) cell.font = { ...cell.font, bold: true };

    if (x.explain) notes.push({ title: "Cara menghitung", body: x.explain });
    if (x.note) notes.push({ title: x.src === "ai" ? "Alasan AI" : "Catatan", body: x.note });
    if (x.refs?.length) notes.push({ title: "Bukti", body: `${x.refs.join(", ")} (isi potongan di sheet SUMBER)` });
    if (x.display && typeof x.v === "number" && !/^\d+\/\d+$/.test(x.display.trim()) && x.display !== String(x.v))
      notes.push({ title: "Ditampilkan di aplikasi sebagai", body: x.display });
    if (edited)
      notes.push({
        title: "Diubah manusia",
        body: `Semula ${valueText(edited.from)} (usulan AI) → kini ${valueText(edited.to)}${edited.times > 1 ? `, diubah ${edited.times} kali` : ""}${edited.at ? ` · ${edited.at.slice(0, 16).replace("T", " ")}` : ""}.`,
      });
    else if (x.edit && x.src === "ai") notes.push({ title: "Bisa diubah", body: "Nilai ini usulan AI dan bisa diubah di aplikasi; analisis sesudahnya akan dihitung ulang." });
    setNote(cell, notes, colWidth);
  }

  // Sel gabungan (gaya sel induk disalin ke seluruh rentang oleh exceljs).
  for (const x of grid.cells) {
    const rs = Math.max(1, x.rs ?? 1);
    const cs = Math.max(1, x.cs ?? 1);
    if (rs === 1 && cs === 1) continue;
    try {
      ws.mergeCells(x.r + 1, x.c + 1, x.r + rs, x.c + cs);
    } catch {
      // tumpang-tindih dengan gabungan lain: lewati
    }
  }

  // Judul (gaya title) tidak dibungkus; baris judul sedikit lebih tinggi.
  const titleRows = new Set(grid.cells.filter((x) => x.style === "title").map((x) => x.r + 1));
  titleRows.forEach((r) => (ws.getRow(r).height = 22));

  if (grid.freeze && (grid.freeze.rows > 0 || grid.freeze.cols > 0))
    ws.views = [{ state: "frozen", xSplit: Math.max(0, grid.freeze.cols), ySplit: Math.max(0, grid.freeze.rows) }];

  // Di bawah tabel: cara membaca, data grafik, dan asal sheet (tanpa menggeser alamat sel tabel).
  const size = gridSize(grid);
  const span = Math.max(4, Math.min(size.cols || 4, 10));
  let r = size.rows + 2;
  const merged = (row: number, text: string, opts: { bold?: boolean; italic?: boolean; color?: string } = {}) => {
    const c = ws.getCell(row, 1);
    c.value = clean(text);
    c.font = { name: "Calibri", size: 10, bold: opts.bold, italic: opts.italic, color: opts.color ? { argb: `FF${opts.color}` } : undefined };
    c.alignment = { wrapText: true, vertical: "top" };
    try {
      ws.mergeCells(row, 1, row, span);
    } catch {
      /* sudah tergabung */
    }
    let w = 0;
    for (let i = 1; i <= span; i++) w += colWidth(i);
    const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(20, w * 1.1))), 0);
    ws.getRow(row).height = Math.max(15, lines * 14);
  };
  if (grid.notes?.length) {
    merged(r++, "Cara membaca", { bold: true });
    for (const n of grid.notes) merged(r++, `• ${n}`, { italic: true, color: COLOR.note });
    r++;
  }
  if (grid.chart) r = writeChartData(ws, r, grid.chart) + 1;
  const meta = [
    `Analisis: ${section.label} (${section.groupCode}) · status ${section.statusLabel}`,
    section.edits.count ? `${section.edits.count} nilai diubah manusia (sel berwarna jingga)` : "",
    section.validation.failed ? `${section.validation.failed} pemeriksaan otomatis gagal — lihat sheet PEMERIKSAAN` : "",
    section.fallback.sheets ? "sheet disusun dari daftar butir (tabel khusus belum tersedia)" : "",
  ].filter(Boolean);
  merged(r, meta.join(" · "), { italic: true, color: COLOR.muted });

  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

/** exceljs tidak bisa menggambar grafik: tulis tabel datanya agar bisa dibuat grafik di Excel (Insert → Chart). */
function writeChartData(ws: WS, r0: number, chart: GridChart): number {
  let r = r0;
  const head = (cells: string[]) => {
    cells.forEach((h, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = h;
      c.font = { name: "Calibri", size: 10, bold: true, color: { argb: `FF${COLOR.headerFont}` } };
      c.fill = solid(COLOR.headerFill)!;
      c.border = BOX;
    });
    r++;
  };
  const row = (cells: (string | number)[], fmt?: string) => {
    cells.forEach((v, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = cleanValue(v);
      c.font = { name: "Calibri", size: 10 };
      c.border = BOX;
      if (typeof v === "number" && fmt) c.numFmt = fmt;
    });
    r++;
  };
  const t = ws.getCell(r++, 1);
  t.value = clean(`Data grafik: ${chart.title}`);
  t.font = { name: "Calibri", size: 11, bold: true };
  const n = ws.getCell(r++, 1);
  n.value = "Grafik tampil di aplikasi; file ini memuat datanya. Untuk menggambar di Excel: pilih tabel di bawah lalu Insert → Chart.";
  n.font = { name: "Calibri", size: 9, italic: true, color: { argb: `FF${COLOR.note}` } };
  if (chart.type === "quadrant") {
    head(["Sumbu", "Nilai"]);
    row([chart.xLabel, chart.x], "0.000");
    row([chart.yLabel, chart.y], "0.000");
    head(["Kuadran", "Label"]);
    ["Kanan-atas", "Kiri-atas", "Kiri-bawah", "Kanan-bawah"].forEach((q, i) => row([q, chart.quadrants[i] ?? ""]));
  } else if (chart.type === "bar") {
    head(["Label", "Nilai"]);
    for (const d of chart.data) row([d.label, d.value], "0.000");
  } else if (chart.type === "scatter") {
    head(["Label", chart.xLabel, chart.yLabel]);
    for (const p of chart.points) row([p.label, p.x, p.y], "0.00");
    if (chart.threshold !== undefined) row(["Batas", chart.threshold, chart.threshold], "0.00");
  }
  return r;
}

// ---------- Tabel daftar (RINGKASAN, SUMBER, PEMERIKSAAN) ----------

type TCell = string | number | null | { text: string; link?: string; fill?: string; bold?: boolean };

/** Tabel berkepala. `lastTo`: kolom terakhir digabung sampai kolom ini (1-based) agar teks panjang muat. */
function table(ws: WS, r0: number, head: string[], rows: TCell[][], opts: { c0?: number; lastTo?: number } = {}): number {
  const c0 = opts.c0 ?? 1;
  const lastCol = c0 + head.length - 1;
  const spanLast = (r: number) => {
    if (opts.lastTo && opts.lastTo > lastCol)
      try {
        ws.mergeCells(r, lastCol, r, opts.lastTo);
      } catch {
        /* sudah tergabung */
      }
  };
  head.forEach((h, i) => {
    const c = ws.getCell(r0, c0 + i);
    c.value = h;
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: `FF${COLOR.headerFont}` } };
    c.fill = solid(COLOR.headerFill)!;
    c.border = BOX;
    c.alignment = { vertical: "middle", wrapText: true };
  });
  spanLast(r0);
  let r = r0 + 1;
  for (const row of rows) {
    row.forEach((v, i) => {
      const c = ws.getCell(r, c0 + i);
      c.border = BOX;
      c.alignment = { vertical: "top", wrapText: true };
      c.font = { name: "Calibri", size: 10 };
      if (v !== null && typeof v === "object") {
        if (v.link) {
          c.value = { formula: `HYPERLINK(${strLit(`#${sheetRef(v.link)}!A1`)},${strLit(clean(v.text, 250))})`, result: clean(v.text, 250) };
          c.font = { name: "Calibri", size: 10, underline: true, color: { argb: `FF${COLOR.link}` } };
        } else c.value = clean(v.text);
        if (v.fill) c.fill = solid(v.fill)!;
        if (v.bold) c.font = { ...c.font, bold: true };
      } else c.value = cleanValue(v);
    });
    spanLast(r);
    r++;
  }
  return r;
}

function heading(ws: WS, r: number, text: string, size = 12) {
  const c = ws.getCell(r, 1);
  c.value = text;
  c.font = { name: "Calibri", size, bold: true, color: { argb: "FF1F4E78" } };
  return r + 1;
}

function para(ws: WS, r: number, text: string, span: number, opts: { italic?: boolean; color?: string; height?: number } = {}) {
  const c = ws.getCell(r, 1);
  c.value = clean(text);
  c.font = { name: "Calibri", size: 10, italic: opts.italic, color: opts.color ? { argb: `FF${opts.color}` } : undefined };
  c.alignment = { wrapText: true, vertical: "top" };
  try {
    ws.mergeCells(r, 1, r, span);
  } catch {
    /* sudah tergabung */
  }
  if (opts.height) ws.getRow(r).height = opts.height;
  return r + 1;
}

const checkText = (s: DocSection) =>
  !s.validation.enabled
    ? "validator tidak dipasang"
    : !s.validation.checks.length
      ? s.available
        ? "belum ada catatan"
        : "-"
      : `${s.validation.passedChecks} lolos · ${s.validation.failed} gagal`;

// ---------- Buku kerja ----------

/** Buku kerja XLSX grand design. */
export async function grandDesignXlsx(doc: GrandDesignDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Platform Eksperimen Alur Agen LLM";
  wb.title = `Grand Design ${doc.projectName}`;
  wb.created = new Date(doc.generatedAt);
  wb.calcProperties.fullCalcOnLoad = true; // Excel menghitung ulang semua rumus saat file dibuka

  const names = new SheetNames(["RINGKASAN", "SUMBER", "PEMERIKSAAN"]);
  const plans: GridPlan[] = [];
  for (const s of doc.sections) {
    if (!s.available) continue;
    for (const g of s.grids) plans.push({ section: s, grid: g, sheet: names.take(g.name || s.sheetName || s.label) });
  }
  const index: AnchorIndex = new Map();
  for (const p of plans) {
    const list = index.get(p.section.key) ?? [];
    list.push({ sheet: p.sheet, anchors: p.grid.anchors ?? {} });
    index.set(p.section.key, list);
  }

  const summary = wb.addWorksheet("RINGKASAN", { properties: { tabColor: { argb: "FF1F4E78" } } });
  for (const p of plans) {
    const ws = wb.addWorksheet(p.sheet, { properties: { tabColor: { argb: `FF${GROUP_TAB[p.section.group] ?? "7F7F7F"}` } } });
    writeGrid(ws, p, index);
  }
  writeSources(wb.addWorksheet("SUMBER", { properties: { tabColor: { argb: "FF7F7F7F" } } }), doc);
  writeChecks(wb.addWorksheet("PEMERIKSAAN", { properties: { tabColor: { argb: "FFC00000" } } }), doc);
  writeSummary(summary, doc, plans);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

function writeSummary(ws: WS, doc: GrandDesignDoc, plans: GridPlan[]) {
  [5, 12, 30, 18, 60, 14, 22, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const SPAN = 8;
  const t = ws.getCell(1, 1);
  t.value = clean(`Grand Design ${doc.projectName}`);
  t.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF1F4E78" } };
  ws.getRow(1).height = 24;
  let r = para(ws, 2, "DRAF hasil platform agen LLM — wajib ditelaah pengurus sebelum dipakai.", SPAN, { italic: true, color: COLOR.note });
  r++;
  const available = doc.sections.filter((s) => s.available).length;
  const info: [string, string][] = [
    ["Proyek", doc.projectName],
    ["Jenis organisasi", doc.orgType ?? "-"],
    ["Run", `${doc.runId.slice(0, 8)} (${doc.experimentTag})`],
    ["Disusun", new Date(doc.generatedAt).toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" })],
    ["Analisis tersedia", `${available} dari ${doc.sections.length}`],
    [
      "Ketertelusuran",
      doc.trace.total ? `${doc.trace.complete} dari ${doc.trace.total} elemen (${num((doc.trace.complete / doc.trace.total) * 100, 0)}%) sampai ke kutipan sumber` : "belum ada elemen berujukan",
    ],
  ];
  for (const [k, v] of info) {
    const a = ws.getCell(r, 2);
    a.value = k;
    a.font = { name: "Calibri", size: 10, bold: true };
    const b = ws.getCell(r, 3);
    b.value = clean(v);
    b.font = { name: "Calibri", size: 10 };
    try {
      ws.mergeCells(r, 3, r, 5);
    } catch {
      /* - */
    }
    r++;
  }
  r++;

  // Status per analisis
  r = heading(ws, r, "Status analisis (urut alur)");
  const firstSheet = new Map<string, string>();
  for (const p of plans) if (!firstSheet.has(p.section.key)) firstSheet.set(p.section.key, p.sheet);
  r = table(
    ws,
    r,
    ["No", "Kelompok", "Analisis", "Status", "Hasil utama", "Diubah manusia", "Pemeriksaan otomatis", "Sheet"],
    doc.sections.map((s, i) => [
      i + 1,
      s.groupCode,
      { text: s.label, bold: true },
      { text: s.statusLabel, fill: s.available ? COLOR.pass : s.status === "failed" ? COLOR.fail : COLOR.warn },
      s.available ? (s.summary ?? "-") : s.error ? `Galat: ${s.error}` : "-",
      s.edits.count ? { text: `${s.edits.count} sel`, fill: SRC_FILL.manusia } : "-",
      { text: checkText(s), fill: s.validation.failed ? COLOR.fail : s.validation.checks.length ? COLOR.pass : undefined },
      firstSheet.has(s.key) ? { text: firstSheet.get(s.key)!, link: firstSheet.get(s.key)! } : "-",
    ]),
  );
  r++;

  // Ringkasan eksekutif
  r = heading(ws, r, "Ringkasan eksekutif");
  if (doc.executiveSummary?.length) {
    for (const [i, s] of doc.executiveSummary.entries()) {
      const a = ws.getCell(r, 1);
      a.value = `K${i + 1}`;
      a.font = { name: "Calibri", size: 10, bold: true };
      a.alignment = { vertical: "top" };
      const b = ws.getCell(r, 2);
      b.value = clean(s.text);
      b.font = { name: "Calibri", size: 10 };
      b.alignment = { wrapText: true, vertical: "top" };
      b.fill = solid(SRC_FILL.ai)!;
      try {
        ws.mergeCells(r, 2, r, 6);
      } catch {
        /* - */
      }
      ws.getRow(r).height = Math.max(15, Math.ceil(s.text.length / 120) * 14);
      const c = ws.getCell(r, 7);
      c.value = clean(s.refs.join(", "));
      c.font = { name: "Calibri", size: 9, color: { argb: `FF${COLOR.muted}` } };
      c.alignment = { wrapText: true, vertical: "top" };
      try {
        ws.mergeCells(r, 7, r, 8);
      } catch {
        /* - */
      }
      r++;
    }
  } else r = para(ws, r, `Ringkasan eksekutif belum tersedia (${doc.executiveStatus}). Jalankan node grand design untuk menyusunnya.`, SPAN, { italic: true, color: COLOR.note });
  r++;

  // Cara membaca
  r = heading(ws, r, "Cara membaca file ini");
  const how = [
    "Setiap analisis punya sheet sendiri (nama sheet sama dengan tab di Excel framework). Urutan sheet mengikuti alur di canvas.",
    "Sel bersegitiga merah di pojok kanan atas punya komentar: arahkan kursor ke sel untuk melihat cara menghitung angka itu, alasan AI, bukti, atau nilai semula sebelum diubah manusia.",
    "Sel berumus memakai rumus Excel yang hidup: bila angka usulan diubah di file ini, total dan peringkat ikut dihitung ulang. Rujukan antarsheet (mis. IFAS → posisi organisasi) juga berupa rumus.",
    "Warna latar sel menunjukkan asal isinya (lihat legenda di bawah). Sheet SUMBER memuat isi potongan dokumen yang dikutip (C… = dokumen, U… = jawaban pengguna); sheet PEMERIKSAAN memuat hasil pemeriksaan otomatis, galat, dan pertanyaan agen.",
    "Grafik tidak ikut tergambar di file ini; tabel datanya ada di bawah tabel utama sheet terkait.",
  ];
  for (const h of how) r = para(ws, r, `• ${h}`, SPAN, { height: Math.max(15, Math.ceil(h.length / 150) * 14) });
  r++;

  // Legenda warna
  r = heading(ws, r, "Arti warna sel");
  for (const src of ["ai", "manusia", "ahp", "hitung", "tetap", "dokumen"] as CellSource[]) {
    const a = ws.getCell(r, 2);
    a.value = src === "manusia" ? "manusia" : src;
    a.fill = solid(SRC_FILL[src])!;
    a.border = BOX;
    a.font = { name: "Calibri", size: 10, bold: src === "manusia" };
    a.alignment = { horizontal: "center" };
    const b = ws.getCell(r, 3);
    b.value = SRC_LABEL[src];
    b.font = { name: "Calibri", size: 10 };
    try {
      ws.mergeCells(r, 3, r, 6);
    } catch {
      /* - */
    }
    r++;
  }
  const hdr = ws.getCell(r, 2);
  hdr.value = "kepala";
  hdr.fill = solid(COLOR.headerFill)!;
  hdr.font = { name: "Calibri", size: 10, bold: true, color: { argb: `FF${COLOR.headerFont}` } };
  hdr.alignment = { horizontal: "center" };
  ws.getCell(r, 3).value = "Kepala tabel; warna lain (mis. warna kuadran) mengikuti Excel framework.";
  r += 2;

  // Daftar sheet
  r = heading(ws, r, "Daftar sheet");
  const groupLabel = (g: string) => NODE_GROUPS.find((x) => x.id === g)?.code ?? (g === "custom" ? "KUSTOM" : g);
  table(ws, r, ["No", "Kelompok", "Sheet", "Analisis", "Judul tabel"], [
    ...plans.map((p, i) => [i + 1, groupLabel(p.section.group), { text: p.sheet, link: p.sheet }, p.section.label, p.grid.title]),
    [plans.length + 1, "-", { text: "SUMBER", link: "SUMBER" }, "Sumber kutipan", "Isi potongan dokumen yang dikutip"],
    [plans.length + 2, "-", { text: "PEMERIKSAAN", link: "PEMERIKSAAN" }, "Pemeriksaan", "Hasil pemeriksaan otomatis, jejak rujukan, galat, pertanyaan agen, nilai yang diubah manusia"],
  ]);
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

function writeSources(ws: WS, doc: GrandDesignDoc) {
  [8, 18, 28, 110].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getCell(1, 1).value = "Sumber kutipan";
  ws.getCell(1, 1).font = { name: "Calibri", size: 14, bold: true };
  ws.getCell(2, 1).value = "C… = potongan dokumen organisasi; U… = jawaban pengguna atas pertanyaan agen.";
  ws.getCell(2, 1).font = { name: "Calibri", size: 10, italic: true, color: { argb: `FF${COLOR.note}` } };
  const src = Object.entries(doc.sources);
  if (!src.length) {
    ws.getCell(4, 1).value = "Tidak ada kutipan pada analisis yang tersedia.";
    return;
  }
  table(
    ws,
    4,
    ["ID", "Jenis", "Sumber", "Isi potongan"],
    src.map(([id, s]) => [{ text: id, bold: true }, s.kind === "user_answer" ? "Jawaban pengguna" : "Dokumen", s.source, s.content || "(isi potongan tidak ditemukan)"]),
  );
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];
}

function writeChecks(ws: WS, doc: GrandDesignDoc) {
  [24, 34, 12, 16, 30, 70].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getCell(1, 1).value = "Pemeriksaan, galat, dan pertanyaan";
  ws.getCell(1, 1).font = { name: "Calibri", size: 14, bold: true };
  let r = para(
    ws,
    2,
    "Hasil pemeriksaan otomatis pada percobaan TERAKHIR setiap analisis (lolos maupun gagal), galat penyusunan, jejak rujukan, pertanyaan agen yang belum dijawab, dan nilai yang diubah manusia.",
    6,
    { italic: true, color: COLOR.note, height: 28 },
  );
  r++;

  r = heading(ws, r, "Ringkasan per analisis");
  r = table(
    ws,
    r,
    ["Analisis", "Kelompok · status", "Lolos", "Gagal", "Diubah manusia", "Galat"],
    doc.sections.map((s) => [
      { text: s.label, bold: true },
      { text: `${s.groupCode} · ${s.statusLabel}`, fill: s.available ? undefined : s.status === "failed" ? COLOR.fail : COLOR.warn },
      s.validation.enabled ? s.validation.passedChecks : "-",
      s.validation.failed ? { text: String(s.validation.failed), fill: COLOR.fail, bold: true } : s.validation.enabled ? 0 : "-",
      s.edits.count || "-",
      [s.status === "failed" ? `Gagal dijalankan: ${s.error ?? "tanpa pesan"}` : "", ...s.renderErrors].filter(Boolean).join("\n") || "-",
    ]),
  );
  r++;

  r = heading(ws, r, "Pemeriksaan pada percobaan terakhir");
  const rows: TCell[][] = [];
  for (const s of doc.sections) {
    for (const c of s.validation.checks) {
      const kind = c.kind === "llm" ? "cek AI" : "cek kode";
      if (c.passed || !c.failures.length)
        rows.push([s.label, c.label, kind, { text: c.passed ? "Lolos" : "Gagal", fill: c.passed ? COLOR.pass : COLOR.fail }, "-", c.passed ? "-" : "gagal"]);
      for (const f of c.failures) rows.push([s.label, c.label, kind, { text: "Gagal", fill: COLOR.fail, bold: true }, f.itemId ?? "-", f.message]);
    }
  }
  r = rows.length
    ? table(ws, r, ["Analisis", "Pemeriksaan", "Jenis", "Hasil", "Butir", "Pesan"], rows)
    : para(ws, r, "Belum ada catatan pemeriksaan (validator tidak dipasang atau analisis belum dijalankan).", 6, { italic: true });
  r++;

  r = heading(ws, r, "Jejak rujukan");
  r = para(
    ws,
    r,
    doc.trace.total
      ? `${doc.trace.complete} dari ${doc.trace.total} elemen (strategi, inisiatif SI, sasaran SO, misi, dan butir berujukan) rantai rujukannya sampai ke kutipan dokumen atau jawaban pengguna.`
      : "Belum ada elemen berujukan yang bisa ditelusuri.",
    6,
  );
  if (doc.trace.chains.length)
    r = table(
      ws,
      r,
      ["Elemen", "Teks", "Lengkap", "Jenis", "Analisis", "Rantai rujukan"],
      doc.trace.chains.map((c) => [
        { text: c.id, bold: true },
        c.text,
        { text: c.complete ? "ya" : "TIDAK", fill: c.complete ? COLOR.pass : COLOR.fail },
        TRACE_KIND_LABEL[c.kind] ?? c.kind,
        doc.sections.find((s) => s.key === c.nodeKey)?.label ?? c.nodeKey ?? "-",
        `${c.path}${c.complete ? "" : `\nMasalah: ${doc.trace.broken.find((b) => b.id === c.id)?.reason ?? "-"}`}`,
      ]),
    );
  r++;

  r = heading(ws, r, "Pertanyaan agen yang belum dijawab");
  r = doc.questions.length
    ? table(ws, r, ["Label", "Analisis", "Pertanyaan"], doc.questions.map((q) => [{ text: q.label, bold: true }, q.nodeLabel, q.question]), { lastTo: 6 })
    : para(ws, r, "Tidak ada.", 6, { italic: true });
  r++;

  r = heading(ws, r, "Nilai yang diubah manusia");
  const edits: TCell[][] = [];
  for (const s of doc.sections)
    for (const [path, e] of Object.entries(s.edits.byPath))
      edits.push([s.label, path, e.times, e.at ? e.at.slice(0, 16).replace("T", " ") : "-", valueText(e.from), { text: valueText(e.to), fill: SRC_FILL.manusia }]);
  if (edits.length) table(ws, r, ["Analisis", "Lokasi nilai (path)", "Berapa kali", "Terakhir", "Semula (usulan AI)", "Sekarang"], edits);
  else para(ws, r, "Tidak ada nilai yang diubah manusia.", 6, { italic: true });
}

/** Alamat A1 (untuk uji): baris/kolom 0-based. */
export const a1 = addr;
