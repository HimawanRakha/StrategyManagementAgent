import { describe, expect, it } from "vitest";
import { CHUNK_DEFAULT, chunkText, paragraphsOf } from "@/lib/rag/chunk";
import { assessDocument, textFingerprint } from "@/lib/rag/quality";
import { coreMemory, MEMORY_MAX_CHARS } from "@/lib/engine/memory";
import { FRAMEWORK_TEMPLATES, nextSteps } from "@/components/canvas/next-steps";
import { templateGraph } from "@/lib/engine/canvas";
import type { ReportProjectData } from "@/components/canvas/report-utils";

const para = (n: number, len = 300) => Array.from({ length: n }, (_, i) => `Paragraf ${i + 1}. ` + "Kegiatan kaderisasi berjalan baik. ".repeat(Math.ceil(len / 36))).join("\n\n");

describe("chunk: ukuran dan tumpang-tindih bisa diatur", () => {
  it("bawaan tetap 800/100; potongan lebih kecil menghasilkan lebih banyak potongan; paragraf tidak terbelah", () => {
    const text = para(10);
    expect(CHUNK_DEFAULT).toEqual({ target: 800, overlap: 100 });
    expect(chunkText(text)).toEqual(chunkText(text, { target: 800, overlap: 100 }));
    const small = chunkText(text, { target: 400, overlap: 0 });
    const big = chunkText(text, { target: 1200, overlap: 0 });
    expect(small.length).toBeGreaterThan(big.length);
    expect(paragraphsOf(text)).toHaveLength(10);
    // tanpa tumpang-tindih: isi potongan tidak diawali ekor potongan sebelumnya
    expect(small[1].content.startsWith("Paragraf")).toBe(true);
  });
});

describe("tinjauan dokumen: pemeriksaan kualitas otomatis", () => {
  it("dokumen normal tanpa peringatan; pendek, simbol, karakter rusak, tabel, dan duplikat terdeteksi", () => {
    const ok = para(4);
    expect(assessDocument(ok, chunkText(ok)).warnings).toEqual([]);
    const codes = (t: string, ex: { filename: string; fingerprint: string }[] = []) => (assessDocument(t, chunkText(t), ex).warnings ?? []).map((w) => w.code);
    expect(codes("Rapat singkat.")).toContain("pendek");
    expect(codes("12 | 34 | 56 | 78 | 90\n".repeat(40))).toEqual(expect.arrayContaining(["simbol", "tabel"]));
    expect(codes(ok + " \uFFFD")).toContain("karakter_rusak");
    expect(codes(ok, [{ filename: "lama.txt", fingerprint: textFingerprint(ok.toUpperCase()) }])).toContain("duplikat");
  });
});

describe("memori inti organisasi (context engineering)", () => {
  const inputs = {
    posisi_organisasi: { x: -1.2, y: 0.3, kuadran: "III", strategi: "Turnaround", fokus: "WO" },
    qspm: { ranking: [{ id: "WO1", type: "WO", text: "Perbaiki dokumentasi kegiatan", tas: 5.1, rank: 1 }] },
    faktor_internal: { factors: [{ id: "W1", quadrant: "W", text: "Dokumentasi lemah", bobot: 0.3 }, { id: "S1", quadrant: "S", text: "Kaderisasi rutin", bobot: 0.4 }] },
    cascading: { visi: "BEM yang berdampak", aspects: [{ misi: "Menguatkan tata kelola" }] },
  };
  const ctx = { projectName: "BEM Uji", orgType: "BEM", description: "Organisasi uji.", inputs };
  it("memuat profil, visi–misi, posisi, strategi prioritas, dan kelemahan utama; bukan hasil analisis itu sendiri", () => {
    const m = coreMemory(ctx, "msdm_attraction")!;
    expect(m).toContain("MEMORI INTI ORGANISASI — BEM Uji");
    expect(m).toContain("Kuadran III");
    expect(m).toContain("WO1 Perbaiki dokumentasi kegiatan");
    expect(m).toContain("W1 Dokumentasi lemah");
    expect(m).not.toContain("S1 Kaderisasi");
    expect(m).toContain("Visi: BEM yang berdampak");
    expect(coreMemory(ctx, "cascading")).not.toContain("Visi:");
    expect(m.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
  });
  it("tanpa hasil apa pun dan tanpa profil → tidak ada memori", () => {
    expect(coreMemory({ projectName: "X", orgType: null, inputs: {} }, "stakeholder_internal")).toBeNull();
  });
});

describe("saran langkah berikutnya", () => {
  const graph = templateGraph("mvp");
  const data: ReportProjectData = {
    runId: "r1",
    nodes: {
      swot_matrix: { status: "done", validationPassed: null, validatorEnabled: false, humanEnabled: false, error: null, attempts: 1, formatFailures: 0, startedAt: "2026-10-01T08:00:00Z", finishedAt: "2026-10-01T08:05:00Z", tokens: {}, validation: [], review: null, evidence: [{ id: "C1", similarity: 0.4 }, { id: "C2", similarity: 0.45 }] },
    },
    questions: [],
    documents: [
      { filename: "notulensi baru.txt", reviewed_at: null },
      { filename: "lpj.txt", reviewed_at: "2026-10-02T08:00:00Z" },
    ],
  };
  it("dokumen belum ditinjau didahulukan; analisis lebih lama dari dokumen disarankan diulang; bukti lemah; analisis dan proses kustom baru", () => {
    const s = nextSteps(graph, data);
    expect(s[0].id).toBe("dokumen-tinjau");
    expect(s.find((x) => x.id === "ulang-dokumen")?.detail).toContain("Matriks SWOT");
    expect(s.find((x) => x.id === "bukti-swot_matrix")?.action).toEqual({ type: "select", key: "swot_matrix" });
    expect(s.some((x) => x.kind === "analisis" && x.action?.type === "addBuiltin")).toBe(true);
    const kpi = s.find((x) => x.id === "kustom-kpi")!;
    expect(kpi.action).toMatchObject({ type: "addCustom", name: FRAMEWORK_TEMPLATES.find((t) => t.id === "kpi")!.name });
    expect(s.map((x) => x.priority)).toEqual([...s.map((x) => x.priority)].sort());
  });
});

describe("pencarian hybrid (Reciprocal Rank Fusion)", () => {
  it("potongan yang tinggi di kedua daftar naik ke atas; yang hanya ada di satu daftar tetap ikut", async () => {
    const { rrf } = await import("@/lib/rag/rrf");
    expect(rrf([["C1", "C2", "C3"], ["C3", "C1", "C9"]])).toEqual(["C1", "C3", "C2", "C9"]);
    expect(rrf([["C1"], []])).toEqual(["C1"]);
  });
});
