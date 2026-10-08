// MSDM – Separation (tab MSDMSEPARATION, "ENGAGEMENT SURVEYS"): kuesioner keterikatan staf Q1…Qn (skala 01–10) dan tabel
// responden (skor per pertanyaan) dengan baris AVERAGE per pertanyaan (=AVERAGE(G3:G6) di Excel) beserta grafiknya.
// Pertanyaan disusun AI. Skor responden HANYA diambil dari data survei per responden di dokumen (bisa diedit, boleh kosong);
// bila tidak ada, tabel berisi baris "Responden 1…n" kosong untuk diisi pengguna.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { GridBuilder, addr, num, range, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { result } from "@/lib/validators/common";
import { QUOTE_CHECK, blank, contextBlock, countProblem, findQuote, idProblems, noteOf, evidenceRefs, quoteCheck, strategyJudge, type Upstream } from "./common";
import { msdmRetention } from "./retention";
import { msdmPenilaian } from "./penilaian";

export const SCALE_MIN = 1;
export const SCALE_MAX = 10;

const Question = z.object({
  /** Q1, Q2, … berurutan (menjadi kepala kolom tabel responden). */
  id: z.string(),
  text: z.string().min(5),
  /** Aspek engagement yang diukur (mis. komunikasi, beban kerja, apresiasi). */
  aspek: z.string().default(""),
  evidence: z.array(Evidence).default([]),
});

const Respondent = z.object({
  /** R1, R2, … */
  id: z.string(),
  /** Label anonim: "Responden 1", "Responden 2", … (jangan nama orang). */
  label: z.string(),
  /** Skor per ID pertanyaan pada skala 1–10; null = belum diisi. */
  scores: z.record(z.string(), z.number().int().min(SCALE_MIN).max(SCALE_MAX).nullable()),
});

export const SeparationOutput = z.object({
  questions: z.array(Question),
  respondents: z.array(Respondent),
  /** "dokumen" = skor diambil dari data survei per responden di dokumen; "kosong" = belum ada data (diisi pengguna). */
  sumberData: z.enum(["dokumen", "kosong"]).default("kosong"),
  /** Bukti data skor di dokumen (wajib bila ada skor yang diisi AI). */
  dataEvidence: z.array(Evidence).default([]),
  /** Penjelasan singkat asal data/alasan tabel kosong. */
  catatanData: z.string().default(""),
});
export type SeparationOutput = z.infer<typeof SeparationOutput>;

export type Kategori = "Tinggi" | "Sedang" | "Rendah";
export type SeparationComputed = SeparationOutput & {
  /** Rata-rata per pertanyaan (=AVERAGE kolom; sel kosong diabaikan); null bila belum ada skor. */
  averages: Record<string, number | null>;
  /** Rata-rata per responden; null bila belum ada skor. */
  respondentAverages: Record<string, number | null>;
  /** Rata-rata baris AVERAGE (semua pertanyaan yang berskor). */
  overall: number | null;
  kategori: Record<string, Kategori | null>;
  /** Hingga tiga pertanyaan dengan rata-rata terendah (prioritas perhatian). */
  lowest: string[];
  jumlahSkor: number;
};

// ---------- Perhitungan ----------

/** AVERAGE ala Excel: sel kosong diabaikan; tanpa angka → null (Excel: #DIV/0!, di ekspor dibungkus IFERROR → kosong). */
export const average = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
export const kategoriOf = (x: number | null): Kategori | null => (x === null ? null : x >= 8 ? "Tinggi" : x >= 6 ? "Sedang" : "Rendah");

export function computeSeparation(out: SeparationOutput): SeparationComputed {
  const qs = out.questions.map((q) => q.id);
  const averages = Object.fromEntries(qs.map((q) => [q, average(out.respondents.map((r) => r.scores?.[q]))]));
  const respondentAverages = Object.fromEntries(out.respondents.map((r) => [r.id, average(qs.map((q) => r.scores?.[q]))]));
  const overall = average(qs.map((q) => averages[q]));
  const kategori = Object.fromEntries(qs.map((q) => [q, kategoriOf(averages[q])]));
  const lowest = qs
    .filter((q) => averages[q] !== null)
    .sort((a, b) => (averages[a] as number) - (averages[b] as number) || qs.indexOf(a) - qs.indexOf(b))
    .slice(0, 3);
  const jumlahSkor = out.respondents.reduce((s, r) => s + qs.filter((q) => typeof r.scores?.[q] === "number").length, 0);
  return { ...out, averages, respondentAverages, overall, kategori, lowest, jumlahSkor };
}

