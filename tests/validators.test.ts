import { describe, expect, it } from "vitest";
import { checkQuotes, isMeasurable } from "@/lib/validators/common";
import { chunkText } from "@/lib/rag/chunk";
import { validateGraph, defaultGraph } from "@/lib/engine/graph";
import type { EvidenceChunk } from "@/lib/db/schema";

describe("quote_exists", () => {
  const evidence: EvidenceChunk[] = [
    { id: "C1", content: "Program  riset rutin\nberjalan setiap dua minggu.", source: "lpj.txt", kind: "document" },
    { id: "C2", content: "Kendala: Regenerasi staf lambat.", source: "lpj.txt", kind: "document" },
  ];
  it("normalisasi spasi dan huruf besar; menolak potongan yang tidak ada", () => {
    const r = checkQuotes(
      [
        { id: "S1", evidence: [{ chunkId: "C1", quote: "Program riset rutin berjalan" }] },
        { id: "W1", evidence: [{ chunkId: "C2", quote: "regenerasi staf lambat" }] },
        { id: "O1", evidence: [{ chunkId: "C3", quote: "program hibah kegiatan" }] },
      ],
      evidence,
    );
    expect(r.failures.map((f) => f.itemId)).toEqual(["O1"]);
  });
});

describe("measurable", () => {
  it.each([["80% staf lulus pelatihan", true], ["minimal tiga kegiatan", true], ["meningkatkan kualitas", false]])("%s → %s", (s, ok) =>
    expect(isMeasurable(s)).toBe(ok),
  );
});

