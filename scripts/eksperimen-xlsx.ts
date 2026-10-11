// npm run eksperimen:xlsx — ekspor hasil eksperimen (hasil-eksperimen/*.json + basis data) ke hasil-eksperimen/hasil-eksperimen.xlsx.
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

const PROJECT = process.env.EKSP_PROJECT ?? "94023829-4c5b-41ce-8809-7674e8a39c7d";

async function main() {
  const { readFileSync } = await import("node:fs");
  const ExcelJS = (await import("exceljs")).default;
  const { queryRows } = await import("../lib/db/client");
  const { sql } = await import("drizzle-orm");
  const { nodeLabel } = await import("../lib/nodes/meta");
  const params = JSON.parse(readFileSync("hasil-eksperimen/parameter.json", "utf8"));
  const opt = JSON.parse(readFileSync("hasil-eksperimen/optimasi.json", "utf8"));
  const pva = (JSON.parse(readFileSync("hasil-eksperimen/prediksi-vs-nyata.json", "utf8")) as { tag: string }[]).filter((x) =>
    ["baseline", "opt", "v-semua", "v-rekom", "rekomendasi", "m-saja"].includes(x.tag),
  );
  const label = (k: string) => (k.startsWith("custom_") ? `Kustom ${k.slice(7, 15)}` : nodeLabel(k));

  const wb = new ExcelJS.Workbook();
  const head = (ws: import("exceljs").Worksheet, cols: { header: string; key: string; width: number }[]) => {
    ws.columns = cols;
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  const info = wb.addWorksheet("RINGKASAN");
  info.columns = [{ width: 34 }, { width: 90 }];
  const rows: [string, string][] = [
    ["PERINGATAN", "Anotasi & putusan dibuat oleh PENILAI AI SEMENTARA, bukan penilai manusia. Gunakan sebagai uji alur/gambaran awal; data TA final memakai penilai manusia."],
    ["Proyek", "BEM FTEIC ITS"],
    ["Model penghasil", String(process.env.LLM_MODEL)],
    ["Penilai", "AI-judge A (gemini-3.5-flash-lite — sama dengan model penghasil, risiko bias menilai diri sendiri); AI-judge B (gemini-3.1-flash-lite)"],
    ["Aturan putusan", "Galat sendiri = ada butir yang ditandai galat oleh KEDUA penilai AI; galat terbawa = ada induk yang bergalat"],
    ["Cohen's κ keseluruhan", `${params.kappa?.toFixed(3) ?? "–"} (n = ${params.kappaN} butir)`],
    ["Stabilitas QSPM (Kendall τ)", params.qspmTau ? `${params.qspmTau.tau.toFixed(2)} (${params.qspmTau.pairs} pasangan run)` : "–"],
    ["dʰ (ketelitian peninjau manusia)", String(opt.dh)],
    ["Anggaran optimasi", `${opt.budgetTok} token, ${opt.budgetMin} menit tinjauan`],
    ["P(bebas galat) tanpa pemeriksaan", `${(opt.baselineP * 100).toFixed(1)}%`],
    ["P(bebas galat) penempatan optimal", `${(opt.predictedP * 100).toFixed(1)}%`],
    ["Validator optimal di", Object.entries(opt.placement as Record<string, { validator: boolean }>).filter(([, c]) => c.validator).map(([k]) => label(k)).join(", ")],
    ["Rumus", "eᵢ′ = eᵢ·(1 − xᵢ·dᵢ·rᵢ)·(1 − yᵢ·dʰ);  P = Π(1 − eᵢ′);  Σ xᵢ·cᵢᵗᵒᵏ ≤ B_tok;  Σ yᵢ·cᵢᵐⁱⁿ ≤ B_min"],
  ];
  rows.forEach((r) => info.addRow(r));
  info.getColumn(1).font = { bold: true };
  info.getRow(1).font = { bold: true, color: { argb: "FFC00000" } };
  info.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const p = wb.addWorksheet("Parameter");
  head(p, [
    { header: "Analisis", key: "a", width: 34 }, { header: "e (galat mentah)", key: "e", width: 16 }, { header: "n (run berinput bersih)", key: "n", width: 12 },
    { header: "e Wilson bawah", key: "lo", width: 14 }, { header: "e Wilson atas", key: "hi", width: 14 }, { header: "d (deteksi)", key: "d", width: 12 },
    { header: "n suntikan", key: "dn", width: 11 }, { header: "r (perbaikan)", key: "r", width: 12 }, { header: "d·r", key: "dr", width: 10 },
    { header: "c_tok validator", key: "c", width: 14 }, { header: "κ penilai", key: "k", width: 10 }, { header: "n butir κ", key: "kn", width: 10 },
  ]);
  for (const s of params.stages) {
    const f = (x: number) => (Number.isFinite(x) ? x : null);
    p.addRow({ a: label(s.key), e: f(s.e.p), n: s.e.n, lo: s.e.n ? s.e.lo : null, hi: s.e.n ? s.e.hi : null, d: f(s.d.p), dn: s.d.n, r: f(s.r.p), dr: s.dr, c: Math.round(s.cTok), k: s.kappa, kn: s.kappaN });
  }
  for (const c of ["e", "lo", "hi", "d", "r", "dr"]) p.getColumn(c).numFmt = "0.0%";
  p.getColumn("k").numFmt = "0.00";

  const o = wb.addWorksheet("Optimasi");
  head(o, [{ header: "Analisis", key: "a", width: 34 }, { header: "e", key: "e", width: 10 }, { header: "d·r", key: "dr", width: 10 }, { header: "c_tok", key: "c", width: 10 }, { header: "Validator optimal", key: "v", width: 18 }]);
  for (const s of opt.stages) o.addRow({ a: label(s.key), e: s.e, dr: s.dr, c: Math.round(s.cTok), v: opt.placement[s.key]?.validator ? "YA" : "–" });
  o.getColumn("e").numFmt = "0.0%";
  o.getColumn("dr").numFmt = "0.0%";

  const pv = wb.addWorksheet("Prediksi vs nyata");
  head(pv, [{ header: "Tag", key: "t", width: 14 }, { header: "Run", key: "r", width: 8 }, { header: "Diputus", key: "a", width: 10 }, { header: "P nyata", key: "p", width: 10 }, { header: "Wilson bawah", key: "lo", width: 13 }, { header: "Wilson atas", key: "hi", width: 13 }, { header: "P prediksi", key: "pr", width: 12 }]);
  for (const x of pva as { tag: string; runs: number; annotated: number; actual: { p: number; lo: number; hi: number }; predicted: number }[])
    pv.addRow({ t: x.tag, r: x.runs, a: x.annotated, p: Number.isFinite(x.actual.p) ? x.actual.p : null, lo: x.actual.lo, hi: x.actual.hi, pr: x.predicted });
  for (const c of ["p", "lo", "hi", "pr"]) pv.getColumn(c).numFmt = "0.0%";

  const v = wb.addWorksheet("Putusan per run");
  head(v, [{ header: "Run", key: "run", width: 10 }, { header: "Tag", key: "tag", width: 10 }, { header: "Analisis", key: "a", width: 34 }, { header: "Galat sendiri", key: "own", width: 13 }, { header: "Galat terbawa", key: "car", width: 13 }, { header: "Diputus oleh", key: "by", width: 28 }]);
  const vr = await queryRows<{ run_id: string; tag: string; node_key: string; own_error: boolean; carried_error: boolean; decided_by: string }>(sql`
    SELECT nr.run_id, r.experiment_tag AS tag, nr.node_key, v.own_error, v.carried_error, v.decided_by
    FROM node_run_verdicts v JOIN node_runs nr ON nr.id = v.node_run_id JOIN runs r ON r.id = nr.run_id JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} ORDER BY r.created_at, nr.started_at`);
  for (const x of vr) v.addRow({ run: x.run_id.slice(0, 8), tag: x.tag, a: label(x.node_key), own: x.own_error ? "YA" : "–", car: x.carried_error ? "YA" : "–", by: x.decided_by });

  const a = wb.addWorksheet("Anotasi butir");
  head(a, [{ header: "Run", key: "run", width: 10 }, { header: "Analisis", key: "a", width: 30 }, { header: "Butir", key: "i", width: 12 }, { header: "Penilai", key: "j", width: 34 }, { header: "Galat?", key: "e", width: 8 }, { header: "Jenis", key: "t", width: 16 }, { header: "Alasan", key: "n", width: 90 }]);
  const ar = await queryRows<{ run_id: string; node_key: string; item_id: string; annotator: string; is_error: boolean; error_type: string | null; note: string | null }>(sql`
    SELECT nr.run_id, nr.node_key, an.item_id, an.annotator, an.is_error, an.error_type, an.note
    FROM annotations an JOIN node_runs nr ON nr.id = an.node_run_id JOIN runs r ON r.id = nr.run_id JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} AND an.annotator LIKE 'AI-judge%' ORDER BY r.created_at, nr.node_key, an.item_id, an.annotator`);
  for (const x of ar) {
    const row = a.addRow({ run: x.run_id.slice(0, 8), a: label(x.node_key), i: x.item_id, j: x.annotator, e: x.is_error ? "YA" : "–", t: x.error_type ?? "", n: x.note ?? "" });
    if (x.is_error) row.getCell("e").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD7D7" } };
  }
  a.autoFilter = { from: "A1", to: "G1" };

  const inj = wb.addWorksheet("Penyuntikan galat");
  head(inj, [{ header: "Analisis", key: "a", width: 30 }, { header: "Jenis galat", key: "t", width: 18 }, { header: "Butir", key: "i", width: 22 }, { header: "Terdeteksi", key: "d", width: 12 }, { header: "Diperbaiki", key: "r", width: 12 }]);
  const ir = await queryRows<{ node_key: string; error_type: string; item_id: string | null; detected: boolean; repaired: boolean | null }>(sql`
    SELECT node_key, error_type, item_id, detected, repaired FROM injections WHERE detected IS NOT NULL ORDER BY node_key, error_type`);
  for (const x of ir) inj.addRow({ a: label(x.node_key), t: x.error_type, i: x.item_id ?? "", d: x.detected ? "YA" : "TIDAK", r: x.detected ? (x.repaired ? "YA" : "TIDAK") : "–" });

  await wb.xlsx.writeFile("hasil-eksperimen/hasil-eksperimen.xlsx");
  console.log("Tersimpan: hasil-eksperimen/hasil-eksperimen.xlsx");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
