"use client";
// Bagian laporan: 4 Rumus · 5 Rekomendasi penempatan (anggaran, hasil, perubahan dalam kata-kata, tabel angka model, kurva).
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Button, Empty, Table, cx } from "@/components/ui";
import { CHART_AXIS, CHART_GRID, PlacementChip, PlacementLegend, SERIES } from "@/components/experiments/shared";
import { fmt } from "@/lib/client/api";
import type { WorkflowGraph } from "@/lib/db/schema";
import { labelOf } from "@/lib/engine/canvas";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { ASSUMED, FEW_DATA_N, MIN_N_USE, MIN_REVIEW_SEC } from "@/lib/experiment/assumptions";
import {
  CURVE_MINUTES,
  FIELDS,
  FIELD_INFO,
  cellOf,
  observedOfRun,
  parseNumber,
  placementToApply,
  reportKeys,
  residualError,
  sameChoice,
  showNum,
  validatorAvailable,
  type Field,
  type ModelResult,
  type ParamEdits,
  type ReportProjectData,
  type Source,
  type StageDefault,
  type StageParam,
} from "./report-utils";
import { Term } from "./report-sections";

type Placement = Record<string, { validator: boolean; human: boolean }>;

export type ModelControls = {
  keys: string[];
  defaults: Record<string, StageDefault>;
  edits: ParamEdits;
  setEdits: Dispatch<SetStateAction<ParamEdits>>;
  dhStr: string | null;
  setDhStr: (v: string | null) => void;
  dhDefault: StageParam;
  dh: number;
  /** null = pakai anggaran yang disarankan. */
  bTokStr: string | null;
  setBTokStr: (v: string | null) => void;
  bMinStr: string | null;
  setBMinStr: (v: string | null) => void;
  /** Anggaran disarankan ("titik siku") dari angka model. */
  suggestion: { tok: number; min: number; p: number; pMax: number } | null;
  /** Profil parameter (model AI yang datanya dipakai). */
  profile: { model: string | null; projectName?: string | null; runs: number; measuredAt: string | null } | null;
  bad: { bTok: boolean; bMin: boolean; dh: boolean };
  paramsLoading: boolean;
  paramsError: string | null;
};

const pct1 = (x: number) => fmt.pct(x, 1);
const pp = (x: number) => `${x >= 0 ? "+" : "−"}${fmt.num(Math.abs(x) * 100, 1)} poin`;
const n3 = (x: number) => showNum(x, 3);

