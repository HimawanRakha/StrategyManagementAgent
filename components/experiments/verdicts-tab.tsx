"use client";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Loading, Select, Field, cx } from "@/components/ui";
import { api, useApi } from "@/lib/client/api";
import { ApiErrorNote, Note, stageOrder } from "./shared";

type Label = { isError: boolean; errorType: string | null; note: string | null } | null;
type VerdictRow = {
  nodeRunId: string;
  runId: string;
  tag: string;
  nodeKey: string;
  label: string;
  annotators: string[];
  items: { id: string; text: string; detail?: string; labels: Label[]; agree: boolean | null }[];
  disagreements: number;
  suggestedOwn: boolean;
  suggestedCarried: boolean;
  parentsDecided: boolean;
  verdict: { ownError: boolean; carriedError: boolean } | null;
};

type Filter = "open" | "all" | "disagree";
const PAGE = 25;

/** Tab "Putusan": label dua penilai berdampingan, saran putusan, simpan galat sendiri/terbawa. */
export function VerdictsTab() {
  const { data, error, loading, reload } = useApi<{ rows: VerdictRow[] }>("/api/verdicts");
  const [filter, setFilter] = useState<Filter>("open");
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const all = [...(data?.rows ?? [])].sort((a, b) => a.runId.localeCompare(b.runId) || stageOrder(a.nodeKey, b.nodeKey));
    return all.filter((r) => (filter === "open" ? !r.verdict : filter === "disagree" ? r.disagreements > 0 : true));
  }, [data, filter]);

  if (error && !data) return <ApiErrorNote message={error} />;
  const total = data?.rows.length ?? 0;
  const open = data?.rows.filter((r) => !r.verdict).length ?? 0;
  const dis = data?.rows.filter((r) => r.disagreements > 0).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Tampilkan">
          <Select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as Filter);
              setLimit(PAGE);
            }}
          >
            <option value="open">Belum diputus ({open})</option>
            <option value="all">Semua ({total})</option>
            <option value="disagree">Ada ketidaksepakatan ({dis})</option>
          </Select>
        </Field>
        <Button size="sm" variant="ghost" onClick={reload}>
          Muat ulang
        </Button>
      </div>
      <Note>
        Putuskan per node run setelah kedua penilai selesai. <b>Galat sendiri</b>: node ini membuat galat baru. <b>Galat terbawa</b>: galat
        berasal dari input induk yang salah. Putuskan berurutan secara topologis (induk lebih dulu) agar saran &ldquo;galat terbawa&rdquo;
        akurat — daftar diurutkan per run lalu urutan node.
      </Note>
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>{total === 0 ? "Belum ada node run yang dianotasi." : filter === "open" ? "Semua node run yang dianotasi sudah diputus." : "Tidak ada baris untuk filter ini."}</Empty>
      ) : (
        <>
          {rows.slice(0, limit).map((r) => (
            <VerdictCard key={r.nodeRunId} row={r} onSaved={reload} />
          ))}
          {rows.length > limit && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                Tampilkan {Math.min(PAGE, rows.length - limit)} lagi ({rows.length - limit} tersisa)
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LabelCell({ l }: { l: Label }) {
  if (!l) return <span className="text-xs text-muted">belum menilai</span>;
  return (
    <div className="space-y-0.5">
      {l.isError ? (
        <Badge tone="danger">Galat{l.errorType ? ` · ${l.errorType}` : ""}</Badge>
      ) : (
        <Badge tone="ok">Tidak galat</Badge>
      )}
      {l.note && <div className="text-[11px] text-muted">{l.note}</div>}
    </div>
  );
}

function VerdictCard({ row, onSaved }: { row: VerdictRow; onSaved: () => void }) {
  const [own, setOwn] = useState(row.verdict?.ownError ?? row.suggestedOwn);
  const [carried, setCarried] = useState(row.verdict?.carriedError ?? row.suggestedCarried);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = !row.verdict || row.verdict.ownError !== own || row.verdict.carriedError !== carried;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/verdicts", { body: { nodeRunId: row.nodeRunId, ownError: own, carriedError: carried } });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const annotHead = row.annotators.length ? row.annotators : ["Penilai"];
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {row.label}
          <Badge tone="neutral" title="Experiment tag">
            {row.tag}
          </Badge>
          <span className="font-mono text-[11px] font-normal text-muted" title={row.runId}>
            run {row.runId.slice(0, 8)}
          </span>
        </span>
      }
      subtitle={`${row.annotators.length} penilai · ${row.items.length} item`}
      actions={
        <>
          {row.disagreements > 0 && <Badge tone="warn">{row.disagreements} tidak sepakat</Badge>}
          {row.annotators.length < 2 && <Badge tone="neutral">baru {row.annotators.length} penilai</Badge>}
          {row.verdict ? (
            <Badge tone={row.verdict.ownError || row.verdict.carriedError ? "danger" : "ok"}>
              {row.verdict.ownError || row.verdict.carriedError
                ? `diputus: ${[row.verdict.ownError && "sendiri", row.verdict.carriedError && "terbawa"].filter(Boolean).join(" + ")}`
                : "diputus: bersih"}
            </Badge>
          ) : (
            <Badge tone="info">belum diputus</Badge>
          )}
        </>
      }
    >
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="border-b border-border px-3 py-2 font-medium">ID</th>
              <th className="border-b border-border px-3 py-2 font-medium">Item</th>
              {annotHead.map((a, i) => (
                <th key={a} className="border-b border-border px-3 py-2 font-medium whitespace-nowrap" title={a}>
                  Penilai {String.fromCharCode(65 + i)} <span className="font-mono text-[10px] font-normal">({a.length > 14 ? a.slice(0, 12) + "…" : a})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row.items.map((it) => (
              <tr key={it.id} className={cx("border-b border-border last:border-b-0", it.agree === false && "bg-warn-soft")}>
                <td className="px-3 py-2 align-top font-mono text-xs whitespace-nowrap">{it.id}</td>
                <td className="px-3 py-2 align-top">
                  <div>{it.text}</div>
                  {it.detail && <div className="mt-0.5 text-xs text-muted">{it.detail}</div>}
                </td>
                {annotHead.map((a, i) => (
                  <td key={a} className="px-3 py-2 align-top">
                    <LabelCell l={it.labels[i] ?? null} />
                  </td>
                ))}
              </tr>
            ))}
            {row.items.length === 0 && (
              <tr>
                <td colSpan={2 + annotHead.length} className="px-3 py-3 text-center text-xs text-muted">
                  Output tanpa item.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-xs text-muted">
          Saran: <b className="text-text">{row.suggestedOwn ? "galat sendiri" : "tanpa galat sendiri"}</b>
          {" · "}
          <b className="text-text">{row.suggestedCarried ? "galat terbawa" : "input bersih"}</b>
        </span>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--danger)]" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          galat sendiri
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--warn)]" checked={carried} onChange={(e) => setCarried(e.target.checked)} />
          galat terbawa
        </label>
        <Button size="sm" variant="primary" loading={busy} disabled={!changed} onClick={save}>
          {row.verdict ? "Perbarui putusan" : "Simpan putusan"}
        </Button>
        {saved && !changed && <span className="text-xs text-ok">Tersimpan</span>}
      </div>
      {!row.parentsDecided && (
        <p className="mt-2 text-xs text-warn">
          Node induk pada run ini belum semua diputus — saran &ldquo;galat terbawa&rdquo; belum lengkap. Putuskan induknya lebih dulu.
        </p>
      )}
      {err && (
        <div className="mt-2">
          <ErrorBox error={err} />
        </div>
      )}
    </Card>
  );
}
