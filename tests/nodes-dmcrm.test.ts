// Uji node Decision, Change & Risk Management (tab DM-CRMDM, DM-CRMCM, DM-CRMRM).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { FaktorComputed, MatrixScoreComputed, StakeholderComputed } from "@/lib/nodes/contracts";
import type { CheckResult, LlmSession, NodeContext } from "@/lib/nodes/types";
import { SYNTHETIC_DOCUMENTS, SYNTHETIC_PROJECT } from "@/lib/seed/synthetic-case";
import { computeDecision, decisionMaking, DecisionOutput } from "@/lib/nodes/dmcrm/decision";
import { changeManagement, ChangeOutput, computeChange, KOTTER } from "@/lib/nodes/dmcrm/change";
import { computeRisk, riskManagement, RiskOutput, riskRating, riskScore, type RiskItem } from "@/lib/nodes/dmcrm/risk";
import { unitKnown, unitsFromText } from "@/lib/nodes/dmcrm/common";
import type { Grid, GridCell } from "@/lib/sheets/grid";

// ---------- Konteks uji: dokumen sintetis + output hulu tiruan ----------

const evidence: EvidenceChunk[] = SYNTHETIC_DOCUMENTS.flatMap((d) => d.text.split(/\n\n/).map((content) => ({ content, source: d.filename }))).map((c, i) => ({
  id: `C${i + 1}`,
  content: c.content,
  source: c.source,
  kind: "document" as const,
}));
const chunkOf = (quote: string) => {
  const c = evidence.find((e) => e.content.includes(quote));
  if (!c) throw new Error(`kutipan tidak ada: ${quote}`);
  return c.id;
};
const ev = (quote: string) => [{ chunkId: chunkOf(quote), quote }];
const factor = (id: string, quadrant: "S" | "W" | "O" | "T", text: string, quote: string, bobot = 0.1) => ({
  id,
  quadrant,
  category: "Staff",
  text,
  bobot,
  evidence: ev(quote),
});

const faktorInternal: FaktorComputed = {
  scope: "internal",
  factors: [
    factor("S1", "S", "Kelas Riset Data menjadi program unggulan", "Kelas Riset Data tetap ramai dan menjadi program unggulan yang paling dikenal mahasiswa", 0.2),
    factor("W1", "W", "Regenerasi staf lambat", "Regenerasi staf lambat: dari 40 staf, hanya 9 orang yang bersedia melanjutkan", 0.2),
    factor("W2", "W", "Dokumentasi program lemah tanpa SOP penyusunan laporan", "Dokumentasi program lemah karena laporan kegiatan sering terlambat", 0.15),
    factor("W3", "W", "Koordinasi antar-divisi kurang karena rapat pleno sering ditunda", "Koordinasi antar-divisi kurang karena rapat pleno sering ditunda", 0.15),
    factor("W4", "W", "Kemampuan desain dan pengelolaan media sosial terbatas", "Kemampuan desain dan pengelolaan media sosial terbatas pada dua orang staf saja", 0.1),
  ],
  total: 1,
  ahp: [],
};
const faktorEksternal: FaktorComputed = {
  scope: "eksternal",
  factors: [
    factor("O1", "O", "Program hibah kegiatan mahasiswa dari rektorat", "Rektorat meluncurkan program hibah kegiatan mahasiswa berbasis proposal", 0.3),
    factor("T1", "T", "Fakultas memangkas anggaran kegiatan rutin ormawa 30 persen", "Fakultas memangkas anggaran kegiatan rutin ormawa sebesar 30 persen", 0.4),
    factor("T2", "T", "Komunitas dan UKM lain mengadakan pelatihan serupa gratis", "Komunitas data independen dan UKM teknologi lain di kampus semakin aktif", 0.3),
  ],
  total: 1,
  ahp: [],
};
const row = (id: string, q: "S" | "W", score: number) => ({ id, quadrant: q, text: id, bobot: 0.1, kp: 0, ks: 0, ki: 0, m: 0, totalRating: 0, score });
const ifas: MatrixScoreComputed = {
  scope: "internal",
  rows: [row("S1", "S", 0.6), row("W1", "W", -0.4), row("W2", "W", -0.3), row("W3", "W", -0.25), row("W4", "W", -0.1)],
  total: -0.45,
  totalPositive: 0.6,
  totalNegative: 1.05,
};
const role = (id: string, jabatan: string, group: "KP" | "KS" | "KI" | "M", bobotTotal: number) => ({
  id,
  jabatan,
  power: "tinggi" as const,
  interest: "tinggi" as const,
  group,
  bobotJabatan: 1,
  bobotKelompok: bobotTotal,
  bobotTotal,
});
const stakeholderInternal = {
  scope: "internal",
  roles: [role("SI1", "Ketua himpunan", "KP", 0.5), role("SI2", "Kepala divisi", "KP", 0.3), role("SI3", "Staf divisi", "KI", 0.2)],
  groups: [],
  subtotal: 1,
  ahp: [],
} as unknown as StakeholderComputed;

