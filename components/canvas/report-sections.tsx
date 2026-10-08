"use client";
// Bagian laporan: 1 Cara membaca · 2 Ringkasan run · 3 Galat & temuan · 6 Kesimpulan.
import { Fragment, useState, type ReactNode } from "react";
import { Badge, Empty, Stat, StatusBadge, Table, cx } from "@/components/ui";
import { fmt } from "@/lib/client/api";
import type { WorkflowGraph } from "@/lib/db/schema";
import { labelOf } from "@/lib/engine/canvas";
import {
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  durationSec,
  failedChecks,
  fmtDuration,
  reportKeys,
  reviewMinutes,
  tokenSplit,
  type Conclusion,
  type Finding,
  type FindingsReport,
  type ReportNode,
  type ReportProjectData,
  type RunSummary,
  type Severity,
} from "./report-utils";

const NO_RUN = "Belum ada run — klik Jalankan semua untuk memulai.";

const SEV_TONE: Record<Severity, "danger" | "warn" | "neutral"> = { berat: "danger", sedang: "warn", catatan: "neutral" };
const SEV_HINT: Record<Severity, string> = {
  berat: "harus diperbaiki sebelum hasil dipakai",
  sedang: "perlu ditindaklanjuti",
  catatan: "informasi, bukan kesalahan",
};

export function Term({ children }: { children: ReactNode }) {
  return <b className="font-medium text-text">{children}</b>;
}

// ---------------------------------------------------------------------------------------------
// 1. Cara membaca

export function HowToRead() {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      <p>
        Laporan ini merangkum <Term>run terakhir</Term> proyek (satu kali menjalankan semua analisis di canvas). Bacalah dari atas ke bawah: apa yang
        sudah selesai, galat apa saja yang ditemukan, rumus yang dipakai, saran letak pemeriksaan, lalu kesimpulan di akhir.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-[13px]">
        <li>
          <Term>Validator</Term> = pemeriksaan otomatis oleh program dan AI. Validator mengecek hasil analisis (mis. kutipan benar-benar ada di dokumen,
          angka dalam rentang, rujukan ID ada) lalu meminta AI memperbaiki yang salah.
        </li>
        <li>
          <Term>Tinjauan manusia</Term> = pengurus membaca hasil dan menyetujui atau menolaknya sebelum dipakai langkah berikutnya.
        </li>
        <li>
          <Term>Galat</Term> = kesalahan atau ketidaksesuaian. Tingkatnya:{" "}
          {SEVERITY_ORDER.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && ", "}
              <Badge tone={SEV_TONE[s]}>{SEVERITY_LABEL[s]}</Badge> {SEV_HINT[s]}
            </Fragment>
          ))}
          .
        </li>
        <li>
          <Term>Token</Term> = satuan pemakaian AI (makin banyak token, makin besar biaya). <Term>Peluang</Term> ditulis dalam persen: 90% berarti
          kira-kira 9 dari 10 kali.
        </li>
        <li>
          Angka peluang di bagian Rekomendasi adalah <Term>perkiraan model</Term>, bukan jaminan. Angka yang dipakai model ditunjukkan lengkap beserta
          asal-usulnya (terukur dari eksperimen atau asumsi).
        </li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Ringkasan run

const STATUS_ORDER: { id: string; label: string; tone: "neutral" | "info" | "warn" | "ok" | "danger" }[] = [
  { id: "done", label: "selesai", tone: "ok" },
  { id: "running", label: "berjalan", tone: "info" },
  { id: "needs_review", label: "menunggu tinjauan", tone: "warn" },
  { id: "failed", label: "gagal", tone: "danger" },
  { id: "pending", label: "menunggu giliran", tone: "neutral" },
  { id: "none", label: "belum dijalankan", tone: "neutral" },
];

const PHASE: Record<string, string> = { retrieve: "mencari bukti", generate: "menyusun", validate: "memeriksa", repair: "memperbaiki", review: "ditinjau" };

