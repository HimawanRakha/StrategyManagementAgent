// SIKONTINUITAS PROKER (INTRO / ANALYSIS S / MATRIX) — analisis kontinuitas program kerja dengan skor effort & impact.
// AI mengusulkan daftar proker dari LPJ (berbukti), skor E1–E3 dan I1–I3 (1–5, rubrik tab INTRO), rekomendasi tindak lanjut
// (dibatasi Matching Matrix tab MATRIX), dan alasan; semua bisa diedit. Kode menghitung rata-rata tertimbang (SUMPRODUCT),
// Low/High (ambang 2,51), dan kuadran.
import { z } from "zod";
import type { KontinuitasComputed, ProkerStrategy } from "../contracts";
import { Evidence } from "../schemas";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { firstSentence, pick, sentencesOf } from "../heuristics";
import { checkQuotes, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, addr, num, range, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";

// ---------- Konstanta metode (tab INTRO & MATRIX) ----------

export const THRESHOLD = 2.51;
export const DEFAULT_WEIGHTS = { effort: [0.35, 0.35, 0.3], impact: [0.3, 0.5, 0.2] };

export const PROKER_STRATEGIES: ProkerStrategy[] = ["Eliminate", "Combine", "Substitute", "Improve & Continue", "Keep it & Continue"];
export const STRATEGY_DESC: Record<ProkerStrategy, string> = {
  Eliminate: "Menghapus program kerja tersebut (tidak digunakan di kepengurusan depan)",
  Combine: "Mengombinasikan 2 atau lebih bentuk program kerja menjadi 1 program kerja dalam sebuah rangkaian",
  Substitute: "Mensubstitusi/mengubah program kerja ke bentuk yang baru dengan tujuan/objektif yang masih sama",
  "Improve & Continue": "Memperbaiki kesalahan besar dari proker tersebut, kemudian melanjutkan di kepengurusan selanjutnya",
  "Keep it & Continue": "Mempertahankan dan melanjutkan program kerja tersebut tanpa perlu perbaikan secara major",
};
const STRATEGY_FILL: Record<ProkerStrategy, string> = {
  Eliminate: "FFA7A7",
  Combine: "F5BE7B",
  Substitute: "F5F5AD",
  "Improve & Continue": "CDFFE6",
  "Keep it & Continue": "75FFBA",
};

export type ProkerKuadran = "Low Effort High Impact" | "High Effort High Impact" | "Low Effort Low Impact" | "High Effort Low Impact";
/** Urutan prioritas kuadran (tab MATRIX A6:B9). */
export const KUADRAN_ORDER: ProkerKuadran[] = ["Low Effort High Impact", "High Effort High Impact", "Low Effort Low Impact", "High Effort Low Impact"];
const KUADRAN_FILL: Record<ProkerKuadran, string> = {
  "Low Effort High Impact": "75FFBA",
  "High Effort High Impact": "F5F5AD",
  "Low Effort Low Impact": "F5BE7B",
  "High Effort Low Impact": "FFA7A7",
};

/** Matching Matrix (tab MATRIX H6:K10): hijau = paling sesuai, kuning = sesuai, tanpa warna = tidak sesuai. */
export const MATCHING: Record<ProkerKuadran, { most: ProkerStrategy[]; suitable: ProkerStrategy[] }> = {
  "Low Effort High Impact": { most: ["Keep it & Continue"], suitable: ["Improve & Continue"] },
  "High Effort High Impact": { most: ["Improve & Continue"], suitable: ["Combine", "Substitute"] },
  "Low Effort Low Impact": { most: ["Combine", "Improve & Continue"], suitable: ["Eliminate"] },
  "High Effort Low Impact": { most: ["Eliminate"], suitable: ["Substitute"] },
};
export type Kesesuaian = "most" | "suitable" | "unsuitable";
export function suitability(k: string, s: ProkerStrategy): Kesesuaian {
  const m = MATCHING[k as ProkerKuadran];
  if (!m) return "unsuitable";
  return m.most.includes(s) ? "most" : m.suitable.includes(s) ? "suitable" : "unsuitable";
}
const SUIT_LABEL: Record<Kesesuaian, string> = { most: "paling sesuai", suitable: "sesuai", unsuitable: "tidak sesuai" };

type Indicator = { code: string; short: string; title: string; levels: [string, string, string, string, string]; note: string };
/** Rubrik indikator (tab INTRO) — disalin persis. */
export const RUBRIC: { effort: Indicator[]; impact: Indicator[] } = {
  effort: [
    {
      code: "E1",
      short: "SDM",
      title: "Acuan Indikator EFFORT 1: Jumlah SDM yang Terlibat",
      levels: ["Melibatkan ≤5 SDM secara aktif", "Melibatkan 6–10 SDM", "Melibatkan 11–20 SDM", "Melibatkan 21–30 SDM", "Melibatkan >30 SDM"],
      note: "Yang dihitung adalah SDM yang terlibat secara langsung dan aktif dalam perencanaan sampai pelaksanaan program, baik dari Kesekjenan maupun unit lain.",
    },
    {
      code: "E2",
      short: "ANGGARAN",
      title: "Acuan Indikator EFFORT 2: Kebutuhan Anggaran",
      levels: [
        "Tidak membutuhkan anggaran",
        "Membutuhkan anggaran ≤Rp500.000",
        "Membutuhkan anggaran >Rp500.000–Rp1.500.000",
        "Membutuhkan anggaran >Rp1.500.000–Rp3.000.000",
        "Membutuhkan anggaran >Rp3.000.000",
      ],
      note: "Yang dihitung adalah kebutuhan anggaran aktual untuk menjalankan program, bukan nilai aset/sumber daya yang sudah dimiliki organisasi.",
    },
    {
      code: "E3",
      short: "WAKTU",
      title: "Acuan Indikator EFFORT 3: Pengeluaran Waktu Efektif",
      levels: ["≤7 person-days", "8–14 person-days", "15–30 person-days", "31–60 person-days", ">60 person-days"],
      note: "Waktu efektif adalah akumulasi waktu yang benar-benar digunakan SDM untuk merancang, menjalankan, mengevaluasi, dan melakukan tindak lanjut program.",
    },
  ],
  impact: [
    {
      code: "I1",
      short: "CAKUPAN",
      title: "Acuan Indikator IMPACT 1: Cakupan Internal yang Terdampak",
      levels: [
        "Berdampak langsung pada ≤10% unit/SDM sasaran",
        "Berdampak pada >10–25% unit/SDM sasaran",
        "Berdampak pada >25–50% unit/SDM sasaran",
        "Berdampak pada >50–75% unit/SDM sasaran",
        "Berdampak pada >75% unit/SDM sasaran",
      ],
      note: "Berapa banyak pihak/unit yang memperoleh manfaat daripada sekadar jumlah peserta.",
    },
    {
      code: "I2",
      short: "KUALITAS",
      title: "Acuan Indikator IMPACT 2: Peningkatan Efektivitas & Kualitas Tata Kelola",
      levels: [
        "Tidak terdapat peningkatan yang terukur terhadap proses kerja",
        "Memberikan perbaikan minor pada proses kerja",
        "Meningkatkan efektivitas/kualitas satu proses kerja secara nyata",
        "Meningkatkan beberapa proses kerja atau mengurangi masalah berulang secara signifikan",
        "Menghasilkan perubahan sistemik yang meningkatkan efektivitas tata kelola organisasi secara signifikan",
      ],
      note: "apakah setelah program berjalan cara organisasi bekerja menjadi lebih baik.",
    },
    {
      code: "I3",
      short: "BERKELANJUTAN",
      title: "Acuan Indikator IMPACT 3: Keberlanjutan & Strategic Value",
      levels: [
        "Manfaat hanya bersifat sesaat dan tidak menghasilkan output yang dapat digunakan kembali",
        "Menghasilkan manfaat jangka pendek tetapi belum dapat digunakan kembali",
        "Menghasilkan output yang dapat digunakan kembali pada periode berikutnya",
        "Menghasilkan sistem, standar, data, pengetahuan, atau mekanisme yang mendukung keberlanjutan organisasi",
        "Menjadi fondasi strategis yang dapat digunakan lintas periode kepengurusan dan sulit digantikan tanpa kehilangan fungsi penting organisasi",
      ],
      note: "program hanya memberikan manfaat sesaat, atau menghasilkan sesuatu yang dapat digunakan organisasi dalam jangka panjang.",
    },
  ],
};

const INTRO_TEXT = `Analisis kontinuitas ini merupakan salah satu metode bagi kita dalam mengidentifikasi dan mengevaluasi program kerja yang telah berjalan. Selain itu, hasil dari analisis kontinuitas ini dapat menentukan apakah program kerja kalian masih relevan atau tidak untuk dilaksanakan di waktu kepengurusan selanjutnya.

Nantinya, kita akan meninjau dari aspek effort dan impact sebagai representatif beban kerja dan dampak yang ditimbulkan dari program kerja kalian.

Lebih lanjutnya, kalian bisa geser ke sheet sebelah untuk mengetahui kontinuitas program kerjanya.

Pengerjaan utama ada di (Analysis Sheet)  sheets selanjutnya dengan keperluan acuan standar ada di (Indikator Effort-Impact) di bawah ini dan (Matrix Tindak Lanjut) sheets selanjutnya.`;

// ---------- Skema ----------

/** Rekomendasi: nama strategi (huruf besar/kecil dan "and"/"&" dinormalkan). */
const Rekomendasi = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase().replace(/\s+and\s+/g, " & ").replace(/\s+/g, " ");
  return PROKER_STRATEGIES.find((s) => s.toLowerCase() === k) ?? v;
}, z.enum(PROKER_STRATEGIES as [ProkerStrategy, ...ProkerStrategy[]]));

