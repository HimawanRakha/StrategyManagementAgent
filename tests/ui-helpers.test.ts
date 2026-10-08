// Uji helper murni tampilan sheet: tata letak sel gabungan, format angka, rumus, masukan pengguna, riwayat edit, kebasian.
import { describe, expect, it } from "vitest";
import { GridBuilder, type Grid } from "@/lib/sheets/grid";
import {
  cellContext,
  editedPaths,
  effectiveSource,
  formatCellValue,
  formatNumber,
  formulaParts,
  formulaRanges,
  formulaText,
  keyCells,
  layoutGrid,
  numberError,
  optionIndex,
  parseA1,
  parseNumberInput,
  sameValue,
  staleSources,
  stickyColsOf,
  stickyRowsOf,
  textOnFill,
} from "@/components/sheets/grid-utils";
import { itemsGrid, sheetsFromDef } from "@/components/sheets/node-sheets";

function sample(): Grid {
  const g = new GridBuilder("t", "UJI", "Uji");
  g.set(0, 0, "Judul", { style: "title", cs: 4 });
  g.row(2, 0, ["Faktor", "Rating", "Bobot", "Skor"], { style: "header" });
  g.set(3, 0, "S1", { style: "label" });
  g.set(3, 1, 3, { src: "ai", edit: { path: ["ratings", 0, "v"], type: "number", min: 1, max: 4, step: 1 } });
  g.set(3, 2, 0.25, { src: "ahp", fmt: "0.000" });
  g.set(3, 3, 0.75, { src: "hitung", fmt: "0.000", f: "B4*C4", explain: "Skor = 3 × 0,25 = 0,75" });
  g.set(4, 0, "Total", { style: "total", cs: 3 });
  g.set(4, 3, 0.75, { style: "total", src: "hitung", fmt: "0.000", f: "SUM(D4:D4)", explain: "Total = 0,75" });
  g.anchor("total", 4, 3);
  return g.build();
}

describe("layoutGrid", () => {
  it("menyusun sel gabungan (rs/cs) dan menandai slot yang tertutup", () => {
    const L = layoutGrid(sample());
    expect(L.rows).toBe(5);
    expect(L.cols).toBe(4);
    const title = L.slots[0][0];
    expect(title !== null && title !== "covered" && title.cs).toBe(4);
    expect(L.slots[0][1]).toBe("covered");
    expect(L.slots[0][3]).toBe("covered");
    expect(L.slots[1][0]).toBeNull();
    expect(L.slots[4][1]).toBe("covered");
    const total = L.slots[4][3];
    expect(total !== null && total !== "covered" && total.cell.v).toBe(0.75);
  });

  it("membuang sel di dalam gabungan dan mempersempit gabungan yang menabrak", () => {
    const L = layoutGrid({
      cells: [
        { r: 0, c: 0, v: "A", rs: 2, cs: 2 },
        { r: 0, c: 1, v: "tertutup" },
        { r: 1, c: 0, v: "juga tertutup" },
        { r: 2, c: 0, v: "B", cs: 3 },
        { r: 2, c: 2, v: "C" }, // ditimpa gabungan B (Excel hanya menyimpan kiri-atas)
        { r: 3, c: 2, v: "F", rs: 2 },
        { r: 4, c: 0, v: "G", cs: 3 }, // menabrak F (gabungan dari baris atas) → dipersempit jadi 2
      ],
    });
    const a = L.slots[0][0];
    expect(a !== null && a !== "covered" && [a.rs, a.cs]).toEqual([2, 2]);
    expect(L.slots[1][1]).toBe("covered");
    expect(L.slots[2][2]).toBe("covered");
    const g = L.slots[4][0];
    expect(g !== null && g !== "covered" && g.cs).toBe(2);
    expect(L.slots[4][2]).toBe("covered");
    const f = L.slots[3][2];
    expect(f !== null && f !== "covered" && f.rs).toBe(2);
  });
});

