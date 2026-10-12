"use client";
// Panel node proses (bawaan & kustom): jalankan, lihat hasil sebagai sheet ala Excel (bisa diubah) + rumusnya,
// jawab pertanyaan AI, tinjau, pemeriksaan (validator/tinjauan yang tersambung), dan pengaturan node.
import { useMemo, useState } from "react";
import { PromptSection } from "./prompt-section";
import { Badge, Button, ErrorBox, Spinner, Textarea, cx } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { isCustomKey } from "@/lib/nodes/custom";
import type { CanvasWarning } from "@/lib/engine/canvas";
import { NodeOutputView } from "@/components/run/node-output";
import { PickContent, resolvePick } from "@/components/run/pick-panel";
import { itemIndexFrom } from "@/components/run/trace-utils";
import type { ChunkInfo, Picked } from "@/components/run/types";
import { NodeFormulas, NodeSheets } from "@/components/sheets/node-result";
import { formulasOf } from "@/components/sheets/node-sheets";
import { groupOf } from "@/lib/nodes/groups";
import { ReviewActions, checksOf } from "./check-panels";
import { ReviewIcon, ShieldIcon } from "./flow-nodes";
import { CustomSpecSection, NodeSettingsSection, Section } from "./node-settings";
import { keyResult, phaseLabel, statusInfo } from "./summary";
import type { FlowData, FlowPatch, NodeState, ProjectData, QuestionRow, RunState } from "./types";

export type RunMsg = { tone: "info" | "ok" | "warn" | "danger"; text: string } | null;

