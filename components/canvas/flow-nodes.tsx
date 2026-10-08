"use client";
// Bentuk flowchart di canvas:
//  input = jajar genjang (data) · proses = persegi panjang (kustom: garis putus-putus) · output = dokumen (bawah bergelombang)
//  validator = gerbang pemeriksaan (perisai di antara dua tiang) · tinjauan manusia = belah ketupat (keputusan) · catatan = kertas tempel kuning
import { createContext, memo, useContext, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Spinner, cx } from "@/components/ui";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import type { CanvasWarning } from "@/lib/engine/canvas";
import { flowKey, groupCodeOf, keyResult, phaseLabel, statusInfo } from "./summary";
import type { FlowData, NodeState } from "./types";

export type FlowNode = Node<FlowData>;

/** Node proses yang diperiksa/ditinjau oleh elemen validator/tinjauan. */
export type CheckTarget = { nodeId: string; key: string; label: string };

export type CanvasCtxValue = {
  nodeState: (key: string | null | undefined) => NodeState | undefined;
  /** Analisis yang sedang berjalan (hanya selama run di tab ini). */
  runningKey: string | null;
  /** Analisis yang baru saja selesai (untuk animasi centang). */
  justDone: ReadonlySet<string>;
  docCount: (nodeId: string) => number;
  warningsOf: (nodeId: string) => CanvasWarning[];
  addMissing: (nodeId: string) => void;
  checkTarget: (nodeId: string) => CheckTarget | null;
  setNoteText: (nodeId: string, text: string) => void;
  /** Analisis hulu yang diubah manusia setelah analisis ini selesai (angka dihitung ulang, teks AI belum). */
  staleOf: (key: string | null | undefined) => string[];
};
export const CanvasCtx = createContext<CanvasCtxValue>({
  nodeState: () => undefined,
  runningKey: null,
  justDone: new Set(),
  docCount: () => 0,
  warningsOf: () => [],
  addMissing: () => {},
  checkTarget: () => null,
  setNoteText: () => {},
  staleOf: () => [],
});

const HANDLE = "size-3! border-2! border-surface! shadow";

// ===== Ikon =====
export function DocIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" strokeLinecap="round" />
    </svg>
  );
}
export function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M5 7h6M5 9.5h4" strokeLinecap="round" />
    </svg>
  );
}
export function CustomIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1" strokeDasharray="2.2 1.6" />
      <path d="M8 5.5v5M5.5 8h5" strokeLinecap="round" />
    </svg>
  );
}
export function OutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M3 2h10v10c-2-1-3.5 1-5 1s-3-2-5-1z" strokeLinejoin="round" />
      <path d="M5.5 5.5h5M5.5 8h3.5" strokeLinecap="round" />
    </svg>
  );
}
export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M8 1.5 13 3.5v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z" strokeLinejoin="round" />
      <path d="m5.6 8 1.7 1.7L10.6 6.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function ReviewIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M8 1 15 8 8 15 1 8z" strokeLinejoin="round" />
      <circle cx="8" cy="6.6" r="1.6" />
      <path d="M5.4 11c.5-1.4 1.5-2.1 2.6-2.1s2.1.7 2.6 2.1" strokeLinecap="round" />
    </svg>
  );
}
export function NoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M2.5 2.5h11v7l-4 4h-7z" strokeLinejoin="round" />
      <path d="M9.5 13.5v-4h4M5 6h6M5 8.5h3" strokeLinecap="round" />
    </svg>
  );
}

/** Lingkaran status kecil di pojok node: centang (selesai), silang (gagal), seru (perlu ditinjau). */
function StatusDot({ status, pop }: { status?: string; pop?: boolean }) {
  if (status === "done")
    return (
      <span className={cx("grid size-5 shrink-0 place-items-center rounded-full bg-ok text-[11px] font-bold text-white", pop && "cv-pop")} title="Selesai">
        ✓
      </span>
    );
  if (status === "failed")
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-danger text-[11px] font-bold text-white" title="Gagal">
        ✕
      </span>
    );
  if (status === "needs_review")
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-warn text-[11px] font-bold text-white" title="Perlu ditinjau">
        !
      </span>
    );
  if (status === "running") return <Spinner className="size-4 shrink-0 text-info" />;
  return null;
}

