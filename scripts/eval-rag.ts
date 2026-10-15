// npm run eval:rag -- <tahap>
// Evaluasi RAG (retrieval + grounding) untuk proyek eksperimen. Hasil di hasil-eksperimen/rag/.
//   label      dua penilai AI menandai paragraf dokumen yang relevan untuk setiap kueri analisis (set uji; label "AI-judge")
//   eval       ablasi: ukuran potongan × tumpang-tindih × metode (vektor, kata kunci, hybrid) × k → recall@k, precision@k, MRR
//   rerank     reranking oleh LLM atas kandidat hybrid (konfigurasi terpilih)
//   grounding  keterlekatan pada bukti dari run eksperimen yang sudah ada (kutipan persis, rujukan dari bukti, klaim didukung)
//   report     ringkasan → hasil-eksperimen/rag/RINGKASAN-RAG.md + ringkasan.json
// Label relevansi dibuat per PARAGRAF (bukan per potongan) agar berlaku untuk ukuran potongan apa pun:
// sebuah potongan dianggap relevan bila memuat paragraf yang relevan.
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const PROJECT = process.env.EKSP_PROJECT ?? "94023829-4c5b-41ce-8809-7674e8a39c7d";
const DIR = "hasil-eksperimen/rag";
const JUDGES = [
  { name: "AI-judge A (gemini-3.5-flash-lite)", model: "gemini-3.5-flash-lite" },
  { name: "AI-judge B (gemini-3.1-flash-lite)", model: "gemini-3.1-flash-lite" },
];
const RERANK_MODEL = process.env.LLM_MODEL || "gemini-3.5-flash-lite";
const VARIANTS = [
  { target: 400, overlap: 0 },
  { target: 400, overlap: 100 },
  { target: 800, overlap: 0 },
  { target: 800, overlap: 100 }, // konfigurasi platform sekarang
  { target: 1200, overlap: 0 },
  { target: 1200, overlap: 100 },
];
const KS = [3, 5, 8];
const RERANK_VARIANTS = ["800/100"]; // satu konfigurasi (konfigurasi platform) agar kuota harian cukup
const TAGS = ["baseline", "opt", "v-semua", "v-rekom", "rekomendasi"];

type Query = { id: string; nodeKey: string; label: string; description: string; focus: string; text: string; k: number; valuesOnly: boolean };
type Unit = { id: string; doc: number; para: number; filename: string; text: string; isValues: boolean };
type Labels = Record<string, Record<string, Record<string, number>>>; // judge → queryId → unitId → skor (1|2)

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const fs = () => import("node:fs");
async function readJson<T>(name: string, fallback: T): Promise<T> {
  const f = await fs();
  return f.existsSync(`${DIR}/${name}`) ? (JSON.parse(f.readFileSync(`${DIR}/${name}`, "utf8")) as T) : fallback;
}
async function writeJson(name: string, x: unknown) {
  const f = await fs();
  f.mkdirSync(DIR, { recursive: true });
  f.writeFileSync(`${DIR}/${name}`, JSON.stringify(x, null, 1));
}
function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

// ---------- Korpus dan kueri ----------
async function corpus() {
  const { getDb, schema } = await import("../lib/db/client");
  const { and, asc, eq, isNotNull } = await import("drizzle-orm");
  const { paragraphsOf } = await import("../lib/rag/chunk");
  const db = await getDb();
  const docs = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.projectId, PROJECT), isNotNull(schema.documents.reviewedAt)))
    .orderBy(asc(schema.documents.createdAt));
  const units: Unit[] = [];
  docs.forEach((d, i) => paragraphsOf(d.rawText).forEach((p, j) => units.push({ id: `D${i + 1}P${j + 1}`, doc: i + 1, para: j + 1, filename: d.filename, text: p, isValues: d.isValues })));
  return { docs, units };
}