// ---------- Mock ----------

const UPSTREAM: Upstream[] = [msdmPenilaian, msdmRetention];

const MOCK_Q: [aspek: string, text: (org: string) => string, q: string][] = [
  ["Lingkungan kerja", (o) => `Seberapa puas Anda dengan lingkungan dan budaya kerja di ${o}?`, "lingkungan budaya kerja kekeluargaan"],
  ["Kerja sama", () => "Seberapa puas Anda dengan hubungan dan kerja sama antaranggota?", "kerja sama antaranggota"],
  ["Komunikasi", () => "Seberapa efektif komunikasi internal yang berlangsung di organisasi?", "komunikasi informasi internal"],
  ["Koordinasi", () => "Seberapa puas Anda dengan koordinasi antara pimpinan, kepala bidang, dan staf?", "koordinasi pimpinan bidang"],
  ["Kejelasan peran", () => "Seberapa jelas Anda memahami peran, tanggung jawab, dan tugas posisi Anda?", "peran tanggung jawab tugas"],
  ["Arahan kerja", () => "Seberapa jelas arahan kerja yang diberikan pimpinan kepada Anda?", "arahan kerja pimpinan"],
  ["Beban kerja", () => "Seberapa puas Anda dengan pembagian beban kerja yang diberikan kepada Anda?", "beban kerja pembagian"],
  ["Pengaturan waktu", () => "Seberapa baik pengaturan waktu dan tenggat pekerjaan menurut Anda?", "tenggat waktu jadwal tertunda"],
  ["Kepemimpinan", () => "Seberapa puas Anda dengan gaya kepemimpinan dan pendampingan pimpinan?", "kepemimpinan pendampingan"],
  ["Umpan balik", () => "Seberapa efektif umpan balik dan evaluasi yang diberikan atas pekerjaan Anda?", "evaluasi umpan balik"],
  ["Pengembangan", () => "Seberapa besar kesempatan Anda mengembangkan kompetensi selama menjadi pengurus?", "pelatihan kompetensi pengembangan"],
  ["Transfer pengetahuan", () => "Seberapa efektif proses berbagi pengetahuan dan informasi di organisasi?", "dokumentasi berbagi pengetahuan"],
  ["Apresiasi", () => "Seberapa besar Anda merasa usaha dan kontribusi Anda dihargai?", "apresiasi penghargaan kontribusi"],
  ["Dampak kerja", (o) => `Seberapa besar Anda merasa pekerjaan Anda berkontribusi pada keberjalanan ${o}?`, "dampak kontribusi program"],
  ["Rasa memiliki", () => "Seberapa besar Anda merasa menjadi bagian penting dari organisasi?", "rasa memiliki bagian"],
  ["Makna kerja", () => "Seberapa besar Anda merasa pekerjaan Anda bermakna dan bertujuan jelas?", "tujuan makna program"],
  ["Keterbukaan", () => "Seberapa nyaman Anda menyampaikan pendapat, kritik, atau keresahan kepada anggota maupun pimpinan?", "aspirasi pendapat keresahan"],
  ["Responsivitas", () => "Seberapa baik organisasi merespons dan menyelesaikan permasalahan yang dihadapi staf?", "tindak lanjut masalah"],
  ["Keselarasan visi", () => "Seberapa sesuai aktivitas Anda dengan visi, misi, dan arah gerak organisasi?", "visi misi arah"],
  ["Engagement keseluruhan", () => "Secara keseluruhan, seberapa puas dan terlibat (engaged) Anda selama menjadi pengurus?", "kepuasan keseluruhan"],
];

function mock(ctx: NodeContext): SeparationOutput {
  const used = new Set<string>();
  const questions = MOCK_Q.map(([aspek, text, q], i) => {
    const ev = findQuote(ctx.evidence, q, used, 2);
    return { id: `Q${i + 1}`, text: text(ctx.projectName), aspek, evidence: ev ? [ev] : [] };
  });
  return {
    questions,
    respondents: Array.from({ length: 5 }, (_, i) => ({ id: `R${i + 1}`, label: `Responden ${i + 1}`, scores: Object.fromEntries(questions.map((q) => [q.id, null])) })),
    sumberData: "kosong",
    dataEvidence: [],
    catatanData: "Dokumen tidak memuat skor survei per responden; isi tabel dari hasil survei engagement staf (skala 1–10).",
  };
}

// ---------- Butir, sheet, blok ----------

