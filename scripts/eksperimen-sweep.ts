// npm run eksperimen:sweep — eksplorasi penempatan validator OTOMATIS dan tinjauan MANUSIA di banyak skenario anggaran
// (murni perhitungan dari hasil-eksperimen/parameter.json; tidak memanggil AI). Keluaran: hasil-eksperimen/sweep.json.
//  1. Flow awal = penempatan di canvas BEM saat ini (hasil-eksperimen/canvas-bem.json).
//  2. Grid anggaran token × menit → penempatan optimal (pemrograman dinamis) dan P prediksi.
//  3. Frontier Pareto biaya ↔ P, dan rekomendasi "titik lutut".
//  4. Sensitivitas: dʰ (ketelitian peninjau) dan menit per tinjauan.
//  5. Kepentingan tiap analisis: kenaikan P bila hanya analisis itu diberi validator / tinjauan.
//  6. Cek silang Monte Carlo (dengan pemulihan hᵢ) untuk flow awal dan flow rekomendasi.
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

type Choice = { validator: boolean; human: boolean };

async function main() {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { optimizeDP } = await import("../lib/experiment/optimize");
  const { predictP, placementCost, effectiveError } = await import("../lib/experiment/propagation");
  const { simulateP, seededRng } = await import("../lib/experiment/simulate");
  const { engineGraph } = await import("../lib/engine/canvas");
  const { Graph } = await import("../lib/engine/graph");
  const { nodeLabel } = await import("../lib/nodes/meta");

  const params = JSON.parse(readFileSync("hasil-eksperimen/parameter.json", "utf8"));
  const canvas = JSON.parse(readFileSync("hasil-eksperimen/canvas-bem.json", "utf8"));
  const MIN_ASSUMED = Number(process.env.EKSP_MENIT ?? 5);
  type P = { key: string; e: { p: number; n: number }; dr: number; cTok: number; cMin: number; cMinN: number; h?: { p: number } };
  const all = (params.stages as P[]).filter((s) => Number.isFinite(s.e.p));
  // EKSP_DR=empiris: pakai d·r nyata (hasil-eksperimen/dr-empiris.json) menggantikan d·r hasil penyuntikan.
  const DR_EMP = process.env.EKSP_DR === "empiris" ? (JSON.parse(readFileSync("hasil-eksperimen/dr-empiris.json", "utf8")) as Record<string, { dr?: number }>) : {};
  for (const s of all) if (typeof DR_EMP[s.key]?.dr === "number") s.dr = DR_EMP[s.key].dr!;
  const OUT = process.env.EKSP_DR === "empiris" ? "hasil-eksperimen/sweep-empiris.json" : "hasil-eksperimen/sweep.json";
  const mk = (minutes: number) =>
    all.map((s) => ({
      key: s.key,
      e: s.e.p,
      dr: s.dr,
      // Validator tanpa data biaya (tidak pernah dipasang) memakai rata-rata biaya validator yang terukur.
      cTok: s.cTok > 0 ? s.cTok : 10000,
      cMin: s.cMinN >= 3 && s.cMin > 0 ? s.cMin : minutes,
    }));
  const stages = mk(MIN_ASSUMED);
  const dh0 = params.dh ?? 0.85;
  const label = (k: string) => nodeLabel(k);
  const pick = (place: Record<string, Choice>) => ({
    validator: Object.entries(place).filter(([, c]) => c.validator).map(([k]) => k),
    human: Object.entries(place).filter(([, c]) => c.human).map(([k]) => k),
  });

  // 1. Flow awal (canvas)
  const eg = engineGraph(canvas);
  const flowAwal: Record<string, Choice> = Object.fromEntries(eg.nodes.map((n) => [n.key!, { validator: !!n.validator, human: !!n.human }]));
  const awal = { place: pick(flowAwal), p: predictP(stages, flowAwal, dh0), cost: placementCost(stages, flowAwal) };
  const none = predictP(stages, {}, dh0);

  // 2. Grid anggaran
  const TOK = [0, 10000, 20000, 30000, 50000, 75000, 100000, 150000, 250000];
  const MIN = [0, 5, 10, 15, 20, 30, 45, 60, 90];
  const grid: { tok: number; min: number; p: number; costTok: number; costMin: number; place: ReturnType<typeof pick> }[] = [];
  for (const t of TOK)
    for (const m of MIN) {
      const b = optimizeDP(stages, dh0, t, m, 250, 1);
      const c = placementCost(stages, b.place);
      grid.push({ tok: t, min: m, p: b.p, costTok: c.tok, costMin: c.min, place: pick(b.place) });
    }

  // 3. Pareto (biaya nyata yang dipakai, bukan anggaran): titik yang tidak didominasi.
  const pts = [...new Map(grid.map((g) => [`${g.costTok}|${g.costMin}`, g])).values()];
  const pareto = pts
    .filter((a) => !pts.some((b) => b !== a && b.costTok <= a.costTok && b.costMin <= a.costMin && b.p > a.p + 1e-9))
    .sort((a, b) => a.costMin - b.costMin || a.costTok - b.costTok);
  // Rekomendasi: titik termurah (menit dulu, lalu token) yang P-nya ≥ 95% dari P maksimum di grid.
  const pMax = Math.max(...grid.map((g) => g.p));
  const rekomendasi = [...grid].filter((g) => g.p >= 0.95 * pMax).sort((a, b) => a.costMin - b.costMin || a.costTok - b.costTok || b.p - a.p)[0];
  // Rekomendasi hemat: dalam anggaran 30 rb token & 15 menit.
  const hemat = grid.find((g) => g.tok === 30000 && g.min === 15)!;
  const tanpaManusia = grid.find((g) => g.tok === 30000 && g.min === 0)!;

  // 4. Sensitivitas
  const sensDh = [0.6, 0.75, 0.85, 0.95].map((dh) => {
    const b = optimizeDP(stages, dh, 30000, 15, 250, 1);
    return { dh, p: b.p, place: pick(b.place) };
  });
  const sensMin = [3, 5, 10, 15].map((mm) => {
    const st = mk(mm);
    const b = optimizeDP(st, dh0, 30000, 15, 250, 1);
    return { menit: mm, p: b.p, place: pick(b.place) };
  });

  // 5. Kepentingan per analisis
  const penting = stages
    .map((s) => ({
      key: s.key,
      label: label(s.key),
      e: s.e,
      dr: s.dr,
      gainV: predictP(stages, { [s.key]: { validator: true, human: false } }, dh0) / none,
      gainH: predictP(stages, { [s.key]: { validator: false, human: true } }, dh0) / none,
      eV: effectiveError(s, { validator: true, human: false }, dh0),
      eH: effectiveError(s, { validator: false, human: true }, dh0),
    }))
    .sort((a, b) => Math.max(b.gainV, b.gainH) - Math.max(a.gainV, a.gainH));

  // 6. Monte Carlo dengan pemulihan h
  const g = new Graph(eg);
  const hOf = Object.fromEntries((params.stages as P[]).map((s) => [s.key, s.h?.p && Number.isFinite(s.h.p) ? s.h.p : 0]));
  const sim = (place: Record<string, Choice>) =>
    simulateP(
      g,
      Object.fromEntries(stages.map((s) => [s.key, { e: effectiveError(s, place[s.key] ?? { validator: false, human: false }, dh0), h: hOf[s.key] ?? 0 }])),
      100000,
      undefined,
      seededRng(7),
    );
  const toPlace = (p: ReturnType<typeof pick>) =>
    Object.fromEntries(stages.map((s) => [s.key, { validator: p.validator.includes(s.key), human: p.human.includes(s.key) }]));

  const out = {
    asumsi: { dh: dh0, menitPerTinjauan: MIN_ASSUMED, catatan: "menit per tinjauan diasumsikan (data tinjauan nyata < 3); validator tanpa data biaya diberi 10.000 token" },
    tanpaPemeriksaan: none,
    awal: { ...awal, mc: sim(flowAwal) },
    rekomendasi: { ...rekomendasi, mc: sim(toPlace(rekomendasi.place)) },
    hemat: { ...hemat, mc: sim(toPlace(hemat.place)) },
    tanpaManusia,
    pMax,
    grid,
    pareto,
    sensDh,
    sensMin,
    penting,
    stages: stages.map((s) => ({ ...s, label: label(s.key) })),
    urutan: g.topoOrder(),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  const f = (x: number) => `${(x * 100).toFixed(1)}%`;
  const names = (p: ReturnType<typeof pick>) => `V[${p.validator.map(label).join(", ")}] M[${p.human.map(label).join(", ")}]`;
  console.log(`Tanpa pemeriksaan: ${f(none)}`);
  console.log(`Flow awal: ${f(awal.p)} (MC ${f(out.awal.mc)}) biaya ${awal.cost.tok} tok + ${awal.cost.min} mnt ${names(awal.place)}`);
  console.log(`30rb tok, 0 mnt: ${f(tanpaManusia.p)} ${names(tanpaManusia.place)}`);
  console.log(`30rb tok, 15 mnt: ${f(hemat.p)} (MC ${f(out.hemat.mc)}) ${names(hemat.place)}`);
  console.log(`Rekomendasi (≥95% Pmax ${f(pMax)}): anggaran ${rekomendasi.tok}/${rekomendasi.min} → ${f(rekomendasi.p)} biaya ${rekomendasi.costTok}/${rekomendasi.costMin} ${names(rekomendasi.place)}`);
  console.log("Pareto:", pareto.map((p) => `${p.costTok}t/${p.costMin}m=${f(p.p)}`).join("  "));
  console.log("Sens dh:", sensDh.map((s) => `${s.dh}:${f(s.p)}`).join(" "), "| Sens menit:", sensMin.map((s) => `${s.menit}:${f(s.p)}`).join(" "));
  console.log("Penting:", penting.slice(0, 8).map((x) => `${x.label} V×${x.gainV.toFixed(2)} M×${x.gainH.toFixed(2)}`).join(" | "));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
