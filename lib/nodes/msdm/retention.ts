// MSDM – Retention (tab MSDMRETENTION, "Collective Starfish Retrospective Method"): lima kolom
// Start Doing | Keep Doing | Do More Of | Do Less Of | Stop Doing, ±10 butir per kolom, berdasar dokumen dan hasil MSDM sebelumnya.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { Failure, NodeContext, NodeDef } from "../types";
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
  quoteCheck,
  refCheck,
  similar,
  strategyJudge,
  upstreamItems,
  type Upstream,
  validRefIds,
} from "./common";
import { msdmOnboarding } from "./onboarding";
import { msdmDevelopment } from "./development";
import { msdmPenilaian } from "./penilaian";

const Item = z.object({
  id: z.string(),
  text: z.string().min(3),
  alasan: z.string().default(""),
  /** ID butir analisis sebelumnya (development, penilaian, onboarding, strategi) yang mendasari. */
  refs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});

export const RetentionOutput = z.object({
  startDoing: z.array(Item),
  keepDoing: z.array(Item),
  doMoreOf: z.array(Item),
  doLessOf: z.array(Item),
  stopDoing: z.array(Item),
});
export type RetentionOutput = z.infer<typeof RetentionOutput>;
export type RetentionKey = keyof RetentionOutput;

export const STARFISH: { key: RetentionKey; prefix: string; label: string; arti: string }[] = [
  { key: "startDoing", prefix: "ST", label: "Start Doing", arti: "hal baru yang belum dilakukan dan perlu mulai dilakukan" },
  { key: "keepDoing", prefix: "KP", label: "Keep Doing", arti: "hal yang sudah berjalan baik dan perlu dipertahankan" },
  { key: "doMoreOf", prefix: "MO", label: "Do More Of", arti: "hal yang sudah dilakukan tetapi perlu ditingkatkan/diperbanyak" },
  { key: "doLessOf", prefix: "LO", label: "Do Less Of", arti: "hal yang masih dilakukan tetapi perlu dikurangi" },
  { key: "stopDoing", prefix: "SP", label: "Stop Doing", arti: "hal yang merugikan dan harus dihentikan" },
];

const UPSTREAM: Upstream[] = [msdmOnboarding, msdmDevelopment, msdmPenilaian];

const allItems = (o: RetentionOutput) => STARFISH.flatMap((s) => (o[s.key] ?? []).map((it) => ({ ...it, cat: s })));

const MOCK: Record<RetentionKey, [text: string, q: string][]> = {
  startDoing: [
    ["Memberikan pendampingan rutin kepada staf dalam menjalankan tugas", "pendampingan staf tugas beban"],
    ["Membuat mekanisme transfer pengetahuan yang terdokumentasi", "dokumentasi serah terima kepengurusan arsip"],
    ["Menjelaskan tujuan, indikator, dan arahan setiap program kerja sejak awal", "program kerja tujuan indikator evaluasi"],
    ["Merencanakan kebutuhan staf berdasarkan beban kerja tiap bidang", "beban kerja pengurus kepanitiaan kuliah"],
    ["Menyusun sistem monitoring dan evaluasi kinerja yang terintegrasi", "evaluasi kinerja monitoring laporan"],
    ["Mengukur kepuasan dan kondisi kerja staf secara berkala", "survei kepuasan anggota pengurus"],
    ["Menyusun rencana regenerasi dan suksesi pengurus", "regenerasi kaderisasi pergantian kepengurusan"],
  ],
  keepDoing: [
    ["Mengadakan pertemuan rutin untuk membahas progres dan arahan kerja", "rapat rutin progres koordinasi"],
    ["Memberikan tenggat tugas yang jelas dan realistis", "tenggat tugas jadwal"],
    ["Mendengarkan pendapat dan aspirasi setiap anggota", "aspirasi pendapat anggota"],
    ["Mempertahankan koordinasi berjenjang pimpinan–kepala bidang–staf", "koordinasi pimpinan bidang staf"],
    ["Mempertahankan budaya berbagi keterampilan dan pengetahuan", "pelatihan berbagi keterampilan"],
    ["Mempertahankan ruang evaluasi untuk menyampaikan keresahan anggota", "evaluasi keresahan anggota"],
  ],
  doMoreOf: [
    ["Memberikan umpan balik berkala berdasarkan hasil monitoring", "umpan balik evaluasi hasil"],
    ["Memastikan seluruh staf memahami SOP dan alur kerja", "sop alur kerja pemahaman"],
    ["Membangun komunikasi dua arah antara pimpinan dan staf", "komunikasi pimpinan staf informasi"],
    ["Mengevaluasi dan meredistribusi beban kerja secara berkala", "beban kerja pembagian tugas"],
    ["Memberi lebih banyak ruang pengembangan kompetensi bagi staf", "pelatihan kompetensi keterampilan pengembangan"],
    ["Menyiapkan staf untuk mengambil tanggung jawab yang lebih besar", "kepemimpinan tanggung jawab pengurus"],
  ],
  doLessOf: [
    ["Menjalankan kegiatan tanpa indikator keberhasilan yang jelas", "kegiatan seremonial indikator"],
    ["Mengandalkan transfer pengetahuan yang hanya informal", "dokumentasi tidak lengkap informal"],
    ["Revisi berulang akibat arahan dan standar kerja yang belum jelas", "revisi arahan standar"],
    ["Menumpukkan beban kerja pada individu tertentu", "beban ganda pengurus"],
    ["Melakukan monitoring hanya menjelang evaluasi", "monitoring evaluasi menjelang"],
    ["Terlalu bergantung pada pemangku jabatan tertentu dalam mengambil keputusan", "keputusan terpusat ketua"],
  ],
  stopDoing: [
    ["Menunda pekerjaan hingga mendekati tenggat", "tertunda terlambat tenggat program"],
    ["Mengabaikan SOP dan alur koordinasi yang disepakati", "sop koordinasi disepakati"],
    ["Mengabaikan keresahan atau kendala yang disampaikan anggota", "keresahan kendala anggota"],
    ["Membiarkan masalah berulang tanpa tindak lanjut", "tindak lanjut belum ada masalah"],
    ["Mengabaikan dokumentasi pekerjaan", "dokumentasi laporan lengkap"],
    ["Memberikan amanah tanpa arahan dan ekspektasi yang jelas", "arahan tanggung jawab penanggung jawab"],
  ],
};

