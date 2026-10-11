// npm run eksperimen:ai -- <tahap> [opsi]
// Eksperimen dengan PENILAI AI SEMENTARA (bukan manusia). Semua label/putusan diberi nama "AI-…" agar tidak tercampur
// dengan data penilai manusia. Tahap:
//   judge <tag> [ulang]    (ulang = daftar node dipisah koma untuk dinilai ulang) dua penilai AI (model berbeda dari model penghasil) menilai setiap butir output run bertag <tag>
//   verdict <tag>          putusan per node run: galat sendiri = ada butir yang ditandai galat oleh KEDUA penilai AI;
//                          galat terbawa = ada induk yang bergalat (sendiri/terbawa)
//   inject [per=2]         penyuntikan galat ke output baseline yang putusannya bersih → d (deteksi) dan r (perbaikan)
//   runs <tag> <opt|v-semua|v-rekom|canvas> [n=5]   buat & jalankan n run dengan penempatan hasil optimasi / validator di semua analisis
//   pasang-rekom [empiris] pasang validator/tinjauan flow rekomendasi (sweep.json) di canvas proyek
//   report                 hitung parameter, optimasi, prediksi vs nyata → hasil-eksperimen/*.json, *.xlsx, RINGKASAN.md
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

const PROJECT = process.env.EKSP_PROJECT ?? "94023829-4c5b-41ce-8809-7674e8a39c7d";
export const JUDGES = [
  { name: "AI-judge A (gemini-3.5-flash-lite)", model: "gemini-3.5-flash-lite" },
  { name: "AI-judge B (gemini-3.1-flash-lite)", model: "gemini-3.1-flash-lite" },
];
const CONCURRENCY = Number(process.env.EKSP_CONCURRENCY ?? 4);

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function db() {
  const { getDb, schema, queryRows } = await import("../lib/db/client");
  return { db: await getDb(), schema, queryRows };
}

async function runsOf(tag: string) {
  const { queryRows } = await db();
  const { sql } = await import("drizzle-orm");
  return queryRows<{ id: string; workflow_id: string }>(sql`
    SELECT r.id, r.workflow_id FROM runs r JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} AND r.experiment_tag = ${tag} ORDER BY r.created_at`);
}

