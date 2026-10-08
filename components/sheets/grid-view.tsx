"use client";
// Penampil sheet ala Excel untuk hasil analisis: sel gabungan, gaya, warna isi, angka berkoma desimal, penanda sumber angka
// (AI / diubah manusia / AHP / hitung / tetap / dokumen), "Cara membaca", grafik, dan detail sel (rumus Excel, penjelasan,
// alasan AI, bukti). Mode "Ubah angka/isi" mengubah sel yang bisa diedit lalu menyimpan lewat
// PATCH /api/node-runs/{id}/output → server menghitung ulang analisis ini dan analisis sesudahnya.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, ErrorBox, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import { addr, colLetter, pathKey, type CellSource, type CellStyle, type Grid, type GridCell } from "@/lib/sheets/grid";
import { nodeLabel } from "@/lib/nodes/meta";
import { ChunkCard } from "@/components/run/evidence";
import type { ChunkInfo } from "@/components/run/types";
import { GridChartView } from "./grid-chart";
import {
  SOURCE_INFO,
  SOURCE_ORDER,
  cellContext,
  colWidths,
  editedPaths,
  effectiveSource,
  formatAny,
  formatCellValue,
  formulaParts,
  formulaRanges,
  layoutGrid,
  normOptions,
  numberError,
  optionIndex,
  parseNumberInput,
  sameValue,
  stickyColsOf,
  stickyRowsOf,
  textOnFill,
  type EditLog,
  type GridLayout,
} from "./grid-utils";

/** Potongan bukti node (EvidenceChunk) — untuk chip rujukan sel. */
export type EvidenceRef = ChunkInfo & { id: string };

export type GridViewProps = {
  grids: Grid[];
  /** Riwayat perubahan manusia node ini (penanda "diubah manusia" + nilai semula). */
  edits?: EditLog[] | null;
  /** ID node run — dibutuhkan untuk menyimpan perubahan. */
  nodeRunId?: string | null;
  /** Hasil boleh diubah sekarang (sudah ada hasil, tidak sedang berjalan). */
  editable?: boolean;
  /** Bukti dokumen node (chip rujukan di detail sel). */
  evidence?: EvidenceRef[] | null;
  /** Nama analisis untuk rujukan antar-sheet {{kunci!anchor}}. */
  labelOf?: (key: string) => string;
  /** Dipanggil setelah perubahan tersimpan / dikembalikan (muat ulang data proyek). */
  onSaved?: () => Promise<void> | void;
  /** Tinggi maksimal area tabel (CSS). */
  maxHeight?: string;
  /** Pemberitahuan kecil di atas tabel. */
  notice?: ReactNode;
};

type Pending = { path: (string | number)[]; value: unknown; text: string; error: string | null; at: string };
type Sel = { gridId: string; r: number; c: number; rect: { top: number; left: number; bottom: number; right: number } };

const ROWNUM_W = 34;
const MAX_EDITS = 200;

const STYLE: Record<CellStyle, string> = {
  title: "text-[13.5px] font-semibold",
  header: "bg-primary text-white font-semibold text-[11.5px] text-center align-middle",
  subheader: "bg-primary-soft font-semibold text-primary",
  label: "font-semibold",
  text: "",
  num: "text-right tabular-nums",
  int: "text-right tabular-nums",
  pct: "text-right tabular-nums",
  total: "bg-surface-2 font-semibold tabular-nums border-t-2 border-t-muted",
  note: "italic text-muted",
  muted: "text-muted",
};

const numText = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("id-ID", { maximumFractionDigits: 6, useGrouping: false }) : v === null || v === undefined ? "" : String(v));
/** Sel yang punya sesuatu untuk dijelaskan (rumus, penjelasan, catatan, bukti, sumber angka). */
const hasContent = (c: GridCell) => !!c.f || !!c.explain || !!c.note || !!c.refs?.length || !!c.edit || (!!c.src && c.v !== null && c.v !== "");

/** Penanda sumber di pojok kanan atas sel. */
function SourceMark({ src, title }: { src: CellSource; title?: string }) {
  return (
    <span
      aria-hidden
      title={title}
      className="pointer-events-none absolute right-0 top-0 size-0 border-l-[7px] border-t-[7px] border-l-transparent"
      style={{ borderTopColor: SOURCE_INFO[src].color }}
    />
  );
}

