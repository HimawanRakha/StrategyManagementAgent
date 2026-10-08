// Sheet AHP: matriks perbandingan berpasangan per himpunan, rata-rata geometrik, bobot, λmaks, CI, RI, CR.
// Sel perbandingan dari AI bisa diubah pengguna (pilihan skala Saaty); sel cerminnya (1/x), bobot, dan konsistensi berumus.
import { SAATY_VALUES, ahp, saatyText } from "@/lib/calc/ahp";
import type { AhpSetRaw } from "@/lib/nodes/contracts";
import { GridBuilder, addr, colLetter, num, range, type CellEdit, type Grid } from "./grid";

/** Pilihan skala Saaty untuk sel perbandingan (9 … 1 … 1/9). */
export const SAATY_OPTIONS: NonNullable<CellEdit["options"]> = [...SAATY_VALUES].reverse().map((v) => ({ label: saatyText(v), value: v }));

export type AhpSheetSet = {
  raw: AhpSetRaw;
  /** Judul himpunan, mis. "Antarkelompok stakeholder". */
  label: string;
  /** Path himpunan ini di output mentah node, mis. ["ahp", 0]. */
  path: (string | number)[];
  /** Nama tampilan butir (tooltip/kolom label). */
  itemLabel: (id: string) => string;
  /** Bobot induk (AHP bertingkat): bobot global = bobot lokal × bobot induk. */
  parent?: { label: string; weight: number; anchor?: string };
};

/**
 * Bangun satu Grid berisi semua himpunan AHP node (ditumpuk ke bawah).
 * Anchor `w_<id>` menunjuk sel bobot (global bila bertingkat) agar sheet lain bisa merujuk {{nodeKey!w_<id>}}.
 */
