import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { NodeContext } from "@/lib/nodes/types";
import type { StakeholderGroup, StakeholderRater } from "@/lib/nodes/contracts";
import type { Grid, GridCell } from "@/lib/sheets/grid";
import { BEM_DOCS } from "@/lib/seed/bem-fteic";
import { allPairs } from "@/lib/calc/ahp";
import { mockLlm } from "@/lib/nodes/es/es-common";
import {
  StakeholderOutput,
  computeStakeholder,
  groupOf,
  stakeholderEksternal,
  stakeholderInternal,
  type StakeholderOut,
} from "@/lib/nodes/es/stakeholder";
import {
  FaktorEksternalOutput,
  FaktorInternalOutput,
  canonicalCategory,
  computeFaktor,
  faktorEksternal,
  faktorInternal,
  type FaktorOut,
  type FaktorOutput,
} from "@/lib/nodes/es/faktor";
import { MatrixScoreOutput, computeMatrixScore, efas, ifas, type FactorInput, type MatrixScoreOut } from "@/lib/nodes/es/matrix-score";

// ---------- alat bantu ----------

type FixRow = { row: number; text: string; bobot: number; ratings: (number | null)[]; kp: number; ks: number; ki: number; m: number; total: number; score: number };
type FixMatrix = { weights: number[]; jabatan: string[]; groupOfCol: StakeholderGroup[]; rows: FixRow[]; total: number };
const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/excel-framework.json"), "utf8")) as {
  ifas: FixMatrix;
  efas: FixMatrix;
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function setAt(obj: unknown, p: (string | number)[], v: unknown) {
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < p.length - 1; i++) cur = cur[p[i]] as Record<string | number, unknown>;
  cur[p[p.length - 1]] = v;
}
const cellAt = (g: Grid, a1: string): GridCell | undefined => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = [...m[1]].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return g.cells.find((x) => x.r === Number(m[2]) - 1 && x.c === c);
};

/** Potongan dokumen dari dokumen dummy BEM (satu paragraf = satu potongan). */
function seedEvidence(...docs: string[]): EvidenceChunk[] {
  let n = 0;
  return docs.flatMap((d) =>
    BEM_DOCS[d].text
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((content) => ({ id: `C${++n}`, content, source: BEM_DOCS[d].filename, kind: "document" as const })),
  );
}
function ctxOf(evidence: EvidenceChunk[], inputs: NodeContext["inputs"] = {}): NodeContext {
  return { projectId: "p", projectName: "BEM FTEIC", orgType: "BEM", runId: "r", nodeRunId: "n", inputs, evidence };
}

// ---------- Stakeholder ----------

/** Contoh internal seperti Excel (tanpa nama orang): 8 jabatan, "Kepala biro" mewakili 4 biro. */
const internalRaw = (): StakeholderOutput =>
  StakeholderOutput.parse({
    roles: [
      { id: "SI1", jabatan: "Sekjen", power: "tinggi", interest: "tinggi" },
      { id: "SI2", jabatan: "Kepala biro", power: "tinggi", interest: "tinggi", units: ["Biro Administrasi", "Biro Penjaminan Mutu", "Biro Multimedia dan Informasi", "Biro Keuangan"] },
      { id: "SI3", jabatan: "Presiden BEM", power: "tinggi", interest: "rendah" },
      { id: "SI4", jabatan: "Asisten Biro", power: "rendah", interest: "tinggi" },
      { id: "SI5", jabatan: "Sekretaris Menko", power: "rendah", interest: "tinggi" },
      { id: "SI6", jabatan: "Menko", power: "rendah", interest: "rendah" },
      { id: "SI7", jabatan: "Menteri", power: "rendah", interest: "rendah" },
      { id: "SI8", jabatan: "Sekretaris Menteri", power: "rendah", interest: "rendah" },
    ],
    ahp: [
      // kelompok: KP 0,6, KS 0,2, KI 0,15, M 0,05 kira-kira (konsisten mendekati)
      { id: "kelompok", items: ["KP", "KS", "KI", "M"], pairs: [{ a: "KP", b: "KS", v: 3 }, { a: "KP", b: "KI", v: 4 }, { a: "KP", b: "M", v: 9 }, { a: "KS", b: "KI", v: 1 }, { a: "KS", b: "M", v: 3 }, { a: "KI", b: "M", v: 3 }] },
      {
        id: "jabatan",
        items: ["SI1", "SI2", "SI3", "SI4", "SI5", "SI6", "SI7", "SI8"],
        // semua pasangan; pentingnya menurun menurut urutan (rasio 2 per langkah dibulatkan Saaty)
        pairs: allPairs(["SI1", "SI2", "SI3", "SI4", "SI5", "SI6", "SI7", "SI8"]).map(([a, b]) => ({ a, b, v: Math.min(9, Number(b.slice(2)) - Number(a.slice(2)) + 1) })),
      },
    ],
  });

