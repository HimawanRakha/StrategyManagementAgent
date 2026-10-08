"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { RunConfig, WorkflowGraph } from "@/lib/db/schema";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, StatusBadge, Table, Textarea, cx } from "@/components/ui";
import { api, download, fmt, useApi } from "@/lib/client/api";
import { nodeLabel } from "@/lib/nodes/meta";
import { engineGraph, processKeys } from "@/lib/engine/canvas";
import { ApiErrorNote, Note, PlacementChip, PlacementLegend, PlacementList, stageOrder, type Placement } from "./shared";

/** Run yang dipakai canvas sehari-hari; bukan bagian dari eksperimen. */
const MAIN_TAG = "utama";
const ACTIVE = new Set(["pending", "running"]);

type ProjectCanvas = { workflowId: string; canvas: WorkflowGraph; runId: string | null };
type RunRow = { id: string; experimentTag: string; status: string; createdAt: string; config: RunConfig };

export type SelectedProject = { id: string; name: string; isSynthetic: boolean };

/** Analisis yang dijalankan mesin untuk canvas ini (grand design ikut bila ada node output), urut rantai analisis. */
export function canvasKeys(canvas: WorkflowGraph | null | undefined): string[] {
  return canvas ? [...processKeys(canvas)].sort(stageOrder) : [];
}

/** Tab "Run batch": jalankan N run dengan satu konfigurasi pemeriksaan, lalu pantau hasilnya. */
export function BatchTab({ project, detail }: { project: SelectedProject | null; detail: { data: ProjectCanvas | null; error: string | null; loading: boolean } }) {
  if (!project) return <Empty>Pilih proyek di atas terlebih dahulu.</Empty>;
  if (detail.error && !detail.data) return <ApiErrorNote message={detail.error} />;
  if (detail.loading || !detail.data) return <Loading label="Memuat canvas proyek…" />;
  const keys = canvasKeys(detail.data.canvas);
  return <BatchBody project={project} data={detail.data} keys={keys} />;
}

function BatchBody({ project, data, keys }: { project: SelectedProject; data: ProjectCanvas; keys: string[] }) {
  const [bump, setBump] = useState(0);
  return (
    <div className="space-y-4">
      {keys.length === 0 ? (
        <Empty>
          Canvas proyek <b>{project.name}</b> belum punya analisis. Tambahkan analisis di canvas proyek terlebih dahulu, lalu kembali ke sini.
        </Empty>
      ) : (
        <BatchForm key={data.workflowId} workflowId={data.workflowId} keys={keys} canvas={data.canvas} onCreated={() => setBump((b) => b + 1)} />
      )}
      <RunList projectId={project.id} bump={bump} />
    </div>
  );
}

