"use client";
// Panel "Perhitungan": dari mana setiap angka berasal, satu langkah per analisis di canvas (urutan alur).
// Tiap langkah: masukan (dokumen & hasil langkah sebelumnya) → rumus yang dipakai → angka kunci beserta penjelasannya
// → sheet lengkap (bisa dibuka di sini atau di canvas). Generik: membaca sheets()/formulas/summary dari definisi node.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Spinner, cx } from "@/components/ui";
import { fmt } from "@/lib/client/api";
import type { WorkflowGraph } from "@/lib/db/schema";
import { attachedChecks, canvasNodeOf, connectedInputIds, engineParents, labelOf, processKeys } from "@/lib/engine/canvas";
import { isCustomKey, tableColumns } from "@/lib/nodes/custom";
import { CustomView } from "@/components/run/node-output";
import { itemIndexFrom } from "@/components/run/trace-utils";
import { FormulaText, GridView } from "@/components/sheets/grid-view";
import { FormulaList } from "@/components/sheets/node-result";
import { formulasOf, sheetsFor } from "@/components/sheets/node-sheets";
import { SOURCE_INFO, SOURCE_ORDER, cellContext, formatCellValue, keyCells, layoutGrid } from "@/components/sheets/grid-utils";
import type { GridCell } from "@/lib/sheets/grid";
import { groupCodeOf, keyResult, phaseLabel, statusInfo } from "./summary";
import { staleMap } from "./stale";
import type { NodeState, ProjectData } from "./types";

const PREVIEW_ROWS = 5;
const MAX_FORMULAS = 4;
const has = (x: unknown) => x !== null && x !== undefined;

// ===== Komponen kecil =====
function Row({ label, tone, children }: { label: string; tone: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-2 border-t border-border py-2 first:border-t-0">
      <div className={cx("pt-0.5 text-[10.5px] font-bold uppercase tracking-wider", tone)}>{label}</div>
      <div className="min-w-0 space-y-1 text-[13px] leading-snug">{children}</div>
    </div>
  );
}

const dot = (s: string | undefined) =>
  s === "done"
    ? "bg-primary text-white border-primary"
    : s === "running"
      ? "bg-info text-white border-info animate-pulse"
      : s === "needs_review"
        ? "bg-warn text-white border-warn"
        : s === "failed"
          ? "bg-danger text-white border-danger"
          : "bg-surface text-muted border-border";

/** Angka kunci sebuah analisis: sel total/anchor berumus beserta penjelasannya. */
function KeyNumbers({ cells, labelOf: lab }: { cells: { cell: GridCell; where: string }[]; labelOf: (k: string) => string }) {
  if (!cells.length) return null;
  return (
    <ul className="space-y-1.5">
      {cells.map(({ cell, where }, i) => (
        <li key={i} className="rounded-md border border-primary/20 bg-primary-soft/25 px-2.5 py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12px] text-muted">{where}</span>
            <span className="text-[14px] font-semibold tabular-nums">{formatCellValue(cell)}</span>
          </div>
          {cell.explain && <p className="text-[12.5px] leading-snug">{cell.explain}</p>}
          {cell.f && <FormulaText f={cell.f} labelOf={lab} className="text-[11px] text-muted" />}
        </li>
      ))}
    </ul>
  );
}

