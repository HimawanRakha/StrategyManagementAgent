"use client";
// Panel elemen pemeriksaan (validator otomatis, tinjauan manusia) dan catatan.
import { useEffect, useRef, useState } from "react";
import { Badge, Button, ErrorBox, Field, Input, Spinner, Textarea, cx } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { genericCustomDef, isCustomKey } from "@/lib/nodes/custom";
import type { ValidatorRule } from "@/lib/db/schema";
import { ruleLabel } from "@/lib/validators/rules";
import type { CanvasWarning } from "@/lib/engine/canvas";
import { NodeOutputView } from "@/components/run/node-output";
import { NodeSheets } from "@/components/sheets/node-result";
import type { CheckTarget } from "./flow-nodes";
import { patchSettings } from "./node-settings";
import { phaseLabel, statusInfo } from "./summary";
import type { FlowData, FlowPatch, NodeState, ProjectData, RunState, ValidationRow } from "./types";

/** Daftar pemeriksaan untuk sebuah analisis (bawaan atau kustom). */
export function checksOf(key: string) {
  if (isCustomKey(key)) return genericCustomDef(key).checks;
  return NODE_META[key as NodeKey]?.checks ?? [];
}

function Warnings({ warnings }: { warnings: CanvasWarning[] }) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-md border border-warn/30 bg-warn-soft/60 px-3 py-2 text-sm text-warn">
      {warnings.map((w, i) => (
        <div key={i}>{w.message}.</div>
      ))}
    </div>
  );
}

function TargetLine({ verb, target, onSelect }: { verb: string; target: CheckTarget | null; onSelect: (nodeId: string) => void }) {
  if (!target)
    return (
      <p className="rounded-md border border-dashed border-warn/50 px-3 py-2 text-sm text-warn">
        Belum tersambung. Tarik panah dari titik kanan sebuah node proses ke elemen ini.
      </p>
    );
  return (
    <p className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
      <span className="text-muted">{verb}</span>
      <button type="button" onClick={() => onSelect(target.nodeId)} className="font-semibold text-primary hover:underline">
        {target.label}
      </button>
    </p>
  );
}

// ===== Validator =====
/** Penjelasan ramah untuk pemeriksaan bawaan: apa yang dicek dan mengapa. */
const CHECK_INFO: Record<string, { what: string; why: string }> = {
  quote_exists: { what: "Kutipan benar-benar ada di dokumen", why: "mencegah AI mengarang kutipan." },
  quote_supports: { what: "Kutipan memang mendukung isi butir", why: "mencegah kutipan yang ada tetapi tidak nyambung dengan klaimnya." },
  trace_complete: { what: "Rantai rujukan setiap elemen sampai ke kutipan dokumen atau jawaban Anda", why: "setiap rekomendasi bisa ditelusuri asal-usulnya." },
  grounded: { what: "Setiap butir punya dasar: kutipan dokumen (atau rujukan ke analisis sebelumnya bila diizinkan)", why: "mencegah butir tanpa dasar." },
  ref_exists: { what: "ID yang dirujuk benar-benar ada di analisis sebelumnya", why: "mencegah rujukan karangan." },
  follows_instruction: { what: "Setiap butir sesuai instruksi Anda", why: "memastikan AI mengerjakan yang diminta." },
  table_shape: { what: "Bentuk tabel: kolom persis seperti yang Anda tentukan dan setiap baris mengisi semua kolom", why: "bentuk tabel jadi terjamin." },
};

