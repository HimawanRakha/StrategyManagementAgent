"use client";
// Penampil bukti: kutipan disorot di potongan sumber, isi potongan, dan panel samping.
import type { ReactNode } from "react";
import { Badge, cx } from "@/components/ui";
import type { Evidence } from "@/lib/nodes/schemas";
import { isUserChunk, type ChunkInfo, type ChunkLookup } from "./types";

// Normalisasi per karakter (selaras dengan norm() di lib/validators/common.ts) sambil menyimpan indeks asal.
const normChar = (c: string) =>
  c
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-");

function normalizeWithMap(s: string) {
  let out = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (!prevSpace) {
        out += " ";
        map.push(i);
        prevSpace = true;
      }
      continue;
    }
    const n = normChar(c);
    for (let k = 0; k < n.length; k++) map.push(i);
    out += n;
    prevSpace = false;
  }
  return { out, map };
}

const normText = (s: string) => normalizeWithMap(s).out.trim();

/** Cari posisi kutipan di isi potongan (tidak peka huruf besar/kecil dan spasi). */
export function findQuote(content: string, quote: string): [number, number] | null {
  const { out, map } = normalizeWithMap(content);
  const candidates = [normText(quote), normText(quote.replace(/^["'“”‘’.…\s]+|["'“”‘’.…\s]+$/g, ""))];
  for (const q of candidates) {
    if (!q) continue;
    const at = out.indexOf(q);
    if (at >= 0) return [map[at], map[at + q.length - 1] + 1];
  }
  return null;
}

export function QuoteInChunk({ content, quote }: { content: string; quote: string }) {
  const pos = findQuote(content, quote);
  if (!pos)
    return (
      <div className="space-y-1.5">
        <div className="rounded border border-warn/30 bg-warn-soft px-2 py-1 text-xs text-warn">Kutipan tidak ditemukan di potongan.</div>
        <p className="text-xs italic text-muted">“{quote}”</p>
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{content}</p>
      </div>
    );
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed">
      {content.slice(0, pos[0])}
      <mark>{content.slice(pos[0], pos[1])}</mark>
      {content.slice(pos[1])}
    </p>
  );
}

export function UserAnswerBadge() {
  return (
    <Badge tone="accent" title="Bukti berasal dari jawaban pengguna atas pertanyaan agen (label U…)">
      jawaban pengguna
    </Badge>
  );
}

/** Daftar bukti satu elemen: setiap kutipan ditampilkan di dalam potongan sumbernya. */
export function EvidenceList({ evidence, lookup }: { evidence: Evidence[]; lookup: ChunkLookup }) {
  if (!evidence.length) return <p className="text-xs text-muted">Tidak ada bukti.</p>;
  return (
    <ul className="space-y-2.5">
      {evidence.map((ev, i) => {
        const chunk = lookup(ev.chunkId);
        const user = isUserChunk(ev.chunkId, chunk?.kind);
        return (
          <li key={`${ev.chunkId}-${i}`} className={cx("rounded-md border p-2.5", user ? "border-accent/30 bg-accent/5" : "border-border bg-surface")}>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={user ? "accent" : "primary"} className="font-mono">
                {ev.chunkId}
              </Badge>
              {chunk && <span className="truncate text-[11px] text-muted">{chunk.source}</span>}
              {user && <UserAnswerBadge />}
            </div>
            {chunk ? (
              <QuoteInChunk content={chunk.content} quote={ev.quote} />
            ) : (
              <div className="space-y-1.5">
                <div className="rounded border border-warn/30 bg-warn-soft px-2 py-1 text-xs text-warn">
                  Potongan {ev.chunkId} tidak ada di bukti yang tersedia; kutipan tidak dapat diperiksa.
                </div>
                <p className="text-xs italic text-muted">“{ev.quote}”</p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Isi satu potongan bukti (tanpa kutipan tertentu), mis. untuk rujukan sel tabel. */
export function ChunkCard({ id, chunk }: { id: string; chunk: ChunkInfo | undefined }) {
  const user = isUserChunk(id, chunk?.kind);
  return (
    <div className={cx("rounded-md border p-2.5", user ? "border-accent/30 bg-accent/5" : "border-border bg-surface")}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={user ? "accent" : "primary"} className="font-mono">
          {id}
        </Badge>
        {chunk && <span className="truncate text-[11px] text-muted">{chunk.source}</span>}
        {user && <UserAnswerBadge />}
      </div>
      {chunk ? (
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">{chunk.content}</p>
      ) : (
        <p className="text-xs text-warn">Potongan {id} tidak ada di bukti analisis ini.</p>
      )}
    </div>
  );
}

/** Panel samping (laci kanan) untuk bukti/jejak. */
export function SidePanel({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text" aria-label="Tutup panel">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}
