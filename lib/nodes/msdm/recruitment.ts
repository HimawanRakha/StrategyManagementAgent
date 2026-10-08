// MSDM – Recruitment (tab MSDMRECRUITMENT): kriteria umum calon pengurus, kriteria khusus per posisi (matriks),
// tugas tiap posisi (struktur), proses seleksi (pemberkasan & screening beserta alasannya), dan timeline seleksi.
// Tanggal timeline dihitung kode dari tanggal mulai + "hari ke-" agar pengguna cukup menggeser satu sel.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { GridBuilder, addr, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { result } from "@/lib/validators/common";
import type { Failure } from "../types";
import {
  QUOTE_CHECK,
  REF_CHECK,
  blank,
  contextBlock,
  countProblem,
  evidenceRefs,
  findQuote,
  idProblems,
  internalPositions,
  noteOf,
  numbered,
  quoteCheck,
  refCheck,
  strategyJudge,
  type Upstream,
  validRefIds,
} from "./common";
import { msdmAttraction, type AttractionOutput } from "./attraction";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const Kriteria = z.object({
  id: z.string(), // KU1…
  text: z.string().min(3),
  reason: z.string().default(""),
  /** ID butir attraction/strategi yang mendasari kriteria. */
  refs: z.array(z.string()).default([]),
});

const Position = z.object({
  id: z.string(), // P1…
  name: z.string().min(2),
  /** ID posisi atasan langsung; null = pucuk struktur. */
  atasan: z.string().nullable().default(null),
  tugas: z.string().min(5),
  /** Kriteria khusus posisi ini (kolom matriks kriteria khusus). */
  kriteria: z.array(z.string().min(3)),
  evidence: z.array(Evidence).default([]),
});

const Berkas = z.object({ id: z.string(), what: z.string().min(3), reason: z.string().default("") }); // B1…
const Pertanyaan = z.object({ id: z.string(), question: z.string().min(3), reason: z.string().default("") }); // W1…

const Step = z.object({
  id: z.string(), // T1…
  tahap: z.string().min(2),
  kegiatan: z.string().default(""),
  /** Hari ke- (1 = hari pertama proses rekrutmen). */
  hariMulai: z.number().int().min(1).max(180),
  /** Lama tahap (hari). */
  durasi: z.number().int().min(1).max(60),
});

export const RecruitmentOutput = z.object({
  kriteriaUmum: z.array(Kriteria),
  positions: z.array(Position),
  pemberkasan: z.array(Berkas),
  screening: z.array(Pertanyaan),
  timeline: z.object({
    /** Tanggal hari ke-1 (YYYY-MM-DD); null bila belum ditentukan di dokumen. */
    tanggalMulai: z.string().regex(ISO, "format tanggal YYYY-MM-DD").nullable().default(null),
    steps: z.array(Step),
  }),
});
export type RecruitmentOutput = z.infer<typeof RecruitmentOutput>;

export type JadwalRow = { id: string; mulai: string | null; selesai: string | null; hariSelesai: number; label: string };
export type RecruitmentComputed = RecruitmentOutput & { jadwal: JadwalRow[]; totalHari: number };

// ---------- Tanggal (UTC, setara serial tanggal Excel) ----------

