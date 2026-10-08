import { describe, expect, it } from "vitest";
import { ahp, randomIndex, snapSaaty } from "@/lib/calc/ahp";
import { checkAhpComplete, checkAhpConsistency, mockAhpSet } from "@/lib/nodes/ahp-common";
import { ahpGrid } from "@/lib/sheets/ahp-sheet";

describe("AHP", () => {
  it("matriks konsisten sempurna: bobot sesuai rasio, λmaks = n, CR = 0", () => {
    // w = 0.6, 0.3, 0.1 → a12 = 2, a13 = 6, a23 = 3
    const r = ahp(["A", "B", "C"], [
      { a: "A", b: "B", v: 2 },
      { a: "A", b: "C", v: 6 },
      { a: "B", b: "C", v: 3 },
    ]);
    expect(r.weights.map((w) => +w.toFixed(3))).toEqual([0.6, 0.3, 0.1]);
    expect(r.lambdaMax).toBeCloseTo(3, 9);
    expect(r.cr).toBeCloseTo(0, 9);
    expect(r.consistent).toBe(true);
  });
  it("kebalikan (b lebih penting) dan pembulatan ke skala Saaty", () => {
    expect(snapSaaty(0.33)).toBeCloseTo(1 / 3, 9);
    expect(snapSaaty(10)).toBe(9);
    expect(snapSaaty(-1)).toBe(1);
    const r = ahp(["A", "B"], [{ a: "A", b: "B", v: 0.2 }]);
    expect(r.weights[1] / r.weights[0]).toBeCloseTo(5, 9);
  });
  it("matriks bertentangan → CR > 0,10", () => {
    const r = ahp(["A", "B", "C"], [
      { a: "A", b: "B", v: 9 },
      { a: "B", b: "C", v: 9 },
      { a: "A", b: "C", v: 1 / 9 },
    ]);
    expect(r.cr).toBeGreaterThan(0.1);
    expect(checkAhpConsistency([{ id: "X", items: ["A", "B", "C"], pairs: [
      { a: "A", b: "B", v: 9 }, { a: "B", b: "C", v: 9 }, { a: "A", b: "C", v: 1 / 9 },
    ] }]).passed).toBe(false);
  });
  it("RI: tabel Saaty dan pendekatan Alonso–Lamata di atas 15", () => {
    expect(randomIndex(3)).toBe(0.58);
    expect(randomIndex(15)).toBe(1.59);
    expect(randomIndex(20)).toBeGreaterThan(1.59);
  });
  it("pasangan hilang terdeteksi; mock lengkap dan konsisten", () => {
    expect(checkAhpComplete([{ id: "S", items: ["S1", "S2", "S3"], pairs: [{ a: "S1", b: "S2", v: 3 }] }]).failures.length).toBe(1);
    const m = mockAhpSet("S", ["S1", "S2", "S3", "S4"], (id) => Number(id.slice(1)));
    expect(m.pairs.length).toBe(6);
    expect(checkAhpComplete([m]).passed).toBe(true);
    expect(checkAhpConsistency([m]).passed).toBe(true);
  });
  it("sheet AHP: sel AI bisa diedit, bobot berumus GEOMEAN", () => {
    const raw = { id: "S", items: ["S1", "S2", "S3"], pairs: [{ a: "S1", b: "S2", v: 3 }, { a: "S1", b: "S3", v: 5 }, { a: "S2", b: "S3", v: 2 }] };
    const g = ahpGrid({ name: "AHP", title: "AHP faktor", sets: [{ raw, label: "Strength", path: ["ahp", 0], itemLabel: (i) => i }] });
    const editable = g.cells.filter((c) => c.edit);
    expect(editable.length).toBe(3);
    expect(editable[0].edit?.path).toEqual(["ahp", 0, "pairs", 0, "v"]);
    expect(g.cells.some((c) => c.f?.startsWith("GEOMEAN("))).toBe(true);
    expect(g.anchors?.w_S1).toBeTruthy();
  });
});
