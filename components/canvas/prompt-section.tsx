"use client";
// Bagian "Prompt AI" di panel node: menampilkan prompt System + User yang dikirim ke AI, kueri pencarian dokumen,
// dan konfigurasi panggilan API. Dimuat hanya saat diminta (tidak memanggil AI).
import { useState } from "react";
import { Badge, Button, ErrorBox, Spinner } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import { Section } from "./node-settings";

type PromptInfo = {
  label: string;
  kind: "llm" | "code";
  computedBy: string;
  hasRun: boolean;
  evidenceCount: number;
  queries: { focus: string; text: string; k: number; valuesOnly: boolean }[];
  system: string | null;
  user: string | null;
  config: { model: string; temperature: number; responseMimeType: string };
};

export function PromptSection({ nodeRunId }: { nodeRunId?: string }) {
  const [info, setInfo] = useState<PromptInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!nodeRunId) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await api<PromptInfo>(`/api/node-runs/${nodeRunId}/prompt`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Prompt AI" defaultOpen={false}>
      <p className="text-[11px] leading-relaxed text-muted">
        Perintah yang dikirim ke AI untuk analisis ini. Templatnya tetap (ditulis di kode per analisis); bagian dalam kurung kurawal di templat diisi
        otomatis dengan nama organisasi, potongan dokumen hasil pencarian, hasil analisis sebelumnya, dan pengaturan node Anda.
      </p>
      {!nodeRunId ? (
        <p className="text-xs text-muted">Jalankan analisis ini dulu agar prompt bisa disusun dari bukti yang dipakai.</p>
      ) : !info ? (
        <Button size="sm" variant="secondary" onClick={load} loading={busy}>
          Tampilkan prompt
        </Button>
      ) : null}
      {busy && !info && <Spinner />}
      {error && <ErrorBox error={error} />}
      {info && (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap gap-1.5">
            <Badge>model {info.config.model}</Badge>
            <Badge>suhu {fmt.num(info.config.temperature, 2)}</Badge>
            <Badge>keluaran {info.config.responseMimeType}</Badge>
            <Badge>{info.evidenceCount} potongan bukti</Badge>
          </div>
          {info.kind === "code" || !info.system ? (
            <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-muted">
              Analisis ini dihitung program, tanpa prompt penyusun: {info.computedBy}.
            </p>
          ) : (
            <>
              <PromptBlock title="System — aturan dan peran" text={info.system} />
              <PromptBlock title="User — bahan yang diberikan" text={info.user ?? ""} />
            </>
          )}
          {info.queries.length > 0 && (
            <div>
              <h4 className="mb-1 font-semibold text-muted">Kueri pencarian dokumen (RAG)</h4>
              <ul className="space-y-1">
                {info.queries.map((q, i) => (
                  <li key={i} className="rounded border border-border px-2 py-1">
                    <span className="font-medium">{q.focus}</span> <span className="text-muted">· {q.k} potongan teratas{q.valuesOnly ? " · hanya dokumen nilai" : ""}</span>
                    <div className="text-muted">{q.text}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-muted">
            Disusun ulang dari bukti yang tersimpan saat analisis terakhir dijalankan. Bila analisis sebelumnya sudah dijalankan ulang sesudahnya, bagian
            &ldquo;hasil analisis sebelumnya&rdquo; memakai versi terbaru. Prompt pemeriksaan dan perbaikan oleh validator tidak ditampilkan di sini.
          </p>
          <Button size="sm" variant="ghost" onClick={load} loading={busy}>
            Muat ulang
          </Button>
        </div>
      )}
    </Section>
  );
}

function PromptBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="font-semibold text-muted">
          {title} <span className="font-normal">· {fmt.int(text.length)} karakter</span>
        </h4>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard tidak tersedia */
            }
          }}
        >
          {copied ? "Tersalin" : "Salin"}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed">{text}</pre>
    </div>
  );
}