/** Kotak dengan bentuk SVG di belakang konten (agar garis tepi tetap rapi saat diperbesar). */
function Shape({
  path,
  viewBox = "0 0 200 76",
  selected,
  fill,
  stroke,
  strokeSel = "stroke-primary",
  strokeWidth = 1.5,
  children,
  className,
}: {
  path: string;
  viewBox?: string;
  selected?: boolean;
  fill: string;
  stroke: string;
  strokeSel?: string;
  strokeWidth?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <svg className="absolute inset-0 size-full overflow-visible" viewBox={viewBox} preserveAspectRatio="none" aria-hidden>
        <path d={path} vectorEffect="non-scaling-stroke" className={cx(fill, selected ? strokeSel : stroke)} strokeWidth={selected ? strokeWidth + 1 : strokeWidth} strokeLinejoin="round" />
      </svg>
      <div className="relative">{children}</div>
    </div>
  );
}

// ===== Input (dokumen) =====
function InputNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { docCount } = useContext(CanvasCtx);
  const n = docCount(id);
  return (
    <Shape fill="fill-[#f3f6ff]" stroke="stroke-[#b9c2cc]" selected={selected} path="M22 0 H200 L178 76 H0 Z" className="w-[210px]">
      <div className="flex min-h-[76px] items-center gap-2 py-2 pr-9 pl-8">
        <DocIcon className="text-info" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight" title={data.label}>
            {data.label || "Dokumen"}
          </div>
          <div className={cx("mt-0.5 text-[11px]", n ? "text-muted" : "text-warn")}>
            {n ? `${n} dokumen` : "klik untuk unggah"}
            {data.values && <span className="ml-1 rounded bg-accent/10 px-1 text-[10px] text-accent">nilai</span>}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className={cx(HANDLE, "bg-info! right-[6px]!")} />
    </Shape>
  );
}

const hasSettings = (d: FlowData) => {
  const s = d.settings ?? {};
  return !!(s.note?.trim() || s.focus?.trim() || s.model?.trim() || s.temperature !== undefined || (s.depth && s.depth !== "sedang"));
};

