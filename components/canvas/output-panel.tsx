"use client";
// Panel node output: pratinjau dokumen hasil (bab sesuai analisis yang tersambung), ringkasan eksekutif, unduh XLSX/DOCX/PDF.
import { useState } from "react";
import { Button, DraftLabel, ErrorBox, Field, Input, Spinner, cx } from "@/components/ui";
import { download, useApi } from "@/lib/client/api";
import type { Block } from "@/lib/sheets/grid";
import { phaseLabel } from "./summary";
import type { RunMsg } from "./process-panel";
import type { FlowData, ProjectData, RunState } from "./types";

/** Respons pratinjau: blok dokumen ringkas + analisis yang belum selesai (bentuk lama ditoleransi). */
type OutputResp = {
  title?: string;
  keys?: string[];
  runId?: string | null;
  blocks?: Block[] | null;
  unavailable?: (string | { key?: string; label?: string; status?: string })[] | null;
  doc?: unknown;
};

const unavailableText = (u: NonNullable<OutputResp["unavailable"]>[number]) => (typeof u === "string" ? u : (u.label ?? u.key ?? "?"));

function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case "title":
      return (
        <div className="border-b border-border pb-2">
          <h2 className="text-lg font-semibold leading-tight">{b.text}</h2>
          <p className="mt-1 text-[11px] text-muted">{b.sub}</p>
        </div>
      );
    case "h1":
      return <h3 className="pt-3 text-[15px] font-semibold">{b.text}</h3>;
    case "h2":
      return <h4 className="pt-1 text-sm font-semibold text-muted">{b.text}</h4>;
    case "p":
      return <p className={cx("text-[13px] leading-relaxed", b.italic && "italic")}>{b.text}</p>;
    case "note":
      return <p className="rounded bg-warn-soft/70 px-2 py-1 text-[11.5px] text-warn">{b.text}</p>;
    case "bullets":
      return (
        <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">
          {(b.items ?? []).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-[11.5px]">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                {(b.head ?? []).map((h, i) => (
                  <th key={i} className="px-2 py-1 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(b.rows ?? []).map((r, i) => (
                <tr key={i} className="border-t border-border align-top">
                  {r.map((c, j) => (
                    <td key={j} className="px-2 py-1">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function OutputPanel({
  projectId,
  nodeId,
  data,
  all,
  connected,
  version,
  dirty,
  runState,
  runMsg,
  onRun,
  onChange,
}: {
  projectId: string;
  nodeId: string;
  data: FlowData;
  all: ProjectData;
  /** Nama analisis di hulu node ini menurut panah di canvas (kosong = semua analisis). */
  connected: string[];
  version: number;
  dirty: boolean;
  runState: RunState | null;
  runMsg: RunMsg;
  onRun: (key: string) => void;
  onChange: (patch: Partial<FlowData>) => void;
}) {
  const url = dirty ? null : `/api/projects/${projectId}/output/${nodeId}?v=${version}`;
  const { data: resp, error, loading } = useApi<OutputResp>(url);
  const [dl, setDl] = useState<string | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const blocks = Array.isArray(resp?.blocks) ? resp.blocks.filter((b) => b && typeof b === "object" && "type" in b) : [];
  const unavailable = Array.isArray(resp?.unavailable) ? resp.unavailable : [];
  const ready = blocks.length > 0 || !!resp?.runId;
  const cut = blocks.findIndex((b) => b.type === "h1" && b.text.startsWith("Lampiran"));
  const main = cut >= 0 ? blocks.slice(0, cut) : blocks;
  const appendix = cut >= 0 ? blocks.slice(cut + 1) : [];
  const summary = all.nodes.grand_design;
  const running = !!runState;

  async function get(format: "xlsx" | "docx" | "pdf") {
    setDl(format);
    setDlError(null);
    try {
      await download(`/api/projects/${projectId}/output/${nodeId}?format=${format}`);
    } catch (e) {
      setDlError((e as Error).message);
    } finally {
      setDl(null);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Nama dokumen">
        <Input value={data.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} placeholder="Dokumen grand design" />
      </Field>

      <div className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
        {connected.length ? (
          <>
            <b>Isi dokumen</b> mengikuti panah yang masuk ke elemen ini: {connected.join(", ")}.
          </>
        ) : (
          <>
            <b>Belum ada panah masuk</b>, jadi dokumen memakai semua analisis di canvas. Hubungkan panah dari analisis tertentu bila ingin membatasi isinya.
          </>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <span className="flex items-center gap-2 text-sm text-info">
              <Spinner /> {runState.label ?? "Analisis"} · {phaseLabel(runState.phase)}… ({Math.min(runState.step, runState.total)}/{runState.total})
            </span>
          ) : (
            <Button variant={summary?.status === "done" ? "secondary" : "primary"} onClick={() => onRun("grand_design")}>
              {summary?.status === "done" ? "Perbarui ringkasan eksekutif" : "Buat ringkasan eksekutif"}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted">“Buat ringkasan eksekutif” menjalankan dulu semua analisis yang belum selesai, lalu AI menulis ringkasan dari hasilnya.</p>
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
      </div>

      <section className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft/30 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-primary">Unduh dokumen</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => get("xlsx")} loading={dl === "xlsx"} disabled={!ready || running} title="Semua sheet analisis lengkap dengan rumus Excel yang tetap hidup">
            Unduh XLSX
          </Button>
          <Button onClick={() => get("docx")} loading={dl === "docx"} disabled={!ready || running}>
            Unduh DOCX
          </Button>
          <Button onClick={() => get("pdf")} loading={dl === "pdf"} disabled={!ready || running}>
            Unduh PDF
          </Button>
        </div>
        <p className="text-[11px] text-muted">
          <b className="text-text">XLSX paling lengkap dan paling mudah dicek</b>: satu tab per analisis seperti Excel framework, rumusnya tetap hidup — bisa dibuka di Excel atau
          Google Sheets. DOCX/PDF berisi ringkasan untuk dibaca atau dicetak.
        </p>
        <ErrorBox error={dlError} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Pratinjau dokumen</h3>
          <DraftLabel />
        </div>
        <p className="text-[11px] text-warn">DRAF — hasil AI wajib ditelaah pengurus sebelum dipakai.</p>
        {dirty ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> Menyimpan canvas…
          </p>
        ) : error && !resp ? (
          <ErrorBox error={error} />
        ) : !resp && loading ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> Menyusun pratinjau…
          </p>
        ) : !blocks.length ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
            Belum ada analisis yang dijalankan. Jalankan analisis, lalu dokumen tersusun otomatis di sini.
          </p>
        ) : (
          <>
            {unavailable.length > 0 && (
              <div className="rounded-md border border-warn/30 bg-warn-soft/60 px-3 py-2 text-[12.5px] text-warn">
                Belum selesai: {unavailable.map(unavailableText).join(", ")}.
              </div>
            )}
            <article className="space-y-2 rounded-md border border-border bg-surface p-3 shadow-sm">
              {main.map((b, i) => (
                <BlockView key={i} b={b} />
              ))}
              {appendix.length > 0 && (
                <details className="pt-2">
                  <summary className="cursor-pointer text-sm font-semibold">Lampiran: jejak bukti</summary>
                  <div className="mt-2 space-y-2">
                    {appendix.map((b, i) => (
                      <BlockView key={i} b={b} />
                    ))}
                  </div>
                </details>
              )}
            </article>
          </>
        )}
      </section>
    </div>
  );
}
