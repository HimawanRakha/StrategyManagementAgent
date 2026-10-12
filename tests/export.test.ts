import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import ExcelJS from "exceljs";
import { GridBuilder, type Grid } from "@/lib/sheets/grid";
import type { DocSection, GrandDesignDoc } from "@/lib/grand-design/doc";
import { summarizeEdits, collectCitations } from "@/lib/grand-design/doc";
import { grandDesignXlsx, normalizeFormula, resolvePlaceholders } from "@/lib/export/xlsx";
import { docToBlocks } from "@/lib/export/blocks";
import { docToReport, titleCase } from "@/lib/export/report";
import { cellText } from "@/lib/export/pdf";
import { checkTraceComplete, traceChains, buildTraceIndex } from "@/lib/grand-design/trace";
import { validateSummaryRefs, validElementIds } from "@/lib/validators/phase2";

// ---------- Data buatan ----------

function ifasGrid(): Grid {
  const g = new GridBuilder("ifas", "ESIFAS", "Matriks IFAS");
  g.set(0, 0, "Matriks IFAS", { style: "title", cs: 4 });
  g.row(2, 0, ["Faktor", "Rating", "Bobot", "Skor"], { style: "header" });
  g.set(3, 0, "S1 Kaderisasi rutin", { style: "label" });
  g.set(3, 1, 3, { style: "num", fmt: "0.00", src: "ai", note: "Notulensi menyebut kaderisasi berjalan tiap semester", refs: ["C1"], edit: { path: ["ratings", 0, "v"], type: "number", min: 1, max: 4 } });
  g.set(3, 2, 0.4, { style: "num", src: "ahp" });
  g.set(3, 3, 1.2, { style: "num", f: "B4*C4", src: "hitung", explain: "Skor = Rating × Bobot = 3 × 0,4 = 1,2" });
  g.set(4, 0, "W1 Regenerasi lambat", { style: "label" });
  g.set(4, 1, 2, { style: "num", src: "ai", edit: { path: ["ratings", 1, "v"], type: "number" } });
  g.set(4, 2, 0.6, { style: "num", src: "ahp" });
  g.set(4, 3, -1.2, { style: "num", f: "-B5*C5", src: "hitung", explain: "Skor W negatif = −2 × 0,6" });
  g.set(5, 0, "Total", { style: "total", cs: 3 });
  g.set(5, 3, 0, { style: "total", f: "SUM(D4:D5)", src: "hitung", explain: "Total = 1,2 − 1,2 = 0" });
  g.anchor("total", 5, 3);
  return g.build({ cols: [30, 10, 10, 10], freeze: { rows: 3, cols: 1 }, notes: ["Skor = rating × bobot."] });
}

function posisiGrid(): Grid {
  const g = new GridBuilder("posisi", "SGSOP", "Posisi organisasi");
  g.set(0, 0, "Posisi organisasi", { style: "title", cs: 3 });
  g.set(1, 0, "X (IFAS)", { style: "label" });
  g.set(1, 1, 0, { style: "num", f: "{{ifas!total}}", src: "hitung", explain: "X = total IFAS" });
  g.set(2, 0, "Y (EFAS)", { style: "label" });
  g.set(2, 1, 0.5, { style: "num", f: "{{efas!total}}", src: "hitung", explain: "Y = total EFAS" });
  g.set(3, 0, "Kuadran", { style: "label" });
  g.set(3, 1, "I", { f: 'IF(AND(B2>=0;B3>=0),"I","II")', src: "hitung", fill: "C6EFCE" });
  return g.build({
    cols: [20, 12, 12],
    chart: { type: "quadrant", title: "Posisi", x: 0, y: 0.5, xLabel: "IFAS", yLabel: "EFAS", quadrants: ["I", "II", "III", "IV"] },
  });
}

function section(p: Partial<DocSection> & Pick<DocSection, "key" | "label" | "group">): DocSection {
  const grids = p.grids ?? [];
  return {
    groupCode: p.group.toUpperCase(),
    sheetName: p.label.toUpperCase(),
    status: "done",
    statusLabel: "selesai",
    available: true,
    error: null,
    summary: null,
    output: {},
    sheets: grids.map((g) => ({ id: g.id, name: g.name, title: g.title })),
    blocks: [],
    formulas: [],
    items: [],
    edits: summarizeEdits([]),
    validation: { enabled: false, passed: null, checks: [], failed: 0, passedChecks: 0 },
    questions: [],
    renderErrors: [],
    fallback: { sheets: false, blocks: false },
    ...p,
    grids,
  };
}