function mock(ctx: NodeContext): RetentionOutput {
  const used = new Set<string>();
  const ups = upstreamItems(ctx, UPSTREAM).flatMap((u) => u.items.map((i) => i.id));
  let n = 0;
  const cat = (s: (typeof STARFISH)[number]) =>
    MOCK[s.key].map(([text, q], i) => {
      const ev = findQuote(ctx.evidence, q, used);
      const refs = ev || !ups.length ? [] : [ups[n++ % ups.length]];
      return { id: `${s.prefix}${i + 1}`, text, alasan: ev ? "Menanggapi temuan di dokumen." : refs.length ? `Ditarik dari ${refs[0]}.` : "", refs, evidence: ev ? [ev] : [] };
    });
  return {
    startDoing: cat(STARFISH[0]),
    keepDoing: cat(STARFISH[1]),
    doMoreOf: cat(STARFISH[2]),
    doLessOf: cat(STARFISH[3]),
    stopDoing: cat(STARFISH[4]),
  };
}

function items(out: unknown) {
  return allItems(out as RetentionOutput).map((i) => ({ id: i.id, text: i.text, detail: [i.cat.label, i.refs.length ? `dasar: ${i.refs.join(", ")}` : ""].filter(Boolean).join(" · ") }));
}

const PINK = "D5A6BD";

function sheet(out: RetentionOutput): Grid {
  const g = new GridBuilder("retention", "MSDMRETENTION", "Collective Starfish Retrospective Method");
  g.set(0, 0, "Collective Starfish Retrospective Method", { style: "title", fill: PINK, cs: 5 });
  STARFISH.forEach((s, c) => g.set(1, c, s.label, { style: "header", fill: PINK, center: true, note: s.arti }));
  const n = Math.max(1, ...STARFISH.map((s) => (out[s.key] ?? []).length));
  for (let i = 0; i < n; i++)
    STARFISH.forEach((s, c) => {
      const it = (out[s.key] ?? [])[i];
      if (!it) return void g.set(2 + i, c, null, { style: "muted" });
      g.set(2 + i, c, it.text, {
        style: "text",
        src: "ai",
        note: noteOf([it.id, it.alasan].filter(Boolean).join(" — "), it.evidence, it.refs),
        refs: evidenceRefs(it.evidence),
        edit: { path: [s.key, i, "text"], type: "text" },
      });
    });
  return g.build({
    cols: [36, 36, 36, 36, 36],
    notes: [
      "Retrospektif bintang laut: tiap kolom adalah satu jenis tindakan untuk mempertahankan staf (retensi).",
      "Start = mulai lakukan; Keep = pertahankan; More of = perbanyak; Less of = kurangi; Stop = hentikan.",
      "Klik butir untuk melihat alasan, kutipan dokumen, atau ID analisis sebelumnya yang mendasarinya.",
    ],
  });
}

function blocks(out: RetentionOutput): Block[] {
  const n = Math.max(0, ...STARFISH.map((s) => (out[s.key] ?? []).length));
  return [
    { type: "h2", text: "Retention — Collective Starfish Retrospective" },
    { type: "table", head: STARFISH.map((s) => s.label), rows: Array.from({ length: n }, (_, i) => STARFISH.map((s) => out[s.key]?.[i]?.text ?? "")) },
  ];
}

