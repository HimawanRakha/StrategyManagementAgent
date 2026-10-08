// Uji node SGS (posisi, matriks SWOT, QSPM, cascading), SI (kontinuitas proker), dan LTV (renstra).
// Data hulu dibangun manual sesuai lib/nodes/contracts.ts; angka emas dari tests/fixtures/excel-framework.json dan tab Excel.
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/excel-framework.json";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { FaktorComputed, MatrixScoreComputed, Quadrant, StrategyType } from "@/lib/nodes/contracts";
import type { LlmSession, NodeContext, NodeDef } from "@/lib/nodes/types";
import type { Grid, GridCell } from "@/lib/sheets/grid";
import { kendallTau, rankDesc, tasCell } from "@/lib/calc/qspm";
import { checkPosisi, computePosisi, kuadranOf, posisiOrganisasi } from "@/lib/nodes/sgs/posisi";
import { codeChecks as swotChecks, computeSwotMatrix, swotMatrix, SwotMatrixRaw } from "@/lib/nodes/sgs/swot-matrix";
import { computeQspm, qspm, qspmCodeChecks, QspmRaw } from "@/lib/nodes/sgs/qspm";
import { cascading, cascadingCodeChecks, computeCascading, mockCascading, CascadingRaw } from "@/lib/nodes/sgs/cascading";
import {
  computeKontinuitas,
  kontinuitasCodeChecks,
  kontinuitasProker,
  KontinuitasRaw,
  MATCHING,
  mockKontinuitas,
  suitability,
} from "@/lib/nodes/si/kontinuitas";
import { computeRenstra, mockRenstra, renstra, renstraCodeChecks, RenstraRaw } from "@/lib/nodes/ltv/renstra";

// ---------- Alat uji ----------

const llm: LlmSession = { json: async (_p, _s, _u, _schema, mock) => mock() };

function ctxOf(inputs: Record<string, unknown>, evidence: EvidenceChunk[] = []): NodeContext {
  return { projectId: "p", projectName: "BEM Uji", orgType: "BEM", runId: "r", nodeRunId: "n", inputs, evidence };
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function setAt(obj: unknown, path: (string | number)[], value: unknown) {
  let cur = obj as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
}
function getAt(obj: unknown, path: (string | number)[]) {
  let cur = obj as Record<string | number, unknown> | undefined;
  for (const k of path) cur = cur?.[k] as Record<string | number, unknown> | undefined;
  return cur;
}
const cellAt = (g: Grid, a1: string): GridCell | undefined =>
  g.cells.find((c) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
    const col = m[1].split("").reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return c.r === Number(m[2]) - 1 && c.c === col;
  });
const failed = (rs: { check: string; failures: { itemId?: string }[] }[], check: string) =>
  rs.find((r) => r.check === check)?.failures.map((f) => f.itemId) ?? [];

/** Semua sel edit harus menunjuk path yang ada (atau induknya ada) di output mentah. */
function expectEditPathsExist(grids: Grid[], raw: unknown) {
  const edits = grids.flatMap((g) => g.cells.filter((c) => c.edit));
  expect(edits.length).toBeGreaterThan(0);
  for (const c of edits) {
    const p = c.edit!.path;
    expect(getAt(raw, p.slice(0, -1)), `path ${p.join(".")}`).toBeDefined();
  }
}
/** Tidak ada sel yang tertimpa sel gabungan lain (rs/cs). */
function expectNoOverlap(grids: Grid[]) {
  for (const g of grids) {
    const owner = new Map<string, string>();
    for (const c of g.cells)
      for (let r = c.r; r < c.r + (c.rs ?? 1); r++)
        for (let k = c.c; k < c.c + (c.cs ?? 1); k++) {
          const key = `${r},${k}`;
          expect(owner.has(key), `${g.name}: sel ${key} dipakai ${owner.get(key)} dan ${c.r},${c.c}`).toBe(false);
          owner.set(key, `${c.r},${c.c}`);
        }
  }
}
/** Setiap sel berumus punya penjelasan awam. */
const expectExplained = (grids: Grid[]) => {
  for (const g of grids) for (const c of g.cells.filter((x) => x.f)) expect(c.explain, `${g.name} ${c.r},${c.c}`).toBeTruthy();
};

// ---------- Data hulu dari fixture Excel (tanpa nama orang) ----------

const sw = fixture.sw as { text: string; bobot: number; cat: string | null }[];
const ot = fixture.ot as { text: string; bobot: number; cat: string | null }[];
const N_S = 13;
const N_O = 3;
const fac = (q: Quadrant, k: number, x: { text: string; bobot: number; cat: string | null }) => ({
  id: `${q}${k}`,
  quadrant: q,
  category: x.cat ?? "",
  text: x.text,
  bobot: x.bobot,
  evidence: [],
});
const faktorInternal: FaktorComputed = {
  scope: "internal",
  factors: sw.map((x, i) => (i < N_S ? fac("S", i + 1, x) : fac("W", i - N_S + 1, x))),
  total: sw.reduce((s, x) => s + x.bobot, 0),
  ahp: [],
};
const faktorEksternal: FaktorComputed = {
  scope: "eksternal",
  factors: ot.map((x, i) => (i < N_O ? fac("O", i + 1, x) : fac("T", i - N_O + 1, x))),
  total: ot.reduce((s, x) => s + x.bobot, 0),
  ahp: [],
};
function matrixScore(scope: "internal" | "eksternal", f: typeof fixture.ifas, pos: Quadrant, neg: Quadrant): MatrixScoreComputed {
  let p = 0;
  let n = 0;
  const rows = f.rows.map((r) => {
    const q = r.score >= 0 ? pos : neg;
    const id = `${q}${q === pos ? ++p : ++n}`;
    return { id, quadrant: q, text: r.text, bobot: r.bobot, kp: r.kp, ks: r.ks, ki: r.ki, m: r.m, totalRating: r.total, score: r.score };
  });
  const total = rows.reduce((s, r) => s + r.score, 0);
  return {
    scope,
    rows,
    total,
    totalPositive: rows.filter((r) => r.score > 0).reduce((s, r) => s + r.score, 0),
    totalNegative: -rows.filter((r) => r.score < 0).reduce((s, r) => s + r.score, 0),
  };
}
const ifas = matrixScore("internal", fixture.ifas, "S", "W");
const efas = matrixScore("eksternal", fixture.efas, "O", "T");

