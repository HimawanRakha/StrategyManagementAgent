// MSDM – Onboarding (tab MSDMONBOARDING, "Staff Work Style Analysis"): rangkaian kegiatan onboarding staf baru —
// No | Nama Kegiatan | Agenda (bernomor) | Tujuan.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { GridBuilder, type Block, type Grid } from "@/lib/sheets/grid";
import { norm, result } from "@/lib/validators/common";
import {
  QUOTE_CHECK,
  REF_CHECK,
  blank,
  contextBlock,
  countProblem,
  evidenceRefs,
  findQuote,
  idProblems,
  noteOf,
  numbered,
  quoteCheck,
  refCheck,
  strategyJudge,
  type Upstream,
  validRefIds,
} from "./common";
import { msdmAttraction } from "./attraction";
import { msdmRecruitment, type RecruitmentOutput } from "./recruitment";

const Kegiatan = z.object({
  /** OB1, OB2, … (urutan pelaksanaan). */
  id: z.string(),
  nama: z.string().min(3),
  /** Butir agenda (ditampilkan bernomor). */
  agenda: z.array(z.string().min(3)),
  tujuan: z.string().min(5),
  /** ID butir attraction/recruitment/strategi yang didukung. */
  refs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});

export const OnboardingOutput = z.object({ kegiatan: z.array(Kegiatan) });
export type OnboardingOutput = z.infer<typeof OnboardingOutput>;

const UPSTREAM: Upstream[] = [msdmAttraction, msdmRecruitment];

/** Topik yang lazim wajib ada di onboarding staf baru (cek kode berbasis kata kunci). */
export const ONBOARDING_TOPICS: { key: string; label: string; re: RegExp }[] = [
  { key: "visi", label: "pengenalan visi, misi, dan arah gerak organisasi", re: /\b(visi|misi|arah gerak|arah organisasi|nilai organisasi|grand design)\b/ },
  { key: "struktur", label: "pengenalan struktur, peran, dan job description", re: /\b(struktur|peran|job ?desc\w*|tupoksi|jobdesk|pembagian (peran|tugas)|fungsi)\b/ },
  { key: "sop", label: "pengenalan SOP dan alur kerja", re: /\b(sop|alur kerja|prosedur|tata cara|mekanisme)\b/ },
  { key: "bonding", label: "bonding / pengenalan antaranggota", re: /\b(bonding|keakraban|kebersamaan|perkenalan|pengenalan sesama|team building|antaranggota)\b/ },
  { key: "rencana", label: "penyelarasan program kerja dan target", re: /\b(program kerja|proker|rapat kerja|raker|target|rencana kerja|arahan kerja)\b/ },
];

function topicsCovered(out: OnboardingOutput) {
  const text = norm(out.kegiatan.map((k) => `${k.nama} ${k.agenda.join(" ")} ${k.tujuan}`).join(" "));
  return ONBOARDING_TOPICS.map((t) => ({ ...t, ok: t.re.test(text) }));
}

const MOCK: { nama: string; agenda: string[]; tujuan: string; q: string }[] = [
  {
    nama: "Welcome Party & Onboarding",
    agenda: ["Apresiasi dan penyambutan staf baru", "Pemaparan visi, misi, dan arah gerak organisasi", "Penjelasan struktur organisasi beserta peran dan fungsinya", "Perkenalan pimpinan dan sesama anggota bidang"],
    tujuan: "Membangun rasa memiliki terhadap organisasi, memberi pemahaman awal tentang arah organisasi, dan menciptakan lingkungan kerja yang nyaman bagi staf baru",
    q: "pengenalan visi misi organisasi struktur staf baru",
  },
  {
    nama: "First Meeting & Work Alignment",
    agenda: ["Pemaparan fungsi dan ruang lingkup kerja tiap bidang", "Penjelasan job description dan pembagian peran", "Pembahasan program kerja dan target bidang", "Pengenalan SOP administrasi dan keuangan", "Penyesuaian gaya kerja dan pola komunikasi"],
    tujuan: "Menyamakan pemahaman mengenai tugas, fungsi, alur kerja, dan SOP serta membentuk pola kerja yang efektif di tiap bidang",
    q: "sop administrasi keuangan alur kerja pembagian tugas",
  },
  {
    nama: "Team Bonding & Work System",
    agenda: ["Bonding antaranggota", "Pendalaman karakter dan gaya kerja antaranggota", "Penyusunan pola komunikasi dan koordinasi internal", "Penyusunan mekanisme monitoring pekerjaan", "Identifikasi potensi kendala dan kebutuhan bidang"],
    tujuan: "Membangun hubungan kerja yang kolaboratif sekaligus sistem kerja yang jelas dan sesuai karakter anggota",
    q: "koordinasi komunikasi internal monitoring kendala pengurus",
  },
  {
    nama: "Pra Rapat Kerja",
    agenda: ["Pemaparan arahan kerja tiap bidang kepada seluruh pengurus", "Penyelarasan program dan target antarbidang", "Identifikasi potensi tumpang tindih pekerjaan", "Pemberian masukan dan rekomendasi antarbidang"],
    tujuan: "Memastikan seluruh pengurus memahami arah kerja tiap bidang dan tercipta sinergi sebelum rapat kerja",
    q: "program kerja jadwal bentrok koordinasi antarbidang",
  },
  {
    nama: "Rapat Kerja",
    agenda: ["Pembahasan arahan kerja organisasi", "Penetapan program kerja dan target tiap bidang", "Penetapan indikator keberhasilan dan mekanisme monitoring", "Penyepakatan sistem koordinasi dan evaluasi"],
    tujuan: "Menghasilkan arah kerja, program, target, dan sistem koordinasi yang terarah, terukur, dan selaras dengan tujuan organisasi selama satu periode",
    q: "rencana kerja program evaluasi target indikator",
  },
];