const baseCtx = (inputs: NodeContext["inputs"] = {}): NodeContext => ({
  projectId: "p",
  projectName: SYNTHETIC_PROJECT.name,
  orgType: SYNTHETIC_PROJECT.orgType,
  runId: "r",
  nodeRunId: "n",
  inputs: { faktor_internal: faktorInternal, faktor_eksternal: faktorEksternal, ifas, stakeholder_internal: stakeholderInternal, ...inputs },
  evidence,
});

/** LLM tiruan: selalu memakai mock (sama seperti mode uji). */
const llm: LlmSession = { json: async (_p, _s, _u, _schema, mock) => mock() };

const failed = (checks: CheckResult[]) => checks.filter((c) => !c.passed);
const check = (checks: CheckResult[], name: string) => checks.find((c) => c.check === name)!;
const cellAt = (g: Grid, a1: string): GridCell | undefined => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return g.cells.find((x) => x.r === Number(m[2]) - 1 && x.c === c);
};
const setAt = (obj: unknown, p: (string | number)[], v: unknown) => {
  let cur = obj as Record<string | number, unknown>;
  for (const k of p.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  cur[p[p.length - 1]] = v;
};

// ---------- Decision making ----------

describe("decision_making (DM-CRMDM)", () => {
  const ctx = baseCtx();
  const raw = DecisionOutput.parse(decisionMaking.mock!(ctx));

  it("mock: kondisi dari W/T hulu dengan bukti, influence diagram tersambung, semua cek kode lolos", async () => {
    expect(raw.kondisi.length).toBeGreaterThanOrEqual(3);
    expect(raw.kondisi[0].refs).toEqual(["W1"]); // W dengan |skor IFAS| terbesar
    expect(raw.kondisi.every((k) => k.evidence.length === 1)).toBe(true);
    const out = computeDecision(raw);
    expect(out.belumDitangani).toEqual([]);
    expect(out.tanpaGoal).toEqual([]);
    expect(out.diagram.links.some((l) => l.hubungan === "menyebabkan")).toBe(true);
    expect(failed(await decisionMaking.validate!(raw, ctx, llm))).toEqual([]);
  });

  it("compute: panah, cakupan langsung/tidak langsung, dan butir yang belum ditangani", async () => {
    const o = DecisionOutput.parse({
      kondisi: [
        { id: "KD1", text: "Monitoring kinerja belum optimal", refs: ["W1"] },
        { id: "KD2", text: "Tata kelola belum terstruktur", refs: ["W2"] },
        { id: "KD3", text: "Kompetensi staf belum terpetakan", refs: ["W9"] },
      ],
      konsekuensi: [
        { id: "KQ1", text: "Keberjalanan program kurang maksimal", dariKondisi: ["KD1", "KD2"] },
        { id: "KQ2", text: "Kompetensi staf belum optimal", dariKondisi: [] },
      ],
      keputusan: [
        { id: "DM1", text: "Sistem monitoring & evaluasi kinerja", menangani: ["KQ1"] },
        { id: "DM2", text: "Pengembangan kompetensi", menangani: ["KD3", "KX9"] },
      ],
      goals: [{ id: "G1", text: "Tata kelola terstruktur", dariKeputusan: ["DM1"] }],
    });
    const c = computeDecision(o);
    expect(c.cakupan).toEqual([
      { id: "DM1", kondisi: ["KD1", "KD2"], konsekuensi: ["KQ1"] },
      { id: "DM2", kondisi: ["KD3"], konsekuensi: [] },
    ]);
    expect(c.belumDitangani).toEqual(["KQ2"]);
    expect(c.tanpaGoal).toEqual(["DM2"]);
    expect(c.tanpaPenyebab).toEqual(["KQ2"]);
    expect(c.diagram.links).toHaveLength(2 + 2 + 1); // KD1,KD2→KQ1; KQ1→DM1, KD3→DM2; DM1→G1 (KX9 diabaikan)
    const checks = await decisionMaking.validate!(o, ctx, llm);
    expect(check(checks, "ref_exists").failures.map((f) => f.itemId).sort()).toEqual(["DM2", "KD3"]);
    expect(check(checks, "diagram_lengkap").failures.map((f) => f.itemId).sort()).toEqual(["DM2", "KQ2", "KQ2"]);
    expect(check(checks, "struktur").passed).toBe(true);
  });

  it("sheet: tata letak Aspek | Deskripsi + INFLUENCE DIAGRAM; sel teks bisa diedit lewat path output mentah", () => {
    const g = decisionMaking.sheets!(computeDecision(raw), { label: "DM", inputs: {} })[0];
    expect(cellAt(g, "A1")?.v).toBe("Aspek");
    expect(cellAt(g, "B1")).toMatchObject({ v: "Deskripsi", cs: 2 });
    expect(cellAt(g, "A2")).toMatchObject({ v: "Kondisi", rs: raw.kondisi.length });
    expect(cellAt(g, "E2")).toMatchObject({ v: "INFLUENCE DIAGRAM", cs: 8 });
    const c = cellAt(g, "C2")!;
    expect(c.edit?.path).toEqual(["kondisi", 0, "text"]);
    const edited = structuredClone(raw);
    setAt(edited, c.edit!.path, "Sistem monitoring kinerja staf belum optimal");
    const parsed = decisionMaking.schema.safeParse(edited);
    expect(parsed.success).toBe(true);
    const g2 = decisionMaking.sheets!(decisionMaking.compute!(parsed.data!, ctx), { label: "DM", inputs: {} })[0];
    expect(cellAt(g2, "C2")?.v).toBe("Sistem monitoring kinerja staf belum optimal");
    expect(g.chart?.type).toBe("bar");
    expect(decisionMaking.summary!(computeDecision(raw))).toMatch(/kondisi → .* konsekuensi → .* keputusan → 1 goal/);
  });

  it("prompt bahasa Indonesia memuat W/T hulu, bukti, dan skema JSON", () => {
    const p = decisionMaking.prompt!(ctx);
    expect(p.system).toContain("INFLUENCE DIAGRAM");
    expect(p.system).toContain("Balas HANYA dengan JSON");
    expect(p.user).toContain("W1: Regenerasi staf lambat");
    expect(p.user).toContain("T1: Fakultas memangkas");
    expect(p.user).toContain('"kondisi"');
    expect(decisionMaking.extraChunkIds!(ctx)).toContain(chunkOf("Regenerasi staf lambat"));
  });
});

// ---------- Change management ----------

describe("change_management (DM-CRMCM)", () => {
  const dmCtx = baseCtx();
  const decision = computeDecision(decisionMaking.mock!(dmCtx));
  const ctx = baseCtx({ decision_making: decision });
  const raw = ChangeOutput.parse(changeManagement.mock!(ctx));

  it("tahap Kotter persis seperti tab Excel", () => {
    expect(KOTTER.map((k) => k.tahap)).toEqual([
      "Increase Urgency",
      "Build the Guiding Team",
      "Get the Right Vision",
      "Communicate for Buy-In",
      "Empower Action",
      "Create Short-Term Wins",
      "Don't Let Up",
      "Make it Stick",
    ]);
    expect(changeManagement.deps).toEqual(["decision_making"]);
  });

  it("mock: 8 tahap berurutan, semua keputusan dijalankan, semua cek kode lolos", async () => {
    const o = computeChange(raw, decision);
    expect(o.steps.map((s) => s.id)).toEqual(["CM1", "CM2", "CM3", "CM4", "CM5", "CM6", "CM7", "CM8"]);
    expect(o.hilang).toEqual([]);
    expect(o.belumDijalankan).toEqual([]);
    expect(o.cakupan).toBe(1);
    expect(failed(await changeManagement.validate!(raw, ctx, llm))).toEqual([]);
  });

  it("cek: tahap hilang/ganda, rujukan keputusan asing, keputusan tanpa tahap", async () => {
    const bad = structuredClone(raw);
    bad.tahapan = bad.tahapan.filter((t) => t.tahap !== "Empower Action");
    bad.tahapan.push({ ...bad.tahapan[0] });
    bad.tahapan.forEach((t) => (t.keputusanRefs = t.keputusanRefs.filter((id) => id !== "DM1")));
    bad.tahapan[1].keputusanRefs = ["DM99"];
    const checks = await changeManagement.validate!(bad, ctx, llm);
    expect(check(checks, "kotter_lengkap").failures.map((f) => f.message).join(" ")).toMatch(/Empower Action.*belum diisi.*Increase Urgency.*lebih dari sekali/);
    expect(check(checks, "ref_exists").failures[0].message).toContain("DM99");
    expect(check(checks, "keputusan_tercakup").failures.map((f) => f.itemId)).toEqual(["DM1"]);
  });

  it("sheet: GAGASAN PERUBAHAN, COUNTIF per keputusan, cakupan, dan path edit ke baris mentah (urutan acak)", () => {
    const shuffled = structuredClone(raw);
    shuffled.tahapan.reverse(); // urutan mentah terbalik → sheet tetap urut Kotter, path menunjuk indeks mentah
    const out = changeManagement.compute!(shuffled, ctx);
    const g = changeManagement.sheets!(out, { label: "CM", inputs: { decision_making: decision } })[0];
    expect(cellAt(g, "A1")).toMatchObject({ v: "GAGASAN PERUBAHAN", cs: 4 });
    expect(cellAt(g, "B2")?.v).toBe("Tahapan (based on Kotter)");
    expect(cellAt(g, "B3")?.v).toBe("Increase Urgency");
    expect(cellAt(g, "C3")?.edit?.path).toEqual(["tahapan", 7, "deskripsi"]);
    expect(cellAt(g, "D10")?.edit?.path).toEqual(["tahapan", 0, "aksi"]);
    expect(cellAt(g, "B14")?.f).toBe('COUNTIF($E$3:$E$10,"*"&A14&"*")');
    expect(cellAt(g, "A14")?.v).toBe("DM1");
    expect(cellAt(g, "B14")?.v).toBeGreaterThan(0);
    const tot = g.cells.find((x) => x.v === "Cakupan keputusan")!;
    const cak = g.cells.find((x) => x.r === tot.r && x.c === 1)!;
    expect(cak.v).toBe(1);
    expect(cak.f).toMatch(/^IF\(COUNTA\(A14:A\d+\)=0,0,COUNTIF\(B14:B\d+,">0"\)\/COUNTA\(A14:A\d+\)\)$/);
    // Edit aksi → skema → compute: teks baru tampil
    const edited = structuredClone(shuffled);
    setAt(edited, ["tahapan", 0, "aksi"], "Integrasi SOP baru");
    const parsed = changeManagement.schema.safeParse(edited);
    expect(parsed.success).toBe(true);
    const g2 = changeManagement.sheets!(changeManagement.compute!(parsed.data!, ctx), { label: "CM", inputs: { decision_making: decision } })[0];
    expect(cellAt(g2, "D10")?.v).toBe("Integrasi SOP baru");
  });
});

// ---------- Risk management ----------

type FixtureRisk = { p: number; i: number; score: number; rating: string; strategi: string };
const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/excel-framework.json"), "utf8")) as { risk: FixtureRisk[] };

const baseRisk = (over: Partial<RiskItem>): RiskItem => ({
  id: "RM1",
  unitKerja: "Divisi Media",
  status: "Active",
  jenis: "Threat",
  kategori: "Technical Risk",
  sasaran: "Menjaga aset digital",
  periode: "TRIWULAN 1–4",
  deskripsi: "Kehilangan akses akun media sosial organisasi",
  akarPenyebab: "1. Akun terhubung ke pribadi\n2. Belum ada serah terima",
  indikator: "Jumlah akun tanpa PIC",
  faktorPositif: "1. Adanya akun organisasi",
  dampakKualitatif: "1. Publikasi terganggu",
  p: 3,
  i: 3,
  alasanP: "",
  alasanI: "",
  strategi: "Mitigate",
  justifikasi: "",
  penanganan: "Inventarisasi akun dan serah terima akses",
  penangananSaatIni: "Pendataan akun",
  refs: ["W4"],
  evidence: [],
  ...over,
});

describe("risk_management (DM-CRMRM)", () => {
  it("uji emas: P × I → skor dan rating sama dengan Excel (12 baris tab DM-CRMRM)", () => {
    expect(fixture.risk.length).toBe(12);
    const out = computeRisk({ risks: fixture.risk.map((f, k) => baseRisk({ id: `RM${k + 1}`, p: f.p, i: f.i, strategi: f.strategi as RiskItem["strategi"] })) });
    out.rows.forEach((r, k) => {
      expect(r.score).toBe(fixture.risk[k].score);
      expect(r.rating).toBe(fixture.risk[k].rating);
    });
    expect(RiskOutput.safeParse({ risks: [baseRisk({ strategi: fixture.risk[0].strategi as RiskItem["strategi"] })] }).success).toBe(true);
  });

  it("rumus Excel: batas rating dan sel kosong dihitung 0 (→ MINOR)", () => {
    expect([1, 4, 5, 14, 15, 25].map(riskRating)).toEqual(["MINOR", "MINOR", "MODERATE", "MODERATE", "MAJOR", "MAJOR"]);
    expect(riskScore(null, 4)).toBe(0);
    expect(riskRating(riskScore(null, 4))).toBe("MINOR");
    expect(riskRating(4.5)).toBe("MODERATE");
  });

  it("No. dihitung per unit kerja; baris dikelompokkan per unit", () => {
    const out = computeRisk({
      risks: [baseRisk({ id: "RM1", unitKerja: "Divisi Media" }), baseRisk({ id: "RM2", unitKerja: "Divisi Riset" }), baseRisk({ id: "RM3", unitKerja: "Divisi Media" })],
    });
    expect(out.rows.map((r) => [r.id, r.no, r.rawIndex])).toEqual([
      ["RM1", 1, 0],
      ["RM3", 2, 2],
      ["RM2", 1, 1],
    ]);
  });

  it("mock: unit kerja dari dokumen struktur, berujukan ke DM/CM, semua cek kode lolos", async () => {
    const dec = computeDecision(decisionMaking.mock!(baseCtx()));
    const chg = computeChange(changeManagement.mock!(baseCtx({ decision_making: dec })), dec);
    const ctx = baseCtx({ decision_making: dec, change_management: chg });
    const raw = RiskOutput.parse(riskManagement.mock!(ctx));
    expect(raw.risks.length).toBeGreaterThanOrEqual(6);
    expect(raw.risks.some((r) => r.jenis === "Opportunity")).toBe(true);
    expect(raw.risks.some((r) => r.unitKerja === "Divisi Media")).toBe(true);
    expect(raw.risks.some((r) => r.refs.some((x) => x.startsWith("DM")))).toBe(true);
    const checks = await riskManagement.validate!(raw, ctx, llm);
    expect(failed(checks)).toEqual([]);
    const out = computeRisk(raw);
    expect(out.heat.flat().reduce((s, x) => s + x, 0)).toBe(out.rows.length);
  });

  it("cek: skala P/I, Accept untuk MAJOR/MODERATE tanpa justifikasi, strategi tidak cocok dengan jenis, unit asing", async () => {
    const ctx = baseCtx();
    const raw = {
      risks: [
        baseRisk({ id: "RM1", p: 5, i: 4, strategi: "Accept" }),
        baseRisk({ id: "RM2", p: 5, i: 4, strategi: "Accept", justifikasi: "Di luar kendali organisasi; dipantau tiap bulan" }),
        baseRisk({ id: "RM3", p: null, i: 7 }),
        baseRisk({ id: "RM4", jenis: "Opportunity", strategi: "Mitigate", deskripsi: "Peluang kerja sama pelatihan dengan perusahaan teknologi" }),
        baseRisk({ id: "RM5", unitKerja: "Biro Antariksa", akarPenyebab: "", refs: [] }),
      ],
    };
    const checks = await riskManagement.validate!(RiskOutput.parse(raw), ctx, llm);
    expect(check(checks, "strategi_sesuai_rating").failures.map((f) => f.itemId)).toEqual(["RM1"]);
    expect(check(checks, "strategi_sesuai_rating").failures[0].message).toMatch(/MAJOR \(skor 20\).*Accept/);
    expect(check(checks, "skala_pi").failures.map((f) => f.itemId)).toEqual(["RM3", "RM3"]);
    expect(check(checks, "skala_pi").failures[0].message).toMatch(/kosong — Excel menghitungnya 0 sehingga skor 0 dan rating MINOR/);
    expect(check(checks, "strategi_sesuai_jenis").failures.map((f) => f.itemId)).toEqual(["RM4"]);
    expect(check(checks, "unit_kerja").failures.map((f) => f.itemId)).toEqual(["RM5"]);
    expect(check(checks, "kelengkapan").failures[0].message).toContain("akar penyebab");
    expect(check(checks, "grounded").failures.map((f) => f.itemId)).toEqual(["RM5"]);
  });

  it("sheet: 19 kolom Excel, rumus W dan rating, P/I bisa diedit → skor & rating berubah, peta risiko & grafik sebar", () => {
    const raw = RiskOutput.parse({ risks: [baseRisk({ id: "RM1" }), baseRisk({ id: "RM2", p: 2, i: 2 })] });
    const g = riskManagement.sheets!(computeRisk(raw), { label: "RM", inputs: {} })[0];
    expect(cellAt(g, "Q1")).toMatchObject({ v: "EVALUASI DAN RENCANA PENANGANAN RISIKO", cs: 3 });
    expect(cellAt(g, "A2")?.v).toBe("Unit Kerja");
    expect(cellAt(g, "S2")?.v).toBe("Penanganan Yang Telah Dilakukan");
    expect(cellAt(g, "O3")).toMatchObject({ v: 9, f: "M3*N3" });
    expect(cellAt(g, "P3")).toMatchObject({ v: "MODERATE", f: 'IF(O3="","",IF(O3<=4,"MINOR",IF(O3<=14,"MODERATE","MAJOR")))' });
    expect(cellAt(g, "P4")?.v).toBe("MINOR");
    const pCell = cellAt(g, "M3")!;
    expect(pCell.edit).toMatchObject({ path: ["risks", 0, "p"], type: "select", allowEmpty: true });
    const edited = structuredClone(raw);
    setAt(edited, pCell.edit!.path, 5);
    const parsed = riskManagement.schema.safeParse(edited);
    expect(parsed.success).toBe(true);
    const out = riskManagement.compute!(parsed.data!, baseCtx()) as ReturnType<typeof computeRisk>;
    expect(out.rows[0]).toMatchObject({ score: 15, rating: "MAJOR" });
    const g2 = riskManagement.sheets!(out, { label: "RM", inputs: {} })[0];
    expect(cellAt(g2, "O3")?.v).toBe(15);
    expect(cellAt(g2, "P3")?.v).toBe("MAJOR");
    // Peta risiko: sel P = 5, I = 3 berisi 1 risiko (COUNTIFS)
    const heat = g2.cells.find((x) => x.f === "COUNTIFS($M$3:$M$4,5,$N$3:$N$4,3)")!;
    expect(heat.v).toBe(1);
    expect(heat.fill).toBe("FF0000");
    expect(g2.anchors?.major).toBeTruthy();
    expect(g2.chart).toMatchObject({ type: "scatter", max: 5 });
    expect(g2.chart?.type === "scatter" && g2.chart.points).toEqual([
      { label: "RM1", x: 3, y: 5 },
      { label: "RM2", x: 2, y: 2 },
    ]);
    // Mengosongkan P diperbolehkan (Excel: dihitung 0)
    setAt(edited, ["risks", 0, "p"], null);
    expect(riskManagement.schema.safeParse(edited).success).toBe(true);
    expect(computeRisk(edited).rows[0]).toMatchObject({ score: 0, rating: "MINOR" });
  });

  it("unit kerja: dibaca dari dokumen struktur; nama organisasi selalu sah", () => {
    expect(unitsFromText(evidence.map((e) => e.content))).toEqual(expect.arrayContaining(["Divisi Media", "Divisi Riset", "Divisi Kaderisasi"]));
    const opts = { projectName: SYNTHETIC_PROJECT.name, evidence, jabatan: ["Ketua himpunan"] };
    expect(unitKnown("Divisi Hubungan Eksternal", opts)).toBe(true);
    expect(unitKnown(SYNTHETIC_PROJECT.name, opts)).toBe(true);
    expect(unitKnown("Biro Antariksa", opts)).toBe(false);
    expect(unitKnown("Biro Keuangan", { projectName: "X", evidence: [], jabatan: [] })).toBeNull();
  });
});