describe("stakeholder", () => {
  it("power–interest → kelompok seperti Excel", () => {
    expect(groupOf("tinggi", "tinggi")).toBe("KP");
    expect(groupOf("tinggi", "rendah")).toBe("KS");
    expect(groupOf("rendah", "tinggi")).toBe("KI");
    expect(groupOf("rendah", "rendah")).toBe("M");
  });

  it("bobot total = bobot jabatan × bobot kelompok, sub total 1, unit membagi rata bobot (E31 = E12/4)", () => {
    const o = computeStakeholder(internalRaw(), "internal");
    expect(o.roles.map((r) => r.group)).toEqual(["KP", "KP", "KS", "KI", "KI", "M", "M", "M"]);
    expect(o.subtotal).toBeCloseTo(1, 12);
    for (const r of o.roles) expect(r.bobotTotal).toBeCloseTo(r.bobotJabatan * r.bobotKelompok, 12);
    for (const g of ["KP", "KI", "M"] as const) expect(o.roles.filter((r) => r.group === g).reduce((s, r) => s + r.bobotJabatan, 0)).toBeCloseTo(1, 12);
    expect(o.roles.find((r) => r.id === "SI3")!.bobotJabatan).toBe(1); // sendirian di KS
    expect(o.groups.map((g) => g.group)).toEqual(["KP", "KS", "KI", "M"]);
    expect(o.groups[0].bobot).toBeGreaterThan(o.groups[1].bobot);
    // penilai: 1 + 4 unit + 1 + 2 + 3 = 11 kolom seperti ESIFAS
    expect(o.raters.length).toBe(11);
    const kabiro = o.roles.find((r) => r.id === "SI2")!;
    const units = o.raters.filter((r) => r.roleId === "SI2");
    expect(units.map((u) => u.id)).toEqual(["SI2-1", "SI2-2", "SI2-3", "SI2-4"]);
    for (const u of units) expect(u.weight).toBeCloseTo(kabiro.bobotTotal / 4, 12);
    expect(o.raters.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 12);
    // AHP: himpunan antarkelompok + KP, KI, M (KS sendirian tidak perlu)
    expect(o.ahp.map((s) => s.id)).toEqual(["kelompok", "KP", "KI", "M"]);
  });

  it("eksternal: kelompok kosong (KS, M) berbobot 0 seperti ESEFAS", () => {
    const raw = StakeholderOutput.parse({
      roles: [
        { id: "SE1", jabatan: "Presiden BEM", power: "tinggi", interest: "tinggi" },
        { id: "SE2", jabatan: "Sekjen", power: "tinggi", interest: "tinggi" },
        { id: "SE3", jabatan: "Lembaga legislatif", power: "rendah", interest: "tinggi" },
      ],
      ahp: [
        { id: "kelompok", items: ["KP", "KS", "KI", "M"], pairs: [{ a: "KP", b: "KI", v: 2 }] },
        { id: "jabatan", items: ["SE1", "SE2", "SE3"], pairs: [{ a: "SE1", b: "SE2", v: 2 }] },
      ],
    });
    const o = computeStakeholder(raw, "eksternal");
    const gw = Object.fromEntries(o.groups.map((g) => [g.group, g.bobot]));
    expect(gw.KS).toBe(0);
    expect(gw.M).toBe(0);
    expect(gw.KP).toBeCloseTo(2 / 3, 12);
    expect(o.subtotal).toBeCloseTo(1, 12);
  });

  it("edit power di sheet → jabatan pindah kelompok dan bobotnya memakai pasangan yang sudah ada", () => {
    const raw = internalRaw();
    const o = computeStakeholder(raw, "internal");
    const [main, ahpSheet] = stakeholderInternal.sheets!(o, { label: "x", inputs: {} });
    expect(main.name).toBe("ESSTAKEHOLDER INTERNAL");
    const presRow = main.cells.find((c) => c.v === "Presiden BEM" && c.edit)!;
    const powerCell = main.cells.find((c) => c.r === presRow.r && c.edit?.path[2] === "power")!;
    expect(powerCell.edit!.path).toEqual(["roles", 2, "power"]);
    const next = clone(raw);
    setAt(next, powerCell.edit!.path, "rendah");
    const parsed = stakeholderInternal.schema.safeParse(next);
    expect(parsed.success).toBe(true);
    const o2 = stakeholderInternal.compute!(parsed.data!, ctxOf([])) as StakeholderOut;
    expect(o2.roles.find((r) => r.id === "SI3")!.group).toBe("M");
    expect(o2.groups.find((g) => g.group === "KS")!.bobot).toBe(0);
    expect(o2.ahp.find((s) => s.id === "M")!.missing).toEqual([]);
    expect(o2.subtotal).toBeCloseTo(1, 12);
    // Rumus bobot total meniru Excel (=D11*$B$11) dan sheet AHP punya sel edit yang menunjuk himpunan mentah
    const e11 = cellAt(main, "E11")!;
    expect(e11.f).toBe("D11*$B$11");
    expect(cellAt(main, "B11")!.f).toBe("{{stakeholder_internal!w_KP}}");
    expect(main.anchors?.["rw_SI2-1"]).toBeTruthy();
    const edits = ahpSheet.cells.filter((c) => c.edit);
    expect(edits.length).toBeGreaterThan(0);
    for (const c of edits) {
      expect(c.edit!.path[0]).toBe("ahp");
      const [, si, , pi] = c.edit!.path as [string, number, string, number];
      expect(raw.ahp[si].pairs[pi]).toBeTruthy();
    }
  });

  it("unit penilai bisa diketik sebagai teks (dipisah ;) lewat sel edit", () => {
    const raw = internalRaw();
    const o = computeStakeholder(raw, "internal");
    const [main] = stakeholderInternal.sheets!(o, { label: "x", inputs: {} });
    const unitCell = main.cells.find((c) => c.edit?.path.join(".") === "roles.0.units")!;
    expect(unitCell).toBeTruthy();
    const next = clone(raw);
    setAt(next, unitCell.edit!.path, "Biro A; Biro B");
    const parsed = StakeholderOutput.safeParse(next);
    expect(parsed.success).toBe(true);
    const o2 = computeStakeholder(parsed.data!, "internal");
    expect(o2.raters.filter((r) => r.roleId === "SI1").map((r) => r.name)).toEqual(["Biro A", "Biro B"]);
  });

  it("mock dari dokumen dummy lolos skema dan cek kode utama", async () => {
    const ev = seedEvidence("Struktur & jabatan organisasi", "JARAS VALIDASI");
    const ctx = ctxOf(ev);
    const out = stakeholderInternal.mock!(ctx);
    expect(stakeholderInternal.schema.safeParse(out).success).toBe(true);
    expect(out.roles.length).toBeGreaterThanOrEqual(4);
    expect(out.roles.some((r) => r.units?.length === 6)).toBe(true); // 6 kementerian
    const checks = await stakeholderInternal.validate!(out, ctx, mockLlm);
    const failed = checks.filter((c) => !c.passed).map((c) => c.check);
    expect(failed).not.toContain("quote_exists");
    expect(failed).not.toContain("grounded");
    expect(failed).not.toContain("ahp_complete");
    expect(failed).not.toContain("ahp_consistency");
    expect(failed).not.toContain("key_player");
    const o = stakeholderInternal.compute!(out, ctx) as StakeholderOut;
    expect(o.subtotal).toBeCloseTo(1, 9);

    const evx = seedEvidence("Pihak eksternal");
    const outx = stakeholderEksternal.mock!(ctxOf(evx));
    expect(stakeholderEksternal.schema.safeParse(outx).success).toBe(true);
    expect(outx.roles.length).toBeGreaterThanOrEqual(4);
    expect(outx.roles.every((r) => r.id.startsWith("SE"))).toBe(true);
  });

  it("validator: jabatan ganda, tanpa Key Player, dan AHP yang belum lengkap", async () => {
    const raw = StakeholderOutput.parse({
      roles: [
        { id: "SI1", jabatan: "Bendahara", power: "rendah", interest: "tinggi" },
        { id: "SI2", jabatan: "bendahara", power: "rendah", interest: "tinggi" },
        { id: "SI3", jabatan: "Staf", power: "rendah", interest: "tinggi" },
      ],
      ahp: [{ id: "jabatan", items: ["SI1", "SI2", "SI3"], pairs: [{ a: "SI1", b: "SI2", v: 3 }] }],
    });
    const checks = await stakeholderInternal.validate!(raw, ctxOf([]), mockLlm);
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));
    expect(by.duplicate_role.passed).toBe(false);
    expect(by.key_player.passed).toBe(false);
    expect(by.ahp_complete.failures[0].message).toContain("SI1 vs SI3");
  });
});