function Legend({ sources }: { sources: CellSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      {SOURCE_ORDER.filter((s) => sources.includes(s)).map((s) => (
        <span key={s} className="inline-flex items-center gap-1" title={SOURCE_INFO[s].long}>
          <span className="relative inline-block size-3 rounded-[2px] border border-border bg-surface">
            <SourceMark src={s} />
          </span>
          {SOURCE_INFO[s].label}
        </span>
      ))}
      <span className="text-muted/80">· klik sel untuk melihat rumus &amp; alasannya</span>
    </div>
  );
}

/** Rumus Excel dengan rujukan antar-sheet sebagai chip ("IFAS › total"). */
export function FormulaText({ f, labelOf = nodeLabel, className }: { f: string; labelOf?: (key: string) => string; className?: string }) {
  return (
    <code className={cx("break-all font-mono text-[12px] leading-relaxed", className)}>
      =
      {formulaParts(f).map((p, i) =>
        p.type === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="mx-0.5 rounded bg-info-soft px-1 py-px font-sans text-[11px] font-semibold text-info" title={`Sel "${p.anchor}" di sheet ${labelOf(p.key)}`}>
            {labelOf(p.key)} › {p.anchor}
          </span>
        ),
      )}
    </code>
  );
}

// ===== Detail sel (popover) =====
function CellDetail({
  sel,
  cell,
  layout,
  src,
  editedFrom,
  evidence,
  labelOf,
  canEditHint,
  onClose,
}: {
  sel: Sel;
  cell: GridCell;
  layout: GridLayout;
  src: CellSource | undefined;
  editedFrom: { from: unknown } | undefined;
  evidence: EvidenceRef[];
  labelOf: (key: string) => string;
  canEditHint: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const ctx = cellContext(layout, cell);

  useEffect(() => {
    const inside = (t: EventTarget | null) => !!t && !!ref.current?.contains(t as Node);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => !inside(e.target) && onClose();
    const onScroll = (e: Event) => !inside(e.target) && onClose();
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const W = Math.min(390, vw - 16);
  const below = vh - sel.rect.bottom;
  const placeBelow = below >= 300 || below >= sel.rect.top;
  const style: CSSProperties = {
    width: W,
    left: Math.max(8, Math.min(sel.rect.left, vw - W - 8)),
    ...(placeBelow ? { top: sel.rect.bottom + 6, maxHeight: below - 16 } : { bottom: vh - sel.rect.top + 6, maxHeight: sel.rect.top - 16 }),
  };
  const value = formatCellValue(cell);
  const chunk = (id: string) => evidence.find((e) => e.id === id);

  return createPortal(
    <div ref={ref} role="dialog" aria-label={`Detail sel ${addr(cell.r, cell.c)}`} style={style} className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-surface text-text shadow-xl">
      <header className="flex items-start gap-2 border-b border-border bg-surface-2/70 px-3 py-2">
        <div className="min-w-0 flex-1 text-[11.5px] text-muted">
          <span className="font-mono font-semibold text-text">Sel {addr(cell.r, cell.c)}</span>
          {ctx.col && <span> · kolom “{ctx.col}”</span>}
          {ctx.row && <span> · baris “{ctx.row}”</span>}
        </div>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-sm leading-none text-muted hover:bg-surface hover:text-text" aria-label="Tutup detail sel">
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 text-[12.5px] leading-relaxed">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx("min-w-0 break-words font-semibold", typeof cell.v === "number" ? "text-lg tabular-nums" : "text-[13px]")}>{value || <span className="text-muted">(kosong)</span>}</span>
          {src && (
            <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium" title={SOURCE_INFO[src].long}>
              <span className="relative inline-block size-2.5 rounded-[2px] border border-border">
                <SourceMark src={src} />
              </span>
              {SOURCE_INFO[src].long}
            </span>
          )}
        </div>
        {editedFrom && (
          <p className="rounded-md bg-warn-soft px-2 py-1 text-[12px] text-warn">
            Diubah manusia — semula <b>{formatAny(editedFrom.from, cell.edit)}</b> (usulan AI).
          </p>
        )}
        {cell.f && (
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Rumus Excel</div>
            <FormulaText f={cell.f} labelOf={labelOf} />
            <p className="text-[11px] text-muted">Sel yang dirujuk rumus ini disorot biru di tabel.</p>
          </div>
        )}
        {cell.explain && (
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Dari mana angka ini</div>
            <p>{cell.explain}</p>
          </div>
        )}
        {cell.note && (
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{src === "ai" || cell.src === "ai" ? "Alasan AI" : "Catatan"}</div>
            <p className="whitespace-pre-wrap">{cell.note}</p>
          </div>
        )}
        {!!cell.refs?.length && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Bukti dokumen</div>
            <div className="flex flex-wrap gap-1">
              {cell.refs.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setOpenRef((o) => (o === id ? null : id))}
                  className={cx(
                    "rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none",
                    openRef === id ? "border-primary bg-primary text-white" : "border-primary/30 bg-primary-soft text-primary hover:border-primary",
                  )}
                  title={chunk(id)?.source ?? "Lihat isi potongan"}
                >
                  {id}
                </button>
              ))}
            </div>
            {openRef && <ChunkCard id={openRef} chunk={chunk(openRef)} />}
          </div>
        )}
        {!cell.f && !cell.explain && !cell.note && !cell.refs?.length && !editedFrom && (
          <p className="text-[12px] text-muted">
            {src === "tetap"
              ? "Nilai tetap dari metode."
              : src === "ai"
                ? "Isi diusulkan AI."
                : src === "dokumen"
                  ? "Diambil dari dokumen input."
                  : "Tidak ada rumus atau catatan untuk sel ini."}
          </p>
        )}
        {canEditHint && cell.edit && <p className="rounded-md bg-primary-soft px-2 py-1 text-[11.5px] text-primary">Sel ini bisa Anda ubah — klik “Ubah angka/isi” di atas tabel.</p>}
      </div>
    </div>,
    document.body,
  );
}

