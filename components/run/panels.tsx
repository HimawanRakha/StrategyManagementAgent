"use client";
// Panel-panel detail node run: biaya, riwayat validasi, tinjauan manusia, pertanyaan agen, daftar bukti.
import { Fragment, useState } from "react";
import { Badge, Button, Field, Input, Table, Textarea, cx, ErrorBox } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import { nodeLabel } from "@/lib/nodes/meta";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { CostRow, NodeRunJson, QuestionJson, ReviewJson, ValidationEventJson } from "./types";
import { isUserChunk } from "./types";

const PURPOSE_LABEL: Record<string, string> = { generate: "generate", validate: "validasi", repair: "perbaikan", judge: "juri" };

export function CostTable({ costs }: { costs: CostRow[] }) {
  if (!costs.length) return <p className="text-xs text-muted">Belum ada panggilan LLM untuk node ini.</p>;
  const sum = (f: (c: CostRow) => number) => costs.reduce((s, c) => s + (f(c) ?? 0), 0);
  return (
    <Table head={["Tujuan", "Panggilan", "Token masuk", "Token keluar", "Latensi", "Galat format"]}>
      {costs.map((c) => (
        <tr key={c.purpose}>
          <td className="text-xs font-medium">{PURPOSE_LABEL[c.purpose] ?? c.purpose}</td>
          <td className="text-right tabular-nums">{fmt.int(c.calls)}</td>
          <td className="text-right tabular-nums">{fmt.int(c.tokens_in)}</td>
          <td className="text-right tabular-nums">{fmt.int(c.tokens_out)}</td>
          <td className="text-right tabular-nums">{fmt.num(c.latency_ms / 1000, 1)} d</td>
          <td className={cx("text-right tabular-nums", c.format_errors > 0 && "text-warn")}>{fmt.int(c.format_errors)}</td>
        </tr>
      ))}
      <tr className="bg-surface-2 font-semibold">
        <td className="text-xs">Total</td>
        <td className="text-right tabular-nums">{fmt.int(sum((c) => c.calls))}</td>
        <td className="text-right tabular-nums">{fmt.int(sum((c) => c.tokens_in))}</td>
        <td className="text-right tabular-nums">{fmt.int(sum((c) => c.tokens_out))}</td>
        <td className="text-right tabular-nums">{fmt.num(sum((c) => c.latency_ms) / 1000, 1)} d</td>
        <td className="text-right tabular-nums">{fmt.int(sum((c) => c.format_errors))}</td>
      </tr>
    </Table>
  );
}

