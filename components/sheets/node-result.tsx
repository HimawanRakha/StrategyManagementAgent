"use client";
// Hasil analisis bawaan sebagai sheet ala Excel (bisa diubah) + daftar rumus yang dipakai.
import { useMemo } from "react";
import { cx } from "@/components/ui";
import type { FormulaDoc } from "@/lib/sheets/grid";
import type { NodeState } from "@/components/canvas/types";
import { GridView } from "./grid-view";
import { formulasOf, sheetsFor } from "./node-sheets";

/** Sheet hasil sebuah analisis, dengan mode ubah angka/isi bila hasilnya sudah ada. */
export function NodeSheets({
  nodeKey,
  label,
  state,
  outputs,
  editable,
  labelOf,
  onSaved,
  maxHeight,
}: {
  nodeKey: string;
  label: string;
  state: NodeState;
  /** Output semua analisis di run (konteks sheet: teks butir yang dirujuk). */
  outputs: Record<string, unknown>;
  /** Boleh diubah sekarang (mis. tidak sedang ada run). */
  editable: boolean;
  labelOf?: (key: string) => string;
  onSaved?: () => Promise<void> | void;
  maxHeight?: string;
}) {
  const res = useMemo(() => sheetsFor(nodeKey, state.output, { label, inputs: outputs }), [nodeKey, state.output, label, outputs]);
  const hasResult = state.status === "done" || state.status === "needs_review";
  return (
    <GridView
      grids={res.grids}
      edits={state.edits}
      nodeRunId={state.nodeRunId}
      editable={editable && hasResult}
      evidence={state.evidence}
      labelOf={labelOf}
      onSaved={onSaved}
      maxHeight={maxHeight}
      notice={
        res.fallback || res.error ? (
          <p className={cx("rounded-md px-2.5 py-1.5 text-[11.5px]", res.error ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted")}>
            {res.error ?? "Tabel Excel untuk analisis ini belum tersedia — sementara ditampilkan daftar butir hasilnya."}
          </p>
        ) : undefined
      }
    />
  );
}

/** Daftar rumus (FormulaDoc) dalam bahasa awam, dengan padanan Excel. */
export function FormulaList({ formulas, compact }: { formulas: FormulaDoc[]; compact?: boolean }) {
  if (!formulas.length) return null;
  return (
    <ul className={cx("space-y-1.5", compact && "space-y-1")}>
      {formulas.map((f, i) => (
        <li key={`${f.name}-${i}`} className={cx("rounded-md border border-border bg-surface", compact ? "px-2.5 py-1.5" : "px-3 py-2")}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-semibold">{f.name}</span>
            <code className="font-mono text-[12px] text-primary">{f.rumus}</code>
          </div>
          <p className="text-[12px] leading-snug text-muted">{f.arti}</p>
          {f.excel && (
            <p className="mt-0.5 text-[11px] text-muted">
              Di Excel: <code className="font-mono text-text">{f.excel.startsWith("=") ? f.excel : `=${f.excel}`}</code>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Rumus yang dipakai analisis `key`. */
export function NodeFormulas({ nodeKey, compact }: { nodeKey: string; compact?: boolean }) {
  return <FormulaList formulas={formulasOf(nodeKey)} compact={compact} />;
}