describe("format angka", () => {
  it("memakai koma desimal dan format Excel", () => {
    expect(formatNumber(0.2838, "0.000")).toBe("0,284");
    expect(formatNumber(0.125, "0%")).toBe("13%");
    expect(formatNumber(0.125, "0.0%")).toBe("12,5%");
    expect(formatNumber(1234.5, "#,##0.00")).toBe("1.234,50");
    expect(formatNumber(3)).toBe("3");
    expect(formatNumber(1 / 3)).toBe("0,333");
    expect(formatNumber(2.7, undefined, "int")).toBe("3");
  });
  it("mengutamakan display", () => {
    expect(formatCellValue({ v: 0.3333, display: "1/3" })).toBe("1/3");
    expect(formatCellValue({ v: null })).toBe("");
    expect(formatCellValue({ v: "teks" })).toBe("teks");
  });
});

describe("rumus", () => {
  it("menampilkan rujukan antar-sheet sebagai 'Label › anchor'", () => {
    expect(formulaParts("{{ifas!total}}-{{efas!total}}")).toEqual([
      { type: "ref", key: "ifas", anchor: "total" },
      { type: "text", text: "-" },
      { type: "ref", key: "efas", anchor: "total" },
    ]);
    expect(formulaText("B6*{{ifas!total}}", (k) => k.toUpperCase())).toBe("=B6*IFAS › total");
  });
  it("menemukan sel/rentang yang dirujuk di sheet yang sama", () => {
    expect(parseA1("$D$6")).toEqual({ r: 5, c: 3 });
    expect(parseA1("AA1")).toEqual({ r: 0, c: 26 });
    expect(formulaRanges("SUM(D6:H6)*$B$2")).toEqual([
      { r1: 5, c1: 3, r2: 5, c2: 7 },
      { r1: 1, c1: 1, r2: 1, c2: 1 },
    ]);
    // rujukan sheet lain, teks, dan nama fungsi diabaikan
    expect(formulaRanges('IF({{ifas!total}}>2,"A1",LOG10(C3))+\'Sheet X\'!B2+Data!C4')).toEqual([{ r1: 2, c1: 2, r2: 2, c2: 2 }]);
  });
});

describe("masukan pengguna", () => {
  it("membaca angka gaya Indonesia, titik, dan pecahan", () => {
    expect(parseNumberInput("0,5")).toBe(0.5);
    expect(parseNumberInput("0.5")).toBe(0.5);
    expect(parseNumberInput("1.250,75")).toBe(1250.75);
    expect(parseNumberInput("1/4")).toBe(0.25);
    expect(parseNumberInput("  ")).toBeNull();
    expect(parseNumberInput("abc")).toBeNaN();
  });
  it("memeriksa min/max/step dan kosong", () => {
    const e = { min: 1, max: 4, step: 1 };
    expect(numberError(3, e)).toBeNull();
    expect(numberError(5, e)).toMatch(/Maksimal 4/);
    expect(numberError(0, e)).toMatch(/Minimal 1/);
    expect(numberError(2.5, e)).toMatch(/Kelipatan/);
    expect(numberError(null, e)).toBe("Wajib diisi");
    expect(numberError(null, { allowEmpty: true })).toBeNull();
    expect(numberError(NaN, {})).toBe("Bukan angka");
  });
  it("mencocokkan pilihan skala Saaty dengan toleransi", () => {
    const opts = [
      { label: "3", value: 3 },
      { label: "1", value: 1 },
      { label: "1/3", value: 0.3333 },
    ];
    expect(optionIndex(opts, 1 / 3)).toBe(2);
    expect(optionIndex(opts, 3)).toBe(0);
    expect(optionIndex(opts, 0.5)).toBe(-1);
    expect(optionIndex(["tinggi", "rendah"], "rendah")).toBe(1);
  });
  it("membandingkan nilai sel", () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue("", null)).toBe(true);
    expect(sameValue(1, "1")).toBe(false);
  });
});

describe("riwayat edit", () => {
  it("menandai path yang berbeda dari usulan AI dan menyimpan nilai semula", () => {
    const m = editedPaths([
      { path: ["ratings", 0, "v"], from: 3, to: 4 },
      { path: ["ratings", 0, "v"], from: 4, to: 2 },
      { path: ["ratings", 1, "v"], from: 2, to: 1 },
      { path: ["ratings", 1, "v"], from: 1, to: 2 }, // dikembalikan ke semula → tidak ditandai
    ]);
    expect([...m.keys()]).toEqual(["ratings.0.v"]);
    expect(m.get("ratings.0.v")).toEqual({ from: 3, to: 2 });
    const g = sample();
    const cell = g.cells.find((c) => c.edit)!;
    expect(effectiveSource(cell, m)).toBe("manusia");
    expect(effectiveSource(cell, new Map())).toBe("ai");
  });
});

