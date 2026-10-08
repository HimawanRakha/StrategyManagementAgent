import { describe, expect, it } from "vitest";
import { kendallTau } from "@/lib/calc/qspm";

// Uji kalkulator tiap node ada di tests/nodes-*.test.ts (termasuk uji emas terhadap angka Excel framework) dan tests/ahp.test.ts.

describe("stabilitas peringkat", () => {
  it("Kendall tau: identik 1, terbalik −1", () => {
    expect(kendallTau(["A", "B", "C"], ["A", "B", "C"])).toBe(1);
    expect(kendallTau(["A", "B", "C"], ["C", "B", "A"])).toBe(-1);
  });
});