/** Strategi tab SGS-QSPM (kode faktor seperti di kepala kolom QSPM), urutan matriks SWOT (SO, WO, ST, WT). */
const EXCEL_STRATEGIES: { id: string; type: StrategyType; text: string; refs: string }[] = [
  { id: "SO1", type: "SO", text: "Mengintegrasikan pengembangan kompetensi staf dengan kebutuhan komunikasi publik", refs: "S1 + S2 + O1" },
  { id: "SO2", type: "SO", text: "Memperkuat peran Biro Multimedia & Informasi sebagai media strategis", refs: "S3 + S5 + O1" },
  { id: "SO3", type: "SO", text: "Mengoptimalkan jejaring sebagai kanal kolaborasi dan distribusi informasi", refs: "S4 + S10 + O2" },
  { id: "SO4", type: "SO", text: "Membuka ruang knowledge sharing dan skill sharing lintas jejaring organisasi", refs: "S11 + S12 + O2" },
  { id: "SO5", type: "SO", text: "Menurunkan sasaran Renstra ke dalam WBS agar setiap fungsi punya keterkaitan jelas", refs: "S1 + S3 + S7 + O3" },
  { id: "SO6", type: "SO", text: "Mengembangkan sistem monitoring dan pelaporan yang terukur berdasarkan sasaran Renstra", refs: "S6 + S10 + O3" },
  { id: "WO1", type: "WO", text: "Menetapkan target dan indikator keberhasilan sejak awal periode", refs: "W1 + W2 + O3" },
  { id: "WO2", type: "WO", text: "Mempercepat standardisasi dan sosialisasi SOP administrasi melalui centralized knowledge base", refs: "W3 + W4 + W7 + O2" },
  { id: "WO3", type: "WO", text: "Melakukan rekrutmen berbasis kebutuhan melalui pemetaan kementerian yang defisit staf", refs: "W6 + O2" },
  { id: "WO4", type: "WO", text: "Menyusun pemetaan kebutuhan SDM dan indikator kinerja tiap kementerian", refs: "W2 + W6 + O3" },
  { id: "ST1", type: "ST", text: "Memperkuat transfer knowledge dan dokumentasi pengetahuan organisasi sebagai mekanisme regenerasi", refs: "S1 + S11 + T5" },
  { id: "ST2", type: "ST", text: "Memperjelas pembagian kewenangan dan alur eskalasi melalui WBS", refs: "S3 + S7 + T4" },
  { id: "ST3", type: "ST", text: "Membangun jalur komunikasi administratif yang jelas dan terdokumentasi", refs: "S4 + S10 + T3" },
  { id: "ST4", type: "ST", text: "Memperkuat dokumentasi, monitoring, dan evaluasi berbasis indikator sebagai akuntabilitas internal", refs: "S6 + S8 + T1" },
  { id: "WT1", type: "WT", text: "Menetapkan standar kinerja minimum sebagai dasar evaluasi yang objektif", refs: "W2 + T1" },
  { id: "WT2", type: "WT", text: "Membangun sistem substitusi jabatan dan delegasi berjenjang melalui matriks RACI", refs: "W5 + T3 + T4" },
  { id: "WT3", type: "WT", text: "Membentuk sistem knowledge management pada setiap posisi strategis", refs: "W5 + T5" },
];
const swotRaw: SwotMatrixRaw = SwotMatrixRaw.parse({
  strategies: EXCEL_STRATEGIES.map((s) => ({ id: s.id, type: s.type, factorRefs: s.refs, text: `${s.text}.` })),
});
const baseInputs = { faktor_internal: faktorInternal, faktor_eksternal: faktorEksternal, ifas, efas };
const posisi = computePosisi(undefined, baseInputs);
const swotOut = computeSwotMatrix(swotRaw, { ...baseInputs, posisi_organisasi: posisi });

