"use client";
// Pengaturan per node proses (bawaan & kustom) dan spesifikasi proses kustom. Semua tersimpan otomatis di canvas.
import type { ReactNode } from "react";
import { Field, Input, Textarea, cx } from "@/components/ui";
import type { CustomSpec, NodeSettings } from "@/lib/db/schema";
import type { FlowData, FlowPatch } from "./types";

const DEPTHS: { v: NonNullable<NodeSettings["depth"]>; label: string; hint: string }[] = [
  { v: "sedikit", label: "Sedikit", hint: "lebih cepat & hemat" },
  { v: "sedang", label: "Sedang", hint: "bawaan" },
  { v: "banyak", label: "Banyak", hint: "lebih teliti, lebih lama" },
];

export function Section({ title, children, defaultOpen = true, badge }: { title: string; children: ReactNode; defaultOpen?: boolean; badge?: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-sm font-medium hover:bg-surface-2">
        <span className="inline-block w-4 text-muted transition-transform group-open:rotate-90">▸</span>
        <span className="flex-1">{title}</span>
        {badge}
      </summary>
      <div className="space-y-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

/** Ubah satu kunci pengaturan; nilai kosong/undefined menghapus kuncinya. */
export function patchSettings(k: string, v: unknown): FlowPatch {
  return (data) => {
    const next: Record<string, unknown> = { ...(data.settings ?? {}) };
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete next[k];
    else next[k] = v;
    return { settings: Object.keys(next).length ? (next as FlowData["settings"]) : undefined };
  };
}

export function NodeSettingsSection({
  data,
  defaultLabel,
  done,
  onChange,
}: {
  data: FlowData;
  defaultLabel: string;
  /** Analisis sudah selesai → pengaturan baru berlaku setelah dijalankan ulang. */
  done: boolean;
  onChange: (patch: FlowPatch) => void;
}) {
  const s = data.settings ?? {};
  const set = (k: keyof NodeSettings, v: unknown) => onChange(patchSettings(k, v));
  const depth = s.depth ?? "sedang";
  const changed = !!(s.note?.trim() || s.focus?.trim() || s.model?.trim() || s.temperature !== undefined || depth !== "sedang" || s.sourceScope);
  return (
    <Section title="Pengaturan node" badge={changed ? <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">diatur</span> : null}>
      {done && changed && (
        <p className="rounded-md bg-info-soft px-2.5 py-1.5 text-[11.5px] text-info">Jalankan ulang agar pengaturan dipakai.</p>
      )}
      <Field label="Nama tampilan">
        <Input value={data.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} placeholder={defaultLabel} />
      </Field>
      <Field label="Catatan / instruksi tambahan untuk AI" hint="Ditambahkan ke instruksi AI saat analisis ini dijalankan.">
        <Textarea
          value={s.note ?? ""}
          maxLength={4000}
          onChange={(e) => set("note", e.target.value)}
          placeholder="contoh: Fokus pada program kerja divisi kaderisasi"
          className="min-h-20 w-full"
        />
      </Field>
      <Field label="Fokus pencarian dokumen" hint="Kata kunci tambahan agar AI menemukan bagian dokumen yang tepat.">
        <Input value={s.focus ?? ""} maxLength={500} onChange={(e) => set("focus", e.target.value)} placeholder="mis. kaderisasi, keuangan, alumni" />
      </Field>
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">Dokumen yang dibaca</span>
        <div className="flex rounded-md border border-border p-0.5 text-xs" role="radiogroup">
          {(
            [
              { v: undefined, label: "Otomatis" },
              { v: "tersambung", label: "Hanya input tersambung" },
              { v: "semua", label: "Semua dokumen proyek" },
            ] as const
          ).map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={s.sourceScope === o.v}
              onClick={() => set("sourceScope", o.v)}
              className={cx("flex-1 rounded px-2 py-1", s.sourceScope === o.v ? "bg-primary-soft font-semibold text-primary" : "text-muted hover:text-text")}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted">
          Otomatis: bila ada node Input yang panahnya masuk ke node ini, hanya dokumen dari input itu yang dibaca; bila tidak ada, semua dokumen proyek dibaca.
        </p>
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">Jumlah bukti yang dibaca</span>
        <div className="flex rounded-md border border-border p-0.5 text-xs" role="radiogroup">
          {DEPTHS.map((d) => (
            <button
              key={d.v}
              type="button"
              role="radio"
              aria-checked={depth === d.v}
              onClick={() => set("depth", d.v === "sedang" ? undefined : d.v)}
              className={cx("flex-1 rounded px-2 py-1", depth === d.v ? "bg-primary-soft font-semibold text-primary" : "text-muted hover:text-text")}
              title={d.hint}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted">{DEPTHS.find((d) => d.v === depth)?.hint}</p>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted">Kreativitas AI</span>
          <span className="flex items-center gap-2 text-xs">
            <span className="font-semibold tabular-nums">{s.temperature === undefined ? "default" : s.temperature.toFixed(1)}</span>
            {s.temperature !== undefined && (
              <button type="button" onClick={() => set("temperature", undefined)} className="text-primary hover:underline">
                reset
              </button>
            )}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={s.temperature ?? 0.2}
          onChange={(e) => set("temperature", Number(e.target.value))}
          className={cx("w-full accent-[var(--primary)]", s.temperature === undefined && "opacity-50")}
          aria-label="Kreativitas AI"
        />
        <div className="flex justify-between text-[10.5px] text-muted">
          <span>0 · ketat & konsisten</span>
          <span>1 · lebih bebas</span>
        </div>
      </div>
      <Field label="Model AI (opsional)" hint="Kosongkan untuk memakai model bawaan platform.">
        <Input value={s.model ?? ""} maxLength={100} onChange={(e) => set("model", e.target.value.trim() ? e.target.value : undefined)} placeholder="bawaan" />
      </Field>
    </Section>
  );
}

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "Balanced Scorecard",
    text: "Analisis Balanced Scorecard: susun tujuan per perspektif (keuangan, pelanggan, proses internal, pembelajaran)",
  },
  { label: "Analisis risiko", text: "Analisis risiko: daftar risiko utama, peluang terjadi, dampak" },
  { label: "Analisis stakeholder", text: "Analisis stakeholder: pihak berkepentingan, kepentingan, pengaruh" },
];

const MAX_COLS = 8;
const COL_PLACEHOLDERS = ["mis. Risiko", "mis. Peluang terjadi", "mis. Dampak", "mis. Mitigasi", "mis. Penanggung jawab", "mis. Tenggat", "mis. Catatan", "mis. Status"];
const COL_PRESETS: { label: string; columns: string[] }[] = [
  { label: "Analisis risiko", columns: ["Risiko", "Peluang", "Dampak", "Mitigasi"] },
  { label: "Balanced Scorecard", columns: ["Tujuan", "Indikator", "Target", "Inisiatif"] },
  { label: "Analisis stakeholder", columns: ["Pihak", "Kepentingan", "Pengaruh", "Strategi"] },
];

/** Pilihan "Bentuk hasil": daftar butir atau tabel dengan kolom yang dikunci. */
function OutputFormatField({ c, set }: { c: CustomSpec; set: (p: Partial<CustomSpec>) => void }) {
  const table = c.format === "table";
  const cols = c.columns?.length ? c.columns : [""];
  const filled = cols.filter((x) => x.trim()).length;
  const setCols = (next: string[]) => set({ columns: next });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    setCols(next);
  };
  const mentionsTable = !table && /\btabel\b/i.test(c.instruction ?? "");
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted">Bentuk hasil</span>
      <div className="flex rounded-md border border-border bg-surface p-0.5 text-xs" role="radiogroup" aria-label="Bentuk hasil">
        {(
          [
            ["list", "Daftar butir"],
            ["table", "Tabel"],
          ] as const
        ).map(([v, label]) => {
          const on = (v === "table") === table;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => set(v === "table" ? { format: "table", columns: c.columns?.length ? c.columns : [""] } : { format: "list" })}
              className={cx("flex-1 rounded px-2 py-1.5", on ? "bg-accent/10 font-semibold text-accent" : "text-muted hover:text-text")}
            >
              {label}
            </button>
          );
        })}
      </div>
      {mentionsTable && (
        <p className="rounded-md bg-warn-soft px-2.5 py-1.5 text-[11.5px] text-warn">
          Instruksi menyebut “tabel”, tetapi bentuk hasil masih <b>Daftar butir</b>. Pilih <b>Tabel</b> agar bentuknya dijamin.
        </p>
      )}
      {table && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Kolom tabel</span>
            <span className="text-[11px] text-muted">
              {cols.length}/{MAX_COLS} kolom · kolom ID dan Bukti ditambahkan otomatis
            </span>
          </div>
          <ol className="space-y-1.5">
            {cols.map((col, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted">{i + 1}.</span>
                <Input
                  value={col}
                  maxLength={60}
                  onChange={(e) => setCols(cols.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={COL_PLACEHOLDERS[i] ?? "Nama kolom"}
                  aria-label={`Nama kolom ${i + 1}`}
                  className={cx("h-8 min-w-0 flex-1", !col.trim() && filled === 0 && "border-warn")}
                />
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-30" aria-label="Naikkan kolom" title="Naikkan">
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === cols.length - 1}
                  className="rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-30"
                  aria-label="Turunkan kolom"
                  title="Turunkan"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setCols(cols.filter((_, j) => j !== i))}
                  disabled={cols.length <= 1}
                  className="rounded px-1.5 py-1 text-xs text-danger hover:bg-danger-soft disabled:opacity-30"
                  aria-label="Hapus kolom"
                  title="Hapus kolom"
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => setCols([...cols, ""])}
            disabled={cols.length >= MAX_COLS}
            className="text-[12px] font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
          >
            + Tambah kolom
          </button>
          {filled === 0 && <p className="text-[11.5px] text-warn">Isi minimal satu nama kolom — tanpa kolom, hasil dibuat sebagai daftar butir.</p>}
          <div className="space-y-1">
            <span className="text-[11px] text-muted">Pakai kolom siap pakai:</span>
            <div className="flex flex-wrap gap-1.5">
              {COL_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setCols(p.columns)}
                  className="rounded-full border border-accent/30 bg-surface px-2.5 py-1 text-[11.5px] text-accent hover:bg-[#eef0fd]"
                  title={p.label}
                >
                  {p.columns.join(" | ")}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted">
        <b className="text-text">Bentuk tabel dijamin:</b> kolom dikunci sesuai yang Anda tentukan dan setiap baris wajib mengisi semua kolom — jika tidak, validator menolak
        dan AI memperbaiki (bila validator dipasang). Isi tabel tetap hasil AI, jadi telaah sebelum dipakai. Menulis “buat tabel” di instruksi saja tidak cukup — pilih
        bentuk <b className="text-text">Tabel</b> di sini.
      </p>
    </div>
  );
}

export function CustomSpecSection({ data, parents, onChange }: { data: FlowData; parents: string[]; onChange: (patch: FlowPatch) => void }) {
  const c: CustomSpec = data.custom ?? { name: "", instruction: "" };
  const set = (p: Partial<CustomSpec>) => onChange((d) => ({ custom: { ...(d.custom ?? { name: "", instruction: "" }), ...p } }));
  const missingName = !c.name?.trim();
  const missingInstr = !c.instruction?.trim();
  return (
    <section className="space-y-3 rounded-lg border border-accent/30 bg-[#fafaff] p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-accent">Proses buatan Anda</h3>
      <Field label={<>Nama proses <span className="text-danger">*</span></>}>
        <Input
          value={c.name ?? ""}
          maxLength={120}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="mis. Analisis risiko"
          className={cx(missingName && "border-warn")}
          autoFocus={missingName}
        />
      </Field>
      <Field
        label={<>Instruksi untuk AI <span className="text-danger">*</span></>}
        hint="Tulis apa yang harus dikerjakan AI. Hasilnya berupa butir-butir (atau baris tabel — lihat Bentuk hasil) yang masing-masing menyertakan bukti dari dokumen."
      >
        <Textarea
          value={c.instruction ?? ""}
          maxLength={4000}
          onChange={(e) => set({ instruction: e.target.value })}
          placeholder="mis. Daftar risiko utama organisasi, perkiraan peluang terjadi, dan dampaknya"
          className={cx("min-h-32 w-full", missingInstr && "border-warn")}
        />
      </Field>
      <div className="space-y-1">
        <span className="text-[11px] text-muted">Contoh (klik untuk memakai):</span>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() =>
                set({
                  instruction: c.instruction?.trim() ? `${c.instruction.trim()}\n${ex.text}` : ex.text,
                  ...(missingName ? { name: ex.label } : {}),
                })
              }
              className="rounded-full border border-accent/30 bg-surface px-2.5 py-1 text-[11.5px] text-accent hover:bg-[#eef0fd]"
              title={ex.text}
            >
              + {ex.label}
            </button>
          ))}
        </div>
      </div>
      <OutputFormatField c={c} set={set} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Awalan ID butir" hint={`Butir diberi ID ${(c.prefix || "K").toUpperCase()}1, ${(c.prefix || "K").toUpperCase()}2, …`} className="w-36">
          <Input
            value={c.prefix ?? "K"}
            maxLength={4}
            onChange={(e) => set({ prefix: e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase() })}
            placeholder="K"
          />
        </Field>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--primary)]"
          checked={c.requireEvidence !== false}
          onChange={(e) => set({ requireEvidence: e.target.checked })}
        />
        <span>
          Setiap butir wajib punya kutipan dokumen
          <span className="block text-xs text-muted">Matikan bila butir boleh disimpulkan dari hasil analisis sebelumnya (wajib menyebut rujukannya).</span>
        </span>
      </label>
      <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px]">
        <b>Membaca hasil dari:</b> {parents.length ? parents.join(", ") : "hanya dokumen"}
        <span className="block text-[11px] text-muted">Tarik panah dari analisis lain ke proses ini agar hasilnya ikut dibaca.</span>
      </p>
    </section>
  );
}