function mock(ctx: NodeContext): OnboardingOutput {
  const used = new Set<string>();
  const rec = ctx.inputs.msdm_recruitment as RecruitmentOutput | undefined;
  const kuRefs = (rec?.kriteriaUmum ?? []).map((k) => k.id);
  const posRefs = (rec?.positions ?? []).map((p) => p.id);
  return {
    kegiatan: MOCK.map((m, i) => {
      const ev = findQuote(ctx.evidence, m.q, used);
      const refs = i === 1 && posRefs.length ? posRefs.slice(0, 2) : i === 0 && kuRefs.length ? [kuRefs[kuRefs.length - 1]] : [];
      return { id: `OB${i + 1}`, nama: m.nama, agenda: m.agenda, tujuan: m.tujuan, refs, evidence: ev ? [ev] : [] };
    }),
  };
}

function items(out: unknown) {
  return ((out as OnboardingOutput).kegiatan ?? []).map((k) => ({ id: k.id, text: k.nama, detail: `Agenda: ${k.agenda.join("; ")} | Tujuan: ${k.tujuan}` }));
}

const GREEN = "B6D7A8";

function sheet(out: OnboardingOutput): Grid {
  const g = new GridBuilder("onboarding", "MSDMONBOARDING", "Staff Work Style Analysis");
  g.set(0, 0, "Staff Work Style Analysis", { style: "title", fill: GREEN, cs: 4 });
  g.row(1, 0, ["No.", "Nama Kegiatan", "Agenda", "Tujuan"], { style: "header", fill: GREEN });
  let r = 2;
  out.kegiatan.forEach((k, i) => {
    const n = Math.max(1, k.agenda.length);
    g.set(r, 0, i + 1, { style: "int", center: true, rs: n });
    g.set(r, 1, k.nama, { style: "label", src: "ai", rs: n, note: noteOf(undefined, k.evidence, k.refs), refs: evidenceRefs(k.evidence), edit: { path: ["kegiatan", i, "nama"], type: "text" } });
    k.agenda.forEach((a, j) =>
      g.set(r + j, 2, a, { style: "text", src: "ai", display: `${j + 1}. ${a}`, edit: { path: ["kegiatan", i, "agenda", j], type: "text" } }),
    );
    if (!k.agenda.length) g.set(r, 2, "(belum ada agenda)", { style: "muted" });
    g.set(r, 3, k.tujuan, { style: "text", src: "ai", rs: n, edit: { path: ["kegiatan", i, "tujuan"], type: "text" } });
    r += n;
  });
  return g.build({
    cols: [6, 28, 60, 50],
    notes: [
      "Rangkaian kegiatan onboarding staf baru, diurutkan sesuai waktu pelaksanaan.",
      "Setiap kegiatan punya agenda bernomor dan tujuan; teks dari AI bisa Anda ubah per baris agenda.",
      "Klik nama kegiatan untuk melihat dasar (kriteria/posisi rekrutmen atau kutipan dokumen) yang dipakai.",
    ],
  });
}

function blocks(out: OnboardingOutput): Block[] {
  return [
    { type: "h2", text: "Onboarding — Staff Work Style Analysis" },
    { type: "table", head: ["No.", "Nama Kegiatan", "Agenda", "Tujuan"], rows: out.kegiatan.map((k, i) => [String(i + 1), k.nama, numbered(k.agenda), k.tujuan]), widths: [6, 22, 42, 30] },
  ];
}