// ---------- Faktor ----------

const faktorRaw = (): FaktorOutput =>
  FaktorInternalOutput.parse({
    factors: [
      { id: "S1", category: "Strategy", text: "Fokus kesekjenan sesuai visi dan misi kabinet." },
      { id: "S2", category: "system", text: "Sistem WBS dinilai optimal dalam pembagian fungsi kerja." },
      { id: "S3", category: "Structure ", text: "Struktur kewenangan internal sudah jelas." },
      { id: "W1", category: "Strategy", text: "Masa efektif kabinet hanya sekitar empat bulan." },
      { id: "W2", category: "staff", text: "Beberapa kementerian kekurangan staf." },
    ],
    ahp: [
      { id: "SW", items: ["S", "W"], pairs: [{ a: "S", b: "W", v: 2 }] },
      { id: "S", items: ["S1", "S2", "S3"], pairs: [{ a: "S1", b: "S2", v: 2 }, { a: "S1", b: "S3", v: 4 }, { a: "S2", b: "S3", v: 2 }] },
      { id: "W", items: ["W1", "W2"], pairs: [{ a: "W1", b: "W2", v: 1 }] },
    ],
  });

describe("faktor S+W / O+T", () => {
  it("AHP bertingkat: bobot = lokal × kuadran, total 1, kategori baku", () => {
    const o = computeFaktor(faktorRaw(), "internal");
    expect(o.factors.map((f) => f.id)).toEqual(["S1", "S2", "S3", "W1", "W2"]);
    expect(o.groupWeights.S).toBeCloseTo(2 / 3, 12);
    expect(o.groupWeights.W).toBeCloseTo(1 / 3, 12);
    // S lokal konsisten sempurna 4:2:1
    expect(o.factors[0].bobot).toBeCloseTo((4 / 7) * (2 / 3), 12);
    expect(o.factors[3].bobot).toBeCloseTo(0.5 / 3, 12);
    expect(o.total).toBeCloseTo(1, 12);
    expect(o.factors.map((f) => f.category)).toEqual(["Strategy", "System", "Structure", "Strategy", "Staff"]);
    expect(canonicalCategory("Politik", "eksternal")).toBe("Politic");
    expect(canonicalCategory("style", "internal")).toBe("Style");
  });

  it("sheet ESS+W: bobot merujuk sheet AHP; teks & kategori bisa diedit", () => {
    const raw = faktorRaw();
    const o = computeFaktor(raw, "internal");
    const [main, ahpSheet] = faktorInternal.sheets!(o, { label: "x", inputs: {} });
    expect(main.name).toBe("ESS+W");
    expect(cellAt(main, "C1")!.v).toBe("Strength");
    expect(cellAt(main, "D2")!.f).toBe("{{faktor_internal!w_S1}}");
    expect(main.anchors?.b_W2).toBeTruthy();
    expect(main.anchors?.total).toBeTruthy();
    expect(ahpSheet.anchors?.w_S1).toBeTruthy();
    // bobot global di sheet AHP = lokal × sel bobot kuadran
    const glob = ahpSheet.cells.find((c) => c.f && /\*[A-Z]+\d+$/.test(c.f) && c.src === "ahp");
    expect(glob).toBeTruthy();
    const cat = main.cells.find((c) => c.edit?.path.join(".") === "factors.1.category")!;
    expect(cat.edit!.options).toContain("Shared Value");
    // edit perbandingan S1 vs S3 → bobot berubah
    const pairCell = ahpSheet.cells.find((c) => c.edit?.path.join(".") === "ahp.1.pairs.1.v")!;
    expect(pairCell).toBeTruthy();
    const next = clone(raw);
    setAt(next, pairCell.edit!.path, 1);
    const parsed = faktorInternal.schema.safeParse(next);
    expect(parsed.success).toBe(true);
    const o2 = faktorInternal.compute!(parsed.data!, ctxOf([])) as FaktorOut;
    expect(o2.factors[0].bobot).not.toBeCloseTo(o.factors[0].bobot, 6);
    expect(o2.total).toBeCloseTo(1, 12);
  });

  it("mock dari dokumen dummy: internal S/W dan eksternal O/T lolos skema dan cek kode", async () => {
    const ev = seedEvidence("Notulensi rapat", "LPJ / laporan kegiatan", "Kondisi eksternal", "Survei anggota");
    const ctx = ctxOf(ev);
    for (const [node, schema] of [
      [faktorInternal, FaktorInternalOutput],
      [faktorEksternal, FaktorEksternalOutput],
    ] as const) {
      const out = node.mock!(ctx);
      expect(schema.safeParse(out).success).toBe(true);
      expect(out.factors.length).toBeGreaterThan(1);
      const checks = await node.validate!(out, ctx, mockLlm);
      const failed = checks.filter((c) => !c.passed).map((c) => c.check);
      for (const name of ["quote_exists", "grounded", "id_format", "category_valid", "ahp_complete", "ahp_consistency"]) expect(failed).not.toContain(name);
      const o = node.compute!(out, ctx) as FaktorOut;
      expect(o.total).toBeCloseTo(1, 9);
    }
  });

  it("validator: ID meloncat, kategori asing, duplikat, kuadran kosong", async () => {
    const raw = FaktorEksternalOutput.parse({
      factors: [
        { id: "O1", category: "Politik", text: "Dinamika politik kampus meningkatkan kebutuhan media." },
        { id: "O3", category: "Cuaca ekstrem", text: "Dinamika politik kampus meningkatkan kebutuhan media." },
      ],
    });
    const checks = await faktorEksternal.validate!(raw, ctxOf([]), mockLlm);
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));
    expect(by.id_format.passed).toBe(false);
    expect(by.category_valid.failures.map((f) => f.itemId)).toEqual(["O3"]);
    expect(by.duplicate.passed).toBe(false);
    expect(by.quadrant_coverage.failures.map((f) => f.itemId)).toEqual(["T"]);
    expect(by.ahp_complete.passed).toBe(false);
  });
});

