"use client";
// Bagian Laporan "Saran langkah berikutnya": aksi yang perlu dilakukan dan node baru yang disarankan.
import { useState } from "react";
import { Badge, Button, Empty } from "@/components/ui";
import type { NextAction, Suggestion } from "./next-steps";

const PRIORITY: Record<Suggestion["priority"], { label: string; tone: "danger" | "warn" | "primary" }> = {
  1: { label: "Lakukan dulu", tone: "danger" },
  2: { label: "Disarankan", tone: "warn" },
  3: { label: "Pengembangan", tone: "primary" },
};

export function NextStepsSection({
  suggestions,
  running,
  onAction,
}: {
  suggestions: Suggestion[];
  running: boolean;
  /** Jalankan aksi saran (tambah node ke canvas, sorot analisis). */
  onAction: (a: NextAction) => void;
}) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  if (!suggestions.length) return <Empty>Tidak ada saran tambahan — dokumen sudah ditinjau, bukti cukup, dan semua analisis framework sudah terpasang.</Empty>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-[13px] leading-relaxed text-muted">
        Disusun otomatis dari kondisi dokumen, bukti yang dipakai AI, pertanyaan AI yang terbuka, dan analisis framework yang belum ada di canvas. Saran
        &ldquo;Pengembangan&rdquo; bisa langsung ditambahkan ke canvas sebagai node baru (lengkap dengan instruksi), lalu dijalankan.
      </p>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.id} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={PRIORITY[s.priority].tone}>{PRIORITY[s.priority].label}</Badge>
              <span className="min-w-0 flex-1 font-medium">{s.title}</span>
              {s.action && !done[s.id] && (
                <Button
                  size="sm"
                  variant={s.action.type === "select" ? "ghost" : "secondary"}
                  disabled={running && s.action.type !== "select"}
                  title={running && s.action.type !== "select" ? "Tunggu run selesai sebelum mengubah canvas" : undefined}
                  onClick={() => {
                    onAction(s.action!);
                    if (s.action!.type !== "select") setDone((d) => ({ ...d, [s.id]: true }));
                  }}
                >
                  {s.action.type === "select" ? "Sorot di canvas" : "Tambahkan ke canvas"}
                </Button>
              )}
              {done[s.id] && <span className="text-xs text-ok">Ditambahkan — jalankan analisisnya dari canvas.</span>}
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{s.detail}</p>
            {s.action?.type === "addCustom" && (
              <details className="mt-1 text-[12px]">
                <summary className="cursor-pointer text-primary">Lihat instruksi yang akan dipakai</summary>
                <p className="mt-1 rounded bg-surface-2 px-2 py-1.5 leading-relaxed">{s.action.instruction}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
