// npm run smoke — uji asap mesin end-to-end dalam mode mock (tanpa API key):
// kasus sintetis + canvas templat ringkas ("mvp": ES + SGS) → run dengan validator di semua analisis → putusan bersih
// → penyuntikan galat GENERIK pada matriks SWOT dan QSPM → parameter → optimasi (deterministik) → kompilasi + ekspor.
// Set SMOKE_REAL_LLM=1 untuk memakai penyedia LLM dari .env.local.
import { config } from "dotenv";
config({ path: ".env.local" });
config();
if (!process.env.SMOKE_REAL_LLM) process.env.LLM_PROVIDER = "mock";

async function main() {
  const { getDb, schema } = await import("../lib/db/client");
  const { eq } = await import("drizzle-orm");
  const { createSyntheticCase } = await import("../lib/seed/create");
  const { templateGraph, engineGraph } = await import("../lib/engine/canvas");
  const { createRun, executeStep } = await import("../lib/engine/run-workflow");
  const { runInjection } = await import("../lib/experiment/run-injection");
  const { INJECTORS } = await import("../lib/experiment/injectors");
  const { computeParameters, toStages } = await import("../lib/experiment/parameters");
  const { optimize, optimizeDP } = await import("../lib/experiment/optimize");
  const { NODE_KEYS } = await import("../lib/nodes/registry");
  const { bestPlacement } = await import("../components/canvas/report-utils");

  const db = await getDb();
  const project = await createSyntheticCase();
  // Canvas templat ringkas: ID node input sama dengan templat lengkap, jadi dokumen sintetis tetap tersambung.
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.projectId, project.id));
  const graph = templateGraph("mvp");
  await db.update(schema.workflows).set({ graph }).where(eq(schema.workflows.id, wf.id));
  const keys = engineGraph(graph).nodes.map((n) => n.key!);
  console.log(`  proyek ${project.name}: ${keys.length} analisis (${keys.join(", ")})`);

  const placement = Object.fromEntries(keys.map((k) => [k, { validator: true, human: false }]));
  const run = await createRun({ workflowId: wf.id, experimentTag: "smoke-val-all", placement });

  for (let i = 0; i < 60; i++) {
    const r = await executeStep(run.id, {});
    if (!r.ran) break;
    console.log(`  ${r.ran.padEnd(22)} → ${r.status}`);
  }
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, run.id));
  for (const n of nrs) {
    if (n.status !== "done") console.log(`  ! ${n.nodeKey}: ${n.status} ${n.error ?? ""}`);
    if (n.validationPassed === false) {
      const ev = await db.select().from(schema.validationEvents).where(eq(schema.validationEvents.nodeRunId, n.id));
      console.log(`  ! validasi gagal ${n.nodeKey}:`, JSON.stringify(ev.filter((e) => !e.passed).map((e) => e.detail)).slice(0, 600));
    }
  }

  const ranking = (nrs.find((n) => n.nodeKey === "qspm")?.output as { ranking?: { id: string; rank: number; tas: number; text: string }[] } | undefined)?.ranking;
  console.log("  QSPM (peringkat):");
  for (const r of [...(ranking ?? [])].sort((a, b) => a.rank - b.rank).slice(0, 8)) console.log(`    ${r.rank}. ${r.id} TAS=${r.tas?.toFixed?.(3)} ${String(r.text).slice(0, 100)}`);

  // Putusan bersih untuk semua node, lalu suntik setiap jenis galat generik ke matriks SWOT dan QSPM.
  for (const n of nrs) await db.insert(schema.nodeRunVerdicts).values({ nodeRunId: n.id, ownError: false, carriedError: false });
  for (const key of ["swot_matrix", "qspm"]) {
    const nr = nrs.find((n) => n.nodeKey === key);
    if (!nr || nr.status !== "done") {
      console.log(`  injeksi ${key} dilewati: analisis belum selesai`);
      continue;
    }
    const raw = nr.raw ?? nr.output;
    for (const inj of INJECTORS) {
      if (!inj.applicable(raw)) {
        console.log(`  injeksi ${key}/${inj.type}: tidak berlaku untuk output ini`);
        continue;
      }
      try {
        const res = await runInjection(nr.id, inj.type, { seed: 3 });
        console.log(`  injeksi ${key}/${inj.type} @ ${res.location}: detected=${res.detected} repaired=${res.repaired}`);
      } catch (e) {
        console.log(`  injeksi ${key}/${inj.type} dilewati: ${(e as Error).message}`);
      }
    }
  }

  const params = await computeParameters();
  console.log(
    "  parameter:",
    params.stages
      .filter((s) => s.cTok || s.d.n)
      .map((s) => `${s.key} d=${Number.isFinite(s.d.p) ? s.d.p.toFixed(2) : "-"} r=${Number.isFinite(s.r.p) ? s.r.p.toFixed(2) : "-"} cTok=${s.cTok}`)
      .join(" | "),
    `qspmTau=${params.qspmTau ? params.qspmTau.tau.toFixed(2) : "-"}`,
  );
  void toStages;

  // Contoh angka brief: optimize dan optimizeDP harus sama.
  const stages = [
    { key: "swot_matrix", e: 0.2, dr: 0.6, cTok: 3000, cMin: 8 },
    { key: "qspm", e: 0.06, dr: 0.5, cTok: 1500, cMin: 3 },
    { key: "cascading", e: 0.13, dr: 0.8, cTok: 2500, cMin: 6 },
  ];
  const a = optimize(stages, 0.85, 3000, 8);
  const b = optimizeDP(stages, 0.85, 3000, 8);
  console.log(`  optimize P=${a.p.toFixed(3)} DP P=${b.p.toFixed(3)}`, JSON.stringify(a.place));

  // Laporan: optimasi seluruh alur (22 analisis) harus cepat dan memberi hasil yang sama bila diulang.
  const all = NODE_KEYS.filter((k) => k !== "grand_design").map((k, i) => ({ key: k, e: 0.05 + (i % 5) * 0.03, dr: 0.6, cTok: 1500, cMin: 5 }));
  const t0 = Date.now();
  const r1 = bestPlacement(all, 0.85, 6000, 20);
  const r2 = bestPlacement(all, 0.85, 6000, 20);
  console.log(`  laporan: ${all.length} analisis, P=${r1.p.toFixed(3)}, ${Date.now() - t0} ms, stabil=${JSON.stringify(r1.place) === JSON.stringify(r2.place)}`);

  try {
    const { composeGrandDesign } = await import("../lib/grand-design/compose");
    const { grandDesignDocx } = await import("../lib/export/docx");
    const doc = await composeGrandDesign(run.id);
    const docx = await grandDesignDocx(doc);
    console.log(`  ekspor: docx ${docx.length} B`);
  } catch (e) {
    console.log("  kompilasi/ekspor grand design gagal:", (e as Error).message.slice(0, 200));
  }
  try {
    // @react-pdf memakai ESM murni; di luar Next (tsx) impor ini bisa gagal — ekspor PDF tetap diuji lewat route.
    const { composeGrandDesign } = await import("../lib/grand-design/compose");
    const { grandDesignPdf } = await import("../lib/export/pdf");
    const pdf = await grandDesignPdf(await composeGrandDesign(run.id));
    console.log(`  ekspor: pdf ${pdf.length} B`);
  } catch (e) {
    console.log("  ekspor pdf dilewati di tsx:", (e as Error).message.slice(0, 120));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