export function ahpGrid(opts: { id?: string; name: string; title: string; sets: AhpSheetSet[] }): Grid {
  const g = new GridBuilder(opts.id ?? "ahp", opts.name, opts.title);
  let r = 0;
  const maxN = Math.max(1, ...opts.sets.map((s) => s.raw.items.length));
  g.set(r, 0, opts.title, { style: "title", cs: maxN + 5 });
  r += 2;
  for (const set of opts.sets) {
    const ids = set.raw.items;
    const n = ids.length;
    const res = ahp(ids, set.raw.pairs ?? []);
    const hasParent = !!set.parent;
    const cGeo = 1 + n;
    const cW = cGeo + 1;
    const cGlob = hasParent ? cW + 1 : -1;
    const cLam = hasParent ? cW + 2 : cW + 1;
    g.set(r, 0, `AHP — ${set.label}`, { style: "subheader", cs: cLam + 1 });
    r++;
    const head = r;
    g.set(head, 0, "Butir", { style: "header" });
    ids.forEach((id, j) => g.set(head, 1 + j, id, { style: "header", center: true, note: set.itemLabel(id) }));
    g.set(head, cGeo, "Rata-rata geometrik", { style: "header" });
    g.set(head, cW, "Bobot lokal", { style: "header" });
    if (hasParent) g.set(head, cGlob, `Bobot global (× ${set.parent!.label})`, { style: "header" });
    g.set(head, cLam, "Jumlah kolom × bobot", { style: "header" });
    const r0 = head + 1;
    const rN = r0 + n - 1;
    // Posisi pasangan di output mentah: (a,b) → index
    const pairIdx = new Map<string, number>();
    (set.raw.pairs ?? []).forEach((p, k) => pairIdx.set(`${p.a}|${p.b}`, k));
    ids.forEach((id, i) => {
      const row = r0 + i;
      g.set(row, 0, id, { style: "label", note: set.itemLabel(id) });
      ids.forEach((jd, j) => {
        const c = 1 + j;
        const v = res.matrix[i][j];
        if (i === j) {
          g.set(row, c, 1, { src: "tetap", center: true, display: "1" });
          return;
        }
        const k = pairIdx.get(`${id}|${jd}`);
        if (k !== undefined) {
          g.set(row, c, v, {
            src: "ai",
            center: true,
            display: saatyText(v),
            fmt: "0.000",
            note: `${id} dibanding ${jd}: ${saatyText(v)} — ${v >= 1 ? `${id} ${v === 1 ? "sama penting" : `${saatyText(v)}× lebih penting`}` : `${jd} ${saatyText(1 / v)}× lebih penting`}`,
            edit: { path: [...set.path, "pairs", k, "v"], type: "select", options: SAATY_OPTIONS },
          });
        } else if (pairIdx.has(`${jd}|${id}`)) {
          const mirror = addr(r0 + j, 1 + i);
          g.set(row, c, v, {
            src: "hitung",
            center: true,
            display: saatyText(v),
            fmt: "0.000",
            f: `1/${mirror}`,
            explain: `Kebalikan perbandingan ${jd} vs ${id}: 1 ÷ ${saatyText(1 / v)} = ${saatyText(v)}`,
          });
        } else {
          g.set(row, c, 1, { src: "tetap", center: true, display: "1", note: "Belum diisi — dianggap sama penting" });
        }
      });
      const rowRange = range(row, 1, row, n);
      g.set(row, cGeo, res.geo[i], {
        src: "hitung",
        fmt: "0.000",
        f: `GEOMEAN(${rowRange})`,
        explain: `Rata-rata geometrik baris ${id} = (hasil kali ${n} nilai di barisnya)^(1/${n}) = ${num(res.geo[i])}`,
      });
      const geoSum = res.geo.reduce((s, x) => s + x, 0);
      g.set(row, cW, res.weights[i], {
        src: "ahp",
        fmt: "0.000",
        f: `${addr(row, cGeo)}/SUM(${range(r0, cGeo, rN, cGeo, true)})`,
        explain: `Bobot ${id} = rata-rata geometrik ÷ jumlah semua = ${num(res.geo[i])} ÷ ${num(geoSum)} = ${num(res.weights[i])}`,
      });
      if (hasParent) {
        const pw = set.parent!.weight;
        g.set(row, cGlob, res.weights[i] * pw, {
          src: "ahp",
          fmt: "0.000",
          f: set.parent!.anchor ? `${addr(row, cW)}*${set.parent!.anchor}` : `${addr(row, cW)}*${pw}`,
          explain: `Bobot global ${id} = bobot lokal × bobot ${set.parent!.label} = ${num(res.weights[i])} × ${num(pw)} = ${num(res.weights[i] * pw)}`,
        });
        g.anchor(`w_${id}`, row, cGlob);
      } else g.anchor(`w_${id}`, row, cW);
      const col = colLetter(1 + i);
      g.set(row, cLam, res.colSums[i] * res.weights[i], {
        src: "hitung",
        fmt: "0.000",
        f: `SUM(${col}${r0 + 1}:${col}${rN + 1})*${addr(row, cW)}`,
        explain: `Jumlah kolom ${id} × bobot ${id} = ${num(res.colSums[i])} × ${num(res.weights[i])} = ${num(res.colSums[i] * res.weights[i])}`,
      });
    });
    // Ringkasan konsistensi
    let rr = rN + 1;
    g.set(rr, 0, "Jumlah bobot", { style: "total" });
    g.set(rr, cW, res.weights.reduce((s, x) => s + x, 0), {
      style: "total",
      fmt: "0.000",
      f: `SUM(${range(r0, cW, rN, cW)})`,
      src: "hitung",
      explain: `Jumlah semua bobot lokal = ${num(res.weights.reduce((s, x) => s + x, 0))} (selalu 1 karena bobot dinormalkan)`,
    });
    const lamAddr = addr(rr, cLam);
    g.set(rr, cLam - 1, "λ maks", { style: "label" });
    g.set(rr, cLam, res.lambdaMax, {
      style: "total",
      fmt: "0.000",
      f: `SUM(${range(r0, cLam, rN, cLam)})`,
      src: "hitung",
      explain: `λ maks = Σ (jumlah kolom × bobot) = ${num(res.lambdaMax)} (matriks yang konsisten sempurna memberi λ maks = n = ${n})`,
    });
    rr++;
    const ciAddr = addr(rr, 1);
    g.set(rr, 0, "CI", { style: "label", note: "Consistency Index" });
    g.set(rr, 1, res.ci, {
      fmt: "0.000",
      f: n > 2 ? `(${lamAddr}-${n})/(${n}-1)` : "0",
      src: "hitung",
      explain: n > 2 ? `CI = (λ maks − n) ÷ (n − 1) = (${num(res.lambdaMax)} − ${n}) ÷ ${n - 1} = ${num(res.ci)}` : "Dua butir atau kurang selalu konsisten (CI = 0)",
    });
    rr++;
    const riAddr = addr(rr, 1);
    g.set(rr, 0, "RI", { style: "label", note: "Random Index (tabel Saaty)" });
    g.set(rr, 1, res.ri, { fmt: "0.00", src: "tetap", explain: `RI untuk n = ${n} dari tabel Saaty = ${num(res.ri, 2)}` });
    rr++;
    g.set(rr, 0, "CR", { style: "label", note: "Consistency Ratio" });
    g.set(rr, 1, res.cr, {
      style: "total",
      fmt: "0.000",
      f: n > 2 ? `IF(${riAddr}=0,0,${ciAddr}/${riAddr})` : "0",
      src: "hitung",
      explain: n > 2 ? `CR = CI ÷ RI = ${num(res.ci)} ÷ ${num(res.ri, 2)} = ${num(res.cr)} → ${res.consistent ? "konsisten (≤ 0,10)" : "TIDAK konsisten (> 0,10): ubah perbandingan yang bertentangan"}` : "CR = 0",
    });
    g.set(rr, 2, res.consistent ? "Konsisten (CR ≤ 0,10)" : "Tidak konsisten (CR > 0,10)", {
      style: "label",
      fill: res.consistent ? "D9F2E3" : "FAD7D7",
      cs: 3,
      f: n > 2 ? `IF(${addr(rr, 1)}<=0.1,"Konsisten (CR ≤ 0,10)","Tidak konsisten (CR > 0,10)")` : undefined,
      explain: n > 2 ? `Kesimpulan: CR ${num(res.cr)} ${res.consistent ? "≤" : ">"} 0,10 → ${res.consistent ? "penilaian berpasangan cukup konsisten" : "penilaian berpasangan saling bertentangan, perlu diperbaiki"}` : undefined,
    });
    if (res.missing.length)
      g.set(rr + 1, 0, `${res.missing.length} pasangan belum diisi dan dianggap sama penting.`, { style: "note", cs: cLam + 1 });
    r = rr + 3;
  }
  return g.build({
    cols: [12, ...Array.from({ length: maxN }, () => 7), 12, 10, 12, 12],
    notes: [
      "Setiap sel di dalam matriks = seberapa penting butir di baris dibanding butir di kolom (skala Saaty 1–9; 1/3 berarti kolom lebih penting).",
      "Sel berwarna AI bisa Anda ubah; sel kebalikannya (1/x), bobot, dan CR dihitung ulang otomatis.",
      "Bobot = rata-rata geometrik baris ÷ jumlahnya. CR ≤ 0,10 berarti penilaian berpasangan cukup konsisten.",
    ],
  });
}