/** Skor 1–5 (kosong = 0 seperti SUMPRODUCT Excel). */
const Score = z.number().nullable();

export const ProkerRaw = z.object({
  /** "P1", "P2", … */
  id: z.string(),
  name: z.string(),
  /** Skor effort [E1 SDM, E2 Anggaran, E3 Waktu], masing-masing 1–5. */
  e: z.array(Score).length(3),
  /** Skor impact [I1 Cakupan, I2 Kualitas, I3 Keberlanjutan], masing-masing 1–5. */
  i: z.array(Score).length(3),
  rekomendasi: Rekomendasi,
  /** Keterangan tambahan rekomendasi. */
  keterangan: z.string().default(""),
  /** Alasan skor effort: "E1 = …; E2 = …; E3 = …". */
  alasanEffort: z.string().default(""),
  /** Alasan skor impact: "I1 = …; I2 = …; I3 = …". */
  alasanImpact: z.string().default(""),
  evidence: z.array(Evidence).default([]),
});
export const KontinuitasRaw = z.object({
  /** Bobot indikator (bisa diubah; bawaan Excel E 0,35/0,35/0,3 dan I 0,3/0,5/0,2). */
  weights: z
    .object({ effort: z.array(z.number()).length(3), impact: z.array(z.number()).length(3) })
    .default({ effort: [...DEFAULT_WEIGHTS.effort], impact: [...DEFAULT_WEIGHTS.impact] }),
  proker: z.array(ProkerRaw),
});
export type KontinuitasRaw = z.infer<typeof KontinuitasRaw>;