/** Rumus dengan huruf miring dan subskrip. */
function Formula({ children }: { children: ReactNode }) {
  return <div className="my-1 overflow-x-auto rounded bg-surface-2 px-2.5 py-1.5 font-serif text-[14px] italic leading-relaxed whitespace-nowrap">{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// 4. Rumus

export function FormulasSection({ graph, data, model }: { graph: WorkflowGraph; data: ReportProjectData; model: ModelResult | null }) {
  const { rowKeys } = reportKeys(graph, data);
  const withF = rowKeys.filter((k) => (NODE_META[k as NodeKey]?.formulas ?? []).length > 0);
  const without = rowKeys.filter((k) => !withF.includes(k));

  // Contoh hitung dengan angka sebenarnya: analisis pertama yang berubah, atau yang diperiksa, atau yang pertama.
  const ex = model
    ? (model.stages.find((s) => !sameChoice(model.current[s.key], model.rec[s.key])) ??
      model.stages.find((s) => model.rec[s.key]?.validator || model.rec[s.key]?.human) ??
      model.stages[0])
    : null;
  const exC = ex && model ? model.rec[ex.key] : null;

  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <div className="space-y-2">
        <h4 className="font-semibold">A. Model peluang bebas galat (dipakai bagian Rekomendasi)</h4>
        <p>
          <b>(1) Peluang galat yang tersisa</b> di analisis ke-<i>i</i> setelah pemeriksaan:
        </p>
        <Formula>
          e<sub>i</sub>′ = e<sub>i</sub> × (1 − x<sub>i</sub> · d<sub>i</sub>
          <sup>r</sup>) × (1 − y<sub>i</sub> · d<sup>h</sup>)
        </Formula>
        <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
          <li>
            <i>
              e<sub>i</sub>
            </i>{" "}
            = peluang AI keliru di analisis itu bila tidak diperiksa.
          </li>
          <li>
            <i>
              x<sub>i</sub>
            </i>{" "}
            = 1 bila validator dipasang, 0 bila tidak.{" "}
            <i>
              y<sub>i</sub>
            </i>{" "}
            = 1 bila tinjauan manusia dipasang, 0 bila tidak.
          </li>
          <li>
            <i>
              d<sub>i</sub>
              <sup>r</sup>
            </i>{" "}
            = d<sub>i</sub> × r<sub>i</sub> = peluang validator <u>menemukan</u> kekeliruan (d) dikali peluang <u>berhasil memperbaikinya</u> (r).
          </li>
          <li>
            <i>
              d<sup>h</sup>
            </i>{" "}
            = ketelitian peninjau manusia: peluang kekeliruan tertangkap saat ditinjau.
          </li>
        </ul>
        <p>
          <b>(2) Peluang seluruh hasil bebas galat</b> = semua analisis harus benar, jadi peluangnya dikalikan:
        </p>
        <Formula>
          P(bebas galat) = Π<sub>i</sub> (1 − e<sub>i</sub>′) = (1 − e<sub>1</sub>′) × (1 − e<sub>2</sub>′) × …
        </Formula>
        <p>
          <b>(3) Batas biaya</b>: token validator dan menit tinjauan yang terpakai tidak boleh melebihi anggaran.
        </p>
        <Formula>
          Σ<sub>i</sub> x<sub>i</sub> · c<sub>i</sub>
          <sup>tok</sup> ≤ B<sub>tok</sub> &nbsp;&nbsp;dan&nbsp;&nbsp; Σ<sub>i</sub> y<sub>i</sub> · c<sub>i</sub>
          <sup>min</sup> ≤ B<sub>min</sub>
        </Formula>
        <p className="text-[13px]">
          <b>(4) Optimasi</b>: pilih <i>x</i> dan <i>y</i> untuk setiap analisis agar <i>P</i> sebesar mungkin tanpa melewati batas (3). Bila ada beberapa
          pilihan yang sama baiknya, dipilih yang pemeriksaannya paling sedikit dan paling murah. Dengan ≤ 8 analisis semua 4ⁿ kombinasi dicoba; lebih dari
          itu dipakai pemrograman dinamis (biaya dibulatkan ke atas sedikit, jadi hasilnya selalu muat anggaran). Hasilnya selalu sama untuk angka dan
          anggaran yang sama.
        </p>
        {model && ex && exC && (
          <div className="rounded-md border border-border px-3 py-2 text-[13px]">
            <div className="mb-1 text-xs font-semibold text-muted">Contoh dengan angka laporan ini — {labelOf(graph, ex.key)} (pilihan rekomendasi)</div>
            <Formula>
              e′ = {n3(ex.e)} × (1 − {exC.validator ? 1 : 0} × {n3(ex.dr)}) × (1 − {exC.human ? 1 : 0} × {n3(model.dh)}) ={" "}
              {n3(residualError(ex, exC, model.dh))}
            </Formula>
            <Formula>
              P = {model.stages
                .slice(0, 3)
                .map((s) => `(1 − ${n3(residualError(s, model.rec[s.key], model.dh))})`)
                .join(" × ")}
              {model.stages.length > 3 ? ` × … (${model.stages.length} analisis)` : ""} = {pct1(model.pRec)}
            </Formula>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="font-semibold">B. Rumus di dalam setiap analisis</h4>
        <p className="text-[13px] text-muted">
          Rumus hitungan yang dipakai tiap analisis (sama dengan rumus di file Excel framework). Klik nama analisis untuk membuka.
        </p>
        {withF.length === 0 ? (
          <p className="text-[13px] text-muted">Belum ada analisis dengan rumus terdaftar di canvas ini.</p>
        ) : (
          <div className="space-y-1">
            {withF.map((k) => {
              const fs = NODE_META[k as NodeKey].formulas;
              return (
                <details key={k} className="rounded-md border border-border">
                  <summary className="cursor-pointer px-3 py-1.5 text-[13px] font-medium">
                    {labelOf(graph, k)} <span className="font-normal text-muted">— {fs.length} rumus</span>
                  </summary>
                  <ul className="space-y-2 border-t border-border px-3 py-2">
                    {fs.map((f, i) => (
                      <li key={i} className="text-[13px]">
                        <div className="font-medium">{f.name}</div>
                        <div className="my-0.5 overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-[12px] whitespace-pre-wrap">{f.rumus}</div>
                        <div className="text-muted">{f.arti}</div>
                        {f.excel && <div className="mt-0.5 font-mono text-[11px] text-muted">Excel: {f.excel}</div>}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
        {without.length > 0 && (
          <p className="text-[12px] text-muted">
            Tanpa rumus hitungan (isinya disusun AI atau belum terdaftar): {without.map((k) => labelOf(graph, k)).join(", ")}.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Rekomendasi penempatan

export function RecommendationSection({
  graph,
  data,
  running,
  model,
  changes,
  inert,
  controls: c,
  onApply,
}: {
  graph: WorkflowGraph;
  data: ReportProjectData;
  running: boolean;
  model: ModelResult | null;
  changes: string[];
  /** Analisis dengan elemen validator di canvas tetapi tanpa pemeriksaan otomatis. */
  inert: string[];
  controls: ModelControls;
  onApply: (p: Placement) => void;
}) {
  const [applied, setApplied] = useState<string | null>(null);
  if (!c.keys.length) return <Empty>Tambahkan analisis ke canvas dulu, lalu buka bagian ini lagi.</Empty>;
  const budgetOk = !c.bad.bTok && !c.bad.bMin;
  const sug = c.suggestion;
  const bTokVal = c.bTokStr === null ? (sug?.tok ?? 0) : parseNumber(c.bTokStr);
  const bMinVal = c.bMinStr === null ? (sug?.min ?? 0) : parseNumber(c.bMinStr);
  const usingSuggestion = c.bTokStr === null && c.bMinStr === null;

  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-1.5 leading-relaxed">
        <p>
          Setiap analisis punya peluang keliru. <Term>Validator</Term> dan <Term>tinjauan manusia</Term> bisa menangkap kekeliruan itu, tetapi memakan token
          AI dan waktu pengurus. Bagian ini mencari letak validator dan tinjauan yang membuat <Term>peluang seluruh hasil bebas galat</Term> setinggi mungkin
          tanpa melewati anggaran Anda.
        </p>
        <p className="text-[13px] text-muted">
          Angka model <b>tidak</b> bergantung pada letak validator/tinjauan sekarang, dan perubahan Anda di bawah disimpan di browser ini untuk proyek ini —
          jadi rekomendasi tetap sama setiap kali laporan dibuka, sampai Anda mengubah angka/anggaran atau ada data eksperimen baru.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <NumField
          label={
            <>
              Anggaran token pemeriksaan (B<sub>tok</sub>)
            </>
          }
          hint={c.bTokStr === null ? "disarankan otomatis (titik siku)" : "diubah Anda"}
          value={c.bTokStr ?? (sug ? String(sug.tok) : "")}
          bad={c.bad.bTok}
          onChange={c.setBTokStr}
          suffix="token"
        />
        <NumField
          label={
            <>
              Anggaran waktu tinjauan (B<sub>min</sub>)
            </>
          }
          hint={c.bMinStr === null ? "disarankan otomatis (titik siku)" : "diubah Anda"}
          value={c.bMinStr ?? (sug ? String(sug.min) : "")}
          bad={c.bad.bMin}
          onChange={c.setBMinStr}
          suffix="menit"
        />
        <NumField
          label={
            <>
              Ketelitian peninjau (d<sup>h</sup>)
            </>
          }
          hint={c.dhStr === null ? `${c.dhDefault.src.kind === "pengaturan" ? "dari pengaturan eksperimen" : "asumsi"} · 0,85 = menangkap 85% galat` : "diubah Anda · 0–1"}
          value={c.dhStr ?? showNum(c.dhDefault.value, 2)}
          bad={c.bad.dh}
          onChange={c.setDhStr}
        />
      </div>

      {sug && (
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <span>
            Anggaran disarankan: <b className="text-text">{fmt.num(sug.tok / 1000, 0)} rb token + {fmt.num(sug.min, 0)} menit</b> (P {pct1(sug.p)}) — anggaran
            termurah yang sudah mencapai ≥ 95% dari peluang tertinggi ({pct1(sug.pMax)}) pada kisi 0–100 rb token × 0–30 menit.
          </span>
          {!usingSuggestion && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                c.setBTokStr(null);
                c.setBMinStr(null);
              }}
            >
              Pakai saran
            </Button>
          )}
        </div>
      )}

      {!model ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          {c.paramsLoading ? "Memuat angka terukur dari eksperimen… rekomendasi muncul setelah semua angka siap." : "Belum ada analisis untuk dihitung."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ResultBox
              title="Penempatan sekarang"
              p={model.pCur}
              ci={model.ciCur}
              tok={model.costCur.tok}
              min={model.costCur.min}
              note={model.overBudget ? <span className="text-warn">Melebihi anggaran yang Anda tetapkan.</span> : undefined}
            />
            <ResultBox
              title="Rekomendasi"
              highlight
              p={model.pRec}
              ci={model.ciRec}
              tok={model.costRec.tok}
              min={model.costRec.min}
              note={<span className={model.pRec - model.pCur >= 0 ? "text-ok" : "text-warn"}>{pp(model.pRec - model.pCur)} dibanding sekarang</span>}
            />
          </div>
          <p className="-mt-3 text-[11px] text-muted">
            Tanpa pemeriksaan sama sekali: {pct1(model.pNone)}.{" "}
            {model.method === "semua" ? "Dihitung dengan mencoba semua kombinasi." : "Dihitung dengan pemrograman dinamis."}
            {model.keptCurrent && " Penempatan sekarang dipertahankan karena hasil hitungan tidak lebih baik."}
          </p>

          <div className="rounded-md border border-primary/30 bg-primary-soft/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-semibold">Apa yang disarankan</h4>
              <Button
                variant="primary"
                size="sm"
                disabled={!changes.length || running || !budgetOk}
                title={running ? "Tunggu run selesai sebelum mengubah canvas" : !changes.length ? "Canvas sudah sesuai rekomendasi" : undefined}
                onClick={() => {
                  onApply(placementToApply(model) as Placement);
                  setApplied(`${changes.length} perubahan diterapkan ke canvas. Jalankan ulang analisis agar pemeriksaan baru ikut berlaku.`);
                }}
              >
                Terapkan ke canvas
              </Button>
            </div>
            {changes.length ? (
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[13px]">
                {changes.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-[13px] text-muted">Penempatan sekarang sudah yang terbaik untuk anggaran ini — tidak ada yang perlu diubah.</p>
            )}
            {applied && <p className="mt-1.5 text-xs text-ok">{applied}</p>}
          </div>

          <div>
            <h4 className="mb-2 font-semibold">Perbandingan per analisis</h4>
            <Table head={["Analisis", "Sekarang", "Rekomendasi", "Peluang galat tersisa"]}>
              {model.stages.map((s) => {
                const cur = model.current[s.key];
                const rec = model.rec[s.key];
                const changed = !sameChoice(cur, rec);
                const eCur = residualError(s, cur, model.dh);
                const eRec = residualError(s, rec, model.dh);
                return (
                  <tr key={s.key} className={cx(changed && "bg-primary-soft/60")}>
                    <td className="font-medium">
                      {labelOf(graph, s.key)}
                      {changed && <span className="ml-1.5 text-[11px] font-normal text-primary">berubah</span>}
                    </td>
                    <td>
                      <PlacementChip c={cur} />
                    </td>
                    <td>
                      <PlacementChip c={rec} />
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      {pct1(eCur)}
                      {changed && <span className="text-muted"> → {pct1(eRec)}</span>}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <PlacementLegend className="mt-1.5" />
            {inert.length > 0 && (
              <p className="text-[11px] text-warn">
                Validator terpasang di canvas tetapi belum berfungsi (analisisnya belum punya pemeriksaan otomatis):{" "}
                {inert.map((k) => labelOf(graph, k)).join(", ")}. Di tabel ini dihitung sebagai tanpa validator.
              </p>
            )}
            <p className="text-[11px] text-muted">Kompilasi grand design tidak ikut dihitung (hanya menyusun dokumen dari hasil analisis lain).</p>
          </div>
        </>
      )}

      <ParamTable graph={graph} data={data} c={c} />

      {model && <QualityCurveMini curve={model.curve} current={model.pCur} bTok={budgetOk ? bTokVal : 0} bMin={budgetOk ? bMinVal : null} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tabel "Angka yang dipakai model"

function ParamTable({ graph, data, c }: { graph: WorkflowGraph; data: ReportProjectData; c: ModelControls }) {
  const setEdit = (k: string, f: Field, v: string) => c.setEdits((e) => ({ ...e, [k]: { ...e[k], [f]: v } }));
  const observed = Object.fromEntries(c.keys.map((k) => [k, observedOfRun(data.nodes[k])]));
  const applyObserved = (only?: string) =>
    c.setEdits((e) => {
      const next: ParamEdits = { ...e };
      for (const k of only ? [only] : c.keys) {
        const o = observed[k];
        const row = { ...next[k] };
        if (o.cTok !== null && validatorAvailable(k)) row.cTok = String(Math.round(o.cTok));
        if (o.cMin !== null) row.cMin = showNum(o.cMin, 1);
        if (Object.keys(row).length) next[k] = row;
      }
      return next;
    });
  const anyObserved = c.keys.some((k) => (observed[k].cTok !== null && validatorAvailable(k)) || observed[k].cMin !== null);
  const anyEdit = Object.keys(c.edits).length > 0 || c.dhStr !== null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Angka yang dipakai model</h4>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {c.paramsLoading && <span>Memuat angka terukur…</span>}
          {anyObserved && (
            <Button size="sm" variant="secondary" onClick={() => applyObserved()} title="Isi token validator dan menit tinjauan dengan angka yang teramati di run ini">
              Pakai angka teramati
            </Button>
          )}
          {anyEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                c.setEdits({});
                c.setDhStr(null);
              }}
            >
              Kembalikan nilai awal
            </Button>
          )}
        </div>
      </div>

      <dl className="mb-2 grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border border-border bg-surface-2/60 px-3 py-2 text-[12px] sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f}>
            <dt className="inline font-semibold">
              <Sym f={f} /> {FIELD_INFO[f].name}:
            </dt>{" "}
            <dd className="inline text-muted">{FIELD_INFO[f].meaning}.</dd>
          </div>
        ))}
        <div>
          <dt className="inline font-semibold">
            d<sup>h</sup> Ketelitian peninjau:
          </dt>{" "}
          <dd className="inline text-muted">
            {showNum(c.dh, 2)} ({c.dhStr !== null ? "diubah Anda" : c.dhDefault.src.kind === "pengaturan" ? "dari pengaturan eksperimen" : "asumsi"}), sama untuk semua analisis.
          </dd>
        </div>
      </dl>

      <p className="mb-2 text-[12px] text-muted">
        {c.profile && c.profile.runs > 0 ? (
          <>
            Profil: <b className="text-text">{c.profile.projectName ?? "proyek ini"}</b>
            {c.profile.model ? <> · {c.profile.model}</> : null} · {c.profile.runs} run{c.profile.measuredAt ? ` · diukur ${c.profile.measuredAt}` : ""}. Angka terukur
            hanya diambil dari run proyek ini dengan model ini — data proyek lain tidak ikut.
          </>
        ) : c.profile ? (
          <span className="text-warn">
            Profil: {c.profile.projectName ?? "proyek ini"}
            {c.profile.model ? ` · ${c.profile.model}` : ""} · belum ada run untuk proyek dan model ini — semua angka memakai asumsi, jadi rekomendasi hanya{" "}
            <b>perkiraan kasar</b>.
          </span>
        ) : null}
      </p>

      {!c.paramsLoading && <MeasuredSummary c={c} />}

      {c.paramsError && (
        <p className="mb-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          Angka terukur dari eksperimen belum bisa dimuat ({c.paramsError}); semua angka memakai asumsi.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-2 text-left text-[11px] text-muted">
            <tr>
              <th className="border-b border-border px-3 py-2 font-medium">Analisis</th>
              {FIELDS.map((f) => (
                <th key={f} className="border-b border-border px-2 py-2 font-medium" title={FIELD_INFO[f].meaning}>
                  <Sym f={f} /> <span className="font-normal">{FIELD_INFO[f].name.toLowerCase()}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.keys.map((k) => {
              const d = c.defaults[k];
              const hasVal = validatorAvailable(k);
              const o = observed[k];
              return (
                <tr key={k} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 align-top font-medium">{labelOf(graph, k)}</td>
                  {FIELDS.map((f) => {
                    if (!hasVal && (f === "dr" || f === "cTok"))
                      return (
                        <td key={f} className="px-2 py-2 align-top text-[11px] text-muted">
                          analisis ini belum punya validator
                        </td>
                      );
                    const cell = cellOf(d, c.edits, k, f);
                    const obs = f === "cTok" ? o.cTok : f === "cMin" ? o.cMin : null;
                    const isAssumed = !c.paramsLoading && !cell.edited && d[f].src.kind === "asumsi";
                    return (
                      <td key={f} className="px-2 py-2 align-top">
                        <input
                          inputMode="decimal"
                          aria-label={`${labelOf(graph, k)}: ${FIELD_INFO[f].name}`}
                          value={cell.text}
                          onChange={(e) => setEdit(k, f, e.target.value)}
                          className={cx(
                            "h-7 w-20 rounded border bg-surface px-1.5 text-right text-sm tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/15",
                            cell.bad ? "border-danger" : isAssumed ? "border-warn/60 bg-warn-soft/40" : "border-border",
                          )}
                        />
                        <SourceTag src={d[f].src} edited={cell.edited} bad={cell.bad} loading={c.paramsLoading} />
                        {obs !== null && (
                          <div className="mt-0.5 text-[10px] text-muted">
                            teramati di run: {f === "cTok" ? fmt.int(obs) : showNum(obs, 1)}{" "}
                            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setEdit(k, f, f === "cTok" ? String(Math.round(obs)) : showNum(obs, 1))}>
                              pakai
                            </button>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        Asal angka: <b className="text-ok">terukur</b> = dihitung dari eksperimen (n = jumlah data; peluang dipakai bila n ≥ {MIN_N_USE}, dengan
        rentang keyakinan 95%; dʳ diambil dari run sungguhan bila cukup data, selain itu dari uji sisip; tinjauan di bawah {MIN_REVIEW_SEC} detik
        tidak dihitung sebagai menit tinjauan; e = 0 dari kurang dari {FEW_DATA_N} data diberi tanda <i>data sedikit</i>);{" "}
        <b className="text-warn">asumsi</b> = angka awal tetap (e = {showNum(ASSUMED.e, 2)}, dʳ = {showNum(ASSUMED.dr, 2)}, c_tok = {fmt.int(ASSUMED.cTok)}{" "}
        token, c_min = {ASSUMED.cMin} menit, analisis yang dihitung program e = {showNum(ASSUMED.eCode, 2)}); <b className="text-primary">diubah Anda</b> =
        angka yang Anda ketik (disimpan untuk proyek ini). <b>Teramati di run</b> hanya informasi dari run terakhir — dipakai model hanya bila Anda menekan
        &ldquo;pakai&rdquo;, karena angka satu run bisa berubah-ubah.
      </p>
      <Link href="/experiments" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
        Ukur angka sungguhan di menu Eksperimen →
      </Link>
    </div>
  );
}

/** "N dari M angka terisi otomatis dari eksperimen; sisanya asumsi" (angka yang diketik pengguna dihitung terpisah). */
function MeasuredSummary({ c }: { c: ModelControls }) {
  let measured = 0;
  let assumed = 0;
  let edited = 0;
  for (const k of c.keys)
    for (const f of FIELDS) {
      if (!validatorAvailable(k) && (f === "dr" || f === "cTok")) continue;
      if (c.edits[k]?.[f] !== undefined) edited++;
      else if (c.defaults[k]?.[f].src.kind === "terukur") measured++;
      else if (c.defaults[k]?.[f].src.kind === "asumsi") assumed++;
    }
  const total = measured + assumed + edited;
  return (
    <p className="mb-2 text-[12px]">
      <b className="text-ok">{measured}</b> dari {total} angka terisi otomatis dari hasil eksperimen;{" "}
      <b className="text-warn">{assumed}</b> masih <b>asumsi</b> (kolom kuning — alasannya ditulis di bawah angkanya)
      {edited ? (
        <>
          ; <b className="text-primary">{edited}</b> diubah Anda
        </>
      ) : null}
      .
    </p>
  );
}

function Sym({ f }: { f: Field }) {
  if (f === "e")
    return (
      <i>
        e<sub>i</sub>
      </i>
    );
  if (f === "dr")
    return (
      <i>
        d<sub>i</sub>
        <sup>r</sup>
      </i>
    );
  if (f === "cTok")
    return (
      <i>
        c<sub>i</sub>
        <sup>tok</sup>
      </i>
    );
  return (
    <i>
      c<sub>i</sub>
      <sup>min</sup>
    </i>
  );
}

function SourceTag({ src, edited, bad, loading }: { src: Source; edited: boolean; bad: boolean; loading?: boolean }) {
  if (bad) return <div className="mt-0.5 text-[10px] text-danger">isi angka yang valid</div>;
  if (edited) return <div className="mt-0.5 text-[10px] text-primary">diubah Anda</div>;
  if (loading) return <div className="mt-0.5 text-[10px] text-muted">memuat…</div>;
  if (src.kind === "terukur")
    return (
      <div className="mt-0.5 text-[10px] text-ok">
        terukur{src.via ? ` · ${src.via}` : ""} (n={src.n})
        {src.lo !== undefined && src.hi !== undefined && (
          <span className="text-muted">
            {" "}
            · 95%: {showNum(src.lo, 2)}–{showNum(src.hi, 2)}
          </span>
        )}
        {src.few && <div className="text-warn">data sedikit</div>}
        {src.note && <div className="text-muted">{src.note}</div>}
      </div>
    );
  if (src.kind === "asumsi")
    return (
      <div className="mt-0.5 max-w-[11rem] text-[10px] leading-tight text-warn" title={src.why}>
        <b>asumsi</b> — belum terukur{src.reason ? `: ${src.reason}` : ""}
      </div>
    );
  return null;
}

function NumField({ label, hint, value, bad, onChange, suffix }: { label: ReactNode; hint: ReactNode; value: string; bad: boolean; onChange: (v: string) => void; suffix?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cx(
            "h-9 w-full min-w-0 rounded-md border bg-surface px-2.5 text-sm tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/15",
            bad ? "border-danger" : "border-border",
          )}
        />
        {suffix && <span className="shrink-0 text-xs text-muted">{suffix}</span>}
      </span>
      <span className={cx("text-[11px]", bad ? "text-danger" : "text-muted")}>{bad ? "Isi angka yang valid" : hint}</span>
    </label>
  );
}

function ResultBox({
  title,
  p,
  ci,
  tok,
  min,
  note,
  highlight,
}: {
  title: string;
  p: number;
  ci?: { lo: number; hi: number };
  tok: number;
  min: number;
  note?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={cx("rounded-md border px-3 py-2.5", highlight ? "border-primary/40 bg-primary-soft" : "border-border bg-surface")}>
      <div className="text-[11px] font-medium text-muted">{title}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums">{pct1(p)}</span>
        <span className="text-[11px] text-muted">peluang seluruh hasil bebas galat</span>
      </div>
      {ci && (
        <div className="text-[11px] tabular-nums text-muted" title="Rentang dari ketidakpastian angka keliru (eᵢ) yang terukur, disimulasikan 5.000 kali">
          95% yakin antara {fmt.pct(ci.lo, 0)}–{fmt.pct(ci.hi, 0)}
        </div>
      )}
      <div className="mt-1 text-xs tabular-nums text-muted">
        biaya {fmt.int(tok)} token · {fmt.num(min, 1)} menit
      </div>
      {note && <div className="mt-1 text-xs">{note}</div>}
    </div>
  );
}

function QualityCurveMini({ curve, current, bTok, bMin }: { curve: { minutes: number; p: number }[]; current: number; bTok: number; bMin: number | null }) {
  const lo = Math.min(current, ...curve.map((c) => c.p));
  const yMin = Math.max(0, Math.floor((lo - 0.02) * 20) / 20);
  const color = SERIES[0];
  return (
    <div>
      <h4 className="font-semibold">Kurva kualitas vs anggaran waktu</h4>
      <p className="mb-2 text-xs text-muted">
        Peluang bebas galat terbaik bila waktu tinjauan ditambah, dengan anggaran token tetap {fmt.int(bTok)}. Garis putus-putus = penempatan sekarang.
      </p>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={curve} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={CHART_GRID} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="minutes"
              type="number"
              domain={[0, CURVE_MINUTES[CURVE_MINUTES.length - 1]]}
              ticks={CURVE_MINUTES}
              tick={{ fontSize: 11, fill: CHART_AXIS }}
              stroke={CHART_GRID}
              tickFormatter={(v: number) => `${v} mnt`}
              height={24}
            />
            <YAxis domain={[yMin, 1]} tick={{ fontSize: 11, fill: CHART_AXIS }} stroke={CHART_GRID} tickFormatter={(v: number) => fmt.pct(v)} width={44} />
            <ReferenceLine y={current} stroke={CHART_AXIS} strokeDasharray="4 3" strokeWidth={1} />
            {bMin !== null && bMin <= CURVE_MINUTES[CURVE_MINUTES.length - 1] && <ReferenceLine x={bMin} stroke={CHART_GRID} strokeWidth={1} />}
            <Tooltip
              cursor={{ stroke: CHART_AXIS, strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs shadow-sm">
                    <div className="font-medium">{label} menit tinjauan</div>
                    <div className="tabular-nums text-muted">
                      bebas galat <span className="font-medium text-text">{fmt.pct(Number(payload[0].value), 1)}</span>
                    </div>
                  </div>
                ) : null
              }
            />
            <Line
              type="linear"
              dataKey="p"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={{ r: 4, fill: color, stroke: "#ffffff", strokeWidth: 2 }}
              activeDot={{ r: 5, stroke: "#ffffff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <tbody>
            <tr className="text-muted">
              <th className="pr-2 text-left font-medium">Menit</th>
              {curve.map((x) => (
                <td key={x.minutes} className="px-1 text-right">
                  {x.minutes}
                </td>
              ))}
            </tr>
            <tr>
              <th className="pr-2 text-left font-medium text-muted">Bebas galat</th>
              {curve.map((x) => (
                <td key={x.minutes} className="px-1 text-right">
                  {pct1(x.p)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <Badge className="mt-1">perkiraan model</Badge>
    </div>
  );
}
