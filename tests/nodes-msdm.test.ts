import { describe, expect, it } from "vitest";
import type { EvidenceChunk } from "@/lib/db/schema";
import type { CheckResult, LlmSession, NodeContext, NodeDef, NodeKey } from "@/lib/nodes/types";
import type { Grid, GridCell } from "@/lib/sheets/grid";
import { msdmAttraction } from "@/lib/nodes/msdm/attraction";
import { computeRecruitment, excelSerial, msdmRecruitment, parseIsoDate, RecruitmentOutput } from "@/lib/nodes/msdm/recruitment";
import { msdmOnboarding } from "@/lib/nodes/msdm/onboarding";
import { msdmDevelopment, type DevelopmentOutput } from "@/lib/nodes/msdm/development";
import { computePenilaian, msdmPenilaian, rollUp, PenilaianOutput, type NilaiUtamaRaw, type PenilaianComputed } from "@/lib/nodes/msdm/penilaian";
import { msdmRetention, type RetentionOutput } from "@/lib/nodes/msdm/retention";
import { computeSeparation, msdmSeparation, SeparationOutput, type SeparationComputed } from "@/lib/nodes/msdm/separation";

// ---------- Konteks uji ----------

const evidence: EvidenceChunk[] = [
  {
    id: "C1",
    kind: "document",
    source: "notulensi.txt",
    content:
      "Poin 3. Kehadiran pengurus pada kegiatan internal menurun menjadi 58 persen setelah ujian tengah semester. Poin 7. Rapat menyepakati perlunya pelatihan manajemen proyek dan kepemimpinan bagi pengurus karena banyak program kerja tertunda.",
  },
  {
    id: "C2",
    kind: "document",
    source: "keresahan.txt",
    content:
      "Keresahan 4. Pengurus mengeluhkan beban ganda antara kepanitiaan, kuliah, dan praktikum sehingga banyak program kerja selesai tanpa evaluasi. Keresahan 5. Pergantian kepengurusan selalu menyisakan dokumentasi yang tidak lengkap, sehingga program harus dirancang ulang dari nol.",
  },
  {
    id: "C3",
    kind: "document",
    source: "struktur.txt",
    content:
      "Sekretaris bertugas mengelola administrasi, persuratan, dan arsip organisasi. Bendahara bertugas mengelola anggaran dan laporan keuangan setiap bulan. Staf divisi membantu kepala divisi menjalankan program kerja.",
  },
];

const cascading = {
  visi: "Menjadi wadah kolaborasi mahasiswa yang berdampak",
  aspects: [
    {
      id: "AS1",
      aspek: "Kapasitas pengurus",
      misi: "Mengembangkan kapasitas pengurus",
      objectives: [
        { id: "SO1", text: "Meningkatkan kompetensi pengurus", initiatives: [{ id: "SI1", text: "Program pelatihan rutin", strategyRef: null }] },
        { id: "SO2", text: "Membangun sistem dokumentasi", initiatives: [] },
      ],
    },
  ],
};

function ctxOf(inputs: Partial<Record<NodeKey, unknown>>, ev: EvidenceChunk[] = evidence): NodeContext {
  return { projectId: "p", projectName: "BEM Uji", orgType: "BEM", runId: "r", nodeRunId: "n", inputs, evidence: ev };
}

const llm: LlmSession = { json: async (_p, _s, _u, schema, mock) => schema.parse(mock()) };

/** Jalankan satu node seperti engine mode uji: mock → skema → validator → compute. */
async function runMock<T>(def: NodeDef<T>, ctx: NodeContext) {
  const raw = def.schema.parse(def.mock!(ctx));
  const checks = await def.validate!(raw, ctx, llm);
  const out = def.compute ? def.compute(raw, ctx) : raw;
  return { raw, checks, out };
}

const failed = (cs: CheckResult[]) => cs.filter((c) => !c.passed).map((c) => `${c.check}: ${c.failures.map((f) => f.message).join(" | ")}`);

function getAt(obj: unknown, path: (string | number)[]): unknown {
  let cur = obj as Record<string | number, unknown> | undefined;
  for (const k of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[k] as Record<string | number, unknown> | undefined;
  }
  return cur;
}
function setAt(obj: unknown, path: (string | number)[], value: unknown) {
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
}
const cellAt = (g: Grid, a1: string): GridCell | undefined => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = m[1].split("").reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return g.cells.find((x) => x.r === Number(m[2]) - 1 && x.c === c);
};