export type ProkerOut = KontinuitasRaw["proker"][number] & KontinuitasComputed["proker"][number] & { kesesuaian: Kesesuaian; saran: ProkerStrategy[] };
export type KontinuitasOutput = Omit<KontinuitasRaw, "proker"> &
  Omit<KontinuitasComputed, "proker"> & {
    proker: ProkerOut[];
    threshold: number;
    counts: Record<ProkerKuadran, number>;
  };

// ---------- Compute ----------

/** SUMPRODUCT bobot × skor; sel kosong = 0 (seperti Excel). */
export const sumproduct = (w: number[], s: (number | null | undefined)[]) =>
  Math.round(w.reduce((acc, wk, k) => acc + (wk ?? 0) * (typeof s[k] === "number" ? (s[k] as number) : 0), 0) * 1e10) / 1e10;

export function computeKontinuitas(raw: KontinuitasRaw): KontinuitasOutput {
  const weights = raw?.weights ?? { effort: [...DEFAULT_WEIGHTS.effort], impact: [...DEFAULT_WEIGHTS.impact] };
  const proker: ProkerOut[] = (raw?.proker ?? []).map((p) => {
    const effort = sumproduct(weights.effort, p.e ?? []);
    const impact = sumproduct(weights.impact, p.i ?? []);
    const effortLevel = effort < THRESHOLD ? ("Low Effort" as const) : ("High Effort" as const);
    const impactLevel = impact < THRESHOLD ? ("Low Impact" as const) : ("High Impact" as const);
    const kuadran = `${effortLevel} ${impactLevel}` as ProkerKuadran;
    return { ...p, effort, impact, effortLevel, impactLevel, kuadran, kesesuaian: suitability(kuadran, p.rekomendasi), saran: MATCHING[kuadran].most };
  });
  const counts = Object.fromEntries(KUADRAN_ORDER.map((k) => [k, proker.filter((p) => p.kuadran === k).length])) as Record<ProkerKuadran, number>;
  return { ...raw, weights, proker, threshold: THRESHOLD, counts };
}

const asOutput = (out: unknown): KontinuitasOutput => {
  const o = (typeof out === "object" && out !== null ? out : {}) as Partial<KontinuitasOutput>;
  if (o.counts && Array.isArray(o.proker)) return o as KontinuitasOutput;
  return computeKontinuitas({ weights: o.weights ?? { ...DEFAULT_WEIGHTS }, proker: (Array.isArray(o.proker) ? o.proker : []) as KontinuitasRaw["proker"] });
};

// ---------- Prompt & mock ----------

const rubricText = () =>
  [...RUBRIC.effort, ...RUBRIC.impact]
    .map((ind) => `${ind.title}\n${ind.levels.map((l, k) => `  ${k + 1} = ${l}`).join("\n")}\n  Catatan: ${ind.note}`)
    .join("\n");

const matrixText = () =>
  KUADRAN_ORDER.map((k) => `- ${k}: paling sesuai ${MATCHING[k].most.join(" / ")}; sesuai ${MATCHING[k].suitable.join(" / ")}`).join("\n");

function promptOf(ctx: NodeContext) {
  return {
    system: `Kamu evaluator program kerja organisasi. Lakukan ANALISIS KONTINUITAS PROGRAM KERJA (tab SIKONTINUITAS PROKER).
Langkah:
1. Daftar SEMUA program kerja (proker) yang sudah berjalan dari LPJ/dokumen (ID P1, P2, …), masing-masing dengan bukti kutipan dokumen.
2. Beri skor EFFORT e = [E1 SDM, E2 Anggaran, E3 Waktu] dan IMPACT i = [I1 Cakupan, I2 Kualitas tata kelola, I3 Keberlanjutan], masing-masing bilangan bulat 1–5 menurut rubrik berikut (pilih deskripsi yang paling cocok dengan data dokumen):
${rubricText()}
3. JANGAN menghitung rata-rata, Low/High, atau kuadran — dihitung kode: Avg effort = 0,35·E1 + 0,35·E2 + 0,3·E3; Avg impact = 0,3·I1 + 0,5·I2 + 0,2·I3; Low bila Avg < 2,51, High bila ≥ 2,51; kuadran = "<Low/High> Effort <Low/High> Impact".
4. Perkirakan kuadran dari skormu, lalu pilih rekomendasi tindak lanjut yang SESUAI Matching Matrix (utamakan yang paling sesuai):
${matrixText()}
Arti strategi: ${PROKER_STRATEGIES.map((s) => `${s} = ${STRATEGY_DESC[s]}`).join("; ")}.
5. keterangan = 1–2 kalimat alasan rekomendasi. alasanEffort = "E1 = …; E2 = …; E3 = …" dan alasanImpact = "I1 = …; I2 = …; I3 = …" (data dari dokumen yang mendasari setiap skor, mis. jumlah panitia, besar anggaran, lama pelaksanaan, cakupan peserta).
6. weights: tulis bobot bawaan {"effort":[0.35,0.35,0.3],"impact":[0.3,0.5,0.2]}.
7. ${EVIDENCE_RULES}
8. ${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Potongan dokumen (LPJ / laporan kegiatan):
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(KontinuitasRaw)}`,
  };
}