// ---------- IFAS / EFAS (uji emas dari Excel) ----------

function excelCase(fx: FixMatrix, pos: "S" | "O", neg: "W" | "T", nPos: number) {
  const raters: StakeholderRater[] = fx.weights.map((w, k) => ({ id: `R${k + 1}`, roleId: `R${k + 1}`, name: `Penilai ${k + 1}`, group: fx.groupOfCol[k], weight: w }));
  const factors: FactorInput[] = fx.rows.map((r, i) => ({
    id: i < nPos ? `${pos}${i + 1}` : `${neg}${i - nPos + 1}`,
    quadrant: i < nPos ? pos : neg,
    text: r.text,
    bobot: r.bobot,
  }));
  const raw = MatrixScoreOutput.parse({
    ratings: fx.rows.map((r, i) => ({
      factorId: factors[i].id,
      // Excel ESEFAS H14 berisi 0 berlatar hitam (= tidak menilai) → null; hasilnya sama karena sel kosong dihitung 0.
      values: Object.fromEntries(r.ratings.map((v, k) => [`R${k + 1}`, v === null || v === 0 ? null : v])),
    })),
  });
  return { raters, factors, raw };
}

describe("IFAS / EFAS", () => {
  it("uji emas ESIFAS: per baris dan total T27 = 1,133907226", () => {
    const fx = fixture.ifas;
    const { raters, factors, raw } = excelCase(fx, "S", "W", 13);
    const o = computeMatrixScore(raw, factors, raters, "internal");
    expect(o.u).toBeCloseTo(1, 9);
    o.rows.forEach((row, i) => {
      const e = fx.rows[i];
      expect(row.kp).toBeCloseTo(e.kp, 9);
      expect(row.ks).toBeCloseTo(e.ks, 9);
      expect(row.ki).toBeCloseTo(e.ki, 9);
      expect(row.m).toBeCloseTo(e.m, 9);
      expect(row.totalRating).toBeCloseTo(e.total, 9);
      expect(row.score).toBeCloseTo(e.score, 9);
    });
    expect(o.total).toBeCloseTo(1.133907226, 9);
    expect(o.totalPositive - o.totalNegative).toBeCloseTo(o.total, 12);
  });

  it("uji emas ESEFAS: total T15 = −1,6824472 (kolom P Excel berisi penilai Keep Informed)", () => {
    const fx = fixture.efas;
    const { raters, factors, raw } = excelCase(fx, "O", "T", 3);
    const o = computeMatrixScore(raw, factors, raters, "eksternal");
    o.rows.forEach((row, i) => {
      const e = fx.rows[i];
      expect(row.kp).toBeCloseTo(e.kp, 9);
      // Di ESEFAS, kolom berlabel "KS" (P) menjumlah penilai Keep Informed (F:L) dan kolom "KI" (Q) penilai Keep Satisfied (M).
      expect(row.ki).toBeCloseTo(e.ks, 9);
      expect(row.ks).toBeCloseTo(e.ki, 9);
      expect(row.m).toBeCloseTo(e.m, 9);
      expect(row.totalRating).toBeCloseTo(e.total, 9);
      expect(row.score).toBeCloseTo(e.score, 9);
    });
    expect(o.total).toBeCloseTo(-1.6824472, 9);
    expect(o.totalNegative).toBeGreaterThan(o.totalPositive);
  });

  it("sheet ESIFAS meniru alamat & rumus Excel; edit rating menghitung ulang skor", () => {
    const fx = fixture.ifas;
    const { raters, factors, raw } = excelCase(fx, "S", "W", 13);
    const o = computeMatrixScore(raw, factors, raters, "internal");
    const [g] = ifas.sheets!(o, { label: "IFAS", inputs: {} });
    expect(g.name).toBe("ESIFAS");
    expect(cellAt(g, "D1")!.v).toBe("Key Player");
    expect(cellAt(g, "D1")!.cs).toBe(5);
    expect(cellAt(g, "O6")!.f).toBe("(SUMPRODUCT($D$4:$H$4*D6:H6))/U6");
    expect(cellAt(g, "P6")!.f).toBe("(SUMPRODUCT($I$4*I6))/U6");
    expect(cellAt(g, "Q6")!.f).toBe("(SUMPRODUCT($J$4:$K$4*J6:K6))/U6");
    expect(cellAt(g, "R6")!.f).toBe("(SUMPRODUCT($L$4:$N$4*L6:N6))/U6");
    expect(cellAt(g, "S6")!.f).toBe("SUM(O6:R6)");
    expect(cellAt(g, "T6")!.f).toBe("S6*C6");
    expect(cellAt(g, "U6")!.f).toBe("SUM($D$4:$N$4)");
    expect(cellAt(g, "T20")!.f).toBe("-S20*C20");
    expect(cellAt(g, "T27")!.f).toBe("SUM(T6:T26)");
    expect(cellAt(g, "T27")!.v).toBeCloseTo(1.133907226, 9);
    expect(cellAt(g, "C27")!.f).toBe("SUM(C6:C26)");
    expect(cellAt(g, "C6")!.f).toBe("{{faktor_internal!b_S1}}");
    expect(cellAt(g, "D4")!.f).toBe("{{stakeholder_internal!rw_R1}}");
    expect(g.anchors?.total).toBe("T27");
    for (const c of g.cells.filter((x) => x.f && !x.f.startsWith("{{"))) expect(c.explain ?? c.f).toBeTruthy();
    // Edit: Sekjen (D) menilai S3 (baris 8) dari 4 → 1
    const cell = cellAt(g, "D8")!;
    expect(cell.edit!.path).toEqual(["ratings", 2, "values", "R1"]);
    expect(cell.edit!.allowEmpty).toBe(true);
    const next = clone(raw);
    setAt(next, cell.edit!.path, 1);
    const parsed = ifas.schema.safeParse(next);
    expect(parsed.success).toBe(true);
    const o2 = computeMatrixScore(parsed.data!, factors, raters, "internal");
    const expectedKp = (fx.rows[2].kp * 1 - 0.2838 * 4 + 0.2838 * 1) / 1;
    expect(o2.rows[2].kp).toBeCloseTo(expectedKp, 9);
    expect(o2.rows[2].score).toBeCloseTo((expectedKp + fx.rows[2].ks + fx.rows[2].ki + fx.rows[2].m) * 0.055, 9);
    // Kosongkan sel (null) → dihitung 0 dan dilaporkan rating_complete
    setAt(next, cell.edit!.path, null);
    const o3 = computeMatrixScore(MatrixScoreOutput.parse(next), factors, raters, "internal");
    expect(o3.rows[2].kp).toBeCloseTo(fx.rows[2].kp - 0.2838 * 4, 9);
  });

  it("rantai mock: stakeholder + faktor → IFAS/EFAS lolos skema, cakupan lengkap, total = Σ skor", async () => {
    const ev = seedEvidence("Struktur & jabatan organisasi", "Pihak eksternal", "Notulensi rapat", "LPJ / laporan kegiatan", "Kondisi eksternal", "JARAS VALIDASI");
    const base = ctxOf(ev);
    const inputs: NodeContext["inputs"] = {
      stakeholder_internal: stakeholderInternal.compute!(stakeholderInternal.mock!(base), base),
      stakeholder_eksternal: stakeholderEksternal.compute!(stakeholderEksternal.mock!(base), base),
      faktor_internal: faktorInternal.compute!(faktorInternal.mock!(base), base),
      faktor_eksternal: faktorEksternal.compute!(faktorEksternal.mock!(base), base),
    };
    const ctx = ctxOf(ev, inputs);
    for (const node of [ifas, efas]) {
      const out = node.mock!(ctx);
      expect(node.schema.safeParse(out).success).toBe(true);
      const checks = await node.validate!(out, ctx, mockLlm);
      expect(checks.filter((c) => !c.passed).map((c) => c.check)).toEqual([]);
      const o = node.compute!(out, ctx) as MatrixScoreOut;
      expect(o.rows.length).toBeGreaterThan(0);
      expect(o.total).toBeCloseTo(o.rows.reduce((s, r) => s + r.score, 0), 12);
      expect(o.rows.every((r) => r.blanks === 0)).toBe(true);
      const [g] = node.sheets!(o, { label: node.label, inputs });
      expect(g.anchors?.total).toBeTruthy();
      expect(node.summary!(o)).toContain(node.label);
      // sheet bisa dibuat dari output mentah (status menunggu tinjauan) memakai input hulu
      expect(node.sheets!(out, { label: node.label, inputs })[0].cells.length).toBe(g.cells.length);
    }
    // Penilai IFAS mengikuti unit di stakeholder internal (6 kementerian)
    const io = ifas.compute!(ifas.mock!(ctx), ctx) as MatrixScoreOut;
    expect(io.raters.filter((r) => /-\d+$/.test(r.id)).length).toBe(6);
  });

  it("validator: faktor terlewat, penilai tidak dicantumkan, sel kosong, dan rating terlalu rendah", async () => {
    const inputs = {
      faktor_internal: computeFaktor(faktorRaw(), "internal"),
      stakeholder_internal: computeStakeholder(internalRaw(), "internal"),
    };
    const ctx = ctxOf([], inputs);
    const raters = inputs.stakeholder_internal.raters;
    const all = (v: number | null) => Object.fromEntries(raters.map((r) => [r.id, v]));
    const raw = MatrixScoreOutput.parse({
      ratings: [
        { factorId: "S1", values: all(4) },
        { factorId: "S2", values: { ...all(3), SI1: null } },
        { factorId: "S3", values: all(1) },
        { factorId: "W1", values: { SI1: 3 } },
        { factorId: "X9", values: all(2) },
      ],
    });
    const checks = await ifas.validate!(raw, ctx, mockLlm);
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));
    const covIds = by.coverage.failures.map((f) => f.itemId);
    expect(covIds).toContain("W2"); // tidak dinilai
    expect(covIds).toContain("W1"); // penilai tidak dicantumkan
    expect(covIds).toContain("X9"); // faktor asing
    expect(by.rating_complete.failures.map((f) => f.itemId)).toEqual(["S2", "W1"]);
    expect(by.rating_direction.failures.map((f) => f.itemId)).toEqual(["S3"]);
    // W2 tanpa entri → baris tetap ada, skor 0, sel tidak bisa diedit
    const o = ifas.compute!(raw, ctx) as MatrixScoreOut;
    const w2 = o.rows.find((r) => r.id === "W2")!;
    expect(w2.score).toBe(0);
    expect(w2.rawIndex).toBeNull();
  });
});
