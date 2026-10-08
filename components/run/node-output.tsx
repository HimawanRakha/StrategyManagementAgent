"use client";
// Penampil output analisis: sheet ala Excel (bawaan), butir berbukti (kustom), ringkasan (grand design). Semua akses defensif.
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { Badge, Table, cx } from "@/components/ui";
import { fmt } from "@/lib/client/api";
import { nodeLabel } from "@/lib/nodes/meta";
import type { Evidence, GrandDesignOutput } from "@/lib/nodes/schemas";
import { GridView, type EvidenceRef } from "@/components/sheets/grid-view";
import { sheetsFor } from "@/components/sheets/node-sheets";
import { UserAnswerBadge } from "./evidence";
import { hasUserEvidence, isUserChunk, type Picked } from "./types";

export type OutputViewProps = {
  output: unknown;
  onPick?: (p: Picked) => void;
  pickedId?: string | null;
  /** Teks elemen menurut ID (untuk tooltip rujukan). */
  textOf?: (id: string) => string | undefined;
};

const arr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

/** ID elemen yang bisa diklik untuk membuka bukti/jejak. */
export function IdChip({ id, onPick, pick, active, title }: { id: string; onPick?: (p: Picked) => void; pick?: Picked; active?: boolean; title?: string }) {
  const cls = cx(
    "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none whitespace-nowrap",
    active ? "border-primary bg-primary text-white" : "border-primary/30 bg-primary-soft text-primary",
  );
  if (!onPick) return <span className={cls} title={title}>{id}</span>;
  return (
    <button type="button" className={cx(cls, "hover:border-primary")} title={title ?? "Lihat bukti/jejak"} onClick={() => onPick(pick ?? { id })}>
      {id}
    </button>
  );
}

export function RefList({ refs, onPick, textOf, label }: { refs: string[] | undefined; onPick?: (p: Picked) => void; textOf?: (id: string) => string | undefined; label?: string }) {
  const list = arr(refs);
  if (!list.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {label && <span className="text-[11px] text-muted">{label}</span>}
      {list.map((r, i) => {
        const cls = "rounded border border-border bg-surface-2 px-1 py-0.5 font-mono text-[10px] leading-none text-muted";
        return onPick ? (
          <button key={`${r}-${i}`} type="button" title={textOf?.(r) ?? r} onClick={() => onPick({ id: r, text: textOf?.(r) })} className={cx(cls, "hover:border-primary hover:text-primary")}>
            {r}
          </button>
        ) : (
          <span key={`${r}-${i}`} title={textOf?.(r) ?? r} className={cls}>
            {r}
          </span>
        );
      })}
    </span>
  );
}

export function EvidenceChips({ evidence, onPick, pick }: { evidence: Evidence[] | undefined; onPick?: (p: Picked) => void; pick: Picked }) {
  const list = arr(evidence);
  if (!list.length) return <span className="text-[11px] text-danger">tanpa bukti</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map((e, i) => {
        const user = isUserChunk(e.chunkId ?? "");
        return (
          <button
            key={`${e.chunkId}-${i}`}
            type="button"
            disabled={!onPick}
            title={e.quote}
            onClick={() => onPick?.(pick)}
            className={cx(
              "rounded px-1 py-0.5 font-mono text-[10px] leading-none",
              user ? "bg-[#eef0fd] text-accent" : "bg-info-soft text-info",
              onPick && "hover:ring-1 hover:ring-current",
            )}
          >
            {e.chunkId}
          </button>
        );
      })}
    </span>
  );
}

function Section({ title, children, note }: { title: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {note && <span className="text-[11px] text-muted">{note}</span>}
      </div>
      {children}
    </div>
  );
}

type PickProps = Pick<OutputViewProps, "onPick" | "textOf">;

// ===== Grand design =====
export function ExecSummaryList({ sentences, onPick, textOf }: { sentences: GrandDesignOutput["executiveSummary"] | null | undefined } & PickProps) {
  const list = arr(sentences);
  if (!list.length) return <EmptyOut />;
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm">
      {list.map((s, i) => (
        <li key={i}>
          {s.text} <RefList refs={s.refs} onPick={onPick} textOf={textOf} />
        </li>
      ))}
    </ol>
  );
}