export const msdmRetention: NodeDef<RetentionOutput> = {
  key: "msdm_retention",
  label: "MSDM – Retention",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMRETENTION",
  deps: [],
  kind: "llm",
  description:
    "Retrospektif bintang laut (Start Doing, Keep Doing, Do More Of, Do Less Of, Stop Doing) untuk mempertahankan staf, berdasar bukti dokumen dan hasil penilaian/pengembangan staf.",
  computedBy: "LLM",
  schema: RetentionOutput,
  checks: [
    { name: "count_per_category", kind: "code", description: "Setiap kolom starfish berisi 5–12 butir ber-ID unik dengan awalan yang benar" },
    QUOTE_CHECK,
    GROUNDED_CHECK,
    REF_CHECK,
    { name: "category_conflict", kind: "code", description: "Butir yang sama muncul di dua kolom (mis. Keep Doing dan Stop Doing) sehingga saling bertentangan" },
    { name: "category_fit", kind: "llm", description: "Butir tidak sesuai arti kolomnya (Start = baru, Keep = sudah baik, More = perbanyak, Less = kurangi, Stop = hentikan)" },
  ],
  queries: () => [
    { focus: "retensi", text: "keaktifan pengurus menurun keluar mundur beban kerja kepuasan apresiasi", k: 6 },
    { focus: "budaya kerja", text: "rapat koordinasi komunikasi evaluasi dokumentasi kebiasaan kerja pengurus", k: 5 },
    { focus: "masalah", text: "kendala masalah keresahan keluhan pengurus staf tertunda", k: 5 },
  ],
  prompt: (ctx) => ({
    system: `Kamu fasilitator retrospektif organisasi kemahasiswaan. Susun hasil COLLECTIVE STARFISH RETROSPECTIVE untuk mempertahankan (retensi) staf.
Kolom:
${STARFISH.map((s) => `- ${s.key} (${s.label}, ID ${s.prefix}1, ${s.prefix}2, …): ${s.arti}.`).join("\n")}
Aturan:
1. Isi 6–10 butir per kolom; satu butir = satu tindakan/kebiasaan konkret dalam kalimat pendek berawalan kata kerja.
2. Dasarkan pada masalah dan praktik baik di dokumen (notulensi, LPJ, survei, keresahan) dan pada hasil penilaian/pengembangan staf. Butir dari dokumen WAJIB punya bukti. ${EVIDENCE_RULES}
   Butir yang ditarik dari analisis sebelumnya WAJIB menulis ID-nya di "refs" (hanya ID yang tercantum di konteks). Setiap butir minimal punya bukti atau refs.
3. Jangan menaruh tindakan yang sama di dua kolom (mis. sekaligus Keep Doing dan Stop Doing).
4. "alasan": satu kalimat mengapa butir ini penting bagi retensi staf.
5. Jangan menyebut nama orang. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(RetentionOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const all = allItems(out);
    const valid = validRefIds(ctx, UPSTREAM);
    const cnt: Failure[] = [
      ...STARFISH.flatMap((s) => [
        ...countProblem((out[s.key] ?? []).length, 5, 12, s.label, "count_per_category"),
        ...(out[s.key] ?? []).filter((i) => !i.id.startsWith(s.prefix)).map((i) => ({ check: "count_per_category", itemId: i.id, message: `${i.id}: ID butir ${s.label} harus berawalan ${s.prefix}.` })),
        ...(out[s.key] ?? []).filter((i) => blank(i.text)).map((i) => ({ check: "count_per_category", itemId: i.id, message: `${i.id}: teks kosong.` })),
      ]),
      ...idProblems(all, "Retention", "count_per_category"),
    ];
    const conflict: Failure[] = [];
    for (let a = 0; a < all.length; a++)
      for (let b = a + 1; b < all.length; b++)
        if (all[a].cat.key !== all[b].cat.key && similar(all[a].text, all[b].text))
          conflict.push({ check: "category_conflict", itemId: all[b].id, message: `${all[b].id} (${all[b].cat.label}) hampir sama dengan ${all[a].id} (${all[a].cat.label}): "${all[b].text}".` });
    return [
      result("count_per_category", "code", cnt),
      quoteCheck(all, ctx.evidence),
      groundedCheck(all, ctx, valid),
      refCheck(all, valid),
      result("category_conflict", "code", conflict),
      await strategyJudge(
        llm,
        ctx,
        "category_fit",
        `Periksa apakah setiap butir sesuai arti kolomnya: ${STARFISH.map((s) => `${s.label} = ${s.arti}`).join("; ")}. Butir juga harus relevan untuk mempertahankan staf organisasi ini.`,
        all.map((i) => ({ id: i.id, text: `[${i.cat.label}] ${i.text}` })),
      ),
    ];
  },
  repairHint: "Perbaiki hanya butir yang ditolak (pindahkan ke kolom yang tepat, tambah bukti/refs, atau hapus duplikat); butir lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as RetentionOutput)],
  blocks: (out) => blocks(out as RetentionOutput),
  formulas: [],
  summary: (out) => {
    const o = out as RetentionOutput;
    return `Retention: ${STARFISH.map((s) => `${(o[s.key] ?? []).length} ${s.label}`).join(", ")}.`;
  },
};