export function SummarySection({
  graph,
  data,
  summary: s,
  running,
  onSelectNode,
}: {
  graph: WorkflowGraph;
  data: ReportProjectData;
  summary: RunSummary;
  running: boolean;
  onSelectNode?: (k: string) => void;
}) {
  if (!data.runId) return <Empty>{NO_RUN}</Empty>;
  const pct = s.total ? s.done / s.total : 0;
  const { rowKeys, canvasKeys } = reportKeys(graph, data);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border px-3 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted">Kemajuan</span>
          <span className="text-sm font-semibold tabular-nums">
            {fmt.int(s.done)} dari {fmt.int(s.total)} analisis selesai
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.done}>
          <div className={cx("h-full rounded-full bg-primary transition-all", running && "animate-pulse")} style={{ width: `${pct * 100}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STATUS_ORDER.filter((x) => s.status[x.id]).map((x) => (
            <Badge key={x.id} tone={x.tone}>
              {x.label} <span className="tabular-nums">{fmt.int(s.status[x.id])}</span>
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="Total token AI"
          value={fmt.int(s.tokens.total)}
          hint={
            <>
              menyusun {fmt.int(s.tokens.gen)} · memeriksa {fmt.int(s.tokens.check)}
              {s.tokens.other > 0 && <> · lainnya {fmt.int(s.tokens.other)}</>}
            </>
          }
        />
        <Stat label="Total waktu kerja AI" value={fmtDuration(s.duration.sec)} hint={`jumlah dari ${fmt.int(s.duration.n)} analisis yang selesai`} />
        <Stat
          label="Pemeriksaan otomatis (validator)"
          value={
            <span className="flex flex-wrap items-baseline gap-x-2 text-base">
              <span className="text-ok">{fmt.int(s.validator.pass)} lolos</span>
              <span className="text-danger">{fmt.int(s.validator.fail)} tidak</span>
            </span>
          }
          hint={`${fmt.int(s.validator.unchecked)} analisis tidak diperiksa validator`}
        />
        <Stat
          label="Tinjauan manusia"
          value={`${fmt.int(s.reviews.count)} kali`}
          hint={
            s.reviews.count
              ? `${s.reviews.approved} disetujui · ${s.reviews.rejected} ditolak${s.reviews.done ? ` · total ${fmt.num(s.reviews.minutes, 1)} mnt` : ""}${s.reviews.open ? ` · ${s.reviews.open} masih berjalan` : ""}`
              : "belum ada"
          }
        />
        <Stat label="Pertanyaan AI terbuka" value={fmt.int(s.openQuestions)} hint={s.openQuestions ? "lihat bagian Galat & temuan" : "semua sudah dijawab"} />
        <Stat label="Jawaban AI tak terbaca" value={fmt.int(s.formatFailures)} hint="diminta ulang otomatis; bukan galat isi" />
      </div>

      <p className="text-xs leading-relaxed text-muted">
        <Term>Token menyusun</Term> dipakai AI untuk menulis analisis. <Term>Token memeriksa</Term> dipakai validator untuk mengecek dan memperbaiki hasil.{" "}
        <Term>Lainnya</Term> mis. penilaian makna oleh AI. <Term>Waktu kerja</Term> dihitung dari mulai sampai selesai tiap analisis.
      </p>

      <details className="group rounded-md border border-border" open={rowKeys.length <= 12}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Rincian per analisis ({rowKeys.length})</summary>
        <div className="border-t border-border p-2">
          <Table head={["Analisis", "Durasi", "Token menyusun", "Token memeriksa", "Pemeriksaan otomatis", "Tinjauan manusia"]}>
            {rowKeys.map((k) => {
              const n = data.nodes[k];
              const t = tokenSplit(n);
              return (
                <tr key={k} className="cursor-pointer hover:bg-surface-2" onClick={() => onSelectNode?.(k)} title={onSelectNode ? "Sorot di canvas" : undefined}>
                  <td className="min-w-36">
                    <div className="font-medium leading-snug">{labelOf(graph, k)}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {n ? <StatusBadge status={n.status} /> : <Badge>belum dijalankan</Badge>}
                      {n?.status === "running" && n.phase && <span className="text-[11px] text-info">{PHASE[n.phase] ?? n.phase}…</span>}
                      {!canvasKeys.includes(k) && <Badge title="Analisis ini sudah dihapus dari canvas">tidak di canvas</Badge>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{fmtDuration(durationSec(n))}</td>
                  <td className="text-right tabular-nums">{n ? fmt.int(t.gen) : "–"}</td>
                  <td className="text-right tabular-nums">{n && (n.validatorEnabled || t.check) ? fmt.int(t.check) : "–"}</td>
                  <td className="text-xs">
                    <CheckWords n={n} />
                  </td>
                  <td className="text-xs">
                    <ReviewWords n={n} />
                  </td>
                </tr>
              );
            })}
          </Table>
        </div>
      </details>
    </div>
  );
}

function CheckWords({ n }: { n: ReportNode | undefined }) {
  if (!n || !n.validatorEnabled) return <span className="text-muted">tidak diperiksa</span>;
  if (n.validationPassed === true) {
    const repaired = (n.tokens.repair ?? 0) > 0 || n.validation.some((v) => !v.passed);
    return <span className="whitespace-nowrap text-ok">lolos{repaired && <span className="text-muted"> setelah diperbaiki</span>}</span>;
  }
  if (n.validationPassed === false) return <span className="text-danger">tidak lolos ({failedChecks(n).length} pemeriksaan)</span>;
  return <span className="text-muted">belum diperiksa</span>;
}

function ReviewWords({ n }: { n: ReportNode | undefined }) {
  if (!n?.review) {
    if (n?.humanEnabled) return <span className="text-muted">{n.status === "needs_review" ? "menunggu" : "dijadwalkan"}</span>;
    return <span className="text-muted">tidak ditinjau</span>;
  }
  const m = reviewMinutes(n);
  if (m === null) return <span className="text-warn">sedang ditinjau</span>;
  return (
    <span className="whitespace-nowrap">
      <span className={n.review.approved ? "text-ok" : n.review.approved === false ? "text-danger" : "text-muted"}>
        {n.review.approved ? "disetujui" : n.review.approved === false ? "ditolak" : "tanpa keputusan"}
      </span>{" "}
      <span className="tabular-nums text-muted">({fmt.num(m, 1)} mnt)</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Galat & temuan

export function FindingsSection({ data, findings, onSelectNode }: { data: ReportProjectData; findings: FindingsReport; onSelectNode?: (k: string) => void }) {
  const [showNotes, setShowNotes] = useState(true);
  if (!data.runId) return <Empty>{NO_RUN}</Empty>;
  const t = findings.totals;
  const withFindings = findings.groups.filter((g) => g.findings.some((f) => showNotes || f.severity !== "catatan"));
  const clean = findings.groups.filter((g) => !withFindings.includes(g));

  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">
        Semua masalah yang tercatat di run ini, dikelompokkan per analisis sesuai urutan alur. Tidak ada yang disembunyikan: setiap pemeriksaan yang gagal,
        pesan rinciannya, dan masalah yang sudah diperbaiki otomatis ikut ditampilkan.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {SEVERITY_ORDER.map((s) => (
          <Badge key={s} tone={SEV_TONE[s]} title={SEV_HINT[s]}>
            {SEVERITY_LABEL[s]} <span className="tabular-nums">{t[s]}</span>
          </Badge>
        ))}
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" className="size-3.5 accent-[var(--primary)]" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} />
          tampilkan catatan (diperbaiki otomatis, diubah manusia, dll.)
        </label>
      </div>

      {withFindings.length === 0 ? (
        <div className="rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-sm text-ok">Tidak ada galat atau temuan di run ini.</div>
      ) : (
        <div className="space-y-2">
          {withFindings.map((g) => (
            <div key={g.key} className={cx("rounded-md border", g.counts.berat ? "border-danger/40" : g.counts.sedang ? "border-warn/40" : "border-border")}>
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-1.5">
                <button type="button" className="text-sm font-semibold hover:text-primary hover:underline" onClick={() => onSelectNode?.(g.key)} title="Sorot di canvas">
                  {g.label}
                </button>
                <StatusBadge status={g.status === "none" ? "pending" : g.status} />
                <span className="ml-auto flex gap-1">
                  {SEVERITY_ORDER.filter((s) => g.counts[s] && (showNotes || s !== "catatan")).map((s) => (
                    <Badge key={s} tone={SEV_TONE[s]}>
                      {g.counts[s]} {SEVERITY_LABEL[s].toLowerCase()}
                    </Badge>
                  ))}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {g.findings
                  .filter((f) => showNotes || f.severity !== "catatan")
                  .map((f, i) => (
                    <FindingItem key={i} f={f} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {clean.length > 0 && (
        <p className="text-xs text-muted">
          Tanpa temuan{!showNotes ? " (selain catatan)" : ""}: {clean.map((g) => g.label).join(", ")}.
        </p>
      )}
    </div>
  );
}

function FindingItem({ f }: { f: Finding }) {
  return (
    <li className="px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-start gap-1.5">
        <Badge tone={SEV_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
        <span className="min-w-0 flex-1 font-medium leading-snug">{f.title}</span>
      </div>
      {f.check && (
        <div className="mt-0.5 text-[11px] text-muted">
          Pemeriksaan <span className="font-mono">{f.check.name}</span>
          {f.check.kind && <> · {f.check.kind === "llm" ? "dinilai AI" : "dicek program"}</>}
          {f.check.attempts > 1 && <> · diperiksa {f.check.attempts} kali</>}
        </div>
      )}
      {f.detail && <p className="mt-1 text-xs leading-relaxed text-muted">{f.detail}</p>}
      {f.messages.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed">
          {f.messages.map((m, j) => (
            <li key={j}>
              {m.itemId && <span className="mr-1 rounded bg-surface-2 px-1 font-mono text-[10px] font-semibold">{m.itemId}</span>}
              {m.text}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Kesimpulan

export function ConclusionSection({
  conclusion: c,
  hasRun,
  modelReady,
  onSelectNode,
}: {
  conclusion: Conclusion;
  hasRun: boolean;
  modelReady: boolean;
  onSelectNode?: (k: string) => void;
}) {
  if (!hasRun) return <Empty>{NO_RUN}</Empty>;
  const tone = c.verdict.tone === "ok" ? "border-ok/30 bg-ok-soft text-ok" : c.verdict.tone === "warn" ? "border-warn/30 bg-warn-soft text-warn" : "border-danger/30 bg-danger-soft text-danger";
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <div className={cx("rounded-md border px-3 py-2 font-medium", tone)}>{c.verdict.text}</div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Kelengkapan</h4>
        <p>{c.completeness}</p>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Galat</h4>
        <p>{c.errors}</p>
        {c.attention.length > 0 && (
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[13px]">
            {c.attention.map((a, i) => (
              <li key={i}>
                <Badge tone={SEV_TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>{" "}
                <button type="button" className="font-medium hover:text-primary hover:underline" onClick={() => onSelectNode?.(a.key)}>
                  {a.label}
                </button>
                : {a.text}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Perkiraan peluang bebas galat</h4>
        <p>{c.estimate ?? (modelReady ? "Belum ada analisis untuk diperkirakan." : "Menunggu angka model dimuat…")}</p>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Langkah berikutnya</h4>
        <ol className="list-decimal space-y-1 pl-5 text-[13px]">
          {c.nextSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