// ===== Proses (analisis bawaan / kustom) =====
function ProcessNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { nodeState, runningKey, justDone, warningsOf, addMissing, staleOf } = useContext(CanvasCtx);
  const key = flowKey(id, data);
  const custom = data.key === "custom" || !!data.custom;
  const meta = custom ? null : NODE_META[data.key as NodeKey];
  const title = data.label?.trim() || (custom ? data.custom?.name?.trim() || "Proses kustom" : (meta?.label ?? data.key));
  const code = !custom && key ? groupCodeOf(key) : null;
  const st = nodeState(key);
  const running = !!key && runningKey === key;
  const status = running ? "running" : st?.status;
  const info = statusInfo(status);
  const review = status === "needs_review";
  const result = st?.status === "done" || st?.status === "needs_review" ? keyResult(key ?? "", st.output) : null;
  const edited = (st?.edits?.length ?? 0) > 0;
  const stale = st?.status === "done" && staleOf(key).length > 0;
  const warns = warningsOf(id);
  const missing = warns.find((w) => w.missing?.length);
  const other = warns.find((w) => !w.missing?.length);
  return (
    <div
      className={cx(
        "w-[220px] rounded-[4px] border bg-surface shadow-sm transition-[box-shadow,border-color]",
        custom && "border-dashed bg-accent/[0.03]",
        running
          ? "cv-ring-info border-info ring-2 ring-info/60"
          : review
            ? "cv-ring-warn border-warn ring-2 ring-warn/60"
            : selected
              ? "border-primary ring-2 ring-primary/20"
              : status === "failed"
                ? "border-danger"
                : custom
                  ? "border-accent/60 hover:shadow-md"
                  : "border-[#b9c2cc] hover:shadow-md",
        !custom && !meta && "border-danger",
      )}
    >
      <Handle type="target" position={Position.Left} className={cx(HANDLE, "bg-muted!")} />
      <div className="flex items-start gap-2 px-3 pt-2.5">
        {custom ? <CustomIcon className="mt-px text-accent" /> : <GearIcon className="mt-px text-primary" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight" title={title}>
            {title}
          </div>
          {(custom || code || data.label?.trim()) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-none text-muted">
              {custom ? (
                <span className="rounded bg-accent/10 px-1 py-0.5 font-semibold text-accent">kustom</span>
              ) : (
                <>
                  {code && (
                    <span className="shrink-0 rounded bg-primary-soft px-1 py-0.5 font-mono font-bold text-primary" title={meta?.sheetName ? `Tab Excel ${meta.sheetName}` : undefined}>
                      {code}
                    </span>
                  )}
                  {data.label?.trim() && <span className="truncate">{meta?.label}</span>}
                </>
              )}
            </div>
          )}
        </div>
        <StatusDot status={status} pop={!!key && justDone.has(key)} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5 pb-2.5">
        {running ? (
          <span className="inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-info">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {phaseLabel(st?.status === "running" ? st.phase : null)}…
          </span>
        ) : (
          <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none", info.cls)}>{info.label}</span>
        )}
        {edited && !running && (
          <span className="rounded bg-warn-soft px-1 py-0.5 text-[10px] leading-none text-warn" title="Ada angka/isi yang diubah manusia">
            diubah
          </span>
        )}
        {stale && !running && (
          <span className="rounded bg-warn-soft px-1 py-0.5 text-[10px] leading-none text-warn" title={`Angka dihitung ulang dari perubahan di analisis sebelumnya; teks AI mungkin perlu dijalankan ulang`}>
            hulu diubah
          </span>
        )}
        {hasSettings(data) && (
          <span className="rounded bg-surface-2 px-1 py-0.5 text-[10px] leading-none text-muted" title="Node ini punya pengaturan sendiri">
            diatur
          </span>
        )}
      </div>
      {result && (
        <div className="border-t border-border bg-surface-2/70 px-3 py-1.5 text-[11.5px] font-medium leading-snug tabular-nums text-text" title={result}>
          <div className="line-clamp-2">{result}</div>
        </div>
      )}
      {missing && (
        <div className="flex items-center gap-1.5 border-t border-warn/30 bg-warn-soft px-3 py-1.5 text-[11px] text-warn">
          <span className="min-w-0 flex-1 truncate" title={missing.message}>
            butuh {missing.missing!.map((m) => NODE_META[m]?.label ?? m).join(", ")}
          </span>
          <button
            type="button"
            className="nodrag shrink-0 rounded border border-warn/40 bg-surface px-1.5 py-0.5 text-[10px] font-semibold hover:bg-warn-soft"
            onClick={(e) => {
              e.stopPropagation();
              addMissing(id);
            }}
          >
            tambahkan
          </button>
        </div>
      )}
      {!missing && other && (
        <div className="truncate border-t border-warn/30 bg-warn-soft px-3 py-1.5 text-[11px] text-warn" title={other.message}>
          {other.message}
        </div>
      )}
      <Handle type="source" position={Position.Right} className={cx(HANDLE, custom ? "bg-accent!" : "bg-primary!")} />
    </div>
  );
}

// ===== Output (dokumen hasil) =====
function OutputNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { nodeState, runningKey, justDone } = useContext(CanvasCtx);
  const gd = nodeState("grand_design");
  const running = runningKey === "grand_design";
  const status = running ? "running" : gd?.status;
  return (
    <Shape
      fill="fill-[#f2faf8]"
      stroke="stroke-[#b9c2cc]"
      selected={selected}
      path="M0 0 H200 V64 C160 82 120 52 80 66 C50 76 25 74 0 66 Z"
      className={cx("w-[210px]", running && "cv-glow-info")}
    >
      <div className="flex min-h-[76px] items-start gap-2 px-3 pt-3 pb-5">
        <OutIcon className="mt-px text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight" title={data.label}>
            {data.label || "Dokumen hasil"}
          </div>
          <div className={cx("mt-0.5 text-[11px]", running ? "font-medium text-info" : "text-muted")}>
            {running ? "menyusun ringkasan…" : status === "done" ? "ringkasan siap" : "klik untuk pratinjau"}
          </div>
        </div>
        <StatusDot status={status} pop={justDone.has("grand_design")} />
      </div>
      <Handle type="target" position={Position.Left} className={cx(HANDLE, "bg-muted! left-[1px]!")} />
    </Shape>
  );
}

