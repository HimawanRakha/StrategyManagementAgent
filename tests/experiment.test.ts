import { describe, expect, it } from "vitest";
import { cohenKappa } from "@/lib/experiment/kappa";
import { wilson } from "@/lib/experiment/wilson";
import { estimateE } from "@/lib/experiment/estimate";
import { predictMarkov, predictP, type Stage } from "@/lib/experiment/propagation";
import { optimize, optimizeDP, OPTIONS } from "@/lib/experiment/optimize";
import { seededRng, simulateP } from "@/lib/experiment/simulate";
import { INJECTORS, fakeId, inject, injectorsFor, pathText } from "@/lib/experiment/injectors";
import { qspmRankIds } from "@/lib/experiment/stability";
import { agentFactors, compareGold } from "@/lib/experiment/gold";
import { ahp } from "@/lib/calc/ahp";
import { Graph, defaultGraph } from "@/lib/engine/graph";
import { templateGraph } from "@/lib/engine/canvas";
import type { EvidenceChunk } from "@/lib/db/schema";
import {
  bestPlacement,
  buildConclusion,
  collectFindings,
  placementToApply,
  runModel,
  stageDefault,
  summarize,
  type ParamsApi,
  type ReportProjectData,
} from "@/components/canvas/report-utils";
import { ASSUMED } from "@/lib/experiment/assumptions";

// Parameter contoh dari brief (dipasang ke kunci node baru)
const STAGES: Stage[] = [
  { key: "swot_matrix", e: 0.2, dr: 0.6, cTok: 3000, cMin: 8 },
  { key: "qspm", e: 0.06, dr: 0.5, cTok: 1500, cMin: 3 },
  { key: "cascading", e: 0.13, dr: 0.8, cTok: 2500, cMin: 6 },
];
const none = { validator: false, human: false };

describe("Cohen's kappa", () => {
  it("kesepakatan sempurna = 1", () => expect(cohenKappa([true, false, true], [true, false, true])).toBe(1));
  it("contoh hitung manual", () => {
    // po = 0.8, pa = 0.6, pb = 0.4, pe = 0.24 + 0.24 = 0.48 → (0.8-0.48)/(0.52)
    const a = [true, true, true, false, false];
    const b = [true, true, false, false, false];
    expect(cohenKappa(a, b)).toBeCloseTo((0.8 - 0.48) / 0.52, 10);
  });
});

describe("Interval Wilson", () => {
  it("e = 4/20 = 0,20 memiliki interval sekitar 0,08–0,42", () => {
    const w = wilson(4, 20);
    expect(w.p).toBe(0.2);
    expect(w.lo).toBeCloseTo(0.081, 2);
    expect(w.hi).toBeCloseTo(0.416, 2);
  });
  it("n = 0 tidak meledak", () => expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1, n: 0 }));
});

describe("Estimasi e_i hanya dari run dengan input benar", () => {
  it("contoh brief: e_swot = 4/20, e_qspm = 1/16, e_cascading = 2/15", () => {
    const v: Record<string, Record<string, { own: boolean; carried: boolean }>> = {};
    for (let i = 0; i < 20; i++) {
      const swotErr = i < 4;
      const qspmErr = !swotErr && i === 4;
      const casErr = !swotErr && !qspmErr && (i === 5 || i === 6);
      v[`r${i}`] = {
        swot_matrix: { own: swotErr, carried: false },
        qspm: { own: qspmErr, carried: swotErr },
        cascading: { own: casErr, carried: swotErr || qspmErr },
      };
    }
    expect(estimateE(v, "swot_matrix", [])).toMatchObject({ e: 0.2, n: 20 });
    expect(estimateE(v, "qspm", ["swot_matrix"])).toMatchObject({ k: 1, n: 16 });
    expect(estimateE(v, "cascading", ["swot_matrix", "qspm"])).toMatchObject({ k: 2, n: 15 });
  });
});