describe("chunking", () => {
  it("memecah teks panjang ~800 karakter dan mempertahankan batas paragraf", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Poin ${i + 1}. ` + "Kegiatan organisasi berjalan baik dan terdokumentasi. ".repeat(3));
    const chunks = chunkText(paras.join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1000);
    // setiap poin muncul utuh di minimal satu potongan
    for (const p of paras) expect(chunks.some((c) => c.content.includes(p.trim()))).toBe(true);
  });
});

describe("validasi graf", () => {
  it("graf bawaan valid", () => {
    expect(validateGraph(defaultGraph("mvp"))).toEqual([]);
    expect(validateGraph(defaultGraph("full"))).toEqual([]);
  });
  it("menolak node tanpa dependensi", () => {
    const errs = validateGraph({ nodes: [{ id: "qspm", type: "process", key: "qspm" }], edges: [] });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("canvas", () => {
  it("dependensi wajib tetap berlaku walau panah belum digambar", async () => {
    const { engineGraph, canvasWarnings, templateGraph, upstreamProcesses } = await import("@/lib/engine/canvas");
    const canvas = {
      nodes: [
        { id: "in-1", type: "input" as const, label: "Notulensi" },
        { id: "fi", type: "process" as const, key: "faktor_internal" },
        { id: "fe", type: "process" as const, key: "faktor_eksternal" },
        { id: "sm", type: "process" as const, key: "swot_matrix" },
        { id: "o", type: "output" as const },
      ],
      edges: [{ from: "sm", to: "o" }], // panah tidak lengkap
    };
    const eg = engineGraph(canvas);
    expect(eg.nodes.map((n) => n.key)).toEqual(["faktor_internal", "faktor_eksternal", "swot_matrix", "grand_design"]);
    expect(eg.edges).toContainEqual({ from: "faktor_internal", to: "swot_matrix" });
    expect(canvasWarnings(canvas)).toEqual([]);
    expect(upstreamProcesses(canvas, "o").sort()).toEqual(["faktor_eksternal", "faktor_internal", "swot_matrix"]);
    expect(canvasWarnings({ nodes: [{ id: "q", type: "process", key: "qspm" }], edges: [] })[0].missing).toEqual([
      "swot_matrix",
      "faktor_internal",
      "faktor_eksternal",
    ]);
    expect(validateGraph(engineGraph(templateGraph("full")))).toEqual([]);
  });
  it("templat mengikuti urutan tab Excel: ES → SGS → SI → LTV → MSDM → DM-CRM", async () => {
    const { processKeys, templateGraph } = await import("@/lib/engine/canvas");
    const keys = processKeys(templateGraph("full"));
    const at = (k: string) => keys.indexOf(k);
    expect(keys.length).toBe(23);
    expect(at("stakeholder_internal")).toBe(0);
    expect(at("ifas")).toBeLessThan(at("posisi_organisasi"));
    expect(at("posisi_organisasi")).toBeLessThan(at("swot_matrix"));
    expect(at("qspm")).toBeLessThan(at("cascading"));
    expect(at("cascading")).toBeLessThan(at("kontinuitas_proker"));
    expect(at("renstra")).toBeLessThan(at("msdm_attraction"));
    expect(at("msdm_separation")).toBeLessThan(at("decision_making"));
    expect(at("change_management")).toBeLessThan(at("risk_management"));
    expect(keys[keys.length - 1]).toBe("grand_design");
    expect(processKeys(templateGraph("mvp"))).toEqual(keys.filter((k) => at(k) <= at("cascading")).concat("grand_design"));
  });
});

describe("canvas fleksibel", () => {
  it("panah antar-analisis (bawaan maupun kustom) menjadi induk; validator/tinjauan dari elemen yang disambung", async () => {
    const { engineGraph, engineParents, processKeys } = await import("@/lib/engine/canvas");
    const canvas = {
      nodes: [
        { id: "a", type: "process" as const, key: "stakeholder_internal", position: { x: 0, y: 0 } },
        { id: "b", type: "process" as const, key: "faktor_internal", position: { x: 0, y: 200 } },
        { id: "k", type: "process" as const, key: "custom", custom: { name: "Analisis risiko", instruction: "Daftar risiko utama" }, position: { x: 400, y: 0 } },
        { id: "v", type: "validator" as const },
        { id: "r", type: "review" as const },
      ],
      edges: [
        { from: "a", to: "b" }, // panah bawaan → bawaan sekarang dihitung sebagai induk
        { from: "b", to: "v" },
        { from: "v", to: "k" }, // lewat validator tetap dihitung sebagai induk
        { from: "k", to: "r" },
      ],
    };
    expect(processKeys(canvas)).toEqual(["stakeholder_internal", "faktor_internal", "custom_k"]);
    expect(engineParents(canvas, "faktor_internal")).toEqual(["stakeholder_internal"]);
    expect(engineParents(canvas, "custom_k")).toEqual(["faktor_internal"]);
    const eg = engineGraph(canvas);
    expect(eg.nodes.find((n) => n.key === "faktor_internal")).toMatchObject({ validator: true, human: false });
    expect(eg.nodes.find((n) => n.key === "custom_k")).toMatchObject({ validator: false, human: true });
    expect(eg.edges).toContainEqual({ from: "faktor_internal", to: "custom_k" });
  });
  it("panah melingkar terdeteksi", async () => {
    const { canvasWarnings } = await import("@/lib/engine/canvas");
    const c = {
      nodes: [
        { id: "x", type: "process" as const, key: "custom", custom: { name: "X", instruction: "x" } },
        { id: "y", type: "process" as const, key: "custom", custom: { name: "Y", instruction: "y" } },
      ],
      edges: [{ from: "x", to: "y" }, { from: "y", to: "x" }],
    };
    expect(canvasWarnings(c).some((w) => w.message.includes("melingkar"))).toBe(true);
  });
});

describe("node kustom bentuk tabel", () => {
  it("table_shape menolak kolom yang beda dan baris yang tidak lengkap; sheet kustom berisi kolom pengguna", async () => {
    const { makeCustomNode, customSheet } = await import("@/lib/nodes/custom");
    const def = makeCustomNode(
      "custom_x",
      { name: "Risiko", instruction: "tabel risiko", format: "table", columns: ["Risiko", "Dampak"], requireEvidence: false },
      [],
      () => ({ label: "", items: [] }),
    );
    const llm = { json: async <T,>(_p: string, _s: string, _u: string, _z: unknown, mock: () => T) => mock() };
    const ctx = { projectId: "p", projectName: "P", orgType: null, runId: "r", nodeRunId: "n", inputs: {}, evidence: [] };
    const bad = {
      summary: "s",
      columns: ["Risiko"],
      items: [{ id: "K1", text: "a", cells: ["a"], refs: ["S1"], evidence: [] }],
    };
    const checks = await def.validate!(bad, ctx, llm);
    const shape = checks.find((c) => c.check === "table_shape")!;
    expect(shape.passed).toBe(false);
    expect(shape.failures.length).toBe(2); // kolom salah + baris K1 kurang sel
    const good = { ...bad, columns: ["Risiko", "Dampak"], items: [{ ...bad.items[0], cells: ["a", "b"] }] };
    expect((await def.validate!(good, ctx, llm)).find((c) => c.check === "table_shape")!.passed).toBe(true);
    const g = customSheet(good, "Risiko");
    expect(g.cells.find((c) => c.r === 3 && c.c === 2)?.v).toBe("Dampak");
    expect(g.cells.find((c) => c.r === 4 && c.c === 1)?.v).toBe("a");
  });
});
