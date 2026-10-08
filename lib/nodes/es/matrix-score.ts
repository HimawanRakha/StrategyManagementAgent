// ESIFAS / ESEFAS — matriks skor faktor internal (S, W) / eksternal (O, T) yang dinilai setiap penilai stakeholder.
//
// Baris = faktor (bobot dari node Faktor), kolom = penilai (jabatan/unit dari node Stakeholder, dikelompokkan KP/KS/KI/M
// dengan bobotnya di baris 4). AI mengusulkan rating 1–4 per faktor per penilai (boleh kosong = null), kode menghitung
// persis seperti Excel:
//   KP = (SUMPRODUCT($D$4:$H$4, D6:H6)) / U6        (sama untuk KS, KI, M; sel kosong dihitung 0)
//   U  = SUM($D$4:$N$4)                              ("Stakeholder Terpakai" = jumlah bobot semua penilai)
//   Total Rating = SUM(O6:R6)
//   Score = S6*C6 (Strength/Opportunity),  = -S20*C20 (Weakness/Threat)
//   Total = SUM(T6:T26)
// Modul murni (aman di client).
import { z } from "zod";
import type {
  FactorScoreRow,
  MatrixScoreComputed,
  Quadrant,
  StakeholderComputed,
  StakeholderGroup,
  StakeholderRater,
} from "../contracts";
import type { CheckResult, CheckSpec, Failure, NodeContext, NodeDef, NodeKey, SheetContext } from "../types";
import { JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { pick, sentencesOf } from "../heuristics";
import { overlap, result } from "@/lib/validators/common";
import { GridBuilder, addr, num, range, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { FILL, idNum, sum } from "./es-common";
import { QUADS, QUADRANT_NAME, asFaktor } from "./faktor";
import { GROUP_NAME, STAKEHOLDER_GROUPS, ratersOf } from "./stakeholder";

export type MatrixScope = "internal" | "eksternal";

const KEY: Record<MatrixScope, NodeKey> = { internal: "ifas", eksternal: "efas" };
const FAKTOR_KEY: Record<MatrixScope, NodeKey> = { internal: "faktor_internal", eksternal: "faktor_eksternal" };
const STAKE_KEY: Record<MatrixScope, NodeKey> = { internal: "stakeholder_internal", eksternal: "stakeholder_eksternal" };
const SHEET: Record<MatrixScope, string> = { internal: "ESIFAS", eksternal: "ESEFAS" };
const NAME: Record<MatrixScope, string> = { internal: "IFAS", eksternal: "EFAS" };
/** Judul bagian seperti di Excel (ESIFAS B5/B19, ESEFAS B5/B9). */
const SECTION: Record<Quadrant, string> = { S: "Strength", W: "Weakness", O: "Opportunity", T: "Threat" };
/** Judul kelompok di baris 1 seperti Excel. */
const GROUP_HEAD: Record<StakeholderGroup, string> = { KP: "Key Player", KS: "Keep Satisfied", KI: "Keep Informed", M: "Monitor/Minimum Effort" };
const NEGATIVE = new Set<Quadrant>(["W", "T"]);

/** Arti rating 1–4 (sama untuk semua faktor; untuk W/T skornya dibuat negatif oleh kode). */
export const RATING_LABEL: Record<number, string> = {
  1: "sangat lemah / sangat tidak setuju",
  2: "lemah / kurang setuju",
  3: "kuat / setuju",
  4: "sangat kuat / sangat setuju",
};
export const RATING_OPTIONS = [1, 2, 3, 4].map((v) => ({ label: `${v} — ${RATING_LABEL[v]}`, value: v }));

// ---------- Skema output mentah (AI) ----------

const Rating = z.number().int().min(1).max(4).nullable();

export const MatrixScoreOutput = z.object({
  ratings: z.array(
    z.object({
      factorId: z.string().describe("ID faktor persis seperti daftar (S1, W2, O1, T3, …)"),
      values: z
        .record(z.string(), Rating)
        .describe("ID penilai → rating 1–4 (1 sangat lemah/tidak setuju … 4 sangat kuat/setuju); null = penilai tidak menilai (dihitung 0)"),
      reason: z.string().default("").describe("Alasan singkat penilaian"),
      refs: z.array(z.string()).default([]).describe("ID potongan bukti (C…/U…)"),
    }),
  ),
});
export type MatrixScoreOutput = z.infer<typeof MatrixScoreOutput>;

// ---------- Output setelah compute ----------

/** Faktor masukan (bentuk minimum FactorComputed). */
export type FactorInput = { id: string; quadrant: Quadrant; text: string; bobot: number };

export type MatrixRowOut = FactorScoreRow & {
  /** Rating per penilai, urut sama dengan `raters` (null = kosong, dihitung 0). */
  ratings: (number | null)[];
  /** Posisi entri faktor ini di output mentah `ratings` (null = belum dinilai; sel tidak bisa diedit). */
  rawIndex: number | null;
  reason: string;
  refs: string[];
  /** Jumlah penilai yang tidak memberi rating. */
  blanks: number;
};

export type MatrixScoreOut = MatrixScoreOutput &
  Omit<MatrixScoreComputed, "rows"> & {
    rows: MatrixRowOut[];
    /** Penilai (kolom) saat dihitung, urut KP → KS → KI → M. */
    raters: StakeholderRater[];
    /** Bobot kelompok stakeholder (baris 2 Excel). */
    groupWeights: Record<StakeholderGroup, number>;
    /** U = Σ bobot semua penilai ("Stakeholder Terpakai"). */
    u: number;
    /** Analisis hulu yang belum tersedia (hasil dihitung dengan data kosong). */
    missingInputs: string[];
  };

// ---------- Perhitungan ----------

const groupValue = (raters: StakeholderRater[], ratings: (number | null)[], g: StakeholderGroup, u: number) =>
  u ? sum(raters.map((r, k) => (r.group === g ? r.weight * (ratings[k] ?? 0) : 0))) / u : 0;

/**
 * Kalkulator IFAS/EFAS (murni): sama dengan rumus Excel, termasuk sel kosong = 0.
 * U = 0 (tidak ada penilai) memberi 0, bukan #DIV/0!.
 */
export function computeMatrixScore(
  out: MatrixScoreOutput,
  factors: FactorInput[],
  raters: StakeholderRater[],
  scope: MatrixScope,
  groupWeights?: Partial<Record<StakeholderGroup, number>>,
  missingInputs: string[] = [],
): MatrixScoreOut {
  const [pos, neg] = QUADS[scope];
  const order = (q: Quadrant) => (q === pos ? 0 : 1);
  const fs = factors.filter((f) => f.quadrant === pos || f.quadrant === neg).sort((a, b) => order(a.quadrant) - order(b.quadrant) || idNum(a.id) - idNum(b.id));
  const idx = new Map<string, number>();
  (out.ratings ?? []).forEach((r, i) => {
    if (!idx.has(r.factorId)) idx.set(r.factorId, i);
  });
  const u = sum(raters.map((r) => r.weight));
  const rows: MatrixRowOut[] = fs.map((f) => {
    const ri = idx.get(f.id);
    const entry = ri === undefined ? undefined : out.ratings[ri];
    const ratings = raters.map((r) => {
      const v = entry?.values?.[r.id];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    const kp = groupValue(raters, ratings, "KP", u);
    const ks = groupValue(raters, ratings, "KS", u);
    const ki = groupValue(raters, ratings, "KI", u);
    const m = groupValue(raters, ratings, "M", u);
    const totalRating = kp + ks + ki + m;
    const bobot = Number.isFinite(f.bobot) ? f.bobot : 0;
    // "+ 0" mengubah −0 menjadi 0 (baris W/T tanpa rating).
    const score = (NEGATIVE.has(f.quadrant) ? -(totalRating * bobot) : totalRating * bobot) + 0;
    return {
      id: f.id,
      quadrant: f.quadrant,
      text: f.text,
      bobot,
      kp,
      ks,
      ki,
      m,
      totalRating,
      score,
      ratings,
      rawIndex: ri ?? null,
      reason: entry?.reason ?? "",
      refs: entry?.refs ?? [],
      blanks: ratings.filter((x) => x === null).length,
    };
  });
  const gw = { KP: 0, KS: 0, KI: 0, M: 0 } as Record<StakeholderGroup, number>;
  for (const g of STAKEHOLDER_GROUPS) gw[g] = groupWeights?.[g] ?? sum(raters.filter((r) => r.group === g).map((r) => r.weight));
  return {
    ...out,
    scope,
    rows,
    total: sum(rows.map((r) => r.score)),
    totalPositive: sum(rows.filter((r) => !NEGATIVE.has(r.quadrant)).map((r) => r.score)),
    totalNegative: sum(rows.filter((r) => NEGATIVE.has(r.quadrant)).map((r) => -r.score)),
    raters,
    groupWeights: gw,
    u,
    missingInputs,
  };
}

/** Faktor, penilai, dan bobot kelompok dari output node hulu (mentah atau sudah dihitung). */
export function upstreamOf(inputs: Partial<Record<string, unknown>>, scope: MatrixScope) {
  const f = inputs[FAKTOR_KEY[scope]];
  const s = inputs[STAKE_KEY[scope]];
  const missing = [...(f === undefined ? [FAKTOR_KEY[scope]] : []), ...(s === undefined ? [STAKE_KEY[scope]] : [])];
  const factors: FactorInput[] = f === undefined ? [] : asFaktor(f, scope).factors;
  const raters = ratersOf(s);
  const groups = (s as Partial<StakeholderComputed> | undefined)?.groups;
  const gw = Array.isArray(groups) ? Object.fromEntries(groups.map((g) => [g.group, g.bobot])) : undefined;
  return { factors, raters, groupWeights: gw as Partial<Record<StakeholderGroup, number>> | undefined, missing };
}

export function computeFromInputs(out: MatrixScoreOutput, inputs: Partial<Record<string, unknown>>, scope: MatrixScope): MatrixScoreOut {
  const up = upstreamOf(inputs, scope);
  return computeMatrixScore(out, up.factors, up.raters, scope, up.groupWeights, up.missing);
}

const isComputed = (o: unknown): o is MatrixScoreOut =>
  !!o && typeof o === "object" && Array.isArray((o as MatrixScoreOut).rows) && Array.isArray((o as MatrixScoreOut).raters);

/** Output (mentah atau sudah dihitung) → bentuk hasil hitung. */
export function asMatrix(o: unknown, inputs: Partial<Record<string, unknown>>, scope: MatrixScope): MatrixScoreOut {
  if (isComputed(o)) return o;
  const p = MatrixScoreOutput.safeParse(o ?? {});
  return computeFromInputs(p.success ? p.data : { ratings: [] }, inputs, scope);
}

// ---------- Sheet ----------

type Col = { rater: StakeholderRater | null; k: number; group: StakeholderGroup };

export function matrixSheets(o: MatrixScoreOut, scope: MatrixScope): Grid[] {
  const [pos, neg] = QUADS[scope];
  const fKey = FAKTOR_KEY[scope];
  const sKey = STAKE_KEY[scope];
  const g = new GridBuilder("matrix", SHEET[scope], `${NAME[scope]} — skor faktor ${scope} menurut penilai stakeholder`);
  // Kolom penilai: kelompok KP → KS → KI → M; kelompok kosong tetap punya satu kolom berbobot 0 (seperti Excel ESEFAS).
  const cols: Col[] = [];
  for (const grp of STAKEHOLDER_GROUPS) {
    const rs = o.raters.map((r, k) => ({ r, k })).filter((x) => x.r.group === grp);
    if (rs.length) rs.forEach((x) => cols.push({ rater: x.r, k: x.k, group: grp }));
    else cols.push({ rater: null, k: -1, group: grp });
  }
  const C0 = 3;
  const cLast = C0 + cols.length - 1;
  const cG: Record<StakeholderGroup, number> = { KP: cLast + 1, KS: cLast + 2, KI: cLast + 3, M: cLast + 4 };
  const cTot = cLast + 5;
  const cScore = cLast + 6;
  const cU = cLast + 7;
  const span = (grp: StakeholderGroup) => {
    const js = cols.map((c, j) => (c.group === grp ? j : -1)).filter((j) => j >= 0);
    return { a: C0 + js[0], b: C0 + js[js.length - 1] };
  };

  // Kepala tabel (baris 1–4)
  g.set(0, 0, scope === "internal" ? " " : "NO.", { style: "header", rs: 4, fill: FILL.navy, center: true });
  g.set(0, 1, NAME[scope], { style: "header", rs: 4, fill: FILL.navy, center: true });
  g.set(0, 2, "Bobot", { style: "header", rs: 4, fill: FILL.navy, center: true });
  for (const grp of STAKEHOLDER_GROUPS) {
    const { a, b } = span(grp);
    g.set(0, a, GROUP_HEAD[grp], { style: "header", cs: b - a + 1, fill: FILL.blue, center: true });
    const gw = o.groupWeights[grp] ?? 0;
    const has = o.raters.some((r) => r.group === grp);
    g.set(1, a, gw, {
      cs: b - a + 1,
      fill: FILL.blue,
      center: true,
      fmt: "0.000",
      ...(has
        ? { src: "ahp" as const, f: `{{${sKey}!g_${grp}}}`, explain: `Bobot kelompok ${GROUP_HEAD[grp]} dari node Stakeholder = ${num(gw)}` }
        : { src: "tetap" as const, note: "Tidak ada jabatan di kelompok ini → bobot 0" }),
    });
  }
  cols.forEach((c, j) => {
    const cc = C0 + j;
    if (!c.rater) {
      g.set(2, cc, "(tidak ada)", { style: "muted", fill: FILL.blue, center: true });
      g.set(3, cc, 0, { fill: FILL.blue, fmt: "0.0000", src: "tetap", center: true, note: "Kolom kosong agar rumus kelompok tetap utuh (seperti Excel)" });
      return;
    }
    g.set(2, cc, c.rater.name, { style: "header", fill: FILL.blue, center: true, note: `${c.rater.id} — ${GROUP_NAME[c.group]}` });
    g.set(3, cc, c.rater.weight, {
      fill: FILL.blue,
      fmt: "0.0000",
      center: true,
      src: "ahp",
      f: `{{${sKey}!rw_${c.rater.id}}}`,
      explain: `Bobot penilai ${c.rater.name} dari node Stakeholder = ${num(c.rater.weight, 4)}`,
    });
  });
  for (const grp of STAKEHOLDER_GROUPS) g.set(0, cG[grp], grp, { style: "header", rs: 4, fill: FILL.navy, center: true, note: GROUP_HEAD[grp] });
  g.set(0, cTot, "Total Rating", { style: "header", rs: 4, fill: FILL.navy, center: true });
  g.set(0, cScore, "Score", { style: "header", rs: 4, fill: FILL.navy, center: true });
  g.set(0, cU, "Stakeholder Terpakai", { style: "header", rs: 4, fill: FILL.navy, center: true });

  const wRange = (grp: StakeholderGroup) => {
    const { a, b } = span(grp);
    return a === b ? addr(3, a, true) : range(3, a, 3, b, true);
  };
  const rRange = (grp: StakeholderGroup, r: number) => {
    const { a, b } = span(grp);
    return a === b ? addr(r, a) : range(r, a, r, b);
  };
  const ratingTerms = (row: MatrixRowOut, grp: StakeholderGroup) => {
    const ts = cols
      .filter((c) => c.group === grp && c.rater)
      .map((c) => `${num(c.rater!.weight, 4)}×${row.ratings[c.k] ?? "0 (kosong)"}`);
    if (!ts.length) return "0 (tidak ada penilai)";
    return ts.length > 6 ? `${ts.slice(0, 6).join(" + ")} + …` : ts.join(" + ");
  };

  let r = 4;
  let firstRow = -1;
  let lastRow = -1;
  const sectionRange: Partial<Record<Quadrant, [number, number]>> = {};
  for (const q of [pos, neg]) {
    g.set(r, 1, SECTION[q], { style: "header", fill: FILL.blue });
    g.set(r, 2, "Bobot", { style: "header", fill: FILL.blue });
    r++;
    const rows = o.rows.filter((x) => x.quadrant === q);
    if (!rows.length) {
      g.set(r, 1, `(belum ada faktor ${SECTION[q]})`, { style: "note" });
      r++;
      continue;
    }
    sectionRange[q] = [r, r + rows.length - 1];
    rows.forEach((row, k) => {
      if (firstRow < 0) firstRow = r;
      lastRow = r;
      const R = r + 1;
      g.set(r, 0, k + 1, {
        style: "int",
        fill: FILL.navy,
        center: true,
        ...(k ? { f: `A${R - 1}+1`, src: "hitung" as const } : { src: "tetap" as const }),
      });
      g.set(r, 1, row.text, {
        style: "text",
        fill: FILL.factor,
        note: [`${row.id} (dari node Faktor)`, row.reason && `Alasan penilaian: ${row.reason}`].filter(Boolean).join("\n"),
        refs: row.refs.length ? row.refs : undefined,
      });
      g.set(r, 2, row.bobot, {
        fill: FILL.factor,
        fmt: "0.000",
        src: "ahp",
        f: `{{${fKey}!b_${row.id}}}`,
        explain: `Bobot ${row.id} dari node Faktor (AHP) = ${num(row.bobot)}`,
      });
      cols.forEach((c, j) => {
        const cc = C0 + j;
        if (!c.rater) {
          g.set(r, cc, null, { fill: FILL.rating });
          return;
        }
        const v = row.ratings[c.k];
        g.set(r, cc, v, {
          fill: FILL.rating,
          center: true,
          src: "ai",
          note: `${c.rater.name} menilai ${row.id}: ${v === null ? "kosong — dihitung 0 dan menurunkan skor" : `${v} (${RATING_LABEL[v] ?? "?"})`}`,
          ...(row.rawIndex !== null
            ? { edit: { path: ["ratings", row.rawIndex, "values", c.rater.id], type: "select" as const, options: RATING_OPTIONS, allowEmpty: true } }
            : {}),
        });
      });
      const uAddr = addr(r, cU);
      const vals: Record<StakeholderGroup, number> = { KP: row.kp, KS: row.ks, KI: row.ki, M: row.m };
      for (const grp of STAKEHOLDER_GROUPS)
        g.set(r, cG[grp], vals[grp], {
          fill: FILL.calc,
          fmt: "0.000",
          src: "hitung",
          // `bobot*rating` di dalam SUMPRODUCT: sel rating kosong dihitung 0 seperti TS. Bentuk Excel asli
          // SUMPRODUCT(bobot,rating) memberi #VALUE! di Excel bila kelompok hanya punya satu sel / semuanya kosong.
          f: `(SUMPRODUCT(${wRange(grp)}*${rRange(grp, r)}))/${uAddr}`,
          explain: `${grp} = Σ(bobot penilai ${GROUP_HEAD[grp]} × rating) ÷ U = (${ratingTerms(row, grp)}) ÷ ${num(o.u)} = ${num(vals[grp])}`,
        });
      g.set(r, cTot, row.totalRating, {
        fill: FILL.calc,
        fmt: "0.000",
        src: "hitung",
        f: `SUM(${range(r, cG.KP, r, cG.M)})`,
        explain: `Total rating = KP + KS + KI + M = ${num(row.kp)} + ${num(row.ks)} + ${num(row.ki)} + ${num(row.m)} = ${num(row.totalRating)}`,
      });
      const neg_ = NEGATIVE.has(q);
      g.set(r, cScore, row.score, {
        fill: FILL.calc,
        fmt: "0.000",
        src: "hitung",
        f: neg_ ? `-${addr(r, cTot)}*${addr(r, 2)}` : `${addr(r, cTot)}*${addr(r, 2)}`,
        explain: neg_
          ? `Skor = −(Total rating × Bobot) = −(${num(row.totalRating)} × ${num(row.bobot)}) = ${num(row.score)} (${SECTION[q]} mengurangi total)`
          : `Skor = Total rating × Bobot = ${num(row.totalRating)} × ${num(row.bobot)} = ${num(row.score)}`,
      });
      g.set(r, cU, o.u, {
        fill: FILL.calc,
        fmt: "0.000",
        src: "hitung",
        f: `SUM(${range(3, C0, 3, cLast, true)})`,
        explain: `Stakeholder terpakai U = jumlah bobot semua penilai = ${num(o.u)}`,
      });
      r++;
    });
  }
  // Baris total (Excel: C27 = SUM(C6:C26), T27 = SUM(T6:T26))
  const totalRow = r;
  g.set(r, 1, "Total", { style: "total" });
  if (firstRow >= 0) {
    g.set(r, 2, sum(o.rows.map((x) => x.bobot)), {
      style: "total",
      fill: FILL.factor,
      fmt: "0.000",
      src: "hitung",
      f: `SUM(${range(firstRow, 2, lastRow, 2)})`,
      explain: `Jumlah bobot = ${num(sum(o.rows.map((x) => x.bobot)))} (harus 1)`,
    });
    g.set(r, cScore, o.total, {
      style: "total",
      fill: FILL.calc,
      fmt: "0.000",
      src: "hitung",
      f: `SUM(${range(firstRow, cScore, lastRow, cScore)})`,
      explain: `Total ${NAME[scope]} = Σ skor = ${SECTION[pos]} ${num(o.totalPositive)} − ${SECTION[neg]} ${num(o.totalNegative)} = ${num(o.total)}`,
    });
  } else g.set(r, cScore, 0, { style: "total", src: "hitung" });
  g.anchor("total", totalRow, cScore);
  r++;
  const more = o.totalPositive >= o.totalNegative;
  g.set(r, 1, `**proporsi ${SECTION[pos].toLowerCase()} ${Math.abs(o.totalPositive - o.totalNegative) < 1e-9 ? "sama dengan" : more ? "lebih besar daripada" : "lebih kecil daripada"} ${SECTION[neg].toLowerCase()}`, {
    style: "note",
    explain: `Σ skor ${SECTION[pos]} = ${num(o.totalPositive)}; Σ skor ${SECTION[neg]} (tanpa tanda minus) = ${num(o.totalNegative)}`,
  });
  r += 2;
  for (const q of [pos, neg]) {
    const sr = sectionRange[q];
    const val = q === pos ? o.totalPositive : o.totalNegative;
    g.set(r, 1, `Jumlah skor ${SECTION[q]}${q === neg ? " (tanpa tanda minus)" : ""}`, { style: "label" });
    g.set(r, cScore, val, {
      fmt: "0.000",
      src: "hitung",
      ...(sr
        ? {
            f: `${q === neg ? "-" : ""}SUM(${range(sr[0], cScore, sr[1], cScore)})`,
            explain: `Σ skor ${SECTION[q]} = ${num(val)}`,
          }
        : { f: "0" }),
    });
    g.anchor(q === pos ? "pos" : "neg", r, cScore);
    r++;
  }
  const notes = [
    `Setiap kolom penilai = satu jabatan/unit dari node Stakeholder ${scope} (bobotnya di baris 4, bobot kelompok di baris 2). Rating 1–4: 1 = sangat lemah/sangat tidak setuju, 2 = lemah/kurang setuju, 3 = kuat/setuju, 4 = sangat kuat/sangat setuju bahwa faktor itu benar-benar terjadi dan berpengaruh.`,
    "KP, KS, KI, M = Σ(bobot penilai kelompok itu × rating) ÷ U, dengan U = jumlah bobot semua penilai (Stakeholder Terpakai). Total rating = KP + KS + KI + M.",
    `Skor = Total rating × Bobot; untuk ${SECTION[neg]} skornya negatif. Total ${NAME[scope]} = Σ skor (${SECTION[pos]} − ${SECTION[neg]}): positif berarti ${SECTION[pos].toLowerCase()} lebih besar.`,
    "Sel rating kosong dihitung 0 (seperti Excel) sehingga menurunkan skor — isi semua sel atau kosongkan dengan sengaja.",
  ];
  if (o.missingInputs.length) notes.unshift(`Analisis hulu belum tersedia: ${o.missingInputs.join(", ")} — tabel dihitung dengan data kosong.`);
  return [
    g.build({
      cols: [5, 60, 8, ...cols.map(() => 11), 8, 8, 8, 8, 10, 10, 11],
      freeze: { rows: 4, cols: 3 },
      notes,
    }),
  ];
}

function matrixSummary(o: MatrixScoreOut): string {
  const [pos, neg] = QUADS[o.scope];
  const verdict = o.total > 0 ? `${SECTION[pos].toLowerCase()} lebih besar` : o.total < 0 ? `${SECTION[neg].toLowerCase()} lebih besar` : "seimbang";
  return `Total ${NAME[o.scope]} ${num(o.total)} (${SECTION[pos]} ${num(o.totalPositive)} − ${SECTION[neg]} ${num(o.totalNegative)}) — ${verdict}; ${o.rows.length} faktor × ${o.raters.length} penilai.`;
}

function matrixBlocks(o: MatrixScoreOut, label: string): Block[] {
  return [
    { type: "h2", text: label },
    { type: "p", text: matrixSummary(o) },
    {
      type: "table",
      head: ["ID", "Faktor", "Bobot", "KP+KS+KI+M", "Total rating", "Skor"],
      rows: [
        ...o.rows.map((x) => [x.id, x.text, num(x.bobot), `${num(x.kp, 2)} + ${num(x.ks, 2)} + ${num(x.ki, 2)} + ${num(x.m, 2)}`, num(x.totalRating), num(x.score)]),
        ["", "Total", num(sum(o.rows.map((x) => x.bobot))), "", "", num(o.total)],
      ],
      widths: [7, 45, 9, 19, 10, 10],
    },
    {
      type: "table",
      head: ["Penilai", "Kelompok", "Bobot"],
      rows: o.raters.map((r) => [r.name, GROUP_NAME[r.group], num(r.weight, 4)]),
      widths: [50, 30, 20],
    },
    {
      type: "note",
      text: "Rating 1–4: 1 = sangat lemah/tidak setuju … 4 = sangat kuat/setuju. KP/KS/KI/M = Σ(bobot penilai × rating) ÷ U; skor = total rating × bobot (negatif untuk kelemahan/ancaman). Sel kosong dihitung 0.",
    },
  ];
}

export const MATRIX_FORMULAS: FormulaDoc[] = [
  {
    name: "Rating kelompok (KP, KS, KI, M)",
    rumus: "KP = Σ(bobot penilai Key Player × rating) ÷ U",
    arti: "Rata-rata rating tertimbang dari penilai satu kelompok stakeholder; rating kosong dihitung 0.",
    excel: "=(SUMPRODUCT($D$4:$H$4*D6:H6))/U6",
  },
  { name: "Stakeholder terpakai (U)", rumus: "U = Σ bobot semua penilai", arti: "Pembagi rata-rata; bernilai 1 bila semua bobot penilai berjumlah 1.", excel: "=SUM($D$4:$N$4)" },
  { name: "Total rating", rumus: "Total rating = KP + KS + KI + M", arti: "Seberapa kuat faktor dirasakan semua penilai (skala 0–4).", excel: "=SUM(O6:R6)" },
  {
    name: "Skor",
    rumus: "Skor = Total rating × Bobot (negatif untuk Weakness/Threat)",
    arti: "Sumbangan faktor terhadap total; kelemahan dan ancaman mengurangi total.",
    excel: "=S6*C6  /  =-S20*C20",
  },
  { name: "Total IFAS/EFAS", rumus: "Total = Σ skor (S − W atau O − T)", arti: "Positif: kekuatan/peluang lebih besar; negatif: kelemahan/ancaman lebih besar. Dipakai di posisi organisasi.", excel: "=SUM(T6:T26)" },
];

// ---------- Prompt ----------

function matrixPrompt(ctx: NodeContext, scope: MatrixScope) {
  const [pos, neg] = QUADS[scope];
  const up = upstreamOf(ctx.inputs, scope);
  const raterLines = up.raters.length
    ? up.raters.map((r) => `${r.id} | ${r.name} | ${GROUP_NAME[r.group]} (${r.group}) | bobot ${num(r.weight, 4)}`).join("\n")
    : "(belum ada penilai — node Stakeholder belum selesai)";
  const factorLines = up.factors.length
    ? up.factors.map((f) => `${f.id} [${QUADRANT_NAME[f.quadrant]} · bobot ${num(f.bobot)}] ${f.text}`).join("\n")
    : "(belum ada faktor — node Faktor belum selesai)";
  return {
    system: `Kamu analis strategi organisasi. Isi matriks ${NAME[scope]} (${scope === "internal" ? "Internal" : "External"} Factor Analysis Summary) gaya Excel framework: SETIAP faktor ${pos}/${neg} dinilai oleh SETIAP penilai (jabatan/unit stakeholder) dengan rating 1–4.

ARTI RATING (sama untuk semua penilai dan semua faktor)
1 = sangat lemah / sangat tidak setuju — menurut penilai, faktor itu hampir tidak terjadi atau pengaruhnya sangat kecil
2 = lemah / kurang setuju
3 = kuat / setuju
4 = sangat kuat / sangat setuju — faktor itu jelas terjadi dan pengaruhnya besar
- Untuk ${QUADRANT_NAME[neg]}, rating tinggi berarti ${neg === "W" ? "kelemahan" : "ancaman"} itu makin terasa; kode menjadikan skornya NEGATIF (mengurangi total). JANGAN membalik skala untuk ${QUADRANT_NAME[neg]}.
- Bila dokumen penilaian stakeholder memakai arti lain (mis. menilai KONDISI/KESIAPAN organisasi: 1 = kondisi sangat lemah/tidak siap … 4 = sangat kuat/siap), terjemahkan: untuk ${QUADRANT_NAME[pos]} nilai itu dipakai apa adanya; untuk ${QUADRANT_NAME[neg]}, kondisi sangat lemah/tidak siap berarti ${neg === "W" ? "kelemahan" : "ancaman"} itu sangat terasa → rating tinggi (rating = 5 − nilai kondisi). Sebutkan terjemahan itu di reason.

CARA MENILAI
- Utamakan dokumen penilaian/validasi stakeholder (rating yang benar-benar diberikan jabatan itu). Bila tidak ada, perkirakan dari sudut pandang jabatan: seberapa dekat jabatan itu dengan faktor dan apa kata dokumen tentang faktor itu.
- Tulis SATU entri untuk SETIAP faktor (factorId persis seperti daftar; jangan menambah faktor baru).
- values: objek {"ID penilai": rating}. Tulis SEMUA ID penilai di setiap faktor. Pakai null HANYA bila penilai itu benar-benar tidak bisa menilai faktor tersebut (mis. tidak terlibat sama sekali); null dihitung 0 seperti sel kosong di Excel sehingga menurunkan skor.
- reason: alasan singkat (sebut penilai yang menonjol); refs: ID potongan bukti (C…/U…) yang dipakai.
- JANGAN menghitung bobot, rata-rata, atau skor — dikerjakan kode: KP/KS/KI/M = Σ(bobot penilai × rating) ÷ U, total rating = KP + KS + KI + M, skor = total rating × bobot (negatif untuk ${QUADRANT_NAME[neg]}).

${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Penilai (kolom matriks, dari node Stakeholder ${scope}) — ID | penilai | kelompok | bobot:
${raterLines}

Faktor (baris matriks, dari node Faktor ${scope}):
${factorLines}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(MatrixScoreOutput)}`,
  };
}

// ---------- Mock (tanpa LLM) ----------

const NEG_WORDS = /\b(lemah|tidak siap|kurang|belum|buruk|rendah)\b/i;

/** Rating dari dokumen penilaian bila ada kalimat yang menyebut penilai, kata "rating N", dan mirip dengan faktor. */
function docRating(ctx: NodeContext, f: FactorInput, rater: StakeholderRater): { v: number; chunkId: string } | null {
  const name = rater.name.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
  if (name.length < 4) return null;
  for (const c of ctx.evidence.filter((e) => e.kind === "document")) {
    for (const s of sentencesOf(c.content)) {
      const m = /rating(?: kesiapan(?: [a-z]+)?)?\s+([1-4])\b/i.exec(s);
      if (!m || !s.toLowerCase().includes(name) || overlap(f.text, s) < 0.15) continue;
      const n = Number(m[1]);
      const v = NEGATIVE.has(f.quadrant) && NEG_WORDS.test(s) ? 5 - n : n;
      return { v: Math.min(4, Math.max(1, v)), chunkId: c.id };
    }
  }
  return null;
}

export function mockMatrix(ctx: NodeContext, scope: MatrixScope): MatrixScoreOutput {
  const up = upstreamOf(ctx.inputs, scope);
  return {
    ratings: up.factors.map((f) => {
      const refs = new Set<string>();
      const values: Record<string, number | null> = {};
      for (const r of up.raters) {
        const d = docRating(ctx, f, r);
        if (d) {
          values[r.id] = d.v;
          refs.add(d.chunkId);
          continue;
        }
        const h = pick(`${f.id}|${r.id}|${f.text}`, 10);
        values[r.id] = h < 2 ? 2 : h < 7 ? 3 : 4;
      }
      return {
        factorId: f.id,
        values,
        reason: refs.size ? "Mode uji: sebagian rating diambil dari dokumen penilaian stakeholder, sisanya heuristik (2–4)." : "Mode uji: rating heuristik deterministik (2–4).",
        refs: [...refs],
      };
    }),
  };
}

// ---------- Validasi ----------

export const MATRIX_CHECKS: CheckSpec[] = [
  { name: "coverage", kind: "code", description: "Ada faktor yang tidak dinilai, dinilai dua kali, ID faktor/penilai asing, atau penilai yang tidak dicantumkan" },
  { name: "rating_range", kind: "code", description: "Rating bukan bilangan bulat 1–4" },
  { name: "rating_complete", kind: "code", description: "Ada sel rating kosong (dihitung 0 seperti Excel sehingga menurunkan skor)" },
  { name: "rating_direction", kind: "code", description: "Faktor dengan rata-rata rating di bawah 2 — hampir tidak diakui penilai atau skala terbalik" },
];

export async function validateMatrix(out: MatrixScoreOutput, ctx: NodeContext, scope: MatrixScope): Promise<CheckResult[]> {
  const up = upstreamOf(ctx.inputs, scope);
  const factorIds = new Set(up.factors.map((f) => f.id));
  const raterIds = new Set(up.raters.map((r) => r.id));
  const nameOf = new Map(up.raters.map((r) => [r.id, r.name]));
  const entries = out.ratings ?? [];
  const cov: Failure[] = [];
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.factorId, (count.get(e.factorId) ?? 0) + 1);
  for (const f of up.factors) {
    const n = count.get(f.id) ?? 0;
    if (!n) cov.push({ check: "coverage", itemId: f.id, message: `Faktor ${f.id} belum dinilai; tulis satu entri dengan rating dari semua penilai.` });
    if (n > 1) cov.push({ check: "coverage", itemId: f.id, message: `Faktor ${f.id} dinilai ${n} kali; gabungkan menjadi satu entri.` });
  }
  for (const e of entries) {
    if (!factorIds.has(e.factorId)) cov.push({ check: "coverage", itemId: e.factorId, message: `ID faktor ${e.factorId} tidak ada di node Faktor; hapus entri ini.` });
    const keys = Object.keys(e.values ?? {});
    const missing = up.raters.filter((r) => !keys.includes(r.id));
    if (missing.length && factorIds.has(e.factorId))
      cov.push({ check: "coverage", itemId: e.factorId, message: `Faktor ${e.factorId}: penilai ${missing.map((r) => `${r.id} (${r.name})`).join(", ")} tidak dicantumkan; tulis rating 1–4 atau null.` });
    const alien = keys.filter((k) => !raterIds.has(k));
    if (alien.length) cov.push({ check: "coverage", itemId: e.factorId, message: `Faktor ${e.factorId}: ID penilai asing ${alien.join(", ")}; gunakan hanya ID dari daftar penilai.` });
  }
  const range_: Failure[] = [];
  for (const e of entries)
    for (const [k, v] of Object.entries(e.values ?? {}))
      if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 4))
        range_.push({ check: "rating_range", itemId: e.factorId, message: `Faktor ${e.factorId}, penilai ${nameOf.get(k) ?? k}: rating ${v} harus bilangan bulat 1–4.` });
  const blanks: Failure[] = [];
  const dir: Failure[] = [];
  const firstOf = new Map<string, MatrixScoreOutput["ratings"][number]>();
  for (const e of entries) if (!firstOf.has(e.factorId)) firstOf.set(e.factorId, e);
  for (const f of up.factors) {
    const e = firstOf.get(f.id);
    if (!e) continue;
    const empty = up.raters.filter((r) => e.values?.[r.id] === null || e.values?.[r.id] === undefined);
    if (empty.length)
      blanks.push({
        check: "rating_complete",
        itemId: f.id,
        message: `Faktor ${f.id}: rating kosong dari ${empty.map((r) => r.name).join(", ")} — dihitung 0 (seperti Excel) sehingga skor ${f.id} turun. Isi rating 1–4 bila penilai itu sebenarnya bisa menilai.`,
      });
    const vals = up.raters.map((r) => e.values?.[r.id]).filter((v): v is number => typeof v === "number");
    const mean = vals.length ? sum(vals) / vals.length : NaN;
    if (vals.length && mean < 2)
      dir.push({
        check: "rating_direction",
        itemId: f.id,
        message: `Faktor ${f.id} (${QUADRANT_NAME[f.quadrant]}) rata-rata rating ${num(mean, 2)} — penilai hampir tidak mengakui faktor ini. ${
          NEGATIVE.has(f.quadrant)
            ? `Ingat: untuk ${QUADRANT_NAME[f.quadrant]} rating tinggi = makin terasa (jangan dibalik).`
            : "Periksa apakah faktor ini memang kekuatan/peluang."
        }`,
      });
  }
  return [result("coverage", "code", cov), result("rating_range", "code", range_), result("rating_complete", "code", blanks), result("rating_direction", "code", dir)];
}

// ---------- Definisi node ----------

function matrixItems(out: unknown) {
  if (isComputed(out))
    return out.rows.map((x) => ({
      id: x.id,
      text: x.text,
      detail: `Bobot ${num(x.bobot)} · KP ${num(x.kp)} · KS ${num(x.ks)} · KI ${num(x.ki)} · M ${num(x.m)} · total rating ${num(x.totalRating)} · skor ${num(x.score)}`,
    }));
  const p = MatrixScoreOutput.safeParse(out ?? {});
  return (p.success ? p.data.ratings : []).map((e) => ({
    id: e.factorId,
    text: `rating: ${Object.entries(e.values)
      .map(([k, v]) => `${k}=${v ?? "kosong"}`)
      .join(", ")}`,
    detail: e.reason,
  }));
}

function makeMatrixNode(scope: MatrixScope): NodeDef<MatrixScoreOutput> {
  const label = NAME[scope];
  const [pos, neg] = QUADS[scope];
  return {
    key: KEY[scope],
    label,
    phase: 1,
    group: "es",
    sheetName: SHEET[scope],
    deps: [FAKTOR_KEY[scope], STAKE_KEY[scope]],
    kind: "llm",
    description: `Rating 1–4 setiap faktor ${pos}/${neg} oleh setiap penilai stakeholder ${scope}; kode menghitung rating tertimbang per kelompok (KP, KS, KI, M), total rating, skor (negatif untuk ${QUADRANT_NAME[neg]}), dan total ${label}.`,
    computedBy: "LLM mengusulkan rating; kode menghitung SUMPRODUCT per kelompok ÷ U, total rating, skor, dan total",
    schema: MatrixScoreOutput,
    checks: MATRIX_CHECKS,
    queries: () => [
      {
        focus: "penilaian",
        text:
          scope === "internal"
            ? "penilaian validasi stakeholder rating skala 1-4 jabatan menilai kekuatan kelemahan internal"
            : "penilaian validasi stakeholder eksternal rating kesiapan peluang ancaman",
        k: 8,
      },
    ],
    extraChunkIds: (ctx) => {
      const f = ctx.inputs[FAKTOR_KEY[scope]];
      if (!f) return [];
      return [...new Set(asFaktor(f, scope).factors.flatMap((x) => x.evidence.slice(0, 1).map((e) => e.chunkId)))].slice(0, 15);
    },
    prompt: (ctx) => matrixPrompt(ctx, scope),
    mock: (ctx) => mockMatrix(ctx, scope),
    validate: (out, ctx) => validateMatrix(out, ctx, scope),
    compute: (out, ctx) => computeFromInputs(out, ctx.inputs, scope),
    items: matrixItems,
    repairHint: "Perbaiki hanya entri faktor yang ditolak; entri lain salin apa adanya. Setiap faktor tepat satu entri dan setiap ID penilai tercantum (rating 1–4 atau null).",
    sheets: (out: unknown, ctx: SheetContext) => matrixSheets(asMatrix(out, ctx.inputs, scope), scope),
    blocks: (out: unknown, ctx: SheetContext) => matrixBlocks(asMatrix(out, ctx.inputs, scope), ctx.label || label),
    formulas: MATRIX_FORMULAS,
    summary: (out) => (isComputed(out) ? matrixSummary(out) : `${label}: belum dihitung`),
  };
}

export const ifas = makeMatrixNode("internal");
export const efas = makeMatrixNode("eksternal");