function makeDoc(): GrandDesignDoc {
  const custom = new GridBuilder("custom", "ESIFAS", "Kustom dengan nama sama");
  custom.set(0, 0, "Kustom", { style: "title" });
  const sections: DocSection[] = [
    section({
      key: "ifas",
      label: "IFAS",
      group: "es",
      groupCode: "ES",
      summary: "Total IFAS 0,000.",
      grids: [ifasGrid()],
      blocks: [{ type: "table", head: ["Faktor", "Skor"], rows: [["S1", "1,2"]] }],
      formulas: [{ name: "Skor", rumus: "Skor = Rating × Bobot", arti: "Kontribusi faktor", excel: "=B4*C4" }],
      edits: summarizeEdits([
        { path: ["ratings", 0, "v"], from: 2, to: 4, at: "2026-10-07T08:00:00.000Z" },
        { path: ["ratings", 0, "v"], from: 4, to: 3, at: "2026-10-07T09:00:00.000Z" },
      ]),
      validation: {
        enabled: true,
        passed: false,
        checks: [
          { check: "range", label: "Rating di luar 1–4", kind: "code", passed: true, failures: [] },
          { check: "ahp_cr", label: "CR AHP > 0,10", kind: "code", passed: false, failures: [{ check: "ahp_cr", itemId: "S", message: "CR himpunan S = 0,15 > 0,10." }] },
        ],
        failed: 1,
        passedChecks: 1,
      },
    }),
    section({ key: "posisi_organisasi", label: "Posisi organisasi", group: "sgs", groupCode: "SGS", grids: [posisiGrid()], summary: "Kuadran I." }),
    section({ key: "custom_x", label: "Analisis kustom", group: "custom", groupCode: "KUSTOM", grids: [custom.build()] }),
    section({
      key: "efas",
      label: "EFAS",
      group: "es",
      groupCode: "ES",
      status: "failed",
      statusLabel: "gagal",
      available: false,
      error: "LLM gagal",
      output: null,
    }),
  ];
  return {
    projectName: "BEM Uji",
    orgType: "BEM",
    description: "Organisasi uji untuk tes ekspor.",
    runId: "12345678-aaaa-bbbb-cccc-1234567890ab",
    experimentTag: "utama",
    generatedAt: "2026-10-07T10:00:00.000Z",
    executiveSummary: [{ text: "Organisasi berada di kuadran I.", refs: ["S1"] }],
    executiveStatus: "selesai",
    keyResults: [{ key: "ifas", label: "IFAS", text: "Total IFAS 0,000." }],
    sections,
    unavailable: [{ key: "efas", label: "EFAS", status: "gagal" }],
    trace: { total: 1, complete: 0, broken: [{ id: "SO1", reason: "rujukan tidak ada: S9" }], chains: [{ id: "SO1", kind: "strategy", nodeKey: "swot_matrix", text: "x", path: "SO1 → S9 (tidak ada)", complete: false }] },
    sources: { C1: { source: "notulensi.pdf", kind: "document", content: "Kaderisasi berjalan tiap semester." } },
    questions: [{ label: "U1", nodeKey: "ifas", nodeLabel: "IFAS", question: "Mohon konfirmasi rating S1." }],
    keys: sections.map((s) => s.key),
  };
}