function items(out: unknown) {
  const o = out as SeparationComputed;
  return (o.questions ?? []).map((q) => ({
    id: q.id,
    text: q.text,
    detail: [q.aspek, o.averages?.[q.id] !== null && o.averages?.[q.id] !== undefined ? `rata-rata ${num(o.averages[q.id], 2)} (${o.kategori?.[q.id]})` : "belum ada skor"].filter(Boolean).join(" · "),
  }));
}

const RED = "E06666";

function sheet(o: SeparationComputed): Grid {
  const g = new GridBuilder("separation", "MSDMSEPARATION", "Engagement surveys");
  const Q = o.questions;
  const R = o.respondents;
  const C0 = 6; // kolom G = Q1
  const cAvg = C0 + Q.length; // rata-rata responden
  // Excel baris 2: judul kuesioner (B:D) dan kepala tabel responden (F, G…)
  g.set(1, 1, "ENGAGEMENT SURVEYS", { style: "header", fill: RED, cs: 3 });
  g.set(1, 5, "Kuisioner", { style: "header", fill: RED });
  Q.forEach((q, j) => g.set(1, C0 + j, q.id, { style: "header", fill: RED, center: true, note: q.text }));
  g.set(1, cAvg, "Rata-rata responden", { style: "header", fill: RED, note: "Tambahan (bukan di Excel): rata-rata skor tiap responden, untuk melihat staf yang keterikatannya rendah." });
  // Daftar pertanyaan (B:D)
  Q.forEach((q, i) => {
    g.set(2 + i, 1, q.id, { style: "label" });
    g.set(2 + i, 2, q.text, {
      style: "text",
      src: "ai",
      note: noteOf(q.aspek ? `Aspek: ${q.aspek}` : undefined, q.evidence),
      refs: evidenceRefs(q.evidence),
      edit: { path: ["questions", i, "text"], type: "text" },
    });
    g.set(2 + i, 3, "Scale 01–10", { style: "muted", src: "tetap" });
  });
  // Tabel responden (F…)
  const r0 = 2;
  const rN = r0 + R.length - 1;
  R.forEach((resp, i) => {
    const r = r0 + i;
    g.set(r, 5, resp.label, { style: "label", src: "ai", edit: { path: ["respondents", i, "label"], type: "text" } });
    Q.forEach((q, j) => {
      const v = resp.scores?.[q.id];
      g.set(r, C0 + j, typeof v === "number" ? v : null, {
        style: "int",
        center: true,
        src: o.sumberData === "dokumen" && typeof v === "number" ? "dokumen" : "ai",
        refs: o.sumberData === "dokumen" && typeof v === "number" ? evidenceRefs(o.dataEvidence) : undefined,
        edit: { path: ["respondents", i, "scores", q.id], type: "number", min: SCALE_MIN, max: SCALE_MAX, step: 1, allowEmpty: true },
      });
    });
    const ra = o.respondentAverages?.[resp.id] ?? null;
    g.set(r, cAvg, ra, {
      style: "num",
      fmt: "0.00",
      src: "hitung",
      display: ra === null ? "–" : undefined,
      f: Q.length ? `IFERROR(AVERAGE(${range(r, C0, r, cAvg - 1)}),"")` : undefined,
      explain: ra === null ? `${resp.label} belum punya skor.` : `Rata-rata ${resp.label} = rata-rata skor yang terisi = ${num(ra, 2)} (${kategoriOf(ra)})`,
    });
  });
  const rA = r0 + R.length; // baris AVERAGE
  g.set(rA, 5, "AVERAGE", { style: "total" });
  Q.forEach((q, j) => {
    const c = C0 + j;
    const v = o.averages?.[q.id] ?? null;
    const n = R.filter((x) => typeof x.scores?.[q.id] === "number").length;
    g.set(rA, c, v, {
      style: "total",
      fmt: "0.00",
      src: "hitung",
      display: v === null ? "–" : undefined,
      f: R.length ? `IFERROR(AVERAGE(${range(r0, c, rN, c)}),"")` : undefined,
      explain: v === null ? `Rata-rata ${q.id}: belum ada skor responden.` : `Rata-rata ${q.id} = jumlah skor ÷ jumlah responden yang mengisi = ${num(v * n, 0)} ÷ ${n} = ${num(v, 2)}`,
    });
  });
  // Interpretasi (tambahan, bukan di Excel)
  let r = rA + 2;
  g.set(r, 5, "Interpretasi", { style: "subheader", cs: 2, note: "Tambahan di luar Excel untuk membaca hasil: kategori Tinggi ≥ 8, Sedang ≥ 6, Rendah < 6." });
  r++;
  g.set(r, 5, "Kategori", { style: "label" });
  Q.forEach((q, j) => {
    const a = addr(rA, C0 + j);
    const k = o.kategori?.[q.id] ?? null;
    g.set(r, C0 + j, k, {
      style: "text",
      center: true,
      src: "hitung",
      fill: k === "Tinggi" ? "D9F2E3" : k === "Rendah" ? "FAD7D7" : k === "Sedang" ? "FFF2CC" : undefined,
      f: `IF(${a}="","",IF(${a}>=8,"Tinggi",IF(${a}>=6,"Sedang","Rendah")))`,
      explain: k === null ? "Belum ada rata-rata." : `Rata-rata ${num(o.averages[q.id], 2)} → ${k} (Tinggi ≥ 8, Sedang ≥ 6, Rendah < 6)`,
    });
  });
  r++;
  const rO = r;
  g.set(rO, 5, "Rata-rata keseluruhan", { style: "label" });
  g.set(rO, C0, o.overall, {
    style: "total",
    fmt: "0.00",
    src: "hitung",
    display: o.overall === null ? "–" : undefined,
    f: Q.length ? `IFERROR(AVERAGE(${range(rA, C0, rA, cAvg - 1)}),"")` : undefined,
    explain: o.overall === null ? "Belum ada skor." : `Rata-rata baris AVERAGE (${Q.filter((q) => o.averages[q.id] !== null).length} pertanyaan berskor) = ${num(o.overall, 2)} (${kategoriOf(o.overall)})`,
  });
  g.anchor("overall", rO, C0);
  r++;
  g.set(r, 5, "Perlu perhatian", { style: "label" });
  g.set(r, C0, o.lowest.length ? o.lowest.map((id) => `${id} (${num(o.averages[id], 2)})`).join(", ") : "–", {
    style: "text",
    src: "hitung",
    cs: Math.max(1, Math.min(8, Q.length)),
    explain: o.lowest.length ? "Tiga pertanyaan dengan rata-rata terendah — aspek yang paling berisiko membuat staf tidak bertahan." : "Belum ada skor.",
  });
  r += 2;
  g.set(r, 5, "Sumber data", { style: "label" });
  g.set(r, C0, o.sumberData === "dokumen" ? "Data survei di dokumen" : "Belum ada data — isi skor responden", {
    style: "note",
    cs: Math.max(1, Math.min(8, Q.length)),
    note: noteOf(o.catatanData, o.dataEvidence),
    refs: evidenceRefs(o.dataEvidence),
  });

  const data = Q.filter((q) => o.averages?.[q.id] !== null && o.averages?.[q.id] !== undefined).map((q) => ({ label: q.id, value: o.averages[q.id] as number }));
  return g.build({
    cols: [2, 6, 60, 12, 2, 22, ...Q.map(() => 6), 12],
    freeze: { rows: 2, cols: 6 },
    chart: data.length ? { type: "bar", title: "ENGAGEMENT SURVEYS — rata-rata skor per pertanyaan", data, max: SCALE_MAX } : undefined,
    notes: [
      "Kiri: daftar pertanyaan survei keterikatan (skala 1–10). Kanan: skor tiap responden per pertanyaan dan baris AVERAGE.",
      o.jumlahSkor
        ? "Rata-rata mengabaikan sel kosong (seperti AVERAGE di Excel). Pertanyaan berkategori Rendah menandai aspek yang berisiko membuat staf keluar."
        : "Belum ada skor: isi tabel responden dari hasil survei (nama responden diganti \"Responden 1, 2, …\"); rata-rata dan grafik dihitung otomatis.",
      "Baris Interpretasi adalah tambahan untuk membantu membaca hasil (tidak ada di Excel).",
    ],
  });
}