function BatchForm({ workflowId, keys, canvas, onCreated }: { workflowId: string; keys: string[]; canvas: WorkflowGraph; onCreated: () => void }) {
  const off = () => Object.fromEntries(keys.map((k) => [k, { validator: false, human: false }]));
  const [placement, setPlacement] = useState<Placement>(off);
  const [tag, setTag] = useState("baseline");
  const [n, setN] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (k: string, f: "validator" | "human") =>
    setPlacement((p) => ({ ...p, [k]: { ...p[k], [f]: !p[k]?.[f] } }));
  const fromCanvas = () => {
    // Penempatan di canvas = elemen validator/tinjauan yang terpasang (lihat engineGraph).
    const eg = engineGraph(canvas);
    const next: Placement = {};
    for (const k of keys) {
      const node = eg.nodes.find((x) => x.key === k);
      next[k] = { validator: !!node?.validator, human: !!node?.human };
    }
    setPlacement(next);
  };
  const all = (f: "validator" | "human") => setPlacement((p) => Object.fromEntries(keys.map((k) => [k, { ...p[k], [f]: true }])));

  const anyCheck = keys.some((k) => placement[k]?.validator || placement[k]?.human);
  const anyHuman = keys.some((k) => placement[k]?.human);
  const tagT = tag.trim();
  const count = Math.round(Number(n));
  const problem = !tagT
    ? "Tag eksperimen wajib diisi."
    : tagT.toLowerCase() === MAIN_TAG
      ? `Tag "${MAIN_TAG}" dipakai canvas utama; pilih nama lain.`
      : !(count >= 1 && count <= 50)
        ? "Jumlah run harus 1–50."
        : null;

  async function submit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { runs } = await api<{ runs: RunRow[] }>("/api/runs/batch", {
        body: { workflowId, experimentTag: tagT, placement, n: count, autoStart: true },
      });
      setDone(`${runs.length} run dengan tag "${tagT}" dibuat dan masuk antrean.`);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Buat run batch" subtitle="Jalankan seluruh analisis di canvas proyek ini beberapa kali dengan konfigurasi pemeriksaan yang sama.">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">Isi cepat:</span>
            <Button size="sm" variant="ghost" onClick={() => setPlacement(off())}>
              Semua mati (baseline)
            </Button>
            <Button size="sm" variant="ghost" onClick={fromCanvas}>
              Ikuti canvas
            </Button>
            <Button size="sm" variant="ghost" onClick={() => all("validator")}>
              Validator di semua
            </Button>
          </div>
          <Table head={["Analisis", "Validator", "Tinjauan manusia", "Pilihan"]}>
            {keys.map((k) => {
              const c = placement[k];
              return (
                <tr key={k}>
                  <td className="font-medium whitespace-nowrap">{nodeLabel(k)}</td>
                  <td>
                    <input type="checkbox" className="size-4 accent-[var(--info)]" checked={!!c?.validator} onChange={() => toggle(k, "validator")} aria-label={`Validator ${nodeLabel(k)}`} />
                  </td>
                  <td>
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!c?.human} onChange={() => toggle(k, "human")} aria-label={`Tinjauan manusia ${nodeLabel(k)}`} />
                  </td>
                  <td>
                    <PlacementChip c={c} />
                  </td>
                </tr>
              );
            })}
          </Table>
          <PlacementLegend />
        </div>
        <div className="space-y-3">
          <Field label="Tag eksperimen" hint="Nama kelompok run ini, mis. baseline, v-qspm, vm-semua.">
            <Input value={tag} onChange={(e) => setTag(e.target.value)} className="font-mono" maxLength={60} />
          </Field>
          <Note>
            <b>baseline</b> = tanpa pemeriksaan: validator dan tinjauan manusia dimatikan di semua analisis. Run baseline dipakai mengukur tingkat galat
            asli setiap tahap.
          </Note>
          {tagT.toLowerCase() === "baseline" && anyCheck && (
            <div className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">Tag &ldquo;baseline&rdquo; tetapi ada pemeriksaan yang aktif. Matikan semua atau ganti tag.</div>
          )}
          <Field label="Jumlah run (1–50)">
            <Input type="number" min={1} max={50} value={n} onChange={(e) => setN(e.target.value)} className="w-28 tabular-nums" />
          </Field>
          {anyHuman && (
            <p className="text-[11px] text-muted">Run dengan tinjauan manusia akan berhenti di status &ldquo;menunggu tinjauan&rdquo; sampai Anda menyetujuinya di daftar run.</p>
          )}
          {problem && <p className="text-xs text-danger">{problem}</p>}
          <ErrorBox error={error} />
          {done && <div className="rounded-md bg-ok-soft px-3 py-2 text-xs text-ok">{done}</div>}
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={submit}>
            Jalankan {Number.isFinite(count) && count > 0 ? count : ""} run
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RunList({ projectId, bump }: { projectId: string; bump: number }) {
  const [poll, setPoll] = useState(false);
  const { data, error, loading, reload } = useApi<{ runs: RunRow[] }>(`/api/runs?projectId=${projectId}`, poll ? 3000 : undefined);
  const runs = useMemo(() => (data?.runs ?? []).filter((r) => r.experimentTag !== MAIN_TAG), [data]);
  const active = runs.some((r) => ACTIVE.has(r.status));
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Polling hanya selama ada run yang menunggu/berjalan.
  if (poll !== active) setPoll(active);

  // Batch baru dibuat: muat ulang daftar agar run baru (dan polling) langsung terlihat.
  useEffect(() => {
    if (bump) void reload();
  }, [bump, reload]);

  const summary = useMemo(() => {
    const m = new Map<string, { total: number; done: number; review: number; failed: number }>();
    for (const r of runs) {
      const s = m.get(r.experimentTag) ?? { total: 0, done: 0, review: 0, failed: 0 };
      s.total++;
      if (r.status === "done") s.done++;
      if (r.status === "waiting_review") s.review++;
      if (r.status === "failed") s.failed++;
      m.set(r.experimentTag, s);
    }
    return [...m.entries()];
  }, [runs]);

  async function act(id: string, what: "start" | "delete") {
    if (what === "delete" && !window.confirm("Hapus run ini beserta seluruh output dan anotasinya? Tindakan ini tidak bisa dibatalkan.")) return;
    setBusy(id + what);
    setErr(null);
    try {
      if (what === "start") await api(`/api/runs/${id}/start`, { method: "POST" });
      else await api(`/api/runs/${id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportRun(id: string, format: "csv" | "json") {
    setErr(null);
    try {
      await download(`/api/runs/${id}/export?format=${format}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Card
      title="Run eksperimen proyek ini"
      subtitle={active ? "Diperbarui otomatis setiap 3 detik selama ada run yang berjalan." : "Run dijalankan di antrean latar belakang."}
      actions={
        <Button size="sm" variant="ghost" onClick={() => reload()}>
          Muat ulang
        </Button>
      }
    >
      {error && !data ? (
        <ApiErrorNote message={error} />
      ) : loading && !data ? (
        <Loading />
      ) : runs.length === 0 ? (
        <Empty>Belum ada run eksperimen. Buat run batch di atas.</Empty>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {summary.map(([t, s]) => (
              <span key={t} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
                <span className="font-mono font-semibold">{t}</span>
                <span className="text-muted tabular-nums">
                  {s.done}/{s.total} selesai
                  {s.review ? ` · ${s.review} menunggu tinjauan` : ""}
                  {s.failed ? ` · ${s.failed} gagal` : ""}
                </span>
              </span>
            ))}
          </div>
          <ErrorBox error={err} />
          <Table head={["Tag", "Dibuat", "Status", "Pemeriksaan", "Aksi"]}>
            {runs.map((r) => (
              <Fragment key={r.id}>
                <tr className={cx(open === r.id && "bg-surface-2/60")}>
                  <td>
                    <span className="font-mono text-xs font-semibold">{r.experimentTag}</span>
                    <div className="font-mono text-[10px] text-muted">{r.id.slice(0, 8)}</div>
                  </td>
                  <td className="text-xs whitespace-nowrap text-muted">{fmt.date(r.createdAt)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>
                    <PlacementList placement={r.config?.placement ?? {}} />
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant={r.status === "waiting_review" ? "primary" : "ghost"} onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? "Tutup" : r.status === "waiting_review" ? "Tinjau" : "Detail"}
                      </Button>
                      {(r.status === "waiting_review" || r.status === "failed" || r.status === "pending") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === r.id + "start"}
                          onClick={() => act(r.id, "start")}
                          title="Antrekan lagi analisis yang siap dijalankan (mis. setelah gagal atau setelah tinjauan)"
                        >
                          Lanjutkan
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => exportRun(r.id, "csv")} title="Unduh output sebagai CSV">
                        CSV
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => exportRun(r.id, "json")} title="Unduh output sebagai JSON">
                        JSON
                      </Button>
                      <Button size="sm" variant="danger" loading={busy === r.id + "delete"} onClick={() => act(r.id, "delete")}>
                        Hapus
                      </Button>
                    </div>
                  </td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={5} className="bg-surface-2/40">
                      <RunDetail runId={r.id} live={r.status !== "done" && r.status !== "failed"} onChanged={reload} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

type NodeRunRow = { id: string; nodeKey: string; status: string; output: unknown; error: string | null; validationPassed: boolean | null };
type ReviewRow = { id: string; nodeRunId: string; endedAt: string | null };
type RunDetailResp = { nodeRuns: NodeRunRow[]; reviews: ReviewRow[] };

function RunDetail({ runId, live, onChanged }: { runId: string; live: boolean; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<RunDetailResp>(`/api/runs/${runId}`, live ? 3000 : undefined);
  if (error && !data) return <ApiErrorNote message={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const refresh = () => {
    reload();
    onChanged();
  };
  return (
    <div className="space-y-2 py-1">
      <ul className="flex flex-wrap gap-1.5">
        {data.nodeRuns.map((nr) => (
          <li key={nr.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs" title={nr.error ?? undefined}>
            <span className="font-medium">{nodeLabel(nr.nodeKey)}</span>
            <StatusBadge status={nr.status} />
            {nr.validationPassed === false && <Badge tone="danger">validasi gagal</Badge>}
          </li>
        ))}
      </ul>
      {data.nodeRuns
        .filter((nr) => nr.status === "failed" && nr.error)
        .map((nr) => (
          <p key={nr.id} className="text-xs text-danger">
            {nodeLabel(nr.nodeKey)}: {nr.error}
          </p>
        ))}
      {data.nodeRuns
        .filter((nr) => nr.status === "needs_review")
        .map((nr) => (
          <ReviewBox key={nr.id} runId={runId} nodeRun={nr} started={data.reviews.some((r) => r.nodeRunId === nr.id && !r.endedAt)} onDone={refresh} />
        ))}
    </div>
  );
}

/** Tinjauan manusia sederhana: waktu tercatat dari "Mulai tinjau" sampai setuju/tolak. */
function ReviewBox({ runId, nodeRun, started, onDone }: { runId: string; nodeRun: NodeRunRow; started: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function review(action: "start" | "approve" | "reject") {
    setBusy(action);
    setErr(null);
    try {
      await api(`/api/node-runs/${nodeRun.id}/review`, { body: action === "reject" ? { action, note: note.trim() || undefined } : { action } });
      // Ditolak: node kembali ke antrean agar dijalankan ulang.
      if (action === "reject") await api(`/api/runs/${runId}/start`, { method: "POST" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-md border border-warn/30 bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <b>{nodeLabel(nodeRun.nodeKey)}</b> menunggu tinjauan manusia
        </div>
        {!started && (
          <Button size="sm" variant="primary" loading={busy === "start"} onClick={() => review("start")}>
            Mulai tinjau
          </Button>
        )}
      </div>
      {started && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted">Waktu tinjauan sedang dicatat. Periksa output di bawah, lalu setujui atau tolak (output ditolak akan dibuat ulang).</p>
          <pre className="max-h-80 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(nodeRun.output, null, 2)}</pre>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Catatan bila ditolak (opsional)" className="text-xs" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy === "approve"} onClick={() => review("approve")}>
              Setujui
            </Button>
            <Button size="sm" variant="danger" loading={busy === "reject"} onClick={() => review("reject")}>
              Tolak dan buat ulang
            </Button>
          </div>
        </div>
      )}
      {err && (
        <div className="mt-2">
          <ApiErrorNote message={err} />
        </div>
      )}
    </div>
  );
}