/** Nilai uji yang sah untuk sel edit. */
function sampleValue(cell: GridCell): unknown {
  const e = cell.edit!;
  if (e.type === "select") {
    const o = e.options?.[0];
    return o === undefined ? null : typeof o === "string" ? o : o.value;
  }
  if (e.type === "number") return e.max ?? e.min ?? 1;
  if (e.path[e.path.length - 1] === "tanggalMulai") return "2026-03-02";
  return "Teks uji dari pengguna";
}

/** Setiap sel edit menunjuk path yang ada di output mentah; nilai baru lolos skema dan compute tidak gagal. */
function checkEditable<T>(def: NodeDef<T>, raw: T, ctx: NodeContext) {
  const out = def.compute ? def.compute(raw, ctx) : raw;
  const grids = def.sheets!(out, { label: def.label, inputs: ctx.inputs });
  const cells = grids.flatMap((g) => g.cells.filter((c) => c.edit));
  expect(cells.length).toBeGreaterThan(0);
  for (const c of cells) {
    const p = c.edit!.path;
    const parent = getAt(raw, p.slice(0, -1));
    expect(parent, `path ${p.join(".")}`).toBeTypeOf("object");
    const copy = structuredClone(raw);
    setAt(copy, p, sampleValue(c));
    const parsed = def.schema.safeParse(copy);
    expect(parsed.success, `edit ${p.join(".")}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
    expect(() => def.compute?.(parsed.data as T, ctx)).not.toThrow();
  }
  return { grids, cells };
}

// ---------- Rantai mode uji ----------

describe("MSDM — rantai mode uji (mock → skema → validator → compute → sheet)", async () => {
  const inputs: Partial<Record<NodeKey, unknown>> = { cascading };
  const chain = [msdmAttraction, msdmRecruitment, msdmOnboarding, msdmDevelopment, msdmPenilaian, msdmRetention, msdmSeparation] as NodeDef<unknown>[];
  const results: Record<string, Awaited<ReturnType<typeof runMock>>> = {};
  for (const def of chain) {
    const r = await runMock(def, ctxOf({ ...inputs }));
    results[def.key] = r;
    inputs[def.key] = r.out;
  }

  it.each(chain.map((d) => [d.key, d] as const))("%s: lolos semua cek kode & LLM mock, punya butir, sheet, blok, ringkasan, prompt", (_k, def) => {
    const r = results[def.key];
    expect(failed(r.checks)).toEqual([]);
    // Setiap cek yang dideklarasikan benar-benar dijalankan.
    expect(def.checks.map((c) => c.name).sort()).toEqual([...new Set(r.checks.map((c) => c.check))].sort());
    expect(def.items(r.out).length).toBeGreaterThan(0);
    const grids = def.sheets!(r.out, { label: def.label, inputs });
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      expect(g.name.length).toBeLessThanOrEqual(31);
      // sel tidak bertumpuk
      const seen = new Set<string>();
      for (const c of g.cells)
        for (let dr = 0; dr < (c.rs ?? 1); dr++)
          for (let dc = 0; dc < (c.cs ?? 1); dc++) {
            const k = `${c.r + dr},${c.c + dc}`;
            expect(seen.has(k), `${g.id} sel ${k} bertumpuk`).toBe(false);
            seen.add(k);
          }
      // sel berumus selalu punya penjelasan (sheet AHP bersama dibuat lib/sheets/ahp-sheet.ts, di luar node ini)
      if (g.id !== "ahp") for (const c of g.cells.filter((x) => x.f)) expect(c.explain, `${g.id} ${c.r},${c.c}`).toBeTruthy();
    }
    expect(def.blocks!(r.out, { label: def.label, inputs }).length).toBeGreaterThan(0);
    expect(def.summary!(r.out)).toMatch(/\S/);
    const p = def.prompt!(ctxOf(inputs));
    expect(p.system).toContain("Balas HANYA dengan JSON");
    expect(p.user).toContain("Skema output");
    expect(def.deps).toEqual([]);
  });

  it.each(chain.map((d) => [d.key, d] as const))("%s: setiap sel edit menunjuk path output mentah yang sah", (_k, def) => {
    checkEditable(def, results[def.key].raw, ctxOf(inputs));
  });

  it("konteks hulu masuk ke prompt dan refs memakai ID hulu", () => {
    const dev = results.msdm_development.raw as DevelopmentOutput;
    expect(dev.kegiatan.some((k) => k.refs.some((r) => r.startsWith("OB")))).toBe(true);
    const p = msdmRetention.prompt!(ctxOf(inputs));
    expect(p.user).toContain("SO1");
    expect(p.user).toContain("MSDM – Penilaian");
    const ret = results.msdm_retention.raw as RetentionOutput;
    expect(ret.startDoing.length + ret.stopDoing.length).toBeGreaterThan(10);
    // penilaian mock: realisasi kosong (belum dinilai) → ketercapaian "–"
    const pen = results.msdm_penilaian.out as PenilaianComputed;
    expect(pen.total).toBeNull();
    expect(pen.dinilai).toBe(0);
    expect(pen.staffName).toBe("Staf A");
  });
});

// ---------- Recruitment: tanggal ----------

describe("recruitment — timeline", () => {
  const base = msdmRecruitment.schema.parse(msdmRecruitment.mock!(ctxOf({})));
  it("tanpa tanggal mulai: label hari ke-, sel tanggal kosong", () => {
    const c = computeRecruitment(base);
    expect(c.jadwal[2].label).toBe("Hari ke-3–5");
    expect(c.jadwal[2].mulai).toBeNull();
    expect(c.totalHari).toBe(9);
  });
  it("tanggal mulai digeser lewat sel edit → semua tanggal dihitung ulang (serial Excel)", () => {
    const raw = structuredClone(base);
    const g = msdmRecruitment.sheets!(computeRecruitment(raw), { label: "", inputs: {} })[0];
    const startCell = g.cells.find((c) => c.edit?.path.join(".") === "timeline.tanggalMulai")!;
    setAt(raw, startCell.edit!.path, "2026-02-14");
    const parsed = RecruitmentOutput.parse(raw);
    const c = computeRecruitment(parsed);
    expect(c.jadwal[0]).toMatchObject({ mulai: "2026-02-14", selesai: "2026-02-14", label: "14 Feb 2026" });
    expect(c.jadwal[2]).toMatchObject({ mulai: "2026-02-16", selesai: "2026-02-18", label: "16–18 Feb 2026" });
    expect(excelSerial(parseIsoDate("2026-02-14")!)).toBe(46067);
    const g2 = msdmRecruitment.sheets!(c, { label: "", inputs: {} })[0];
    const mulai = g2.cells.find((x) => x.f?.includes("-1)") && x.f.startsWith("IF(") && x.display === "16 Feb 2026")!;
    expect(mulai.v).toBe(46069);
    expect(mulai.f).toMatch(/^IF\(\$B\$\d+="","",\$B\$\d+\+D\d+-1\)$/);
  });
  it("tanggal tidak sah ditolak skema/validator; hari ke- mundur ditandai", async () => {
    expect(RecruitmentOutput.safeParse({ ...base, timeline: { ...base.timeline, tanggalMulai: "14/02/2026" } }).success).toBe(false);
    const bad = structuredClone(base);
    bad.timeline.tanggalMulai = "2026-02-30";
    bad.timeline.steps[3].hariMulai = 2;
    bad.positions[1].atasan = "P99";
    const checks = await msdmRecruitment.validate!(bad, ctxOf({}), llm);
    expect(checks.find((c) => c.check === "timeline_order")!.failures.length).toBe(2);
    expect(checks.find((c) => c.check === "atasan_exists")!.passed).toBe(false);
  });
});

// ---------- Penilaian: uji emas Excel ----------

/** Struktur lembar penilaian di Excel (MSDMGD-DEVELOPMENT) dengan bobot, target, dan realisasinya. Nama staf diganti. */
const L3 = ["level 1", "level 2", "level 3"];
const L2 = ["level 1", "level 2"];
const ind = (id: string, levels: string[], target: number, realisasi: number) => ({ id, nama: id, levels, target, realisasi, tools: "t", alasan: "" });
const EXCEL_NU: NilaiUtamaRaw[] = [
  {
    id: "N1",
    nama: "Komunikatif",
    atribut: [
      { id: "A1", nama: "Komunikasi Internal", indikator: [ind("I1", L2, 3, 2)] },
      { id: "A2", nama: "Koordinasi Media", indikator: [ind("I2", L3, 3, 2), ind("I3", L3, 2, 3)] },
      { id: "A3", nama: "Kejelasan Komunikasi", indikator: [ind("I4", L3, 3, 2)] },
    ],
  },
  {
    id: "N2",
    nama: "Informatif",
    atribut: [
      { id: "A4", nama: "Pengelolaan Informasi", indikator: [ind("I5", L2, 3, 2)] },
      { id: "A5", nama: "Ketepatan Waktu Informasi", indikator: [ind("I6", L3, 3, 2)] },
    ],
  },
  {
    id: "N3",
    nama: "Kreatif",
    atribut: [
      { id: "A6", nama: "Kreativitas Konten", indikator: [ind("I7", L2, 3, 2)] },
      { id: "A7", nama: "Kualitas Visual", indikator: [ind("I8", L2, 2, 2)] },
      { id: "A8", nama: "Konsistensi Identitas Media", indikator: [ind("I9", L3, 3, 2)] },
      // Indikator kedua "Inisiatif Produksi Konten" di Excel hanya punya satu baris (deskripsi berisi angka 1).
      { id: "A9", nama: "Inisiatif Produksi Konten", indikator: [ind("I10", L3, 3, 2), ind("I11", ["1"], 2, 2)] },
    ],
  },
  { id: "N4", nama: "Adaptif & Bermanfaat", atribut: [{ id: "A10", nama: "Pemanfaatan Teknologi", indikator: [ind("I12", L2, 3, 2)] }] },
];
const EXCEL_W: Record<string, number> = {
  N1: 0.3, N2: 0.25, N3: 0.3, N4: 0.15,
  A1: 0.5, A2: 0.3, A3: 0.2, A4: 0.5, A5: 0.5, A6: 0.3, A7: 0.3, A8: 0.2, A9: 0.2, A10: 1,
  I1: 1, I2: 0.4, I3: 0.6, I4: 1, I5: 1, I6: 1, I7: 1, I8: 1, I9: 1, I10: 0.6, I11: 0.4, I12: 1,
};

describe("penilaian — uji emas rumus Excel", () => {
  const { ketercapaian: k, total } = rollUp(EXCEL_NU, (id) => EXCEL_W[id]);
  it("ketercapaian indikator = IF(N>M,1,N/M) dan atribut (L4, L9, H4, H6, H27)", () => {
    expect(k.I1).toBeCloseTo(2 / 3, 9); // L4
    expect(k.I3).toBe(1); // L9: realisasi 3 > target 2
    expect(k.A1).toBeCloseTo(0.6666666667, 9); // H4
    expect(k.A2).toBeCloseTo(0.8666666667, 9); // H6
    expect(k.A7).toBe(1); // H22
    expect(k.A9).toBeCloseTo(0.8, 9); // H27
  });
  it("ketercapaian nilai utama E15, E20, E31 sama dengan Excel", () => {
    expect(k.N2).toBeCloseTo(0.6666666667, 9);
    expect(k.N3).toBeCloseTo(0.7933333333, 9);
    expect(k.N4).toBeCloseTo(0.6666666667, 9);
  });
  it("E4 & A4: Excel salah rujuk (H11*F11 seharusnya H6*F6) → kode memakai rujukan yang benar", () => {
    // Excel: E4 = H4*F4 + H11*F11 + F12*H12 = 0,4667 (H11/F11 sel kosong di dalam gabungan → 0), A4 = 0,6447.
    expect(k.N1).toBeCloseTo(0.5 * (2 / 3) + 0.3 * 0.8666666667 + 0.2 * (2 / 3), 9);
    expect(k.N1).toBeCloseTo(0.7266666667, 9);
    expect(total).toBeCloseTo(0.7226666667, 9);
    // Bila sumbangan atribut Koordinasi Media dihilangkan (kekeliruan Excel), angka Excel muncul kembali.
    const excelE4 = (k.N1 as number) - 0.3 * (k.A2 as number);
    expect(excelE4).toBeCloseTo(0.4666666667, 9);
    expect((total as number) - 0.3 * 0.3 * (k.A2 as number)).toBeCloseTo(0.6446666667, 9);
  });
  it("realisasi kosong → belum dinilai, ikut kosong ke atas", () => {
    const nu = structuredClone(EXCEL_NU);
    nu[0].atribut[1].indikator[0].realisasi = null as unknown as number;
    const r = rollUp(nu, (id) => EXCEL_W[id]);
    expect(r.ketercapaian.I2).toBeNull();
    expect(r.ketercapaian.A2).toBeNull();
    expect(r.ketercapaian.N1).toBeNull();
    expect(r.total).toBeNull();
    expect(r.ketercapaian.N2).toBeCloseTo(2 / 3, 9);
  });
  it("sheet meniru tata letak Excel: rumus di L4, H6, H27, E4, A4 (dengan penjaga sel kosong)", () => {
    const raw = PenilaianOutput.parse({ staffName: "Staf A", unit: "Biro Media", output: "Staf yang handal dan adaptif", nilaiUtama: EXCEL_NU });
    const c = computePenilaian(raw);
    const g = msdmPenilaian.sheets!(c, { label: "", inputs: {} })[0];
    expect(cellAt(g, "L4")?.f).toBe('IF(N4="","",IF(N4>M4,1,N4/M4))');
    expect(cellAt(g, "H6")?.f).toBe('IF(OR(L6="",L9=""),"",I6*L6+I9*L9)');
    expect(cellAt(g, "H27")?.f).toBe('IF(OR(L27="",L30=""),"",I27*L27+I30*L30)');
    expect(cellAt(g, "E4")?.f).toBe('IF(OR(H4="",H6="",H12=""),"",F4*H4+F6*H6+F12*H12)');
    expect(cellAt(g, "E15")?.f).toBe('IF(OR(H15="",H17=""),"",F15*H15+F17*H17)');
    expect(cellAt(g, "A4")?.f).toBe('IF(OR(E4="",E15="",E20="",E31=""),"",C4*E4+C15*E15+C20*E20+C31*E31)');
    expect(cellAt(g, "D31")?.v).toBe("Adaptif & Bermanfaat");
    expect(cellAt(g, "B1")?.v).toBe("Staf A");
    // Bobot butir tunggal = 1; bobot kelompok tanpa perbandingan = sama rata (AHP)
    expect(cellAt(g, "I4")?.v).toBe(1);
    expect(cellAt(g, "F31")?.v).toBe(1);
    expect(cellAt(g, "C4")?.v).toBeCloseTo(0.25, 9);
    expect(cellAt(g, "C4")?.f).toBe("{{msdm_penilaian!w_N1}}");
    expect(g.chart?.type).toBe("bar");
    expect(g.anchors?.total).toBe("A4");
  });
});

describe("penilaian — AHP dan edit pengguna", () => {
  const ctx = ctxOf({});
  const raw = msdmPenilaian.schema.parse(msdmPenilaian.mock!(ctx));
  it("bobot tiap kelompok berjumlah 1; butir tunggal berbobot 1", () => {
    const c = computePenilaian(raw);
    const sum = (ids: string[]) => ids.reduce((s, id) => s + c.bobot[id], 0);
    expect(sum(c.nilaiUtama.map((n) => n.id))).toBeCloseTo(1, 9);
    for (const n of c.nilaiUtama) expect(sum(n.atribut.map((a) => a.id))).toBeCloseTo(1, 9);
    expect(c.bobot.I1).toBe(1);
    expect(c.ahpSets.every((s) => s.consistent)).toBe(true);
  });
  it("mengisi realisasi lewat sel edit → ketercapaian dihitung; mengubah perbandingan AHP → bobot berubah", () => {
    const c0 = computePenilaian(raw);
    const [main, ahpG] = msdmPenilaian.sheets!(c0, { label: "", inputs: {} });
    const edited = structuredClone(raw);
    for (const cell of main.cells.filter((x) => x.edit?.path[x.edit.path.length - 1] === "realisasi")) setAt(edited, cell.edit!.path, 2);
    const p = PenilaianOutput.safeParse(edited);
    expect(p.success).toBe(true);
    const c1 = computePenilaian(p.data!);
    expect(c1.dinilai).toBe(c1.jumlahIndikator);
    expect(c1.total).not.toBeNull();
    // indikator target 3, realisasi 2 → 2/3; target 2, realisasi 2 → 1
    expect(c1.ketercapaian.I1).toBeCloseTo(2 / 3, 9);
    expect(c1.ketercapaian.I3).toBe(1);
    const g1 = msdmPenilaian.sheets!(c1, { label: "", inputs: {} })[0];
    expect(g1.chart?.type === "bar" && g1.chart.data.length).toBe(c1.nilaiUtama.length);
    // AHP: sel perbandingan pertama himpunan NU
    const pairCell = ahpG.cells.find((x) => x.edit && x.edit.path[0] === "ahp")!;
    expect(pairCell.edit!.path).toEqual(["ahp", 0, "pairs", 0, "v"]);
    const e2 = structuredClone(p.data!);
    setAt(e2, pairCell.edit!.path, 9);
    const c2 = computePenilaian(PenilaianOutput.parse(e2));
    expect(c2.bobot.N1).toBeGreaterThan(c1.bobot.N1);
    expect(c2.total).not.toBeCloseTo(c1.total as number, 6);
  });
  it("validator: realisasi tanpa bukti, target melebihi level, nama asli, AHP kurang", async () => {
    const bad = structuredClone(raw);
    bad.nilaiUtama[0].atribut[0].indikator[0].realisasi = 2;
    bad.nilaiUtama[0].atribut[0].indikator[0].levels = ["a", "b"];
    bad.nilaiUtama[0].atribut[0].indikator[0].target = 3;
    bad.staffName = "Budi Santoso";
    bad.ahp = bad.ahp.filter((s) => s.id !== "NU");
    const checks = await msdmPenilaian.validate!(bad, ctx, llm);
    const fails = new Set(checks.filter((c) => !c.passed).map((c) => c.check));
    expect([...fails].sort()).toEqual(["ahp_complete", "realisasi_grounded", "staff_anonim", "target_range"]);
  });
});

// ---------- Separation ----------

describe("separation — rata-rata survei", () => {
  const ctx = ctxOf({});
  const raw = msdmSeparation.schema.parse(msdmSeparation.mock!(ctx));
  it("mock: 20 pertanyaan, 5 baris responden kosong, rumus AVERAGE dan tanpa grafik", () => {
    const c = computeSeparation(raw);
    expect(c.questions.length).toBe(20);
    expect(c.respondents.map((r) => r.label)).toEqual(["Responden 1", "Responden 2", "Responden 3", "Responden 4", "Responden 5"]);
    expect(c.overall).toBeNull();
    const g = msdmSeparation.sheets!(c, { label: "", inputs: {} })[0];
    expect(cellAt(g, "F8")?.v).toBe("AVERAGE");
    expect(cellAt(g, "G8")?.f).toBe('IFERROR(AVERAGE(G3:G7),"")');
    expect(cellAt(g, "B3")?.v).toBe("Q1");
    expect(cellAt(g, "G2")?.v).toBe("Q1");
    expect(g.chart).toBeUndefined();
  });
  it("skor dari pengguna (data 4 responden di Excel): AVERAGE mengabaikan sel kosong", () => {
    // Skor Q1–Q4 empat responden di tab MSDMSEPARATION (nama diganti "Responden n").
    const excel = [
      [7, 8, 7, 8],
      [8, 9, 8, 9],
      [6, 6, 5, 6],
      [9, 8, 9, 8],
    ];
    const edited = structuredClone(raw);
    const c0 = computeSeparation(raw);
    const g = msdmSeparation.sheets!(c0, { label: "", inputs: {} })[0];
    excel.forEach((row, i) =>
      row.forEach((v, j) => {
        const cell = g.cells.find((x) => x.edit?.path.join(".") === `respondents.${i}.scores.Q${j + 1}`)!;
        setAt(edited, cell.edit!.path, v);
      }),
    );
    const p = SeparationOutput.safeParse(edited);
    expect(p.success).toBe(true);
    const c: SeparationComputed = computeSeparation(p.data!);
    // Rata-rata sebenarnya dari empat responden (Excel menulis angka ketikan 7,4 / 7,55 / 7,05 / 7,6 — bukan rumus).
    expect(c.averages.Q1).toBeCloseTo(7.5, 9);
    expect(c.averages.Q2).toBeCloseTo(7.75, 9);
    expect(c.averages.Q3).toBeCloseTo(7.25, 9);
    expect(c.averages.Q4).toBeCloseTo(7.75, 9);
    expect(c.averages.Q5).toBeNull();
    expect(c.respondentAverages.R3).toBeCloseTo(5.75, 9);
    expect(c.respondentAverages.R5).toBeNull();
    expect(c.overall).toBeCloseTo(7.5625, 9);
    expect(c.lowest[0]).toBe("Q3");
    expect(c.kategori.Q1).toBe("Sedang");
    const g2 = msdmSeparation.sheets!(c, { label: "", inputs: {} })[0];
    expect(g2.chart?.type === "bar" && g2.chart.data.map((d) => d.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    // skor di luar skala ditolak skema
    setAt(edited, ["respondents", 0, "scores", "Q1"], 11);
    expect(SeparationOutput.safeParse(edited).success).toBe(false);
  });
  it("validator: skor tanpa bukti dan label bernama ditolak", async () => {
    const bad = structuredClone(raw);
    bad.respondents[0].scores.Q1 = 7;
    bad.respondents[1].label = "Andi";
    const checks = await msdmSeparation.validate!(bad, ctx, llm);
    const fails = new Set(checks.filter((c) => !c.passed).map((c) => c.check));
    expect(fails.has("data_grounded")).toBe(true);
    expect(fails.has("respondent_anonim")).toBe(true);
  });
});

// ---------- Validator lain ----------

describe("validator MSDM lain", () => {
  it("retention: butir sama di Keep Doing dan Stop Doing terdeteksi", async () => {
    const ctx = ctxOf({ cascading });
    const raw = msdmRetention.schema.parse(msdmRetention.mock!(ctx));
    raw.stopDoing[0] = { ...raw.stopDoing[0], text: raw.keepDoing[0].text };
    const checks = await msdmRetention.validate!(raw, ctx, llm);
    expect(checks.find((c) => c.check === "category_conflict")!.failures[0].itemId).toBe(raw.stopDoing[0].id);
  });
  it("development: maintenance tumpang tindih / celah dan urutan tahap", async () => {
    const ctx = ctxOf({ cascading });
    const raw = msdmDevelopment.schema.parse(msdmDevelopment.mock!(ctx));
    raw.maintenance[1].dari = 2; // kuartal 2 ganda
    raw.kegiatan[0].kuartal = 4; // tahap 1 di kuartal 4 → setelah tahap 2 berakhir
    raw.maintenance.push({ id: "M3", pj: "Sekretaris", dari: 4, sampai: 4, tugas: "" });
    const checks = await msdmDevelopment.validate!(raw, ctx, llm);
    expect(checks.find((c) => c.check === "maintenance_coverage")!.failures.length).toBe(2);
    expect(checks.find((c) => c.check === "stage_window")!.failures.map((f) => f.itemId)).toContain("D1");
    // sheet tetap tersusun tanpa sel bertumpuk walau maintenance tumpang tindih
    const g = msdmDevelopment.sheets!(raw, { label: "", inputs: {} })[0];
    expect(g.cells.filter((c) => c.v === "SEKRETARIS").length).toBe(1);
  });
  it("onboarding: topik wajib yang hilang dilaporkan", async () => {
    const ctx = ctxOf({});
    const raw = msdmOnboarding.schema.parse(msdmOnboarding.mock!(ctx));
    raw.kegiatan = raw.kegiatan.slice(2, 3);
    const checks = await msdmOnboarding.validate!(raw, ctx, llm);
    expect(checks.find((c) => c.check === "topic_coverage")!.passed).toBe(false);
    expect(checks.find((c) => c.check === "kegiatan_complete")!.passed).toBe(false);
  });
  it("attraction: kutipan palsu dan refs asing ditolak", async () => {
    const ctx = ctxOf({ cascading });
    const raw = msdmAttraction.schema.parse(msdmAttraction.mock!(ctx));
    raw.staffNeed[0].evidence = [{ chunkId: "C1", quote: "kalimat ini tidak ada di dokumen" }];
    raw.organizationNeed[0].refs = ["SO99"];
    const checks = await msdmAttraction.validate!(raw, ctx, llm);
    expect(checks.find((c) => c.check === "quote_exists")!.passed).toBe(false);
    expect(checks.find((c) => c.check === "ref_exists")!.failures[0].message).toContain("SO99");
  });
});