// ===== Satu langkah =====
function Step({
  k,
  no,
  last,
  graph,
  data,
  outputs,
  stepNo,
  staleFrom,
  focused,
  running,
  textOf,
  onRun,
  onSelectNode,
}: {
  k: string;
  no: number;
  last: boolean;
  graph: WorkflowGraph;
  data: ProjectData;
  outputs: Record<string, unknown>;
  stepNo: Map<string, number>;
  staleFrom: string[];
  focused: boolean;
  running: boolean;
  textOf: (id: string) => string | undefined;
  onRun: (k: string) => void;
  onSelectNode: (k: string) => void;
}) {
  const [showSheet, setShowSheet] = useState(false);
  const [allFormulas, setAllFormulas] = useState(false);
  const label = (x: string) => labelOf(graph, x);
  const ref = (x: string) => (stepNo.has(x) ? `langkah ${stepNo.get(x)} (${label(x)})` : label(x));
  const st: NodeState | undefined = data.nodes[k];
  const status = st?.status;
  const isRunning = status === "running";
  const done = status === "done";
  const notRun = !status || status === "pending" || status === "queued" || status === "none";
  const info = statusInfo(status);
  const out = has(st?.output) ? st!.output : undefined;
  const custom = isCustomKey(k);
  const code = groupCodeOf(k);
  const summary = out !== undefined ? keyResult(k, out) : null;
  const formulas = custom ? [] : formulasOf(k);
  const title = labelOf(graph, k);
  const sheets = useMemo(() => (out === undefined || custom || k === "grand_design" ? null : sheetsFor(k, out, { label: title, inputs: outputs })), [out, custom, k, outputs, title]);
  const keyNums = useMemo(() => {
    if (!sheets || sheets.fallback) return [];
    const res: { cell: GridCell; where: string }[] = [];
    for (const g of sheets.grids) {
      const layout = layoutGrid(g);
      for (const cell of keyCells(g, 4)) {
        if (res.length >= 5) break;
        const c = cellContext(layout, cell);
        const where = [c.row, c.col].filter(Boolean).join(" · ") || g.title;
        res.push({ cell, where: sheets.grids.length > 1 ? `${g.title} — ${where}` : where });
      }
    }
    return res;
  }, [sheets]);

  // ----- Masukan -----
  const inputs: ReactNode[] = [];
  const docs = data.documents;
  if (k === "grand_design") {
    const others = processKeys(graph).filter((x) => x !== "grand_design");
    inputs.push(`Hasil ${others.length} analisis lain di canvas (${others.filter((x) => data.nodes[x]?.status === "done").length} sudah selesai).`);
  } else {
    const cn = canvasNodeOf(graph, k);
    const linkedIds = cn ? connectedInputIds(graph, cn.id) : [];
    const linkedDocs = docs.filter((d) => d.input_node && linkedIds.includes(d.input_node));
    if (linkedDocs.length) {
      const names = linkedIds.map((id) => graph.nodes.find((n) => n.id === id)?.label).filter(Boolean);
      const onlyLinked = (cn?.settings?.sourceScope ?? "tersambung") === "tersambung";
      inputs.push(
        `Dokumen dari input ${names.join(", ")} (${linkedDocs.length} dokumen, ${fmt.int(linkedDocs.reduce((s, d) => s + d.chunks, 0))} potongan teks)${onlyLinked ? "" : " ditambah pencarian di seluruh dokumen proyek"}.`,
      );
    } else if (linkedIds.length) inputs.push(<span className="text-warn">Input tersambung belum berisi dokumen — unggah lewat elemen Input.</span>);
    for (const p of engineParents(graph, k)) {
      const po = has(data.nodes[p]?.output) ? data.nodes[p].output : undefined;
      inputs.push(
        po === undefined ? (
          <span className="text-muted">
            Hasil {ref(p)} — <i>belum tersedia</i>.
          </span>
        ) : (
          <>
            Hasil {ref(p)}
            {keyResult(p, po) ? (
              <>
                : <b>{keyResult(p, po)}</b>
              </>
            ) : null}
            .
          </>
        ),
      );
    }
    if (!inputs.length) inputs.push(docs.length ? `Potongan dokumen proyek yang paling relevan (dari ${docs.length} dokumen).` : "Belum ada dokumen — unggah lewat elemen Input di canvas.");
  }

  // ----- Proses -----
  const proc: ReactNode[] = [];
  const node = canvasNodeOf(graph, k);
  if (custom) {
    const spec = node?.custom;
    const instr = spec?.instruction?.trim();
    const cols = tableColumns(spec);
    proc.push(instr ? `AI mengikuti instruksi Anda: “${instr.length > 280 ? `${instr.slice(0, 280)}…` : instr}”` : "AI mengikuti instruksi Anda (instruksi belum diisi).");
    proc.push(cols.length ? `Bentuk tabel dengan kolom ${cols.join(" | ")}.` : "Bentuk daftar butir.");
    proc.push(spec?.requireEvidence === false ? "Butir boleh disimpulkan dari analisis sebelumnya, tetapi wajib menyebut rujukannya." : "Setiap butir wajib membawa kutipan persis dari dokumen.");
  } else if (k === "grand_design") {
    proc.push("Sistem menyusun semua sheet menjadi satu dokumen; AI hanya menulis ringkasan eksekutif yang merujuk butir analisis.");
  } else if (!formulas.length) {
    proc.push("AI menyusun isi tabel dari dokumen dan hasil langkah sebelumnya; tidak ada rumus angka di langkah ini.");
  }
  if (node) {
    const att = attachedChecks(graph, node.id);
    if (att.validator) proc.push("Validator otomatis terpasang: hasil diperiksa, dan bila ada yang salah AI diminta memperbaiki.");
    if (att.review) proc.push("Tinjauan manusia terpasang: run berhenti sampai Anda menyetujui hasil ini.");
  }
  const shownFormulas = allFormulas ? formulas : formulas.slice(0, MAX_FORMULAS);
  const items = custom && out !== undefined ? ((out as { items?: unknown[] }).items ?? []) : [];

  return (
    <li data-step={k} className="relative flex scroll-mt-3 gap-3">
      {!last && <span className="absolute bottom-0 left-[15px] top-9 w-0.5 bg-border" aria-hidden />}
      <span className={cx("relative z-10 mt-1 grid size-8 shrink-0 place-items-center rounded-full border-2 text-sm font-bold tabular-nums", dot(status))}>{no}</span>
      <div className={cx("mb-5 min-w-0 flex-1 rounded-lg border px-3 py-2.5", notRun ? "border-dashed border-border bg-surface-2/50" : "border-border bg-surface", focused && "ring-2 ring-primary/30")}>
        <div className="flex flex-wrap items-center gap-2">
          {code && (
            <Badge tone="primary" className="font-mono">
              {code}
            </Badge>
          )}
          {custom && <Badge tone="accent">kustom</Badge>}
          <h3 className={cx("text-sm font-semibold", notRun && "text-muted")}>{label(k)}</h3>
          <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", info.cls)}>
            {isRunning && <Spinner className="size-2.5" />}
            {isRunning ? `${phaseLabel(st?.phase)}…` : notRun ? "Belum dijalankan" : info.label}
          </span>
          {(st?.edits?.length ?? 0) > 0 && <Badge tone="warn">ada angka diubah manusia</Badge>}
          <span className="flex-1" />
          {notRun ? (
            <Button size="sm" variant="primary" onClick={() => onRun(k)} disabled={running} title="Jalankan langkah ini (langkah sebelumnya ikut dijalankan bila belum selesai)">
              Jalankan
            </Button>
          ) : (
            !isRunning && (
              <button type="button" onClick={() => onSelectNode(k)} className="text-[12px] font-medium text-primary hover:underline">
                {done ? "Buka sheet di canvas →" : status === "needs_review" ? "Tinjau di canvas →" : "Buka di canvas →"}
              </button>
            )
          )}
        </div>
        {summary && <p className="mt-1 text-[13px] font-semibold tabular-nums">{summary}</p>}
        {staleFrom.length > 0 && (
          <p className="mt-1 rounded bg-warn-soft px-2 py-1 text-[12px] text-warn">
            Angka sudah dihitung ulang dari perubahan di {staleFrom.map(label).join(", ")}; isi teks AI mungkin perlu dijalankan ulang.
          </p>
        )}

        <div className="mt-1.5">
          <Row label="Masukan" tone="text-info">
            <ul className="space-y-0.5">
              {inputs.map((l, j) => (
                <li key={j} className="flex gap-1.5">
                  <span className="text-muted" aria-hidden>
                    •
                  </span>
                  <span className="min-w-0">{l}</span>
                </li>
              ))}
            </ul>
          </Row>
          <Row label="Rumus" tone="text-accent">
            {formulas.length > 0 && (
              <>
                <FormulaList formulas={shownFormulas} compact />
                {formulas.length > MAX_FORMULAS && (
                  <button type="button" onClick={() => setAllFormulas((a) => !a)} className="text-[12px] font-medium text-primary hover:underline">
                    {allFormulas ? "Ringkas" : `Tampilkan semua rumus (${formulas.length})`}
                  </button>
                )}
              </>
            )}
            {proc.map((e, j) => (
              <p key={j} className={cx("text-[12.5px]", formulas.length ? "text-muted" : "")}>
                {e}
              </p>
            ))}
          </Row>
          <Row label="Keluaran" tone="text-ok">
            {out === undefined ? (
              <span className="text-muted">Belum ada — jalankan langkah ini.</span>
            ) : keyNums.length ? (
              <>
                <p className="text-[12px] text-muted">Angka kunci dan dari mana asalnya:</p>
                <KeyNumbers cells={keyNums} labelOf={label} />
              </>
            ) : (
              <span>{summary ?? "Selesai."}</span>
            )}
            {sheets && sheets.grids.length > 0 && (
              <div className="pt-1">
                <button type="button" onClick={() => setShowSheet((v) => !v)} className="text-[12.5px] font-medium text-primary hover:underline" aria-expanded={showSheet}>
                  {showSheet ? "▾ Sembunyikan sheet" : `▸ Lihat sheet lengkap di sini${sheets.grids.length > 1 ? ` (${sheets.grids.length} tab)` : ""}`}
                </button>
              </div>
            )}
          </Row>
        </div>

        {showSheet && sheets && (
          <div className="mt-1 border-t border-border pt-2">
            <GridView grids={sheets.grids} edits={st?.edits} evidence={st?.evidence} labelOf={label} maxHeight="55vh" />
            <p className="mt-1 text-[11px] text-muted">Untuk mengubah angka, buka sheet di canvas (tombol di kanan atas langkah ini).</p>
          </div>
        )}

        {custom && items.length > 0 && (
          <details className="group mt-1 rounded-md border border-accent/25 bg-accent/[0.03]" open>
            <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 text-[12.5px] font-medium text-accent">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span>
              Pratinjau hasil{items.length > PREVIEW_ROWS ? ` (${PREVIEW_ROWS} dari ${items.length})` : ""}
            </summary>
            <div className="overflow-x-auto border-t border-accent/15 p-3">
              <CustomView output={{ ...(out as object), summary: undefined, items: items.slice(0, PREVIEW_ROWS) }} textOf={textOf} />
              {items.length > PREVIEW_ROWS && (
                <button type="button" onClick={() => onSelectNode(k)} className="mt-2 text-[12px] font-medium text-primary hover:underline">
                  +{items.length - PREVIEW_ROWS} lainnya — lihat di canvas →
                </button>
              )}
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

// ===== Panel =====
export function CalcOverview({
  graph,
  data,
  onSelectNode,
  onRun,
  running,
  onClose,
  focusKey,
}: {
  graph: WorkflowGraph;
  data: ProjectData;
  /** Fokuskan node canvas untuk kunci mesin ini. */
  onSelectNode: (engineKey: string) => void;
  /** Jalankan analisis (beserta analisis sebelumnya yang belum selesai). */
  onRun: (engineKey: string) => void;
  /** Ada run yang sedang berjalan di halaman ini. */
  running: boolean;
  onClose: () => void;
  /** Langkah yang langsung digulir ke tampilan saat panel dibuka. */
  focusKey?: string | null;
}) {
  const keys = useMemo(() => processKeys(graph), [graph]);
  const stepNo = useMemo(() => new Map(keys.map((k, i) => [k, i + 1])), [keys]);
  const outputs = useMemo(() => Object.fromEntries(Object.entries(data.nodes).map(([k, v]) => [k, v.output])), [data.nodes]);
  const index = useMemo(() => itemIndexFrom(outputs), [outputs]);
  const stale = useMemo(() => staleMap(graph, data.nodes), [graph, data.nodes]);
  const textOf = (id: string) => index.get(id)?.text;

  const scroller = useRef<HTMLDivElement>(null);
  const goTo = (k: string) => scroller.current?.querySelector(`[data-step="${CSS.escape(k)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  useEffect(() => {
    if (!focusKey) return;
    const t = setTimeout(() => scroller.current?.querySelector(`[data-step="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [focusKey]);

  // Alur angka: ringkasan tiap analisis yang sudah punya hasil, sesuai urutan alur.
  const flow = keys
    .filter((k) => k !== "grand_design" && has(data.nodes[k]?.output))
    .map((k) => ({ key: k, text: keyResult(k, data.nodes[k].output), code: groupCodeOf(k), label: labelOf(graph, k) }))
    .filter((f) => f.text);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-text">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-base font-semibold">Perhitungan</h2>
          <span className="truncate text-xs text-muted">dari mana setiap angka berasal</span>
          {running && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info" aria-live="polite">
              <Spinner className="size-2.5" /> sedang berjalan · diperbarui otomatis
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Tutup panel perhitungan" title="Tutup">
          ✕
        </Button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-sm text-muted">
          Langkah-langkah di bawah mengikuti urutan alur di canvas. Angka penilaian (rating, skor, perbandingan berpasangan) <b className="text-text">diusulkan AI</b>{" "}
          beserta alasannya dan bisa Anda ubah; <b className="text-text">bobot</b> dihitung dengan AHP; angka lainnya <b className="text-text">dihitung sistem</b> dengan rumus
          yang sama seperti di Excel framework.
        </p>

        <section className="mt-3 rounded-lg border border-primary/25 bg-primary-soft/30 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-primary">Alur angka</h3>
          {flow.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">
              {flow.map((f, i) => (
                <span key={f.key} className="inline-flex max-w-full items-center gap-1.5">
                  {i > 0 && (
                    <span className="text-primary" aria-hidden>
                      →
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => goTo(f.key)}
                    className="max-w-[22rem] truncate rounded bg-surface px-1.5 py-0.5 text-left shadow-sm ring-1 ring-border hover:ring-primary"
                    title={`${f.label}: ${f.text}`}
                  >
                    {f.code && <span className="mr-1 font-mono text-[10.5px] font-bold text-primary">{f.code}</span>}
                    <span className="font-medium">{f.label}</span>
                    <span className="text-muted"> · {f.text}</span>
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[13px] text-muted">Belum ada angka — jalankan analisis untuk melihat alurnya.</p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-primary/15 pt-2 text-[11.5px] text-muted">
            {SOURCE_ORDER.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5" title={SOURCE_INFO[s].long}>
                <span className="relative inline-block size-3 rounded-[2px] border border-border bg-surface">
                  <span className="absolute right-0 top-0 size-0 border-l-[7px] border-t-[7px] border-l-transparent" style={{ borderTopColor: SOURCE_INFO[s].color }} />
                </span>
                {SOURCE_INFO[s].long}
              </span>
            ))}
          </div>
        </section>

        {!keys.length ? (
          <p className="mt-4 rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Belum ada analisis di canvas. Tarik elemen Proses atau pakai templat alur lengkap.
          </p>
        ) : (
          <ol className="mt-4">
            {keys.map((k, i) => (
              <Step
                key={k}
                k={k}
                no={i + 1}
                last={i === keys.length - 1}
                graph={graph}
                data={data}
                outputs={outputs}
                stepNo={stepNo}
                staleFrom={stale.get(k) ?? []}
                focused={focusKey === k}
                running={running}
                textOf={textOf}
                onRun={onRun}
                onSelectNode={onSelectNode}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