const RULE_KINDS: { kind: ValidatorRule["kind"]; label: string; who: "ai" | "code"; hint: string }[] = [
  { kind: "ai", label: "Aturan bebas (dinilai AI)", who: "ai", hint: "Tulis aturan dengan kalimat biasa." },
  { kind: "contains", label: "Wajib memuat kata", who: "code", hint: "Setiap butir wajib memuat salah satu kata ini (pisahkan dengan koma)." },
  { kind: "not_contains", label: "Tidak boleh memuat kata", who: "code", hint: "Tidak boleh ada butir yang memuat kata ini (pisahkan dengan koma)." },
  { kind: "measurable", label: "Setiap butir memuat angka/ukuran", who: "code", hint: "Mis. persentase, jumlah, atau target angka." },
  { kind: "min_items", label: "Jumlah butir minimal", who: "code", hint: "Hasil ditolak bila butirnya kurang dari angka ini." },
  { kind: "max_items", label: "Jumlah butir maksimal", who: "code", hint: "Hasil ditolak bila butirnya lebih dari angka ini." },
];
const MAX_RULES = 20;
const RULE_PRESETS: { label: string; rule: Omit<ValidatorRule, "id"> }[] = [
  { label: "Setiap butir menyebut penanggung jawab", rule: { kind: "ai", text: "Setiap butir menyebut penanggung jawab (divisi atau jabatan)" } },
  { label: "Maksimal 8 butir", rule: { kind: "max_items", value: 8 } },
  { label: "Tidak boleh memuat kata: mungkin, sepertinya", rule: { kind: "not_contains", text: "mungkin, sepertinya" } },
  { label: "Setiap butir memuat target angka", rule: { kind: "measurable" } },
];
const newRule = (r: Omit<ValidatorRule, "id">): ValidatorRule => ({ id: crypto.randomUUID(), ...r });

function KindBadge({ who }: { who: "ai" | "code" }) {
  return (
    <Badge tone={who === "ai" ? "accent" : "neutral"} title={who === "ai" ? "Dinilai AI — memakai token" : "Dicek sistem — pasti dan gratis"}>
      {who === "ai" ? "dinilai AI (memakai token)" : "dicek sistem (pasti, gratis)"}
    </Badge>
  );
}

function RuleRow({ rule, onChange, onRemove }: { rule: ValidatorRule; onChange: (r: ValidatorRule) => void; onRemove: () => void }) {
  const k = RULE_KINDS.find((x) => x.kind === rule.kind) ?? RULE_KINDS[0];
  const on = rule.enabled !== false;
  return (
    <li className={cx("space-y-1.5 rounded-md border px-2.5 py-2", on ? "border-border bg-surface" : "border-dashed border-border bg-surface-2/60")}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={on}
          onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          aria-label="Aktifkan aturan"
          title={on ? "Aktif — klik untuk menonaktifkan" : "Nonaktif — klik untuk mengaktifkan"}
        />
        <span className={cx("min-w-0 flex-1 text-[13px] font-medium", !on && "text-muted")}>{k.label}</span>
        <KindBadge who={k.who} />
        <button type="button" onClick={onRemove} className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-danger-soft" aria-label="Hapus aturan" title="Hapus aturan">
          ✕
        </button>
      </div>
      {rule.kind === "ai" && (
        <Textarea
          value={rule.text ?? ""}
          maxLength={600}
          onChange={(e) => onChange({ ...rule, text: e.target.value })}
          placeholder="mis. Setiap strategi menyebut divisi penanggung jawab"
          className="min-h-14 w-full text-[13px]"
          disabled={!on}
        />
      )}
      {(rule.kind === "contains" || rule.kind === "not_contains") && (
        <Input
          value={rule.text ?? ""}
          maxLength={600}
          onChange={(e) => onChange({ ...rule, text: e.target.value })}
          placeholder={rule.kind === "contains" ? "mis. staf, anggota, kampus" : "mis. mungkin, sepertinya"}
          className="h-8 w-full text-[13px]"
          disabled={!on}
        />
      )}
      {(rule.kind === "min_items" || rule.kind === "max_items") && (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted">{rule.kind === "min_items" ? "Minimal" : "Maksimal"}</span>
          <Input
            type="number"
            min={0}
            max={200}
            value={rule.value ?? ""}
            onChange={(e) => onChange({ ...rule, value: e.target.value === "" ? undefined : Math.max(0, Math.min(200, Math.round(Number(e.target.value)))) })}
            className="h-8 w-20 tabular-nums"
            disabled={!on}
            aria-label="Jumlah butir"
          />
          <span className="text-muted">butir</span>
        </div>
      )}
      <p className="text-[11px] text-muted">{k.hint}</p>
    </li>
  );
}