function QuestionItem({ q, onChanged }: { q: QuestionRow; onChanged: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agent-questions/${q.id}/answer`, { body: { answer } });
      setAnswer("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="rounded-md border border-border bg-surface p-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge tone="accent" className="font-mono">
          {q.label}
        </Badge>
        {q.answer ? <Badge tone="ok">terjawab</Badge> : <Badge tone="warn">belum dijawab</Badge>}
      </div>
      <p className="text-sm">{q.question}</p>
      {q.answer ? (
        <p className="mt-1.5 rounded bg-surface-2 px-2 py-1 text-sm">
          <span className="text-xs text-muted">Jawaban Anda: </span>
          {q.answer}
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Tulis jawaban sesuai kondisi organisasi…" className="min-h-16 w-full" />
          <ErrorBox error={error} />
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={answer.trim().length < 2}>
            Kirim jawaban
          </Button>
        </div>
      )}
    </li>
  );
}

const PURPOSE: Record<string, string> = { generate: "membuat hasil", validate: "pemeriksaan", repair: "perbaikan", judge: "penilaian" };

function TechDetails({ nodeKey, state }: { nodeKey: string; state?: NodeState }) {
  const checks = checksOf(nodeKey);
  const checkDesc = (name: string) => checks.find((c) => c.name === name)?.description ?? name;
  const validation = state?.validation ?? [];
  const attempts = [...new Set(validation.map((v) => v.attempt))].sort((a, b) => a - b);
  const tokens = Object.entries(state?.tokens ?? {});
  return (
    <Section title="Detail teknis" defaultOpen={false}>
      <div>
        <h4 className="mb-1 text-xs font-semibold text-muted">Riwayat pemeriksaan otomatis</h4>
        {attempts.length ? (
          <ul className="space-y-1 text-xs">
            {attempts.map((a) => {
              const evs = validation.filter((v) => v.attempt === a);
              const failed = evs.filter((v) => !v.passed);
              return (
                <li key={a}>
                  <span className={cx("font-medium", failed.length ? "text-danger" : "text-ok")}>
                    {a === 0 ? "Pemeriksaan awal" : `Setelah perbaikan ke-${a}`}: {failed.length ? `${failed.length} pemeriksaan gagal` : "semua lolos"}
                  </span>
                  {failed.map((f) => (
                    <div key={f.id} className="pl-3 text-muted">
                      • {checkDesc(f.checkName)}
                      {f.detail?.failures?.slice(0, 3).map((x, i) => (
                        <div key={i} className="pl-3">
                          – {x.itemId ? `[${x.itemId}] ` : ""}
                          {x.message}
                        </div>
                      ))}
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted">Belum ada.</p>
        )}
      </div>
      <div>
        <h4 className="mb-1 text-xs font-semibold text-muted">Pemakaian token AI</h4>
        {tokens.length ? (
          <p className="text-xs">
            {tokens.map(([k, v]) => `${PURPOSE[k] ?? k} ${fmt.int(v)}`).join(" · ")} · total <b>{fmt.int(tokens.reduce((s, [, v]) => s + v, 0))}</b>
          </p>
        ) : (
          <p className="text-xs text-muted">Belum ada.</p>
        )}
      </div>
    </Section>
  );
}

export type AttachedChecks = { validator: { id: string; label: string } | null; review: { id: string; label: string } | null };

function ChecksSection({
  checks,
  canValidate,
  onAdd,
  onRemove,
  onSelect,
}: {
  checks: AttachedChecks;
  canValidate: boolean;
  onAdd: (type: "validator" | "review") => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const rows = [
    {
      type: "validator" as const,
      icon: <ShieldIcon className="text-info" />,
      title: "Validator otomatis",
      desc: canValidate ? "Memeriksa kutipan & rujukan; bila salah, AI memperbaiki." : "Tidak diperlukan — analisis ini dihitung sistem.",
      el: checks.validator,
      add: "Tambah validator",
      disabled: !canValidate,
    },
    {
      type: "review" as const,
      icon: <ReviewIcon className="text-warn" />,
      title: "Tinjauan manusia",
      desc: "Run berhenti sampai Anda menyetujui hasil ini.",
      el: checks.review,
      add: "Tambah tinjauan",
      disabled: false,
    },
  ];
  return (
    <Section title="Pemeriksaan" defaultOpen>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.type} className="flex items-start gap-2">
            <span className="mt-0.5">{r.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {r.title}
                {r.el ? <Badge tone="ok">terpasang</Badge> : <Badge>tidak ada</Badge>}
              </div>
              <p className="text-[11px] text-muted">{r.desc}</p>
            </div>
            {r.el ? (
              <span className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" onClick={() => onSelect(r.el!.id)}>
                  Buka
                </Button>
                <Button size="sm" variant="danger" onClick={() => onRemove(r.el!.id)}>
                  Lepas
                </Button>
              </span>
            ) : (
              <Button size="sm" onClick={() => onAdd(r.type)} disabled={r.disabled} className="shrink-0">
                {r.add}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted">Pemeriksaan tampil sebagai elemen di canvas yang tersambung panah dari proses ini. Berlaku saat analisis dijalankan berikutnya.</p>
    </Section>
  );
}

export function ProcessPanel({
  nodeId,
  nodeKey: key,
  label,
  defaultLabel,
  parents,
  staleFrom = [],
  labelOf,
  checks,
  data,
  all,
  warnings,
  runState,
  runMsg,
  canResume,
  onRun,
  onRerun,
  onStop,
  onResume,
  onAddMissing,
  onAddCheck,
  onRemoveNode,
  onSelect,
  onChange,
  onChanged,
  onOpenCalc,
  wide,
}: {
  nodeId: string;
  /** Kunci mesin: node_key bawaan atau "custom_<id>". */
  nodeKey: string;
  label: string;
  defaultLabel: string;
  /** Nama analisis yang hasilnya dibaca node ini (lewat panah / dependensi). */
  parents: string[];
  /** Nama analisis hulu yang diubah manusia setelah analisis ini selesai (angka sudah dihitung ulang). */
  staleFrom?: string[];
  /** Nama tampilan analisis lain menurut kunci (rujukan rumus antar-sheet). */
  labelOf?: (key: string) => string;
  checks: AttachedChecks;
  data: FlowData;
  all: ProjectData;
  warnings: CanvasWarning[];
  runState: RunState | null;
  runMsg: RunMsg;
  canResume: boolean;
  onRun: (key: string) => void;
  onRerun: (key: string) => void;
  onStop: () => void;
  onResume: () => void;
  onAddMissing: (nodeId: string) => void;
  onAddCheck: (type: "validator" | "review") => void;
  onRemoveNode: (id: string) => void;
  onSelect: (id: string) => void;
  onChange: (patch: FlowPatch) => void;
  onChanged: () => Promise<void> | void;
  /** Buka panel "Perhitungan" (seluruh alur angka). */
  onOpenCalc?: () => void;
  wide: boolean;
}) {
  const custom = isCustomKey(key);
  const meta = custom ? null : NODE_META[key as NodeKey];
  const state = all.nodes[key];
  const running = !!runState;
  const status = runState?.current === key ? "running" : state?.status;
  const info = statusInfo(status);
  const [picked, setPicked] = useState<Picked | null>(null);

  const outputs = useMemo(() => Object.fromEntries(Object.entries(all.nodes).map(([k, v]) => [k, v.output])), [all.nodes]);
  const index = useMemo(() => itemIndexFrom(outputs), [outputs]);
  const chunks = useMemo(() => {
    const m = new Map<string, ChunkInfo>();
    for (const n of Object.values(all.nodes)) for (const e of n.evidence ?? []) if (!m.has(e.id)) m.set(e.id, e);
    return m;
  }, [all.nodes]);
  const lookup = (id: string) => chunks.get(id);
  const textOf = (id: string) => index.get(id)?.text;
  const questions = all.questions.filter((q) => q.nodeKey === key);
  const open = questions.filter((q) => !q.answer).length;
  const missing = warnings.find((w) => w.missing?.length);
  const blocking = warnings.find((w) => !w.missing?.length);
  const hasOutput = state?.output !== null && state?.output !== undefined;
  const done = state?.status === "done";
  const result = hasOutput ? keyResult(key, state!.output) : null;
  const description = custom ? data.custom?.instruction?.trim() || "Proses buatan Anda — isi nama dan instruksinya di bawah." : meta?.description;
  const group = meta && meta.group !== "custom" ? groupOf(meta.group) : null;
  const hasFormulas = !custom && formulasOf(key).length > 0;
  const stale = done && staleFrom.length > 0;

  if (!custom && !meta) return <ErrorBox error={`Analisis tidak dikenal: ${data.key}`} />;

  if (picked) {
    const { text } = resolvePick({ picked, index });
    return (
      <div className="space-y-3">
        <button type="button" onClick={() => setPicked(null)} className="text-sm font-medium text-primary hover:underline">
          ← Kembali ke {label}
        </button>
        <div>
          <div className="font-mono text-sm font-semibold">{picked.id}</div>
          {text && <p className="mt-0.5 text-sm">{text}</p>}
        </div>
        <PickContent picked={picked} index={index} lookup={lookup} labelOf={labelOf} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{label}</h2>
          {custom && <Badge tone="accent">kustom</Badge>}
          {group && (
            <Badge tone="primary" title={`${group.label} — tab Excel ${meta?.sheetName ?? ""}`} className="font-mono">
              {group.code}
            </Badge>
          )}
          <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", info.cls)}>
            {status === "running" && <Spinner className="size-2.5" />}
            {status === "running" ? `${phaseLabel(state?.status === "running" ? state.phase : null)}…` : info.label}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-3 text-sm text-muted" title={description}>
          {description}
        </p>
        {group && (
          <p className="mt-0.5 text-[11px] text-muted">
            {group.label} · tab Excel <span className="font-mono">{meta?.sheetName}</span>
          </p>
        )}
        {result && <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm font-semibold tabular-nums">{result}</p>}
      </div>

      {stale && (
        <div className="space-y-2 rounded-md border border-warn/40 bg-warn-soft/70 px-3 py-2 text-sm text-warn">
          <p>
            Angka di analisis ini sudah dihitung ulang dari perubahan di <b>{staleFrom.join(", ")}</b>. Isi teks dari AI mungkin perlu dijalankan ulang.
          </p>
          <Button size="sm" onClick={() => onRerun(key)} disabled={running || !!missing || !!blocking}>
            Jalankan ulang analisis ini
          </Button>
        </div>
      )}

      {missing && (
        <div className="flex items-center gap-2 rounded-md border border-warn/30 bg-warn-soft/60 px-3 py-2 text-sm text-warn">
          <span className="flex-1">{missing.message}.</span>
          <Button size="sm" onClick={() => onAddMissing(nodeId)}>
            Tambahkan
          </Button>
        </div>
      )}
      {blocking && <div className="rounded-md border border-warn/30 bg-warn-soft/60 px-3 py-2 text-sm text-warn">{blocking.message}.</div>}

      {custom && <CustomSpecSection data={data} parents={parents} onChange={onChange} />}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <span className="flex items-center gap-2 text-sm text-info">
                <Spinner /> {runState.label ?? "Analisis"} · {phaseLabel(runState.phase)}…
                {runState.total > 1 && (
                  <span className="text-muted">
                    ({Math.min(runState.step, runState.total)}/{runState.total})
                  </span>
                )}
              </span>
              <Button size="sm" onClick={onStop}>
                Hentikan
              </Button>
            </>
          ) : done || state?.status === "failed" ? (
            <Button variant={done ? "secondary" : "primary"} onClick={() => onRerun(key)} disabled={!!missing || !!blocking}>
              {done ? "Jalankan ulang" : "Coba lagi"}
            </Button>
          ) : state?.status === "needs_review" ? null : (
            <Button variant="primary" onClick={() => onRun(key)} disabled={!!missing || !!blocking}>
              Jalankan
            </Button>
          )}
          {!running && canResume && state?.status !== "needs_review" && (
            <Button variant="primary" onClick={onResume}>
              Lanjutkan run
            </Button>
          )}
          {!running && !done && state?.status !== "needs_review" && parents.length > 0 && (
            <span className="text-[11px] text-muted">Analisis sebelumnya ikut dijalankan bila belum selesai.</span>
          )}
        </div>
        {runMsg && (
          <div
            className={cx(
              "rounded-md px-3 py-2 text-sm",
              { info: "bg-info-soft text-info", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger" }[runMsg.tone],
            )}
          >
            {runMsg.text}
          </div>
        )}
        {state?.status === "failed" && state.error && <ErrorBox error={`Analisis gagal: ${state.error}`} />}
      </div>

      {state?.status === "needs_review" && (
        <div className="space-y-2 rounded-lg border-2 border-warn/60 bg-warn-soft/60 p-3">
          <p className="text-sm font-semibold text-warn">Menunggu tinjauan Anda — periksa hasil di bawah sebelum analisis berikutnya dijalankan.</p>
          <ReviewActions state={state} label={label} onChanged={onChanged} onRejected={() => onRun(key)} />
        </div>
      )}

      {open > 0 && (
        <div className="rounded-md bg-accent/10 px-3 py-2 text-sm text-accent">
          AI punya {open} pertanyaan untuk Anda — lihat di bagian bawah.
        </div>
      )}

      {hasOutput && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Hasil</h3>
            {onOpenCalc && (
              <button type="button" onClick={onOpenCalc} className="text-[12px] font-medium text-primary hover:underline" title="Buka panel Perhitungan: seluruh alur angka dari awal sampai akhir">
                Lihat seluruh alur perhitungan →
              </button>
            )}
          </div>
          {custom ? (
            <>
              <p className="text-[11px] text-muted">Klik ID (mis. K1) untuk melihat bukti dari dokumen.</p>
              <NodeOutputView nodeKey={key} output={state!.output} onPick={setPicked} textOf={textOf} />
              {!wide && isTableOutput(state!.output) && <p className="text-[11px] text-muted">Tabel terpotong? Klik “Perlebar” di atas panel.</p>}
            </>
          ) : (
            <>
              <p className="text-[11px] text-muted">
                Tabel mengikuti tab Excel framework. Klik sel untuk melihat rumus, penjelasan, dan alasan AI.
                {state?.status === "done" || state?.status === "needs_review" ? " Angka/isi usulan AI bisa Anda ubah — angka lain dihitung ulang otomatis." : ""}
              </p>
              <NodeSheets nodeKey={key} label={label} state={state!} outputs={outputs} editable={!running} labelOf={labelOf} onSaved={onChanged} />
            </>
          )}
        </section>
      )}
      {hasFormulas && (
        <Section title="Rumus" defaultOpen={!hasOutput}>
          <p className="text-[11px] text-muted">Rumus yang dipakai analisis ini — sama dengan rumus di tab Excel {meta?.sheetName}.</p>
          <NodeFormulas nodeKey={key} />
        </Section>
      )}
      {!hasOutput && !running && state?.status !== "failed" && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
          Belum ada hasil. Klik <b>Jalankan</b> — hasil{custom ? "" : " (tabel ala Excel lengkap dengan penjelasan angkanya)"} muncul di sini.
        </p>
      )}

      {questions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Pertanyaan dari AI</h3>
          <p className="text-[11px] text-muted">
            AI bertanya karena tidak menemukan bukti di dokumen. Setelah menjawab, klik <b>Jalankan ulang</b> agar jawaban dipakai.
          </p>
          <ul className="space-y-2">
            {questions.map((q) => (
              <QuestionItem key={q.id} q={q} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}

      <ChecksSection checks={checks} canValidate={custom || !!meta?.hasValidator} onAdd={onAddCheck} onRemove={onRemoveNode} onSelect={onSelect} />
      <NodeSettingsSection data={data} defaultLabel={defaultLabel} done={done} onChange={onChange} />
      <PromptSection nodeRunId={state?.nodeRunId} />
      <TechDetails nodeKey={key} state={state} />
    </div>
  );
}

/** Output proses kustom berbentuk tabel. */
const isTableOutput = (o: unknown) => !!o && typeof o === "object" && Array.isArray((o as { columns?: unknown }).columns) && (o as { columns: unknown[] }).columns.length > 0;