// ---------- 1. Penilai AI ----------
async function judge(tag: string, ulang: string[] = []) {
  const { db: d, schema } = await db();
  const { and, eq, inArray, like } = await import("drizzle-orm");
  const { z } = await import("zod");
  const { getNode } = await import("../lib/nodes/registry");
  const { callLlm } = await import("../lib/llm/provider");
  const { DEFAULT_CODEBOOK, ERROR_TYPES } = await import("../lib/codebook");
  const runs = await runsOf(tag);
  if (!runs.length) throw new Error(`Tidak ada run bertag ${tag}`);
  const nrs = await d.select().from(schema.nodeRuns).where(and(inArray(schema.nodeRuns.runId, runs.map((r) => r.id)), eq(schema.nodeRuns.status, "done")));
  if (ulang.length) {
    // Nilai ulang: label AI lama untuk node ini dicadangkan ke berkas lalu dihapus (label manusia tidak disentuh).
    const { writeFileSync } = await import("node:fs");
    const target = nrs.filter((n) => ulang.includes(n.nodeKey)).map((n) => n.id);
    if (target.length) {
      const old = await d.select().from(schema.annotations).where(and(inArray(schema.annotations.nodeRunId, target), like(schema.annotations.annotator, "AI-judge%")));
      writeFileSync(`hasil-eksperimen/anotasi-lama-${tag}-${ulang.join("+")}-${Date.now()}.json`, JSON.stringify(old));
      await d.delete(schema.annotations).where(and(inArray(schema.annotations.nodeRunId, target), like(schema.annotations.annotator, "AI-judge%")));
      console.log(`Nilai ulang ${ulang.join(", ")}: ${old.length} label lama dicadangkan & dihapus`);
    }
  }
  const existing = await d.select({ nodeRunId: schema.annotations.nodeRunId, annotator: schema.annotations.annotator }).from(schema.annotations).where(inArray(schema.annotations.nodeRunId, nrs.map((n) => n.id)));
  const done = new Set(existing.map((e) => `${e.nodeRunId}|${e.annotator}`));
  const bool = z.union([z.boolean(), z.string(), z.number()]).transform((v) => v === true || v === 1 || /^(true|ya|yes|galat|1)$/i.test(String(v)));
  const Out = z.object({
    results: z.array(z.object({ id: z.coerce.string(), isError: bool, errorType: z.string().nullable().optional(), reason: z.string().nullable().optional() })),
  });
  const jobs: { nr: (typeof nrs)[number]; j: (typeof JUDGES)[number] }[] = [];
  for (const nr of nrs) {
    const def = getNode(nr.nodeKey);
    if (def.kind === "code") continue; // posisi organisasi & grand design dihitung program
    for (const j of JUDGES) if (!done.has(`${nr.id}|${j.name}`)) jobs.push({ nr, j });
  }
  console.log(`Penilaian AI: ${jobs.length} tugas (${nrs.length} node run × ${JUDGES.length} penilai, yang sudah ada dilewati)`);
  let ok = 0;
  let fail = 0;
  await pool(jobs, CONCURRENCY, async ({ nr, j }) => {
    const def = getNode(nr.nodeKey);
    let items: { id: string; text: string; detail?: string }[] = [];
    try {
      items = def.items(nr.output);
    } catch {
      /* output lama */
    }
    if (!items.length) return;
    const evidence = (nr.input?.evidence ?? []).map((c) => `[${c.id}] (${c.source}) ${c.content}`).join("\n\n").slice(0, 16000);
    // Hasil analisis sebelumnya (induk) yang dirujuk butir ini, mis. daftar faktor S/W/O/T untuk Matriks SWOT.
    // Tanpa ini penilai menandai rujukan "S1/O2" sebagai tidak didukung hanya karena tidak melihat daftarnya.
    const parentKeys = ((nr.input as { parents?: string[] } | null)?.parents ?? []).filter((k) => !k.startsWith("custom_"));
    const parentRuns = parentKeys.length
      ? await d.select().from(schema.nodeRuns).where(and(eq(schema.nodeRuns.runId, nr.runId), inArray(schema.nodeRuns.nodeKey, parentKeys)))
      : [];
    const parentText = parentRuns
      .map((p) => {
        try {
          return `## ${getNode(p.nodeKey).label}\n` + getNode(p.nodeKey).items(p.output).map((i) => `- ${i.id}: ${i.text}`).join("\n");
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 14000);
    const system = `Kamu PENILAI MUTU independen untuk analisis perencanaan strategis organisasi mahasiswa. Ikuti codebook berikut dengan ketat.
${DEFAULT_CODEBOOK.text}

Untuk SETIAP butir, putuskan isError (true/false) dan, bila galat, errorType salah satu dari: ${ERROR_TYPES.join(", ")}. Sertakan alasan singkat.
Nilai hanya isi butir itu berdasarkan dokumen sumber dan metode analisisnya. Jangan menilai format JSON. Bersikap seimbang: jangan menandai galat tanpa alasan jelas.
Balas HANYA JSON: {"results":[{"id":"<id butir>","isError":true|false,"errorType":"<jenis atau null>","reason":"<alasan>"}]}`;
    const user = `Analisis: ${def.label} — ${def.description}

Butir yang dinilai:
${items.map((i) => `- ${i.id}: ${i.text}${i.detail ? ` | ${i.detail}` : ""}`).join("\n").slice(0, 14000)}

Hasil analisis sebelumnya yang menjadi input (butir boleh merujuk ID di sini, mis. S1, O2, W3):
${parentText || "(tidak ada)"}

Potongan dokumen sumber yang dipakai analisis ini:
${evidence || "(tidak ada potongan dokumen; nilai berdasarkan hasil analisis sebelumnya di atas)"}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await callLlm(system, user, { model: j.model, temperature: 0 });
        const t = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
        const parsed = Out.parse(JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)));
        const ids = new Set(items.map((i) => i.id));
        const rows = parsed.results.filter((x) => ids.has(x.id));
        for (const it of items) if (!rows.some((x) => x.id === it.id)) rows.push({ id: it.id, isError: false, errorType: null, reason: "(tidak dinilai penilai AI; dianggap tidak galat)" });
        for (const x of rows)
          await d
            .insert(schema.annotations)
            .values({
              nodeRunId: nr.id,
              annotator: j.name,
              itemId: x.id,
              isError: x.isError,
              errorType: x.isError ? ((ERROR_TYPES as readonly string[]).includes(x.errorType ?? "") ? x.errorType! : "other") : null,
              note: `[penilai AI] ${x.reason ?? ""}`.slice(0, 1000),
            })
            .onConflictDoNothing();
        ok++;
        return;
      } catch (e) {
        if (attempt === 1) {
          fail++;
          console.warn(`  ✗ ${nr.nodeKey} (${j.name}): ${(e as Error).message.slice(0, 160)}`);
        }
      }
    }
  });
  console.log(`Selesai: ${ok} berhasil, ${fail} gagal.`);
}

// ---------- 2. Putusan dari konsensus dua penilai AI ----------
async function verdict(tag: string) {
  const { db: d, schema } = await db();
  const { eq, inArray, and } = await import("drizzle-orm");
  const { loadRunGraph } = await import("../lib/engine/run-workflow");
  const runs = await runsOf(tag);
  let n = 0;
  for (const r of runs) {
    const { graph } = await loadRunGraph(r.id);
    const nrs = await d.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, r.id));
    const ann = await d.select().from(schema.annotations).where(and(inArray(schema.annotations.nodeRunId, nrs.map((x) => x.id)), inArray(schema.annotations.annotator, JUDGES.map((j) => j.name))));
    const state = new Map<string, { own: boolean; carried: boolean }>();
    for (const key of graph.topoOrder()) {
      const nr = nrs.find((x) => x.nodeKey === key);
      if (!nr || nr.status !== "done") continue;
      const mine = ann.filter((a) => a.nodeRunId === nr.id);
      const byItem = new Map<string, Set<string>>();
      for (const a of mine) if (a.isError) byItem.set(a.itemId, (byItem.get(a.itemId) ?? new Set()).add(a.annotator));
      const own = [...byItem.values()].some((s) => s.size >= JUDGES.length); // konsensus: semua penilai AI menandai butir yang sama
      const carried = graph.parents(key).some((p) => state.get(p)?.own || state.get(p)?.carried);
      state.set(key, { own, carried });
      await d
        .insert(schema.nodeRunVerdicts)
        .values({ nodeRunId: nr.id, ownError: own, carriedError: carried, decidedBy: "AI (konsensus 2 penilai AI)" })
        .onConflictDoUpdate({ target: schema.nodeRunVerdicts.nodeRunId, set: { ownError: own, carriedError: carried, decidedBy: "AI (konsensus 2 penilai AI)" } });
      n++;
    }
  }
  console.log(`Putusan disimpan untuk ${n} node run (${runs.length} run bertag ${tag}).`);
}

// ---------- 3. Penyuntikan galat ----------
async function injectAll(per = 2) {
  const { db: d, schema } = await db();
  const { and, eq, inArray, isNotNull } = await import("drizzle-orm");
  const { getNode, NODE_KEYS } = await import("../lib/nodes/registry");
  const { injectorsFor } = await import("../lib/experiment/injectors");
  const { runInjection } = await import("../lib/experiment/run-injection");
  const runs = await runsOf("baseline");
  const clean = await d
    .select({ id: schema.nodeRuns.id, key: schema.nodeRuns.nodeKey, raw: schema.nodeRuns.raw, output: schema.nodeRuns.output })
    .from(schema.nodeRuns)
    .innerJoin(schema.nodeRunVerdicts, eq(schema.nodeRunVerdicts.nodeRunId, schema.nodeRuns.id))
    .where(and(inArray(schema.nodeRuns.runId, runs.map((r) => r.id)), eq(schema.nodeRunVerdicts.ownError, false), eq(schema.nodeRunVerdicts.carriedError, false)));
  const prior = await d
    .select({ key: schema.injections.nodeKey, type: schema.injections.errorType })
    .from(schema.injections)
    .where(and(inArray(schema.injections.nodeKey, [...NODE_KEYS]), isNotNull(schema.injections.detected)));
  const jobs: { id: string; key: string; type: string; seed: number }[] = [];
  for (const key of NODE_KEYS) {
    const def = getNode(key);
    if (def.kind === "code" || !def.validate) continue;
    const pool_ = clean.filter((c) => c.key === key);
    if (!pool_.length) continue;
    const types = injectorsFor(pool_[0].raw ?? pool_[0].output).map((i) => i.type);
    for (const type of types) {
      // Bobot stakeholder dihitung per kelompok; membalik pasangan lintas kelompok tidak berdampak → tidak diukur.
      if (key.startsWith("stakeholder_") && type === "ahp_inconsistent") continue;
      const have = prior.filter((p) => p.key === key && p.type === type).length;
      for (let k = have; k < per; k++) jobs.push({ id: pool_[k % pool_.length].id, key, type, seed: 100 + k });
    }
  }
  console.log(`Penyuntikan: ${jobs.length} percobaan`);
  await pool(jobs, Math.max(1, CONCURRENCY - 1), async (j) => {
    try {
      const r = await runInjection(j.id, j.type, { seed: j.seed });
      console.log(`  ${j.key.padEnd(22)} ${j.type.padEnd(18)} terdeteksi=${r.detected} diperbaiki=${r.repaired}`);
    } catch (e) {
      console.warn(`  ✗ ${j.key} ${j.type}: ${(e as Error).message.slice(0, 140)}`);
    }
  });
}

// ---------- 4. Run pembuktian ----------
async function runs(tag: string, kind: string, n = 5) {
  const { createRun, executeStep } = await import("../lib/engine/run-workflow");
  const { getCanvas } = await import("../lib/engine/main-run");
  const { engineGraph } = await import("../lib/engine/canvas");
  const wf = await getCanvas(PROJECT);
  const keys = engineGraph(wf.graph).nodes.map((x) => x.key!);
  let placement: Record<string, { validator: boolean; human: boolean }> | undefined;
  // "canvas": ikut validator/tinjauan yang terpasang di canvas; tinjauan dilakukan manusia di aplikasi.
  if (kind === "canvas") placement = undefined;
  else if (kind === "v-semua") placement = Object.fromEntries(keys.map((k) => [k, { validator: true, human: false }]));
  else if (kind === "v-rekom") {
    // Bagian validator dari flow rekomendasi (hasil sweep), tanpa tinjauan manusia.
    const { readFileSync } = await import("node:fs");
    const v = (JSON.parse(readFileSync("hasil-eksperimen/sweep.json", "utf8")) as { rekomendasi: { place: { validator: string[] } } }).rekomendasi.place.validator;
    placement = Object.fromEntries(keys.map((k) => [k, { validator: v.includes(k), human: false }]));
  } else {
    const { readFileSync } = await import("node:fs");
    const opt = JSON.parse(readFileSync("hasil-eksperimen/optimasi.json", "utf8")) as { placement: Record<string, { validator: boolean; human: boolean }> };
    placement = Object.fromEntries(keys.map((k) => [k, { validator: !!opt.placement[k]?.validator, human: false }]));
  }
  const existing = await runsOf(tag);
  const created = [];
  for (let i = existing.length; i < n; i++) created.push(await createRun({ workflowId: wf.id, experimentTag: tag, placement, mode: "manual", createdBy: "eksperimen-ai" }));
  const all = [...existing.map((r) => r.id), ...created.map((r) => r.id)];
  console.log(`Menjalankan ${all.length} run bertag ${tag}`);
  await pool(all, 3, async (id) => {
    const { readyNodes } = await import("../lib/engine/run-workflow");
    const readyAny = async (rid: string) => (await readyNodes(rid)).length > 0;
    for (let step = 0; step < 80; step++) {
      const r = await executeStep(id, {});
      if (r.ran) console.log(`  ${id.slice(0, 8)} ${String(r.ran).padEnd(28)} ${r.status}`);
      if (!r.ran) {
        // Run berhenti di titik tinjauan: tunggu peninjau manusia menyetujui/menolak di aplikasi, lalu lanjut.
        const { getDb, schema } = await import("../lib/db/client");
        const { and, eq } = await import("drizzle-orm");
        const d = await getDb();
        const waiting = await d.select({ k: schema.nodeRuns.nodeKey }).from(schema.nodeRuns).where(and(eq(schema.nodeRuns.runId, id), eq(schema.nodeRuns.status, "needs_review")));
        if (kind !== "canvas" || !waiting.length) break;
        console.log(`  ${id.slice(0, 8)} menunggu tinjauan: ${waiting.map((w) => w.k).join(", ")}`);
        while ((await d.select({ k: schema.nodeRuns.id }).from(schema.nodeRuns).where(and(eq(schema.nodeRuns.runId, id), eq(schema.nodeRuns.status, "needs_review")))).length && !(await readyAny(id)))
          await new Promise((res) => setTimeout(res, 15000));
        step--;
        continue;
      }
      // Jangan mengulang node gagal di loop yang sama: tiap ulangan memakan kuota harian (mis. 429 kuota habis).
      if (r.status === "failed") {
        console.log(`  ${id.slice(0, 8)} berhenti: ${r.ran} gagal — jalankan ulang perintah ini nanti untuk melanjutkan`);
        break;
      }
    }
  });
}

// ---------- 4b. Pasang flow rekomendasi di canvas ----------
// Menambah elemen validator/tinjauan sesuai hasil-eksperimen/sweep.json (rekomendasi). Canvas lama dicadangkan dulu.
async function pasangRekom(sumber = "sweep.json") {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { eq } = await import("drizzle-orm");
  const { getCanvas } = await import("../lib/engine/main-run");
  const { canvasNodeOf, attachedChecks, labelOf } = await import("../lib/engine/canvas");
  const { db: d, schema } = await db();
  const wf = await getCanvas(PROJECT);
  writeFileSync(`hasil-eksperimen/canvas-sebelum-rekom-${Date.now()}.json`, JSON.stringify(wf.graph, null, 1));
  const place = (JSON.parse(readFileSync(`hasil-eksperimen/${sumber}`, "utf8")) as { rekomendasi: { place: { validator: string[]; human: string[] } } }).rekomendasi.place;
  let g = { nodes: [...wf.graph.nodes], edges: [...wf.graph.edges] };
  // Lepas validator/tinjauan yang tidak lagi direkomendasikan.
  for (const n of wf.graph.nodes) {
    const key = n.type === "process" ? (await import("../lib/engine/canvas")).processKeyOf(n) : null;
    if (!key) continue;
    const att = attachedChecks(g, n.id);
    for (const [type, el, keep] of [["validator", att.validator, place.validator.includes(key)], ["review", att.review, place.human.includes(key)]] as const)
      if (el && !keep) {
        g = { nodes: g.nodes.filter((x) => x.id !== el.id), edges: g.edges.filter((e) => e.from !== el.id && e.to !== el.id) };
        console.log(`  - ${type} di ${key}`);
      }
  }
  const add = (key: string, type: "validator" | "review", dy: number) => {
    const n = canvasNodeOf(g, key);
    if (!n) return console.warn(`  ! ${key} tidak ada di canvas`);
    if (attachedChecks(g, n.id)[type === "validator" ? "validator" : "review"]) return console.log(`  = ${key}: ${type} sudah ada`);
    const id = `${type === "validator" ? "val" : "rev"}-${key}`;
    const pos = n.position ?? { x: 0, y: 0 };
    g.nodes.push({ id, type, label: `${type === "validator" ? "Validator" : "Tinjau"} ${labelOf(g, key)}`, position: { x: pos.x + 40, y: pos.y + dy } });
    g.edges.push({ from: n.id, to: id });
    console.log(`  + ${type} di ${key}`);
  };
  for (const k of place.validator) add(k, "validator", 60);
  for (const k of place.human) add(k, "review", place.validator.includes(k) ? 110 : 60);
  await d.update(schema.workflows).set({ graph: g }).where(eq(schema.workflows.id, wf.id));
  console.log("Canvas diperbarui.");
}

// ---------- 5. Rekap ----------
async function report() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { computeParameters, toStages, predictedVsActual } = await import("../lib/experiment/parameters");
  const { optimizeDP } = await import("../lib/experiment/optimize");
  const { predictP } = await import("../lib/experiment/propagation");
  const { nodeLabel } = await import("../lib/nodes/meta");
  mkdirSync("hasil-eksperimen", { recursive: true });
  const params = await computeParameters({});
  // Menit tinjauan yang belum terukur (0) memakai asumsi 5 menit agar tinjauan tidak dianggap gratis.
  const stages = toStages(params.stages).map((s) => ({ ...s, cMin: s.cMin > 0 ? s.cMin : 5 }));
  const dh = params.dh;
  const budgetTok = Number(process.env.EKSP_BUDGET_TOK ?? 30000);
  const best = optimizeDP(stages, dh, budgetTok, 0, 500);
  writeFileSync("hasil-eksperimen/parameter.json", JSON.stringify(params, null, 1));
  writeFileSync("hasil-eksperimen/optimasi.json", JSON.stringify({ budgetTok, budgetMin: 0, dh, placement: best.place, predictedP: best.p, baselineP: predictP(stages, {}, dh), stages }, null, 1));
  const pva = await predictedVsActual(stages, dh);
  writeFileSync("hasil-eksperimen/prediksi-vs-nyata.json", JSON.stringify(pva, null, 1));

  const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(1)}%`);
  const lines: string[] = [];
  lines.push(`# Hasil eksperimen (PENILAI AI SEMENTARA — bukan penilai manusia)`, "");
  lines.push(`Proyek BEM FTEIC ITS · model penghasil ${process.env.LLM_MODEL} · penilai: ${JUDGES.map((j) => j.name).join(", ")} · dibuat ${new Date().toISOString()}`, "");
  lines.push(`Kesepakatan penilai AI (Cohen's κ keseluruhan): ${params.kappa?.toFixed(3) ?? "–"} (n=${params.kappaN}) · dʰ = ${dh} · stabilitas QSPM (Kendall τ) = ${params.qspmTau ? params.qspmTau.tau.toFixed(2) : "–"}`, "");
  lines.push(`## Parameter per analisis`, "", `| Analisis | eᵢ (galat mentah) | n | Wilson 95% | dᵢ | rᵢ | dᵢ·rᵢ | cᵢᵗᵒᵏ | κ |`, `|---|---|---|---|---|---|---|---|---|`);
  for (const s of params.stages) {
    const w = s.e;
    lines.push(`| ${nodeLabel(s.key)} | ${pct(w.p)} | ${w.n} | ${w.n ? `${pct(w.lo)}–${pct(w.hi)}` : "–"} | ${pct(s.d.p)} | ${pct(s.r.p)} | ${pct(s.dr)} | ${Math.round(s.cTok)} | ${s.kappa?.toFixed(2) ?? "–"} |`);
  }
  lines.push("", `## Optimasi (anggaran ${budgetTok} token, 0 menit tinjauan)`, "", `P(bebas galat) tanpa pemeriksaan: ${pct(predictP(stages, {}, dh))} → dengan penempatan optimal: ${pct(best.p)}`, "");
  lines.push(`Validator dipasang di: ${Object.entries(best.place).filter(([, c]) => c.validator).map(([k]) => nodeLabel(k)).join(", ") || "(tidak ada)"}`, "");
  lines.push(`## Prediksi vs nyata`, "", `| Tag | run | diputus | P nyata | Wilson 95% | P prediksi |`, `|---|---|---|---|---|---|`);
  for (const r of pva.filter((x) => ["baseline", "opt", "v-semua", "v-rekom", "rekomendasi", "m-saja"].includes(x.tag))) lines.push(`| ${r.tag} | ${r.runs} | ${r.annotated} | ${pct(r.actual.p)} | ${pct(r.actual.lo)}–${pct(r.actual.hi)} | ${pct(r.predicted)} |`);
  writeFileSync("hasil-eksperimen/RINGKASAN.md", lines.join("\n"));
  console.log(lines.join("\n"));
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "judge") await judge(a ?? "baseline", b ? b.split(",") : []);
  else if (cmd === "verdict") await verdict(a ?? "baseline");
  else if (cmd === "inject") await injectAll(Number(a ?? 2));
  else if (cmd === "runs") await runs(a, b ?? "opt", Number(c ?? 5));
  else if (cmd === "pasang-rekom") await pasangRekom(a === "empiris" ? "sweep-empiris.json" : "sweep.json");
  else if (cmd === "report") await report();
  else throw new Error("Tahap: judge | verdict | inject | runs | report");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