function RulesSection({ rules, onChange }: { rules: ValidatorRule[]; onChange: (rules: ValidatorRule[]) => void }) {
  const [picking, setPicking] = useState(false);
  const full = rules.length >= MAX_RULES;
  const add = (r: Omit<ValidatorRule, "id">) => {
    if (full) return;
    onChange([...rules, newRule(r)]);
    setPicking(false);
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Aturan pemeriksaan Anda</h3>
        {rules.length > 0 && <Badge tone="primary">{rules.filter((r) => r.enabled !== false).length} aktif</Badge>}
      </div>
      <p className="text-[11.5px] text-muted">
        Tambahkan syarat sendiri. <b className="text-text">Aturan AI</b> juga disampaikan ke AI sebelum menulis, lalu diperiksa setelahnya.{" "}
        <b className="text-text">Aturan kata dan jumlah</b> dicek sistem. Bila ada yang dilanggar, AI diminta memperbaiki.
      </p>
      {rules.length > 0 && (
        <ul className="space-y-1.5">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} onChange={(nr) => onChange(rules.map((x) => (x.id === r.id ? nr : x)))} onRemove={() => onChange(rules.filter((x) => x.id !== r.id))} />
          ))}
        </ul>
      )}
      {picking ? (
        <div className="space-y-1 rounded-md border border-primary/30 bg-primary-soft/30 p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Pilih jenis aturan</span>
            <button type="button" onClick={() => setPicking(false)} className="text-xs text-muted hover:text-text">
              Batal
            </button>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {RULE_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => add(k.kind === "min_items" ? { kind: k.kind, value: 3 } : k.kind === "max_items" ? { kind: k.kind, value: 8 } : { kind: k.kind, text: "" })}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-left hover:border-primary"
              >
                <span className="block text-[12.5px] font-medium">{k.label}</span>
                <span className="block text-[10.5px] text-muted">{k.who === "ai" ? "dinilai AI" : "dicek sistem"}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => setPicking(true)} disabled={full}>
          + Tambah aturan
        </Button>
      )}
      {full && <p className="text-[11px] text-muted">Paling banyak {MAX_RULES} aturan.</p>}
      <div className="space-y-1">
        <span className="text-[11px] text-muted">Contoh (klik untuk menambahkan):</span>
        <div className="flex flex-wrap gap-1.5">
          {RULE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={full}
              onClick={() => add(p.rule)}
              className="rounded-full border border-primary/30 bg-surface px-2.5 py-1 text-[11.5px] text-primary hover:bg-primary-soft disabled:opacity-40"
            >
              + {p.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted">Aturan berlaku saat proses dijalankan (ulang).</p>
    </section>
  );
}