// ===== Editor sel =====
function CellEditor({ cell, pending, onInput }: { cell: GridCell; pending: Pending | undefined; onInput: (text: string, value?: unknown) => void }) {
  const e = cell.edit!;
  const invalid = !!pending?.error;
  const base = cx(
    "w-full rounded border bg-surface px-1 py-0.5 text-[12px] text-text outline-none focus:ring-2 focus:ring-primary/30",
    invalid ? "border-danger" : pending ? "border-warn" : "border-primary/40",
  );
  const stop = (ev: SyntheticEvent) => ev.stopPropagation();
  if (e.type === "select") {
    const opts = normOptions(e.options);
    const cur = pending ? pending.value : cell.v;
    const idx = cur === null || cur === undefined || cur === "" ? -1 : optionIndex(e.options, cur);
    const val = idx >= 0 ? String(idx) : cur === null || cur === undefined || cur === "" ? "__empty" : "__cur";
    return (
      <select
        value={val}
        onClick={stop}
        onChange={(ev) => {
          const v = ev.target.value;
          if (v === "__empty") onInput("", null);
          else if (v !== "__cur") onInput(opts[Number(v)].label, opts[Number(v)].value);
        }}
        className={cx(base, "pr-4")}
        title={pending?.error ?? undefined}
        aria-label={`Ubah sel ${addr(cell.r, cell.c)}`}
      >
        {val === "__cur" && <option value="__cur">{formatCellValue(cell)} (sekarang)</option>}
        {(e.allowEmpty || val === "__empty") && <option value="__empty">(kosong)</option>}
        {opts.map((o, i) => (
          <option key={i} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (e.type === "number") {
    const hint = [e.min !== undefined ? `min ${numText(e.min)}` : "", e.max !== undefined ? `maks ${numText(e.max)}` : "", e.step ? `kelipatan ${numText(e.step)}` : ""].filter(Boolean).join(" · ");
    return (
      <input
        type="text"
        inputMode="decimal"
        value={pending ? pending.text : numText(cell.v)}
        onClick={stop}
        onChange={(ev) => onInput(ev.target.value)}
        className={cx(base, "text-right tabular-nums")}
        title={pending?.error ?? (hint || undefined)}
        placeholder={e.allowEmpty ? "kosong" : undefined}
        aria-label={`Ubah sel ${addr(cell.r, cell.c)}`}
        aria-invalid={invalid}
      />
    );
  }
  const text = pending ? pending.text : cell.v === null || cell.v === undefined ? "" : String(cell.v);
  return (
    <textarea
      value={text}
      onClick={stop}
      onChange={(ev) => onInput(ev.target.value)}
      rows={Math.min(6, Math.max(2, Math.ceil(text.length / 32)))}
      className={cx(base, "resize-y leading-snug")}
      title={pending?.error ?? undefined}
      aria-label={`Ubah sel ${addr(cell.r, cell.c)}`}
      aria-invalid={invalid}
    />
  );
}

// ===== Tabel =====
function SheetTable({
  grid,
  layout,
  edited,
  editing,
  pending,
  sel,
  maxHeight,
  onCell,
  onInput,
}: {
  grid: Grid;
  layout: GridLayout;
  edited: Map<string, { from: unknown; to: unknown }>;
  editing: boolean;
  pending: Map<string, Pending>;
  sel: Sel | null;
  maxHeight: string;
  onCell: (cell: GridCell, el: HTMLElement) => void;
  onInput: (cell: GridCell, text: string, value?: unknown) => void;
}) {
  const widths = useMemo(() => colWidths(grid, layout.cols), [grid, layout.cols]);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = ROWNUM_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);
  const stickyRows = useMemo(() => stickyRowsOf(grid, layout), [grid, layout]);
  const stickySet = useMemo(() => new Set(stickyRows), [stickyRows]);
  const freezeCols = stickyColsOf(grid, layout);
  const selCell = sel && sel.gridId === grid.id ? layout.slots[sel.r]?.[sel.c] : null;
  const selected = selCell && selCell !== "covered" ? selCell.cell : null;
  const refSet = useMemo(() => {
    const s = new Set<string>();
    if (!selected?.f) return s;
    for (const rg of formulaRanges(selected.f))
      for (let i = rg.r1; i <= Math.min(rg.r2, layout.rows - 1); i++) for (let j = rg.c1; j <= Math.min(rg.c2, layout.cols - 1); j++) s.add(`${i},${j}`);
    return s;
  }, [selected, layout.rows, layout.cols]);

  // Posisi "top" baris beku dihitung dari tinggi baris sebenarnya (langsung ke DOM, tanpa render ulang).
  const tableRef = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const t = tableRef.current;
    if (!t) return;
    const apply = () => {
      let top = (t.querySelector("thead tr") as HTMLElement | null)?.offsetHeight ?? 0;
      for (const r of stickyRows) {
        t.querySelectorAll<HTMLElement>(`[data-srow="${r}"]`).forEach((el) => (el.style.top = `${top}px`));
        top += (t.querySelector(`tr[data-row="${r}"]`) as HTMLElement | null)?.offsetHeight ?? 0;
      }
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(t);
    return () => ro.disconnect();
  }, [stickyRows, grid, editing]);

  const total = ROWNUM_W + widths.reduce((s, w) => s + w, 0);
  const selCols = selected ? new Set(Array.from({ length: (layout.slots[selected.r][selected.c] as { cs: number }).cs }, (_, k) => selected.c + k)) : null;
  const selRows = selected ? new Set(Array.from({ length: (layout.slots[selected.r][selected.c] as { rs: number }).rs }, (_, k) => selected.r + k)) : null;

  return (
    <div className="overflow-auto rounded-md border border-border bg-surface" style={{ maxHeight }}>
      <table ref={tableRef} className="border-separate border-spacing-0 text-[12px] leading-snug" style={{ tableLayout: "fixed", width: total }}>
        <colgroup>
          <col style={{ width: ROWNUM_W }} />
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-[4] border-b border-r border-border bg-surface-2" />
            {widths.map((_, j) => (
              <th
                key={j}
                className={cx(
                  "sticky top-0 z-[3] border-b border-r border-border px-1 py-0.5 text-center text-[10px] font-medium",
                  selCols?.has(j) ? "bg-primary-soft text-primary" : "bg-surface-2 text-muted",
                  j < freezeCols && "z-[4]",
                )}
                style={j < freezeCols ? { left: lefts[j] } : undefined}
              >
                {colLetter(j)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.slots.map((row, i) => {
            const stickyRow = stickySet.has(i);
            return (
              <tr key={i} data-row={i}>
                <th
                  data-srow={stickyRow ? i : undefined}
                  className={cx(
                    "sticky left-0 border-b border-r border-border px-1 text-right align-top text-[10px] font-medium tabular-nums",
                    stickyRow ? "z-[3]" : "z-[2]",
                    selRows?.has(i) ? "bg-primary-soft text-primary" : "bg-surface-2 text-muted",
                  )}
                >
                  {i + 1}
                </th>
                {row.map((slot, j) => {
                  if (slot === "covered") return null;
                  const frozenCol = j < freezeCols;
                  if (slot === null) {
                    return (
                      <td
                        key={j}
                        data-srow={stickyRow ? i : undefined}
                        className={cx("border-b border-r border-border/70", (stickyRow || frozenCol) && "sticky bg-surface", stickyRow && "z-[2]", frozenCol && "z-[1]")}
                        style={frozenCol ? { left: lefts[j] } : undefined}
                      />
                    );
                  }
                  const { cell, rs, cs } = slot;
                  const k = cell.edit ? pathKey(cell.edit.path) : null;
                  const ed = k ? edited.get(k) : undefined;
                  const src = effectiveSource(cell, edited);
                  const pend = k ? pending.get(k) : undefined;
                  const inEdit = editing && !!cell.edit;
                  const isSticky = stickyRow && rs === 1;
                  const isFrozen = frozenCol && j + cs <= freezeCols;
                  const isSel = !!selected && selected.r === cell.r && selected.c === cell.c;
                  let isRef = false;
                  if (refSet.size) for (let a = i; a < i + rs && !isRef; a++) for (let b = j; b < j + cs && !isRef; b++) isRef = refSet.has(`${a},${b}`);
                  const numeric = typeof cell.v === "number" && !cell.center;
                  const style: CSSProperties = {};
                  if (cell.fill) {
                    style.background = `#${cell.fill}`;
                    style.color = textOnFill(cell.fill);
                  }
                  if (isFrozen) style.left = lefts[j];
                  if (isRef) style.boxShadow = "inset 0 0 0 2px var(--info)";
                  const clickable = hasContent(cell) && !inEdit;
                  const tip = src
                    ? `${SOURCE_INFO[src].long}${ed ? ` — semula: ${formatAny(ed.from, cell.edit)}` : ""}${clickable ? " · klik untuk detail" : ""}`
                    : clickable && (cell.f || cell.explain || cell.note)
                      ? "Klik untuk melihat rumus/penjelasan"
                      : undefined;
                  return (
                    <td
                      key={j}
                      rowSpan={rs > 1 ? rs : undefined}
                      colSpan={cs > 1 ? cs : undefined}
                      data-srow={isSticky ? i : undefined}
                      title={tip}
                      onClick={clickable ? (ev) => onCell(cell, ev.currentTarget) : undefined}
                      className={cx(
                        "relative border-b border-r border-border/70 px-1.5 py-1 align-top break-words",
                        cell.style ? STYLE[cell.style] : "",
                        numeric ? "whitespace-nowrap text-right tabular-nums" : "whitespace-pre-wrap",
                        cell.center && "text-center",
                        (isSticky || isFrozen) && "sticky",
                        (isSticky || isFrozen) && !cell.fill && !cell.style?.match(/header|total/) && "bg-surface",
                        isSticky && (isFrozen ? "z-[3]" : "z-[2]"),
                        !isSticky && isFrozen && "z-[1]",
                        !cell.fill && !inEdit && ed && "bg-warn-soft",
                        !cell.fill && !inEdit && !ed && isRef && "bg-info-soft",
                        !cell.fill && inEdit && "bg-primary-soft/50",
                        pend && cx("outline outline-2 -outline-offset-2", pend.error ? "outline-danger" : "outline-warn"),
                        isSel && "outline outline-2 -outline-offset-2 outline-primary",
                        clickable && "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-primary/60",
                      )}
                      style={style}
                    >
                      {inEdit ? <CellEditor cell={cell} pending={pend} onInput={(text, value) => onInput(cell, text, value)} /> : formatCellValue(cell)}
                      {src && <SourceMark src={src} />}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===== Komponen utama =====
export function GridView({ grids, edits, nodeRunId, editable = false, evidence, labelOf = nodeLabel, onSaved, maxHeight = "70vh", notice }: GridViewProps) {
  const [tabId, setTabId] = useState<string | null>(null);
  const grid = grids.find((g) => g.id === tabId) ?? grids[0];
  const layout = useMemo(() => (grid ? layoutGrid(grid) : null), [grid]);
  const edited = useMemo(() => editedPaths(edits), [edits]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Map<string, Pending>>(() => new Map());
  const [busy, setBusy] = useState<"save" | "revert" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [full, setFull] = useState(false);
  const [showNotes, setShowNotes] = useState(true);

  const canEdit = editable && !!nodeRunId;
  const hasEditable = useMemo(() => grids.some((g) => g.cells.some((c) => c.edit)), [grids]);
  const editMode = editing && canEdit;
  const sources = useMemo(() => {
    const s = new Set<CellSource>();
    for (const c of grid?.cells ?? []) {
      const x = effectiveSource(c, edited);
      if (x) s.add(x);
    }
    return [...s];
  }, [grid, edited]);
  const editedCount = edited.size;
  const pendingList = [...pending.values()];
  const invalid = pendingList.filter((p) => p.error).length;

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  if (!grid || !layout) return <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">Belum ada tabel untuk ditampilkan.</p>;

  function onInput(cell: GridCell, text: string, value?: unknown) {
    const e = cell.edit!;
    const k = pathKey(e.path);
    let v: unknown = value;
    let err: string | null = null;
    if (e.type === "number") {
      const n = parseNumberInput(text);
      v = n;
      err = numberError(n, e);
    } else if (e.type === "text") {
      const t = text.trim();
      v = t ? t : e.allowEmpty ? null : "";
      err = !t && !e.allowEmpty ? "Wajib diisi" : null;
    } else if (v === null && !e.allowEmpty) err = "Wajib dipilih";
    setMsg(null);
    setPending((m) => {
      const next = new Map(m);
      if (!err && sameValue(v, cell.v)) next.delete(k);
      else next.set(k, { path: e.path, value: v, text, error: err, at: addr(cell.r, cell.c) });
      return next;
    });
  }

  async function save() {
    if (!nodeRunId || !pendingList.length) return;
    if (invalid) {
      setError(`Perbaiki ${invalid} sel yang ditandai merah dulu (${pendingList.filter((p) => p.error).map((p) => `${p.at}: ${p.error}`).join("; ")}).`);
      return;
    }
    if (pendingList.length > MAX_EDITS) {
      setError(`Paling banyak ${MAX_EDITS} sel sekali simpan.`);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const r = await api<{ changed: number; recomputed?: string[] }>(`/api/node-runs/${nodeRunId}/output`, {
        method: "PATCH",
        body: { edits: pendingList.map((p) => ({ path: p.path, value: p.value })) },
      });
      setPending(new Map());
      setEditing(false);
      const down = r.recomputed ?? [];
      setMsg(
        r.changed
          ? `Tersimpan: ${r.changed} perubahan. Angka di analisis ini${down.length ? ` dan ${down.length} analisis sesudahnya (${down.map(labelOf).join(", ")})` : ""} sudah dihitung ulang.`
          : "Tidak ada yang berubah.",
      );
      await onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    if (!nodeRunId) return;
    if (!confirm(`Kembalikan ${editedCount} sel yang Anda ubah ke usulan AI semula? Angka di analisis ini dan analisis sesudahnya dihitung ulang.`)) return;
    setBusy("revert");
    setError(null);
    try {
      await api(`/api/node-runs/${nodeRunId}/output`, { method: "PATCH", body: { action: "revert" } });
      setPending(new Map());
      setEditing(false);
      setMsg("Semua perubahan dikembalikan ke usulan AI.");
      await onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function cancelEdit() {
    setPending(new Map());
    setEditing(false);
    setError(null);
  }

  const selSlot = sel && sel.gridId === grid.id ? layout.slots[sel.r]?.[sel.c] : null;
  const selCell = selSlot && selSlot !== "covered" ? selSlot.cell : null;

  const body = (
    <div className="space-y-2">
      {/* Bilah atas: tab sheet + aksi */}
      <div className="flex flex-wrap items-end gap-2">
        {grids.length > 1 ? (
          <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="tablist" aria-label="Sheet">
            {grids.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === grid.id}
                onClick={() => {
                  setTabId(g.id);
                  setSel(null);
                }}
                title={`Tab Excel: ${g.name}`}
                className={cx(
                  "max-w-[14rem] truncate rounded-t-md border border-b-0 px-2.5 py-1 text-[12px] font-medium",
                  g.id === grid.id ? "border-border bg-surface text-primary shadow-[inset_0_2px_0_var(--primary)]" : "border-transparent bg-surface-2 text-muted hover:text-text",
                )}
              >
                {g.title || g.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted" title={`Tab Excel: ${grid.name}`}>
            Sheet <span className="font-mono text-text">{grid.name}</span>
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {canEdit && hasEditable && !editMode && (
            <Button size="sm" onClick={() => setEditing(true)} disabled={!!busy} title="Ubah angka atau isi usulan AI; angka lain dihitung ulang otomatis">
              ✎ Ubah angka/isi
            </Button>
          )}
          {canEdit && editedCount > 0 && !editMode && (
            <Button size="sm" variant="ghost" onClick={revert} loading={busy === "revert"} title="Buang semua perubahan Anda di analisis ini">
              Kembalikan usulan AI
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)} title={full ? "Kembali ke panel" : "Tampilkan tabel selebar layar"}>
            {full ? "Kecilkan" : "⤢ Layar penuh"}
          </Button>
        </div>
      </div>

      {notice}

      {editMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary-soft/60 px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1">
            <b>Mode ubah.</b> Sel berlatar hijau muda bisa diubah; angka lain dihitung ulang otomatis setelah disimpan.
            {pendingList.length > 0 && <span className="text-warn"> {pendingList.length} perubahan belum disimpan.</span>}
          </span>
          <Button size="sm" variant="primary" onClick={save} loading={busy === "save"} disabled={!pendingList.length || !!invalid}>
            Simpan perubahan ({pendingList.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={!!busy}>
            Batal
          </Button>
        </div>
      )}
      <ErrorBox error={error} />
      {msg && <div className="rounded-md bg-ok-soft px-3 py-1.5 text-[12.5px] text-ok">{msg}</div>}

      {!!grid.notes?.length && (
        <div className="rounded-md border border-info/20 bg-info-soft/50 px-3 py-2 text-[12px] leading-relaxed">
          <button type="button" onClick={() => setShowNotes((s) => !s)} className="flex w-full items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-info">
            <span className={cx("inline-block w-3 transition-transform", showNotes && "rotate-90")}>▸</span>
            Cara membaca
          </button>
          {showNotes && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {grid.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Legend sources={sources} />

      <SheetTable
        grid={grid}
        layout={layout}
        edited={edited}
        editing={editMode}
        pending={pending}
        sel={sel}
        maxHeight={full ? "calc(100vh - 14rem)" : maxHeight}
        onCell={(cell, el) => {
          const r = el.getBoundingClientRect();
          setSel((s) => (s && s.gridId === grid.id && s.r === cell.r && s.c === cell.c ? null : { gridId: grid.id, r: cell.r, c: cell.c, rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } }));
        }}
        onInput={onInput}
      />

      {canEdit && editedCount > 0 && !editMode && (
        <p className="text-[11px] text-muted">
          <Badge tone="warn">{editedCount} sel diubah manusia</Badge> Arahkan kursor ke sel bertanda oranye untuk melihat nilai semula.
        </p>
      )}

      {grid.chart && <GridChartView chart={grid.chart} />}

      {sel && selCell && (
        <CellDetail
          sel={sel}
          cell={selCell}
          layout={layout}
          src={effectiveSource(selCell, edited)}
          editedFrom={selCell.edit ? edited.get(pathKey(selCell.edit.path)) : undefined}
          evidence={evidence ?? []}
          labelOf={labelOf}
          canEditHint={canEdit && !editMode}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );

  if (!full) return body;
  return (
    <>
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
        Tabel sedang ditampilkan layar penuh.{" "}
        <button type="button" onClick={() => setFull(false)} className="font-medium text-primary hover:underline">
          Kecilkan
        </button>
      </p>
      {createPortal(
        <div className="fixed inset-0 z-50 bg-black/40 p-3 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && setFull(false)}>
          <div role="dialog" aria-modal aria-label={grid.title} className="h-full overflow-y-auto rounded-lg border border-border bg-surface p-4 shadow-2xl">
            {body}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