describe("Model propagasi dan optimasi", () => {
  it("tanpa cek P = 0,654", () => {
    expect(predictP(STAGES, { swot_matrix: none, qspm: none, cascading: none }, 0.85)).toBeCloseTo(0.654, 3);
  });
  it("validator cascading + manusia SWOT = 0,888 (baris terbaik di brief)", () => {
    const place = { swot_matrix: { validator: false, human: true }, qspm: none, cascading: { validator: true, human: false } };
    expect(predictP(STAGES, place, 0.85)).toBeCloseTo(0.888, 3);
  });
  it("optimize memilih penempatan terbaik dalam anggaran 3.000 token dan 8 menit", () => {
    const best = optimize(STAGES, 0.85, 3000, 8);
    expect(best.p).toBeCloseTo(0.888, 3);
    expect(best.place.swot_matrix).toEqual({ validator: false, human: true });
    expect(best.place.cascading).toEqual({ validator: true, human: false });
  });
  it("optimizeDP = optimize (uji kebenaran DP) untuk banyak anggaran", () => {
    for (const tok of [0, 1500, 3000, 4000, 5500, 7000])
      for (const min of [0, 3, 6, 8, 11, 17]) {
        const a = optimize(STAGES, 0.85, tok, min);
        const b = optimizeDP(STAGES, 0.85, tok, min, 500);
        expect(b.p).toBeCloseTo(a.p, 10);
      }
  });
  it("optimizeDP pada 6 node acak cocok dengan brute force", () => {
    const rng = seededRng(7);
    const stages: Stage[] = Array.from({ length: 6 }, (_, i) => ({
      key: `n${i}`, e: rng() * 0.3, dr: rng(), cTok: 500 * (1 + Math.floor(rng() * 6)), cMin: 1 + Math.floor(rng() * 8),
    }));
    for (const [tok, min] of [[0, 0], [3000, 10], [6000, 20], [10000, 40]]) {
      expect(optimizeDP(stages, 0.85, tok, min).p).toBeCloseTo(optimize(stages, 0.85, tok, min).p, 10);
    }
  });
  it("optimize memecah seri ke pilihan termurah (tahap tanpa galat tidak diberi pemeriksaan)", () => {
    const st: Stage[] = [
      { key: "a", e: 0, dr: 0.6, cTok: 100, cMin: 1 },
      { key: "b", e: 0.2, dr: 0.6, cTok: 100, cMin: 1 },
    ];
    const r = optimize(st, 0.85, 1000, 10);
    expect(r.place.a).toEqual(none);
    expect(r.place.b).toEqual({ validator: true, human: true });
  });
  it("predictMarkov dengan semua h = 0 sama dengan predictP", () => {
    const place = { swot_matrix: OPTIONS[1], qspm: OPTIONS[2], cascading: OPTIONS[3] };
    expect(predictMarkov(STAGES.map((s) => ({ ...s, h: 0 })), place, 0.85)).toBeCloseTo(predictP(STAGES, place, 0.85), 12);
  });
});

describe("Simulasi Monte Carlo", () => {
  it("dengan h = 0 hasil simulasi mendekati rumus perkalian pada graf bercabang lengkap", () => {
    const g = new Graph(defaultGraph("full"));
    const par = Object.fromEntries(g.keys.map((k, i) => [k, { e: 0.02 + (i % 4) * 0.01, h: 0 }]));
    const product = g.keys.reduce((p, k) => p * (1 - par[k].e), 1);
    const sim = simulateP(g, par, 200_000, undefined, seededRng(1));
    expect(Math.abs(sim - product)).toBeLessThan(0.006);
  });
});

// ---------------------------------------------------------------------------------------------
// Penyuntik galat generik

const chunk = (id: string, content: string): EvidenceChunk => ({ id, content, source: "dok.txt", kind: "document" });
const EVIDENCE: EvidenceChunk[] = [
  chunk("C1", "Rapat evaluasi dihadiri tiga puluh anggota aktif. Program kerja pelatihan berjalan rutin setiap bulan."),
  chunk("C2", "Kampus menyediakan dana kegiatan untuk himpunan setiap semester. Aturan baru membatasi kegiatan malam hari."),
];

/** Output palsu dengan semua pola yang dikenali penyuntik (bentuknya sengaja tidak sama dengan node mana pun). */
const FAKE = {
  factors: [
    { id: "S1", text: "Pelatihan rutin anggota", evidence: [{ chunkId: "C1", quote: "Program kerja pelatihan berjalan rutin setiap bulan." }] },
    { id: "O1", text: "Dana kegiatan dari kampus", evidence: [{ chunkId: "C2", quote: "Kampus menyediakan dana kegiatan untuk himpunan setiap semester." }] },
  ],
  strategies: [{ id: "SO1", factorRefs: ["S1", "O1"], text: "Memakai dana kampus untuk memperluas pelatihan" }],
  ratings: [
    { id: "S1", rating: 3 },
    { id: "O1", rating: 4 },
  ],
  ahp: [
    {
      id: "S",
      items: ["S1", "S2", "S3"],
      pairs: [
        { a: "S1", b: "S2", v: 3 },
        { a: "S1", b: "S3", v: 5 },
        { a: "S2", b: "S3", v: 2 },
      ],
    },
  ],
};

