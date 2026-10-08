// SGS-QSPM — Quantitative Strategic Planning Matrix: semua strategi matriks SWOT (kolom, urut SO → ST → WO → WT seperti Excel)
// × semua faktor S, W, O, T (baris, bobot AHP). AI mengusulkan AS 0–4 (bisa diedit; kosong = tidak dinilai),
// kode menghitung TAS = Bobot × AS, TOTAL = Σ TAS per strategi, dan peringkat (1 = total terbesar).
import { z } from "zod";
import type { QspmComputedV2, Quadrant, StrategyType } from "../contracts";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { JSON_ONLY, jsonSchemaText, orgLine } from "../prompt";
import { pick } from "../heuristics";
import { llmJudge, result } from "@/lib/validators/common";
import { qspmTotal, rankDesc, singleChangeWorst, tasCell } from "@/lib/calc/qspm";
import { GridBuilder, addr, colLetter, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import {
  QSPM_ORDER,
  QUADRANTS,
  TYPE_INFO,
  factorsOf,
  isObj,
  orderStrategies,
  posisiOf,
  quadrantOf,
  strategiesOf,
  typeOfId,
  type Inputs,
  type StrategyLite,
} from "./common";

export const QspmStrategyRaw = z.object({
  /** ID strategi dari matriks SWOT, mis. "SO1". */
  id: z.string(),
  /** ID faktor → AS (0–4). null = tidak dinilai (sel kosong, TAS kosong). Semua ID faktor wajib ada sebagai kunci. */
  as: z.record(z.string(), z.number().nullable()),
  /** Satu kalimat alasan utama penilaian strategi ini. */
  reason: z.string().default(""),
});
export const QspmRaw = z.object({ strategies: z.array(QspmStrategyRaw) });
export type QspmRaw = z.infer<typeof QspmRaw>;

export type QspmFactor = { id: string; quadrant: Quadrant; text: string; bobot: number };
export type QspmColumn = {
  id: string;
  type: StrategyType;
  text: string;
  code: string;
  factorRefs: string[];
  /** Index strategi ini di output mentah (`strategies`), null bila belum dinilai AI. */
  rawIndex: number | null;
  reason: string;
  /** Total TAS (Σ Bobot × AS atas sel yang terisi). */
  total: number;
  rank: number;
  /** Banyaknya sel AS yang terisi angka. */
  filled: number;
};
export type QspmOutput = QspmRaw &
  QspmComputedV2 & {
    factors: QspmFactor[];
    /** Kolom QSPM berurutan seperti Excel: SO, ST, WO, WT. */
    columns: QspmColumn[];
    /** Strategi peringkat 1 (null bila tidak ada strategi). */
    selected: string | null;
    /** Kompatibel dengan pengukur stabilitas peringkat eksperimen (Kendall's tau). */
    totals: { strategyId: string; tas: number; rank: number }[];
  };

// ---------- Compute ----------

/** Kolom QSPM: strategi matriks SWOT (atau, bila tidak ada, strategi di output mentah) berurutan SO → ST → WO → WT. */
function columnsOf(raw: QspmRaw, inputs: Inputs): StrategyLite[] {
  const swot = strategiesOf(inputs);
  if (swot.length) return orderStrategies(swot, QSPM_ORDER);
  const fromRaw = (raw.strategies ?? []).map((s) => ({ id: s.id, type: typeOfId(s.id) ?? ("SO" as StrategyType), factorRefs: [], text: "", code: "" }));
  return orderStrategies(fromRaw, QSPM_ORDER);
}

function factorRows(raw: QspmRaw, inputs: Inputs): QspmFactor[] {
  const fs = factorsOf(inputs).map((f) => ({ id: f.id, quadrant: f.quadrant, text: f.text, bobot: f.bobot }));
  if (fs.length) return fs;
  // Cadangan: faktor hulu tidak tersedia → pakai kunci AS (bobot 0) agar tabel tetap tampil.
  const ids = [...new Set((raw.strategies ?? []).flatMap((s) => Object.keys(s.as ?? {})))];
  return ids
    .map((id) => ({ id, quadrant: quadrantOf(id) ?? ("S" as Quadrant), text: "(faktor tidak ditemukan)", bobot: 0 }))
    .sort((a, b) => QUADRANTS.indexOf(a.quadrant) - QUADRANTS.indexOf(b.quadrant));
}

export function computeQspm(raw: QspmRaw, inputs: Inputs): QspmOutput {
  const strategies = raw?.strategies ?? [];
  const factors = factorRows({ strategies }, inputs);
  const cols = columnsOf({ strategies }, inputs);
  const idx = new Map(strategies.map((s, i) => [s.id, i]));
  const totals = cols.map((c) => qspmTotal(factors, strategies[idx.get(c.id) ?? -1]?.as));
  const ranks = rankDesc(totals);
  const columns: QspmColumn[] = cols.map((c, j) => {
    const i = idx.get(c.id);
    const as = i === undefined ? undefined : strategies[i].as;
    return {
      id: c.id,
      type: c.type,
      text: c.text,
      code: c.code,
      factorRefs: c.factorRefs,
      rawIndex: i ?? null,
      reason: i === undefined ? "" : strategies[i].reason ?? "",
      total: totals[j],
      rank: ranks[j],
      filled: factors.filter((f) => typeof as?.[f.id] === "number").length,
    };
  });
  const ranked = columns.map((c, j) => ({ c, j })).sort((a, b) => a.c.rank - b.c.rank || a.j - b.j);
  return {
    ...raw,
    strategies,
    factors,
    columns,
    ranking: ranked.map(({ c }) => ({ id: c.id, type: c.type, text: c.text, tas: c.total, rank: c.rank })),
    totals: columns.map((c) => ({ strategyId: c.id, tas: c.total, rank: c.rank })),
    selected: ranked[0]?.c.id ?? null,
  };
}

const asOutput = (out: unknown, inputs: Inputs): QspmOutput => {
  const o = isObj(out) ? (out as Partial<QspmOutput>) : {};
  if (Array.isArray(o.columns) && Array.isArray(o.factors) && Array.isArray(o.ranking)) return o as QspmOutput;
  return computeQspm({ strategies: Array.isArray(o.strategies) ? (o.strategies as QspmRaw["strategies"]) : [] }, inputs);
};

// ---------- Prompt & mock ----------

const AS_SCALE = "1 = tidak menarik, 2 = agak menarik, 3 = cukup menarik, 4 = sangat menarik";

function promptOf(ctx: NodeContext) {
  const factors = factorsOf(ctx.inputs);
  const strategies = orderStrategies(strategiesOf(ctx.inputs), QSPM_ORDER);
  const pos = posisiOf(ctx.inputs);
  const ids = factors.map((f) => f.id);
  return {
    system: `Kamu analis strategi. Isi QSPM (Quantitative Strategic Planning Matrix) untuk SEMUA ${strategies.length} strategi alternatif dari matriks SWOT terhadap SEMUA ${factors.length} faktor (S, W, O, T).
Cara menilai:
1. Untuk setiap strategi dan setiap faktor, beri Attractiveness Score (AS) bilangan bulat: ${AS_SCALE}. AS menjawab: "seberapa besar faktor ini membuat strategi tersebut menarik untuk dijalankan?"
2. AS 0 = faktor itu sama sekali tidak relevan bagi strategi tersebut. null = faktor tidak memengaruhi pilihan strategi mana pun; bila memakai null, beri null pada faktor itu untuk SEMUA strategi (jangan sebagian).
3. Faktor yang digabung langsung oleh strategi (kode di depan kalimatnya) biasanya bernilai 3–4. Bandingkan antarstrategi per faktor: strategi yang paling memanfaatkan/menjawab faktor itu mendapat AS tertinggi. Jangan memberi nilai seragam di semua faktor.
4. JANGAN menulis bobot, TAS, total, atau peringkat — semuanya dihitung kode (TAS = Bobot × AS; Total = Σ TAS; peringkat 1 = total terbesar).
5. Tulis ringkas: SATU objek per strategi, {"id":"SO1","as":{${ids.slice(0, 3).map((id, i) => `"${id}":${[4, 3, 2][i]}`).join(",")}${ids.length > 3 ? ",…" : ""}},"reason":"<satu kalimat alasan utama>"}. Kunci "as" HARUS memuat SEMUA ${ids.length} ID faktor: ${ids.join(", ")}.
6. Sertakan semua strategi: ${strategies.map((s) => s.id).join(", ")}.
7. ${JSON_ONLY}`,
    user: `${orgLine(ctx)}
${pos ? `Posisi organisasi: kuadran ${pos.kuadran} (${pos.strategi}, fokus ${pos.fokus}).\n` : ""}
Faktor (bobot AHP):
${factors.map((f) => `${f.id} [${f.quadrant}] ${f.text} (bobot ${f.bobot.toFixed(3)})`).join("\n") || "(belum ada faktor)"}

Strategi alternatif (urut kolom QSPM):
${strategies.map((s) => `${s.id} [${s.type}] ${s.code} — ${s.text}`).join("\n") || "(belum ada strategi)"}

Skema output:
${jsonSchemaText(QspmRaw)}`,
  };
}

export function mockQspm(inputs: Inputs): QspmRaw {
  const factors = factorsOf(inputs);
  const strategies = orderStrategies(strategiesOf(inputs), QSPM_ORDER);
  return {
    strategies: strategies.map((s) => {
      const info = TYPE_INFO[s.type];
      const as: Record<string, number | null> = {};
      for (const f of factors) {
        if (s.factorRefs.includes(f.id)) as[f.id] = 4;
        else if (f.quadrant === info.internal || f.quadrant === info.external) as[f.id] = 2 + pick(f.id + s.id, 2);
        else as[f.id] = 1 + pick(f.id + s.id, 2);
      }
      return { id: s.id, as, reason: `Mode uji: faktor yang digabung strategi ini (${s.code || "-"}) diberi AS 4, faktor sejenis 2–3, faktor lain 1–2.` };
    }),
  };
}

// ---------- Validator ----------

const CHECKS = [
  {
    name: "coverage",
    kind: "code" as const,
    description: "Ada strategi atau sel strategi × faktor yang belum dinilai (harus berisi AS atau null), atau faktor bernilai null untuk sebagian strategi saja",
  },
  { name: "ref_exists", kind: "code" as const, description: "Penilaian merujuk strategi atau faktor yang tidak ada" },
  { name: "as_range", kind: "code" as const, description: "Nilai AS di luar skala 0–4 atau bukan bilangan bulat" },
  {
    name: "ranking_stability",
    kind: "code" as const,
    description:
      "Peringkat tidak stabil: menurunkan satu nilai AS strategi peringkat 1 sebanyak 1 poin sudah membuatnya keluar 3 besar, atau AS satu strategi seragam di semua faktor",
  },
  { name: "as_reasonable", kind: "llm" as const, description: "Nilai AS tidak masuk akal terhadap faktor yang digabung strategi (mis. faktor inti strategi diberi nilai rendah)" },
];

export function qspmCodeChecks(raw: QspmRaw, inputs: Inputs): CheckResult[] {
  const factors = factorsOf(inputs);
  const fids = new Set(factors.map((f) => f.id));
  const swot = strategiesOf(inputs);
  const sids = new Set(swot.map((s) => s.id));
  const strategies = raw.strategies ?? [];
  const byId = new Map(strategies.map((s) => [s.id, s]));
  const cov: Failure[] = [];
  const refs: Failure[] = [];
  const range: Failure[] = [];
  const stab: Failure[] = [];

  for (const s of swot) if (!byId.has(s.id)) cov.push({ check: "coverage", itemId: s.id, message: `Strategi ${s.id} belum dinilai sama sekali (tambahkan objek {"id":"${s.id}","as":{…}}).` });
  for (const s of strategies) {
    const keys = Object.keys(s.as ?? {});
    const missing = factors.filter((f) => !(f.id in (s.as ?? {}))).map((f) => f.id);
    if (missing.length)
      cov.push({ check: "coverage", itemId: s.id, message: `${s.id}: AS belum diisi untuk ${missing.length} faktor (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}); isi 0–4 atau null.` });
    if (sids.size && !sids.has(s.id)) refs.push({ check: "ref_exists", itemId: s.id, message: `${s.id} tidak ada di matriks SWOT.` });
    const bad = fids.size ? keys.filter((k) => !fids.has(k)) : [];
    if (bad.length) refs.push({ check: "ref_exists", itemId: s.id, message: `${s.id} menilai faktor yang tidak ada: ${bad.join(", ")}.` });
    const out = keys.filter((k) => {
      const v = s.as[k];
      return v !== null && (!Number.isInteger(v) || v < 0 || v > 4);
    });
    if (out.length) range.push({ check: "as_range", itemId: s.id, message: `${s.id}: AS harus bilangan bulat 0–4 (${out.map((k) => `${k}=${s.as[k]}`).join(", ")}).` });
  }
  // Null sebagian: faktor dinilai untuk sebagian strategi tetapi null untuk strategi lain.
  for (const f of factors) {
    const vals = strategies.filter((s) => f.id in (s.as ?? {})).map((s) => ({ id: s.id, v: s.as[f.id] }));
    const nulls = vals.filter((x) => x.v === null).map((x) => x.id);
    if (nulls.length && nulls.length < vals.length)
      cov.push({ check: "coverage", itemId: f.id, message: `Faktor ${f.id} bernilai null untuk ${nulls.join(", ")} tetapi diisi untuk strategi lain; isi 0–4 untuk semua strategi atau null untuk semua.` });
  }
  // Stabilitas peringkat
  for (const s of strategies) {
    const nums = factors.map((f) => s.as?.[f.id]).filter((v): v is number => typeof v === "number");
    if (nums.length >= 5 && nums.every((v) => v === nums[0]))
      stab.push({ check: "ranking_stability", itemId: s.id, message: `${s.id}: semua AS bernilai ${nums[0]} — penilaian seragam tidak membedakan faktor; bedakan menurut relevansi tiap faktor.` });
  }
  const o = computeQspm(raw, inputs);
  const cols = o.columns.filter((c) => c.rawIndex !== null);
  if (o.selected && cols.length > 3) {
    const w = singleChangeWorst(
      o.factors,
      cols.map((c) => ({ id: c.id, as: strategies[c.rawIndex!].as })),
      o.selected,
    );
    if (w.worstRank > 3 && w.factorId) {
      const f = o.factors.find((x) => x.id === w.factorId);
      stab.push({
        check: "ranking_stability",
        itemId: o.selected,
        message: `Peringkat 1 (${o.selected}) rapuh: bila AS-nya untuk ${w.factorId} (bobot ${num(f?.bobot ?? 0)}) turun 1 poin saja, ${o.selected} jatuh ke peringkat ${w.worstRank}. Selisih total antarstrategi teratas sangat tipis — tinjau ulang AS strategi-strategi teratas agar benar-benar membedakan daya tariknya.`,
      });
    }
  }
  return [result("coverage", "code", cov), result("ref_exists", "code", refs), result("as_range", "code", range), result("ranking_stability", "code", stab)];
}

// ---------- Sheet ----------

const FILL = { matrix: "F4B083", head: "A8D08D", strat: "B4C6E7", total: "00FF00", top: "FFD966" };
const GROUP_HEAD: Record<Quadrant, string> = { S: "STRENGTH", W: "Weakness", O: "Opportunity", T: "Threat" };

export function qspmSheet(o: QspmOutput): Grid {
  const g = new GridBuilder("qspm", "SGS-QSPM", "QSPM");
  const n = o.columns.length;
  const W = 3 + 2 * Math.max(1, n);
  const asC = (j: number) => 3 + 2 * j;
  const tasC = (j: number) => 4 + 2 * j;
  g.set(0, 0, "The Quantitative Strategic Planning Matrix (QSPM)", { style: "title", cs: W });
  const top = o.columns.find((c) => c.id === o.selected);
  if (top) g.set(1, 0, `Strategi paling menarik: ${top.id} (total TAS ${num(top.total)}).`, { style: "note", cs: W });

  // Baris tipe strategi + kepala strategi
  g.set(2, 0, "Tipe strategi", { style: "subheader", cs: 3 });
  let j0 = 0;
  for (const t of QSPM_ORDER) {
    const k = o.columns.filter((c) => c.type === t).length;
    if (!k) continue;
    g.set(2, asC(j0), `${t} — ${TYPE_INFO[t].label}`, { style: "subheader", cs: 2 * k, center: true, note: TYPE_INFO[t].arti });
    j0 += k;
  }
  g.set(3, 0, "QSPM MATRIX", { style: "header", cs: 3, fill: FILL.matrix, center: true });
  o.columns.forEach((c, j) =>
    g.set(3, asC(j), `${c.id} — ${c.code ? `${c.code} ` : ""}${c.text}`, {
      style: "text",
      cs: 2,
      fill: c.id === o.selected ? FILL.top : FILL.strat,
      src: "ai",
      note: c.reason ? `Alasan AI: ${c.reason}` : c.rawIndex === null ? "Strategi ini belum dinilai AI." : undefined,
    }),
  );
  const headRow = (r: number, q: Quadrant) => {
    g.row(r, 0, ["No", GROUP_HEAD[q], "Bobot"], { style: "header", fill: FILL.head });
    o.columns.forEach((_, j) => {
      g.set(r, asC(j), "AS", { style: "header", fill: FILL.head, center: true });
      g.set(r, tasC(j), "TAS", { style: "header", fill: FILL.head, center: true });
    });
  };

  let r = 4;
  let first = -1;
  let last = -1;
  for (const q of QUADRANTS) {
    headRow(r, q);
    r++;
    for (const f of o.factors.filter((x) => x.quadrant === q)) {
      if (first < 0) first = r;
      last = r;
      g.set(r, 0, f.id, { style: "label" });
      g.set(r, 1, f.text, { style: "text", src: "ai", note: "Faktor dari analisis Faktor S+W / O+T." });
      const bA = addr(r, 2, false).replace(/^([A-Z]+)/, "$$$1");
      g.set(r, 2, f.bobot, { fmt: "0.000", src: "ahp", note: "Bobot global hasil AHP di Faktor S+W / O+T (ubah perbandingannya di sana)." });
      o.columns.forEach((c, j) => {
        const raw = c.rawIndex === null ? undefined : o.strategies[c.rawIndex];
        const has = !!raw && f.id in (raw.as ?? {});
        const as = has ? raw!.as[f.id] : null;
        const asAddr = addr(r, asC(j));
        g.set(r, asC(j), typeof as === "number" ? as : null, {
          src: "ai",
          center: true,
          note: !raw ? "Strategi ini belum dinilai AI." : !has ? "Belum dinilai AI (kosong = tidak dihitung)." : undefined,
          edit: raw ? { path: ["strategies", c.rawIndex!, "as", f.id], type: "number", min: 0, max: 4, step: 1, allowEmpty: true } : undefined,
        });
        const t = tasCell(f.bobot, as);
        g.set(r, tasC(j), t ?? "", {
          f: `IF(AND(ISNUMBER(${bA}),ISNUMBER(${asAddr})),${bA}*${asAddr},"")`,
          fmt: "0.000",
          src: "hitung",
          explain:
            t === null
              ? `AS ${c.id} untuk ${f.id} kosong → TAS kosong dan tidak ikut dijumlahkan.`
              : `TAS ${c.id} untuk ${f.id} = Bobot × AS = ${num(f.bobot)} × ${num(as as number, 0)} = ${num(t)}`,
        });
      });
      r++;
    }
  }
  if (first < 0) {
    first = r;
    last = r;
  }
  // TOTAL
  const totRow = r;
  g.set(totRow, 0, "TOTAL", { style: "total", cs: 3, fill: FILL.head });
  o.columns.forEach((c, j) => {
    const col = colLetter(tasC(j));
    g.set(totRow, tasC(j), c.total, {
      style: "total",
      fmt: "0.000",
      fill: FILL.total,
      src: "hitung",
      f: `SUM(${col}${first + 1}:${col}${last + 1})`,
      explain: `Total TAS ${c.id} = jumlah TAS di kolom ini (${c.filled} dari ${o.factors.length} faktor terisi; sel kosong tidak dihitung) = ${num(c.total)}`,
    });
    g.anchor(`total_${c.id}`, totRow, tasC(j));
  });
  // Tabel peringkat (rumus RANK atas rentang bersebelahan)
  const rankHead = totRow + 3;
  const r1 = rankHead + 1;
  const rN = r1 + Math.max(0, n - 1);
  g.set(totRow + 1, 0, "PERINGKAT", { style: "label", cs: 3 });
  g.set(rankHead - 1, 0, "Peringkat strategi (1 = paling menarik)", { style: "subheader", cs: W });
  g.row(rankHead, 0, ["Kode", "Strategi", "Total TAS", "Peringkat"], { style: "header" });
  g.set(rankHead, 4, "Alasan AI", { style: "header", cs: Math.max(1, W - 4) });
  o.columns.forEach((c, j) => {
    const rr = r1 + j;
    g.set(rr, 0, c.id, { style: "label" });
    g.set(rr, 1, `${c.code ? `${c.code} ` : ""}${c.text}`, { style: "text" });
    g.set(rr, 2, c.total, {
      fmt: "0.000",
      src: "hitung",
      f: addr(totRow, tasC(j)),
      explain: `Total TAS ${c.id} dari baris TOTAL = ${num(c.total)}`,
    });
    g.set(rr, 3, c.rank, {
      src: "hitung",
      center: true,
      fill: c.rank === 1 ? FILL.top : undefined,
      f: `RANK(${addr(rr, 2)},${addr(r1, 2, true)}:${addr(rN, 2, true)})`,
      explain: `Peringkat ${c.id}: total ${num(c.total)} adalah terbesar ke-${c.rank} dari ${n} strategi (RANK, 1 = terbesar; nilai sama mendapat peringkat sama).`,
    });
    g.set(rr, 4, c.reason, { style: "muted", cs: Math.max(1, W - 4), src: "ai" });
    g.set(totRow + 1, asC(j), c.rank, {
      style: "total",
      cs: 2,
      center: true,
      fill: c.rank === 1 ? FILL.top : undefined,
      src: "hitung",
      f: addr(rr, 3),
      explain: `Peringkat ${c.id} (dari tabel peringkat di bawah) = ${c.rank}`,
    });
    g.anchor(`rank_${c.id}`, rr, 3);
  });
  return g.build({
    cols: [7, 44, 9, ...o.columns.flatMap(() => [6, 7])],
    freeze: { rows: 5, cols: 3 },
    notes: [
      "Setiap kolom = satu strategi dari matriks SWOT; setiap baris = satu faktor S, W, O, T dengan bobot AHP.",
      `AS (Attractiveness Score) diusulkan AI dan bisa Anda ubah: ${AS_SCALE}; 0 = tidak relevan; kosong = tidak dinilai.`,
      "TAS = Bobot × AS. TOTAL = jumlah TAS per strategi; strategi dengan total terbesar paling menarik (peringkat 1).",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  { name: "TAS", rumus: "TAS = Bobot × AS", arti: "Skor daya tarik tertimbang satu faktor untuk satu strategi; kosong bila AS kosong.", excel: '=IF(AND(ISNUMBER($C11), ISNUMBER(D11)), $C11*D11, "")' },
  { name: "Total TAS", rumus: "Total = Σ TAS semua faktor (S, W, O, T)", arti: "Daya tarik total strategi; hanya baris faktor sungguhan yang dijumlah.", excel: "=SUM(E11:E53)" },
  { name: "Peringkat", rumus: "Peringkat 1 = total TAS terbesar", arti: "Strategi dengan total terbesar paling menarik untuk dijalankan.", excel: "=RANK(total, semua total)" },
];

export const qspm: NodeDef<QspmRaw> = {
  key: "qspm",
  label: "QSPM",
  phase: 1,
  group: "sgs",
  sheetName: "SGS-QSPM",
  deps: ["swot_matrix", "faktor_internal", "faktor_eksternal"],
  kind: "llm",
  computedBy: "LLM mengusulkan AS 0–4; kode menghitung TAS = Bobot × AS, total, dan peringkat",
  description:
    "Menilai daya tarik (AS) setiap strategi matriks SWOT terhadap setiap faktor S, W, O, T berbobot AHP; total TAS menentukan peringkat strategi.",
  schema: QspmRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  prompt: promptOf,
  mock: (ctx) => mockQspm(ctx.inputs),
  validate: async (out, ctx, llm) => {
    const o = computeQspm(out, ctx.inputs);
    const text = new Map(o.factors.map((f) => [f.id, f.text]));
    const evalCols = o.columns.filter((c) => c.rawIndex !== null);
    const refAvg = (c: QspmColumn) => {
      const as = o.strategies[c.rawIndex!].as;
      const xs = c.factorRefs.map((r) => as?.[r]).filter((v): v is number => typeof v === "number");
      return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
    };
    return [
      ...qspmCodeChecks(out, ctx.inputs),
      await llmJudge(
        llm,
        "as_reasonable",
        "Periksa apakah nilai AS (1 tidak menarik … 4 sangat menarik; 0 tidak relevan) untuk setiap strategi masuk akal: faktor yang digabung strategi itu semestinya bernilai tinggi, faktor yang tidak berkaitan rendah atau 0, dan alasannya sesuai nilai.",
        evalCols.map((c) => {
          const as = o.strategies[c.rawIndex!].as;
          return {
            id: c.id,
            text: `${c.code} ${c.text} || AS faktor yang digabung: ${c.factorRefs.map((r) => `${r}=${as?.[r] ?? "kosong"}`).join(", ") || "-"} || AS lain: ${o.factors
              .filter((f) => !c.factorRefs.includes(f.id))
              .map((f) => `${f.id}=${as?.[f.id] ?? "-"}`)
              .join(", ")} || alasan: ${c.reason || "-"}`,
          };
        }),
        `Faktor:\n${[...text].map(([id, t]) => `${id}: ${t}`).join("\n")}`,
        (id) => {
          const c = evalCols.find((x) => x.id === id);
          const avg = c ? refAvg(c) : null;
          return avg === null || avg >= 2.5;
        },
      ),
    ];
  },
  compute: (out, ctx) => computeQspm(out, ctx.inputs),
  items: (out) => {
    const o = asOutput(out, {});
    const n = o.columns.length;
    return o.ranking.map((r) => {
      const c = o.columns.find((x) => x.id === r.id);
      return { id: r.id, text: `${c?.code ? `${c.code} ` : ""}${r.text}`, detail: `${r.type} · total TAS ${num(r.tas)} · peringkat ${r.rank}/${n}` };
    });
  },
  sheets: (out, ctx) => [qspmSheet(asOutput(out, ctx.inputs))],
  blocks: (out, ctx): Block[] => {
    const o = asOutput(out, ctx.inputs);
    const top = o.ranking[0];
    return [
      { type: "h2", text: "QSPM — peringkat strategi" },
      {
        type: "p",
        text: top
          ? `${o.columns.length} strategi dinilai terhadap ${o.factors.length} faktor. Strategi paling menarik: ${top.id} (total TAS ${num(top.tas)}).`
          : "Belum ada strategi yang dinilai.",
      },
      {
        type: "table",
        head: ["Peringkat", "ID", "Tipe", "Strategi", "Total TAS"],
        rows: o.ranking.map((r) => [String(r.rank), r.id, r.type, r.text, num(r.tas)]),
        widths: [10, 8, 8, 60, 14],
      },
      { type: "note", text: "TAS = Bobot × AS; total TAS = jumlah TAS semua faktor. Matriks AS lengkap ada di lampiran XLSX (sheet SGS-QSPM)." },
    ];
  },
  summary: (out) => {
    const o = asOutput(out, {});
    const [a, b] = o.ranking;
    if (!a) return "Belum ada strategi yang dinilai";
    return `Peringkat 1: ${a.id} (total TAS ${num(a.tas)})${b ? `; berikutnya ${b.id} (${num(b.tas)}${b.rank === a.rank ? ", seri" : ""})` : ""} dari ${o.ranking.length} strategi`;
  },
  repairHint: "Perbaiki hanya strategi/faktor yang ditolak; nilai AS lain salin apa adanya. Pastikan setiap strategi memuat semua ID faktor di \"as\".",
};