/** AS tab SGS-QSPM (baris faktor sungguhan), kolom urut Excel: SO1–SO6, ST1–ST4, WO1–WO4, WT1–WT3. */
const QSPM_COLS = ["SO1", "SO2", "SO3", "SO4", "SO5", "SO6", "ST1", "ST2", "ST3", "ST4", "WO1", "WO2", "WO3", "WO4", "WT1", "WT2", "WT3"];
const AS: Record<string, number[]> = {
  S1: [4, 3, 2, 3, 4, 3, 3, 2, 1, 2, 4, 1, 2, 3, 3, 1, 2],
  S2: [4, 3, 2, 4, 2, 2, 3, 1, 1, 1, 2, 1, 2, 2, 2, 1, 2],
  S3: [2, 4, 2, 1, 4, 3, 2, 4, 2, 2, 3, 2, 2, 3, 3, 4, 2],
  S4: [1, 1, 4, 1, 3, 3, 2, 2, 4, 2, 1, 4, 1, 1, 1, 2, 3],
  S5: [3, 4, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1],
  S6: [3, 2, 2, 2, 3, 4, 2, 2, 2, 4, 4, 2, 1, 3, 4, 2, 2],
  S7: [2, 3, 2, 1, 4, 3, 2, 4, 2, 2, 2, 2, 1, 2, 2, 4, 2],
  S8: [4, 2, 2, 4, 1, 1, 3, 2, 1, 3, 2, 1, 4, 3, 3, 2, 1],
  S9: [3, 2, 3, 4, 2, 3, 2, 3, 2, 2, 2, 1, 1, 2, 2, 3, 1],
  S10: [2, 1, 4, 2, 3, 4, 2, 3, 4, 3, 2, 3, 2, 2, 2, 3, 2],
  S11: [4, 2, 2, 4, 2, 2, 4, 1, 1, 2, 1, 3, 1, 1, 1, 2, 4],
  S12: [2, 1, 3, 4, 2, 2, 3, 2, 1, 1, 1, 1, 2, 1, 1, 2, 1],
  S13: [4, 3, 2, 3, 2, 2, 3, 2, 1, 2, 2, 2, 3, 2, 2, 2, 2],
  W1: [2, 3, 2, 2, 4, 3, 3, 2, 2, 2, 4, 3, 3, 3, 3, 2, 2],
  W2: [2, 2, 2, 1, 4, 4, 2, 2, 1, 4, 4, 1, 2, 4, 4, 2, 2],
  W3: [1, 1, 4, 1, 3, 3, 1, 3, 4, 2, 1, 4, 0, 1, 1, 2, 2],
  W4: [3, 2, 3, 3, 4, 3, 2, 3, 3, 2, 2, 4, 1, 1, 2, 2, 3],
  W5: [3, 3, 3, 4, 3, 3, 4, 3, 2, 2, 2, 2, 3, 3, 2, 4, 4],
  W6: [4, 1, 3, 4, 1, 2, 2, 2, 1, 1, 2, 1, 4, 4, 2, 4, 2],
  W7: [3, 3, 3, 4, 4, 3, 3, 3, 3, 2, 2, 4, 1, 1, 2, 3, 3],
  O1: [4, 4, 3, 2, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  O2: [2, 3, 4, 4, 2, 2, 2, 1, 2, 1, 1, 3, 4, 2, 1, 1, 2],
  O3: [3, 2, 2, 2, 4, 4, 3, 2, 2, 3, 4, 2, 2, 4, 3, 2, 3],
  T1: [2, 1, 3, 3, 3, 2, 1, 3, 2, 2, 1, 2, 4, 3, 2, 2, 2],
  T2: [2, 2, 4, 2, 3, 3, 1, 2, 4, 1, 1, 2, 1, 1, 1, 4, 1],
  T3: [3, 1, 2, 3, 4, 4, 4, 2, 1, 2, 3, 2, 1, 2, 3, 2, 4],
  T4: [2, 1, 3, 1, 4, 4, 2, 2, 2, 4, 3, 2, 1, 2, 4, 2, 2],
  T5: [2, 4, 3, 2, 2, 4, 1, 1, 1, 2, 0, 2, 0, 0, 1, 1, 2],
};
const qspmRawExcel = (): QspmRaw => ({
  strategies: QSPM_COLS.map((id, j) => ({ id, as: Object.fromEntries(Object.entries(AS).map(([f, xs]) => [f, xs[j]])), reason: "" })),
});
/** Total yang BENAR (hanya baris faktor sungguhan). */
const CORRECT_TOTALS = [5.184, 4.018, 5.426, 4.669, 6.44, 6.245, 4.483, 4.371, 3.84, 4.709, 4.506, 4.172, 3.432, 4.283, 4.854, 4.264, 4.494];
/**
 * Baris sisa templat di tab SGS-QSPM yang masih berada di dalam rentang TOTAL =SUM(E11:E53): S5–S9 (baris 24–28),
 * W5–W9 (37–41), O5–O6 (46–47). Hanya tiga kolom pertama (SO1–SO3) yang terisi AS; E46/E47 tidak punya rumus TAS.
 * Baris T5–T6 (54–55) berada di luar rentang SUM sehingga tidak ikut.
 */
const LEFTOVER: { id: string; bobot: number; as: (number | null)[] }[] = [
  { id: "S5x", bobot: 0.02, as: [1, 0, 1] },
  { id: "S6x", bobot: 0.06, as: [4, 2, 2] },
  { id: "S7x", bobot: 0.08, as: [0, 2, 3] },
  { id: "S8x", bobot: 0.08, as: [3, 4, 3] },
  { id: "S9x", bobot: 0.03, as: [4, 4, 1] },
  { id: "W5x", bobot: 0.03, as: [3, 2, 4] },
  { id: "W6x", bobot: 0.03, as: [4, 1, 3] },
  { id: "W7x", bobot: 0.02, as: [3, 2, 4] },
  { id: "W8x", bobot: 0.08, as: [0, 4, 3] },
  { id: "W9x", bobot: 0.07, as: [3, 0, 4] },
  { id: "O5x", bobot: 0.1, as: [null, 1, 2] },
  { id: "O6x", bobot: 0.06, as: [null, 2, 4] },
];

// ---------- Posisi organisasi ----------

describe("posisi_organisasi (SGSOP)", () => {
  it("emas: X = ESIFAS!T27, Y = ESEFAS!T15 → kuadran II Diversifikasi (ST)", () => {
    expect(posisi.x).toBeCloseTo(fixture.ifas.total, 6);
    expect(posisi.y).toBeCloseTo(fixture.efas.total, 6);
    expect(posisi.kuadran).toBe("II");
    expect(posisi.fokus).toBe("ST");
    expect(posisi.strategi).toBe("Diversifikasi");
  });
  it("aturan kuadran (nol dihitung ke sisi positif)", () => {
    expect(kuadranOf(0, 0)).toBe("I");
    expect(kuadranOf(0.5, -0.1)).toBe("II");
    expect(kuadranOf(-0.1, 0)).toBe("III");
    expect(kuadranOf(-1, -1)).toBe("IV");
  });
  it("run → compute memakai IFAS/EFAS terbaru (edit di hulu ikut terbawa), output mentah hanya cadangan", async () => {
    const raw = await posisiOrganisasi.run!(ctxOf(baseInputs), llm);
    expect(posisiOrganisasi.schema.safeParse(raw).success).toBe(true);
    const ifas2 = { ...ifas, total: -0.5 };
    const o = posisiOrganisasi.compute!(raw, ctxOf({ ...baseInputs, ifas: ifas2 })) as ReturnType<typeof computePosisi>;
    expect(o.kuadran).toBe("IV");
    const fallback = posisiOrganisasi.compute!({ x: -1, y: 2 }, ctxOf({})) as ReturnType<typeof computePosisi>;
    expect(fallback.kuadran).toBe("III");
  });
  it("sheet: rujukan {{ifas!total}} / {{efas!total}}, grafik kuadran, rumus kuadran berpenjelasan", () => {
    const [g] = posisiOrganisasi.sheets!(posisi, { label: "Posisi", inputs: baseInputs });
    expect(g.name).toBe("SGSOP");
    expect(g.cells.some((c) => c.f === "{{ifas!total}}" && c.v === posisi.x)).toBe(true);
    expect(g.cells.some((c) => c.f === "{{efas!total}}" && c.v === posisi.y)).toBe(true);
    expect(g.chart?.type).toBe("quadrant");
    expect(g.cells.find((c) => c.f?.startsWith("IF("))?.v).toBe("II");
    expectExplained([g]);
    expectNoOverlap([g]);
  });
  it("cek: lolos dengan data lengkap; gagal bila EFAS tidak ada atau total tidak cocok", () => {
    expect(checkPosisi(baseInputs).every((c) => c.passed)).toBe(true);
    expect(failed(checkPosisi({ ifas }), "data_hulu")).toEqual(["EFAS"]);
    expect(failed(checkPosisi({ ifas: { ...ifas, total: 9 }, efas }), "total_cocok")).toEqual(["IFAS"]);
  });
});

// ---------- Matriks SWOT ----------

describe("swot_matrix (SGSSWOT-SM)", () => {
  it("strategi Excel lolos cek kode; kode faktor teks diurai menjadi daftar", () => {
    expect(swotRaw.strategies[4].factorRefs).toEqual(["S1", "S3", "S7", "O3"]);
    expect(swotChecks(swotRaw, baseInputs).every((c) => c.passed)).toBe(true);
    expect(swotOut.strategies[0].code).toBe("S1 + S2 + O1");
    expect(swotOut.counts).toEqual({ SO: 6, WO: 4, ST: 4, WT: 3 });
    expect(swotOut.fokus).toBe("ST");
  });
  it("cek gagal: faktor tidak ada, tipe tidak cocok, ID salah, strategi ganda, tipe kosong", () => {
    const bad = clone(swotRaw);
    bad.strategies[0].factorRefs = ["S1", "W2", "O9"];
    bad.strategies[1].id = "WO7";
    bad.strategies[3].text = bad.strategies[2].text;
    bad.strategies = bad.strategies.filter((s) => s.type !== "WT");
    const rs = swotChecks(bad, baseInputs);
    expect(failed(rs, "ref_exists")).toContain("SO1");
    expect(failed(rs, "ref_type_match")).toContain("SO1");
    expect(failed(rs, "id_format")).toContain("WO7");
    expect(failed(rs, "no_duplicate")).toContain("SO4");
    expect(failed(rs, "type_coverage")).toEqual(["WT"]);
  });
  it("mock: lolos skema dan semua cek (kode + LLM mock), fokus ST lebih banyak", async () => {
    const ctx = ctxOf({ ...baseInputs, posisi_organisasi: posisi });
    const raw = swotMatrix.mock!(ctx);
    expect(swotMatrix.schema.safeParse(raw).success).toBe(true);
    const rs = await swotMatrix.validate!(raw, ctx, llm);
    expect(rs.filter((r) => !r.passed)).toEqual([]);
    const counts = computeSwotMatrix(raw, ctx.inputs).counts;
    expect(counts.ST).toBeGreaterThan(counts.SO);
    expect(swotMatrix.prompt!(ctx).user).toContain("kuadran II");
  });
  it("sheet: sel kode faktor dan kalimat bisa diedit; edit kode → skema mengurai → kode baru", () => {
    const [g] = swotMatrix.sheets!(swotOut, { label: "SWOT", inputs: baseInputs });
    expectEditPathsExist([g], swotRaw);
    expectNoOverlap([g]);
    const codeCell = g.cells.find((c) => c.edit?.path.join(".") === "strategies.0.factorRefs")!;
    expect(codeCell.v).toBe("S1 + S2 + O1");
    const raw = clone(swotRaw);
    setAt(raw, codeCell.edit!.path, "O2 + S3");
    const parsed = SwotMatrixRaw.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(computeSwotMatrix(parsed.data!, baseInputs).strategies[0].code).toBe("S3 + O2");
    expect(g.cells.some((c) => String(c.v).startsWith("SO Strategies use"))).toBe(true);
  });
});

// ---------- QSPM ----------

describe("qspm (SGS-QSPM)", () => {
  const inputs = { ...baseInputs, swot_matrix: swotOut, posisi_organisasi: posisi };
  const out = computeQspm(qspmRawExcel(), inputs);

  it("TAS = Bobot × AS; AS kosong → TAS kosong (IF(AND(ISNUMBER…)))", () => {
    expect(tasCell(0.088, 4)).toBeCloseTo(0.352, 9);
    expect(tasCell(0.088, null)).toBeNull();
    expect(tasCell(0.088, 0)).toBe(0);
    expect(rankDesc([3, 5, 5, 1])).toEqual([3, 1, 1, 4]);
  });
  it("kolom diurutkan seperti Excel (SO → ST → WO → WT) dari urutan matriks SWOT", () => {
    expect(out.columns.map((c) => c.id)).toEqual(QSPM_COLS);
  });
  it("emas: total TAS yang BENAR (hanya baris faktor sungguhan) dan peringkat", () => {
    out.columns.forEach((c, j) => expect(c.total, c.id).toBeCloseTo(CORRECT_TOTALS[j], 6));
    expect(out.selected).toBe("SO5");
    expect(out.ranking.slice(0, 3).map((r) => r.id)).toEqual(["SO5", "SO6", "SO3"]);
    expect(out.ranking.find((r) => r.id === "WO3")?.rank).toBe(17);
    expect(out.totals.find((t) => t.strategyId === "SO5")?.rank).toBe(1);
  });
  it("galat Excel direproduksi: TOTAL =SUM(E11:E53) ikut menjumlah baris sisa templat → qspmTotals fixture", () => {
    const withLeftover = {
      ...inputs,
      faktor_internal: { ...faktorInternal, factors: [...faktorInternal.factors, ...LEFTOVER.filter((l) => /^[SW]/.test(l.id)).map((l) => ({ ...fac(l.id[0] as Quadrant, 0, { text: l.id, bobot: l.bobot, cat: null }), id: l.id }))] },
      faktor_eksternal: { ...faktorEksternal, factors: [...faktorEksternal.factors, ...LEFTOVER.filter((l) => /^O/.test(l.id)).map((l) => ({ ...fac("O", 0, { text: l.id, bobot: l.bobot, cat: null }), id: l.id }))] },
    };
    const raw = qspmRawExcel();
    raw.strategies.forEach((s, j) => LEFTOVER.forEach((l) => (s.as[l.id] = j < 3 ? l.as[j] : null)));
    const excel = computeQspm(raw, withLeftover);
    excel.columns.forEach((c, j) => expect(c.total, c.id).toBeCloseTo(fixture.qspmTotals[j], 6));
    // Akibatnya peringkat 1 di Excel menjadi SO3 (7,326), padahal yang benar SO5 (6,440).
    expect(excel.selected).toBe("SO3");
    expect(fixture.qspmTotals.slice(0, 3).map((t, j) => +(t - CORRECT_TOTALS[j]).toFixed(3))).toEqual([1.1, 1.39, 1.9]);
  });
  it("sheet: AS bisa diedit → skema → total naik sebesar Bobot × ΔAS; TOTAL & RANK berumus", () => {
    const raw = qspmRawExcel();
    const [g] = qspm.sheets!(out, { label: "QSPM", inputs });
    expectEditPathsExist([g], raw);
    expectExplained([g]);
    expectNoOverlap([g]);
    const cell = g.cells.find((c) => c.edit?.path.join(".") === "strategies.0.as.S2")!;
    expect(cell.v).toBe(4);
    setAt(raw, cell.edit!.path, 1);
    const parsed = QspmRaw.safeParse(raw);
    expect(parsed.success).toBe(true);
    const o2 = computeQspm(parsed.data!, inputs);
    expect(o2.columns[0].total).toBeCloseTo(CORRECT_TOTALS[0] - 0.059 * 3, 6);
    setAt(raw, cell.edit!.path, null); // dikosongkan
    expect(computeQspm(QspmRaw.parse(raw), inputs).columns[0].total).toBeCloseTo(CORRECT_TOTALS[0] - 0.059 * 4, 6);
    expect(g.cells.some((c) => /^SUM\(E\d+:E\d+\)$/.test(c.f ?? ""))).toBe(true);
    expect(g.cells.some((c) => c.f?.startsWith("RANK(") && c.v === 1)).toBe(true);
    expect(g.cells.some((c) => c.f?.startsWith("IF(AND(ISNUMBER($C"))).toBe(true);
    expect(g.anchors?.total_SO5).toBeTruthy();
  });
  it("cek: data Excel lolos; sel hilang, null sebagian, AS di luar skala, dan peringkat rapuh terdeteksi", () => {
    expect(qspmCodeChecks(qspmRawExcel(), inputs).every((c) => c.passed)).toBe(true);
    const bad = qspmRawExcel();
    delete bad.strategies[1].as.T5;
    bad.strategies[2].as.O1 = null;
    bad.strategies[3].as.S1 = 7;
    bad.strategies = bad.strategies.filter((s) => s.id !== "WT3");
    const rs = qspmCodeChecks(bad, inputs);
    expect(failed(rs, "coverage")).toEqual(expect.arrayContaining(["WT3", "SO2", "O1"]));
    expect(failed(rs, "as_range")).toEqual(["SO4"]);
    // Peringkat rapuh: SO1 dan SO3 dinaikkan sehingga SO5 (6,440) hanya unggul tipis; menurunkan AS SO5 untuk T4
    // (bobot 0,321) satu poin → 6,119 < SO1 6,310, SO6 6,245, SO3 6,193 → peringkat 4.
    const fragile = qspmRawExcel();
    Object.assign(fragile.strategies[0].as, { T4: 4, T3: 4, T1: 4 });
    Object.assign(fragile.strategies[2].as, { T4: 4, T1: 4, T3: 4 });
    const fo = computeQspm(fragile, inputs);
    expect(fo.columns[0].total).toBeCloseTo(6.31, 6);
    expect(fo.columns[2].total).toBeCloseTo(6.193, 6);
    expect(failed(qspmCodeChecks(fragile, inputs), "ranking_stability")).toEqual(["SO5"]);
    // Penilaian seragam
    const flat = qspmRawExcel();
    for (const k of Object.keys(flat.strategies[16].as)) flat.strategies[16].as[k] = 3;
    expect(failed(qspmCodeChecks(flat, inputs), "ranking_stability")).toEqual(["WT3"]);
  });
  it("mock: lolos skema dan semua cek; prompt ringkas memuat semua ID faktor", async () => {
    const ctx = ctxOf(inputs);
    const raw = qspm.mock!(ctx);
    expect(qspm.schema.safeParse(raw).success).toBe(true);
    const rs = await qspm.validate!(raw, ctx, llm);
    expect(rs.filter((r) => !r.passed)).toEqual([]);
    expect(qspm.prompt!(ctx).system).toContain("S1, S2, S3");
    expect(kendallTau(["A", "B", "C"], ["A", "B", "C"])).toBe(1);
  });
});

// ---------- Cascading ----------

describe("cascading (SGSCASCADING)", () => {
  const qspmOut = computeQspm(qspmRawExcel(), { ...baseInputs, swot_matrix: swotOut });
  const inputs = { qspm: qspmOut, swot_matrix: swotOut };
  const evidence: EvidenceChunk[] = [
    { id: "C1", content: "Nilai organisasi kami adalah kekeluargaan, profesionalitas, dan pengabdian kepada mahasiswa.", source: "adart.txt", kind: "document", focus: "nilai" },
  ];
  const ctx = ctxOf(inputs, evidence);
  const raw = mockCascading(ctx);

  it("mock: lolos skema dan semua cek (top-5 QSPM menjadi SI, index A.1.1, kutipan nilai)", async () => {
    expect(cascading.schema.safeParse(raw).success).toBe(true);
    const rs = await cascading.validate!(raw, ctx, llm);
    expect(rs.filter((r) => !r.passed)).toEqual([]);
    const o = computeCascading(raw, inputs);
    expect(o.topK).toEqual(["SO5", "SO6", "SO3", "SO1", "WT1"]);
    expect(o.missingTop).toEqual([]);
    expect(o.visiEvidence[0].chunkId).toBe("C1");
  });
  it("cek gagal: strategi top-k hilang, rujukan tidak ada, index salah", () => {
    const bad: CascadingRaw = clone(raw);
    const first = bad.aspects[0].objectives[0].initiatives;
    const removed = first.shift()!;
    first[0].strategyRef = "XX9";
    bad.aspects[0].objectives[0].id = "A.2";
    const rs = cascadingCodeChecks(bad, ctx);
    expect(failed(rs, "top_k_covered")).toContain(removed.strategyRef);
    expect(failed(rs, "ref_exists").length).toBe(1);
    expect(failed(rs, "index_format")).toContain("A.2");
  });
  it("sheet: visi/misi/SO/SI dan rujukan strategi bisa diedit; anchor visi & misi untuk renstra", () => {
    const o = computeCascading(raw, inputs);
    const [g] = cascading.sheets!(o, { label: "Cascading", inputs });
    expectEditPathsExist([g], raw);
    expectNoOverlap([g]);
    expect(g.anchors?.visi).toBe("B3");
    expect(g.anchors?.misi_A).toBeTruthy();
    const ref = g.cells.find((c) => c.edit?.path.at(-1) === "strategyRef")!;
    expect(ref.edit?.type).toBe("select");
    const r2 = clone(raw);
    setAt(r2, ref.edit!.path, "WO3");
    expect(CascadingRaw.safeParse(r2).success).toBe(true);
    expect(g.cells.some((c) => String(c.v).startsWith("Menggunakan kalimat pasif"))).toBe(true);
  });
});

// ---------- Kontinuitas proker ----------

describe("kontinuitas_proker (SIKONTINUITAS PROKER)", () => {
  const rows = fixture.kontinuitas as { name: string; e: number[]; i: number[]; effort: number; impact: number; effortLevel: string; impactLevel: string; kuadran: string; rekomendasi: string }[];
  const raw: KontinuitasRaw = KontinuitasRaw.parse({
    proker: rows.map((r, n) => ({
      id: `P${n}`,
      name: r.name,
      e: r.e,
      i: r.i,
      rekomendasi: r.rekomendasi,
      keterangan: "Keterangan.",
      alasanEffort: "E1 = a; E2 = b; E3 = c",
      alasanImpact: "I1 = a; I2 = b; I3 = c",
      evidence: [],
    })),
  });

  it("emas: Avg = SUMPRODUCT, Low/High < 2,51, kuadran sama dengan Excel", () => {
    const o = computeKontinuitas(raw);
    expect(o.weights).toEqual({ effort: [0.35, 0.35, 0.3], impact: [0.3, 0.5, 0.2] });
    o.proker.forEach((p, n) => {
      expect(p.effort, rows[n].name).toBeCloseTo(rows[n].effort, 9);
      expect(p.impact, rows[n].name).toBeCloseTo(rows[n].impact, 9);
      expect(p.effortLevel).toBe(rows[n].effortLevel);
      expect(p.impactLevel).toBe(rows[n].impactLevel);
      expect(p.kuadran).toBe(rows[n].kuadran);
    });
  });
  it("Matching Matrix (warna sel tab MATRIX) dan galat Excel: dua proker HEHI diberi Keep it & Continue", () => {
    expect(MATCHING["Low Effort High Impact"]).toEqual({ most: ["Keep it & Continue"], suitable: ["Improve & Continue"] });
    expect(MATCHING["High Effort High Impact"]).toEqual({ most: ["Improve & Continue"], suitable: ["Combine", "Substitute"] });
    expect(MATCHING["Low Effort Low Impact"]).toEqual({ most: ["Combine", "Improve & Continue"], suitable: ["Eliminate"] });
    expect(MATCHING["High Effort Low Impact"]).toEqual({ most: ["Eliminate"], suitable: ["Substitute"] });
    expect(suitability("High Effort High Impact", "Keep it & Continue")).toBe("unsuitable");
    const rs = kontinuitasCodeChecks(raw, { evidence: [] });
    const bad = failed(rs, "rekomendasi_sesuai").map((id) => rows[Number(id!.slice(1))].name);
    expect(bad).toEqual(["Tata Kelola Organisasi", "Monitoring dan Evaluasi Kuartal"]);
  });
  it("edit: bobot indikator & skor → skema → rata-rata baru; rekomendasi dinormalkan", () => {
    const o = computeKontinuitas(raw);
    const grids = kontinuitasProker.sheets!(o, { label: "Kontinuitas", inputs: {} });
    expect(grids.map((g) => g.name)).toEqual(["SIKONTINUITAS PROKER-INTRO", "SIKONTINUITAS PROKER-ANALYSIS S", "SIKONTINUITAS PROKER-MATRIX"]);
    expectEditPathsExist(grids, raw);
    expectExplained(grids);
    expectNoOverlap(grids);
    const analysis = grids[1];
    expect(cellAt(analysis, "F4")?.f).toBe("SUMPRODUCT($C$3:$E$3,C4:E4)");
    expect(cellAt(analysis, "G4")?.f).toBe('IF(F4<2.51,"Low Effort","High Effort")');
    expect(cellAt(analysis, "M4")?.f).toBe('G4&" "&L4');
    expect(analysis.chart).toMatchObject({ type: "scatter", threshold: 2.51, max: 5 });
    const r2 = clone(raw);
    setAt(r2, cellAt(analysis, "C3")!.edit!.path, 0.5); // bobot E1
    setAt(r2, cellAt(analysis, "D3")!.edit!.path, 0.2); // bobot E2
    setAt(r2, cellAt(analysis, "D4")!.edit!.path, 5); // E2 proker pertama
    const p = KontinuitasRaw.safeParse(r2);
    expect(p.success).toBe(true);
    expect(computeKontinuitas(p.data!).proker[0].effort).toBeCloseTo(0.5 * 1 + 0.2 * 5 + 0.3 * 2, 9);
    expect(KontinuitasRaw.parse({ proker: [{ ...raw.proker[0], rekomendasi: "keep it and continue" }] }).proker[0].rekomendasi).toBe("Keep it & Continue");
  });
  it("mock dari potongan LPJ: lolos skema dan semua cek", async () => {
    const evidence: EvidenceChunk[] = [
      { id: "C1", content: "Program kerja Upgrading Staff dilaksanakan dua kali dengan 25 panitia dan anggaran Rp2.000.000.", source: "lpj.txt", kind: "document" },
      { id: "C2", content: "Kegiatan Sekre Care berjalan setiap minggu untuk merapikan sekretariat bersama pengurus.", source: "lpj.txt", kind: "document" },
      { id: "C3", content: "Proker Inven Track telah mendata seluruh inventaris organisasi secara digital.", source: "lpj.txt", kind: "document" },
    ];
    const ctx = ctxOf({}, evidence);
    const m = kontinuitasProker.mock!(ctx);
    expect(kontinuitasProker.schema.safeParse(m).success).toBe(true);
    expect(m.proker.map((p) => p.name)).toEqual(["Upgrading Staff", "Sekre Care", "Inven Track"]);
    const rs = await kontinuitasProker.validate!(m, ctx, llm);
    expect(rs.filter((r) => !r.passed)).toEqual([]);
    expect(mockKontinuitas({ evidence: [] }).proker).toEqual([]);
    expect(kontinuitasProker.prompt!(ctx).system).toContain("Melibatkan ≤5 SDM secara aktif");
  });
});

// ---------- Renstra ----------

describe("renstra (LTVMRENSTRA)", () => {
  const qspmOut = computeQspm(qspmRawExcel(), { ...baseInputs, swot_matrix: swotOut });
  const casc = computeCascading(mockCascading(ctxOf({ qspm: qspmOut, swot_matrix: swotOut })), { qspm: qspmOut });
  const inputs = { cascading: casc };

  /** Isi tab LTVMRENSTRA (3 misi, 3 tahun, milestone A–F, 12 arah kerja). */
  const excelRaw: RenstraRaw = RenstraRaw.parse({
    sasaranUmum: "Strategis Internal, Regenerasi, dan Opini Publik",
    years: [
      ["Mengunci dan mempertahakan kondisi internal agar menjadi fondasi kuat untuk 2 tahun berikutnya.", [
        ["A", "Integrasi sistem administrasi & koordinasi lintas bidang dan Standardisasi SOP lintas fungsi", ["% kementerian/biro menggunakan sistem terintegrasi", "100% di akhir tahun 1"], ["Jumlah SOP yang disahkan & diimplementasikan", "Minimal 1 SOP per bidang"]],
        ["B", "Pemetaan kompetensi & beban kerja SDM serta efisiensi alokasi anggaran & aset organisasi", ["% pengurus yang dipetakan kompetensinya", "100% pengurus aktif"], ["Serapan anggaran sesuai rencana kerja", "≥90% sesuai RAB"]],
      ]],
      ["Menjaga kekuatan internal", [
        ["C", "Program capacity building terstruktur dan manajemen pengetahuan organisasi", ["Jumlah pelatihan terlaksana per bidang", "Minimal 2x per bidang/tahun"], ["Dokumen knowledge base yang tersusun", "1 database terpusat aktif"]],
        ["D", "Sistem rekrutmen & kaderisasi berkelanjutan serta mentoring & suksesi kepemimpinan", ["Rasio kader baru terhadap kebutuhan posisi", "≥80% posisi terisi kader terlatih"], ["% calon pemimpin yang menjalani mentoring", "100% kandidat strategis"]],
      ]],
      ["Ekspansi eksternal dengan modal internal yang sudah matang", [
        ["E", "Branding & positioning di ruang publik serta konten strategis & responsif isu publik", ["Peningkatan awareness/engagement media", "Naik ≥30% dari baseline"], ["Jumlah & kecepatan respons konten terhadap isu", "Respons <24 jam"]],
        ["F", "Kolaborasi & kemitraan strategis eksternal dan monitoring opini publik & reputasi", ["Jumlah kemitraan aktif terjalin", "Minimal 3 kemitraan baru"], ["Skor sentimen/reputasi publik", "Bergeser ke arah positif (net sentiment naik)"]],
      ]],
    ].map(([fokus, ms], y) => ({
      tahun: y + 1,
      fokus,
      milestones: (ms as [string, string, [string, string], [string, string]][]).map(([id, text, a1, a2], k) => ({
        id,
        text,
        misiRefs: [`M${(y % casc.aspects.length) + 1}`, ...(k === 1 && casc.aspects.length > 3 ? ["M4"] : [])],
        arah: [a1, a2].map(([indikator, target], n) => ({ id: `${id}${n + 1}`, text: `Arah kerja ${id}${n + 1}`, indikator, target })),
      })),
    })),
  });

  it("isi tab Excel: hanya target F2 yang tidak terukur", () => {
    const rs = renstraCodeChecks(excelRaw, inputs);
    expect(failed(rs, "measurable")).toEqual(["F2"]);
    expect(failed(rs, "index_format")).toEqual([]);
    expect(failed(rs, "years_complete")).toEqual([]);
  });
  it("compute: visi & misi diambil dari cascading", () => {
    const o = computeRenstra(excelRaw, inputs);
    expect(o.visi).toBe(casc.visi);
    expect(o.misi).toEqual(casc.aspects.map((a) => a.misi));
    expect(o.counts).toEqual({ milestones: 6, arah: 12 });
  });
  it("cek gagal: misi tidak didukung, tahun hilang, index salah, rujukan SI tidak ada", () => {
    const bad = clone(excelRaw);
    bad.years = bad.years.slice(0, 2);
    bad.years.forEach((y) => y.milestones.forEach((m) => (m.misiRefs = ["M1"])));
    bad.years[0].milestones[1].id = "Z";
    bad.years[0].milestones[0].arah[0].siRefs = ["Q.9.9"];
    const rs = renstraCodeChecks(bad, inputs);
    expect(failed(rs, "misi_covered")).toEqual(expect.arrayContaining(["M2"]));
    expect(failed(rs, "years_complete")).toContain("TAHUN 3");
    expect(failed(rs, "index_format")).toContain("Z");
    expect(failed(rs, "ref_exists")).toEqual(["A1"]);
  });
  it("tahun tidak urut di output mentah: sheet tetap urut, path edit menunjuk index mentah", () => {
    const shuffled = clone(excelRaw);
    shuffled.years = [shuffled.years[2], shuffled.years[0], shuffled.years[1]];
    const [g] = renstra.sheets!(computeRenstra(shuffled, inputs), { label: "Renstra", inputs });
    expect(cellAt(g, "D2")?.v).toBe("TAHUN KE 1");
    expect(cellAt(g, "E2")?.edit?.path).toEqual(["years", 1, "fokus"]);
    expect(cellAt(g, "K13")?.edit?.path).toEqual(["years", 0, "milestones", 1, "arah", 1, "target"]);
    expect(renstraCodeChecks(shuffled, inputs).find((c) => c.check === "index_format")?.passed).toBe(true);
  });
  it("mock: lolos skema dan semua cek", async () => {
    const ctx = ctxOf(inputs);
    const m = renstra.mock!(ctx);
    expect(renstra.schema.safeParse(m).success).toBe(true);
    const rs = await renstra.validate!(m, ctx, llm);
    expect(rs.filter((r) => !r.passed)).toEqual([]);
    expect(mockRenstra({}).years.length).toBe(3);
  });
  it("sheet: visi/misi merujuk sheet Cascading, sel gabungan per tahun, target bisa diedit", () => {
    const o = computeRenstra(excelRaw, inputs);
    const [g] = renstra.sheets!(o, { label: "Renstra", inputs });
    expectEditPathsExist([g], excelRaw);
    expectExplained([g]);
    expectNoOverlap([g]);
    expect(cellAt(g, "A2")?.f).toBe("{{cascading!visi}}");
    expect(cellAt(g, "A2")?.rs).toBe(12);
    expect(cellAt(g, "B2")?.f).toBe("{{cascading!misi_A}}");
    expect(cellAt(g, "D2")).toMatchObject({ v: "TAHUN KE 1", rs: 4 });
    expect(cellAt(g, "F2")).toMatchObject({ v: "A.", rs: 2 });
    const target = cellAt(g, "K13")!;
    expect(target.v).toBe("Bergeser ke arah positif (net sentiment naik)");
    const r2 = clone(excelRaw);
    setAt(r2, target.edit!.path, "Net sentiment naik minimal 10 poin");
    expect(renstraCodeChecks(RenstraRaw.parse(r2), inputs).find((c) => c.check === "measurable")?.passed).toBe(true);
  });
});

// ---------- Alur mock ujung ke ujung ----------

describe("alur mock SGS → SI → LTV", () => {
  it("setiap node menghasilkan output mentah sah, compute, items, summary, blocks, sheets tanpa galat", async () => {
    const evidence: EvidenceChunk[] = [
      { id: "C1", content: "Program kerja Gudang Personalia dilaksanakan oleh 6 pengurus tanpa anggaran.", source: "lpj.txt", kind: "document" },
      { id: "C2", content: "Nilai organisasi adalah kekeluargaan dan profesionalitas dalam melayani mahasiswa.", source: "adart.txt", kind: "document", focus: "nilai" },
    ];
    const inputs: Record<string, unknown> = { ...baseInputs };
    const steps: [NodeDef<unknown>, string][] = [
      [posisiOrganisasi as NodeDef<unknown>, "posisi_organisasi"],
      [swotMatrix as NodeDef<unknown>, "swot_matrix"],
      [qspm as NodeDef<unknown>, "qspm"],
      [cascading as NodeDef<unknown>, "cascading"],
      [kontinuitasProker as NodeDef<unknown>, "kontinuitas_proker"],
      [renstra as NodeDef<unknown>, "renstra"],
    ];
    for (const [def, key] of steps) {
      const ctx = ctxOf(inputs, evidence);
      const raw = def.kind === "code" ? await def.run!(ctx, llm) : def.mock!(ctx);
      expect(def.schema.safeParse(raw).success, key).toBe(true);
      if (def.prompt) expect(def.prompt(ctx).system.length, key).toBeGreaterThan(100);
      const checks = await def.validate!(raw, ctx, llm);
      expect(checks.filter((c) => !c.passed).map((c) => `${key}:${c.check}`)).toEqual([]);
      const out = def.compute!(raw, ctx);
      inputs[key] = out;
      const sctx = { label: def.label, inputs };
      // Hasil setelah compute dan output mentah (saat menunggu tinjauan) sama-sama bisa ditampilkan.
      for (const o of [out, raw]) {
        expect(def.items(o).length, key).toBeGreaterThan(0);
        expect(def.summary!(o), key).toBeTruthy();
        expect(def.blocks!(o, sctx).length, key).toBeGreaterThan(0);
        const grids = def.sheets!(o, sctx);
        expect(grids.length, key).toBeGreaterThan(0);
        expectNoOverlap(grids);
        expectExplained(grids);
      }
      expect(def.checks.map((c) => c.name).sort()).toEqual(checks.map((c) => c.check).sort());
    }
    expect((inputs.qspm as { ranking: unknown[] }).ranking.length).toBeGreaterThan(0);
  });
});
