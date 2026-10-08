"use client";
// Halaman utama proyek: canvas alur berpikir (input → proses → pemeriksaan → output) + satu panel samping.
import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type OnBeforeDelete,
} from "@xyflow/react";
import { Button, ErrorBox, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import {
  attachedChecks,
  canvasWarnings,
  engineParents,
  labelOf,
  processKeys,
  templateGraph,
  upstreamProcesses,
  type CanvasWarning,
} from "@/lib/engine/canvas";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import type { GraphNode, WorkflowGraph } from "@/lib/db/schema";
import {
  CanvasCtx,
  CustomIcon,
  DocIcon,
  GearIcon,
  NoteIcon,
  OutIcon,
  ReviewIcon,
  ShieldIcon,
  nodeTypes,
  rfType,
  type CanvasCtxValue,
  type CheckTarget,
  type FlowNode,
} from "./flow-nodes";
import { DND_TYPE, Palette } from "./palette";
import { InputPanel } from "./input-panel";
import { ProcessPanel, type AttachedChecks, type RunMsg } from "./process-panel";
import { OutputPanel } from "./output-panel";
import { NotePanel, ReviewPanel, ValidatorPanel } from "./check-panels";
import { flowKey, phaseLabel } from "./summary";
import { ReportPanel } from "./report-panel";
import { CalcOverview } from "./calc-overview";
import { staleMap } from "./stale";
import { Modal } from "@/components/projects/modal";
import { canvasNodeOf as canvasNodeOfKey } from "@/lib/engine/canvas";
import type { ExecResult, FlowData, FlowPatch, PaletteItem, PlacementMap, ProjectData, RunState } from "./types";

// ===== Konversi graf ⇄ React Flow =====
function toFlow(g: WorkflowGraph): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = g.nodes.map((n) => ({
    id: n.id,
    type: rfType(n.type),
    position: n.position ?? { x: 0, y: 0 },
    data: { gtype: n.type, key: n.key, label: n.label, values: n.values, text: n.text, settings: n.settings, custom: n.custom },
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }));
  return { nodes, edges };
}

/** Buang kunci pengaturan yang kosong (agar canvas tersimpan rapi). */
function cleanSettings(s: FlowData["settings"]): GraphNode["settings"] {
  if (!s) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as GraphNode["settings"]) : undefined;
}

function toGraph(nodes: FlowNode[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const d = n.data;
      const base: GraphNode = { id: n.id, type: d.gtype, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } };
      const label = d.label?.trim() ? d.label : undefined;
      switch (d.gtype) {
        case "process":
          return { ...base, key: d.key, label, settings: cleanSettings(d.settings), custom: d.custom };
        case "input":
          return { ...base, label: d.label ?? "", values: !!d.values };
        case "validator":
        case "review":
          return { ...base, label, settings: cleanSettings(d.settings) };
        case "note":
          return { ...base, label, text: d.text ?? "" };
        default:
          return { ...base, label: d.label ?? "" };
      }
    }),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  };
}

const depsOf = (k: string) => NODE_META[k as NodeKey]?.deps ?? [];
const isBuiltinProcess = (n: FlowNode) => n.data.gtype === "process" && !!n.data.key && n.data.key !== "custom" && !n.data.custom;

/** Analisis yang dibutuhkan untuk mencapai `target` (termasuk dirinya), terbatas pada yang ada di canvas. */
function neededKeys(target: string | null, g: WorkflowGraph) {
  const all = processKeys(g);
  if (!target || target === "grand_design") return all;
  const out = new Set<string>();
  const st = [target];
  while (st.length) {
    const k = st.pop()!;
    if (out.has(k) || !all.includes(k)) continue;
    out.add(k);
    st.push(...engineParents(g, k));
  }
  return all.filter((k) => out.has(k));
}

/** Tebakan analisis berikutnya (untuk label progres; server yang menentukan urutan sebenarnya). */
function predictNext(needed: string[], done: Set<string>, g: WorkflowGraph) {
  return (
    needed.find(
      (k) =>
        !done.has(k) &&
        (k === "grand_design" ? needed.filter((x) => x !== k).every((x) => done.has(x)) : engineParents(g, k).every((d) => !needed.includes(d) || done.has(d))),
    ) ?? null
  );
}

/** Sisi otomatis untuk analisis bawaan baru: dari dependensinya yang sudah ada, dan ke analisis yang membutuhkannya. */
function autoEdges(newKeys: string[], nodes: FlowNode[], existing: Edge[]): Edge[] {
  const idOf = new Map(nodes.filter(isBuiltinProcess).map((n) => [n.data.key!, n.id]));
  const have = new Set(existing.map((e) => `${e.source}->${e.target}`));
  const out: Edge[] = [];
  const push = (s?: string, t?: string) => {
    if (!s || !t || have.has(`${s}->${t}`)) return;
    have.add(`${s}->${t}`);
    out.push({ id: `${s}->${t}`, source: s, target: t });
  };
  for (const k of newKeys) {
    for (const d of depsOf(k)) push(idOf.get(d), idOf.get(k));
    for (const [other, id] of idOf) if (depsOf(other).includes(k as NodeKey)) push(idOf.get(k), id);
  }
  return out;
}

// ===== Penempatan elemen pemeriksaan =====
const SIZE: Record<FlowData["gtype"], { w: number; h: number }> = {
  input: { w: 210, h: 76 },
  process: { w: 220, h: 92 },
  output: { w: 210, h: 76 },
  validator: { w: 206, h: 112 },
  review: { w: 160, h: 110 },
  note: { w: 210, h: 110 },
};
const sizeOf = (n: FlowNode) => ({ w: n.measured?.width ?? SIZE[n.data.gtype]?.w ?? 200, h: n.measured?.height ?? SIZE[n.data.gtype]?.h ?? 80 });

type CheckType = "validator" | "review";

/** Elemen validator/tinjauan yang menerima panah langsung dari node proses `processId`. */
function checksOfProcess(processId: string, type: CheckType, nodes: FlowNode[], edges: Edge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.filter((e) => e.source === processId && byId.get(e.target)?.data.gtype === type).map((e) => byId.get(e.target)!);
}

/** Posisi rapi untuk elemen pemeriksaan: di bawah node prosesnya (validator kiri, tinjauan kanan), tanpa menimpa elemen lain. */
function placeCheck(anchor: FlowNode, type: CheckType, nodes: FlowNode[]) {
  const a = sizeOf(anchor);
  const s = SIZE[type];
  const p = { x: anchor.position.x + (type === "validator" ? -10 : a.w - s.w + 30), y: anchor.position.y + a.h + 36 };
  const hit = (q: { x: number; y: number }) =>
    nodes.some((n) => {
      if (n.id === anchor.id) return false;
      const z = sizeOf(n);
      return q.x < n.position.x + z.w + 12 && q.x + s.w + 12 > n.position.x && q.y < n.position.y + z.h + 12 && q.y + s.h + 12 > n.position.y;
    });
  for (let i = 0; i < 16 && hit(p); i++) p.y += 48;
  return p;
}