describe("Penyuntik galat generik", () => {
  it("semua penyuntik berlaku pada output palsu, tidak ada yang berlaku pada output kosong", () => {
    expect(injectorsFor(FAKE).map((i) => i.type).sort()).toEqual(INJECTORS.map((i) => i.type).sort());
    expect(injectorsFor({ items: [] })).toEqual([]);
    expect(injectorsFor(undefined).length).toBe(INJECTORS.length);
  });

  it("utilitas: pathText dan fakeId", () => {
    expect(pathText(["factors", 2, "evidence", 0, "quote"])).toBe("factors[2].evidence[0].quote");
    expect(fakeId("S2", new Set(["S2", "S99"]))).toBe("S98");
    expect(fakeId("risk", new Set())).toBe("risk99");
  });

  it("(a) kutipan ditukar: kutipan baru tidak ada di potongannya; asli = sudah diperbaiki", () => {
    const inj = inject("faktor_internal", "swapped_quote", FAKE, EVIDENCE, 0)!;
    expect(inj).not.toBeNull();
    const out = inj.injected as typeof FAKE;
    const ev = out.factors[0].evidence[0];
    expect(inj.location).toBe("factors[0].evidence[0].quote");
    expect(inj.itemId).toBe("S1");
    expect(EVIDENCE[0].content.toLowerCase()).not.toContain(ev.quote.toLowerCase());
    expect(FAKE.factors[0].evidence[0].quote).toContain("Program kerja"); // input tidak diubah
    expect(inj.matches({ itemId: "S1", message: "kutipan tidak ditemukan" })).toBe(true);
    expect(inj.matches({ itemId: "O1", message: "lain" })).toBe(false);
    expect(inj.isRepaired(inj.injected)).toBe(false);
    expect(inj.isRepaired(FAKE)).toBe(true);
  });

  it("(b) rujukan rusak: ID palsu tidak ada di output, terdeteksi lewat pesan", () => {
    const inj = inject("swot_matrix", "invalid_ref", FAKE, EVIDENCE, 1)!;
    const out = inj.injected as typeof FAKE;
    expect(inj.location).toBe("strategies[0].factorRefs[1]");
    expect(out.strategies[0].factorRefs[1]).toBe("O99");
    expect(inj.itemId).toBe("SO1");
    expect(inj.matches({ itemId: "X", message: "SO1 merujuk faktor yang tidak ada: O99." })).toBe(true);
    expect(inj.isRepaired(inj.injected)).toBe(false);
    expect(inj.isRepaired(FAKE)).toBe(true);
  });

  it("(c) angka di luar rentang: rating jauh di atas skala", () => {
    const inj = inject("ifas", "out_of_range", FAKE, EVIDENCE, 0)!;
    const out = inj.injected as typeof FAKE;
    expect(inj.location).toBe("ratings[0].rating");
    expect(out.ratings[0].rating).toBe(13); // maks skala 4 → 4×3+1
    expect(inj.matches({ itemId: "S1", message: "rating di luar 1–4" })).toBe(true);
    expect(inj.isRepaired(inj.injected)).toBe(false);
    expect(inj.isRepaired(FAKE)).toBe(true);
  });

  it("(d) AHP tidak konsisten: CR > 0,10 setelah disuntik", () => {
    const set = FAKE.ahp[0];
    expect(ahp(set.items, set.pairs).consistent).toBe(true);
    const inj = inject("faktor_internal", "ahp_inconsistent", FAKE, EVIDENCE, 0)!;
    const out = inj.injected as typeof FAKE;
    expect(ahp(out.ahp[0].items, out.ahp[0].pairs).consistent).toBe(false);
    expect(inj.itemId).toBe("S");
    expect(inj.location).toMatch(/^ahp\[0\]\.pairs\[\d\]\.v$/);
    expect(inj.matches({ check: "ahp_consistency", itemId: "S", message: "AHP S tidak konsisten" })).toBe(true);
    expect(inj.isRepaired(inj.injected)).toBe(false);
    expect(inj.isRepaired(FAKE)).toBe(true);
  });

  it("(e) butir karangan: salinan dengan ID baru, teks dan kutipan yang tidak didukung", () => {
    const inj = inject("faktor_internal", "fabricated_item", FAKE, EVIDENCE, 0)!;
    const out = inj.injected as typeof FAKE;
    expect(out.factors).toHaveLength(3);
    expect(out.factors[1].id).toBe("S99");
    expect(out.factors[1].text).toMatch(/dana hibah/);
    expect(inj.itemId).toBe("S99");
    expect(inj.matches({ itemId: "S99", message: "kutipan tidak ditemukan" })).toBe(true);
    expect(inj.isRepaired(inj.injected)).toBe(false);
    expect(inj.isRepaired(FAKE)).toBe(true);
  });

  it("deterministik untuk seed yang sama dan tidak berlaku bila pola tidak ada", () => {
    for (const t of INJECTORS.map((i) => i.type)) {
      const a = inject("x", t, FAKE, EVIDENCE, 5);
      const b = inject("x", t, FAKE, EVIDENCE, 5);
      expect(JSON.stringify(a?.injected)).toBe(JSON.stringify(b?.injected));
      expect(inject("x", t, { items: [] }, EVIDENCE, 5)).toBeNull();
    }
    expect(() => inject("x", "tidak_ada", FAKE, EVIDENCE, 0)).toThrow();
  });
});

