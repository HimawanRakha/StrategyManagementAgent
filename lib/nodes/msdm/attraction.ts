// MSDM – Attraction (tab MSDMATTRACTION): value proposition organisasi bagi calon pengurus.
// Tiga faktor (irisan diagram Venn di Excel): Organization Need, Staff Need, Main differentiator — masing-masing berisi
// butir penjelasan bernomor. Irisan ketiganya = value proposition (teks di tengah diagram).
import { z } from "zod";
import { Evidence } from "../schemas";
import type { NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { GridBuilder, type Block, type Grid } from "@/lib/sheets/grid";
import { result } from "@/lib/validators/common";
import {
  GROUNDED_CHECK,
  QUOTE_CHECK,
  REF_CHECK,
  blank,
  contextBlock,
  countProblem,
  evidenceRefs,
  findQuote,
  groundedCheck,
  idProblems,
  noteOf,
  numbered,
  quoteCheck,
  refCheck,
  strategyJudge,
  strategyRefs,
  type Upstream,
  validRefIds,
} from "./common";

const Point = z.object({
  /** ON1… (Organization Need), SN1… (Staff Need), MD1… (Main differentiator). */
  id: z.string(),
  text: z.string().min(3),
  /** Alasan singkat (mengapa butir ini penting bagi organisasi). */
  reason: z.string().default(""),
  /** ID butir strategi (cascading/renstra) yang didukung butir ini. */
  refs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});

export const AttractionOutput = z.object({
  organizationNeed: z.array(Point),
  staffNeed: z.array(Point),
  differentiator: z.array(Point),
  /** Irisan ketiga faktor: satu–dua kalimat tawaran nilai organisasi bagi calon pengurus. */
  valueProposition: z.string(),
});
export type AttractionOutput = z.infer<typeof AttractionOutput>;
export type AttractionPoint = z.infer<typeof Point>;

export type FactorKey = "organizationNeed" | "staffNeed" | "differentiator";
export const ATTRACTION_FACTORS: { key: FactorKey; prefix: string; label: string; keterangan: string }[] = [
  {
    key: "organizationNeed",
    prefix: "ON",
    label: "Organization Need",
    keterangan: "Keahlian seperti apa yang akan membantu kita mencapai tujuan / gambaran besar organisasi",
  },
  {
    key: "staffNeed",
    prefix: "SN",
    label: "Staff Need",
    keterangan: "Program seperti apa yang akan membantu kita mencapai tujuan gambaran besar / apa yang penting bagi mereka",
  },
  {
    key: "differentiator",
    prefix: "MD",
    label: "Main differentiator",
    keterangan: "Apa yang ditawarkan organisasi ini yang tidak dapat atau tidak akan dilakukan oleh organisasi lain",
  },
];

const UPSTREAM: Upstream[] = [];

const allPoints = (o: AttractionOutput) => ATTRACTION_FACTORS.flatMap((f) => (o[f.key] ?? []).map((p) => ({ ...p, factor: f })));

const QUERIES: Record<FactorKey, string> = {
  organizationNeed: "kebutuhan keahlian kompetensi pengurus staf untuk mencapai tujuan program kerja organisasi",
  staffNeed: "harapan kebutuhan anggota pengurus pengembangan diri pelatihan lingkungan kerja apresiasi beban",
  differentiator: "keunggulan ciri khas peran unik kesempatan organisasi dibanding organisasi lain kolaborasi jejaring",
};

const MOCK: Record<FactorKey, string[]> = {
  organizationNeed: [
    "Komitmen dan etos kerja tinggi untuk menuntaskan program kerja sampai evaluasi.",
    "Kemampuan administrasi, keuangan, komunikasi, atau multimedia sesuai bidang kerja.",
    "Kemampuan koordinasi lintas bidang dan dokumentasi kerja yang rapi agar program bisa dilanjutkan.",
  ],
  staffNeed: [
    "Wadah pengembangan kemampuan sesuai bidang masing-masing.",
    "Kesempatan belajar melalui transfer knowledge dan sharing skill.",
    "Pembagian beban kerja yang jelas dan pendampingan dari pengurus inti.",
    "Lingkungan kekeluargaan yang tetap profesional.",
  ],
  differentiator: [
    "Berperan langsung dalam menjalankan dan mengembangkan sistem kerja organisasi.",
    "Ranah kerja beragam sehingga staf dapat berkembang sesuai minat dan kompetensinya.",
    "Budaya berbagi pengetahuan antargenerasi pengurus yang dibangun secara sengaja.",
  ],
};

function mock(ctx: NodeContext): AttractionOutput {
  const used = new Set<string>();
  const strat = strategyRefs(ctx);
  const factor = (f: (typeof ATTRACTION_FACTORS)[number]) =>
    MOCK[f.key].map((text, i) => {
      const ev = findQuote(ctx.evidence, `${QUERIES[f.key]} ${text}`, used);
      const ref = strat.length ? [strat[(i + f.prefix.length) % strat.length].id] : [];
      return {
        id: `${f.prefix}${i + 1}`,
        text,
        reason: ev ? "Didukung temuan dokumen." : ref.length ? `Mendukung ${ref[0]}.` : "Kebutuhan umum organisasi kemahasiswaan (mode uji).",
        refs: f.key === "organizationNeed" || !ev ? ref : [],
        evidence: ev ? [ev] : [],
      };
    });
  return {
    organizationNeed: factor(ATTRACTION_FACTORS[0]),
    staffNeed: factor(ATTRACTION_FACTORS[1]),
    differentiator: factor(ATTRACTION_FACTORS[2]),
    valueProposition: `Bergabung dengan ${ctx.projectName} berarti berkontribusi langsung pada sistem kerja organisasi sambil berkembang sesuai minat, dalam lingkungan kekeluargaan yang profesional.`,
  };
}

function items(out: unknown) {
  const o = out as AttractionOutput;
  return [
    ...allPoints(o).map((p) => ({
      id: p.id,
      text: p.text,
      detail: [p.factor.label, p.refs?.length ? `dasar: ${p.refs.join(", ")}` : ""].filter(Boolean).join(" · "),
    })),
    ...(o.valueProposition ? [{ id: "VP", text: o.valueProposition, detail: "Value proposition (irisan ketiga faktor)" }] : []),
  ];
}

function sheet(out: AttractionOutput): Grid {
  const g = new GridBuilder("attraction", "MSDMATTRACTION", "Attraction — value proposition bagi calon pengurus");
  g.set(0, 0, "Attraction — value proposition bagi calon pengurus", { style: "title", cs: 5 });
  const H = { style: "header" as const, fill: "B4A7D6" };
  g.row(2, 0, ["Faktor", "Keterangan", "No.", "Penjelasan", "Dasar / bukti"], H);
  let r = 3;
  for (const f of ATTRACTION_FACTORS) {
    const pts = out[f.key] ?? [];
    const n = Math.max(1, pts.length);
    g.set(r, 0, f.label, { style: "label", fill: "B4A7D6", rs: n });
    g.set(r, 1, f.keterangan, { style: "text", fill: "D9D2E9", rs: n, src: "tetap" });
    if (!pts.length) g.set(r, 3, "(belum ada butir)", { style: "muted" });
    pts.forEach((p, i) => {
      g.set(r + i, 2, i + 1, { style: "int", center: true });
      g.set(r + i, 3, p.text, {
        style: "text",
        src: "ai",
        note: noteOf(p.reason, p.evidence, p.refs),
        refs: evidenceRefs(p.evidence),
        edit: { path: [f.key, i, "text"], type: "text" },
      });
      g.set(r + i, 4, [p.refs.join(", "), ...p.evidence.map((e) => `[${e.chunkId}]`)].filter(Boolean).join(" ") || "–", {
        style: "muted",
        refs: evidenceRefs(p.evidence),
      });
    });
    r += n;
  }
  r++;
  g.set(r, 0, "Value proposition", { style: "label", fill: "B4A7D6", note: "Irisan Organization Need, Staff Need, dan Main differentiator (bagian tengah diagram Venn di Excel)." });
  g.set(r, 1, out.valueProposition, { style: "text", src: "ai", cs: 4, edit: { path: ["valueProposition"], type: "text" } });
  return g.build({
    cols: [20, 34, 5, 60, 16],
    notes: [
      "Tiga faktor attraction: apa yang dibutuhkan organisasi, apa yang dibutuhkan staf, dan apa pembeda organisasi dibanding organisasi lain.",
      "Value proposition = irisan ketiganya: alasan utama calon pengurus mau bergabung.",
      "Teks penjelasan berasal dari AI dan bisa Anda ubah; klik sel untuk melihat alasan dan kutipan dokumennya.",
    ],
  });
}

function blocks(out: AttractionOutput): Block[] {
  return [
    { type: "h2", text: "Attraction — value proposition" },
    {
      type: "table",
      head: ["Faktor", "Keterangan", "Penjelasan"],
      rows: ATTRACTION_FACTORS.map((f) => [f.label, f.keterangan, numbered((out[f.key] ?? []).map((p) => p.text))]),
      widths: [18, 30, 52],
    },
    { type: "p", text: `Value proposition: ${out.valueProposition}` },
  ];
}

export const msdmAttraction: NodeDef<AttractionOutput> = {
  key: "msdm_attraction",
  label: "MSDM – Attraction",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMATTRACTION",
  deps: [],
  kind: "llm",
  description:
    "Value proposition bagi calon pengurus: kebutuhan organisasi (keahlian yang dicari), kebutuhan staf (apa yang penting bagi mereka), dan pembeda utama organisasi — berdasar dokumen dan arah strategi.",
  computedBy: "LLM",
  schema: AttractionOutput,
  checks: [
    { name: "factor_complete", kind: "code", description: "Setiap faktor (Organization Need, Staff Need, Main differentiator) berisi 2–6 butir ber-ID unik dan value proposition terisi" },
    QUOTE_CHECK,
    GROUNDED_CHECK,
    REF_CHECK,
    { name: "strategy_relevance", kind: "llm", description: "Butir tidak relevan dengan tujuan/arah strategi organisasi atau tidak sesuai faktornya" },
  ],
  queries: () => [
    { focus: "kebutuhan organisasi", text: QUERIES.organizationNeed, k: 5 },
    { focus: "kebutuhan staf", text: QUERIES.staffNeed, k: 5 },
    { focus: "pembeda organisasi", text: QUERIES.differentiator, k: 4 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun tabel ATTRACTION (value proposition bagi calon pengurus) dengan tiga faktor:
${ATTRACTION_FACTORS.map((f) => `- ${f.label} (${f.key}, ID ${f.prefix}1, ${f.prefix}2, …): ${f.keterangan}.`).join("\n")}
Aturan:
1. Isi 2–5 butir per faktor (idealnya 3–4); satu butir = satu gagasan singkat dan konkret (bukan slogan).
2. Organization Need = keahlian/sikap yang dibutuhkan organisasi untuk mencapai arah strategi; rujuk ID sasaran/inisiatif/milestone yang didukung di "refs" (hanya ID yang tercantum di konteks).
3. Staff Need = program/kondisi yang penting bagi staf agar mau bergabung dan berkembang (ambil dari keluhan/harapan pengurus di dokumen bila ada).
4. Main differentiator = hal yang ditawarkan organisasi ini dan tidak ditawarkan organisasi lain; harus spesifik untuk organisasi ini.
5. Butir yang berasal dari dokumen WAJIB punya bukti. ${EVIDENCE_RULES}
   Butir yang disimpulkan dari arah strategi boleh tanpa kutipan tetapi WAJIB punya "refs". Setiap butir minimal punya salah satunya.
6. "reason": satu kalimat alasan. "valueProposition": 1–2 kalimat yang merangkum irisan ketiga faktor.
7. Jangan menyebut nama orang.
8. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(AttractionOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const pts = allPoints(out);
    const valid = validRefIds(ctx, UPSTREAM);
    const failures = [
      ...ATTRACTION_FACTORS.flatMap((f) => [
        ...countProblem((out[f.key] ?? []).length, 2, 6, f.label, "factor_complete"),
        ...(out[f.key] ?? []).filter((p) => !p.id.startsWith(f.prefix)).map((p) => ({ check: "factor_complete", itemId: p.id, message: `${p.id}: ID butir ${f.label} harus berawalan ${f.prefix} (mis. ${f.prefix}1).` })),
        ...(out[f.key] ?? []).filter((p) => blank(p.text)).map((p) => ({ check: "factor_complete", itemId: p.id, message: `${p.id}: penjelasan kosong.` })),
      ]),
      ...idProblems(pts, "Attraction", "factor_complete"),
      ...((out.valueProposition ?? "").trim().length < 20 ? [{ check: "factor_complete", itemId: "VP", message: "Value proposition belum diisi (minimal satu kalimat)." }] : []),
    ];
    return [
      result("factor_complete", "code", failures),
      quoteCheck(pts, ctx.evidence),
      groundedCheck(pts, ctx, valid),
      refCheck(pts, valid),
      await strategyJudge(
        llm,
        ctx,
        "strategy_relevance",
        "Periksa apakah setiap butir sesuai dengan faktornya (Organization Need = keahlian yang dibutuhkan organisasi; Staff Need = hal yang penting bagi staf; Main differentiator = pembeda organisasi) dan relevan dengan arah strategi organisasi. Value proposition (VP) harus merangkum ketiganya.",
        items(out).map((i) => ({ id: i.id, text: `${i.text}${i.detail ? ` (${i.detail})` : ""}` })),
      ),
    ];
  },
  repairHint: "Perbaiki hanya butir yang ditolak (tambah bukti/refs, perbaiki ID atau isi); butir lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as AttractionOutput)],
  blocks: (out) => blocks(out as AttractionOutput),
  formulas: [],
  summary: (out) => {
    const o = out as AttractionOutput;
    return `Attraction: ${o.organizationNeed?.length ?? 0} kebutuhan organisasi, ${o.staffNeed?.length ?? 0} kebutuhan staf, ${o.differentiator?.length ?? 0} pembeda utama.`;
  },
};