export function ValidatorPanel({
  data,
  target,
  all,
  warnings,
  runState,
  onChange,
  onSelect,
}: {
  data: FlowData;
  target: CheckTarget | null;
  all: ProjectData;
  warnings: CanvasWarning[];
  runState: RunState | null;
  onChange: (patch: FlowPatch) => void;
  onSelect: (nodeId: string) => void;
}) {
  const key = target?.key ?? null;
  const st = key ? all.nodes[key] : undefined;
  const checks = key ? checksOf(key) : [];
  const computed = !!key && !isCustomKey(key) && NODE_META[key as NodeKey] && !NODE_META[key as NodeKey].hasValidator;
  const disabled = new Set(data.settings?.disabledChecks ?? []);
  const rules = data.settings?.rules ?? [];
  const maxRepair = data.settings?.maxRepair ?? 2;
  const live = !!key && runState?.current === key && st?.status === "running" && (st.phase === "validate" || st.phase === "repair");
  const validation = st?.validation ?? [];
  const attempts = [...new Set(validation.map((v) => v.attempt))].sort((a, b) => a - b);
  const nameOf = (v: ValidationRow) => {
    if (v.checkName.startsWith("aturan:")) {
      if (v.detail?.label) return v.detail.label;
      const r = rules.find((x) => `aturan:${x.id}` === v.checkName);
      return r ? ruleLabel(r) : "Aturan Anda (sudah dihapus)";
    }
    return CHECK_INFO[v.checkName]?.what ?? checks.find((c) => c.name === v.checkName)?.description ?? v.checkName;
  };
  /** Satu baris per pemeriksaan dalam satu percobaan (catatan ganda: yang terakhir dipakai). */
  const eventsOf = (a: number) => [...new Map(validation.filter((v) => v.attempt === a).map((v) => [v.checkName, v])).values()];
  const lastEvs = attempts.length ? eventsOf(attempts[attempts.length - 1]) : [];

  function toggle(name: string, on: boolean) {
    const next = new Set(disabled);
    if (on) next.delete(name);
    else next.add(name);
    onChange(patchSettings("disabledChecks", [...next]));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-info">Validator otomatis</h2>
        <p className="mt-0.5 text-sm text-muted">
          Hasil AI dari proses yang panahnya masuk ke sini diperiksa otomatis. Bila ada yang salah, AI diminta memperbaikinya. Anda bisa memilih pemeriksaan bawaan dan
          menambah aturan sendiri.
        </p>
      </div>
      <Warnings warnings={warnings} />
      <TargetLine verb="Memeriksa:" target={target} onSelect={onSelect} />

      {live && (
        <div className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-sm font-medium text-info">
          <Spinner /> {phaseLabel(st?.phase)}…
        </div>
      )}

      {key && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Hasil pemeriksaan terakhir</h3>
            {st?.validationPassed === true ? (
              <Badge tone="ok">Lolos</Badge>
            ) : st?.validationPassed === false ? (
              <Badge tone="danger">Tidak lolos</Badge>
            ) : null}
            {lastEvs.length > 0 && (
              <span className="text-[11.5px] text-muted">
                {lastEvs.filter((v) => v.passed).length} dari {lastEvs.length} pemeriksaan lolos
                {attempts.length > 1 ? " (percobaan terakhir)" : ""}
              </span>
            )}
          </div>
          {attempts.length ? (
            <ol className="space-y-2">
              {attempts.map((a, ai) => {
                const evs = eventsOf(a);
                const failed = evs.filter((v) => !v.passed).length;
                const isLast = ai === attempts.length - 1;
                return (
                  <li key={a} className={cx("rounded-md border p-2", failed ? "border-danger/25" : "border-ok/25")}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold">
                        Percobaan {ai + 1}
                        {a > 0 && <span className="font-normal text-muted"> (setelah perbaikan)</span>}
                      </span>
                      <span className={cx("font-medium", failed ? "text-danger" : "text-ok")}>
                        {evs.length - failed} dari {evs.length} lolos
                      </span>
                      {failed > 0 && !isLast && <span className="text-muted">→ AI memperbaiki</span>}
                    </div>
                    <ul className="space-y-1 text-[12.5px]">
                      {evs.map((v) => {
                        const fails = v.detail?.failures ?? [];
                        return (
                          <li key={v.id}>
                            <div className="flex items-start gap-1.5">
                              <span className={cx("w-4 shrink-0 font-bold", v.passed ? "text-ok" : "text-danger")}>{v.passed ? "✓" : "✗"}</span>
                              <span className={cx("min-w-0 flex-1", v.passed && "text-muted")}>
                                {nameOf(v)}
                                {(v.detail?.kind === "llm" || v.checkName.startsWith("aturan:")) && (
                                  <span className="ml-1 text-[10.5px] text-muted">{v.detail?.kind === "llm" ? "· dinilai AI" : "· aturan Anda"}</span>
                                )}
                              </span>
                            </div>
                            {!v.passed && fails.length > 0 && (
                              <ul className="mt-0.5 space-y-0.5 pl-5 text-[11.5px] text-muted">
                                {fails.slice(0, 6).map((f, i) => (
                                  <li key={i} className="flex items-start gap-1">
                                    <span aria-hidden>–</span>
                                    <span className="min-w-0">
                                      {f.itemId && target && (
                                        <button
                                          type="button"
                                          onClick={() => onSelect(target.nodeId)}
                                          className="mr-1 rounded border border-primary/30 bg-primary-soft px-1 font-mono text-[10.5px] font-semibold text-primary hover:border-primary"
                                          title={`Buka ${target.label}`}
                                        >
                                          {f.itemId}
                                        </button>
                                      )}
                                      {f.itemId && f.message.startsWith(f.itemId) ? f.message.slice(f.itemId.length).trimStart() : f.message}
                                    </span>
                                  </li>
                                ))}
                                {fails.length > 6 && <li className="pl-3">… dan {fails.length - 6} lagi</li>}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted">Belum ada hasil — jalankan prosesnya.</p>
          )}
        </section>
      )}

      {key && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Pemeriksaan bawaan</h3>
          {computed ? (
            <p className="text-sm text-muted">
              {NODE_META[key as NodeKey]?.kind === "code"
                ? "Analisis ini dihitung oleh sistem (bukan AI), jadi tidak ada yang perlu diperiksa."
                : "Analisis ini belum punya pemeriksaan bawaan."}
            </p>
          ) : checks.length ? (
            <>
              <p className="text-[11px] text-muted">Hilangkan centang untuk melewati satu pemeriksaan.</p>
              <ul className="space-y-1.5">
                {checks.map((c) => {
                  const info = CHECK_INFO[c.name];
                  const on = !disabled.has(c.name);
                  return (
                    <li key={c.name}>
                      <label className={cx("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2", on ? "border-border" : "border-dashed border-border bg-surface-2/60")}>
                        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={on} onChange={(e) => toggle(c.name, e.target.checked)} />
                        <span className="min-w-0 flex-1 text-[13px]">
                          <span className={cx("font-medium", !on && "text-muted")}>{info?.what ?? c.description}</span>
                          {info && <span className="text-muted"> — {info.why}</span>}
                          <span className="mt-1 block">
                            <KindBadge who={c.kind === "llm" ? "ai" : "code"} />
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted">Tidak ada pemeriksaan bawaan untuk analisis ini.</p>
          )}
          {disabled.size > 0 && <p className="text-[11px] text-muted">{disabled.size} pemeriksaan dimatikan — tidak dicek pada run berikutnya.</p>}
        </section>
      )}

      {key && !computed && <RulesSection rules={rules} onChange={(next) => onChange(patchSettings("rules", next))} />}

      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">Batas percobaan perbaikan</span>
        <div className="flex rounded-md border border-border p-0.5 text-xs" role="radiogroup">
          {[0, 1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={maxRepair === n}
              onClick={() => onChange(patchSettings("maxRepair", n === 2 ? undefined : n))}
              className={cx("flex-1 rounded px-2 py-1 tabular-nums", maxRepair === n ? "bg-info-soft font-semibold text-info" : "text-muted hover:text-text")}
            >
              {n}
              {n === 2 && <span className="font-normal"> (bawaan)</span>}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted">{maxRepair === 0 ? "Hanya memeriksa, tanpa meminta AI memperbaiki." : `AI boleh memperbaiki hasilnya sampai ${maxRepair} kali.`}</p>
      </div>

      <Field label="Nama elemen (opsional)">
        <Input value={data.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} placeholder="Validator otomatis" />
      </Field>
      <p className="text-[11px] text-muted">Perubahan berlaku saat analisis dijalankan (ulang).</p>
    </div>
  );
}

// ===== Tinjauan manusia =====
/**
 * Tombol Setujui / Tolak yang selalu tampil. Aktif bila proses sudah punya hasil (perlu ditinjau atau selesai).
 * Waktu tinjauan mulai dicatat otomatis saat komponen ini tampil dengan hasil yang belum ditinjau.
 */
export function ReviewActions({
  state,
  label,
  onChanged,
  onRejected,
}: {
  state: NodeState | undefined;
  label: string;
  onChanged: () => Promise<void> | void;
  /** Jalankan ulang analisisnya (otomatis setelah menolak hasil yang menahan run; atau lewat tombol Jalankan). */
  onRejected: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [rejectedDone, setRejectedDone] = useState(false);
  const status = state?.status;
  const waiting = status === "needs_review";
  const reviewable = waiting || status === "done";
  // Keputusan lama (sebelum hasil ini dibuat ulang) tidak berlaku untuk hasil sekarang.
  const last = state?.review ?? null;
  const stale = !!last?.endedAt && !!state?.startedAt && +new Date(last.endedAt) < +new Date(state.startedAt);
  const rv = stale ? null : last;
  const open = !!rv && !rv.endedAt;

  // Mulai catat waktu tinjauan sekali saat hasil yang belum ditinjau ditampilkan.
  const startedFor = useRef<string | null>(null);
  const nodeRunId = state?.nodeRunId;
  const resultId = nodeRunId ? `${nodeRunId}:${state?.startedAt ?? ""}` : null;
  const shouldStart = reviewable && !rv;
  useEffect(() => {
    if (!shouldStart || !nodeRunId || !resultId || startedFor.current === resultId) return;
    startedFor.current = resultId;
    api(`/api/node-runs/${nodeRunId}/review`, { body: { action: "start" } })
      .then(() => onChanged())
      .catch(() => {});
  }, [shouldStart, nodeRunId, resultId, onChanged]);

  async function act(action: "approve" | "reject") {
    if (!state) return;
    setBusy(action);
    setError(null);
    try {
      const n = note.trim();
      await api(`/api/node-runs/${state.nodeRunId}/review`, { body: { action, ...(n ? { note: n } : {}) } });
      setConfirming(false);
      setNote("");
      await onChanged();
      if (action === "reject") {
        if (waiting) onRejected();
        else setRejectedDone(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (rejectedDone && !reviewable)
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface-2/60 px-3 py-2">
        <p className="text-sm">Hasil dikosongkan — klik Jalankan untuk menjalankan ulang. Alasan Anda dipakai AI pada percobaan berikutnya.</p>
        <Button size="sm" variant="primary" onClick={onRejected}>
          Jalankan
        </Button>
      </div>
    );

  return (
    <div className="space-y-2">
      {rv?.endedAt ? (
        rv.approved ? (
          <p className="text-sm font-medium text-ok">Disetujui ✓ pada {fmt.date(rv.endedAt)}</p>
        ) : (
          <p className="text-sm font-medium text-danger">Ditolak pada {fmt.date(rv.endedAt)}</p>
        )
      ) : open ? (
        <p className="text-[11.5px] text-muted">Mulai ditinjau {fmt.date(rv!.startedAt)}. Baca hasilnya, lalu putuskan.</p>
      ) : null}
      {reviewable && (
        <Field label="Alasan / catatan (dikirim ke AI bila ditolak)">
          <Textarea
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="mis. Faktor W2 tidak sesuai kondisi; fokuskan pada keuangan"
            className="min-h-14 w-full"
          />
        </Field>
      )}
      {confirming ? (
        <div className="space-y-2 rounded-md border border-danger/30 bg-danger-soft/60 px-3 py-2">
          <p className="text-sm text-danger">
            Tolak hasil {label}? {waiting ? "Hasil dikosongkan lalu analisis dijalankan ulang" : "Hasil ini dan analisis sesudahnya dikosongkan"}
            {note.trim() ? " — alasan Anda dikirim ke AI." : "."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => act("reject")} loading={busy === "reject"}>
              Ya, tolak
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={!!busy}>
              Batal
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => act("approve")} loading={busy === "approve"} disabled={!reviewable || !!busy}>
            ✓ Setujui
          </Button>
          <Button variant="danger" onClick={() => setConfirming(true)} disabled={!reviewable || !!busy}>
            ✗ Tolak
          </Button>
          {!reviewable && <span className="text-[11.5px] text-muted">Tombol aktif setelah prosesnya selesai dijalankan.</span>}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

const duration = (a: string, b: string) => {
  const s = Math.max(0, Math.round((+new Date(b) - +new Date(a)) / 1000));
  return s < 60 ? `${s} detik` : `${Math.floor(s / 60)} menit ${s % 60} detik`;
};

export function ReviewPanel({
  data,
  target,
  all,
  warnings,
  canResume,
  onChange,
  onChanged,
  onRejected,
  onResume,
  onSelect,
}: {
  data: FlowData;
  target: CheckTarget | null;
  all: ProjectData;
  warnings: CanvasWarning[];
  canResume: boolean;
  onChange: (patch: FlowPatch) => void;
  onChanged: () => Promise<void> | void;
  onRejected: (key: string) => void;
  onResume: () => void;
  onSelect: (nodeId: string) => void;
}) {
  const key = target?.key ?? null;
  const st = key ? all.nodes[key] : undefined;
  const waiting = st?.status === "needs_review";
  const reviewable = waiting || st?.status === "done";
  const rv = st?.review ?? null;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-warn">Tinjauan manusia</h2>
        <p className="mt-0.5 text-sm text-muted">
          Setelah proses yang panahnya masuk ke sini selesai, run berhenti sampai Anda menyetujui hasilnya. Hasil yang sudah selesai juga bisa ditinjau kapan saja.
        </p>
      </div>
      <Warnings warnings={warnings} />
      <TargetLine verb="Meninjau:" target={target} onSelect={onSelect} />

      {key && target && (
        <section className={cx("space-y-3 rounded-lg p-3", waiting ? "border-2 border-warn/60 bg-warn-soft/50" : "border border-border")}>
          <div className="flex items-center gap-2">
            {waiting && (
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex size-2.5 rounded-full bg-warn" />
              </span>
            )}
            <span className={cx("text-sm font-semibold", waiting ? "text-warn" : "text-text")}>
              {waiting ? "Menunggu tinjauan Anda" : reviewable ? "Hasil siap ditinjau" : "Belum ada hasil"}
            </span>
            <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", statusInfo(st?.status).cls)}>{statusInfo(st?.status).label}</span>
          </div>
          {reviewable && st ? (
            <>
              {isCustomKey(target.key) ? (
                <div className="max-h-96 overflow-auto rounded-md border border-border bg-surface p-2">
                  <NodeOutputView nodeKey={target.key} output={st.output} />
                </div>
              ) : (
                <NodeSheets
                  nodeKey={target.key}
                  label={target.label}
                  state={st}
                  outputs={Object.fromEntries(Object.entries(all.nodes).map(([k, v]) => [k, v.output]))}
                  editable
                  onSaved={onChanged}
                  maxHeight="50vh"
                />
              )}
              <p className="text-[11px] text-muted">
                {isCustomKey(target.key)
                  ? `Butuh bukti lengkap? Buka node ${target.label} untuk mengklik ID dan melihat kutipan dokumennya.`
                  : "Klik sel untuk melihat rumus dan alasan AI. Angka yang kurang tepat bisa Anda ubah dulu sebelum menyetujui."}
              </p>
            </>
          ) : (
            <p className="text-[12px] text-muted">Saat analisis ini selesai, hasilnya muncul di sini untuk Anda setujui atau tolak.</p>
          )}
          <ReviewActions key={st?.nodeRunId ?? "none"} state={st} label={target.label} onChanged={onChanged} onRejected={() => onRejected(target.key)} />
        </section>
      )}

      {canResume && !waiting && (
        <div className="flex items-center gap-2 rounded-md border border-ok/30 bg-ok-soft/60 px-3 py-2">
          <span className="flex-1 text-sm text-ok">Disetujui. Run sebelumnya berhenti di sini.</span>
          <Button size="sm" variant="primary" onClick={onResume}>
            Lanjutkan run
          </Button>
        </div>
      )}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Riwayat tinjauan</h3>
        {rv ? (
          <div className="rounded-md border border-border px-3 py-2 text-[12.5px]">
            <div>
              Mulai: <b>{fmt.date(rv.startedAt)}</b>
            </div>
            {rv.endedAt ? (
              <>
                <div>
                  Selesai: <b>{fmt.date(rv.endedAt)}</b> · lama {duration(rv.startedAt, rv.endedAt)}
                </div>
                <div>
                  Keputusan: {rv.approved ? <Badge tone="ok">disetujui</Badge> : <Badge tone="danger">ditolak</Badge>}
                </div>
              </>
            ) : (
              <div className="text-warn">Sedang ditinjau…</div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">Belum ada.</p>
        )}
        <p className="text-[11px] text-muted">Waktu tinjauan dicatat otomatis (sejak panel ini dibuka) untuk optimasi.</p>
      </section>

      <Field label="Nama elemen (opsional)">
        <Input value={data.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} placeholder="Tinjauan" />
      </Field>
    </div>
  );
}

// ===== Catatan =====
export function NotePanel({ data, onChange }: { data: FlowData; onChange: (patch: FlowPatch) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Catatan</h2>
        <p className="mt-0.5 text-sm text-muted">Catatan bebas untuk Anda sendiri. Tidak dijalankan dan tidak dibaca AI.</p>
      </div>
      <Field label="Judul">
        <Input value={data.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} placeholder="Catatan" />
      </Field>
      <Field label="Isi catatan">
        <Textarea value={data.text ?? ""} maxLength={5000} onChange={(e) => onChange({ text: e.target.value })} placeholder="Tulis catatan Anda…" className="min-h-48 w-full bg-[#fffbe0]" />
      </Field>
    </div>
  );
}