// ===== Validator otomatis (gerbang pemeriksaan berbentuk perisai) =====
// Dua tiang gerbang bergaris di kiri-kanan dan perisai di tengah: panah masuk dari kiri, "melewati" gerbang, keluar di kanan.
const SHIELD = "M85 3 L158 15 C158 62 130 94 85 109 C40 94 12 62 12 15 Z";
const POST = "w-[11px] rounded-[3px] border border-info/60 bg-[repeating-linear-gradient(45deg,#1d4ed8_0_5px,#ffffff_5px_10px)]";

function ValidatorNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { nodeState, runningKey, checkTarget } = useContext(CanvasCtx);
  const t = checkTarget(id);
  const st = nodeState(t?.key);
  const active = !!t && runningKey === t.key && st?.status === "running" && (st.phase === "validate" || st.phase === "repair");
  const off = data.settings?.disabledChecks?.length ?? 0;
  const passed = active ? null : (st?.validationPassed ?? null);
  const clip = `vclip-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <div className={cx("relative flex h-[112px] w-[206px] items-center", active && "cv-glow-info")}>
      {/* palang gerbang di belakang perisai */}
      <div className="absolute inset-x-2 top-1/2 h-[6px] -translate-y-1/2 rounded-full bg-[repeating-linear-gradient(90deg,#1d4ed8_0_10px,#ffffff_10px_20px)] opacity-70" />
      <div className={cx(POST, "relative z-[1] h-[84px]")}>
        <Handle type="target" position={Position.Left} className={cx(HANDLE, "bg-info! -left-[7px]!")} />
      </div>
      <div className="relative z-[1] mx-[3px] h-[112px] w-[170px]">
        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 170 112" aria-hidden>
          <defs>
            <clipPath id={clip}>
              <path d={SHIELD} />
            </clipPath>
          </defs>
          <path d={SHIELD} className={cx(active ? "fill-[#e3ecff]" : "fill-[#f1f5ff]", selected ? "stroke-primary" : "stroke-info")} strokeWidth={selected || active ? 4 : 3.2} strokeLinejoin="round" />
          <path
            d={SHIELD}
            transform="translate(85 56) scale(0.88) translate(-85 -56)"
            fill="none"
            className={selected ? "stroke-primary/60" : "stroke-info/50"}
            strokeWidth={1.2}
            strokeDasharray={active ? "4 3" : undefined}
            strokeLinejoin="round"
          />
          {active && (
            <g clipPath={`url(#${clip})`}>
              <rect x="0" y="0" width="170" height="14" className="cv-scan fill-info/25" />
            </g>
          )}
        </svg>
        <div className="relative flex h-full flex-col items-center px-7 pt-[18px] text-center">
          <ShieldIcon className={cx("size-[18px] text-info", active && "cv-spin-slow")} />
          <div className="mt-0.5 w-full truncate text-[12.5px] font-bold leading-tight text-info" title={data.label}>
            {data.label?.trim() || "Validator"}
          </div>
          <div className="w-full truncate text-[9.5px] leading-tight text-info/80">Gerbang pemeriksaan otomatis</div>
          {active ? (
            <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-semibold text-info">
              <Spinner className="size-2.5" />
              {st?.phase === "repair" ? "Memperbaiki…" : "Memeriksa…"}
            </div>
          ) : t ? (
            <div className="mt-0.5 w-[96px] truncate text-[10.5px] text-muted" title={`Memeriksa ${t.label}${off ? ` · ${off} pemeriksaan dimatikan` : ""}`}>
              {t.label}
            </div>
          ) : (
            <div className="mt-0.5 w-[100px] text-[10px] leading-tight text-warn">tarik panah dari proses</div>
          )}
        </div>
        {passed !== null && (
          <span
            className={cx(
              "cv-pop absolute top-0 right-1 grid size-5 place-items-center rounded-full text-[11px] font-bold text-white shadow",
              passed ? "bg-ok" : "bg-danger",
            )}
            title={passed ? "Pemeriksaan terakhir lolos" : "Pemeriksaan terakhir tidak lolos"}
          >
            {passed ? "✓" : "✗"}
          </span>
        )}
      </div>
      <div className={cx(POST, "relative z-[1] h-[84px]")}>
        <Handle type="source" position={Position.Right} className={cx(HANDLE, "bg-info! -right-[7px]!")} />
      </div>
    </div>
  );
}