describe("konteks & sel kunci", () => {
  it("menemukan label baris dan judul kolom", () => {
    const g = sample();
    const L = layoutGrid(g);
    const skor = g.cells.find((c) => c.r === 3 && c.c === 3)!;
    expect(cellContext(L, skor)).toEqual({ row: "S1", col: "Skor" });
  });
  it("memilih sel total/anchor berpenjelasan", () => {
    const k = keyCells(sample());
    expect(k.map((c) => [c.r, c.c])).toEqual([[4, 3]]);
  });
  it("membekukan baris kepala tabel", () => {
    const g = sample();
    const L = layoutGrid(g);
    expect(stickyRowsOf(g, L)).toEqual([2]);
    expect(stickyRowsOf({ freeze: { rows: 3, cols: 1 } }, L)).toEqual([0, 1, 2]);
    expect(stickyColsOf(g, L)).toBe(0);
    expect(stickyColsOf({ freeze: { rows: 0, cols: 2 } }, L)).toBe(2);
  });
  it("memilih warna teks yang terbaca", () => {
    expect(textOnFill("FFFFFF")).toBe("#1c2128");
    expect(textOnFill("D9F2E3")).toBe("#1c2128");
    expect(textOnFill("1F4E79")).toBe("#ffffff");
  });
});

describe("staleSources", () => {
  const parents: Record<string, string[]> = { ifas: ["faktor_internal", "stakeholder_internal"], posisi: ["ifas", "efas"], efas: [] };
  const t = (iso: string) => new Date(iso).toISOString();
  it("melaporkan hulu (berantai) yang diubah setelah analisis selesai", () => {
    const states: Record<string, { finishedAt?: string; editedAt?: string | null; status: string }> = {
      posisi: { status: "done", finishedAt: t("2026-10-07T10:00:00Z") },
      ifas: { status: "done", finishedAt: t("2026-10-07T09:00:00Z"), editedAt: null },
      faktor_internal: { status: "done", finishedAt: t("2026-10-07T08:00:00Z"), editedAt: t("2026-10-07T11:00:00Z") },
      efas: { status: "done", finishedAt: t("2026-10-07T09:00:00Z"), editedAt: t("2026-10-07T09:30:00Z") }, // sebelum posisi selesai
    };
    const s = staleSources("posisi", (k) => parents[k] ?? [], (k) => states[k]);
    expect(s).toEqual(["faktor_internal"]);
    // analisis yang belum selesai tidak pernah basi
    expect(staleSources("posisi", (k) => parents[k] ?? [], (k) => (k === "posisi" ? { status: "pending" } : states[k]))).toEqual([]);
  });
});

describe("sheet cadangan", () => {
  it("memakai sheets() node bila ada, kalau tidak tabel dari items()", () => {
    const ctx = { label: "Faktor", inputs: {} };
    const withSheets = sheetsFromDef({ sheets: () => [sample()], items: () => [] }, { x: 1 }, ctx);
    expect(withSheets.fallback).toBe(false);
    expect(withSheets.grids[0].id).toBe("t");

    const stub = sheetsFromDef({ items: () => [{ id: "X1", text: "Butir satu", detail: "angka 3" }] }, { items: [] }, ctx);
    expect(stub.fallback).toBe(true);
    const cells = stub.grids[0].cells;
    expect(cells.find((c) => c.r === 3 && c.c === 0)?.v).toBe("X1");
    expect(cells.find((c) => c.r === 3 && c.c === 1)?.v).toBe("Butir satu");

    const broken = sheetsFromDef(
      {
        sheets: () => {
          throw new Error("bentuk lama");
        },
        items: () => [],
      },
      {},
      ctx,
    );
    expect(broken.fallback).toBe(true);
    expect(broken.error).toMatch(/bentuk lama/);
    expect(sheetsFromDef(null, null, ctx).grids).toEqual([]);
  });
  it("itemsGrid menulis baris kosong yang ramah", () => {
    const g = itemsGrid([], "Kosong");
    expect(g.cells.some((c) => c.v === "Belum ada butir.")).toBe(true);
  });
});
