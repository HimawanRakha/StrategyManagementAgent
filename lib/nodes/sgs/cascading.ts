// SGSCASCADING — VISI → Aspek Visi → Misi → Strategy Objectives (SO, index A.1) → Strategy Initiatives (SI, index A.1.1).
// SI diambil dari strategi QSPM berperingkat teratas (strategyRef = ID strategi). Visi/misi berpijak pada nilai organisasi (AD/ART).
import { z } from "zod";
import type { CascadingComputed } from "../contracts";
import { Evidence } from "../schemas";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { firstSentence } from "../heuristics";
import { checkQuotes, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { isObj, orderStrategies, QSPM_ORDER, qspmRankingOf, strategiesOf, type Inputs, type RankedStrategy } from "./common";

/** Banyaknya strategi peringkat teratas QSPM yang WAJIB menjadi Strategy Initiative. */
export const CASCADING_TOP_K = 5;

export const CascadingInitiativeRaw = z.object({
  /** Index SI, mis. "A.1.1". */
  id: z.string(),
  /** Strategy Initiative: kalimat AKTIF (tindakan yang dilaksanakan). */
  text: z.string(),
  /** ID strategi QSPM yang diturunkan, mis. "SO5"; null bila bukan dari QSPM. */
  strategyRef: z.string().nullable(),
});
export const CascadingObjectiveRaw = z.object({
  /** Index SO, mis. "A.1". */
  id: z.string(),
  /** Strategy Objective: hasil yang diharapkan (kalimat pasif/frasa hasil). */
  text: z.string(),
  initiatives: z.array(CascadingInitiativeRaw),
});
export const CascadingAspectRaw = z.object({
  /** "A", "B", "C". */
  id: z.string(),
  /** Aspek visi, mis. "STRATEGIS INTERNAL". */
  aspek: z.string(),
  misi: z.string(),
  objectives: z.array(CascadingObjectiveRaw),
  /** Bukti nilai organisasi untuk misi ini (opsional). */
  evidence: z.array(Evidence).default([]),
});
export const CascadingRaw = z.object({
  visi: z.string(),
  /** Bukti nilai organisasi (AD/ART) yang mendasari visi. */
  visiEvidence: z.array(Evidence).default([]),
  aspects: z.array(CascadingAspectRaw),
});
export type CascadingRaw = z.infer<typeof CascadingRaw>;

export type StrategyInfo = { id: string; type: string; text: string; rank: number | null; tas: number | null };
export type CascadingOutput = CascadingRaw &
  Omit<CascadingComputed, "aspects" | "visi"> & {
    /** Info strategi QSPM per ID (peringkat, total TAS). */
    strategies: Record<string, StrategyInfo>;
    topK: string[];
    /** Strategi top-k yang belum menjadi SI. */
    missingTop: string[];
    counts: { aspects: number; objectives: number; initiatives: number };
  };

// ---------- Compute ----------

function strategyPool(inputs: Inputs): StrategyInfo[] {
  const ranking = qspmRankingOf(inputs);
  if (ranking.length) return ranking.map((r) => ({ id: r.id, type: r.type, text: r.text, rank: r.rank, tas: r.tas }));
  return orderStrategies(strategiesOf(inputs), QSPM_ORDER).map((s) => ({ id: s.id, type: s.type, text: s.text, rank: null, tas: null }));
}

export const topKOf = (ranking: RankedStrategy[], k = CASCADING_TOP_K) => ranking.filter((r) => r.rank <= k).slice(0, Math.max(k, 0)).map((r) => r.id);

export function computeCascading(raw: CascadingRaw, inputs: Inputs): CascadingOutput {
  const pool = strategyPool(inputs);
  const ranking = qspmRankingOf(inputs);
  const topK = topKOf(ranking);
  const aspects = raw?.aspects ?? [];
  const used = new Set(aspects.flatMap((a) => a.objectives.flatMap((o) => o.initiatives.map((i) => i.strategyRef).filter((x): x is string => !!x))));
  return {
    ...raw,
    visi: raw?.visi ?? "",
    visiEvidence: raw?.visiEvidence ?? [],
    aspects,
    strategies: Object.fromEntries(pool.map((s) => [s.id, s])),
    topK,
    missingTop: topK.filter((id) => !used.has(id)),
    counts: {
      aspects: aspects.length,
      objectives: aspects.reduce((s, a) => s + a.objectives.length, 0),
      initiatives: aspects.reduce((s, a) => s + a.objectives.reduce((t, o) => t + o.initiatives.length, 0), 0),
    },
  };
}

const asOutput = (out: unknown, inputs: Inputs): CascadingOutput => {
  const o = isObj(out) ? (out as Partial<CascadingOutput>) : {};
  if (o.counts && o.strategies && Array.isArray(o.aspects)) return o as CascadingOutput;
  return computeCascading({ visi: String(o.visi ?? ""), visiEvidence: o.visiEvidence ?? [], aspects: Array.isArray(o.aspects) ? o.aspects : [] }, inputs);
};

// ---------- Prompt & mock ----------

function promptOf(ctx: NodeContext) {
  const pool = strategyPool(ctx.inputs);
  const top = topKOf(qspmRankingOf(ctx.inputs));
  return {
    system: `Kamu perencana strategis organisasi. Susun CASCADING: VISI → Aspek Visi → Misi → Strategy Objectives (SO) → Strategy Initiatives (SI), seperti tab SGSCASCADING.
Aturan:
1. VISI: satu kalimat kondisi ideal yang ingin dicapai, selaras dengan nilai organisasi (AD/ART) pada potongan dokumen. Bila ada potongan nilai organisasi, isi visiEvidence dengan kutipannya.
2. Pecah visi menjadi 2–4 ASPEK VISI (kata kunci visi, ditulis kapital, mis. "STRATEGIS INTERNAL", "REGENERASI"). ID aspek: A, B, C, D.
3. Setiap aspek punya SATU MISI (kalimat yang menjabarkan aspek itu, mis. "Mewujudkan …", "Membangun …"). Bukti nilai organisasi untuk misi boleh ditulis di evidence aspek.
4. Setiap aspek punya 1–3 STRATEGY OBJECTIVES (SO) dengan index A.1, A.2, B.1, …. SO = hasil yang diharapkan, ditulis sebagai KALIMAT PASIF atau frasa hasil (mis. "Penguatan tata kelola dan sistem kerja internal", "Terwujudnya …", "Meningkatnya …") — BUKAN kalimat perintah.
5. Setiap SO punya 1–4 STRATEGY INITIATIVES (SI) dengan index A.1.1, A.1.2, …. SI = tindakan yang akan dilaksanakan, ditulis sebagai KALIMAT AKTIF diawali kata kerja me- (mis. "Menyusun …", "Mengembangkan …").
6. SI diturunkan dari strategi QSPM: tulis ID strateginya di strategyRef; teks SI boleh disesuaikan agar menjadi tindakan yang jelas. WAJIB memuat strategi peringkat teratas: ${top.length ? top.join(", ") : "(QSPM belum ada — pakai strategi yang tersedia)"}. Strategi lain boleh dipakai bila relevan (utamakan peringkat tinggi; strategi peringkat terbawah boleh ditinggalkan). Satu strategi cukup dipakai sekali. strategyRef null hanya untuk inisiatif tambahan yang bukan dari QSPM (hindari).
7. Kelompokkan SI ke SO dan aspek yang paling sesuai isinya.
8. ${EVIDENCE_RULES}
9. ${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Strategi hasil QSPM (urut peringkat):
${pool.map((s) => `${s.id} [${s.type}]${s.rank !== null ? ` peringkat ${s.rank}, total TAS ${s.tas!.toFixed(3)}` : ""}: ${s.text}`).join("\n") || "(belum ada strategi)"}

Potongan dokumen (nilai organisasi / AD/ART):
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(CascadingRaw)}`,
  };
}

const ASPEK_MOCK = [
  { aspek: "TATA KELOLA INTERNAL", misi: "Mewujudkan tata kelola internal yang efektif, terintegrasi, dan adaptif.", so: "Penguatan tata kelola dan sistem kerja internal" },
  { aspek: "PENGEMBANGAN SUMBER DAYA", misi: "Membangun keberlanjutan organisasi melalui pengembangan kapasitas dan regenerasi pengurus.", so: "Peningkatan kapasitas dan keberlanjutan sumber daya organisasi" },
  { aspek: "PERAN EKSTERNAL", misi: "Membangun peran dan komunikasi organisasi yang relevan bagi pihak luar.", so: "Penguatan peran dan komunikasi eksternal organisasi" },
];

/** Ubah kalimat strategi menjadi kalimat aktif (mock): "Memanfaatkan …" tetap; selain itu diawali "Melaksanakan". */
const activeText = (s: string) => (/^me/i.test(s.trim()) ? s.trim() : `Melaksanakan ${s.trim().charAt(0).toLowerCase()}${s.trim().slice(1)}`);

export function mockCascading(ctx: Pick<NodeContext, "inputs" | "evidence" | "projectName" | "orgType">): CascadingRaw {
  const pool = strategyPool(ctx.inputs);
  const chosen = pool.slice(0, Math.max(CASCADING_TOP_K, Math.min(9, pool.length)));
  const nAsp = Math.min(3, Math.max(1, Math.ceil(chosen.length / 2)));
  const values = ctx.evidence.filter((c) => c.kind === "document");
  const valueChunk = values.find((c) => c.focus === "nilai") ?? values[0];
  const quote = valueChunk ? firstSentence(valueChunk.content) : null;
  const ev = quote && quote.length >= 10 ? [{ chunkId: valueChunk!.id, quote }] : [];
  const aspects = Array.from({ length: nAsp }, (_, a) => {
    const id = String.fromCharCode(65 + a);
    const mine = chosen.filter((_, k) => k % nAsp === a);
    const m = ASPEK_MOCK[a % ASPEK_MOCK.length];
    return {
      id,
      aspek: m.aspek,
      misi: m.misi,
      evidence: a === 0 ? ev : [],
      objectives: [
        {
          id: `${id}.1`,
          text: m.so,
          initiatives: (mine.length ? mine : [null]).map((s, k) => ({
            id: `${id}.1.${k + 1}`,
            text: s ? activeText(s.text) : "Menyusun rencana kerja aspek ini.",
            strategyRef: s ? s.id : null,
          })),
        },
      ],
    };
  });
  return {
    visi: `Menjadi ${ctx.projectName || ctx.orgType || "organisasi"} yang efektif secara internal, tangguh dalam regenerasi, dan berdampak bagi lingkungannya.`,
    visiEvidence: ev,
    aspects,
  };
}

// ---------- Validator ----------

const CHECKS = [
  { name: "ref_exists", kind: "code" as const, description: "Strategy Initiative merujuk strategi yang tidak ada di QSPM / matriks SWOT" },
  { name: "top_k_covered", kind: "code" as const, description: `Ada strategi peringkat 1–${CASCADING_TOP_K} QSPM yang belum diturunkan menjadi Strategy Initiative` },
  { name: "index_format", kind: "code" as const, description: "Index tidak sesuai format atau tidak berurutan (aspek A, SO A.1, SI A.1.1)" },
  { name: "quote_exists", kind: "code" as const, description: "Kutipan nilai organisasi tidak ditemukan di potongan dokumen yang dirujuk" },
  { name: "so_si_voice", kind: "llm" as const, description: "Strategy Objective tidak ditulis sebagai hasil (kalimat pasif) atau Strategy Initiative tidak ditulis sebagai tindakan (kalimat aktif)" },
];

export function cascadingCodeChecks(raw: CascadingRaw, ctx: Pick<NodeContext, "inputs" | "evidence">): CheckResult[] {
  const pool = strategyPool(ctx.inputs);
  const valid = new Set(pool.map((s) => s.id));
  const refs: Failure[] = [];
  const idx: Failure[] = [];
  const aspects = raw.aspects ?? [];
  const seen = new Set<string>();
  const dupId = (id: string) => {
    if (seen.has(id)) idx.push({ check: "index_format", itemId: id, message: `Index ${id} dipakai lebih dari sekali.` });
    seen.add(id);
  };
  aspects.forEach((a, ai) => {
    const want = String.fromCharCode(65 + ai);
    if (a.id !== want) idx.push({ check: "index_format", itemId: a.id, message: `Aspek ke-${ai + 1} seharusnya ber-ID "${want}" (tertulis "${a.id}").` });
    dupId(a.id);
    if (!a.objectives.length) idx.push({ check: "index_format", itemId: a.id, message: `Aspek ${a.id} belum punya Strategy Objective.` });
    a.objectives.forEach((o, oi) => {
      const wo = `${a.id}.${oi + 1}`;
      if (o.id !== wo) idx.push({ check: "index_format", itemId: o.id, message: `Index SO "${o.id}" seharusnya "${wo}".` });
      dupId(o.id);
      if (!o.initiatives.length) idx.push({ check: "index_format", itemId: o.id, message: `SO ${o.id} belum punya Strategy Initiative.` });
      o.initiatives.forEach((i, ii) => {
        const wi = `${o.id}.${ii + 1}`;
        if (i.id !== wi) idx.push({ check: "index_format", itemId: i.id, message: `Index SI "${i.id}" seharusnya "${wi}".` });
        dupId(i.id);
        if (i.strategyRef && valid.size && !valid.has(i.strategyRef))
          refs.push({ check: "ref_exists", itemId: i.id, message: `${i.id} merujuk strategi ${i.strategyRef} yang tidak ada di QSPM.` });
      });
    });
  });
  const used = new Set(aspects.flatMap((a) => a.objectives.flatMap((o) => o.initiatives.map((i) => i.strategyRef))));
  const top = topKOf(qspmRankingOf(ctx.inputs));
  const rank = new Map(qspmRankingOf(ctx.inputs).map((r) => [r.id, r.rank]));
  const cov: Failure[] = top
    .filter((id) => !used.has(id))
    .map((id) => ({ check: "top_k_covered", itemId: id, message: `Strategi ${id} (peringkat ${rank.get(id)} QSPM) belum diturunkan menjadi Strategy Initiative.` }));
  const quoted = [{ id: "VISI", evidence: raw.visiEvidence ?? [] }, ...aspects.map((a) => ({ id: `MISI ${a.id}`, evidence: a.evidence ?? [] }))].filter((x) => x.evidence.length);
  return [result("ref_exists", "code", refs), result("top_k_covered", "code", cov), result("index_format", "code", idx), checkQuotes(quoted, ctx.evidence)];
}

// ---------- Sheet ----------

const FILL = { head: "0B5394", row: "C0E4FF" };

export function cascadingSheet(o: CascadingOutput): Grid {
  const g = new GridBuilder("cascading", "SGSCASCADING", "Cascading");
  const options = Object.values(o.strategies).map((s) => ({ label: `${s.id}${s.rank !== null ? ` (peringkat ${s.rank})` : ""}`, value: s.id }));
  g.set(0, 0, "CASCADING", { style: "title", cs: 4 });
  g.set(2, 0, "VISI", { style: "header", rs: 2, center: true });
  g.set(2, 1, o.visi, {
    style: "label",
    rs: 2,
    cs: 6,
    src: "ai",
    refs: o.visiEvidence.map((e) => e.chunkId),
    note: o.visiEvidence.length ? `Nilai organisasi: ${o.visiEvidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join(" ")}` : undefined,
    edit: { path: ["visi"], type: "text" },
  });
  g.anchor("visi", 2, 1);
  g.row(5, 0, ["Aspek Visi", "Misi", "Index", "Strategy Objectives", "Index", "Strategy Initiatives", "Strategi QSPM"], { style: "header", fill: FILL.head });
  let r = 6;
  o.aspects.forEach((a, ai) => {
    const aRows = Math.max(1, a.objectives.reduce((s, ob) => s + Math.max(1, ob.initiatives.length), 0));
    g.set(r, 0, a.aspek, { style: "label", rs: aRows, fill: FILL.row, src: "ai", edit: { path: ["aspects", ai, "aspek"], type: "text" } });
    g.set(r, 1, a.misi, {
      style: "text",
      rs: aRows,
      fill: FILL.row,
      src: "ai",
      refs: (a.evidence ?? []).map((e) => e.chunkId),
      note: a.evidence?.length ? `Nilai organisasi: ${a.evidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join(" ")}` : undefined,
      edit: { path: ["aspects", ai, "misi"], type: "text" },
    });
    g.anchor(`misi_${a.id}`, r, 1);
    if (!a.objectives.length) {
      g.set(r, 2, "(belum ada SO)", { style: "muted", cs: 5 });
      r++;
      return;
    }
    a.objectives.forEach((ob, oi) => {
      const oRows = Math.max(1, ob.initiatives.length);
      g.set(r, 2, ob.id, { style: "label", rs: oRows, fill: FILL.row, center: true });
      g.set(r, 3, ob.text, { style: "text", rs: oRows, fill: FILL.row, src: "ai", edit: { path: ["aspects", ai, "objectives", oi, "text"], type: "text" } });
      if (!ob.initiatives.length) g.set(r, 4, "(belum ada SI)", { style: "muted", cs: 3 });
      ob.initiatives.forEach((it, ii) => {
        const s = it.strategyRef ? o.strategies[it.strategyRef] : undefined;
        const base = ["aspects", ai, "objectives", oi, "initiatives", ii] as (string | number)[];
        g.set(r + ii, 4, it.id, { style: "label", fill: FILL.row, center: true });
        g.set(r + ii, 5, it.text, { style: "text", fill: FILL.row, src: "ai", note: s ? `Dari strategi ${s.id}: ${s.text}` : undefined, edit: { path: [...base, "text"], type: "text" } });
        g.set(r + ii, 6, it.strategyRef ?? "", {
          fill: FILL.row,
          center: true,
          src: "ai",
          display: it.strategyRef ? `${it.strategyRef}${s?.rank ? ` · #${s.rank}` : s ? "" : " (tidak ada)"}` : "–",
          note: s ? `${s.id} [${s.type}]${s.rank !== null ? ` — peringkat ${s.rank} QSPM, total TAS ${num(s.tas)}` : ""}` : it.strategyRef ? "Strategi tidak ditemukan di QSPM." : "Bukan dari QSPM.",
          edit: { path: [...base, "strategyRef"], type: "select", options, allowEmpty: true },
        });
      });
      r += oRows;
    });
  });
  // Catatan karakteristik SO & SI (kolom I–J seperti Excel H5:I15)
  g.set(2, 8, "Notes:", { style: "label" });
  g.set(3, 8, "Karakteristik SO dan SI", { style: "subheader", cs: 2 });
  g.set(4, 8, "SO", { style: "label" });
  g.set(4, 9, "Menggunakan kalimat pasif karena bersifat menjadi sesuatu hal yang diharapkan.", { style: "text", src: "tetap" });
  g.set(5, 8, "SI", { style: "label" });
  g.set(5, 9, "Menggunakan kalimat aktif karena bersifat sebagai hal yang akan diterapkan/dilaksanakan.", { style: "text", src: "tetap" });
  if (o.missingTop.length) g.set(7, 8, `Strategi peringkat atas QSPM yang belum menjadi SI: ${o.missingTop.join(", ")}.`, { style: "note", cs: 2 });
  return g.build({
    cols: [20, 34, 8, 30, 9, 60, 14, 2, 10, 44],
    notes: [
      "Visi dipecah menjadi aspek; setiap aspek punya satu misi, lalu Strategy Objectives (SO, hasil yang diharapkan, index A.1) dan Strategy Initiatives (SI, tindakan, index A.1.1).",
      "SI diturunkan dari strategi QSPM berperingkat teratas; kolom \"Strategi QSPM\" menunjukkan asal dan peringkatnya.",
      "Semua teks bisa Anda ubah; rujukan strategi bisa diganti lewat pilihan.",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Index cascading",
    rumus: "Aspek = huruf (A); SO = aspek.nomor (A.1); SI = SO.nomor (A.1.1)",
    arti: "Setiap inisiatif bisa ditelusuri ke tujuan, misi, dan aspek visi di atasnya.",
  },
  {
    name: "Cakupan strategi",
    rumus: `Strategi peringkat 1–${CASCADING_TOP_K} QSPM wajib menjadi SI`,
    arti: "Strategi yang paling menarik menurut QSPM harus benar-benar dijalankan.",
  },
];

export const cascading: NodeDef<CascadingRaw> = {
  key: "cascading",
  label: "Cascading visi–misi",
  phase: 1,
  group: "sgs",
  sheetName: "SGSCASCADING",
  deps: ["qspm"],
  kind: "llm",
  computedBy: "LLM menyusun visi, misi, SO, SI; kode memeriksa index dan cakupan strategi QSPM",
  description:
    "Menurunkan visi menjadi aspek visi, misi, Strategy Objectives (hasil, kalimat pasif) dan Strategy Initiatives (tindakan, kalimat aktif) dari strategi QSPM berperingkat teratas, berpijak pada nilai organisasi (AD/ART).",
  schema: CascadingRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  queries: () => [
    { focus: "nilai", text: "nilai organisasi visi misi AD/ART tujuan identitas budaya organisasi", k: 5, valuesOnly: true },
    { focus: "nilai", text: "visi misi tujuan organisasi nilai dasar AD/ART", k: 3 },
  ],
  prompt: promptOf,
  mock: (ctx) => mockCascading(ctx),
  validate: async (out, ctx, llm) => {
    const items = (out.aspects ?? []).flatMap((a) =>
      a.objectives.flatMap((o) => [{ id: o.id, text: `[SO] ${o.text}` }, ...o.initiatives.map((i) => ({ id: i.id, text: `[SI] ${i.text}` }))]),
    );
    return [
      ...cascadingCodeChecks(out, ctx),
      await llmJudge(
        llm,
        "so_si_voice",
        "Periksa gaya kalimat: butir [SO] (Strategy Objective) harus berupa hasil yang diharapkan — kalimat pasif atau frasa hasil (mis. 'Penguatan …', 'Terwujudnya …', 'Meningkatnya …'), bukan kalimat perintah. Butir [SI] (Strategy Initiative) harus berupa tindakan yang dilaksanakan — kalimat aktif diawali kata kerja (mis. 'Menyusun …', 'Mengembangkan …').",
        items,
        `Visi: ${out.visi}`,
        (id) => {
          const it = items.find((x) => x.id === id);
          if (!it) return true;
          const body = it.text.replace(/^\[(SO|SI)\]\s*/, "");
          return it.text.startsWith("[SI]") ? /^me/i.test(body) : !/^me(m|n|ng|ny)?[a-z]/i.test(body) || /^me[a-z]*nya\b/i.test(body);
        },
      ),
    ];
  },
  compute: (out, ctx) => computeCascading(out, ctx.inputs),
  items: (out) => {
    const o = asOutput(out, {});
    return [
      { id: "VISI", text: o.visi },
      ...o.aspects.flatMap((a) => [
        { id: a.id, text: `${a.aspek}: ${a.misi}`, detail: "aspek visi + misi" },
        ...a.objectives.flatMap((ob) => [
          { id: ob.id, text: ob.text, detail: `Strategy Objective (aspek ${a.id})` },
          ...ob.initiatives.map((i) => {
            const s = i.strategyRef ? o.strategies?.[i.strategyRef] : undefined;
            return { id: i.id, text: i.text, detail: `Strategy Initiative${i.strategyRef ? ` dari ${i.strategyRef}${s?.rank ? ` (peringkat ${s.rank} QSPM)` : ""}` : ""}` };
          }),
        ]),
      ]),
    ];
  },
  sheets: (out, ctx) => [cascadingSheet(asOutput(out, ctx.inputs))],
  blocks: (out, ctx): Block[] => {
    const o = asOutput(out, ctx.inputs);
    return [
      { type: "h2", text: "Cascading visi–misi" },
      { type: "p", text: `Visi: ${o.visi}` },
      {
        type: "table",
        head: ["Aspek", "Misi", "Index", "Strategy Objective", "Index", "Strategy Initiative", "Strategi"],
        rows: o.aspects.flatMap((a) =>
          a.objectives.flatMap((ob) =>
            ob.initiatives.map((i, k) => [k === 0 && ob === a.objectives[0] ? a.aspek : "", k === 0 && ob === a.objectives[0] ? a.misi : "", k === 0 ? ob.id : "", k === 0 ? ob.text : "", i.id, i.text, i.strategyRef ?? "–"]),
          ),
        ),
        widths: [12, 18, 6, 18, 7, 31, 8],
      },
      { type: "note", text: "SO ditulis sebagai hasil yang diharapkan (kalimat pasif); SI sebagai tindakan yang dilaksanakan (kalimat aktif)." },
    ];
  },
  summary: (out) => {
    const o = asOutput(out, {});
    return `${o.counts.aspects} aspek visi, ${o.counts.objectives} SO, ${o.counts.initiatives} SI${o.missingTop.length ? `; belum memuat ${o.missingTop.join(", ")}` : ""}`;
  },
  repairHint: "Perbaiki hanya butir yang ditolak (index, rujukan strategi, gaya kalimat, atau kutipan); butir lain salin apa adanya.",
};
