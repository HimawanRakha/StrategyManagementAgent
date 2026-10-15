"use client";
// Panel node input: unggah dokumen (PDF/DOCX/TXT) atau tempel teks, lihat potongan, hapus dokumen.
import { useRef, useState } from "react";
import { Badge, Button, ErrorBox, Field, Input, Spinner, Textarea, cx } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import type { DocRow, FlowData } from "./types";

type Chunk = { id: string; label: string; content: string };

function DocItem({ doc, affected, onDeleted, onChanged }: { doc: DocRow; affected: string[]; onDeleted: () => void; onChanged: () => void }) {
  const pending = !doc.reviewed_at;
  const warnings = doc.quality?.warnings ?? [];
  const [approvedNow, setApprovedNow] = useState(false);
  async function review(action: "approve" | "unapprove") {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/documents/${doc.id}`, { method: "POST", body: { action } });
      setApprovedNow(action === "approve");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !chunks) {
      try {
        const r = await api<{ chunks: Chunk[] }>(`/api/documents/${doc.id}`);
        setChunks(r.chunks);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }
  async function remove() {
    if (!confirm(`Hapus dokumen "${doc.filename}"? Analisis berikutnya tidak lagi membaca dokumen ini.`)) return;
    setBusy(true);
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <li className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button type="button" onClick={toggle} className="min-w-0 flex-1 text-left" title="Lihat potongan dokumen">
          <div className="truncate text-sm font-medium">{doc.filename}</div>
          <div className="text-[11px] text-muted">
            {doc.chunks} potongan · {fmt.int(doc.chars)} karakter {doc.is_values && <Badge tone="accent">nilai</Badge>}{" "}
            {pending ? <Badge tone="warn">perlu ditinjau</Badge> : <Badge tone="ok">disetujui</Badge>}
            {warnings.length > 0 && <Badge tone="warn">{warnings.length} peringatan</Badge>}
          </div>
        </button>
        <span className="text-xs text-muted">{open ? "▾" : "▸"}</span>
        <Button size="sm" variant="ghost" className="text-danger" onClick={remove} loading={busy} title="Hapus dokumen">
          Hapus
        </Button>
      </div>
      <ErrorBox error={error} />
      {(pending || warnings.length > 0) && (
        <div className="space-y-1.5 border-t border-border px-2.5 py-2 text-[11.5px]">
          {pending && (
            <p className="text-warn">
              Dokumen ini <b>belum dibaca analisis</b>. Buka potongannya, pastikan isinya terbaca benar, lalu setujui.
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-warn">
              {warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          )}
          {pending ? (
            <Button size="sm" variant="primary" onClick={() => review("approve")} loading={busy}>
              Setujui dokumen
            </Button>
          ) : null}
        </div>
      )}
      {approvedNow && (
        <p className="border-t border-border px-2.5 py-2 text-[11.5px] text-ok">
          Disetujui. Analisis yang membaca dokumen ini perlu dijalankan ulang agar memakainya
          {affected.length ? `: ${affected.join(", ")}` : " (analisis tanpa input tersambung membaca seluruh dokumen proyek)"}.
        </p>
      )}
      {!pending && !approvedNow && (
        <div className="border-t border-border px-2.5 py-1 text-right">
          <button type="button" className="text-[11px] text-muted hover:text-text hover:underline" onClick={() => review("unapprove")}>
            Batalkan persetujuan (berhenti dibaca analisis)
          </button>
        </div>
      )}
      {open && (
        <div className="max-h-80 space-y-1.5 overflow-y-auto border-t border-border bg-surface-2/50 p-2">
          {!chunks ? (
            <div className="flex items-center gap-2 p-2 text-xs text-muted">
              <Spinner /> Memuat potongan…
            </div>
          ) : chunks.length ? (
            chunks.map((c) => (
              <div key={c.id} className="rounded border border-border bg-surface p-2">
                <Badge tone="primary" className="mb-1 font-mono">
                  {c.label}
                </Badge>
                <p className="line-clamp-6 whitespace-pre-wrap text-[11.5px] leading-relaxed">{c.content}</p>
              </div>
            ))
          ) : (
            <p className="p-2 text-xs text-muted">Tidak ada potongan.</p>
          )}
        </div>
      )}
    </li>
  );
}

export function InputPanel({
  projectId,
  nodeId,
  data,
  docs,
  affected,
  onChange,
  onChanged,
}: {
  projectId: string;
  nodeId: string;
  data: FlowData;
  docs: DocRow[];
  /** Nama analisis yang panahnya menerima input ini (terdampak bila dokumennya berubah). */
  affected?: string[];
  onChange: (patch: Partial<FlowData>) => void;
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "text">("file");

  async function upload() {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("projectId", projectId);
      fd.set("inputNode", nodeId);
      fd.set("isValues", data.values ? "true" : "false");
      if (mode === "file") for (const f of files) fd.append("file", f);
      else {
        fd.set("text", text);
        if (name.trim()) fd.set("filename", name.trim().endsWith(".txt") ? name.trim() : `${name.trim()}.txt`);
      }
      await api("/api/documents", { form: fd });
      setFiles([]);
      setText("");
      setName("");
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canUpload = mode === "file" ? files.length > 0 : text.trim().length > 20;

  return (
    <div className="space-y-4">
      <Field label="Nama elemen">
        <Input value={data.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} placeholder="mis. Notulensi rapat" />
      </Field>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={!!data.values} onChange={(e) => onChange({ values: e.target.checked })} />
        <span>
          Dokumen nilai organisasi
          <span className="block text-xs text-muted">Dipakai untuk menyusun visi & misi (mis. AD/ART, nilai dasar).</span>
        </span>
      </label>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tambah dokumen</h3>
          <div className="flex rounded-md border border-border p-0.5 text-xs">
            {(["file", "text"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cx("rounded px-2 py-0.5", mode === m ? "bg-primary-soft font-medium text-primary" : "text-muted hover:text-text")}
              >
                {m === "file" ? "Unggah file" : "Tempel teks"}
              </button>
            ))}
          </div>
        </div>
        {mode === "file" ? (
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-xs file:mr-2 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-2.5 file:py-1.5 file:text-xs file:font-medium hover:file:bg-border/50"
            />
            <p className="text-[11px] text-muted">PDF, DOCX, atau TXT (maks. 15 MB per file). PDF hasil pindaian (gambar) tidak bisa dibaca.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama dokumen, mis. Notulensi rapat 12 Mei" className="w-full" />
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Tempel isi notulensi atau laporan di sini…" className="min-h-32 w-full" />
          </div>
        )}
        <ErrorBox error={error} />
        <Button variant="primary" onClick={upload} loading={busy} disabled={!canUpload}>
          {busy ? "Memproses dokumen…" : mode === "file" ? `Unggah${files.length ? ` ${files.length} file` : ""}` : "Simpan teks"}
        </Button>
        <p className="rounded-md bg-warn-soft/70 px-2.5 py-1.5 text-[11px] text-warn">
          Privasi: anonimkan nama orang (mis. “Ketua”, “Anggota A”) sebelum mengunggah.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          Dokumen di elemen ini <span className="font-normal text-muted">({docs.length})</span>
        </h3>
        {docs.length ? (
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <DocItem key={d.id} doc={d} affected={affected ?? []} onDeleted={onChanged} onChanged={onChanged} />
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted">Belum ada dokumen. Unggah file atau tempel teks di atas.</p>
        )}
        <p className="text-[11px] text-muted">
          Dokumen baru <b>ditinjau dulu</b>: periksa peringatan dan potongannya, lalu tekan Setujui — sebelum disetujui, analisis tidak membacanya. Klik dokumen untuk melihat potongannya (label seperti <span className="font-mono">C12</span> dipakai sebagai rujukan di hasil analisis). Analisis yang panahnya
          menerima input ini hanya membaca dokumen dari input yang tersambung; analisis tanpa input tersambung membaca seluruh dokumen proyek (bisa diatur di Pengaturan node).
        </p>
      </div>
    </div>
  );
}