function blocks(o: SeparationComputed): Block[] {
  return [
    { type: "h2", text: "Separation — engagement surveys" },
    {
      type: "table",
      head: ["ID", "Pertanyaan (skala 1–10)", "Aspek", "Rata-rata", "Kategori"],
      rows: o.questions.map((q) => [q.id, q.text, q.aspek, o.averages[q.id] === null ? "–" : num(o.averages[q.id], 2), o.kategori[q.id] ?? "–"]),
      widths: [6, 52, 18, 12, 12],
    },
    {
      type: "p",
      text:
        o.overall === null
          ? `Skor survei belum diisi (${o.respondents.length} baris responden kosong). ${o.catatanData}`
          : `Rata-rata keseluruhan ${num(o.overall, 2)} dari ${o.respondents.length} responden; perlu perhatian: ${o.lowest.map((id) => `${id} (${num(o.averages[id], 2)})`).join(", ")}.`,
    },
  ];
}

const FORMULAS: FormulaDoc[] = [
  { name: "Rata-rata per pertanyaan", rumus: "AVERAGE = jumlah skor ÷ jumlah responden yang mengisi", arti: "Skor keterikatan rata-rata untuk satu pertanyaan (sel kosong diabaikan).", excel: '=AVERAGE(G3:G6) — di ekspor: =IFERROR(AVERAGE(G3:G6),"")' },
  { name: "Rata-rata responden", rumus: "Rata-rata skor satu responden di semua pertanyaan", arti: "Tambahan: menunjukkan staf yang keterikatannya rendah.", excel: '=IFERROR(AVERAGE(G3:Z3),"")' },
  { name: "Kategori", rumus: "Tinggi bila ≥ 8, Sedang bila ≥ 6, selain itu Rendah", arti: "Tambahan untuk membaca rata-rata per pertanyaan.", excel: '=IF(G7="","",IF(G7>=8,"Tinggi",IF(G7>=6,"Sedang","Rendah")))' },
  { name: "Rata-rata keseluruhan", rumus: "Rata-rata baris AVERAGE", arti: "Tingkat keterikatan staf secara umum.", excel: '=IFERROR(AVERAGE(G7:Z7),"")' },
];