export function ValidationHistory({ events, onPickItem }: { events: ValidationEventJson[]; onPickItem?: (id: string) => void }) {
  if (!events.length) return <p className="text-xs text-muted">Belum ada riwayat validasi.</p>;
  const attempts = [...new Set(events.map((e) => e.attempt))].sort((a, b) => a - b);
  return (
    <div className="space-y-3">
      {attempts.map((a) => {
        const evs = events.filter((e) => e.attempt === a);
        const ok = evs.every((e) => e.passed);
        return (
          <div key={a} className="rounded-md border border-border">
            <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5 text-xs">
              <span className="font-semibold">Percobaan {a}</span>
              <Badge tone={ok ? "ok" : "danger"}>{ok ? "semua lolos" : `${evs.filter((e) => !e.passed).length} cek gagal`}</Badge>
            </div>
            <ul className="divide-y divide-border">
              {evs.map((e) => (
                <li key={e.id} className="px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cx("font-semibold", e.passed ? "text-ok" : "text-danger")}>{e.passed ? "✓" : "✗"}</span>
                    <span className="font-mono">{e.checkName}</span>
                    {e.detail?.kind && <Badge tone={e.detail.kind === "llm" ? "accent" : "neutral"}>{e.detail.kind === "llm" ? "LLM" : "kode"}</Badge>}
                  </div>
                  {!!e.detail?.failures?.length && (
                    <ul className="mt-1.5 space-y-1 pl-5">
                      {e.detail.failures.map((f, i) => (
                        <li key={i} className="list-disc text-danger">
                          {f.itemId &&
                            (onPickItem ? (
                              <button type="button" onClick={() => onPickItem(f.itemId!)} className="mr-1 font-mono font-semibold underline-offset-2 hover:underline">
                                [{f.itemId}]
                              </button>
                            ) : (
                              <span className="mr-1 font-mono font-semibold">[{f.itemId}]</span>
                            ))}
                          <span className="text-text">{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function RetrievedEvidence({ evidence }: { evidence: EvidenceChunk[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="rounded-md border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-surface-2">
        <span>
          Semua bukti yang diambil <span className="text-muted">({evidence.length})</span>
        </span>
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open &&
        (evidence.length ? (
          <div className="border-t border-border">
            <Table head={["ID", "Sumber", "Kemiripan", "Fokus kueri"]} className="rounded-none border-0">
              {evidence.map((e) => (
                <Fragment key={e.id}>
                  <tr className="cursor-pointer hover:bg-surface-2" onClick={() => setExpanded((x) => (x === e.id ? null : e.id))}>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <Badge tone={isUserChunk(e.id, e.kind) ? "accent" : "primary"} className="font-mono">
                          {e.id}
                        </Badge>
                        {isUserChunk(e.id, e.kind) && <Badge tone="accent">jawaban pengguna</Badge>}
                      </span>
                    </td>
                    <td className="text-xs">{e.source}</td>
                    <td className="text-right text-xs tabular-nums">{e.similarity === undefined ? "–" : fmt.num(e.similarity, 3)}</td>
                    <td className="text-xs text-muted">{e.focus ?? "–"}</td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={4} className="bg-surface-2/60">
                        <p className="whitespace-pre-wrap text-xs leading-relaxed">{e.content}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted">Tidak ada bukti yang diambil.</p>
        ))}
    </div>
  );
}

// ===== Tinjauan manusia =====
export function ReviewPanel({
  nodeRun,
  reviews,
  canReview,
  onChanged,
}: {
  nodeRun: NodeRunJson;
  reviews: ReviewJson[];
  canReview: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const original = JSON.stringify(nodeRun.output ?? null, null, 2);
  const [text, setText] = useState(original);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = reviews.find((r) => !r.endedAt);
  const edited = text !== original;

  async function act(action: "start" | "approve" | "reject") {
    setError(null);
    let changes: unknown;
    if (action === "approve" && edited) {
      try {
        changes = JSON.parse(text);
      } catch (e) {
        setError(`JSON tidak valid: ${(e as Error).message}`);
        return;
      }
    }
    if (action === "reject" && !confirm("Tolak output ini? Node dikembalikan ke status menunggu dan output dikosongkan.")) return;
    if (action === "approve" && !confirm(edited ? "Setujui output dengan perubahan Anda?" : "Setujui output tanpa perubahan?")) return;
    setBusy(action);
    try {
      await api(`/api/node-runs/${nodeRun.id}/review`, {
        body: action === "approve" ? { action, ...(edited ? { changes } : {}) } : action === "reject" ? { action, note: note || undefined } : { action },
      });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {nodeRun.status === "needs_review" && (
        <div className="rounded-md border border-warn/30 bg-warn-soft/50 p-3">
          {!canReview ? (
            <p className="text-sm text-warn">Node ini menunggu untuk diperiksa sebelum analisis berikutnya dijalankan.</p>
          ) : !open ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">Output menunggu tinjauan. Waktu tinjauan dicatat dari “Mulai tinjau” sampai keputusan.</p>
              <Button variant="primary" onClick={() => act("start")} loading={busy === "start"}>
                Mulai tinjau
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  Tinjauan dimulai {fmt.date(open.startedAt)} {edited && <Badge tone="info">diedit</Badge>}
                </span>
                {edited && (
                  <Button size="sm" variant="ghost" onClick={() => setText(original)}>
                    Kembalikan ke output asli
                  </Button>
                )}
              </div>
              <Field label="Output (JSON) — edit bila perlu" hint="Perubahan hanya dikirim bila Anda mengedit teks ini; angka hitungan dibuat ulang oleh kode.">
                <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-72 font-mono text-xs" spellCheck={false} />
              </Field>
              <ErrorBox error={error} />
              <div className="flex flex-wrap items-end gap-2">
                <Button variant="primary" onClick={() => act("approve")} loading={busy === "approve"} disabled={!!busy}>
                  Setujui
                </Button>
                <Field label="Catatan penolakan" className="min-w-48 flex-1">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Alasan (opsional)" />
                </Field>
                <Button variant="danger" onClick={() => act("reject")} loading={busy === "reject"} disabled={!!busy}>
                  Tolak
                </Button>
              </div>
            </div>
          )}
          {!open && <ErrorBox error={error} />}
        </div>
      )}
      {reviews.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Riwayat tinjauan</h4>
          <Table head={["Mulai", "Selesai", "Durasi", "Keputusan", "Perubahan"]}>
            {[...reviews]
              .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
              .map((r) => {
                const dur = r.endedAt ? (new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 1000 : null;
                const changes = r.changes as { note?: string } | null;
                return (
                  <tr key={r.id}>
                    <td className="text-xs whitespace-nowrap">{fmt.date(r.startedAt)}</td>
                    <td className="text-xs whitespace-nowrap">{fmt.date(r.endedAt)}</td>
                    <td className="text-xs tabular-nums">{dur === null ? "–" : dur < 120 ? `${Math.round(dur)} d` : `${fmt.num(dur / 60, 1)} mnt`}</td>
                    <td>{r.approved === null ? <Badge tone="info">berlangsung</Badge> : r.approved ? <Badge tone="ok">disetujui</Badge> : <Badge tone="danger">ditolak</Badge>}</td>
                    <td className="text-xs">
                      {r.approved === false ? (changes?.note ?? "–") : r.changes ? <Badge tone="info">output diedit</Badge> : <span className="text-muted">tanpa perubahan</span>}
                    </td>
                  </tr>
                );
              })}
          </Table>
        </div>
      )}
    </div>
  );
}

// ===== Pertanyaan agen =====
function QuestionItem({ q, nodeKey, canAnswer, onChanged }: { q: QuestionJson; nodeKey?: string; canAnswer: boolean; onChanged: () => Promise<void> | void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agent-questions/${q.id}/answer`, { body: { answer } });
      setAnswer("");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="accent" className="font-mono">{q.label}</Badge>
        {nodeKey && <Badge>{nodeLabel(nodeKey)}</Badge>}
        {q.answer ? <Badge tone="ok">terjawab</Badge> : <Badge tone="warn">belum dijawab</Badge>}
      </div>
      <p className="text-sm">{q.question}</p>
      {q.answer ? (
        <div className="mt-2 rounded bg-surface-2 px-2.5 py-1.5 text-sm">
          <span className="text-xs text-muted">Jawaban ({fmt.date(q.answeredAt)}): </span>
          {q.answer}
        </div>
      ) : canAnswer ? (
        <div className="mt-2 space-y-2">
          <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Tulis jawaban berdasarkan kondisi organisasi…" className="min-h-16 w-full" />
          <ErrorBox error={error} />
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={answer.trim().length < 2}>
            Kirim jawaban
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function QuestionsPanel({
  questions,
  nodeKeyOf,
  canAnswer,
  onChanged,
}: {
  questions: QuestionJson[];
  nodeKeyOf: (nodeRunId: string) => string | undefined;
  canAnswer: boolean;
  onChanged: () => Promise<void> | void;
}) {
  if (!questions.length) return <p className="text-xs text-muted">Agen belum mengajukan pertanyaan pada run ini.</p>;
  const sorted = [...questions].sort((a, b) => Number(!!a.answer) - Number(!!b.answer) || a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="space-y-2">
      <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
        Setelah menjawab, klik <b>Ulangi</b> pada node terkait agar jawaban (label U…) ikut diambil sebagai bukti.
      </p>
      <ul className="space-y-2">
        {sorted.map((q) => (
          <QuestionItem key={q.id} q={q} nodeKey={nodeKeyOf(q.nodeRunId)} canAnswer={canAnswer} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}