async function queries(): Promise<Query[]> {
  const cached = await readJson<Query[] | null>("kueri.json", null);
  if (cached) return cached;
  const { getCanvas, getMainRun } = await import("../lib/engine/main-run");
  const { getDb, schema } = await import("../lib/db/client");
  const { eq } = await import("drizzle-orm");
  const { loadContext } = await import("../lib/engine/run-node");
  const { resolveNode } = await import("../lib/engine/resolve");
  const wf = await getCanvas(PROJECT);
  const run = await getMainRun(wf.id);
  const db = await getDb();
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, run!.id));
  const out: Query[] = [];
  for (const nr of nrs) {
    const { ctx, graph } = await loadContext(nr.id);
    const { def, parents, label } = resolveNode(nr.nodeKey, graph);
    ctx.parents = parents;
    (def.queries?.(ctx) ?? []).forEach((q, i) =>
      out.push({ id: `${nr.nodeKey}#${i + 1}`, nodeKey: nr.nodeKey, label, description: def.description, focus: q.focus, text: q.text, k: q.k ?? 8, valuesOnly: !!q.valuesOnly }),
    );
  }
  await writeJson("kueri.json", out);
  return out;
}

// ---------- 1. Label relevansi ----------
async function label() {
  const { callLlm } = await import("../lib/llm/provider");
  const { units } = await corpus();
  const qs = await queries();
  const labels = await readJson<Labels>("label.json", {});
  const list = units.map((u) => `[${u.id}] (${u.filename}) ${u.text}`).join("\n");
  const system = `Kamu penilai relevansi untuk sistem pencarian dokumen (RAG) sebuah platform perencanaan strategis organisasi mahasiswa.
Tugas: dari daftar paragraf dokumen organisasi, pilih SEMUA paragraf yang memuat informasi yang berguna sebagai BUKTI untuk kebutuhan informasi yang diberikan.
Skor 2 = langsung memuat informasi yang dicari; skor 1 = berkaitan/pendukung. Paragraf yang tidak relevan JANGAN dicantumkan.
Nilai berdasarkan isi paragraf saja. Balas HANYA JSON: {"relevan":[{"id":"D1P2","skor":2}]}`;
  const jobs = JUDGES.flatMap((j) => qs.filter((q) => !labels[j.name]?.[q.id]).map((q) => ({ j, q })));
  console.log(`Label relevansi: ${jobs.length} tugas (${qs.length} kueri × ${JUDGES.length} penilai, ${units.length} paragraf)`);
  let done = 0;
  await pool(jobs, 3, async ({ j, q }) => {
    const user = `Analisis: ${q.label} — ${q.description}
Kebutuhan informasi (fokus "${q.focus}"): ${q.text}${q.valuesOnly ? "\n(Hanya dokumen nilai organisasi / AD-ART yang dicari.)" : ""}

Paragraf dokumen:
${list}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await callLlm(system, user, { model: j.model, temperature: 0 });
        const o = parseJson(r.text) as { relevan?: { id: string; skor: number | string }[] };
        const valid = new Set(units.map((u) => u.id));
        const m: Record<string, number> = {};
        for (const x of o.relevan ?? []) if (valid.has(String(x.id))) m[String(x.id)] = Math.max(1, Math.min(2, Number(x.skor) || 1));
        (labels[j.name] ??= {})[q.id] = m;
        if (++done % 10 === 0) {
          await writeJson("label.json", labels);
          console.log(`  ${done}/${jobs.length}`);
        }
        return;
      } catch (e) {
        if (attempt === 2) console.warn(`  ✗ ${q.id} (${j.name}): ${(e as Error).message.slice(0, 140)}`);
        else await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
  });
  await writeJson("label.json", labels);
  console.log("Label tersimpan.");
}

/** Paragraf relevan (konsensus: kedua penilai memberi skor ≥ 1) per kueri, dan kappa antarpenilai. */
async function gold() {
  const labels = await readJson<Labels>("label.json", {});
  const { units } = await corpus();
  const qs = await queries();
  const { cohenKappa } = await import("../lib/experiment/kappa");
  const [A, B] = JUDGES.map((j) => labels[j.name] ?? {});
  const goldOf: Record<string, Set<string>> = {};
  const a: boolean[] = [];
  const b: boolean[] = [];
  for (const q of qs) {
    if (!A[q.id] || !B[q.id]) continue;
    goldOf[q.id] = new Set(units.filter((u) => A[q.id][u.id] && B[q.id][u.id]).map((u) => u.id));
    for (const u of units) {
      a.push(!!A[q.id][u.id]);
      b.push(!!B[q.id][u.id]);
    }
  }
  return { goldOf, kappa: a.length ? cohenKappa(a, b) : null, pairs: a.length, judgedA: a.filter(Boolean).length, judgedB: b.filter(Boolean).length };
}

// ---------- 2. Ablasi retrieval ----------
type Chunk = { key: string; doc: number; paras: [number, number]; content: string; isValues: boolean };
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
const cosine = (x: number[], y: number[]) => {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) {
    d += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return d / (Math.sqrt(nx * ny) || 1);
};

async function buildIndex() {
  const { embed } = await import("../lib/llm/provider");
  const { chunkText } = await import("../lib/rag/chunk");
  const { docs } = await corpus();
  const qs = await queries();
  const qVec = await embed(qs.map((q) => q.text), "query");
  const index: Record<string, { chunks: Chunk[]; vecs: number[][] }> = {};
  for (const v of VARIANTS) {
    const name = `${v.target}/${v.overlap}`;
    const chunks: Chunk[] = docs.flatMap((d, i) =>
      chunkText(d.rawText, v).map((c) => ({ key: `${name}:D${i + 1}#${c.idx}`, doc: i + 1, paras: c.paragraphs, content: c.content, isValues: d.isValues })),
    );
    index[name] = { chunks, vecs: await embed(chunks.map((c) => c.content), "document") };
  }
  return { qs, qVec, index };
}