const DAY = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** "2026-02-14" → ms UTC; null bila bukan tanggal nyata. */
export function parseIsoDate(s: string | null | undefined): number | null {
  if (!s || !ISO.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? t : null;
}
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Serial tanggal Excel (1 = 1 Jan 1900). */
export const excelSerial = (t: number) => Math.round((t - EXCEL_EPOCH) / DAY);
const fmtDate = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
function fmtRange(a: number, b: number) {
  if (a === b) return fmtDate(a);
  const da = new Date(a);
  const db = new Date(b);
  if (da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth())
    return `${da.getUTCDate()}–${db.getUTCDate()} ${BULAN[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}

export function computeRecruitment(out: RecruitmentOutput): RecruitmentComputed {
  const start = parseIsoDate(out.timeline?.tanggalMulai);
  const jadwal = (out.timeline?.steps ?? []).map((s) => {
    const hariSelesai = s.hariMulai + s.durasi - 1;
    if (start === null)
      return { id: s.id, mulai: null, selesai: null, hariSelesai, label: s.durasi > 1 ? `Hari ke-${s.hariMulai}–${hariSelesai}` : `Hari ke-${s.hariMulai}` };
    const a = start + (s.hariMulai - 1) * DAY;
    const b = a + (s.durasi - 1) * DAY;
    return { id: s.id, mulai: isoOf(a), selesai: isoOf(b), hariSelesai, label: fmtRange(a, b) };
  });
  return { ...out, jadwal, totalHari: jadwal.reduce((m, j) => Math.max(m, j.hariSelesai), 0) };
}

// ---------- Mock ----------

const UPSTREAM: Upstream[] = [msdmAttraction];

const ROLE_TEMPLATES: { re: RegExp; tugas: string; kriteria: string[] }[] = [
  {
    re: /wakil/i,
    tugas: "Mendampingi pimpinan dalam mengoordinasikan bidang-bidang dan menggantikan peran pimpinan bila berhalangan.",
    kriteria: ["Memiliki kemampuan koordinasi lintas bidang", "Mampu memantau dan mengevaluasi jalannya program kerja", "Mampu berkomunikasi dengan baik kepada pengurus dan pihak luar", "Bertanggung jawab dan adaptif"],
  },
  {
    re: /ketua|presiden|sekretaris jenderal|sekjen|direktur/i,
    tugas: "Memimpin dan mengoordinasikan seluruh bidang agar program kerja berjalan sesuai arah strategi organisasi.",
    kriteria: ["Memiliki kemampuan kepemimpinan dan koordinasi lintas elemen organisasi", "Mampu berpikir sistematis, kritis, dan strategis", "Memahami tata kelola dan manajemen organisasi", "Memiliki integritas dan rasa tanggung jawab yang tinggi"],
  },
  {
    re: /sekretaris|administrasi/i,
    tugas: "Mengelola administrasi, persuratan, notulensi, dan arsip organisasi.",
    kriteria: ["Memiliki keterampilan dasar administrasi dan kesekretariatan", "Teliti dalam mengelola dokumen dan arsip", "Mampu mengelola basis data organisasi secara sistematis"],
  },
  {
    re: /bendahara|keuangan/i,
    tugas: "Mengelola anggaran, pencatatan, dan pelaporan keuangan organisasi secara transparan.",
    kriteria: ["Memiliki keterampilan dasar pengelolaan keuangan", "Teliti dan bertanggung jawab dalam pencatatan keuangan", "Memiliki integritas dan akuntabilitas"],
  },
  {
    re: /kepala|koordinator|menteri|kadep|kabiro|manajer/i,
    tugas: "Mengelola program dan agenda bidang, meneruskan arahan pimpinan, serta mengevaluasi kinerja anggota bidang.",
    kriteria: ["Mampu memimpin dan mengelola anggota bidang", "Mampu menyusun dan mengarahkan sistem kerja bidang", "Memiliki pengalaman mengelola tim atau kepanitiaan", "Mampu mengambil keputusan dan memecahkan masalah"],
  },
  {
    re: /staf|staff|anggota|asisten/i,
    tugas: "Membantu menjalankan program dan agenda bidang sesuai arahan dan lingkup kerja yang diberikan.",
    kriteria: ["Mampu bekerja sama dalam tim", "Mampu memahami dan menjalankan sistem kerja bidang", "Mampu bekerja dengan target dan tenggat waktu"],
  },
];
const DEFAULT_ROLE = {
  tugas: "Menjalankan fungsi bidang sesuai pembagian tugas organisasi.",
  kriteria: ["Berkomitmen dan bertanggung jawab", "Mampu bekerja sama dalam tim", "Mampu berkomunikasi dengan baik"],
};
const roleOf = (name: string) => ROLE_TEMPLATES.find((t) => t.re.test(name)) ?? DEFAULT_ROLE;

function mock(ctx: NodeContext): RecruitmentOutput {
  const names = internalPositions(ctx).slice(0, 6);
  const pos = names.length >= 2 ? names : ["Ketua", "Sekretaris", "Bendahara", "Kepala Divisi", "Staf Divisi"];
  const used = new Set<string>();
  const leadIdx = pos.findIndex((p) => /kepala|koordinator|menteri|kadep|kabiro|manajer/i.test(p));
  const positions = pos.map((name, i) => {
    const t = roleOf(name);
    const ev = findQuote(ctx.evidence, `${name} tugas tanggung jawab pengurus`, used, 2);
    const atasan = i === 0 ? null : /staf|staff|asisten|anggota/i.test(name) && leadIdx > 0 && leadIdx !== i ? `P${leadIdx + 1}` : "P1";
    return { id: `P${i + 1}`, name, atasan, tugas: t.tugas, kriteria: t.kriteria, evidence: ev ? [ev] : [] };
  });
  const att = ctx.inputs.msdm_attraction as AttractionOutput | undefined;
  const on = (att?.organizationNeed ?? []).map((p) => p.id);
  const refAt = (i: number) => (on.length ? [on[i % on.length]] : []);
  return {
    kriteriaUmum: [
      { id: "KU1", text: "Mahasiswa aktif yang terdaftar pada periode berjalan", reason: "Memastikan calon pengurus memenuhi status keanggotaan.", refs: [] },
      { id: "KU2", text: "Berkomitmen dan bertanggung jawab menjalankan amanah selama satu periode", reason: "Program kerja membutuhkan keterlibatan sampai evaluasi.", refs: refAt(0) },
      { id: "KU3", text: "Maksimal aktif di tiga organisasi atau kepanitiaan lain", reason: "Menjaga beban kerja agar tidak berbenturan dengan amanah organisasi.", refs: [] },
      { id: "KU4", text: "Bersedia mengikuti seluruh rangkaian onboarding dan pengembangan staf", reason: "Menyamakan pemahaman dan kompetensi sejak awal kepengurusan.", refs: refAt(1) },
    ],
    positions,
    pemberkasan: [
      { id: "B1", what: "Mengunggah kartu mahasiswa / bukti registrasi aktif", reason: "Untuk memvalidasi status dan ketentuan umum calon pengurus" },
      { id: "B2", what: "Mengunggah CV", reason: "Untuk mengetahui latar belakang, pengalaman, dan kompetensi calon pengurus" },
      { id: "B3", what: "Mengumpulkan studi kasus sesuai posisi yang dipilih", reason: "Untuk mengetahui kemampuan analisis dan pemahaman terhadap fungsi posisi" },
      { id: "B4", what: "Mengumpulkan portofolio bagi posisi yang membutuhkan karya (desain, media, publikasi)", reason: "Untuk menilai kompetensi teknis calon pengurus" },
      { id: "B5", what: "Mengisi data pengalaman organisasi dan kepanitiaan", reason: "Untuk mengetahui pengalaman koordinasi dan kerja sama calon pengurus" },
    ],
    screening: [
      { id: "W1", question: "Perkenalan diri secara singkat dan kreatif", reason: "Untuk mengetahui kemampuan komunikasi dan cara calon memperkenalkan dirinya" },
      { id: "W2", question: `Apa motivasi dan alasan Anda mendaftar di ${ctx.projectName}?`, reason: "Untuk mengetahui motivasi dan keseriusan calon pengurus" },
      { id: "W3", question: "Mengapa memilih posisi pilihan pertama dan kedua?", reason: "Untuk mengetahui kesesuaian minat dan kompetensi dengan posisi" },
      { id: "W4", question: "Apa kesibukan dan aktivitas Anda saat ini, dan bagaimana mengatur prioritasnya?", reason: "Untuk mengetahui kapasitas dan komitmen calon pengurus" },
      { id: "W5", question: "Ceritakan pengalaman menghadapi konflik atau masalah dalam tim", reason: "Untuk mengetahui kemampuan adaptasi dan penyelesaian konflik" },
      { id: "W6", question: "Gagasan apa yang ingin Anda kontribusikan untuk organisasi?", reason: "Untuk mengetahui kemampuan melihat kebutuhan organisasi" },
    ],
    timeline: {
      tanggalMulai: null,
      steps: [
        { id: "T1", tahap: "Roadshow", kegiatan: "Pengenalan organisasi dan posisi yang dibuka kepada calon pengurus", hariMulai: 1, durasi: 1 },
        { id: "T2", tahap: "Pembukaan pendaftaran", kegiatan: "Pengumuman dan penyebaran informasi open recruitment", hariMulai: 2, durasi: 1 },
        { id: "T3", tahap: "Penerimaan berkas", kegiatan: "Pengumpulan seluruh persyaratan pendaftaran", hariMulai: 3, durasi: 3 },
        { id: "T4", tahap: "Screening berkas", kegiatan: "Verifikasi administrasi, CV, studi kasus, dan portofolio", hariMulai: 6, durasi: 1 },
        { id: "T5", tahap: "Screening & wawancara", kegiatan: "Pendalaman motivasi, kompetensi, dan komitmen calon", hariMulai: 7, durasi: 2 },
        { id: "T6", tahap: "Pengumuman", kegiatan: "Pengumuman hasil seleksi dan penetapan pengurus", hariMulai: 9, durasi: 1 },
      ],
    },
  };
}

// ---------- Butir, sheet, blok ----------

function items(out: unknown) {
  const o = out as RecruitmentComputed;
  const jadwal = new Map((o.jadwal ?? []).map((j) => [j.id, j.label]));
  return [
    ...(o.kriteriaUmum ?? []).map((k) => ({ id: k.id, text: k.text, detail: "Kriteria umum" })),
    ...(o.positions ?? []).map((p) => ({ id: p.id, text: p.name, detail: `Tugas: ${p.tugas} | Kriteria: ${p.kriteria.join("; ")}` })),
    ...(o.pemberkasan ?? []).map((b) => ({ id: b.id, text: b.what, detail: `Pemberkasan — ${b.reason}` })),
    ...(o.screening ?? []).map((w) => ({ id: w.id, text: w.question, detail: `Screening — ${w.reason}` })),
    ...(o.timeline?.steps ?? []).map((s) => ({ id: s.id, text: s.tahap, detail: `${jadwal.get(s.id) ?? `hari ke-${s.hariMulai}`}: ${s.kegiatan}` })),
  ];
}

const ORANGE = "E69138";
const PEACH = "F6B26B";
const LIGHT = "FCE5CD";

function sheet(out: RecruitmentComputed): Grid {
  const g = new GridBuilder("recruitment", "MSDMRECRUITMENT", "Recruitment — kriteria, tugas, proses seleksi, dan timeline");
  const P = out.positions ?? [];
  const steps = out.timeline?.steps ?? [];
  g.set(0, 0, "Recruitment — kriteria, tugas, proses seleksi, dan timeline", { style: "title", cs: Math.max(6, 5 + P.length) });

  // Kriteria umum (kiri) dan kriteria khusus per posisi (kanan), berdampingan seperti di Excel.
  g.set(2, 0, "KRITERIA UMUM CALON PENGURUS", { style: "header", fill: ORANGE, cs: 3 });
  g.row(3, 0, ["No.", "Kriteria", "Alasan"], { style: "subheader", fill: PEACH });
  out.kriteriaUmum.forEach((k, i) => {
    g.set(4 + i, 0, i + 1, { style: "int", fill: PEACH, center: true });
    g.set(4 + i, 1, k.text, { style: "text", src: "ai", note: noteOf(undefined, [], k.refs), edit: { path: ["kriteriaUmum", i, "text"], type: "text" } });
    g.set(4 + i, 2, k.reason, { style: "muted", src: "ai", edit: { path: ["kriteriaUmum", i, "reason"], type: "text" } });
  });
  g.set(2, 4, "KRITERIA KHUSUS CALON PENGURUS", { style: "header", fill: ORANGE, cs: 1 + Math.max(1, P.length) });
  g.set(3, 4, "No.", { style: "subheader", fill: PEACH });
  P.forEach((p, j) => g.set(3, 5 + j, p.name, { style: "subheader", fill: LIGHT, src: "ai", edit: { path: ["positions", j, "name"], type: "text" } }));
  const maxK = Math.max(0, ...P.map((p) => p.kriteria.length));
  for (let i = 0; i < maxK; i++) {
    g.set(4 + i, 4, i + 1, { style: "int", fill: PEACH, center: true });
    P.forEach((p, j) => {
      if (i < p.kriteria.length) g.set(4 + i, 5 + j, p.kriteria[i], { style: "text", src: "ai", edit: { path: ["positions", j, "kriteria", i], type: "text" } });
      else g.set(4 + i, 5 + j, "—", { style: "muted", center: true });
    });
  }
  let r = 4 + Math.max(out.kriteriaUmum.length, maxK) + 1;

  // Tugas calon pengurus
  g.set(r, 0, "TUGAS CALON PENGURUS", { style: "header", fill: ORANGE, cs: 4 });
  r++;
  g.row(r, 0, ["Jabatan", "Tugas", "Melapor ke", "Bukti"], { style: "subheader", fill: PEACH });
  r++;
  const nameOf = new Map(P.map((p) => [p.id, p.name]));
  P.forEach((p, j) => {
    g.set(r, 0, p.name, { style: "label", fill: PEACH });
    g.set(r, 1, p.tugas, { style: "text", src: "ai", refs: evidenceRefs(p.evidence), note: noteOf(undefined, p.evidence), edit: { path: ["positions", j, "tugas"], type: "text" } });
    g.set(r, 2, p.atasan ? (nameOf.get(p.atasan) ?? `${p.atasan} (tidak ada)`) : "— (pucuk struktur)", {
      style: "text",
      src: "ai",
      edit: { path: ["positions", j, "atasan"], type: "select", allowEmpty: true, options: P.filter((q) => q.id !== p.id).map((q) => ({ label: q.name, value: q.id })) },
    });
    g.set(r, 3, p.evidence.map((e) => `[${e.chunkId}] ${e.quote}`).join("\n") || "–", { style: "muted", refs: evidenceRefs(p.evidence) });
    r++;
  });
  r++;

  // Proses seleksi
  g.set(r, 0, "PROSES SELEKSI", { style: "header", fill: ORANGE, cs: 5 });
  r++;
  g.set(r, 0, "No", { style: "subheader", fill: PEACH, rs: 2 });
  g.set(r, 1, "Pemberkasan", { style: "subheader", fill: LIGHT, cs: 2, center: true });
  g.set(r, 3, "Screening", { style: "subheader", fill: LIGHT, cs: 2, center: true });
  r++;
  g.row(r, 1, ["What to do", "Reasons", "Questions", "Reasons"], { style: "subheader", fill: LIGHT });
  r++;
  const nSel = Math.max(out.pemberkasan.length, out.screening.length);
  for (let i = 0; i < nSel; i++) {
    g.set(r + i, 0, i + 1, { style: "int", fill: PEACH, center: true });
    const b = out.pemberkasan[i];
    const w = out.screening[i];
    if (b) {
      g.set(r + i, 1, b.what, { style: "text", src: "ai", edit: { path: ["pemberkasan", i, "what"], type: "text" } });
      g.set(r + i, 2, b.reason, { style: "text", src: "ai", edit: { path: ["pemberkasan", i, "reason"], type: "text" } });
    } else g.row(r + i, 1, ["—", "—"], { style: "muted", center: true });
    if (w) {
      g.set(r + i, 3, w.question, { style: "text", src: "ai", edit: { path: ["screening", i, "question"], type: "text" } });
      g.set(r + i, 4, w.reason, { style: "text", src: "ai", edit: { path: ["screening", i, "reason"], type: "text" } });
    } else g.row(r + i, 3, ["—", "—"], { style: "muted", center: true });
  }
  r += nSel + 1;

  // Timeline proses seleksi: tanggal = tanggal mulai + hari ke- − 1.
  g.set(r, 0, "TIMELINE PROSES SELEKSI", { style: "header", fill: ORANGE, cs: 1 + Math.max(1, steps.length) });
  r++;
  const start = parseIsoDate(out.timeline?.tanggalMulai);
  g.set(r, 0, "Tanggal mulai (hari ke-1)", { style: "label" });
  g.set(r, 1, start === null ? null : excelSerial(start), {
    src: "ai",
    fmt: "d mmm yyyy",
    display: start === null ? "(belum ditentukan)" : fmtDate(start),
    note: "Ubah tanggal ini (format TTTT-BB-HH, mis. 2026-02-14) untuk menggeser seluruh jadwal. Kosongkan bila belum ditentukan.",
    edit: { path: ["timeline", "tanggalMulai"], type: "text", allowEmpty: true },
    cs: 2,
  });
  const S = addr(r, 1, true);
  r++;
  const rT = r;
  const rH = r + 1;
  const rD = r + 2;
  const rM = r + 3;
  const rS = r + 4;
  const rK = r + 5;
  g.set(rT, 0, "Tahap", { style: "subheader", fill: PEACH });
  g.set(rH, 0, "Hari ke-", { style: "label" });
  g.set(rD, 0, "Lama (hari)", { style: "label" });
  g.set(rM, 0, "Mulai", { style: "label", fill: PEACH });
  g.set(rS, 0, "Selesai", { style: "label", fill: PEACH });
  g.set(rK, 0, "Kegiatan", { style: "label" });
  steps.forEach((s, j) => {
    const c = 1 + j;
    const jd = out.jadwal?.[j];
    g.set(rT, c, s.tahap, { style: "subheader", fill: LIGHT, src: "ai", edit: { path: ["timeline", "steps", j, "tahap"], type: "text" } });
    g.set(rH, c, s.hariMulai, { style: "int", src: "ai", center: true, edit: { path: ["timeline", "steps", j, "hariMulai"], type: "number", min: 1, max: 180, step: 1 } });
    g.set(rD, c, s.durasi, { style: "int", src: "ai", center: true, edit: { path: ["timeline", "steps", j, "durasi"], type: "number", min: 1, max: 60, step: 1 } });
    const a = start === null ? null : start + (s.hariMulai - 1) * DAY;
    const b = a === null ? null : a + (s.durasi - 1) * DAY;
    g.set(rM, c, a === null ? null : excelSerial(a), {
      src: "hitung",
      fmt: "d mmm yyyy",
      display: a === null ? "–" : fmtDate(a),
      f: `IF(${S}="","",${S}+${addr(rH, c)}-1)`,
      explain:
        a === null
          ? `Mulai = tanggal mulai + hari ke- − 1; tanggal mulai belum diisi sehingga tanggal belum bisa dihitung (tahap ini hari ke-${s.hariMulai}).`
          : `Mulai = tanggal mulai + hari ke- − 1 = ${fmtDate(start!)} + ${s.hariMulai} − 1 hari = ${fmtDate(a)}`,
    });
    g.set(rS, c, b === null ? null : excelSerial(b), {
      src: "hitung",
      fmt: "d mmm yyyy",
      display: b === null ? "–" : fmtDate(b),
      f: `IF(${S}="","",${addr(rM, c)}+${addr(rD, c)}-1)`,
      explain:
        b === null
          ? `Selesai = mulai + lama − 1 (hari ke-${jd?.hariSelesai ?? s.hariMulai + s.durasi - 1}); menunggu tanggal mulai.`
          : `Selesai = mulai + lama − 1 = ${fmtDate(a!)} + ${s.durasi} − 1 hari = ${fmtDate(b)}`,
    });
    g.set(rK, c, s.kegiatan, { style: "text", src: "ai", edit: { path: ["timeline", "steps", j, "kegiatan"], type: "text" } });
  });
  return g.build({
    cols: [24, 42, 34, 34, 30, ...P.map(() => 30)],
    notes: [
      "Kriteria umum berlaku untuk semua calon; kriteria khusus dibaca per kolom posisi.",
      "Proses seleksi: kolom Pemberkasan berisi berkas yang diminta beserta alasannya, kolom Screening berisi pertanyaan wawancara beserta tujuannya.",
      "Tanggal timeline dihitung dari tanggal mulai + hari ke-: ubah tanggal mulai untuk menggeser semua tahap, atau ubah hari ke-/lama per tahap.",
    ],
  });
}

function blocks(out: RecruitmentComputed): Block[] {
  return [
    { type: "h2", text: "Recruitment" },
    { type: "p", text: `Kriteria umum calon pengurus:\n${numbered(out.kriteriaUmum.map((k) => k.text))}` },
    { type: "table", head: ["Posisi", "Tugas", "Kriteria khusus"], rows: out.positions.map((p) => [p.name, p.tugas, numbered(p.kriteria)]), widths: [20, 38, 42] },
    {
      type: "table",
      head: ["No", "Pemberkasan", "Alasan", "Pertanyaan screening", "Alasan"],
      rows: Array.from({ length: Math.max(out.pemberkasan.length, out.screening.length) }, (_, i) => [
        String(i + 1),
        out.pemberkasan[i]?.what ?? "—",
        out.pemberkasan[i]?.reason ?? "—",
        out.screening[i]?.question ?? "—",
        out.screening[i]?.reason ?? "—",
      ]),
      widths: [6, 22, 25, 22, 25],
    },
    { type: "table", head: ["Tahap", "Waktu", "Kegiatan"], rows: out.timeline.steps.map((s, i) => [s.tahap, out.jadwal?.[i]?.label ?? `Hari ke-${s.hariMulai}`, s.kegiatan]), widths: [24, 24, 52] },
  ];
}

const FORMULAS: FormulaDoc[] = [
  { name: "Tanggal mulai tahap", rumus: "Mulai = tanggal mulai proses + hari ke- − 1", arti: "Hari pertama tiap tahap seleksi, dihitung dari tanggal hari ke-1.", excel: '=IF($B$x="","",$B$x+Bhari-1)' },
  { name: "Tanggal selesai tahap", rumus: "Selesai = mulai + lama (hari) − 1", arti: "Hari terakhir tahap seleksi.", excel: '=IF($B$x="","",Bmulai+Blama-1)' },
];

export const msdmRecruitment: NodeDef<RecruitmentOutput> = {
  key: "msdm_recruitment",
  label: "MSDM – Recruitment",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMRECRUITMENT",
  deps: [],
  kind: "llm",
  description:
    "Kriteria umum dan khusus calon pengurus per posisi, tugas tiap posisi, proses seleksi (pemberkasan & pertanyaan screening beserta alasannya), dan timeline seleksi yang tanggalnya dihitung otomatis.",
  computedBy: "LLM + kode (tanggal timeline)",
  schema: RecruitmentOutput,
  checks: [
    { name: "section_complete", kind: "code", description: "Bagian rekrutmen belum lengkap: kriteria umum 3–8, 2–10 posisi (tugas + 3–8 kriteria khusus), pemberkasan 3–10, screening 4–12, timeline 4–10 tahap, ID unik" },
    { name: "atasan_exists", kind: "code", description: "Atasan posisi merujuk posisi yang tidak ada, dirinya sendiri, atau tidak ada posisi pucuk" },
    { name: "timeline_order", kind: "code", description: "Timeline seleksi tidak berurutan (hari ke- mundur) atau tanggal mulai bukan tanggal yang sah" },
    QUOTE_CHECK,
    REF_CHECK,
    { name: "kriteria_relevan", kind: "llm", description: "Kriteria khusus tidak sesuai dengan tugas posisinya atau kebutuhan organisasi" },
  ],
  queries: () => [
    { focus: "struktur & jabatan", text: "struktur organisasi jabatan posisi divisi biro departemen tugas tanggung jawab pengurus", k: 6 },
    { focus: "rekrutmen", text: "rekrutmen open recruitment seleksi wawancara pendaftaran calon pengurus syarat kriteria", k: 5 },
    { focus: "kompetensi", text: "kompetensi keterampilan pengalaman yang dibutuhkan pengurus staf", k: 4 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun rancangan RECRUITMENT calon pengurus yang selaras dengan hasil attraction dan arah strategi.
Bagian yang wajib diisi:
1. kriteriaUmum (KU1, KU2, …; 3–6 butir): syarat yang berlaku untuk semua calon (status, komitmen, batas organisasi lain, dsb.). "refs" boleh berisi ID attraction (ON…, SN…, MD…) atau strategi yang mendasarinya.
2. positions (P1, P2, …; 2–8 posisi sesuai struktur di dokumen; bila tidak ada, posisi umum organisasi kemahasiswaan): name, tugas (1–2 kalimat), atasan (ID posisi atasan langsung; null untuk pucuk struktur), kriteria (3–7 kriteria khusus posisi itu, spesifik terhadap tugasnya). Tugas yang diambil dari dokumen diberi bukti. ${EVIDENCE_RULES}
3. pemberkasan (B1, …; 3–8 butir): what = berkas/isian yang diminta, reason = untuk apa berkas itu.
4. screening (W1, …; 4–10 butir): question = pertanyaan wawancara, reason = apa yang ingin diketahui.
5. timeline: steps (T1, …; 4–8 tahap berurutan, mis. roadshow → pembukaan → penerimaan berkas → screening berkas → wawancara → pengumuman) dengan hariMulai (hari ke-, 1 = hari pertama) dan durasi (hari). tanggalMulai (YYYY-MM-DD) HANYA diisi bila tanggal rekrutmen tertulis di dokumen; bila tidak, null.
Aturan: jangan menyebut nama orang; tulis singkat dan konkret. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(RecruitmentOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const P = out.positions;
    const sec: Failure[] = [
      ...countProblem(out.kriteriaUmum.length, 3, 8, "Kriteria umum", "section_complete"),
      ...countProblem(P.length, 2, 10, "Posisi", "section_complete"),
      ...P.flatMap((p) => [
        ...countProblem(p.kriteria.length, 3, 8, `Kriteria khusus ${p.name}`, "section_complete", p.id),
        ...(blank(p.tugas) ? [{ check: "section_complete", itemId: p.id, message: `${p.id} (${p.name}): tugas belum diisi.` }] : []),
      ]),
      ...countProblem(out.pemberkasan.length, 3, 10, "Pemberkasan", "section_complete"),
      ...countProblem(out.screening.length, 4, 12, "Pertanyaan screening", "section_complete"),
      ...countProblem(out.timeline.steps.length, 4, 10, "Tahap timeline", "section_complete"),
      ...idProblems([...out.kriteriaUmum, ...P, ...out.pemberkasan, ...out.screening, ...out.timeline.steps], "Recruitment", "section_complete"),
      ...[...out.pemberkasan, ...out.screening]
        .filter((x) => blank(x.reason))
        .map((x) => ({ check: "section_complete", itemId: x.id, message: `${x.id}: alasan (reasons) belum diisi.` })),
    ];
    const ids = new Set(P.map((p) => p.id));
    const atasan: Failure[] = [
      ...P.filter((p) => p.atasan !== null && (!ids.has(p.atasan) || p.atasan === p.id)).map((p) => ({
        check: "atasan_exists",
        itemId: p.id,
        message: p.atasan === p.id ? `${p.id} (${p.name}) tidak boleh menjadi atasan dirinya sendiri.` : `${p.id} (${p.name}) melapor ke ${p.atasan} yang tidak ada di daftar posisi.`,
      })),
      ...(P.length && !P.some((p) => p.atasan === null) ? [{ check: "atasan_exists", message: "Tidak ada posisi pucuk (atasan = null) — struktur melingkar." }] : []),
    ];
    const order: Failure[] = [];
    out.timeline.steps.forEach((s, i) => {
      const prev = out.timeline.steps[i - 1];
      if (prev && s.hariMulai < prev.hariMulai)
        order.push({ check: "timeline_order", itemId: s.id, message: `${s.id} (${s.tahap}) dimulai hari ke-${s.hariMulai}, lebih awal dari tahap sebelumnya (${prev.tahap}, hari ke-${prev.hariMulai}).` });
    });
    if (out.timeline.tanggalMulai && parseIsoDate(out.timeline.tanggalMulai) === null)
      order.push({ check: "timeline_order", message: `Tanggal mulai "${out.timeline.tanggalMulai}" bukan tanggal yang sah.` });
    const valid = validRefIds(ctx, UPSTREAM);
    return [
      result("section_complete", "code", sec),
      result("atasan_exists", "code", atasan),
      result("timeline_order", "code", order),
      quoteCheck(P, ctx.evidence),
      refCheck(out.kriteriaUmum, valid),
      await strategyJudge(
        llm,
        ctx,
        "kriteria_relevan",
        "Periksa apakah kriteria khusus setiap posisi sesuai dengan tugas posisi itu dan kebutuhan organisasi (bukan kriteria generik yang tertukar antarposisi).",
        P.map((p) => ({ id: p.id, text: `${p.name} — tugas: ${p.tugas} — kriteria: ${p.kriteria.join("; ")}` })),
      ),
    ];
  },
  compute: (out) => computeRecruitment(out),
  repairHint: "Perbaiki hanya bagian yang ditolak; bagian lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as RecruitmentComputed)],
  blocks: (out) => blocks(out as RecruitmentComputed),
  formulas: FORMULAS,
  summary: (out) => {
    const o = out as RecruitmentComputed;
    return `Recruitment: ${o.positions?.length ?? 0} posisi, ${o.kriteriaUmum?.length ?? 0} kriteria umum, ${o.screening?.length ?? 0} pertanyaan screening, timeline ${o.timeline?.steps?.length ?? 0} tahap (${o.totalHari ?? 0} hari).`;
  },
};