// ===== Tinjauan manusia (belah ketupat) =====
function ReviewNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { nodeState, checkTarget } = useContext(CanvasCtx);
  const t = checkTarget(id);
  const st = nodeState(t?.key);
  const waiting = st?.status === "needs_review";
  const approved = st?.status === "done" && st.review?.approved === true;
  return (
    <div className="relative">
      <Shape
        viewBox="0 0 160 110"
        path="M80 0 L160 55 L80 110 L0 55 Z"
        fill={waiting ? "fill-[#fde9c4]" : "fill-[#fdf6e9]"}
        stroke="stroke-warn/70"
        strokeSel="stroke-primary"
        strokeWidth={waiting ? 2.5 : 1.5}
        selected={selected}
        className={cx("w-[160px]", waiting && "cv-glow-warn")}
      >
        <Handle type="target" position={Position.Left} className={cx(HANDLE, "bg-warn! left-[1px]!")} />
        <div className="flex h-[110px] flex-col items-center justify-center px-9 text-center">
          <ReviewIcon className="text-warn" />
          <div className="mt-0.5 w-full truncate text-[12px] font-semibold leading-tight text-warn" title={data.label}>
            {data.label?.trim() || "Tinjauan"}
          </div>
          <div className="w-full truncate text-[10.5px] leading-tight text-muted" title={t ? `Meninjau ${t.label}` : undefined}>
            {t ? (approved ? <span className="font-medium text-ok">✓ disetujui</span> : t.label) : <span className="text-warn">tarik panah</span>}
          </div>
        </div>
        <Handle type="source" position={Position.Right} className={cx(HANDLE, "bg-warn! right-[1px]!")} />
      </Shape>
      {waiting && (
        <div className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-warn px-2.5 py-1 text-[11px] font-semibold text-white shadow-md">
          Menunggu tinjauan Anda
        </div>
      )}
    </div>
  );
}

// ===== Catatan (kertas tempel) =====
function NoteNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { setNoteText } = useContext(CanvasCtx);
  return (
    <div
      className={cx(
        "group w-[210px] rounded-sm border bg-[#fff7c2] shadow-[2px_3px_0_rgba(0,0,0,0.06)]",
        selected ? "border-primary ring-2 ring-primary/20" : "border-[#e8d77a]",
      )}
    >
      <Handle type="target" position={Position.Left} className="size-2! border-0! bg-[#c9b44a]! opacity-0 group-hover:opacity-100" />
      <div className="flex items-center gap-1.5 border-b border-[#efe19a] px-2.5 py-1 text-[11px] font-semibold text-[#8a6d00]">
        <NoteIcon className="size-3.5" />
        {data.label?.trim() || "Catatan"}
      </div>
      <textarea
        value={data.text ?? ""}
        onChange={(e) => setNoteText(id, e.target.value)}
        maxLength={5000}
        rows={Math.min(10, Math.max(3, (data.text ?? "").split("\n").length + 1))}
        placeholder="Tulis catatan Anda…"
        className="nodrag nowheel block w-full resize-none bg-transparent px-2.5 py-1.5 text-[12px] leading-snug text-[#4a3d00] outline-none placeholder:text-[#b9a548]"
      />
      <Handle type="source" position={Position.Right} className="size-2! border-0! bg-[#c9b44a]! opacity-0 group-hover:opacity-100" />
    </div>
  );
}

export const nodeTypes = {
  inputNode: memo(InputNodeView),
  processNode: memo(ProcessNodeView),
  outputNode: memo(OutputNodeView),
  validatorNode: memo(ValidatorNodeView),
  reviewNode: memo(ReviewNodeView),
  noteNode: memo(NoteNodeView),
};

const RF_TYPE: Record<FlowData["gtype"], keyof typeof nodeTypes> = {
  input: "inputNode",
  process: "processNode",
  output: "outputNode",
  validator: "validatorNode",
  review: "reviewNode",
  note: "noteNode",
};
export const rfType = (t: FlowData["gtype"]) => RF_TYPE[t] ?? "processNode";