function rankVector(qv: number[], ix: { chunks: Chunk[]; vecs: number[][] }, valuesOnly: boolean) {
  return ix.chunks
    .map((c, i) => ({ c, s: cosine(qv, ix.vecs[i]) }))
    .filter((x) => !valuesOnly || x.c.isValues)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}
function rankKeyword(text: string, ix: { chunks: Chunk[] }, valuesOnly: boolean) {
  const qw = [...new Set(words(text))].map((w) => w.slice(0, 5));
  return ix.chunks
    .filter((c) => !valuesOnly || c.isValues)
    .map((c) => {
      const cw = words(c.content);
      return { c, s: qw.length ? qw.filter((w) => cw.some((x) => x.startsWith(w))).length / qw.length : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}
/** Reciprocal Rank Fusion (k = 60) dari peringkat vektor dan kata kunci. */
function rankHybrid(vec: Chunk[], kw: Chunk[]) {
  const score = new Map<string, { c: Chunk; s: number }>();
  const add = (list: Chunk[]) => list.forEach((c, r) => score.set(c.key, { c, s: (score.get(c.key)?.s ?? 0) + 1 / (60 + r + 1) }));
  add(vec);
  add(kw);
  return [...score.values()].sort((x, y) => y.s - x.s).map((x) => x.c);
}

const covers = (c: Chunk, unitId: string) => {
  const m = /^D(\d+)P(\d+)$/.exec(unitId)!;
  return c.doc === Number(m[1]) && Number(m[2]) >= c.paras[0] && Number(m[2]) <= c.paras[1];
};
function metrics(ranked: Chunk[], gold: Set<string>, k: number) {
  const top = ranked.slice(0, k);
  const covered = new Set([...gold].filter((u) => top.some((c) => covers(c, u))));
  const relevantChunks = top.filter((c) => [...gold].some((u) => covers(c, u)));
  const first = top.findIndex((c) => [...gold].some((u) => covers(c, u)));
  return {
    recall: gold.size ? covered.size / gold.size : 0,
    precision: top.length ? relevantChunks.length / top.length : 0,
    mrr: first >= 0 ? 1 / (first + 1) : 0,
    hit: first >= 0 ? 1 : 0,
    chars: top.reduce((a, c) => a + c.content.length, 0),
  };
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function evaluate(withRerank = false) {
  const { goldOf } = await gold();
  const { qs, qVec, index } = await buildIndex();
  const reranked = withRerank ? await readJson<Record<string, string[]>>("rerank.json", {}) : {};
  const rows: { variant: string; method: string; k: string; recall: number; precision: number; mrr: number; hit: number; chars: number; n: number }[] = [];
  const evalQs = qs.filter((q) => goldOf[q.id]?.size);
  const methods = ["vektor", "kata kunci", "hybrid", ...(withRerank ? ["hybrid + rerank"] : [])];
  for (const [name, ix] of Object.entries(index)) {
    for (const method of methods) {
      if (method === "hybrid + rerank" && !RERANK_VARIANTS.includes(name)) continue;
      for (const k of [...KS, "sama dengan platform"] as (number | string)[]) {
        const ms = evalQs.map((q) => {
          const i = qs.indexOf(q);
          const vec = rankVector(qVec[i], ix, q.valuesOnly);
          const kw = rankKeyword(q.text, ix, q.valuesOnly);
          let ranked = method === "vektor" ? vec : method === "kata kunci" ? kw : rankHybrid(vec, kw);
          if (method === "hybrid + rerank") {
            const order = reranked[`${name}|${q.id}`];
            if (order) ranked = [...order.map((key) => ranked.find((c) => c.key === key)!).filter(Boolean), ...ranked.filter((c) => !order.includes(c.key))];
          }
          return metrics(ranked, goldOf[q.id], typeof k === "number" ? k : q.k);
        });
        rows.push({
          variant: name,
          method,
          k: String(k),
          recall: mean(ms.map((m) => m.recall)),
          precision: mean(ms.map((m) => m.precision)),
          mrr: mean(ms.map((m) => m.mrr)),
          hit: mean(ms.map((m) => m.hit)),
          chars: mean(ms.map((m) => m.chars)),
          n: ms.length,
        });
      }
    }
  }
  await writeJson(withRerank ? "ablasi-rerank.json" : "ablasi.json", rows);
  const cur = rows.find((r) => r.variant === "800/100" && r.method === "vektor" && r.k === "sama dengan platform")!;
  console.log(`Kueri dievaluasi: ${evalQs.length} dari ${qs.length} (sisanya tanpa paragraf relevan menurut kedua penilai)`);
  console.log(`Konfigurasi platform (800/100, vektor, k sesuai analisis): recall ${cur.recall.toFixed(3)} precision ${cur.precision.toFixed(3)} MRR ${cur.mrr.toFixed(3)}`);
  const best = [...rows].filter((r) => r.k !== "sama dengan platform").sort((a, b) => b.recall + b.mrr - (a.recall + a.mrr))[0];
  console.log(`Terbaik (recall+MRR): ${best.variant} ${best.method} k=${best.k}: recall ${best.recall.toFixed(3)} precision ${best.precision.toFixed(3)} MRR ${best.mrr.toFixed(3)}`);
}

// ---------- 3. Rerank oleh LLM ----------
async function rerank() {
  const { callLlm } = await import("../lib/llm/provider");
  const { qs, qVec, index } = await buildIndex();
  const out = await readJson<Record<string, string[]>>("rerank.json", {});
  const jobs = RERANK_VARIANTS.flatMap((name) => qs.filter((q) => !out[`${name}|${q.id}`]).map((q) => ({ name, q })));
  console.log(`Rerank: ${jobs.length} kueri`);
  await pool(jobs, 3, async ({ name, q }) => {
    const ix = index[name];
    const i = qs.indexOf(q);
    const cand = rankHybrid(rankVector(qVec[i], ix, q.valuesOnly), rankKeyword(q.text, ix, q.valuesOnly)).slice(0, 15);
    const system = `Urutkan potongan dokumen dari yang PALING berguna sebagai bukti untuk kebutuhan informasi berikut. Balas HANYA JSON: {"urutan":["id1","id2",...]} memuat semua id.`;
    const user = `Kebutuhan informasi: ${q.text}\n\n${cand.map((c, n) => `[${n + 1}] ${c.content}`).join("\n\n")}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await callLlm(system, user, { model: RERANK_MODEL, temperature: 0 });
        const o = parseJson(r.text) as { urutan?: (string | number)[] };
        const order = (o.urutan ?? []).map((x) => cand[Number(String(x).replace(/\D/g, "")) - 1]?.key).filter((x): x is string => !!x);
        out[`${name}|${q.id}`] = [...new Set(order)];
        return;
      } catch (e) {
        if (attempt === 2) console.warn(`  ✗ rerank ${q.id}: ${(e as Error).message.slice(0, 120)}`);
        else await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
  });
  await writeJson("rerank.json", out);
  await evaluate(true);
}

// ---------- 4. Grounding dari run eksperimen ----------
async function grounding() {
  const { queryRows } = await import("../lib/db/client");
  const { sql } = await import("drizzle-orm");
  const chunkRows = await queryRows<{ label: string; content: string }>(sql`SELECT label, content FROM chunks WHERE project_id = ${PROJECT}`);
  const content = new Map(chunkRows.map((c) => [c.label, c.content]));
  const norm = (s: string) => s.toLowerCase().replace(/[“”"'‘’]/g, "").replace(/\s+/g, " ").trim();
  const nrs = await queryRows<{ id: string; tag: string; node_key: string; output: unknown; input: { evidence?: { id: string }[] } | null; validator_enabled: boolean }>(sql`
    SELECT nr.id, r.experiment_tag AS tag, nr.node_key, nr.output, nr.input, nr.validator_enabled
    FROM node_runs nr JOIN runs r ON r.id = nr.run_id JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} AND nr.status = 'done' AND r.experiment_tag IN (${sql.join(TAGS.map((t) => sql`${t}`), sql`, `)})`);
  type Acc = { cites: number; exact: number; inEvidence: number; unknown: number; evidence: number; used: number };
  const acc: Record<string, Acc> = {};
  const add = (k: string, f: (a: Acc) => void) => f((acc[k] ??= { cites: 0, exact: 0, inEvidence: 0, unknown: 0, evidence: 0, used: 0 }));
  for (const nr of nrs) {
    const ev = new Set((nr.input?.evidence ?? []).map((e) => e.id));
    const cited = new Set<string>();
    const walk = (x: unknown, d = 0) => {
      if (d > 14 || !x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach((v) => walk(v, d + 1));
      const o = x as Record<string, unknown>;
      if (typeof o.chunkId === "string" && /^C\d+$/.test(o.chunkId)) {
        const c = content.get(o.chunkId);
        const q = typeof o.quote === "string" ? o.quote : "";
        const keys = [nr.validator_enabled ? "dengan validator" : "tanpa validator", "semua"];
        cited.add(o.chunkId);
        for (const k of keys)
          add(k, (a) => {
            a.cites++;
            if (!c) a.unknown++;
            else if (q && norm(c).includes(norm(q))) a.exact++;
            if (ev.has(o.chunkId as string)) a.inEvidence++;
          });
      }
      for (const v of Object.values(o)) walk(v, d + 1);
    };
    walk(nr.output);
    for (const k of [nr.validator_enabled ? "dengan validator" : "tanpa validator", "semua"])
      add(k, (a) => {
        a.evidence += [...ev].filter((x) => /^C\d+$/.test(x)).length;
        a.used += [...cited].filter((x) => ev.has(x)).length;
      });
  }
  // Klaim tanpa dukungan dokumen menurut kedua penilai AI (run tanpa pemeriksaan = perilaku asli penyusun).
  const ann = await queryRows<{ v: boolean; n: number; unsupported: number }>(sql`
    WITH k AS (
      SELECT an.node_run_id, an.item_id, bool_and(an.is_error AND an.error_type = 'unsupported') AS uns, count(*) AS c
      FROM annotations an WHERE an.annotator LIKE 'AI-judge%' GROUP BY 1, 2 HAVING count(*) = 2)
    SELECT nr.validator_enabled AS v, count(*)::int AS n, count(*) FILTER (WHERE uns)::int AS unsupported
    FROM k JOIN node_runs nr ON nr.id = k.node_run_id JOIN runs r ON r.id = nr.run_id JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} AND r.experiment_tag IN (${sql.join(TAGS.map((t) => sql`${t}`), sql`, `)})
    GROUP BY 1`);
  const res = Object.fromEntries(
    Object.entries(acc).map(([k, a]) => [
      k,
      {
        kutipan: a.cites,
        kutipanPersis: a.exact / a.cites,
        rujukanDariBuktiYangDiambil: a.inEvidence / a.cites,
        rujukanTidakDikenal: a.unknown / a.cites,
        pemanfaatanBukti: a.evidence ? a.used / a.evidence : NaN,
      },
    ]),
  );
  const claims = Object.fromEntries(ann.map((r) => [r.v ? "dengan validator" : "tanpa validator", { butir: r.n, tanpaDukungan: r.unsupported, didukung: 1 - r.unsupported / r.n }]));
  await writeJson("grounding.json", { kutipan: res, klaim: claims, nodeRun: nrs.length });
  console.log(JSON.stringify({ kutipan: res, klaim: claims }, null, 1));
}

// ---------- 5. Ringkasan ----------
async function report() {
  const g = await gold();
  const qs = await queries();
  const { units, docs } = await corpus();
  const rows = await readJson<{ variant: string; method: string; k: string; recall: number; precision: number; mrr: number; hit: number; chars: number; n: number }[]>(
    (await fs()).existsSync(`${DIR}/ablasi-rerank.json`) ? "ablasi-rerank.json" : "ablasi.json",
    [],
  );
  const gr = await readJson<Record<string, unknown>>("grounding.json", {});
  const noGold = qs.filter((q) => g.goldOf[q.id] && !g.goldOf[q.id].size);
  const p = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "–");
  const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "–");
  const L: string[] = [];
  L.push(`# Evaluasi RAG — proyek BEM FTEIC ITS (dokumen dummy)`, "");
  L.push(`Korpus: ${docs.length} dokumen, ${units.length} paragraf. Set uji: ${qs.length} kueri dari ${new Set(qs.map((q) => q.nodeKey)).size} analisis.`);
  L.push(`Label relevansi: dua penilai AI (paragraf relevan = kedua penilai setuju). Cohen's κ = ${g.kappa?.toFixed(3) ?? "–"} (${g.pairs} pasangan kueri×paragraf).`);
  L.push(`Kueri tanpa paragraf relevan (dokumen tidak memuat informasinya): ${noGold.length} — ${noGold.map((q) => q.id).join(", ") || "-"}`, "");
  L.push(`| Potongan | Metode | k | Recall@k | Precision@k | MRR | Teks dikirim (karakter) |`, `|---|---|---|---|---|---|---|`);
  for (const r of rows) L.push(`| ${r.variant} | ${r.method} | ${r.k} | ${p(r.recall)} | ${p(r.precision)} | ${f3(r.mrr)} | ${Math.round(r.chars)} |`);
  L.push("", "## Grounding", "```json", JSON.stringify(gr, null, 1), "```");
  (await fs()).writeFileSync(`${DIR}/RINGKASAN-RAG.md`, L.join("\n"));
  await writeJson("ringkasan.json", { kappa: g.kappa, pairs: g.pairs, judgedA: g.judgedA, judgedB: g.judgedB, kueri: qs.length, tanpaGold: noGold.map((q) => q.id), paragraf: units.length, dokumen: docs.length, goldPerKueri: Object.fromEntries(Object.entries(g.goldOf).map(([k, v]) => [k, v.size])) });
  console.log(L.slice(0, 6).join("\n"));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "label") await label();
  else if (cmd === "eval") await evaluate();
  else if (cmd === "rerank") await rerank();
  else if (cmd === "grounding") await grounding();
  else if (cmd === "report") await report();
  else throw new Error("Tahap: label | eval | rerank | grounding | report");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