export function GrandDesignView({ output, onPick, textOf, grandDesignHref }: OutputViewProps & { grandDesignHref?: string }) {
  const o = output as Partial<GrandDesignOutput> | null;
  if (!o) return <EmptyOut />;
  const t = o.trace;
  return (
    <div className="space-y-4">
      {grandDesignHref && (
        <Link href={grandDesignHref} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
          Buka pratinjau grand design →
        </Link>
      )}
      <Section title="Ringkasan eksekutif">
        <ExecSummaryList sentences={o.executiveSummary} onPick={onPick} textOf={textOf} />
      </Section>
      {t && (
        <Section title="Jejak rujukan">
          <div className="text-sm">
            <span className="font-semibold tabular-nums">{t.complete}</span> dari <span className="tabular-nums">{t.total}</span> elemen lengkap sampai kutipan
            {t.total > 0 && <span className="text-muted"> ({fmt.pct(t.complete / t.total)})</span>}
          </div>
          {arr(t.broken).length > 0 && (
            <ul className="space-y-1 text-xs">
              {arr(t.broken).map((b) => (
                <li key={b.id} className="flex items-start gap-2">
                  <span className="text-danger">✗</span>
                  <IdChip id={b.id} onPick={onPick} />
                  <span className="text-muted">{b.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {arr(o.missingNodes).length > 0 && (
        <Section title="Node belum tersedia">
          <div className="flex flex-wrap gap-1">
            {arr(o.missingNodes).map((m) => (
              <Badge key={m} tone="warn">{m}</Badge>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ===== Proses kustom =====
type CustomItem = { id: string; text: string; cells?: string[]; detail?: string; refs?: string[]; evidence?: Evidence[] };

function CustomTable({ columns, items, onPick, pickedId, textOf }: { columns: string[]; items: CustomItem[] } & Omit<OutputViewProps, "output">) {
  return (
    <Table head={["ID", ...columns, "Bukti"]}>
      {items.map((i) => {
        const pick = { id: i.id, text: i.text, evidence: arr(i.evidence) };
        const cells = arr(i.cells);
        return (
          <tr key={i.id} className={cx(pickedId === i.id && "bg-primary-soft/50")} title={i.text}>
            <td>
              <div className="flex flex-col items-start gap-1">
                <IdChip id={i.id} onPick={onPick} pick={pick} active={pickedId === i.id} />
                <RefList refs={i.refs} onPick={onPick} textOf={textOf} />
              </div>
            </td>
            {columns.map((c, j) => {
              const v = cells[j] ?? (j === 0 && !cells.length ? i.text : "");
              return (
                <td key={c + j} className={cx("min-w-32 text-sm", j === 0 && "font-medium")}>
                  {v.trim() ? v : <span className="text-xs text-danger">kosong</span>}
                  {j === 0 && hasUserEvidence(i.evidence) && (
                    <span className="ml-1">
                      <UserAnswerBadge />
                    </span>
                  )}
                </td>
              );
            })}
            <td>
              {arr(i.evidence).length > 0 ? (
                <EvidenceChips evidence={i.evidence} onPick={onPick} pick={pick} />
              ) : arr(i.refs).length ? (
                <span className="text-[11px] text-muted">dari rujukan</span>
              ) : (
                <EvidenceChips evidence={[]} pick={pick} />
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export function CustomView({ output, onPick, pickedId, textOf }: OutputViewProps) {
  const o = output as { summary?: string; columns?: string[]; items?: CustomItem[] } | null;
  const items = arr(o?.items);
  const columns = arr(o?.columns).filter((c) => typeof c === "string");
  if (!o || (!items.length && !o.summary)) return <EmptyOut />;
  if (columns.length)
    return (
      <div className="space-y-2">
        {o.summary && <p className="rounded-md border border-accent/20 bg-[#f5f5ff] px-3 py-2 text-sm leading-relaxed">{o.summary}</p>}
        <CustomTable columns={columns} items={items} onPick={onPick} pickedId={pickedId} textOf={textOf} />
      </div>
    );
  return (
    <div className="space-y-2">
      {o.summary && <p className="rounded-md border border-accent/20 bg-[#f5f5ff] px-3 py-2 text-sm leading-relaxed">{o.summary}</p>}
      <ul className="space-y-1.5">
        {items.map((i) => {
          const pick = { id: i.id, text: i.text, evidence: arr(i.evidence) };
          return (
            <li key={i.id} className={cx("rounded-md border bg-surface p-2.5 text-sm", pickedId === i.id ? "border-primary" : "border-border")}>
              <div className="flex items-start gap-2">
                <IdChip id={i.id} onPick={onPick} pick={pick} active={pickedId === i.id} />
                <span className="min-w-0 flex-1">
                  {i.text} {hasUserEvidence(i.evidence) && <UserAnswerBadge />}
                  {i.detail && <span className="mt-0.5 block text-xs text-muted">{i.detail}</span>}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {arr(i.evidence).length > 0 ? <EvidenceChips evidence={i.evidence} onPick={onPick} pick={pick} /> : !arr(i.refs).length && <EvidenceChips evidence={[]} pick={pick} />}
                <RefList refs={i.refs} label="dasar:" onPick={onPick} textOf={textOf} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EmptyOut() {
  return <p className="text-sm text-muted">Output kosong atau belum lengkap.</p>;
}

/**
 * Penampil hasil sebuah analisis: proses kustom → daftar/tabel butir dengan bukti; grand design → ringkasan;
 * analisis bawaan → sheet ala Excel (hanya baca; pengubahan angka ada di panel node).
 */
export function NodeOutputView({
  nodeKey,
  grandDesignHref,
  label,
  inputs,
  evidence,
  ...props
}: OutputViewProps & { nodeKey: string; grandDesignHref?: string; label?: string; inputs?: Record<string, unknown>; evidence?: EvidenceRef[] }) {
  const sheets = useMemo(
    () => (nodeKey === "grand_design" || nodeKey.startsWith("custom_") ? null : sheetsFor(nodeKey, props.output, { label: label ?? nodeLabel(nodeKey), inputs: inputs ?? {} })),
    [nodeKey, props.output, label, inputs],
  );
  if (props.output === null || props.output === undefined) return <p className="text-sm text-muted">Belum ada output.</p>;
  if (nodeKey === "grand_design") return <GrandDesignView {...props} grandDesignHref={grandDesignHref} />;
  if (nodeKey.startsWith("custom_")) return <CustomView {...props} />;
  return (
    <div className="space-y-1.5">
      {sheets?.error && <p className="text-[11.5px] text-warn">{sheets.error}</p>}
      <GridView grids={sheets?.grids ?? []} evidence={evidence} maxHeight="55vh" />
    </div>
  );
}