const PROKER_NAME = /(?:[Pp]rogram [Kk]erja|[Pp]roker|[Kk]egiatan|[Pp]rogram)\s+["“']?([A-Z][A-Za-z0-9&\-– ]{2,48}?)["”']?(?=[,.;:()]|\s+(?:yang|dengan|dan|di|pada|telah|sudah|berjalan|dilaksanakan)\b|$)/;

export function mockKontinuitas(ctx: Pick<NodeContext, "evidence">): KontinuitasRaw {
  const docs = ctx.evidence.filter((c) => c.kind === "document");
  const seen = new Set<string>();
  const proker: KontinuitasRaw["proker"] = [];
  for (const c of docs) {
    if (proker.length >= 6) break;
    const sents = sentencesOf(c.content);
    const s = sents.find((x) => PROKER_NAME.test(x)) ?? firstSentence(c.content);
    if (!s || s.length < 10) continue;
    const m = PROKER_NAME.exec(s);
    const name = (m?.[1] ?? `Program kerja ${proker.length + 1}`).trim();
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const e = [0, 1, 2].map((k) => 1 + pick(`${name}E${k}`, 5));
    const i = [0, 1, 2].map((k) => 1 + pick(`${name}I${k}`, 5));
    const kuadran = `${sumproduct(DEFAULT_WEIGHTS.effort, e) < THRESHOLD ? "Low Effort" : "High Effort"} ${sumproduct(DEFAULT_WEIGHTS.impact, i) < THRESHOLD ? "Low Impact" : "High Impact"}` as ProkerKuadran;
    const rek = MATCHING[kuadran].most[0];
    proker.push({
      id: `P${proker.length + 1}`,
      name,
      e,
      i,
      rekomendasi: rek,
      keterangan: `Mode uji: ${kuadran} → ${rek} (${STRATEGY_DESC[rek].toLowerCase()}).`,
      alasanEffort: RUBRIC.effort.map((ind, k) => `${ind.code} = ${ind.levels[e[k] - 1]}`).join("; "),
      alasanImpact: RUBRIC.impact.map((ind, k) => `${ind.code} = ${ind.levels[i[k] - 1]}`).join("; "),
      evidence: [{ chunkId: c.id, quote: s }],
    });
  }
  return { weights: { effort: [...DEFAULT_WEIGHTS.effort], impact: [...DEFAULT_WEIGHTS.impact] }, proker };
}

// ---------- Validator ----------

const CHECKS = [
  { name: "quote_exists", kind: "code" as const, description: "Kutipan bukti program kerja tidak ditemukan di potongan dokumen yang dirujuk" },
  { name: "grounded", kind: "code" as const, description: "Program kerja tidak punya bukti dari LPJ/dokumen" },
  { name: "score_range", kind: "code" as const, description: "Skor effort/impact kosong atau di luar 1–5 (bilangan bulat)" },
  { name: "weights_valid", kind: "code" as const, description: "Bobot indikator effort atau impact tidak berjumlah 1" },
  { name: "rekomendasi_sesuai", kind: "code" as const, description: "Rekomendasi tindak lanjut tidak sesuai kuadran menurut Matching Matrix" },
  { name: "reasons_present", kind: "code" as const, description: "Keterangan atau alasan skor (E1–E3, I1–I3) belum ditulis" },
  { name: "alasan_sesuai_rubrik", kind: "llm" as const, description: "Alasan skor tidak sesuai deskripsi rubrik untuk skor yang diberikan" },
];

export function kontinuitasCodeChecks(raw: KontinuitasRaw, ctx: Pick<NodeContext, "evidence">): CheckResult[] {
  const o = computeKontinuitas(raw);
  const grounded: Failure[] = [];
  const range: Failure[] = [];
  const weights: Failure[] = [];
  const rek: Failure[] = [];
  const reasons: Failure[] = [];
  for (const p of o.proker) {
    if (!p.evidence?.length) grounded.push({ check: "grounded", itemId: p.id, message: `${p.id} (${p.name}) tidak punya kutipan bukti dari LPJ/dokumen.` });
    const bad = [
      ...p.e.map((v, k) => ({ code: RUBRIC.effort[k].code, v })),
      ...p.i.map((v, k) => ({ code: RUBRIC.impact[k].code, v })),
    ].filter((x) => x.v === null || !Number.isInteger(x.v) || x.v < 1 || x.v > 5);
    if (bad.length) range.push({ check: "score_range", itemId: p.id, message: `${p.id}: skor harus bilangan bulat 1–5 (${bad.map((b) => `${b.code}=${b.v ?? "kosong"}`).join(", ")}).` });
    if (p.kesesuaian === "unsuitable")
      rek.push({
        check: "rekomendasi_sesuai",
        itemId: p.id,
        message: `${p.id} (${p.name}) berada di kuadran ${p.kuadran} (effort ${num(p.effort, 2)}, impact ${num(p.impact, 2)}); rekomendasi "${p.rekomendasi}" tidak sesuai Matching Matrix — pilih ${[...MATCHING[p.kuadran as ProkerKuadran].most, ...MATCHING[p.kuadran as ProkerKuadran].suitable].join(" / ")}.`,
      });
    const missE = RUBRIC.effort.filter((ind) => !new RegExp(`\\b${ind.code}\\b`).test(p.alasanEffort ?? "")).map((ind) => ind.code);
    const missI = RUBRIC.impact.filter((ind) => !new RegExp(`\\b${ind.code}\\b`).test(p.alasanImpact ?? "")).map((ind) => ind.code);
    const missK = !(p.keterangan ?? "").trim();
    if (missE.length || missI.length || missK)
      reasons.push({
        check: "reasons_present",
        itemId: p.id,
        message: `${p.id}: ${[missK ? "keterangan rekomendasi kosong" : "", missE.length || missI.length ? `alasan skor belum menyebut ${[...missE, ...missI].join(", ")}` : ""].filter(Boolean).join("; ")}.`,
      });
  }
  for (const [k, w] of [
    ["effort", o.weights.effort],
    ["impact", o.weights.impact],
  ] as const) {
    const sum = w.reduce((s, x) => s + x, 0);
    if (Math.abs(sum - 1) > 1e-3 || w.some((x) => x < 0))
      weights.push({ check: "weights_valid", itemId: k, message: `Bobot indikator ${k} berjumlah ${num(sum)} (harus 1, tanpa nilai negatif).` });
  }
  return [
    checkQuotes(o.proker.filter((p) => p.evidence?.length).map((p) => ({ id: p.id, evidence: p.evidence })), ctx.evidence),
    result("grounded", "code", grounded),
    result("score_range", "code", range),
    result("weights_valid", "code", weights),
    result("rekomendasi_sesuai", "code", rek),
    result("reasons_present", "code", reasons),
  ];
}

// ---------- Sheets ----------

const C = { e: "435585", eSub: "818FB4", i: "1B4242", iSub: "5C8374", note: "CCCCCC", rek: "F5E8C7", avgE: "CDD3E1", avgI: "9EC8B9", head: "7F7F7F", matrix: "1F4E78", green: "00B050", yellow: "FFFF00" };

export function introSheet(): Grid {
  const g = new GridBuilder("intro", "SIKONTINUITAS PROKER-INTRO", "Kontinuitas proker — pengantar");
  g.set(0, 0, "ANALISIS KONTINUITAS PROGRAM KERJA", { style: "title", cs: 11, fill: C.i });
  g.set(1, 0, INTRO_TEXT, { style: "text", cs: 11, rs: 4, src: "tetap" });
  g.set(6, 7, "NOTES :", { style: "label", cs: 4, fill: C.note });
  g.set(7, 7, "1. Indikator effort dan impact 1,2,3 bisa diubah", { style: "text", cs: 4, fill: C.note, src: "tetap" });
  g.set(8, 7, "2.Deskripsi indikator dan catatan boleh diubah ubah menyesuaikan dengan indikator effort dan impact", { style: "text", cs: 4, fill: C.note, src: "tetap" });
  g.set(9, 7, "Bobot indikator bisa diubah di sheet ANALYSIS (baris 3): effort 0,35/0,35/0,3 dan impact 0,3/0,5/0,2.", { style: "note", cs: 4 });
  let r = 6;
  for (let k = 0; k < 3; k++) {
    const e = RUBRIC.effort[k];
    const im = RUBRIC.impact[k];
    g.set(r, 1, e.title, { style: "header", cs: 2, fill: C.e });
    g.set(r, 4, im.title, { style: "header", cs: 2, fill: C.i });
    g.row(r + 1, 1, ["Deskripsi Indikator", "Skor"], { style: "subheader", fill: C.eSub });
    g.row(r + 1, 4, ["Deskripsi Indikator", "Skor"], { style: "subheader", fill: C.iSub });
    for (let lv = 0; lv < 5; lv++) {
      g.set(r + 2 + lv, 1, e.levels[lv], { style: "text", src: "tetap" });
      g.set(r + 2 + lv, 2, lv + 1, { style: "int", center: true, src: "tetap" });
      g.set(r + 2 + lv, 4, im.levels[lv], { style: "text", src: "tetap" });
      g.set(r + 2 + lv, 5, lv + 1, { style: "int", center: true, src: "tetap" });
    }
    g.set(r + 7, 1, `Catatan:\n${e.note}`, { style: "note", cs: 2, rs: 2 });
    g.set(r + 7, 4, `Catatan:\n${im.note}`, { style: "note", cs: 2, rs: 2 });
    r += 10;
  }
  return g.build({
    cols: [3, 46, 7, 3, 52, 7, 3, 14, 14, 14, 14],
    notes: [
      "Rubrik ini dipakai AI untuk memberi skor 1–5 pada tiga indikator effort (beban kerja) dan tiga indikator impact (dampak) setiap program kerja.",
      "Skor yang diusulkan AI bisa Anda ubah di sheet ANALYSIS S; rata-rata, Low/High, dan kuadran dihitung ulang otomatis.",
    ],
  });
}

export function analysisSheet(o: KontinuitasOutput): Grid {
  const g = new GridBuilder("analysis", "SIKONTINUITAS PROKER-ANALYSIS S", "Kontinuitas proker — analisis");
  // Kepala tabel (baris 1–3 Excel)
  g.set(0, 0, "", { cs: 2, rs: 2 });
  g.set(0, 2, "Skor Effort (E)", { style: "header", cs: 4, fill: C.e, center: true });
  g.set(0, 6, "Interpretasi", { style: "header", rs: 3, fill: C.e, center: true });
  g.set(0, 7, "Skor Impact (I)", { style: "header", cs: 4, fill: C.i, center: true });
  g.set(0, 11, "Interpretasi", { style: "header", rs: 3, fill: C.i, center: true });
  g.set(0, 12, "Kuadran Kondisi \nProker - Agenda", { style: "header", rs: 3, fill: C.rek, center: true });
  g.set(0, 13, "Rekomendasi Tindak Lanjut", { style: "header", cs: 2, rs: 2, fill: C.rek, center: true });
  g.set(0, 15, "Alasan Skor Effort", { style: "header", rs: 3, fill: C.e, center: true });
  g.set(0, 16, "Alasan Skor Impact", { style: "header", rs: 3, fill: C.iSub, center: true });
  g.set(0, 17, "Bukti (LPJ)", { style: "header", rs: 3, center: true });
  RUBRIC.effort.forEach((ind, k) => g.set(1, 2 + k, `${ind.code} (${ind.short})`, { style: "subheader", fill: C.eSub, center: true, note: ind.title }));
  g.set(1, 5, "Avg.", { style: "subheader", rs: 2, fill: C.eSub, center: true });
  RUBRIC.impact.forEach((ind, k) => g.set(1, 7 + k, `${ind.code} (${ind.short})`, { style: "subheader", fill: C.iSub, center: true, note: ind.title }));
  g.set(1, 10, "Avg.", { style: "subheader", rs: 2, fill: C.iSub, center: true });
  g.set(2, 0, "No", { style: "header", fill: C.head });
  g.set(2, 1, "Program Kerja", { style: "header", fill: C.head });
  o.weights.effort.forEach((w, k) =>
    g.set(2, 2 + k, w, {
      fmt: "0.00",
      src: "tetap",
      center: true,
      fill: C.eSub,
      note: `Bobot indikator ${RUBRIC.effort[k].code} (bawaan ${DEFAULT_WEIGHTS.effort[k]}); bisa diubah, jumlah ketiganya harus 1.`,
      edit: { path: ["weights", "effort", k], type: "number", min: 0, max: 1, step: 0.05 },
    }),
  );
  o.weights.impact.forEach((w, k) =>
    g.set(2, 7 + k, w, {
      fmt: "0.00",
      src: "tetap",
      center: true,
      fill: C.iSub,
      note: `Bobot indikator ${RUBRIC.impact[k].code} (bawaan ${DEFAULT_WEIGHTS.impact[k]}); bisa diubah, jumlah ketiganya harus 1.`,
      edit: { path: ["weights", "impact", k], type: "number", min: 0, max: 1, step: 0.05 },
    }),
  );
  g.set(2, 13, "Strategi", { style: "subheader", fill: C.rek });
  g.set(2, 14, "Keterangan Tambahan", { style: "subheader", fill: C.rek });
  const wE = range(2, 2, 2, 4, true);
  const wI = range(2, 7, 2, 9, true);
  const options = PROKER_STRATEGIES.map((s) => s as string);
  o.proker.forEach((p, n) => {
    const r = 3 + n;
    const base = ["proker", n] as (string | number)[];
    g.set(r, 0, n + 1, { style: "int", center: true });
    g.set(r, 1, p.name, { style: "label", src: "ai", edit: { path: [...base, "name"], type: "text" } });
    const scoreCell = (c: number, v: number | null, kind: "e" | "i", k: number) => {
      const ind = (kind === "e" ? RUBRIC.effort : RUBRIC.impact)[k];
      g.set(r, c, v, {
        style: "int",
        center: true,
        src: "ai",
        note: typeof v === "number" && v >= 1 && v <= 5 ? `${ind.code} = ${v}: ${ind.levels[v - 1]}` : `${ind.code} belum diisi (dihitung 0)`,
        edit: { path: [...base, kind, k], type: "number", min: 1, max: 5, step: 1, allowEmpty: true },
      });
    };
    p.e.forEach((v, k) => scoreCell(2 + k, v, "e", k));
    p.i.forEach((v, k) => scoreCell(7 + k, v, "i", k));
    const eTerms = p.e.map((v, k) => `${num(o.weights.effort[k], 2, true)} × ${v ?? 0}`).join(" + ");
    const iTerms = p.i.map((v, k) => `${num(o.weights.impact[k], 2, true)} × ${v ?? 0}`).join(" + ");
    const fA = addr(r, 5);
    const kA = addr(r, 10);
    g.set(r, 5, p.effort, {
      fmt: "0.00",
      src: "hitung",
      fill: C.avgE,
      f: `SUMPRODUCT(${wE},${range(r, 2, r, 4)})`,
      explain: `Effort = Σ bobot × skor = ${eTerms} = ${num(p.effort, 2)}`,
    });
    g.set(r, 6, p.effortLevel, {
      src: "hitung",
      fill: C.avgE,
      f: `IF(${fA}<2.51,"Low Effort","High Effort")`,
      explain: `${num(p.effort, 2)} ${p.effort < THRESHOLD ? "<" : "≥"} 2,51 → ${p.effortLevel}`,
    });
    g.set(r, 10, p.impact, {
      fmt: "0.00",
      src: "hitung",
      fill: C.avgI,
      f: `SUMPRODUCT(${wI},${range(r, 7, r, 9)})`,
      explain: `Impact = Σ bobot × skor = ${iTerms} = ${num(p.impact, 2)}`,
    });
    g.set(r, 11, p.impactLevel, {
      src: "hitung",
      fill: C.avgI,
      f: `IF(${kA}<2.51,"Low Impact","High Impact")`,
      explain: `${num(p.impact, 2)} ${p.impact < THRESHOLD ? "<" : "≥"} 2,51 → ${p.impactLevel}`,
    });
    g.set(r, 12, p.kuadran, {
      src: "hitung",
      fill: KUADRAN_FILL[p.kuadran as ProkerKuadran],
      f: `${addr(r, 6)}&" "&${addr(r, 11)}`,
      explain: `Kuadran = interpretasi effort & interpretasi impact = "${p.effortLevel}" + "${p.impactLevel}"`,
    });
    g.set(r, 13, p.rekomendasi, {
      src: "ai",
      fill: p.kesesuaian === "unsuitable" ? "FAD7D7" : STRATEGY_FILL[p.rekomendasi],
      note: `${STRATEGY_DESC[p.rekomendasi]}. Menurut Matching Matrix: ${SUIT_LABEL[p.kesesuaian]} untuk ${p.kuadran}${p.kesesuaian !== "most" ? ` (paling sesuai: ${p.saran.join(" / ")})` : ""}.`,
      edit: { path: [...base, "rekomendasi"], type: "select", options },
    });
    g.set(r, 14, p.keterangan, { style: "text", src: "ai", edit: { path: [...base, "keterangan"], type: "text" } });
    g.set(r, 15, p.alasanEffort, { style: "text", src: "ai", edit: { path: [...base, "alasanEffort"], type: "text" } });
    g.set(r, 16, p.alasanImpact, { style: "text", src: "ai", edit: { path: [...base, "alasanImpact"], type: "text" } });
    g.set(r, 17, (p.evidence ?? []).map((e) => `[${e.chunkId}] ${e.quote}`).join("\n"), { style: "muted", src: "dokumen", refs: (p.evidence ?? []).map((e) => e.chunkId) });
  });
  if (!o.proker.length) g.set(3, 0, "(belum ada program kerja)", { style: "muted", cs: 6 });
  return g.build({
    cols: [5, 30, 8, 8, 8, 7, 12, 8, 8, 8, 7, 12, 22, 18, 40, 44, 44, 40],
    freeze: { rows: 3, cols: 2 },
    chart: {
      type: "scatter",
      title: "Effort vs Impact program kerja",
      xLabel: "Effort (rata-rata tertimbang)",
      yLabel: "Impact (rata-rata tertimbang)",
      threshold: THRESHOLD,
      max: 5,
      points: o.proker.map((p) => ({ label: p.name, x: p.effort, y: p.impact })),
    },
    notes: [
      "Skor 1–5 tiap indikator diusulkan AI menurut rubrik di sheet INTRO dan bisa Anda ubah; Avg = Σ bobot × skor (SUMPRODUCT).",
      "Avg < 2,51 = Low, ≥ 2,51 = High. Kuadran (mis. Low Effort High Impact) menentukan rekomendasi yang sesuai di sheet MATRIX.",
      "Rekomendasi berlatar merah muda berarti tidak sesuai Matching Matrix untuk kuadrannya.",
    ],
  });
}

export function matrixSheet(o?: KontinuitasOutput): Grid {
  const g = new GridBuilder("matrix", "SIKONTINUITAS PROKER-MATRIX", "Kontinuitas proker — matriks tindak lanjut");
  g.set(0, 0, "Prioritas Kuadran Kondisi Program Kerja", { style: "header", cs: 2, rs: 3, fill: C.matrix, center: true });
  g.set(0, 2, "Alternatif Tindak Lanjut", { style: "header", cs: 3, rs: 3, fill: C.matrix, center: true });
  g.set(0, 5, "Matching Matrix\n (Recommendation)", { style: "header", cs: 4, rs: 3, fill: C.matrix, center: true });
  g.set(0, 9, "The Most Suitable Strategy", { style: "label", cs: 2, fill: C.green });
  g.set(1, 9, "Suitable Strategy", { style: "label", cs: 2, fill: C.yellow });
  g.set(2, 9, "Unsuitable Strategy", { style: "label", cs: 2 });
  g.set(3, 0, "No", { style: "header", rs: 2, fill: C.matrix, center: true });
  g.set(3, 1, "Kuadran Kondisi\n Program Kerja", { style: "header", rs: 2, fill: C.matrix, center: true });
  g.set(3, 2, "No", { style: "header", rs: 2, fill: C.matrix, center: true });
  g.set(3, 3, "Strategi", { style: "header", rs: 2, fill: C.matrix, center: true });
  g.set(3, 4, "Deskripsi Strategi", { style: "header", rs: 2, fill: C.matrix, center: true });
  g.set(3, 5, "", { style: "header", cs: 2, rs: 2, fill: C.matrix });
  g.set(3, 7, "Kondisi Program Kerja", { style: "header", cs: 4, fill: C.matrix, center: true });
  KUADRAN_ORDER.forEach((k, j) => {
    g.set(4, 7 + j, k, { style: "subheader", fill: KUADRAN_FILL[k], center: true, note: o ? `${o.counts[k]} program kerja di kuadran ini` : undefined });
    g.set(5 + j, 0, j + 1, { style: "int", fill: KUADRAN_FILL[k], center: true });
    g.set(5 + j, 1, k, { style: "label", fill: KUADRAN_FILL[k] });
  });
  g.set(5, 5, "Strategy Alternative", { style: "header", rs: 5, fill: C.matrix, center: true });
  PROKER_STRATEGIES.forEach((s, i) => {
    const r = 5 + i;
    g.set(r, 2, i + 1, { style: "int", fill: STRATEGY_FILL[s], center: true });
    g.set(r, 3, s, { style: "label", fill: STRATEGY_FILL[s] });
    g.set(r, 4, STRATEGY_DESC[s], { style: "text", src: "tetap" });
    g.set(r, 6, s, { style: "label", fill: STRATEGY_FILL[s] });
    KUADRAN_ORDER.forEach((k, j) => {
      const suit = suitability(k, s);
      g.set(r, 7 + j, suit === "unsuitable" ? "" : suit === "most" ? "Paling sesuai" : "Sesuai", {
        style: "muted",
        center: true,
        src: "tetap",
        fill: suit === "most" ? C.green : suit === "suitable" ? C.yellow : undefined,
      });
    });
  });
  g.set(9, 0, "Low: Score < 2,51 (of 5,00)\n High: Score > 2,51 (of 5,00)", { style: "note", cs: 2 });
  if (o?.proker.length) {
    g.set(11, 0, "Ringkasan hasil", { style: "subheader", cs: 5 });
    g.row(12, 0, ["No", "Kuadran", "Jumlah proker"], { style: "header" });
    g.set(12, 3, "Program kerja → rekomendasi", { style: "header", cs: 2 });
    KUADRAN_ORDER.forEach((k, j) => {
      g.set(13 + j, 0, j + 1, { style: "int", center: true });
      g.set(13 + j, 1, k, { style: "label", fill: KUADRAN_FILL[k] });
      g.set(13 + j, 2, o.counts[k], { style: "int", center: true, src: "hitung" });
      g.set(13 + j, 3, o.proker.filter((p) => p.kuadran === k).map((p) => `${p.name} → ${p.rekomendasi}`).join("; ") || "–", { style: "text", cs: 2 });
    });
  }
  return g.build({
    cols: [5, 26, 5, 20, 52, 4, 20, 22, 22, 22, 22],
    notes: [
      "Matching Matrix: hijau = strategi paling sesuai, kuning = sesuai, kosong = tidak sesuai untuk kuadran kondisi program kerja.",
      "Prioritas kuadran: 1 Low Effort High Impact (paling diprioritaskan) sampai 4 High Effort Low Impact.",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  { name: "Avg effort", rumus: "Effort = 0,35·E1 + 0,35·E2 + 0,3·E3", arti: "Rata-rata tertimbang beban kerja (SDM, anggaran, waktu); skor kosong dihitung 0.", excel: "=SUMPRODUCT($C$3:$E$3,C4:E4)" },
  { name: "Avg impact", rumus: "Impact = 0,3·I1 + 0,5·I2 + 0,2·I3", arti: "Rata-rata tertimbang dampak (cakupan, kualitas tata kelola, keberlanjutan).", excel: "=SUMPRODUCT($H$3:$J$3,H4:J4)" },
  { name: "Interpretasi", rumus: "Low bila Avg < 2,51; High bila Avg ≥ 2,51", arti: "Membagi program kerja menjadi beban/dampak rendah atau tinggi.", excel: '=IF(F4<2.51,"Low Effort","High Effort")' },
  { name: "Kuadran", rumus: "Kuadran = interpretasi effort & \" \" & interpretasi impact", arti: "Empat kondisi program kerja yang dicocokkan ke Matching Matrix untuk memilih tindak lanjut.", excel: '=G4&" "&L4' },
];

export const kontinuitasProker: NodeDef<KontinuitasRaw> = {
  key: "kontinuitas_proker",
  label: "Kontinuitas program kerja",
  phase: 2,
  group: "si",
  sheetName: "SIKONTINUITAS PROKER",
  deps: [],
  kind: "llm",
  computedBy: "LLM mengusulkan proker, skor 1–5, rekomendasi, dan alasan; kode menghitung rata-rata tertimbang, Low/High, dan kuadran",
  description:
    "Mengevaluasi program kerja yang sudah berjalan (dari LPJ) dengan skor effort (SDM, anggaran, waktu) dan impact (cakupan, kualitas, keberlanjutan) untuk menentukan tindak lanjut: Eliminate, Combine, Substitute, Improve & Continue, atau Keep it & Continue.",
  schema: KontinuitasRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  queries: () => [
    { focus: "proker", text: "program kerja LPJ laporan pertanggungjawaban kegiatan pelaksanaan evaluasi", k: 10 },
    { focus: "effort", text: "jumlah panitia pengurus terlibat anggaran biaya dana waktu pelaksanaan persiapan", k: 6 },
    { focus: "impact", text: "dampak manfaat peserta sasaran kepuasan keberlanjutan output sistem", k: 6 },
  ],
  prompt: promptOf,
  mock: (ctx) => mockKontinuitas(ctx),
  validate: async (out, ctx, llm) => {
    const o = computeKontinuitas(out);
    return [
      ...kontinuitasCodeChecks(out, ctx),
      await llmJudge(
        llm,
        "alasan_sesuai_rubrik",
        "Periksa apakah alasan skor setiap program kerja sesuai dengan deskripsi rubrik untuk skor yang diberikan (mis. E2 = 1 berarti tidak membutuhkan anggaran; I3 = 5 berarti fondasi strategis lintas periode). Tolak bila alasan bertentangan dengan skornya.",
        o.proker.map((p) => ({
          id: p.id,
          text: `${p.name} || skor ${RUBRIC.effort.map((ind, k) => `${ind.code}=${p.e[k] ?? "-"}`).join(", ")}, ${RUBRIC.impact.map((ind, k) => `${ind.code}=${p.i[k] ?? "-"}`).join(", ")} || alasan effort: ${p.alasanEffort} || alasan impact: ${p.alasanImpact}`,
        })),
        `Rubrik:\n${rubricText()}`,
      ),
    ];
  },
  compute: (out) => computeKontinuitas(out),
  items: (out) =>
    asOutput(out).proker.map((p) => ({
      id: p.id,
      text: p.name,
      detail: `effort ${num(p.effort, 2)} (${p.effortLevel}), impact ${num(p.impact, 2)} (${p.impactLevel}) → ${p.rekomendasi}${p.keterangan ? `: ${p.keterangan}` : ""}`,
    })),
  sheets: (out) => {
    const o = asOutput(out);
    return [introSheet(), analysisSheet(o), matrixSheet(o)];
  },
  blocks: (out): Block[] => {
    const o = asOutput(out);
    return [
      { type: "h2", text: "Kontinuitas program kerja" },
      {
        type: "p",
        text: `${o.proker.length} program kerja dievaluasi: ${KUADRAN_ORDER.map((k) => `${o.counts[k]} ${k}`).join(", ")}. Effort = 0,35·E1 + 0,35·E2 + 0,3·E3; impact = 0,3·I1 + 0,5·I2 + 0,2·I3; Low bila < 2,51.`,
      },
      {
        type: "table",
        head: ["No", "Program kerja", "Effort", "Impact", "Kuadran", "Rekomendasi", "Keterangan"],
        rows: o.proker.map((p, n) => [String(n + 1), p.name, num(p.effort, 2), num(p.impact, 2), p.kuadran, p.rekomendasi, p.keterangan]),
        widths: [5, 20, 8, 8, 18, 14, 27],
      },
    ];
  },
  summary: (out) => {
    const o = asOutput(out);
    const by = PROKER_STRATEGIES.map((s) => [s, o.proker.filter((p) => p.rekomendasi === s).length] as const).filter(([, n]) => n);
    return `${o.proker.length} proker: ${by.map(([s, n]) => `${n} ${s}`).join(", ") || "belum ada"}`;
  },
  repairHint: "Perbaiki hanya program kerja yang ditolak (skor, rekomendasi, alasan, atau kutipan); program kerja lain salin apa adanya.",
};