function newCheckNode(id: string, type: CheckType, position: { x: number; y: number }, selected = false): FlowNode {
  return { id, type: rfType(type), position, selected, data: { gtype: type, label: "" } };
}

/**
 * Terapkan penempatan validator/tinjauan (mis. hasil optimasi) ke canvas: untuk setiap kunci analisis di `placement`,
 * tambahkan elemen yang diminta (tersambung dari node prosesnya, diposisikan otomatis) dan lepas elemen yang tidak diminta.
 * Elemen yang juga menerima panah dari proses lain hanya dilepas panahnya. Fungsi murni.
 */
export function withPlacement(nodes: FlowNode[], edges: Edge[], placement: PlacementMap) {
  let ns = [...nodes];
  let es = [...edges];
  let added = 0;
  const removeIds = new Set<string>();
  for (const n of nodes) {
    const k = flowKey(n.id, n.data);
    const want = k ? placement[k] : undefined;
    if (!k || !want) continue;
    const builtinNoCheck = !k.startsWith("custom_") && NODE_META[k as NodeKey] && !NODE_META[k as NodeKey].hasValidator;
    for (const type of ["validator", "review"] as const) {
      const wanted = type === "validator" ? want.validator && !builtinNoCheck : want.human;
      const have = checksOfProcess(n.id, type, ns, es);
      if (wanted && !have.length) {
        const id = crypto.randomUUID();
        ns.push(newCheckNode(id, type, placeCheck(n, type, ns)));
        es.push({ id: `${n.id}->${id}`, source: n.id, target: id });
        added++;
      } else if (!wanted && have.length) {
        for (const el of have) {
          const shared = es.some((e) => e.target === el.id && e.source !== n.id && ns.find((x) => x.id === e.source)?.data.gtype === "process");
          if (shared) es = es.filter((e) => !(e.source === n.id && e.target === el.id));
          else removeIds.add(el.id);
        }
      }
    }
  }
  ns = ns.filter((n) => !removeIds.has(n.id));
  es = es.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target));
  return { nodes: ns, edges: es, added, removed: removeIds.size };
}

const statusOf = (data: ProjectData, k: string) => data.nodes[k]?.status;

// ===== Komponen =====
function SaveState({ dirty, saving, error, onRetry }: { dirty: boolean; saving: boolean; error: string | null; onRetry: () => void }) {
  if (error)
    return (
      <span className="flex items-center gap-1.5 text-xs text-danger" title={error}>
        gagal menyimpan
        <button type="button" onClick={onRetry} className="underline">
          coba lagi
        </button>
      </span>
    );
  if (saving || dirty)
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Spinner className="size-3" /> menyimpan…
      </span>
    );
  return <span className="text-xs text-muted">✓ tersimpan</span>;
}

function NameEditor({ projectId, initial }: { projectId: string; initial: string }) {
  const [name, setName] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  async function commit() {
    const v = name.trim();
    if (v === saved) return;
    if (v.length < 2) {
      setName(saved);
      return;
    }
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: { name: v } });
      setSaved(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setName(saved);
      }}
      title={error ?? "Klik untuk mengganti nama proyek"}
      className={cx(
        "h-8 min-w-0 max-w-[22rem] flex-1 truncate rounded-md border border-transparent bg-transparent px-2 text-[15px] font-semibold outline-none hover:border-border focus:border-primary focus:bg-surface",
        error && "border-danger",
      )}
    />
  );
}

