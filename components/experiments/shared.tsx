"use client";
// Tipe respons API dan potongan UI bersama untuk modul eksperimen (hanya tipe dari modul server).
import type { ReactNode } from "react";
import type { StageParams } from "@/lib/experiment/parameters";
import type { Choice } from "@/lib/experiment/propagation";
import { nodeLabel, NODE_KEYS } from "@/lib/nodes/meta";
import { Badge, ErrorBox, cx } from "@/components/ui";
import { fmt } from "@/lib/client/api";

/** Proporsi + interval Wilson 95%. NaN dari server menjadi null setelah JSON. */
export type Wil = { p: number | null; lo: number; hi: number; n: number };

export type StageRow = Omit<StageParams, "e" | "d" | "r" | "h" | "key"> & { key: string; e: Wil; d: Wil; r: Wil; h: Wil };
export type Placement = Record<string, Choice>;

export type ParamsResponse = {
  stages: StageRow[];
  kappa: number | null;
  kappaN: number;
  dh: number;
  qspmTau: { tau: number; pairs: number } | null;
  comparison: { tag: string; runs: number; annotated: number; actual: Wil; predicted: number; placement: Placement }[];
  tags: string[];
};

/** Nilai berhingga atau NaN (untuk null/undefined dari JSON). */
export const fin = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? NaN : x);

/** Sesi berakhir (401): route mengembalikan pesan "Silakan masuk …". */
export const isAuthExpired = (msg: string | null | undefined) => !!msg && /(HTTP 401|Silakan masuk)/i.test(msg);

/** Angka dari input teks; koma desimal diterima. */
export function parseNum(s: string): number {
  const t = s.trim().replace(",", ".");
  if (!t) return NaN;
  return Number(t);
}

/** Daftar angka "0, 5, 10" (dipisah koma/titik koma/spasi; desimal pakai titik). */
export function parseList(s: string): number[] {
  return [...new Set(s.split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
}

export const stageOrder = (a: string, b: string) => {
  const ia = (NODE_KEYS as readonly string[]).indexOf(a);
  const ib = (NODE_KEYS as readonly string[]).indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
};

/** Tampilan galat API yang seragam; 401 berarti sesi login berakhir. */
export function ApiErrorNote({ message }: { message?: string | null }) {
  if (!message) return null;
  if (isAuthExpired(message))
    return (
      <div className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-4 text-sm text-warn">
        <p className="font-semibold">Sesi login sudah berakhir.</p>
        <p className="mt-1 text-text/80">
          Silakan{" "}
          <a href="/login" className="font-medium underline">
            masuk lagi
          </a>{" "}
          dengan kata sandi tim, lalu buka kembali halaman ini.
        </p>
      </div>
    );
  return <ErrorBox error={message} />;
}

/** Proporsi dengan interval Wilson; "–" bila belum ada data. */
export function WilsonCell({ w, digits = 3 }: { w: Wil | null | undefined; digits?: number }) {
  if (!w || !w.n) return <span className="text-muted">–</span>;
  const wide = w.hi - w.lo > 0.3;
  return (
    <div className="tabular-nums leading-tight">
      <div className="font-medium">{fmt.num(fin(w.p), digits)}</div>
      <div className={cx("text-[11px]", wide ? "text-warn" : "text-muted")} title={wide ? "Interval lebar: butuh lebih banyak run" : "Interval Wilson 95%"}>
        [{fmt.num(w.lo, 2)}–{fmt.num(w.hi, 2)}] n={w.n}
      </div>
    </div>
  );
}

/** Arti pilihan pemeriksaan dalam kata-kata (tanpa singkatan). */
const CHIP: Record<string, { label: string; tone: "neutral" | "info" | "accent" | "primary"; title: string }> = {
  none: { label: "tanpa pemeriksaan", tone: "neutral", title: "Tidak diperiksa validator maupun manusia" },
  v: { label: "validator", tone: "info", title: "Validator = pemeriksaan otomatis oleh program/AI yang juga mencoba memperbaiki hasil" },
  m: { label: "tinjauan manusia", tone: "accent", title: "Tinjauan manusia = pengurus membaca dan menyetujui hasil sebelum dipakai" },
  vm: { label: "validator + tinjauan manusia", tone: "primary", title: "Diperiksa validator lalu ditinjau manusia" },
};

export function choiceCode(c: Choice | undefined) {
  if (!c) return "none";
  return c.validator && c.human ? "vm" : c.validator ? "v" : c.human ? "m" : "none";
}

/** Pilihan pemeriksaan dalam kata-kata: "validator", "tinjauan manusia", "validator + tinjauan manusia", "tanpa pemeriksaan". */
export const choiceWords = (c: Choice | undefined) => CHIP[choiceCode(c)].label;

export function PlacementChip({ c }: { c: Choice | undefined }) {
  const s = CHIP[choiceCode(c)];
  return (
    <Badge tone={s.tone} title={s.title}>
      {s.label}
    </Badge>
  );
}

/** Keterangan istilah pemeriksaan (dipasang di bawah tabel penempatan). */
export function PlacementLegend({ className }: { className?: string }) {
  return (
    <p className={cx("text-[11px] leading-relaxed text-muted", className)}>
      <b className="font-medium text-text">Validator</b> = pemeriksaan otomatis (program + AI) yang mengecek hasil lalu mencoba memperbaikinya.{" "}
      <b className="font-medium text-text">Tinjauan manusia</b> = pengurus membaca dan menyetujui hasil sebelum dipakai langkah berikutnya.{" "}
      <b className="font-medium text-text">Tanpa pemeriksaan</b> = hasil AI langsung dipakai.
    </p>
  );
}

/** Penempatan dalam kalimat: "Validator di: SWOT, QSPM · Tinjauan manusia di: Cascading" (hanya tahap yang dicek). */
export function PlacementList({ placement, keys }: { placement: Placement; keys?: string[] }) {
  const ks = (keys ?? Object.keys(placement)).slice().sort(stageOrder);
  const val = ks.filter((k) => placement[k]?.validator);
  const hum = ks.filter((k) => placement[k]?.human);
  if (!val.length && !hum.length) return <span className="text-xs text-muted">tanpa pemeriksaan di semua analisis</span>;
  return (
    <div className="space-y-0.5 text-xs leading-snug">
      {val.length > 0 && (
        <div>
          <span className="font-medium text-info">Validator di:</span> {val.map(nodeLabel).join(", ")}
        </div>
      )}
      {hum.length > 0 && (
        <div>
          <span className="font-medium text-accent">Tinjauan manusia di:</span> {hum.map(nodeLabel).join(", ")}
        </div>
      )}
    </div>
  );
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted", className)}>{children}</div>;
}

/** Warna seri kategorikal (urutan tetap, palet tervalidasi skill dataviz, mode terang). */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const CHART_GRID = "#e6e9ed";
export const CHART_AXIS = "#5b6573";