export const msdmSeparation: NodeDef<SeparationOutput> = {
  key: "msdm_separation",
  label: "MSDM – Separation",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMSEPARATION",
  deps: [],
  kind: "llm",
  description:
    "Engagement survey staf: kuesioner Q1…Qn (skala 1–10) dan tabel skor responden dengan rata-rata per pertanyaan beserta grafiknya; skor diambil dari data survei di dokumen bila ada, selain itu diisi pengguna.",
  computedBy: "LLM (kuesioner, ekstraksi skor) + kode (rata-rata)",
  schema: SeparationOutput,
  checks: [
    { name: "questionnaire_complete", kind: "code", description: "Kuesioner belum lengkap: 10–25 pertanyaan ber-ID Q1, Q2, … berurutan dan tidak kosong" },
    { name: "score_keys", kind: "code", description: "Skor responden merujuk pertanyaan yang tidak ada, ID responden ganda, atau tidak ada baris responden untuk diisi" },
    { name: "respondent_anonim", kind: "code", description: 'Label responden harus anonim ("Responden 1", "Responden 2", …), bukan nama orang' },
    { name: "data_grounded", kind: "code", description: "Skor responden diisi tanpa bukti data survei per responden di dokumen" },
    QUOTE_CHECK,
    { name: "question_relevance", kind: "llm", description: "Pertanyaan tidak mengukur aspek keterikatan staf yang relevan, atau kalimatnya menggiring" },
  ],
  queries: () => [
    { focus: "survei", text: "survei kuesioner responden skor kepuasan skala penilaian anggota pengurus", k: 6 },
    { focus: "keterikatan", text: "keaktifan kehadiran pengurus menurun keluar mundur motivasi keterlibatan", k: 4 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun ENGAGEMENT SURVEY staf (tahap separation: mendeteksi staf yang berisiko keluar).
Aturan:
1. questions: 12–20 pertanyaan berurutan Q1, Q2, … dijawab dengan skala 1–10 ("Seberapa …"), netral (tidak menggiring), masing-masing mengukur satu aspek ("aspek"): lingkungan kerja, kerja sama, komunikasi, koordinasi, kejelasan peran, arahan, beban kerja, waktu, kepemimpinan, umpan balik, pengembangan, berbagi pengetahuan, apresiasi, dampak, rasa memiliki, makna, keterbukaan, responsivitas, keselarasan visi; pertanyaan terakhir = engagement keseluruhan.
   Sesuaikan dengan masalah di dokumen dan hasil retention/penilaian; pertanyaan yang menanggapi masalah di dokumen beri bukti. ${EVIDENCE_RULES}
2. respondents: skor HANYA boleh diambil dari data survei PER RESPONDEN di dokumen (tabel skor tiap orang pada pertanyaan yang setara). Jangan mengarang dan jangan mengubah persentase/ringkasan agregat menjadi skor responden.
   - Bila data per responden ada: sumberData = "dokumen", isi scores (bilangan bulat 1–10; skala lain dikonversi linear dan jelaskan di catatanData), bukti di dataEvidence.
   - Bila tidak ada: sumberData = "kosong", buat 5 baris responden dengan semua skor null, dan jelaskan di catatanData.
   - scores berbentuk objek {"Q1": 7, "Q2": null, …} memakai ID pertanyaan.
3. Label responden WAJIB anonim: "Responden 1", "Responden 2", … (id R1, R2, …) — jangan pernah menulis nama orang.
4. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(SeparationOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const Q = out.questions;
    const qids = new Set(Q.map((q) => q.id));
    const qc: Failure[] = [
      ...countProblem(Q.length, 10, 25, "Pertanyaan kuesioner", "questionnaire_complete"),
      ...idProblems(Q, "Kuesioner", "questionnaire_complete"),
      ...Q.filter((q, i) => q.id !== `Q${i + 1}`).map((q) => ({ check: "questionnaire_complete", itemId: q.id, message: `ID pertanyaan ke-${Q.indexOf(q) + 1} harus Q${Q.indexOf(q) + 1} (tertulis ${q.id}).` })),
      ...Q.filter((q) => blank(q.text)).map((q) => ({ check: "questionnaire_complete", itemId: q.id, message: `${q.id}: teks pertanyaan kosong.` })),
    ];
    const sk: Failure[] = [
      ...(out.respondents.length ? [] : [{ check: "score_keys", message: "Tidak ada baris responden; buat minimal satu baris (skor boleh kosong) agar bisa diisi pengguna." }]),
      ...idProblems(out.respondents, "Responden", "score_keys"),
      ...out.respondents.flatMap((r) => {
        const bad = Object.keys(r.scores ?? {}).filter((k) => !qids.has(k));
        return bad.length ? [{ check: "score_keys", itemId: r.id, message: `${r.label}: skor untuk pertanyaan yang tidak ada (${bad.join(", ")}).` }] : [];
      }),
    ];
    const anon: Failure[] = out.respondents
      .filter((r) => !/^responden\s+\d+$/i.test(r.label.trim()))
      .map((r) => ({ check: "respondent_anonim", itemId: r.id, message: `Label "${r.label}" harus anonim seperti "Responden 1".` }));
    const nScores = out.respondents.reduce((s, r) => s + Object.values(r.scores ?? {}).filter((v) => typeof v === "number").length, 0);
    const dg: Failure[] = [
      ...(nScores && (out.sumberData !== "dokumen" || !out.dataEvidence.length)
        ? [{ check: "data_grounded", message: `${nScores} skor diisi tanpa bukti data survei per responden (sumberData "dokumen" + dataEvidence). Kosongkan skor bila dokumen tidak memuatnya.` }]
        : []),
      ...(!nScores && out.sumberData === "dokumen" ? [{ check: "data_grounded", message: 'sumberData "dokumen" tetapi tidak ada skor yang diisi.' }] : []),
    ];
    return [
      result("questionnaire_complete", "code", qc),
      result("score_keys", "code", sk),
      result("respondent_anonim", "code", anon),
      result("data_grounded", "code", dg),
      quoteCheck([...Q, { id: "DATA", evidence: out.dataEvidence }], ctx.evidence),
      await strategyJudge(
        llm,
        ctx,
        "question_relevance",
        "Periksa apakah setiap pertanyaan mengukur satu aspek keterikatan (engagement) staf yang relevan untuk mendeteksi risiko staf keluar, dapat dijawab dengan skala 1–10, dan tidak menggiring.",
        Q.map((q) => ({ id: q.id, text: `${q.text}${q.aspek ? ` (aspek: ${q.aspek})` : ""}` })),
      ),
    ];
  },
  compute: (out) => computeSeparation(out),
  repairHint: "Perbaiki hanya pertanyaan/data yang ditolak; bagian lain salin apa adanya. Jangan mengarang skor.",
  items,
  sheets: (out) => [sheet(out as SeparationComputed)],
  blocks: (out) => blocks(out as SeparationComputed),
  formulas: FORMULAS,
  summary: (out) => {
    const o = out as SeparationComputed;
    return o.overall === null || o.overall === undefined
      ? `Engagement survey: ${o.questions?.length ?? 0} pertanyaan, ${o.respondents?.length ?? 0} baris responden belum berskor.`
      : `Engagement survey: rata-rata ${num(o.overall, 2)} dari ${o.respondents.length} responden; terendah ${o.lowest.join(", ")}.`;
  },
};

