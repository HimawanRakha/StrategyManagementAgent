"use client";
// Panel "Laporan run" untuk orang awam, dibaca dari atas ke bawah:
//  1. Cara membaca · 2. Ringkasan run · 3. Galat & temuan (semua, tanpa disembunyikan) · 4. Rumus
//  5. Rekomendasi penempatan validator/tinjauan · 6. Kesimpulan.
// Semua perhitungan dilakukan di browser dengan fungsi murni (report-utils.ts); tidak ada pemanggilan AI.
// Angka model penempatan TIDAK bergantung pada penempatan sekarang (terukur dari eksperimen → asumsi tetap), edit pengguna
// disimpan per proyek, dan optimasinya deterministik — jadi rekomendasi sama setiap kali laporan dibuka.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import type { WorkflowGraph } from "@/lib/db/schema";
import { labelOf } from "@/lib/engine/canvas";
import { NODE_KEYS } from "@/lib/nodes/meta";
import type { Choice, Stage } from "@/lib/experiment/propagation";
import {
  FIELDS,
  buildConclusion,
  buildStages,
  changeWords,
  collectFindings,
  currentPlacement,
  dhDefault,
  inertValidators,
  loadSettings,
  optimizableKeys,
  parseNumber,
  runModel,
  saveSettings,
  showNum,
  stageDefault,
  suggestBudget,
  summarize,
  validatorAvailable,
  type ModelResult,
  type ParamEdits,
  type ParamsApi,
  type ReportProjectData,
  type StageDefault,
} from "./report-utils";
import { ConclusionSection, FindingsSection, HowToRead, SummarySection } from "./report-sections";
import { FormulasSection, RecommendationSection, type ModelControls } from "./report-model";

export type { ReportProjectData } from "./report-utils";

type Placement = Record<string, { validator: boolean; human: boolean }>;

const SECTIONS = [
  { id: "cara-baca", label: "Cara membaca" },
  { id: "ringkasan", label: "Ringkasan" },
  { id: "galat", label: "Galat & temuan" },
  { id: "rumus", label: "Rumus" },
  { id: "rekomendasi", label: "Rekomendasi" },
  { id: "kesimpulan", label: "Kesimpulan" },
] as const;

/** Urutan tetap untuk optimasi (tidak ikut berubah bila node digeser di canvas): urutan library, lalu kustom menurut nama. */
function canonicalOrder(a: string, b: string) {
  const ia = (NODE_KEYS as readonly string[]).indexOf(a);
  const ib = (NODE_KEYS as readonly string[]).indexOf(b);
  return (ia < 0 ? 1000 : ia) - (ib < 0 ? 1000 : ib) || a.localeCompare(b);
}