function TemplateMenu({ onPick }: { onPick: (k: "full" | "mvp") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((o) => !o)}>
        Pakai templat ▾
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-border bg-surface p-1 shadow-lg">
            {(
              [
                ["full", "Alur lengkap", "semua tab Excel framework: ES → SGS → SI → LTV → MSDM → DM-CRM → dokumen grand design"],
                ["mvp", "Alur singkat", "ES + SGS: stakeholder, faktor S/W/O/T, IFAS/EFAS, posisi, SWOT, QSPM, cascading"],
              ] as const
            ).map(([k, t, d]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(k);
                }}
                className="block w-full rounded px-2.5 py-2 text-left hover:bg-surface-2"
              >
                <div className="text-sm font-medium">{t}</div>
                <div className="text-[11px] text-muted">{d}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Guide({
  data,
  onTemplate,
  onCustom,
  warnings,
  onCanvasInputIds,
}: {
  data: ProjectData;
  onTemplate: () => void;
  onCustom: () => void;
  warnings: CanvasWarning[];
  onCanvasInputIds: Set<string>;
}) {
  const orphan = data.documents.filter((d) => !d.input_node || !onCanvasInputIds.has(d.input_node));
  const general = warnings.filter((w) => !w.nodeId);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Cara pakai</h2>
        <p className="mt-0.5 text-sm text-muted">Susun alur berpikir seperti flowchart, lalu jalankan.</p>
      </div>
      <ol className="space-y-3">
        {[
          { icon: <DocIcon className="text-info" />, t: "Tarik elemen Input", d: "lalu klik elemen itu untuk mengunggah notulensi, LPJ, atau dokumen lain." },
          { icon: <GearIcon className="text-primary" />, t: "Tarik elemen Proses", d: "satu analisis per tab Excel framework (ES → SGS → SI → LTV → MSDM → DM-CRM). Klik untuk menjalankan, melihat tabelnya, mengubah angka, dan mengatur node." },
          { icon: <CustomIcon className="text-accent" />, t: "Butuh analisis lain?", d: "pakai “Buat proses sendiri”, tulis instruksinya, lalu tarik panah dari analisis yang ingin dibaca." },
          {
            icon: (
              <span className="flex">
                <ShieldIcon className="text-info" />
                <ReviewIcon className="text-warn" />
              </span>
            ),
            t: "Pasang pemeriksaan",
            d: "Validator otomatis memeriksa & memperbaiki hasil AI; Tinjauan manusia menahan run sampai Anda setujui.",
          },
          { icon: <OutIcon className="text-primary" />, t: "Tarik elemen Output", d: "untuk menyusun dokumen grand design dan mengunduhnya (XLSX/DOCX/PDF)." },
        ].map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">{i + 1}</span>
            <div className="text-sm">
              <div className="flex items-center gap-1.5 font-medium">
                {s.icon}
                {s.t}
              </div>
              <p className="text-muted">{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="space-y-2">
        <Button variant="primary" onClick={onTemplate} className="w-full">
          Pakai templat alur lengkap
        </Button>
        <button
          type="button"
          onClick={onCustom}
          className="flex w-full items-center gap-2.5 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2 text-left hover:border-primary"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-base font-bold leading-none text-white">+</span>
          <span>
            <span className="block text-sm font-semibold text-primary">Buat proses sendiri</span>
            <span className="block text-[11px] text-muted">Tulis nama &amp; instruksi sendiri untuk AI</span>
          </span>
        </button>
      </div>
      <ul className="space-y-1 text-[12px] text-muted">
        <li>• Hubungkan elemen dengan menarik titik di sisi kanan ke sisi kiri elemen lain.</li>
        <li>• Hapus elemen atau panah: pilih lalu tekan Delete/Backspace.</li>
        <li>
          • <NoteIcon className="inline size-3.5 align-[-2px] text-[#a08400]" /> Catatan bisa ditempel di mana saja untuk pengingat Anda sendiri.
        </li>
        <li>• Urutan analisis bawaan diatur otomatis; proses buatan sendiri mengikuti panah.</li>
      </ul>
      {general.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn-soft/60 px-3 py-2 text-sm text-warn">
          {general.map((w, i) => (
            <div key={i}>{w.message}.</div>
          ))}
        </div>
      )}
      {orphan.length > 0 && (
        <div className="rounded-md border border-border bg-surface-2/60 px-3 py-2 text-[12.5px]">
          <div className="font-medium">{orphan.length} dokumen proyek tidak terhubung ke elemen input</div>
          <p className="text-[11.5px] text-muted">Tetap dibaca semua analisis.</p>
          <ul className="mt-1 list-disc pl-4 text-[11.5px]">
            {orphan.slice(0, 8).map((d) => (
              <li key={d.id} className="truncate">
                {d.filename}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Bilah progres run di bar atas: "Langkah 4 dari 9 · SWOT · Memeriksa". */
function RunProgress({ run, completed, onStop }: { run: RunState; completed: number; onStop: () => void }) {
  const pct = Math.min(100, Math.round(((completed + 0.35) / Math.max(1, run.total)) * 100));
  return (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
      <div className="w-[min(22rem,40vw)] min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Spinner className="size-3 shrink-0 text-info" />
          <span className="shrink-0 font-semibold tabular-nums">
            Langkah {Math.min(run.step, run.total)} dari {run.total}
          </span>
          <span className="text-muted">·</span>
          <span className="truncate font-medium" title={run.label}>
            {run.label ?? "Analisis"}
          </span>
          <span className="text-muted">·</span>
          <span className="shrink-0 text-info">{phaseLabel(run.phase)}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="cv-stripes h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Button size="sm" variant="danger" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

const EDGE_BASE: CSSProperties = { strokeWidth: 1.5 };
const marker = (color?: string) => ({ type: MarkerType.ArrowClosed, width: 18, height: 18, ...(color ? { color } : {}) });

export function CanvasEditor({
  projectId,
  data,
  reload,
  onData,
}: {
  projectId: string;
  data: ProjectData;
  reload: () => Promise<void>;
  /** Ganti data halaman dengan hasil polling (agar status node segar selama run). */
  onData?: (d: ProjectData) => void;
}) {
  const rf = useReactFlow<FlowNode, Edge>();
  const initial = useMemo(() => toFlow(data.canvas), []); // eslint-disable-line react-hooks/exhaustive-deps -- hanya saat pertama dimuat
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [wide, setWide] = useState(false);

  // ===== Simpan otomatis =====
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const sig = useMemo(() => JSON.stringify(graph), [graph]);
  const [savedSig, setSavedSig] = useState(() => JSON.stringify(toGraph(initial.nodes, initial.edges)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const dirty = sig !== savedSig;
  const latest = useRef({ sig, graph });
  useEffect(() => {
    latest.current = { sig, graph };
  }, [sig, graph]);
  const inflight = useRef<Promise<void> | null>(null);

  const save = useCallback(async () => {
    if (inflight.current) await inflight.current;
    const { sig: s, graph: g } = latest.current;
    const p = (async () => {
      setSaving(true);
      try {
        await api(`/api/projects/${projectId}/canvas`, { method: "PUT", body: { graph: g } });
        setSavedSig(s);
        setSaveError(null);
        setVersion((v) => v + 1);
      } catch (e) {
        setSaveError((e as Error).message);
        throw e;
      } finally {
        setSaving(false);
      }
    })();
    inflight.current = p;
    try {
      await p;
    } finally {
      if (inflight.current === p) inflight.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    if (!dirty || saveError) return;
    const t = setTimeout(() => save().catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [sig, dirty, saveError, save]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const flush = useCallback(async () => {
    if (latest.current.sig !== savedSig || inflight.current) await save();
  }, [save, savedSig]);

  // ===== Data segar + animasi "baru selesai" =====
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  const seq = useRef({ sent: 0, applied: 0 });
  const refresh = useCallback(async () => {
    if (!onData) return reload();
    const n = ++seq.current.sent;
    const d = await api<ProjectData>(`/api/projects/${projectId}`);
    if (n < seq.current.applied) return; // respons lama datang belakangan
    seq.current.applied = n;
    const prev = dataRef.current.nodes;
    const fresh = Object.entries(d.nodes)
      .filter(([k, v]) => v.status === "done" && prev[k]?.status !== "done")
      .map(([k]) => k);
    if (fresh.length) {
      setJustDone((s) => new Set([...s, ...fresh]));
      setTimeout(() => setJustDone((s) => new Set([...s].filter((k) => !fresh.includes(k)))), 1600);
    }
    dataRef.current = d;
    onData(d);
  }, [onData, reload, projectId]);
  const refreshSafe = useCallback(() => refresh().catch(() => {}), [refresh]);

  // ===== Turunan =====
  const warnings = useMemo(() => canvasWarnings(graph), [graph]);
  const allKeys = useMemo(() => processKeys(graph), [graph]);
  const presentKeys = useMemo(() => new Set(nodes.filter(isBuiltinProcess).map((n) => n.data.key!)), [nodes]);
  const nodeIdOfKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const k = flowKey(n.id, n.data);
      if (k && !m.has(k)) m.set(k, n.id);
    }
    return m;
  }, [nodes]);
  const labelFor = useCallback((k: string) => labelOf(latest.current.graph, k), []);
  const labelNow = useCallback((k: string) => labelOf(graph, k), [graph]);
  const checkTargetOf = useCallback(
    (id: string): CheckTarget | null => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const e of edges) {
        if (e.target !== id) continue;
        const s = byId.get(e.source);
        const k = s ? flowKey(s.id, s.data) : null;
        if (s && k) return { nodeId: s.id, key: k, label: labelOf(graph, k) };
      }
      return null;
    },
    [nodes, edges, graph],
  );
  const docCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data.documents) if (d.input_node) m.set(d.input_node, (m.get(d.input_node) ?? 0) + 1);
    return m;
  }, [data.documents]);
  const inputIds = useMemo(() => new Set(nodes.filter((n) => n.data.gtype === "input").map((n) => n.id)), [nodes]);

  // ===== Menambah elemen =====
  const centerPos = useCallback(
    (type: FlowData["gtype"]) => {
      const r = wrapRef.current?.getBoundingClientRect();
      const c = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
      const s = SIZE[type];
      const p = { x: c.x - s.w / 2 + (Math.random() * 40 - 20), y: c.y - s.h / 2 + (Math.random() * 40 - 20) };
      // geser sedikit ke bawah bila menimpa elemen lain
      const hit = () =>
        nodes.some((n) => {
          const z = sizeOf(n);
          return p.x < n.position.x + z.w + 10 && p.x + s.w + 10 > n.position.x && p.y < n.position.y + z.h + 10 && p.y + s.h + 10 > n.position.y;
        });
      for (let i = 0; i < 14 && hit(); i++) p.y += 60;
      return p;
    },
    [rf, nodes],
  );

  const addNode = useCallback(
    (item: PaletteItem, pos?: { x: number; y: number }) => {
      if (item.type === "process" && item.key && item.key !== "custom" && presentKeys.has(item.key)) return;
      const isCheck = item.type === "validator" || item.type === "review";
      // Validator/tinjauan langsung disambungkan: ke proses yang dipilih (klik) atau proses terdekat (tarik).
      let anchor: FlowNode | undefined;
      if (isCheck) {
        const free = (p: FlowNode) => p.data.gtype === "process" && !checksOfProcess(p.id, item.type as CheckType, nodes, edges).length;
        if (!pos) {
          const sel = nodes.filter((n) => n.selected);
          if (sel.length === 1 && free(sel[0])) anchor = sel[0];
        } else {
          let best = 260;
          for (const n of nodes) {
            if (!free(n)) continue;
            const z = sizeOf(n);
            const dist = Math.hypot(n.position.x + z.w / 2 - (pos.x + SIZE[item.type].w / 2), n.position.y + z.h / 2 - (pos.y + SIZE[item.type].h / 2));
            if (dist < best) {
              best = dist;
              anchor = n;
            }
          }
        }
      }
      // Proses kustom (klik): di kanan node yang dipilih, dan bila itu proses, hasilnya langsung dibaca (panah otomatis).
      const isCustom = item.type === "process" && item.key === "custom";
      const selOne = nodes.filter((n) => n.selected);
      const besideOf = isCustom && !pos && selOne.length === 1 ? selOne[0] : undefined;
      if (besideOf?.data.gtype === "process") anchor = besideOf;
      let position = pos ?? (anchor && isCheck ? placeCheck(anchor, item.type as CheckType, nodes) : centerPos(item.type));
      if (besideOf) {
        const z = sizeOf(besideOf);
        position = { x: besideOf.position.x + z.w + 80, y: besideOf.position.y };
        for (let i = 0; i < 12 && nodes.some((n) => Math.abs(n.position.x - position.x) < 200 && Math.abs(n.position.y - position.y) < 90); i++) position.y += 110;
      }
      const builtin = item.type === "process" && item.key && item.key !== "custom";
      const id = builtin && !nodes.some((n) => n.id === item.key) ? item.key! : crypto.randomUUID();
      const data: FlowData =
        item.type === "process"
          ? item.key === "custom"
            ? { gtype: "process", key: "custom", custom: { name: "", instruction: "", prefix: "K", requireEvidence: true } }
            : { gtype: "process", key: item.key }
          : item.type === "input"
            ? { gtype: "input", label: item.label ?? "Dokumen", values: !!item.values }
            : item.type === "output"
              ? { gtype: "output", label: item.label ?? "Dokumen hasil" }
              : item.type === "note"
                ? { gtype: "note", label: "", text: "" }
                : { gtype: item.type, label: "" };
      const node: FlowNode = { id, type: rfType(item.type), position, selected: true, data };
      const next = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), node];
      setNodes(next);
      if (anchor) {
        const a = anchor;
        setEdges((es) => [...es, { id: `${a.id}->${id}`, source: a.id, target: id }]);
      } else if (builtin) {
        const add = autoEdges([item.key!], next, edges);
        if (add.length) setEdges((es) => [...es, ...add]);
      }
    },
    [nodes, edges, presentKeys, centerPos, setNodes, setEdges],
  );

  /** Tambah validator/tinjauan untuk node proses tertentu (dari panel proses); proses tetap terpilih. */
  const addCheck = useCallback(
    (processId: string, type: CheckType) => {
      const p = nodes.find((n) => n.id === processId);
      if (!p || checksOfProcess(processId, type, nodes, edges).length) return;
      const id = crypto.randomUUID();
      setNodes([...nodes, newCheckNode(id, type, placeCheck(p, type, nodes))]);
      setEdges((es) => [...es, { id: `${processId}->${id}`, source: processId, target: id }]);
    },
    [nodes, edges, setNodes, setEdges],
  );

  /**
   * Terapkan penempatan validator/tinjauan per analisis (mis. dari laporan optimasi):
   * `applyPlacement({ swot_matrix: { validator: true, human: false }, ... })`. Kunci = kunci mesin (bawaan atau "custom_<id>").
   * Mengembalikan jumlah elemen yang ditambah/dilepas. Perubahan tersimpan otomatis.
   */
  const applyPlacement = useCallback(
    (placement: PlacementMap) => {
      const r = withPlacement(nodes, edges, placement);
      setNodes(r.nodes);
      setEdges(r.edges);
      return { added: r.added, removed: r.removed };
    },
    [nodes, edges, setNodes, setEdges],
  );

  const addMissing = useCallback(
    (nodeId: string) => {
      const base = nodes.find((n) => n.id === nodeId);
      if (!base || !isBuiltinProcess(base)) return;
      const present = new Set(nodes.filter(isBuiltinProcess).map((n) => n.data.key));
      const level = new Map<string, number>();
      const visit = (k: string, lvl: number) => {
        for (const d of depsOf(k)) {
          if (present.has(d)) continue;
          level.set(d, Math.max(level.get(d) ?? 0, lvl));
          visit(d, lvl + 1);
        }
      };
      visit(base.data.key!, 1);
      if (!level.size) return;
      const byLevel = new Map<number, string[]>();
      for (const k of Object.keys(NODE_META)) if (level.has(k)) byLevel.set(level.get(k)!, [...(byLevel.get(level.get(k)!) ?? []), k]);
      const added: FlowNode[] = [];
      for (const [lvl, ks] of byLevel)
        ks.forEach((k, i) =>
          added.push({
            id: nodes.some((n) => n.id === k) ? crypto.randomUUID() : k,
            type: "processNode",
            position: { x: base.position.x - 290 * lvl, y: base.position.y + (i - (ks.length - 1) / 2) * 150 },
            data: { gtype: "process", key: k },
          }),
        );
      const next = [...nodes, ...added];
      setNodes(next);
      const add = autoEdges([...level.keys()], next, edges);
      if (add.length) setEdges((es) => [...es, ...add]);
    },
    [nodes, edges, setNodes, setEdges],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DND_TYPE);
      if (!raw) return;
      e.preventDefault();
      const item = JSON.parse(raw) as PaletteItem;
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const s = SIZE[item.type] ?? { w: 220, h: 76 };
      addNode(item, { x: p.x - s.w / 2, y: p.y - s.h / 2 });
    },
    [rf, addNode],
  );

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: `${c.source}->${c.target}` }, es)), [setEdges]);
  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (c) => {
      if (c.source === c.target) return false;
      const s = nodes.find((n) => n.id === c.source);
      const t = nodes.find((n) => n.id === c.target);
      if (!s || !t || s.data.gtype === "output" || t.data.gtype === "input") return false;
      if (edges.some((e) => e.source === c.source && e.target === c.target)) return false;
      if (t.data.gtype === "validator" || t.data.gtype === "review") {
        // satu elemen pemeriksaan untuk satu proses; satu proses paling banyak satu validator dan satu tinjauan
        if (s.data.gtype !== "process") return false;
        if (edges.some((e) => e.target === t.id && nodes.find((n) => n.id === e.source)?.data.gtype === "process")) return false;
        if (checksOfProcess(s.id, t.data.gtype, nodes, edges).length) return false;
      }
      return true;
    },
    [nodes, edges],
  );

  const onBeforeDelete: OnBeforeDelete<FlowNode, Edge> = useCallback(
    async ({ nodes: del, edges: delEdges }) => {
      // Elemen pemeriksaan milik proses yang dihapus ikut dihapus (bila tidak dipakai proses lain).
      const delIds = new Set(del.map((n) => n.id));
      const extra = nodes.filter((n) => {
        if (delIds.has(n.id) || (n.data.gtype !== "validator" && n.data.gtype !== "review")) return false;
        const from = edges.filter((e) => e.target === n.id).map((e) => e.source);
        return from.length > 0 && from.every((s) => delIds.has(s));
      });
      const allDel = [...del, ...extra];
      const withDocs = allDel.filter((n) => n.data.gtype === "input" && (docCounts.get(n.id) ?? 0) > 0);
      if (withDocs.length) {
        const total = withDocs.reduce((s, n) => s + (docCounts.get(n.id) ?? 0), 0);
        if (!confirm(`Hapus ${withDocs.map((n) => `"${n.data.label}"`).join(", ")} beserta ${total} dokumennya? Dokumen dihapus permanen dan tidak lagi dibaca analisis.`)) return false;
        try {
          const ids = new Set(withDocs.map((n) => n.id));
          await Promise.all(data.documents.filter((d) => d.input_node && ids.has(d.input_node)).map((d) => api(`/api/documents/${d.id}`, { method: "DELETE" })));
        } catch (e) {
          alert(`Gagal menghapus dokumen: ${(e as Error).message}`);
          return false;
        }
        refreshSafe();
      }
      if (!extra.length) return true;
      const extraIds = new Set(extra.map((n) => n.id));
      const extraEdges = edges.filter((e) => (extraIds.has(e.source) || extraIds.has(e.target)) && !delEdges.some((d) => d.id === e.id));
      return { nodes: allDel, edges: [...delEdges, ...extraEdges] };
    },
    [nodes, edges, docCounts, data.documents, refreshSafe],
  );

  const patchNode = useCallback(
    (id: string, patch: FlowPatch) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...(typeof patch === "function" ? patch(n.data) : patch) } } : n))),
    [setNodes],
  );
  const selectNode = useCallback((id: string) => setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id }))), [setNodes]);
  // Panel samping saat tidak ada elemen terpilih: "Laporan" run atau "Perhitungan" (alur angka). Satu terbuka sekaligus.
  const [sidePanel, setSidePanel] = useState<null | "report" | "calc">(null);
  const [calcFocus, setCalcFocus] = useState<string | null>(null);
  const deselect = () => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
  const removeNode = useCallback((id: string) => rf.deleteElements({ nodes: [{ id }] }), [rf]);

  function applyTemplate(kind: "full" | "mvp") {
    if (nodes.length && !confirm("Ganti isi canvas dengan templat? Elemen yang ada sekarang diganti. Dokumen yang sudah diunggah tetap tersimpan dan tetap dibaca analisis."))
      return;
    const f = toFlow(templateGraph(kind));
    setNodes(f.nodes);
    setEdges(f.edges);
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 60);
  }

  // ===== Menjalankan analisis =====
  const [runState, setRunState] = useState<(RunState & { keys: string[]; startDone: number }) | null>(null);
  const [runMsg, setRunMsg] = useState<{ target: string | null; msg: RunMsg } | null>(null);
  /** Run "jalankan semua / sampai X" yang berhenti karena menunggu tinjauan — bisa dilanjutkan setelah disetujui. */
  const [paused, setPaused] = useState<{ target: string | null; key: string } | null>(null);
  const stopRef = useRef(false);

  const run = useCallback(
    async (target: string | null) => {
      if (runState) return;
      stopRef.current = false;
      setRunMsg(null);
      setPaused(null);
      const say = (tone: NonNullable<RunMsg>["tone"], text: string) => setRunMsg({ target, msg: { tone, text } });
      try {
        await flush();
      } catch {
        say("danger", "Canvas belum tersimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      const g = latest.current.graph;
      const needed = neededKeys(target, g);
      const done = new Set(needed.filter((k) => statusOf(dataRef.current, k) === "done"));
      const startDone = done.size;
      const total = Math.max(1, needed.filter((k) => !done.has(k)).length);
      let step = 0;
      let ranAny = false;
      const first = predictNext(needed, done, g);
      setRunState({ target, current: first, label: first ? labelFor(first) : undefined, step: 1, total, keys: needed, startDone });
      const poll = setInterval(refreshSafe, 1000);
      try {
        for (;;) {
          if (stopRef.current) {
            say("info", "Dihentikan. Hasil yang sudah selesai tetap tersimpan.");
            break;
          }
          step++;
          const next = predictNext(needed, done, g);
          setRunState({ target, current: next, label: next ? labelFor(next) : undefined, step, total, keys: needed, startDone });
          const r = await api<ExecResult>(`/api/projects/${projectId}/run`, { body: target ? { key: target } : {} });
          if (!r.ran) {
            if (!ranAny) {
              const allDone = needed.every((k) => done.has(k));
              say(allDone ? "ok" : "warn", allDone ? "Semua analisis yang dibutuhkan sudah selesai." : "Tidak ada analisis yang bisa dijalankan sekarang — cek analisis yang perlu ditinjau atau gagal.");
            } else say("ok", "Selesai.");
            break;
          }
          ranAny = true;
          if (r.status === "done") done.add(r.ran);
          await refresh();
          if (r.status === "needs_review") {
            say("warn", `${labelFor(r.ran)} menunggu tinjauan Anda sebelum analisis berikutnya dijalankan.`);
            if (target !== r.ran) setPaused({ target, key: r.ran }); // ada analisis lain sesudahnya → tawarkan "Lanjutkan run"
            // buka elemen tinjauan (belah ketupat) bila ada, kalau tidak buka node prosesnya
            const pid = [...latest.current.graph.nodes].find((n) => flowKey(n.id, { gtype: n.type, key: n.key, custom: n.custom }) === r.ran)?.id;
            const rv = pid ? attachedChecks(latest.current.graph, pid).review : null;
            if (rv || pid) selectNode(rv?.id ?? pid!);
            break;
          }
          if (r.status === "failed") {
            say("danger", `${labelFor(r.ran)} gagal. Buka elemennya untuk melihat penyebabnya.`);
            const pid = latest.current.graph.nodes.find((n) => flowKey(n.id, { gtype: n.type, key: n.key, custom: n.custom }) === r.ran)?.id;
            if (pid) selectNode(pid);
            break;
          }
          if (!r.remaining.length) {
            say("ok", target ? `${labelFor(target)} selesai.` : "Semua analisis selesai.");
            break;
          }
          if (step > 80) break;
        }
      } catch (e) {
        say("danger", (e as Error).message);
      } finally {
        clearInterval(poll);
        setRunState(null);
        await refreshSafe();
        setVersion((v) => v + 1);
      }
    },
    [runState, flush, projectId, refresh, refreshSafe, labelFor, selectNode],
  );

  const rerun = useCallback(
    async (key: string) => {
      if (!confirm(`Jalankan ulang ${labelFor(key)}? Hasil analisis sesudahnya (yang memakai hasil ini) ikut dikosongkan.`)) return;
      if (data.runId) {
        try {
          await api(`/api/runs/${data.runId}/reset`, { body: { node: key } });
          await refresh();
        } catch (e) {
          setRunMsg({ target: key, msg: { tone: "danger", text: (e as Error).message } });
          return;
        }
      }
      // tunggu render ulang dengan status terbaru sebelum menghitung progres
      setTimeout(() => run(key), 0);
    },
    [data.runId, refresh, run, labelFor],
  );

  // ===== Ulang dari awal: arsipkan run utama lalu mulai run kosong =====
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState<"clear" | "run" | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const hasAnyResult = useMemo(
    () => Object.values(data.nodes).some((n) => (n.output !== null && n.output !== undefined) || ["done", "failed", "needs_review", "running"].includes(n.status)),
    [data.nodes],
  );
  const startOver = useCallback(
    async (thenRun: boolean) => {
      setResetBusy(thenRun ? "run" : "clear");
      setResetError(null);
      try {
        await flush();
        await api(`/api/projects/${projectId}/reset`, { method: "POST" });
        setPaused(null);
        await refresh();
        setResetOpen(false);
        setRunMsg({ target: null, msg: { tone: "ok", text: thenRun ? "Hasil lama diarsipkan. Menjalankan semua analisis dari awal…" : "Hasil lama diarsipkan. Canvas siap dijalankan dari awal." } });
        setVersion((v) => v + 1);
        // tunggu render ulang dengan status kosong sebelum menghitung progres
        if (thenRun) setTimeout(() => run(null), 0);
      } catch (e) {
        setResetError((e as Error).message);
      } finally {
        setResetBusy(null);
      }
    },
    [flush, projectId, refresh, run],
  );

  // Tampilan run: analisis yang benar-benar sedang berjalan (dari polling) + tahapnya.
  const runView: RunState | null = useMemo(() => {
    if (!runState) return null;
    const live = runState.keys.find((k) => data.nodes[k]?.status === "running");
    const cur = live ?? runState.current;
    return { ...runState, current: cur, label: cur ? labelNow(cur) : runState.label, phase: cur && data.nodes[cur]?.status === "running" ? (data.nodes[cur]?.phase ?? null) : null };
  }, [runState, data.nodes, labelNow]);
  const completed = runState ? Math.max(0, runState.keys.filter((k) => data.nodes[k]?.status === "done").length - runState.startDone) : 0;
  const runningKey = runView?.current ?? null;
  const runningNodeId = runningKey ? (runningKey === "grand_design" ? (nodes.find((n) => n.data.gtype === "output")?.id ?? null) : (nodeIdOfKey.get(runningKey) ?? null)) : null;
  const canResume = !!paused && !runState && data.nodes[paused.key]?.status !== "needs_review";
  const resume = useCallback(() => paused && run(paused.target), [paused, run]);

  // ===== Ikuti node yang berjalan (halus; tidak melawan pengguna yang sedang menggeser canvas) =====
  const userMoved = useRef(0);
  useEffect(() => {
    if (!runningNodeId || Date.now() - userMoved.current < 5000) return;
    const n = rf.getInternalNode(runningNodeId);
    const r = wrapRef.current?.getBoundingClientRect();
    if (!n || !r) return;
    const { x, y } = n.internals.positionAbsolute;
    const w = n.measured.width ?? 220;
    const h = n.measured.height ?? 90;
    const vp = rf.getViewport();
    const sx = x * vp.zoom + vp.x;
    const sy = y * vp.zoom + vp.y;
    const m = 24;
    const visible = sx >= m && sy >= m && sx + w * vp.zoom <= r.width - m && sy + h * vp.zoom <= r.height - m;
    if (!visible) rf.setCenter(x + w / 2, y + h / 2, { zoom: vp.zoom, duration: 700 });
  }, [runningNodeId, rf]);

  // ===== Panah: animasi aliran ke node yang berjalan, warna khusus untuk panah pemeriksaan =====
  const waitingReviewIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      const k = flowKey(n.id, n.data);
      if (k && data.nodes[k]?.status === "needs_review") for (const e of edges) if (e.source === n.id) s.add(e.target);
    }
    return s;
  }, [nodes, edges, data.nodes]);
  const displayEdges = useMemo(() => {
    const type = new Map(nodes.map((n) => [n.id, n.data.gtype]));
    return edges.map((e): Edge => {
      const t = type.get(e.target);
      const s = type.get(e.source);
      const check = t === "validator" || t === "review";
      const hot = !!runningNodeId && (e.target === runningNodeId || (e.source === runningNodeId && check));
      if (hot) return { ...e, animated: true, style: { ...EDGE_BASE, stroke: "#1d4ed8", strokeWidth: 2.5 }, markerEnd: marker("#1d4ed8"), zIndex: 1 };
      if (t === "review" && waitingReviewIds.has(e.target))
        return { ...e, animated: false, style: { ...EDGE_BASE, stroke: "#b45309", strokeWidth: 2.5 }, markerEnd: marker("#b45309") };
      if (t === "validator") return { ...e, animated: false, style: { ...EDGE_BASE, stroke: "#7d9be0", strokeDasharray: "5 4" }, markerEnd: marker("#7d9be0") };
      if (t === "review") return { ...e, animated: false, style: { ...EDGE_BASE, stroke: "#d6a35e", strokeDasharray: "5 4" }, markerEnd: marker("#d6a35e") };
      if (t === "note" || s === "note") return { ...e, animated: false, style: { ...EDGE_BASE, stroke: "#d9c56a", strokeDasharray: "2 4" }, markerEnd: marker("#d9c56a") };
      return e;
    });
  }, [edges, nodes, runningNodeId, waitingReviewIds]);

  // ===== Analisis yang hulunya diubah manusia setelah analisis itu selesai =====
  const stale = useMemo(() => staleMap(graph, data.nodes), [graph, data.nodes]);

  // ===== Konteks node =====
  const ctx: CanvasCtxValue = useMemo(
    () => ({
      nodeState: (k) => (k ? data.nodes[k] : undefined),
      runningKey,
      justDone,
      docCount: (id) => docCounts.get(id) ?? 0,
      warningsOf: (id) => warnings.filter((w) => w.nodeId === id),
      addMissing,
      checkTarget: checkTargetOf,
      setNoteText: (id, text) => patchNode(id, { text }),
      staleOf: (k) => (k ? (stale.get(k) ?? []) : []),
    }),
    [data.nodes, runningKey, justDone, docCounts, warnings, addMissing, checkTargetOf, patchNode, stale],
  );

  const selected = nodes.filter((n) => n.selected);
  const sel = selected.length === 1 ? selected[0] : null;
  const selKey = sel ? flowKey(sel.id, sel.data) : null;
  const msgFor = (target: string | null) => (runMsg && runMsg.target === target ? runMsg.msg : null);
  const runAllLabel = runState && !runState.target;
  const attached = (id: string): AttachedChecks => {
    const a = attachedChecks(graph, id);
    return {
      validator: a.validator ? { id: a.validator.id, label: a.validator.label || "Validator otomatis" } : null,
      review: a.review ? { id: a.review.id, label: a.review.label || "Tinjauan" } : null,
    };
  };
  const PANEL_HEAD: Record<FlowData["gtype"], { icon: ReactNode; title: string }> = {
    input: { icon: <DocIcon className="text-info" />, title: "Input — dokumen" },
    output: { icon: <OutIcon className="text-primary" />, title: "Output — dokumen hasil" },
    process: sel?.data.key === "custom" || sel?.data.custom ? { icon: <CustomIcon className="text-accent" />, title: "Proses kustom" } : { icon: <GearIcon className="text-primary" />, title: "Proses — analisis" },
    validator: { icon: <ShieldIcon className="text-info" />, title: "Pemeriksaan — validator otomatis" },
    review: { icon: <ReviewIcon className="text-warn" />, title: "Pemeriksaan — tinjauan manusia" },
    note: { icon: <NoteIcon className="text-[#a08400]" />, title: "Catatan" },
  };
  const narrow = sel && (sel.data.gtype === "validator" || sel.data.gtype === "review" || sel.data.gtype === "note");

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Bar atas */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Link href="/projects" className="shrink-0 rounded-md px-1.5 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text" title="Kembali ke daftar proyek">
          ← Proyek
        </Link>
        <NameEditor projectId={projectId} initial={data.project.name} />
        <SaveState dirty={dirty} saving={saving} error={saveError} onRetry={() => save().catch(() => {})} />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {runView ? (
            <RunProgress run={runView} completed={completed} onStop={() => (stopRef.current = true)} />
          ) : (
            <>
              {msgFor(null) && (
                <span
                  className={cx(
                    "max-w-80 truncate text-xs",
                    { info: "text-info", ok: "text-ok", warn: "text-warn", danger: "text-danger" }[msgFor(null)!.tone],
                  )}
                  title={msgFor(null)!.text}
                >
                  {msgFor(null)!.text}
                </span>
              )}
              {canResume && (
                <Button size="sm" variant="primary" onClick={resume}>
                  Lanjutkan run
                </Button>
              )}
            </>
          )}
          <Button
            size="sm"
            variant={sidePanel === "calc" && !sel ? "primary" : "secondary"}
            onClick={() => {
              if (sidePanel === "calc" && !sel) setSidePanel(null);
              else {
                deselect();
                setCalcFocus(null);
                setSidePanel("calc");
              }
            }}
            title="Bagaimana setiap angka dihitung dari awal sampai akhir: masukan, proses, dan keluaran tiap analisis"
          >
            Perhitungan
          </Button>
          <Button
            size="sm"
            variant={sidePanel === "report" && !sel ? "primary" : "secondary"}
            onClick={() => {
              if (sidePanel === "report" && !sel) setSidePanel(null);
              else {
                deselect();
                setSidePanel("report");
              }
            }}
            title="Progres run, biaya tiap node, hasil validator, tinjauan, dan rekomendasi optimasi"
          >
            Laporan
          </Button>
          <TemplateMenu onPick={applyTemplate} />
          {hasAnyResult && (
            <Button
              size="sm"
              onClick={() => {
                setResetError(null);
                setResetOpen(true);
              }}
              disabled={!!runState}
              title="Arsipkan hasil analisis saat ini dan mulai lagi dari awal (dokumen tetap)"
            >
              Ulang dari awal
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => run(null)} disabled={!!runState || !allKeys.length}>
            {runAllLabel ? "Berjalan…" : "Jalankan semua"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <Palette
          presentKeys={presentKeys}
          onAdd={(it) => addNode(it)}
          collapsed={paletteCollapsed}
          onToggle={() => setPaletteCollapsed((c) => !c)}
          selectedProcess={sel && selKey ? labelNow(selKey) : null}
        />

        {/* Canvas */}
        <div ref={wrapRef} className="relative min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <CanvasCtx.Provider value={ctx}>
            <ReactFlow<FlowNode, Edge>
              nodes={nodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onBeforeDelete={onBeforeDelete}
              onMoveStart={(e) => {
                if (e) userMoved.current = Date.now();
              }}
              onNodeDragStart={() => (userMoved.current = Date.now())}
              nodeTypes={nodeTypes}
              deleteKeyCode={["Backspace", "Delete"]}
              defaultEdgeOptions={{ type: "smoothstep", markerEnd: marker(), style: EDGE_BASE }}
              fitView
              fitViewOptions={{ padding: 0.08, maxZoom: 1, minZoom: 0.2 }}
              // Fit ulang setelah ukuran node terukur agar seluruh alur langsung terlihat saat dibuka.
              onInit={(inst) => setTimeout(() => inst.fitView({ padding: 0.08, maxZoom: 1, minZoom: 0.2 }), 250)}
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#c8ced6" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="!h-24 !w-36"
                nodeColor={(n) =>
                  ({ input: "#c7d6fb", output: "#a7ddd5", validator: "#9db7f0", review: "#f1c27d", note: "#f5e58c", process: "#cfd5dc" })[(n.data as FlowData).gtype] ?? "#cfd5dc"
                }
              />
              <Panel position="bottom-center" className="pointer-events-none !mb-2">
                <span className="inline-block rounded bg-surface/90 px-2 py-1 text-center text-[11px] text-muted shadow-sm">
                  Urutan analisis bawaan diatur otomatis — proses buatan sendiri, validator, dan tinjauan mengikuti panah.
                </span>
              </Panel>
            </ReactFlow>
          </CanvasCtx.Provider>
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="pointer-events-auto max-w-sm rounded-xl border border-dashed border-border bg-surface/90 px-6 py-6 text-center shadow-sm">
                <p className="text-sm font-medium">Canvas masih kosong</p>
                <p className="mt-1 text-sm text-muted">Tarik elemen dari daftar di kiri ke sini, atau mulai dari templat.</p>
                <Button variant="primary" className="mt-3" onClick={() => applyTemplate("full")}>
                  Pakai templat alur lengkap
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Panel samping */}
        <aside
          className={cx(
            "flex shrink-0 flex-col border-l border-border bg-surface transition-[width]",
            sel ? (wide ? "w-[760px]" : narrow ? "w-[420px]" : "w-[480px]") : sidePanel === "calc" ? "w-[760px]" : sidePanel === "report" ? "w-[720px]" : "w-[360px]",
          )}
        >
          {sel && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted">
              {PANEL_HEAD[sel.data.gtype]?.icon}
              <span className="font-medium">{PANEL_HEAD[sel.data.gtype]?.title}</span>
              <span className="flex-1" />
              <button type="button" onClick={() => setWide((w) => !w)} className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text">
                {wide ? "Persempit" : "Perlebar"}
              </button>
              <button type="button" onClick={() => removeNode(sel.id)} className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft" title="Hapus elemen dari canvas">
                Hapus
              </button>
              <button type="button" onClick={deselect} className="rounded px-1.5 py-0.5 text-sm hover:bg-surface-2 hover:text-text" aria-label="Tutup panel">
                ✕
              </button>
            </div>
          )}
          {sidePanel === "calc" && !sel && selected.length <= 1 ? (
            <div className="min-h-0 flex-1">
              <CalcOverview
                graph={graph}
                data={data}
                running={!!runState}
                focusKey={calcFocus}
                onRun={(k) => run(k)}
                onSelectNode={(key) => {
                  const n = key === "grand_design" ? nodes.find((x) => x.data.gtype === "output") : canvasNodeOfKey(graph, key);
                  if (n) selectNode(n.id);
                }}
                onClose={() => setSidePanel(null)}
              />
            </div>
          ) : sidePanel === "report" && !sel && selected.length <= 1 ? (
            <div className="min-h-0 flex-1">
              <ReportPanel
                projectId={projectId}
                graph={graph}
                data={data}
                running={!!runState}
                onApplyPlacement={(placement) => applyPlacement(placement)}
                onSelectNode={(key) => {
                  const n = canvasNodeOfKey(graph, key);
                  if (n) selectNode(n.id);
                }}
                onClose={() => setSidePanel(null)}
              />
            </div>
          ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selected.length > 1 ? (
              <p className="text-sm text-muted">{selected.length} elemen dipilih. Tekan Delete untuk menghapus, atau klik satu elemen untuk melihat detailnya.</p>
            ) : !sel ? (
              <Guide
                data={data}
                onTemplate={() => applyTemplate("full")}
                onCustom={() => addNode({ type: "process", key: "custom" })}
                warnings={warnings}
                onCanvasInputIds={inputIds}
              />
            ) : sel.data.gtype === "input" ? (
              <InputPanel
                key={sel.id}
                projectId={projectId}
                nodeId={sel.id}
                data={sel.data}
                docs={data.documents.filter((d) => d.input_node === sel.id)}
                onChange={(p) => patchNode(sel.id, p)}
                onChanged={refreshSafe}
              />
            ) : sel.data.gtype === "process" && selKey ? (
              <ProcessPanel
                key={sel.id}
                nodeId={sel.id}
                nodeKey={selKey}
                label={labelNow(selKey)}
                defaultLabel={sel.data.key === "custom" || sel.data.custom ? sel.data.custom?.name?.trim() || "Proses kustom" : (NODE_META[sel.data.key as NodeKey]?.label ?? selKey)}
                parents={engineParents(graph, selKey).map(labelNow)}
                staleFrom={(stale.get(selKey) ?? []).map(labelNow)}
                labelOf={labelNow}
                checks={attached(sel.id)}
                data={sel.data}
                all={data}
                warnings={warnings.filter((w) => w.nodeId === sel.id)}
                runState={runView}
                runMsg={msgFor(selKey)}
                canResume={canResume}
                onRun={(k) => run(k)}
                onRerun={rerun}
                onStop={() => (stopRef.current = true)}
                onResume={resume}
                onAddMissing={addMissing}
                onAddCheck={(type) => addCheck(sel.id, type)}
                onRemoveNode={removeNode}
                onSelect={selectNode}
                onChange={(p) => patchNode(sel.id, p)}
                onChanged={refreshSafe}
                onOpenCalc={() => {
                  setCalcFocus(selKey);
                  setSidePanel("calc");
                  deselect();
                }}
                wide={wide}
              />
            ) : sel.data.gtype === "validator" ? (
              <ValidatorPanel
                key={sel.id}
                data={sel.data}
                target={checkTargetOf(sel.id)}
                all={data}
                warnings={warnings.filter((w) => w.nodeId === sel.id)}
                runState={runView}
                onChange={(p) => patchNode(sel.id, p)}
                onSelect={selectNode}
              />
            ) : sel.data.gtype === "review" ? (
              <ReviewPanel
                key={sel.id}
                data={sel.data}
                target={checkTargetOf(sel.id)}
                all={data}
                warnings={warnings.filter((w) => w.nodeId === sel.id)}
                canResume={canResume}
                onChange={(p) => patchNode(sel.id, p)}
                onChanged={refreshSafe}
                onRejected={(k) => run(k)}
                onResume={resume}
                onSelect={selectNode}
              />
            ) : sel.data.gtype === "note" ? (
              <NotePanel key={sel.id} data={sel.data} onChange={(p) => patchNode(sel.id, p)} />
            ) : (
              <OutputPanel
                key={sel.id}
                projectId={projectId}
                nodeId={sel.id}
                data={sel.data}
                all={data}
                connected={allKeys.filter((k) => upstreamProcesses(graph, sel.id).includes(k)).map(labelNow)}
                version={version}
                dirty={dirty}
                runState={runView}
                runMsg={msgFor("grand_design")}
                onRun={(k) => run(k)}
                onChange={(p) => patchNode(sel.id, p)}
              />
            )}
          </div>
          )}
        </aside>
      </div>

      <Modal
        open={resetOpen}
        onClose={() => !resetBusy && setResetOpen(false)}
        title="Ulang dari awal?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)} disabled={!!resetBusy}>
              Batal
            </Button>
            <Button onClick={() => startOver(false)} loading={resetBusy === "clear"} disabled={!!resetBusy}>
              Bersihkan saja
            </Button>
            <Button variant="primary" onClick={() => startOver(true)} loading={resetBusy === "run"} disabled={!!resetBusy || !allKeys.length}>
              Bersihkan &amp; jalankan semua
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Hasil analisis saat ini diarsipkan (tetap tersimpan sebagai data eksperimen/TA) dan canvas mulai dari awal. Dokumen input dan jawaban pertanyaan tidak berubah.
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted">
            <li>Semua tabel, angka yang Anda ubah, tinjauan, dan hasil validator di run ini ikut diarsipkan.</li>
            <li>Susunan canvas, pengaturan node, validator, dan tinjauan tetap seperti sekarang.</li>
            <li>
              <b className="text-text">Bersihkan &amp; jalankan semua</b> langsung menjalankan semua analisis lagi (memakai token AI).
            </li>
          </ul>
          <ErrorBox error={resetError} />
        </div>
      </Modal>
    </div>
  );
}
