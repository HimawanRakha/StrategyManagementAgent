// SGSOP — Posisi organisasi pada diagram SWOT (Rangkuti): titik (x = total IFAS = S − W, y = total EFAS = O − T).
// Node kode (tanpa LLM). compute() selalu menghitung ulang dari IFAS/EFAS terbaru agar edit di sana ikut terbawa.
import { z } from "zod";
import type { Kuadran, MatrixScoreComputed, PosisiComputed } from "../contracts";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { result } from "@/lib/validators/common";
import { GridBuilder, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { isObj, type Inputs } from "./common";

/** Output mentah: salinan total IFAS/EFAS saat node dijalankan (cadangan bila hulu tidak tersedia saat compute ulang). */
export const PosisiRaw = z.object({
  x: z.number(),
  y: z.number(),
});
export type PosisiRaw = z.infer<typeof PosisiRaw>;

export type PosisiOutput = PosisiRaw &
  PosisiComputed & {
    /** "Kuadran II — Diversifikasi (ST)". */
    label: string;
    arti: string;
    ifas: { total: number; positive: number; negative: number; available: boolean };
    efas: { total: number; positive: number; negative: number; available: boolean };
  };

export const KUADRAN_INFO: Record<Kuadran, { strategi: string; fokus: PosisiComputed["fokus"]; posisi: string; arti: string; fill: string }> = {
  I: {
    strategi: "Agresif",
    fokus: "SO",
    posisi: "kanan atas (IFAS ≥ 0, EFAS ≥ 0)",
    arti: "Kekuatan lebih besar dari kelemahan dan peluang lebih besar dari ancaman: dukung strategi agresif — gunakan kekuatan untuk meraih peluang (SO).",
    fill: "D9F2E3",
  },
  II: {
    strategi: "Diversifikasi",
    fokus: "ST",
    posisi: "kanan bawah (IFAS ≥ 0, EFAS < 0)",
    arti: "Organisasi kuat secara internal tetapi menghadapi ancaman lebih besar dari peluang: gunakan kekuatan untuk menghadapi ancaman (diversifikasi, ST).",
    fill: "FFF2CC",
  },
  III: {
    strategi: "Turnaround",
    fokus: "WO",
    posisi: "kiri atas (IFAS < 0, EFAS ≥ 0)",
    arti: "Peluang besar tetapi kelemahan internal lebih besar dari kekuatan: benahi kelemahan dengan memanfaatkan peluang (turnaround, WO).",
    fill: "DDEBF7",
  },
  IV: {
    strategi: "Defensif",
    fokus: "WT",
    posisi: "kiri bawah (IFAS < 0, EFAS < 0)",
    arti: "Kelemahan lebih besar dari kekuatan dan ancaman lebih besar dari peluang: strategi bertahan — kurangi kelemahan dan hindari ancaman (WT).",
    fill: "FAD7D7",
  },
};

/** Kuadran diagram SWOT: sumbu nol dihitung ke sisi positif (x ≥ 0, y ≥ 0). */
export function kuadranOf(x: number, y: number): Kuadran {
  if (x >= 0) return y >= 0 ? "I" : "II";
  return y >= 0 ? "III" : "IV";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function sideOf(m: MatrixScoreComputed | undefined) {
  const rows = Array.isArray(m?.rows) ? m!.rows : [];
  const sumRows = rows.reduce((s, r) => s + (finite(r?.score) ? r.score : 0), 0);
  const total = finite(m?.total) ? m!.total : sumRows;
  const positive = finite(m?.totalPositive) ? m!.totalPositive : rows.reduce((s, r) => s + (finite(r?.score) && r.score > 0 ? r.score : 0), 0);
  const negative = finite(m?.totalNegative) ? m!.totalNegative : rows.reduce((s, r) => s + (finite(r?.score) && r.score < 0 ? -r.score : 0), 0);
  return { total, positive, negative, available: !!m && (finite(m.total) || rows.length > 0) };
}

/** Hitung posisi dari IFAS/EFAS di `inputs`; bila tidak ada, pakai salinan di output mentah. */
export function computePosisi(raw: Partial<PosisiRaw> | undefined, inputs: Inputs): PosisiOutput {
  const ifas = sideOf(inputs.ifas as MatrixScoreComputed | undefined);
  const efas = sideOf(inputs.efas as MatrixScoreComputed | undefined);
  const x = ifas.available ? ifas.total : finite(raw?.x) ? raw!.x : 0;
  const y = efas.available ? efas.total : finite(raw?.y) ? raw!.y : 0;
  const kuadran = kuadranOf(x, y);
  const info = KUADRAN_INFO[kuadran];
  return {
    x,
    y,
    kuadran,
    strategi: info.strategi,
    fokus: info.fokus,
    label: `Kuadran ${kuadran} — ${info.strategi} (${info.fokus})`,
    arti: info.arti,
    ifas: { ...ifas, total: x },
    efas: { ...efas, total: y },
  };
}

const asOutput = (out: unknown, inputs: Inputs): PosisiOutput => {
  const o = isObj(out) ? (out as Partial<PosisiOutput>) : {};
  if (o.kuadran && o.label && o.ifas && o.efas) return o as PosisiOutput;
  return computePosisi(o, inputs);
};

const KUADRAN_F = (xa: string, ya: string) => `IF(${xa}>=0,IF(${ya}>=0,"I","II"),IF(${ya}>=0,"III","IV"))`;
const STRATEGI_F = (xa: string, ya: string) =>
  `IF(${xa}>=0,IF(${ya}>=0,"Agresif (SO)","Diversifikasi (ST)"),IF(${ya}>=0,"Turnaround (WO)","Defensif (WT)"))`;

export function posisiSheet(o: PosisiOutput): Grid {
  const g = new GridBuilder("posisi", "SGSOP", "Organizational Position");
  g.set(0, 0, "ORGANIZATIONAL POSITION", { style: "title", cs: 4 });
  // Tabel seperti Excel (A20:D22): Internal Factor | External Factor
  g.set(2, 0, "Internal Factor", { style: "header", cs: 2, center: true });
  g.set(2, 2, "External Factor", { style: "header", cs: 2, center: true });
  g.set(3, 0, "IFAS", { style: "subheader", rs: 2, center: true });
  g.set(3, 1, "S + W", { style: "subheader", center: true });
  g.set(3, 2, "EFAS", { style: "subheader", rs: 2, center: true });
  g.set(3, 3, "O + T", { style: "subheader", center: true });
  const xa = g.set(4, 1, o.x, {
    f: "{{ifas!total}}",
    fmt: "0.000",
    src: "hitung",
    center: true,
    explain: `Sumbu X = total IFAS = Σ skor kekuatan − Σ skor kelemahan = ${num(o.ifas.positive)} − ${num(o.ifas.negative)} = ${num(o.x)} (diambil dari sheet IFAS, Excel: =ESIFAS!T27)`,
  });
  const ya = g.set(4, 3, o.y, {
    f: "{{efas!total}}",
    fmt: "0.000",
    src: "hitung",
    center: true,
    explain: `Sumbu Y = total EFAS = Σ skor peluang − Σ skor ancaman = ${num(o.efas.positive)} − ${num(o.efas.negative)} = ${num(o.y)} (diambil dari sheet EFAS, Excel: =ESEFAS!T15)`,
  });
  g.anchor("x", 4, 1);
  g.anchor("y", 4, 3);

  // Hasil
  const info = KUADRAN_INFO[o.kuadran];
  g.set(6, 0, "Kuadran", { style: "label" });
  g.set(6, 1, o.kuadran, {
    f: KUADRAN_F(xa, ya),
    src: "hitung",
    center: true,
    fill: info.fill,
    explain: `X = ${num(o.x)} ${o.x >= 0 ? "≥ 0 (kekuatan > kelemahan)" : "< 0 (kelemahan > kekuatan)"} dan Y = ${num(o.y)} ${o.y >= 0 ? "≥ 0 (peluang > ancaman)" : "< 0 (ancaman > peluang)"} → kuadran ${o.kuadran}, ${info.posisi}`,
  });
  g.set(7, 0, "Strategi yang didukung", { style: "label" });
  g.set(7, 1, `${info.strategi} (${info.fokus})`, {
    f: STRATEGI_F(xa, ya),
    src: "hitung",
    cs: 3,
    fill: info.fill,
    explain: `Kuadran ${o.kuadran} → strategi ${info.strategi}; fokus strategi ${info.fokus} di matriks SWOT. ${info.arti}`,
  });
  g.anchor("kuadran", 6, 1);

  // Rincian dari IFAS/EFAS
  g.set(9, 0, "Rincian", { style: "subheader", cs: 4 });
  g.row(10, 0, ["Besaran", "Nilai", "Besaran", "Nilai"], { style: "header" });
  g.set(11, 0, "Σ skor kekuatan (S)", { style: "label" });
  g.set(11, 1, o.ifas.positive, { fmt: "0.000", src: "hitung", note: "Dari IFAS: jumlah skor semua faktor S." });
  g.set(12, 0, "Σ skor kelemahan (W)", { style: "label" });
  g.set(12, 1, o.ifas.negative, { fmt: "0.000", src: "hitung", note: "Dari IFAS: jumlah |skor| semua faktor W (di IFAS ditulis negatif)." });
  g.set(11, 2, "Σ skor peluang (O)", { style: "label" });
  g.set(11, 3, o.efas.positive, { fmt: "0.000", src: "hitung", note: "Dari EFAS: jumlah skor semua faktor O." });
  g.set(12, 2, "Σ skor ancaman (T)", { style: "label" });
  g.set(12, 3, o.efas.negative, { fmt: "0.000", src: "hitung", note: "Dari EFAS: jumlah |skor| semua faktor T (di EFAS ditulis negatif)." });

  // Legenda kuadran
  g.set(14, 0, "Arti kuadran (diagram SWOT Rangkuti)", { style: "subheader", cs: 4 });
  g.row(15, 0, ["Kuadran", "Letak", "Strategi", "Arti"], { style: "header" });
  (["I", "II", "III", "IV"] as Kuadran[]).forEach((k, i) => {
    const inf = KUADRAN_INFO[k];
    const here = k === o.kuadran;
    const opt = { style: here ? ("label" as const) : ("text" as const), fill: here ? inf.fill : undefined, src: "tetap" as const };
    g.set(16 + i, 0, here ? `${k} ← posisi organisasi` : k, opt);
    g.set(16 + i, 1, inf.posisi, opt);
    g.set(16 + i, 2, `${inf.strategi} (${inf.fokus})`, opt);
    g.set(16 + i, 3, inf.arti, opt);
  });
  if (!o.ifas.available || !o.efas.available)
    g.set(21, 0, "Catatan: IFAS/EFAS belum tersedia saat dihitung — nilai memakai salinan terakhir.", { style: "note", cs: 4 });

  return g.build({
    cols: [24, 22, 24, 70],
    chart: {
      type: "quadrant",
      title: "Posisi organisasi (IFAS × EFAS)",
      x: o.x,
      y: o.y,
      xLabel: "IFAS (S − W)",
      yLabel: "EFAS (O − T)",
      quadrants: ["I Agresif (SO)", "III Turnaround (WO)", "IV Defensif (WT)", "II Diversifikasi (ST)"],
    },
    notes: [
      "Titik posisi organisasi: sumbu X = total IFAS (skor kekuatan dikurangi skor kelemahan), sumbu Y = total EFAS (skor peluang dikurangi ancaman).",
      "Kanan atas (I) = agresif/SO, kanan bawah (II) = diversifikasi/ST, kiri atas (III) = turnaround/WO, kiri bawah (IV) = defensif/WT.",
      "Angka ini tidak diisi AI: dihitung dari IFAS dan EFAS, dan ikut berubah bila Anda mengubah rating atau bobot di sana.",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  { name: "Sumbu X (IFAS)", rumus: "X = Σ skor S − Σ skor W (total IFAS)", arti: "Positif berarti kekuatan organisasi lebih besar daripada kelemahannya.", excel: "=ESIFAS!T27" },
  { name: "Sumbu Y (EFAS)", rumus: "Y = Σ skor O − Σ skor T (total EFAS)", arti: "Positif berarti peluang lebih besar daripada ancaman.", excel: "=ESEFAS!T15" },
  {
    name: "Kuadran",
    rumus: "I bila X ≥ 0 dan Y ≥ 0; II bila X ≥ 0 dan Y < 0; III bila X < 0 dan Y ≥ 0; IV bila X < 0 dan Y < 0",
    arti: "Diagram SWOT (Rangkuti): I Agresif (SO), II Diversifikasi (ST), III Turnaround (WO), IV Defensif (WT). Nilai tepat 0 dihitung ke sisi positif.",
    excel: '=IF(X>=0,IF(Y>=0,"I","II"),IF(Y>=0,"III","IV"))',
  },
];

const CHECKS = [
  { name: "data_hulu", kind: "code" as const, description: "IFAS atau EFAS belum tersedia, atau tidak memuat kedua sisi faktor (S dan W / O dan T)" },
  { name: "total_cocok", kind: "code" as const, description: "Total IFAS/EFAS tidak sama dengan jumlah skor barisnya" },
];

export function checkPosisi(inputs: Inputs): CheckResult[] {
  const hulu: Failure[] = [];
  const cocok: Failure[] = [];
  const sides: [string, MatrixScoreComputed | undefined, string, string][] = [
    ["IFAS", inputs.ifas as MatrixScoreComputed | undefined, "S", "W"],
    ["EFAS", inputs.efas as MatrixScoreComputed | undefined, "O", "T"],
  ];
  for (const [name, m, pos, neg] of sides) {
    const rows = Array.isArray(m?.rows) ? m!.rows : [];
    if (!m || !rows.length) {
      hulu.push({ check: "data_hulu", itemId: name, message: `${name} belum tersedia atau kosong — posisi organisasi tidak bisa dihitung dengan benar.` });
      continue;
    }
    const qs = new Set<string>(rows.map((r) => String(r.quadrant ?? r.id?.charAt(0) ?? "")));
    const miss = [pos, neg].filter((q) => !qs.has(q));
    if (miss.length) hulu.push({ check: "data_hulu", itemId: name, message: `${name} tidak memuat faktor ${miss.join(" dan ")} — posisi hanya mencerminkan satu sisi.` });
    const sum = rows.reduce((s, r) => s + (finite(r.score) ? r.score : 0), 0);
    if (finite(m.total) && Math.abs(sum - m.total) > 1e-6)
      cocok.push({ check: "total_cocok", itemId: name, message: `Total ${name} (${num(m.total)}) tidak sama dengan jumlah skor barisnya (${num(sum)}).` });
  }
  return [result("data_hulu", "code", hulu), result("total_cocok", "code", cocok)];
}

export const posisiOrganisasi: NodeDef<PosisiRaw> = {
  key: "posisi_organisasi",
  label: "Posisi organisasi",
  phase: 1,
  group: "sgs",
  sheetName: "SGSOP",
  deps: ["ifas", "efas"],
  kind: "code",
  computedBy: "Kode (tanpa AI): titik X = total IFAS, Y = total EFAS, lalu kuadran diagram SWOT",
  description:
    "Menentukan posisi organisasi pada diagram SWOT dari total IFAS (S − W) dan EFAS (O − T): kuadran I agresif (SO), II diversifikasi (ST), III turnaround (WO), IV defensif (WT).",
  schema: PosisiRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  run: async (ctx: NodeContext) => {
    const o = computePosisi(undefined, ctx.inputs);
    return { x: o.x, y: o.y };
  },
  compute: (out, ctx) => computePosisi(out, ctx.inputs),
  validate: async (_out, ctx) => checkPosisi(ctx.inputs),
  items: (out) => {
    const o = asOutput(out, {});
    return [{ id: "POSISI", text: `${o.label}: ${o.arti}`, detail: `IFAS (S − W) = ${num(o.x)}; EFAS (O − T) = ${num(o.y)}; fokus strategi ${o.fokus}` }];
  },
  sheets: (out, ctx) => [posisiSheet(asOutput(out, ctx.inputs))],
  blocks: (out, ctx): Block[] => {
    const o = asOutput(out, ctx.inputs);
    return [
      { type: "h2", text: "Posisi organisasi (diagram SWOT)" },
      { type: "p", text: `Total IFAS (S − W) = ${num(o.x)} dan total EFAS (O − T) = ${num(o.y)}, sehingga organisasi berada di ${o.label}. ${o.arti}` },
      {
        type: "table",
        head: ["Sumbu", "Rumus", "Nilai"],
        rows: [
          ["X — IFAS", `${num(o.ifas.positive)} (S) − ${num(o.ifas.negative)} (W)`, num(o.x)],
          ["Y — EFAS", `${num(o.efas.positive)} (O) − ${num(o.efas.negative)} (T)`, num(o.y)],
          ["Kuadran", KUADRAN_INFO[o.kuadran].posisi, `${o.kuadran} — ${o.strategi} (${o.fokus})`],
        ],
      },
    ];
  },
  summary: (out) => {
    const o = asOutput(out, {});
    return `${o.label}: IFAS ${num(o.x)}, EFAS ${num(o.y)}`;
  },
};