export const msdmOnboarding: NodeDef<OnboardingOutput> = {
  key: "msdm_onboarding",
  label: "MSDM – Onboarding",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMONBOARDING",
  deps: [],
  kind: "llm",
  description:
    "Rangkaian kegiatan onboarding staf baru (Staff Work Style Analysis): nama kegiatan, agenda bernomor, dan tujuannya — dari penyambutan sampai rapat kerja.",
  computedBy: "LLM",
  schema: OnboardingOutput,
  checks: [
    { name: "kegiatan_complete", kind: "code", description: "Onboarding belum lengkap: 3–7 kegiatan ber-ID unik, tiap kegiatan 3–9 butir agenda dan tujuan terisi" },
    { name: "topic_coverage", kind: "code", description: "Onboarding belum mencakup topik wajib: visi-misi, struktur & peran, SOP/alur kerja, bonding, serta program kerja & target" },
    QUOTE_CHECK,
    REF_CHECK,
    { name: "tujuan_selaras", kind: "llm", description: "Agenda kegiatan tidak mendukung tujuannya atau tidak selaras dengan arah organisasi" },
  ],
  queries: () => [
    { focus: "onboarding", text: "pengenalan pengurus baru orientasi kaderisasi welcome party rapat kerja upgrading", k: 5 },
    { focus: "sistem kerja", text: "SOP alur kerja koordinasi komunikasi internal pembagian tugas job description", k: 5 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun rangkaian ONBOARDING staf baru ("Staff Work Style Analysis") untuk pengurus yang lolos rekrutmen.
Aturan:
1. 4–6 kegiatan berurutan sesuai waktu pelaksanaan (ID OB1, OB2, …), mis. penyambutan → penyelarasan kerja → bonding & sistem kerja → pra rapat kerja → rapat kerja.
2. Tiap kegiatan: "nama", "agenda" (3–9 butir singkat, satu butir satu aktivitas; jangan tulis nomor di teks), "tujuan" (1 kalimat: hasil yang diharapkan).
3. Seluruh rangkaian WAJIB mencakup: ${ONBOARDING_TOPICS.map((t) => t.label).join("; ")}.
4. Sesuaikan dengan posisi/struktur hasil recruitment dan kebutuhan staf hasil attraction; tulis ID yang didukung di "refs" (hanya ID yang tercantum di konteks).
5. Agenda yang menanggapi masalah di dokumen (mis. SOP belum dipahami, koordinasi lemah) beri bukti. ${EVIDENCE_RULES}
6. Jangan menyebut nama orang. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(OnboardingOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const K = out.kegiatan;
    const comp: Failure[] = [
      ...countProblem(K.length, 3, 7, "Kegiatan onboarding", "kegiatan_complete"),
      ...idProblems(K, "Onboarding", "kegiatan_complete"),
      ...K.flatMap((k) => [
        ...countProblem(k.agenda.length, 3, 9, `Agenda ${k.nama}`, "kegiatan_complete", k.id),
        ...(blank(k.tujuan) ? [{ check: "kegiatan_complete", itemId: k.id, message: `${k.id} (${k.nama}): tujuan belum diisi.` }] : []),
      ]),
    ];
    const missing = topicsCovered(out).filter((t) => !t.ok);
    return [
      result("kegiatan_complete", "code", comp),
      result("topic_coverage", "code", missing.map((t) => ({ check: "topic_coverage", message: `Belum ada agenda tentang ${t.label}.` }))),
      quoteCheck(K, ctx.evidence),
      refCheck(K, validRefIds(ctx, UPSTREAM)),
      await strategyJudge(
        llm,
        ctx,
        "tujuan_selaras",
        "Periksa apakah agenda setiap kegiatan onboarding benar-benar mendukung tujuannya, dan tujuan itu membantu staf baru bekerja selaras dengan arah organisasi.",
        K.map((k) => ({ id: k.id, text: `${k.nama} — agenda: ${k.agenda.join("; ")} — tujuan: ${k.tujuan}` })),
      ),
    ];
  },
  repairHint: "Perbaiki hanya kegiatan yang ditolak atau tambahkan agenda untuk topik yang belum tercakup; kegiatan lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as OnboardingOutput)],
  blocks: (out) => blocks(out as OnboardingOutput),
  formulas: [],
  summary: (out) => {
    const o = out as OnboardingOutput;
    const k = o.kegiatan ?? [];
    return `Onboarding: ${k.length} kegiatan, ${k.reduce((s, x) => s + x.agenda.length, 0)} butir agenda (${k.map((x) => x.nama).join(" → ")}).`;
  },
};
