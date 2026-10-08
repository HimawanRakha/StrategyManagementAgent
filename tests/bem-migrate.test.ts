import { describe, expect, it } from "vitest";
import { hasLegacyNodes, migrateBemCanvas } from "@/lib/seed/bem-migrate";
import { canvasWarnings, connectedInputIds, processKeys } from "@/lib/engine/canvas";
import type { WorkflowGraph } from "@/lib/db/schema";

const legacy: WorkflowGraph = {
  nodes: [
    { id: "lb", type: "process", key: "custom", custom: { name: "LATAR BELAKANG", instruction: "x" } },
    { id: "sm", type: "process", key: "custom", custom: { name: "STAKEHOLDER MAPPING", instruction: "x" } },
    { id: "ki", type: "process", key: "custom", custom: { name: "KONDISI IDEAL ORGANISASI", instruction: "x" } },
    { id: "gp", type: "process", key: "custom", custom: { name: "GAP ANALYSIS", instruction: "x" } },
    { id: "i1", type: "input", label: "KERESAHAN" },
    { id: "i2", type: "input", label: "LPJ / laporan kegiatan" },
    { id: "i3", type: "input", label: "JARAS VALIDASI" },
    { id: "i4", type: "input", label: "Nilai organisasi (AD/ART)" },
    { id: "audit_internal", type: "process", key: "audit_internal" },
    { id: "swot", type: "process", key: "swot" },
    { id: "o", type: "output", label: "Dokumen grand design" },
  ],
  edges: [
    { from: "i1", to: "lb" },
    { from: "i2", to: "audit_internal" },
    { from: "audit_internal", to: "swot" },
  ],
};

describe("migrasi canvas BEM", () => {
  it("mengganti node bawaan lama, mempertahankan input & node kustom, dan menyambung input ke node baru", () => {
    expect(hasLegacyNodes(legacy)).toBe(true);
    let n = 0;
    const g = migrateBemCanvas(legacy, () => `new-${++n}`);
    expect(hasLegacyNodes(g)).toBe(false);
    expect(canvasWarnings(g)).toEqual([]);
    // node kustom yang dipertahankan; STAKEHOLDER MAPPING digantikan node bawaan
    expect(g.nodes.some((x) => x.id === "lb")).toBe(true);
    expect(g.nodes.some((x) => x.id === "sm")).toBe(false);
    expect(g.nodes.some((x) => x.id === "o" && x.type === "output")).toBe(true);
    // ID input lama tetap → dokumennya tetap terhubung
    expect(connectedInputIds(g, "faktor_internal")).toContain("i2");
    expect(connectedInputIds(g, "kontinuitas_proker")).toContain("i2");
    expect(connectedInputIds(g, "ifas")).toContain("i3");
    expect(connectedInputIds(g, "cascading")).toContain("i4");
    // input baru untuk stakeholder
    expect(g.nodes.filter((x) => x.type === "input").map((x) => x.label)).toEqual(
      expect.arrayContaining(["Struktur & jabatan organisasi", "Pihak eksternal"]),
    );
    const keys = processKeys(g);
    expect(keys[0]).toBe("custom_lb"); // latar belakang tetap paling awal
    expect(keys.indexOf("custom_gp")).toBeLessThan(keys.indexOf("swot_matrix"));
    expect(keys.indexOf("faktor_internal")).toBeLessThan(keys.indexOf("custom_gp"));
    expect(keys[keys.length - 1]).toBe("grand_design");
  });
});