async function reread(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const noteText = (c: ExcelJS.Cell) => {
  const n = c.note as unknown;
  if (!n) return "";
  if (typeof n === "string") return n;
  return ((n as { texts?: { text: string }[] }).texts ?? []).map((t) => t.text).join("");
};

// ---------- Uji ----------

describe("ekspor XLSX grand design", () => {
  it("menulis sheet per grid (nama unik), rumus hidup, placeholder antarsheet, gabungan sel, komentar, dan penanda edit", async () => {
    const buf = await grandDesignXlsx(makeDoc());
    expect(buf.length).toBeGreaterThan(1000);
    const wb = await reread(buf);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(["RINGKASAN", "ESIFAS", "SGSOP", "ESIFAS (2)", "SUMBER", "PEMERIKSAAN"]);

    const ifas = wb.getWorksheet("ESIFAS")!;
    const d4 = ifas.getCell("D4");
    expect(d4.formula).toBe("B4*C4");
    expect((d4.value as ExcelJS.CellFormulaValue).result).toBe(1.2);
    expect(noteText(d4)).toContain("Cara menghitung");
    expect(noteText(d4)).toContain("3 × 0,4");
    expect(ifas.getCell("D6").formula).toBe("SUM(D4:D5)");
    expect(ifas.getCell("B4").numFmt).toBe("0.00");
    // gabungan sel (judul A1:D1 dan "Total" A6:C6)
    expect(ifas.getCell("A1").isMerged).toBe(true);
    expect(ifas.getCell("D1").isMerged).toBe(true);
    expect(ifas.getCell("C6").master.address).toBe("A6");
    // sel diubah manusia: warna jingga + komentar nilai semula
    const b4 = ifas.getCell("B4");
    expect((b4.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFF8CBAD");
    expect(noteText(b4)).toContain("Diubah manusia");
    expect(noteText(b4)).toContain("Semula 2");
    expect(noteText(b4)).toContain("kini 3");
    expect(noteText(b4)).toContain("Alasan AI");
    expect(noteText(b4)).toContain("C1");
    // usulan AI yang belum diubah: kuning muda
    expect((ifas.getCell("B5").fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF2CC");
    // bobot AHP: biru muda
    expect((ifas.getCell("C4").fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFDDEBF7");
    // panel beku
    expect(ifas.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 3 });

    const pos = wb.getWorksheet("SGSOP")!;
    expect(pos.getCell("B2").formula).toBe("'ESIFAS'!D6");
    // EFAS tidak ada di file → nilai saja + catatan
    expect(pos.getCell("B3").formula).toBeUndefined();
    expect(pos.getCell("B3").value).toBe(0.5);
    expect(noteText(pos.getCell("B3"))).toContain("tidak ada di file ini");
    // pemisah ";" dirapikan menjadi ","; warna sel bawaan grid dipertahankan
    expect(pos.getCell("B4").formula).toBe('IF(AND(B2>=0,B3>=0),"I","II")');
    expect((pos.getCell("B4").fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFC6EFCE");
    // data grafik ditulis di bawah tabel
    const texts: string[] = [];
    pos.eachRow((row) => row.eachCell((c) => texts.push(String(c.value))));
    expect(texts.some((t) => t.includes("Data grafik: Posisi"))).toBe(true);

    // RINGKASAN: tautan ke sheet, ringkasan eksekutif, legenda
    const sum = wb.getWorksheet("RINGKASAN")!;
    const all: string[] = [];
    const formulas: string[] = [];
    sum.eachRow((row) =>
      row.eachCell((c) => {
        all.push(typeof c.value === "object" && c.value && "result" in c.value ? String(c.value.result) : String(c.value));
        if (c.formula) formulas.push(c.formula);
      }),
    );
    expect(formulas).toContain(`HYPERLINK("#'ESIFAS'!A1","ESIFAS")`);
    expect(formulas).toContain(`HYPERLINK("#'ESIFAS (2)'!A1","ESIFAS (2)")`);
    expect(all).toContain("Organisasi berada di kuadran I.");
    expect(all.some((t) => t.includes("Diusulkan AI"))).toBe(true);
    expect(all).toContain("gagal");
    expect(all).toContain("1 lolos · 1 gagal");

    // SUMBER dan PEMERIKSAAN
    const src: string[] = [];
    wb.getWorksheet("SUMBER")!.eachRow((row) => row.eachCell((c) => src.push(String(c.value))));
    expect(src).toContain("Kaderisasi berjalan tiap semester.");
    const chk: string[] = [];
    wb.getWorksheet("PEMERIKSAAN")!.eachRow((row) => row.eachCell((c) => chk.push(String(c.value))));
    expect(chk).toContain("CR himpunan S = 0,15 > 0,10.");
    expect(chk).toContain("Mohon konfirmasi rating S1.");
    expect(chk.some((t) => t.includes("Gagal dijalankan: LLM gagal"))).toBe(true);
    expect(chk).toContain("ratings.0.v");
  });

  it("merapikan rumus dan menolak rumus rusak", () => {
    expect(normalizeFormula("=SUM(A1;A2)")).toBe("SUM(A1,A2)");
    expect(normalizeFormula('IF(A1>0;"a;b";"c")')).toBe('IF(A1>0,"a;b","c")');
    expect(normalizeFormula("IFNA(A1,0)+concat(A1,B1)")).toBe("_xlfn.IFNA(A1,0)+_xlfn.CONCAT(A1,B1)");
    expect(normalizeFormula("CONCATENATE(A1,B1)")).toBe("CONCATENATE(A1,B1)");
    expect(normalizeFormula("SUM(A1:A2")).toBeNull();
    expect(normalizeFormula('IF(A1,"x)')).toBeNull();
    expect(normalizeFormula("{{ifas!total}}*2")).toBeNull();
  });

  it("menyelesaikan placeholder antarsheet", () => {
    const index = new Map([["ifas", [{ sheet: "ESIFAS", anchors: { total: "D6" } }]]]);
    expect(resolvePlaceholders("{{ifas!total}}-{{ifas!total}}", index)).toEqual({ formula: "'ESIFAS'!D6-'ESIFAS'!D6", missing: [] });
    expect(resolvePlaceholders("{{efas!total}}", index).missing).toEqual(["{{efas!total}}"]);
  });
});

describe("docToBlocks", () => {
  it("judul, ringkasan eksekutif, bab per kelompok tab Excel, rumus, kustom, lampiran", () => {
    const b = docToBlocks(makeDoc());
    expect(b[0]).toMatchObject({ type: "title", text: "Grand Design BEM Uji" });
    const h1 = b.filter((x) => x.type === "h1").map((x) => (x as { text: string }).text);
    expect(h1).toEqual([
      "1. Ringkasan eksekutif",
      "2. Environmental Scanning (ES)",
      "3. Strategy Generation & Selection (SGS)",
      "4. Analisis tambahan",
      "Lampiran A. Jejak rujukan",
      "Lampiran B. Sumber kutipan",
      "Lampiran C. Catatan galat dan pemeriksaan",
    ]);
    const text = JSON.stringify(b);
    expect(text).toContain("Organisasi berada di kuadran I. [S1]");
    expect(text).toContain("Rumus yang dipakai");
    expect(text).toContain("EFAS belum tersedia (gagal): LLM gagal");
    expect(text).toContain("CR himpunan S = 0,15 > 0,10.");
    expect(text).toContain("1 nilai diubah manusia");
    expect(text).toContain("U1 (IFAS): Mohon konfirmasi rating S1.");
    // tabel ≤ 7 kolom agar muat halaman potret
    for (const x of b) if (x.type === "table") expect(x.head.length).toBeLessThanOrEqual(7);
  });
});

describe("jejak rujukan node baru", () => {
  const ev = [{ chunkId: "C1", quote: "kutipan dokumen yang cukup panjang" }];
  const outputs = {
    faktor_internal: { factors: [{ id: "S1", quadrant: "S", text: "Kaderisasi", evidence: ev }, { id: "W1", quadrant: "W", text: "Lambat", evidence: [] }] },
    faktor_eksternal: { factors: [{ id: "O1", quadrant: "O", text: "Hibah", evidence: ev }] },
    swot_matrix: {
      strategies: [
        { id: "SO1", type: "SO", factorRefs: ["S1", "O1"], text: "Strategi SO" },
        { id: "WO1", type: "WO", factorRefs: ["W1", "O1"], text: "Strategi WO" },
      ],
    },
    cascading: {
      visi: "Visi",
      aspects: [
        {
          id: "A1",
          aspek: "Kaderisasi",
          misi: "Misi 1",
          objectives: [
            { id: "SO1", text: "Sasaran yang ID-nya sama dengan strategi", initiatives: [{ id: "SI1.1", text: "Inisiatif", strategyRef: "SO1" }] },
            { id: "SO2", text: "Sasaran tanpa rujukan strategi", initiatives: [{ id: "SI2.1", text: "x", strategyRef: null }] },
          ],
        },
      ],
    },
    renstra: { years: [{ tahun: 1, fokus: "f", milestones: [{ id: "M1", text: "m", misiRef: "A1", arah: [{ id: "AK1", text: "a", indikator: "i", target: "t" }] }] }] },
    risk_management: { risks: [{ id: "R1", text: "Risiko", refs: ["SO1"] }, { id: "R2", text: "Risiko tanpa dasar", refs: ["X9"] }] },
    decision_making: { decisions: [{ id: "D1", keputusan: "Putuskan", conditions: [{ id: "K1", kondisi: "Kondisi", evidence: ev }] }] },
  };

  it("SI → strategi → faktor → kutipan; ID ganda antar-analisis tidak tertukar", () => {
    const idx = buildTraceIndex(outputs);
    expect(idx.get("SO1")?.kind).toBe("strategy");
    expect(idx.get("SO1@cascading")?.kind).toBe("objective");
    expect(idx.get("SI1.1")?.refs).toEqual(["SO1"]);
    const t = checkTraceComplete(outputs);
    const broken = Object.fromEntries(t.broken.map((b) => [b.id, b.reason]));
    expect(broken["SO1"]).toBeUndefined(); // strategi SO1 lengkap
    expect(broken["WO1"]).toContain("rantai rujukan"); // W1 tanpa bukti
    expect(broken["SI2.1"]).toContain("tidak merujuk strategi");
    expect(broken["SO2"]).toBeDefined();
    expect(broken["A1"]).toBeDefined(); // misi ikut terputus karena SO2
    expect(broken["R2"]).toContain("rujukan tidak ada: X9");
    expect(broken["R1"]).toBeUndefined();
    expect(broken["D1"]).toBeUndefined(); // keputusan → kondisi berbukti
    expect(broken["AK1"]).toBeDefined(); // arah → milestone → misi A1 (terputus)
    const chain = traceChains(outputs).find((c) => c.id === "SI1.1")!;
    expect(chain.path).toBe("SI1.1 → SO1 → (S1 [C1] | O1 [C1])");
    expect(chain.complete).toBe(true);
  });

  it("toleran terhadap output kosong/aneh", () => {
    expect(checkTraceComplete({ cascading: { aspects: "x" }, swot_matrix: null, risk_management: 5 })).toEqual({ total: 0, complete: 0, broken: [] });
  });

  it("rujukan ringkasan eksekutif harus ada", () => {
    const valid = validElementIds(outputs, ["POS"]);
    const r = validateSummaryRefs([{ text: "a", refs: ["SO1", "POS"] }, { text: "b", refs: ["ZZ9"] }], valid);
    expect(r.failures.map((f) => f.itemId)).toEqual(["K2"]);
  });

  it("kutipan dikumpulkan dari evidence dan refs berlabel C/U", () => {
    expect([...collectCitations({ a: [{ evidence: [{ chunkId: "C3", quote: "q" }] }], b: { refs: ["U2", "S1"] } })].sort()).toEqual(["C3", "U2"]);
  });
});

describe("laporan kajian (PDF)", () => {
  it("sampul, BAB I–IV, daftar pustaka, lampiran; analisis memakai sheet Excel; bagian yang tidak ada tidak muncul", () => {
    const { blocks, toc } = docToReport(makeDoc());
    const titles = toc.map((e) => e.text);
    expect(blocks[0].type).toBe("cover");
    expect(titles.filter((x) => x.startsWith("BAB "))).toEqual(["BAB I PENDAHULUAN", "BAB II ANALISIS BEM UJI", "BAB III PEMBAHASAN DAN REKOMENDASI", "BAB IV KESIMPULAN"]);
    expect(titles).toContain("DAFTAR PUSTAKA");
    expect(titles).toContain("LAMPIRAN");
    // IFAS tersedia → subbab dengan tabel ala sheet Excel (bukan tabel ringkas) dan judul tabel bernomor
    expect(titles).toContain("2.2.1 IFAS");
    const i = blocks.findIndex((b) => b.type === "h3" && b.text === "2.2.1 IFAS");
    const after = blocks.slice(i, i + 6);
    expect(after.some((b) => b.type === "grid" && b.grid.id === "ifas")).toBe(true);
    expect(after.some((b) => b.type === "caption" && /^Tabel 2\.\d+ Matriks IFAS/.test(b.text))).toBe(true);
    // EFAS gagal → tidak dimunculkan sama sekali
    expect(titles.some((x) => x.includes("EFAS"))).toBe(false);
    // Referensi metode hanya untuk analisis yang ada (QSPM tidak ada → David tidak dicantumkan; posisi ada → Weihrich ada)
    const refs = blocks.filter((b) => b.type === "bullets").flatMap((b) => b.items).join(" ");
    expect(refs).toContain("Weihrich");
    expect(refs).not.toContain("David, F. R.");
  });

  it("format sel seperti Excel dan judul huruf kapital dirapikan", () => {
    expect(cellText({ r: 0, c: 0, v: 0.2838, fmt: "0.000" })).toBe("0,284");
    expect(cellText({ r: 0, c: 0, v: 0.125, fmt: "0.0%" })).toBe("12,5%");
    expect(cellText({ r: 0, c: 0, v: 3, style: "int" })).toBe("3");
    expect(cellText({ r: 0, c: 0, v: 0.3333, display: "1/3" })).toBe("1/3");
    expect(cellText({ r: 0, c: 0, v: null })).toBe("");
    expect(titleCase("KONDISI IDEAL ORGANISASI")).toBe("Kondisi Ideal Organisasi");
    expect(titleCase("IFAS")).toBe("Ifas");
    expect(titleCase("Gap analysis")).toBe("Gap analysis");
  });
});