export function ReportPanel(props: {
  projectId: string;
  graph: WorkflowGraph;
  data: ReportProjectData;
  running: boolean;
  onApplyPlacement: (placement: Placement) => void;
  onSelectNode?: (engineKey: string) => void;
  onClose: () => void;
}) {
  const { projectId, graph, data, running, onClose } = props;
  const uid = useId();

  // ---------- Data run ----------
  const summary = useMemo(() => summarize(graph, data), [graph, data]);
  const findings = useMemo(() => collectFindings(graph, data), [graph, data]);

  // ---------- Angka model (disimpan per proyek) ----------
  // Profil parameter sesuai model AI canvas (LLM_MODEL di server); profil kosong → semua asumsi.
  const params = useApi<ParamsApi>("/api/experiments/parameters?model=default");
  const [saved] = useState(() => loadSettings(projectId));
  const [edits, setEdits] = useState<ParamEdits>(saved?.edits ?? {});
  const [dhStr, setDhStr] = useState<string | null>(saved?.dh ?? null);
  // null = pakai anggaran yang disarankan (dihitung dari angka model).
  const [bTokStr, setBTokStr] = useState<string | null>(saved?.bTok ?? null);
  const [bMinStr, setBMinStr] = useState<string | null>(saved?.bMin ?? null);
  useEffect(() => {
    saveSettings(projectId, { v: 1, edits, dh: dhStr, bTok: bTokStr, bMin: bMinStr });
  }, [projectId, edits, dhStr, bTokStr, bMinStr]);

  const keys = useMemo(() => [...optimizableKeys(graph)].sort(canonicalOrder), [graph]);
  const defaults = useMemo<Record<string, StageDefault>>(() => Object.fromEntries(keys.map((k) => [k, stageDefault(k, params.data)])), [keys, params.data]);
  const dhDef = dhDefault(params.data);
  const dhRaw = parseNumber(dhStr ?? showNum(dhDef.value, 2));
  const dhBad = !Number.isFinite(dhRaw) || dhRaw < 0 || dhRaw > 1;
  const dh = dhBad ? dhDef.value : dhRaw;
  const ready = !params.loading; // tunggu angka terukur agar rekomendasi tidak berubah di tengah jalan

  const stages = useMemo<Stage[]>(() => buildStages(keys, defaults, edits), [keys, defaults, edits]);
  // Anggaran disarankan ("titik siku"); dihitung ulang hanya bila angka model berubah.
  const suggestion = useMemo(() => (ready && stages.length ? suggestBudget(stages, dh) : null), [stages, dh, ready]);
  const bTok = bTokStr === null ? (suggestion?.tok ?? 0) : parseNumber(bTokStr);
  const bMin = bMinStr === null ? (suggestion?.min ?? 0) : parseNumber(bMinStr);
  const bad = {
    bTok: !Number.isFinite(bTok) || bTok < 0,
    bMin: !Number.isFinite(bMin) || bMin < 0,
    dh: dhBad,
  };
  const current = useMemo(() => currentPlacement(graph, keys), [graph, keys]);
  // Hitung ulang hanya bila angka/penempatan/anggaran benar-benar berubah (bukan saat node digeser).
  const sig = JSON.stringify([stages, current, dh, bad.bTok ? 0 : bTok, bad.bMin ? 0 : bMin]);
  const model = useMemo<ModelResult | null>(() => {
    if (!ready) return null;
    const [st, cur, d, bt, bm] = JSON.parse(sig) as [Stage[], Record<string, Choice>, number, number, number];
    if (!st.length) return null;
    return runModel(st, d, bt, bm, cur);
  }, [sig, ready]);

  const inert = useMemo(() => inertValidators(graph, keys), [graph, keys]);
  const changes = useMemo(
    () =>
      model
        ? model.stages.flatMap((s) => {
            const words = changeWords(labelOf(graph, s.key), model.current[s.key], model.rec[s.key]);
            // Canvas melepas validator yang tidak punya pemeriksaan saat analisis itu diubah — sebutkan agar tidak diam-diam.
            if (words.length && inert.includes(s.key)) words.push(`Lepas validator di ${labelOf(graph, s.key)} (analisis ini belum punya pemeriksaan otomatis)`);
            return words;
          })
        : [],
    [model, graph, inert],
  );

  // Jumlah angka model yang masih asumsi (dipakai di kesimpulan).
  const numberStats = useMemo(() => {
    let assumed = 0;
    let total = 0;
    for (const k of keys)
      for (const f of FIELDS) {
        if ((f === "dr" || f === "cTok") && !validatorAvailable(k)) continue;
        total++;
        if (defaults[k]?.[f].src.kind === "asumsi" && edits[k]?.[f] === undefined) assumed++;
      }
    return { assumed, total };
  }, [keys, defaults, edits]);

  const conclusion = useMemo(
    () =>
      buildConclusion({
        summary,
        findings,
        model,
        changes,
        assumedCount: numberStats.assumed,
        numberCount: numberStats.total,
        labelOf: (k) => labelOf(graph, k),
      }),
    [summary, findings, model, changes, numberStats, graph],
  );

  const controls: ModelControls = {
    keys,
    defaults,
    edits,
    setEdits,
    dhStr,
    setDhStr,
    dhDefault: dhDef,
    dh,
    bTokStr,
    setBTokStr,
    bMinStr,
    setBMinStr,
    suggestion,
    profile: params.data?.profile ?? null,
    bad,
    paramsLoading: params.loading,
    paramsError: params.error,
  };

  const go = (id: string) => document.getElementById(`${uid}-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const badgeOf: Record<string, ReactNode> = {
    galat: findings.totals.berat ? (
      <Badge tone="danger">{findings.totals.berat}</Badge>
    ) : findings.totals.sedang ? (
      <Badge tone="warn">{findings.totals.sedang}</Badge>
    ) : null,
    rekomendasi: changes.length ? <Badge tone="primary">{changes.length}</Badge> : null,
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-text">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-base font-semibold">Laporan run</h2>
          {running && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info" aria-live="polite">
              <span className="relative inline-flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-info" />
              </span>
              Sedang berjalan · angka diperbarui otomatis
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Tutup laporan" title="Tutup">
          ✕
        </Button>
      </header>

      <nav aria-label="Bagian laporan" className="flex gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
        {SECTIONS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => go(s.id)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            <span className="tabular-nums">{i + 1}.</span> {s.label}
            {badgeOf[s.id]}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-8 p-4">
          <Section id={`${uid}-cara-baca`} n={1} title="Cara membaca laporan ini">
            <HowToRead />
          </Section>
          <Section id={`${uid}-ringkasan`} n={2} title="Ringkasan run">
            <SummarySection graph={graph} data={data} summary={summary} running={running} onSelectNode={props.onSelectNode} />
          </Section>
          <Section id={`${uid}-galat`} n={3} title="Galat & temuan">
            <FindingsSection data={data} findings={findings} onSelectNode={props.onSelectNode} />
          </Section>
          <Section id={`${uid}-rumus`} n={4} title="Rumus yang dipakai">
            <FormulasSection graph={graph} data={data} model={model} />
          </Section>
          <Section id={`${uid}-rekomendasi`} n={5} title="Rekomendasi penempatan validator & tinjauan">
            <RecommendationSection
              graph={graph}
              data={data}
              running={running}
              model={model}
              changes={changes}
              inert={inert}
              controls={controls}
              onApply={props.onApplyPlacement}
            />
          </Section>
          <Section id={`${uid}-kesimpulan`} n={6} title="Kesimpulan">
            <ConclusionSection conclusion={conclusion} hasRun={!!data.runId} onSelectNode={props.onSelectNode} modelReady={!!model || !keys.length} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-2">
      <h3 className={cx("mb-3 flex items-baseline gap-2 border-b border-border pb-1.5 text-[15px] font-semibold")}>
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary tabular-nums">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}