describe("Stabilitas QSPM dan kunci jawaban", () => {
  it("qspmRankIds membaca ranking[] baru (urut rank) dan totals[] lama", () => {
    expect(qspmRankIds({ ranking: [{ id: "WO1", rank: 2 }, { id: "SO1", rank: 1 }, { id: "ST1", rank: 3 }] })).toEqual(["SO1", "WO1", "ST1"]);
    expect(qspmRankIds({ totals: [{ strategyId: "B", rank: 2 }, { strategyId: "A", rank: 1 }] })).toEqual(["A", "B"]);
    expect(qspmRankIds(null)).toEqual([]);
  });
  it("compareGold mencocokkan faktor agen dari faktor_internal + faktor_eksternal", () => {
    const agent = agentFactors({
      faktor_internal: { factors: [{ id: "S1", quadrant: "S", text: "Pelatihan rutin anggota setiap bulan" }] },
      faktor_eksternal: { factors: [{ id: "T1", quadrant: "T", text: "Aturan kampus membatasi kegiatan malam" }] },
    });
    const r = compareGold(
      [
        { id: "S1", quadrant: "S", text: "Pelatihan anggota rutin" },
        { id: "O1", quadrant: "O", text: "Aturan kampus membatasi kegiatan malam" },
      ],
      agent,
    );
    expect(r.matches[0].match?.id).toBe("S1");
    expect(r.matches[1].match).toBeNull();
    expect(r.matches[1].otherQuadrant?.id).toBe("T1");
    expect(r.recall).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------------------------
// Laporan canvas

describe("Laporan: angka model, optimasi, galat, kesimpulan", () => {
  const graph = templateGraph("mvp");

  it("angka model tidak bergantung pada run/penempatan: terukur bila n cukup, selain itu asumsi", () => {
    const params: ParamsApi = {
      dh: 0.9,
      stages: [{ key: "qspm", e: { p: 0.1, n: 12 }, d: { n: 2 }, dr: 0.9, cTok: 2000, cTokN: 4, cMin: 0, cMinN: 0 }],
    };
    const d = stageDefault("qspm", params);
    expect(d.e).toEqual({ value: 0.1, src: { kind: "terukur", n: 12 } });
    expect(d.cMin.value).toBe(ASSUMED.cMin);
    expect(d.cMin.src.kind).toBe("asumsi");
    const none2 = stageDefault("cascading", null);
    expect(none2.e.value).toBe(ASSUMED.e);
    expect(none2.e.src.kind).toBe("asumsi");
  });

  it("bestPlacement 22 analisis: cepat, muat anggaran, dan hasilnya sama bila diulang", () => {
    const st: Stage[] = Array.from({ length: 22 }, (_, i) => ({ key: `custom_${i}`, e: 0.05 + (i % 5) * 0.03, dr: 0.6, cTok: 1500 + (i % 3) * 200, cMin: 5 }));
    const t0 = Date.now();
    const a = bestPlacement(st, 0.85, 6000, 20);
    const b = bestPlacement(st, 0.85, 6000, 20);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(JSON.stringify(a.place)).toBe(JSON.stringify(b.place));
    const tok = st.reduce((s, x) => s + (a.place[x.key].validator ? x.cTok : 0), 0);
    const min = st.reduce((s, x) => s + (a.place[x.key].human ? x.cMin : 0), 0);
    expect(tok).toBeLessThanOrEqual(6000);
    expect(min).toBeLessThanOrEqual(20);
    expect(a.method).toBe("dp");
  });

  it("rekomendasi tetap sama setelah diterapkan (titik tetap)", () => {
    const st: Stage[] = STAGES.map((s) => ({ ...s, key: `custom_${s.key}` }));
    const r1 = runModel(st, 0.85, 3000, 8, {});
    const r2 = runModel(st, 0.85, 3000, 8, r1.rec);
    expect(r2.rec).toEqual(r1.rec);
    expect(r2.pCur).toBeCloseTo(r1.pRec, 12);
    expect(Object.keys(placementToApply(r1)).length).toBeGreaterThan(0);
    expect(placementToApply(r2)).toEqual({}); // setelah diterapkan tidak ada lagi yang diubah
  });

  it("galat & temuan: cek gagal, diperbaiki otomatis, AHP, ditolak, pertanyaan, diubah, usang; kesimpulan deterministik", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 8, m)).toISOString();
    const base = { validatorEnabled: true, humanEnabled: false, error: null, attempts: 1, formatFailures: 0, tokens: { generate: 1000 }, review: null };
    const data: ReportProjectData = {
      runId: "r1",
      questions: [{ id: "q1", nodeKey: "qspm", question: "Berapa anggaran himpunan?", answer: null }],
      nodes: {
        faktor_internal: {
          ...base,
          status: "done",
          validationPassed: false,
          startedAt: t(0),
          finishedAt: t(1),
          editedAt: t(30),
          edits: [{ path: ["ahp", 0, "pairs", 0, "v"], from: 3, to: 5, at: t(30) }],
          validation: [
            { attempt: 0, checkName: "quote_exists", passed: false, detail: { kind: "code", failures: [{ itemId: "S2", message: "Kutipan S2 tidak ditemukan di C3." }] } },
            { attempt: 0, checkName: "ahp_consistency", passed: false, detail: { kind: "code", failures: [{ itemId: "S", message: "AHP S tidak konsisten: CR = 0,2" }] } },
            { attempt: 1, checkName: "quote_exists", passed: true, detail: { kind: "code", failures: [] } },
            { attempt: 1, checkName: "ahp_consistency", passed: false, detail: { kind: "code", failures: [{ itemId: "S", message: "AHP S tidak konsisten: CR = 0,15" }] } },
          ],
        },
        faktor_eksternal: { ...base, status: "failed", validationPassed: null, startedAt: t(0), finishedAt: t(1), error: "LLM tidak menjawab", validation: [] },
        swot_matrix: { ...base, status: "done", validationPassed: true, startedAt: t(2), finishedAt: t(3), validation: [], review: { startedAt: t(3), endedAt: t(8), approved: false } },
      },
    };
    const f = collectFindings(graph, data);
    const g = (k: string) => f.groups.find((x) => x.key === k)!;
    const kinds = (k: string) => g(k).findings.map((x) => x.kind);
    expect(kinds("faktor_internal")).toEqual(expect.arrayContaining(["ahp_tidak_konsisten", "diperbaiki", "diubah"]));
    expect(g("faktor_internal").findings.find((x) => x.kind === "ahp_tidak_konsisten")!.messages[0].text).toContain("0,15");
    expect(g("faktor_internal").findings.find((x) => x.kind === "diperbaiki")!.messages[0].itemId).toBe("S2");
    expect(kinds("faktor_eksternal")).toContain("gagal");
    expect(kinds("swot_matrix")).toEqual(expect.arrayContaining(["tinjauan_ditolak", "usang"]));
    expect(kinds("qspm")).toEqual(expect.arrayContaining(["belum_jalan", "pertanyaan"]));
    expect(f.totals.berat).toBe(3);

    const summary = summarize(graph, data);
    const c1 = buildConclusion({ summary, findings: f, model: null, changes: [], assumedCount: 0, numberCount: 0, labelOf: (k) => k });
    const c2 = buildConclusion({ summary, findings: f, model: null, changes: [], assumedCount: 0, numberCount: 0, labelOf: (k) => k });
    expect(c1).toEqual(c2);
    expect(c1.verdict.tone).toBe("danger");
    expect(c1.attention[0].severity).toBe("berat");
    expect(c1.nextSteps.join(" ")).toMatch(/AHP/);
  });
});
