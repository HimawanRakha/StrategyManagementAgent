// MSDM – Development (tab MSDMDEVELOPMENT): rencana pengembangan staf satu periode.
// Bagian atas = TIME LINE (Bulan 1–3 | 4–6 | 7–9 | 10–12) dengan baris MAINTENANCE (penanggung jawab per rentang bulan) dan
// dua jalur kegiatan (Pengembangan Wawasan; Pengembangan Sikap dan Keterampilan). Bagian bawah = alur
// INPUT → TAHAP 1 → TAHAP 2 → TAHAP 3 → OUTPUT (di Excel: Pengenalan, Akselerasi, Aktualisasi pada gambar alur).
import { z } from "zod";
import type { Failure, NodeContext, NodeDef } from "../types";
import { JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { GridBuilder, type Block, type Grid } from "@/lib/sheets/grid";
import { result } from "@/lib/validators/common";
import { REF_CHECK, blank, contextBlock, countProblem, idProblems, noteOf, refCheck, strategyJudge, type Upstream, validRefIds } from "./common";
import { msdmAttraction } from "./attraction";
import { msdmRecruitment, type RecruitmentOutput } from "./recruitment";
import { msdmOnboarding, type OnboardingOutput } from "./onboarding";

export const JALUR = ["wawasan", "sikap"] as const;
export type Jalur = (typeof JALUR)[number];
export const JALUR_LABEL: Record<Jalur, string> = { wawasan: "Pengembangan Wawasan", sikap: "Pengembangan Sikap dan Keterampilan" };
export const KUARTAL_LABEL = ["BULAN 1–3", "BULAN 4–6", "BULAN 7–9", "BULAN 10–12"];
/** Kolom (0-based) tiap kuartal di Excel: B:D, E:G, H:I, J:K. */
const QSPAN: [number, number][] = [
  [1, 3],
  [4, 6],
  [7, 8],
  [9, 10],
];

const Kuartal = z.number().int().min(1).max(4);

const Kegiatan = z.object({
  id: z.string(), // D1…
  nama: z.string().min(3),
  jalur: z.enum(JALUR),
  /** Nomor tahap (1 = tahap pertama). */
  tahap: z.number().int().min(1).max(4),
  /** Kuartal pelaksanaan: 1 = bulan 1–3, 2 = bulan 4–6, 3 = bulan 7–9, 4 = bulan 10–12. */
  kuartal: Kuartal,
  deskripsi: z.string().default(""),
  /** Indikator keberhasilan kegiatan. */
  indikator: z.string().default(""),
  /** ID butir onboarding/attraction/strategi yang didukung. */
  refs: z.array(z.string()).default([]),
});

const Maintenance = z.object({
  id: z.string(), // M1…
  /** Penanggung jawab pemeliharaan staf (jabatan, bukan nama orang). */
  pj: z.string().min(2),
  dari: Kuartal,
  sampai: Kuartal,
  tugas: z.string().default(""),
});

const Tahap = z.object({ nama: z.string().min(2), capaian: z.string().min(5) });

export const DevelopmentOutput = z.object({
  /** Kondisi staf saat masuk (INPUT). */
  input: z.string().min(5),
  tahap: z.array(Tahap).min(2).max(4),
  /** Profil staf di akhir periode (OUTPUT). */
  output: z.string().min(5),
  maintenance: z.array(Maintenance),
  kegiatan: z.array(Kegiatan),
});
export type DevelopmentOutput = z.infer<typeof DevelopmentOutput>;

const UPSTREAM: Upstream[] = [msdmAttraction, msdmRecruitment, msdmOnboarding];

// ---------- Mock ----------

function mock(ctx: NodeContext): DevelopmentOutput {
  const rec = ctx.inputs.msdm_recruitment as RecruitmentOutput | undefined;
  const onb = ctx.inputs.msdm_onboarding as OnboardingOutput | undefined;
  const ob = (re: RegExp) => (onb?.kegiatan ?? []).filter((k) => re.test(k.nama.toLowerCase())).map((k) => k.id).slice(0, 1);
  const pj1 = rec?.positions?.[0]?.name ?? "Ketua";
  const pj2 = rec?.positions?.find((p) => /wakil/i.test(p.name))?.name ?? `Wakil ${pj1}`;
  const K = (id: number, nama: string, jalur: Jalur, tahap: number, kuartal: number, deskripsi: string, indikator: string, refs: string[] = []) => ({
    id: `D${id}`,
    nama,
    jalur,
    tahap,
    kuartal,
    deskripsi,
    indikator,
    refs,
  });
  return {
    input: "Staf yang telah memenuhi persyaratan dan lolos seleksi rekrutmen",
    tahap: [
      { nama: "Pengenalan", capaian: "Staf memiliki pemahaman yang sama tentang visi, SOP umum kesekretariatan dan keuangan, serta sistem kerja organisasi" },
      { nama: "Akselerasi", capaian: "Staf telah berproses meningkatkan kompetensi diri sesuai kebutuhan fungsional bidangnya" },
      { nama: "Aktualisasi", capaian: "Staf mampu mengintegrasikan kompetensinya, memahami peran bidang, dan berkolaborasi menjalankan program kerja" },
    ],
    output: `Staf ${ctx.projectName} yang kompeten, adaptif, kolaboratif, dan bertanggung jawab serta siap meneruskan estafet kepengurusan`,
    maintenance: [
      { id: "M1", pj: pj1, dari: 1, sampai: 2, tugas: "Memantau keaktifan, beban kerja, dan kebutuhan staf pada paruh pertama periode" },
      { id: "M2", pj: pj2, dari: 3, sampai: 4, tugas: "Memantau keaktifan, beban kerja, dan kebutuhan staf pada paruh kedua periode" },
    ],
    kegiatan: [
      K(1, "Welcome Party", "wawasan", 1, 1, "Penyambutan dan pengenalan arah organisasi", "Seluruh staf baru hadir", ob(/welcome|penyambutan/)),
      K(2, "Rapat Kerja", "wawasan", 1, 1, "Penetapan program kerja dan target bidang", "Program kerja dan target tiap bidang disepakati", ob(/rapat kerja/)),
      K(3, "Upgrading Staf 1", "sikap", 1, 1, "Pelatihan SOP administrasi, keuangan, dan alat kerja dasar", "Staf lulus uji pemahaman SOP"),
      K(4, "Pelaksanaan Program Kerja (periode 1)", "sikap", 1, 2, "Staf menjalankan program kerja dengan pendampingan", "Program berjalan sesuai jadwal"),
      K(5, "Raport Staf 1", "sikap", 2, 2, "Penilaian kinerja staf pertama dan umpan balik", "Seluruh staf menerima raport dan umpan balik"),
      K(6, "Upgrading Staf 2", "sikap", 2, 2, "Pelatihan keterampilan fungsional sesuai bidang", "Peningkatan nilai raport pada atribut keterampilan"),
      K(7, "Sharing Session Antarbidang", "wawasan", 2, 3, "Berbagi pengetahuan dan pengalaman antarbidang (transfer knowledge)", "Minimal satu sesi per bulan"),
      K(8, "Evaluasi Kuartal 1", "wawasan", 2, 3, "Evaluasi capaian program dan kinerja bidang", "Rekomendasi perbaikan tiap bidang tersusun"),
      K(9, "Raport Staf 2", "sikap", 3, 3, "Penilaian kinerja staf kedua dan rencana pengembangan lanjutan", "Seluruh staf menerima raport kedua"),
      K(10, "Upgrading Staf 3", "sikap", 3, 4, "Pelatihan kepemimpinan dan persiapan regenerasi", "Staf siap mengambil peran lebih besar"),
      K(11, "Evaluasi Kuartal 2", "wawasan", 3, 4, "Evaluasi akhir periode dan serah terima pengetahuan", "Dokumen serah terima lengkap"),
    ],
  };
}

// ---------- Butir, sheet, blok ----------

function items(out: unknown) {
  const o = out as DevelopmentOutput;
  return [
    ...(o.kegiatan ?? []).map((k) => ({
      id: k.id,
      text: k.nama,
      detail: `${JALUR_LABEL[k.jalur] ?? k.jalur} · Tahap ${k.tahap} (${o.tahap?.[k.tahap - 1]?.nama ?? "?"}) · ${KUARTAL_LABEL[k.kuartal - 1] ?? ""}${k.indikator ? ` · indikator: ${k.indikator}` : ""}`,
    })),
    ...(o.tahap ?? []).map((t, i) => ({ id: `TH${i + 1}`, text: `Tahap ${i + 1} ${t.nama}`, detail: t.capaian })),
    ...(o.output ? [{ id: "OUT", text: o.output, detail: "Output pengembangan staf" }] : []),
  ];
}

const DARK = "A5A5A5";
const MID = "BFBFBF";
const LIGHTG = "F2F2F2";
const STAGE_FILL = ["DDEBF7", "E2EFDA", "FFF2CC", "FCE4D6"];

/** Bagi segmen [dari, sampai] ke baris-baris tanpa tumpang tindih. */
function allocate<T>(xs: T[], span: (x: T) => [number, number]): T[][] {
  const rows: { used: boolean[]; xs: T[] }[] = [];
  for (const x of xs) {
    const [a, b] = span(x);
    let row = rows.find((r) => r.used.slice(a, b + 1).every((u) => !u));
    if (!row) {
      row = { used: [false, false, false, false], xs: [] };
      rows.push(row);
    }
    for (let q = a; q <= b; q++) row.used[q] = true;
    row.xs.push(x);
  }
  return rows.map((r) => r.xs);
}

function sheet(out: DevelopmentOutput): Grid {
  const g = new GridBuilder("development", "MSDMDEVELOPMENT", "Development — rencana pengembangan staf satu periode");
  const nT = out.tahap.length;
  const width = Math.max(11, 1 + 2 * (nT + 2));
  g.set(0, 0, "Development — rencana pengembangan staf satu periode", { style: "title", cs: width });
  let r = 2;
  g.set(r, 0, "TIME LINE", { style: "header", fill: DARK });
  QSPAN.forEach(([a, b], q) => g.set(r, a, KUARTAL_LABEL[q], { style: "header", fill: MID, cs: b - a + 1, center: true }));
  r++;
  // Maintenance
  const mIdx = out.maintenance.map((m, i) => ({ m, i }));
  const mRows = allocate(mIdx, ({ m }) => [Math.min(m.dari, m.sampai) - 1, Math.max(m.dari, m.sampai) - 1]);
  const nM = Math.max(1, mRows.length);
  g.set(r, 0, "MAINTENANCE", { style: "header", fill: DARK, rs: nM });
  mRows.forEach((row, k) =>
    row.forEach(({ m, i }) => {
      const a = QSPAN[Math.min(m.dari, m.sampai) - 1][0];
      const b = QSPAN[Math.max(m.dari, m.sampai) - 1][1];
      g.set(r + k, a, m.pj.toUpperCase(), {
        style: "label",
        fill: MID,
        cs: b - a + 1,
        center: true,
        src: "ai",
        note: m.tugas || undefined,
        edit: { path: ["maintenance", i, "pj"], type: "text" },
      });
    }),
  );
  r += nM;
  // Jalur kegiatan
  for (const j of JALUR) {
    const ks = out.kegiatan.map((k, i) => ({ k, i })).filter(({ k }) => k.jalur === j).sort((x, y) => x.k.kuartal - y.k.kuartal || x.k.tahap - y.k.tahap);
    const rows = allocate(ks, ({ k }) => [k.kuartal - 1, k.kuartal - 1]);
    const n = Math.max(1, rows.length);
    g.set(r, 0, JALUR_LABEL[j], { style: "label", fill: LIGHTG, rs: n });
    rows.forEach((row, k) =>
      row.forEach(({ k: x, i }) => {
        const [a, b] = QSPAN[x.kuartal - 1];
        g.set(r + k, a, x.nama, {
          style: "text",
          center: true,
          cs: b - a + 1,
          fill: STAGE_FILL[(x.tahap - 1) % STAGE_FILL.length],
          src: "ai",
          note: noteOf([`${x.id} · Tahap ${x.tahap} ${out.tahap[x.tahap - 1]?.nama ?? ""}`, x.deskripsi, x.indikator ? `Indikator: ${x.indikator}` : ""].filter(Boolean).join("\n"), [], x.refs),
          edit: { path: ["kegiatan", i, "nama"], type: "text" },
        });
      }),
    );
    r += n;
  }
  r++;
  // Alur INPUT → TAHAP → OUTPUT
  const flowCol = (k: number) => 1 + 2 * k;
  g.set(r, 0, "ALUR", { style: "header", fill: DARK, rs: 4 });
  g.set(r, flowCol(0), "INPUT", { style: "header", fill: MID, cs: 2, center: true });
  out.tahap.forEach((_, k) => g.set(r, flowCol(k + 1), `TAHAP ${k + 1}`, { style: "header", fill: MID, cs: 2, center: true }));
  g.set(r, flowCol(nT + 1), "OUTPUT", { style: "header", fill: MID, cs: 2, center: true });
  r++;
  out.tahap.forEach((t, k) =>
    g.set(r, flowCol(k + 1), t.nama, { style: "label", cs: 2, center: true, fill: STAGE_FILL[k % STAGE_FILL.length], src: "ai", edit: { path: ["tahap", k, "nama"], type: "text" } }),
  );
  r++;
  g.set(r, flowCol(0), out.input, { style: "text", cs: 2, src: "ai", edit: { path: ["input"], type: "text" } });
  out.tahap.forEach((t, k) => g.set(r, flowCol(k + 1), t.capaian, { style: "text", cs: 2, src: "ai", edit: { path: ["tahap", k, "capaian"], type: "text" } }));
  g.set(r, flowCol(nT + 1), out.output, { style: "text", cs: 2, src: "ai", edit: { path: ["output"], type: "text" } });
  r++;
  g.set(r, flowCol(0), "Kegiatan:", { style: "muted", cs: 2 });
  out.tahap.forEach((_, k) => {
    const names = out.kegiatan.filter((x) => x.tahap === k + 1).map((x) => x.nama);
    g.set(r, flowCol(k + 1), names.join("\n") || "(belum ada kegiatan)", { style: "muted", cs: 2, src: "hitung", note: "Daftar kegiatan yang tahapnya sama (diambil dari tabel rincian)." });
  });
  r += 2;
  // Rincian kegiatan (sel yang bisa diubah: jalur, tahap, kuartal, deskripsi, indikator)
  g.set(r, 0, "RINCIAN KEGIATAN", { style: "header", fill: DARK, cs: 8 });
  r++;
  g.row(r, 0, ["ID", "Kegiatan", "Jalur", "Tahap", "Kuartal", "Deskripsi", "Indikator keberhasilan", "Dasar"], { style: "subheader", fill: MID });
  r++;
  const tahapOpts = out.tahap.map((t, k) => ({ label: `${k + 1} — ${t.nama}`, value: k + 1 }));
  const qOpts = KUARTAL_LABEL.map((l, q) => ({ label: `${q + 1} (${l.toLowerCase()})`, value: q + 1 }));
  out.kegiatan.forEach((k, i) => {
    g.set(r, 0, k.id, { style: "label" });
    g.set(r, 1, k.nama, { style: "text", src: "ai", edit: { path: ["kegiatan", i, "nama"], type: "text" } });
    g.set(r, 2, JALUR_LABEL[k.jalur], { style: "text", src: "ai", edit: { path: ["kegiatan", i, "jalur"], type: "select", options: JALUR.map((j) => ({ label: JALUR_LABEL[j], value: j })) } });
    g.set(r, 3, k.tahap, { style: "int", center: true, src: "ai", display: `${k.tahap} — ${out.tahap[k.tahap - 1]?.nama ?? "?"}`, edit: { path: ["kegiatan", i, "tahap"], type: "select", options: tahapOpts } });
    g.set(r, 4, k.kuartal, { style: "int", center: true, src: "ai", display: KUARTAL_LABEL[k.kuartal - 1]?.toLowerCase(), edit: { path: ["kegiatan", i, "kuartal"], type: "select", options: qOpts } });
    g.set(r, 5, k.deskripsi, { style: "text", src: "ai", edit: { path: ["kegiatan", i, "deskripsi"], type: "text" } });
    g.set(r, 6, k.indikator, { style: "text", src: "ai", edit: { path: ["kegiatan", i, "indikator"], type: "text" } });
    g.set(r, 7, k.refs.join(", ") || "–", { style: "muted" });
    r++;
  });
  r++;
  g.set(r, 0, "MAINTENANCE (rincian)", { style: "header", fill: DARK, cs: 5 });
  r++;
  g.row(r, 0, ["ID", "Penanggung jawab", "Dari kuartal", "Sampai kuartal", "Tugas"], { style: "subheader", fill: MID });
  r++;
  out.maintenance.forEach((m, i) => {
    g.set(r, 0, m.id, { style: "label" });
    g.set(r, 1, m.pj, { style: "text", src: "ai", edit: { path: ["maintenance", i, "pj"], type: "text" } });
    g.set(r, 2, m.dari, { style: "int", center: true, src: "ai", display: KUARTAL_LABEL[m.dari - 1]?.toLowerCase(), edit: { path: ["maintenance", i, "dari"], type: "select", options: qOpts } });
    g.set(r, 3, m.sampai, { style: "int", center: true, src: "ai", display: KUARTAL_LABEL[m.sampai - 1]?.toLowerCase(), edit: { path: ["maintenance", i, "sampai"], type: "select", options: qOpts } });
    g.set(r, 4, m.tugas, { style: "text", src: "ai", edit: { path: ["maintenance", i, "tugas"], type: "text" } });
    r++;
  });
  return g.build({
    cols: [26, 14, 14, 14, 14, 30, 30, 14, 14, 14, 14],
    notes: [
      "Bagian atas adalah linimasa satu periode (per tiga bulan): siapa penanggung jawab pemeliharaan staf, dan kegiatan pengembangan wawasan serta sikap & keterampilan.",
      "Warna kegiatan menunjukkan tahapnya; bagian ALUR membaca dari INPUT (staf baru) melalui tiap tahap sampai OUTPUT (profil staf di akhir periode).",
      "Ubah jalur, tahap, atau kuartal kegiatan di tabel RINCIAN KEGIATAN — linimasa di atas tersusun ulang otomatis.",
    ],
  });
}

function blocks(out: DevelopmentOutput): Block[] {
  return [
    { type: "h2", text: "Development — pengembangan staf" },
    {
      type: "table",
      head: ["Jalur", ...KUARTAL_LABEL.map((l) => l.toLowerCase())],
      rows: [
        ["Maintenance", ...[1, 2, 3, 4].map((q) => out.maintenance.filter((m) => Math.min(m.dari, m.sampai) <= q && q <= Math.max(m.dari, m.sampai)).map((m) => m.pj).join(", ") || "–")],
        ...JALUR.map((j) => [JALUR_LABEL[j], ...[1, 2, 3, 4].map((q) => out.kegiatan.filter((k) => k.jalur === j && k.kuartal === q).map((k) => k.nama).join("; ") || "–")]),
      ],
      widths: [24, 19, 19, 19, 19],
    },
    {
      type: "table",
      head: ["Input", ...out.tahap.map((t, k) => `Tahap ${k + 1}: ${t.nama}`), "Output"],
      rows: [[out.input, ...out.tahap.map((t) => t.capaian), out.output]],
    },
  ];
}

export const msdmDevelopment: NodeDef<DevelopmentOutput> = {
  key: "msdm_development",
  label: "MSDM – Development",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMDEVELOPMENT",
  deps: [],
  kind: "llm",
  description:
    "Rencana pengembangan staf satu periode: linimasa per tiga bulan (penanggung jawab maintenance, kegiatan pengembangan wawasan serta sikap & keterampilan) dan alur INPUT → tahap 1–3 → OUTPUT.",
  computedBy: "LLM",
  schema: DevelopmentOutput,
  checks: [
    { name: "structure_complete", kind: "code", description: "Alur belum lengkap: input/output, nama & capaian tiap tahap, 6–20 kegiatan ber-ID unik, minimal 2 kegiatan per tahap dan per jalur" },
    { name: "maintenance_coverage", kind: "code", description: "Penanggung jawab maintenance tidak menutup keempat kuartal tepat satu kali (ada celah atau tumpang tindih)" },
    { name: "stage_window", kind: "code", description: "Urutan waktu tidak masuk akal: kegiatan tahap berikutnya dimulai sebelum tahap sebelumnya, atau tahap sebelumnya berakhir setelah tahap berikutnya" },
    REF_CHECK,
    { name: "development_relevan", kind: "llm", description: "Kegiatan pengembangan tidak membangun kompetensi yang dibutuhkan organisasi atau tidak sesuai jalur/tahapnya" },
  ],
  queries: () => [
    { focus: "pengembangan staf", text: "pelatihan upgrading pengembangan kompetensi staf pengurus kaderisasi sharing knowledge", k: 5 },
    { focus: "evaluasi kinerja", text: "evaluasi kinerja raport monitoring keaktifan pengurus kehadiran beban kerja", k: 4 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun rencana DEVELOPMENT (pengembangan staf) selama satu periode kepengurusan (12 bulan).
Bagian:
1. tahap: tepat 3 tahap berurutan (mis. Pengenalan → Akselerasi → Aktualisasi), tiap tahap punya "nama" dan "capaian" (kondisi staf setelah tahap itu, satu kalimat).
2. input: kondisi staf saat masuk (setelah lolos rekrutmen); output: profil staf di akhir periode.
3. maintenance: penanggung jawab pemeliharaan staf (JABATAN, bukan nama orang) per rentang kuartal; gabungan rentangnya harus menutup kuartal 1–4 tepat satu kali (mis. M1 kuartal 1–2, M2 kuartal 3–4).
4. kegiatan (D1, D2, …; 8–14 kegiatan): nama, jalur ("wawasan" = Pengembangan Wawasan; "sikap" = Pengembangan Sikap dan Keterampilan), tahap (1–3), kuartal (1 = bulan 1–3, 2 = bulan 4–6, 3 = bulan 7–9, 4 = bulan 10–12), deskripsi, indikator keberhasilan (terukur bila mungkin), refs (ID onboarding/attraction/strategi yang didukung; hanya ID di konteks).
   Minimal 2 kegiatan per tahap dan per jalur. Tahap 1 di awal periode, tahap 3 di akhir. Sertakan penilaian berkala (raport staf) dan evaluasi kuartal.
5. Dasarkan pada kebutuhan organisasi (attraction), posisi (recruitment), kegiatan onboarding, dan masalah pengembangan di dokumen.
6. ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(DevelopmentOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const K = out.kegiatan;
    const nT = out.tahap.length;
    const st: Failure[] = [
      ...(blank(out.input) ? [{ check: "structure_complete", itemId: "IN", message: "INPUT belum diisi." }] : []),
      ...(blank(out.output) ? [{ check: "structure_complete", itemId: "OUT", message: "OUTPUT belum diisi." }] : []),
      ...(nT !== 3 ? [{ check: "structure_complete", message: `Excel memakai 3 tahap (Pengenalan, Akselerasi, Aktualisasi); hasil ini punya ${nT} tahap.` }] : []),
      ...out.tahap.flatMap((t, i) => (blank(t.nama) || blank(t.capaian) ? [{ check: "structure_complete", itemId: `TH${i + 1}`, message: `Tahap ${i + 1}: nama dan capaian wajib diisi.` }] : [])),
      ...countProblem(K.length, 6, 20, "Kegiatan pengembangan", "structure_complete"),
      ...idProblems(K, "Development", "structure_complete"),
      ...K.filter((k) => k.tahap > nT).map((k) => ({ check: "structure_complete", itemId: k.id, message: `${k.id} (${k.nama}) memakai tahap ${k.tahap}, padahal hanya ada ${nT} tahap.` })),
      ...out.tahap.flatMap((_, i) => {
        const n = K.filter((k) => k.tahap === i + 1).length;
        return n < 2 ? [{ check: "structure_complete", itemId: `TH${i + 1}`, message: `Tahap ${i + 1} baru punya ${n} kegiatan (minimal 2).` }] : [];
      }),
      ...JALUR.flatMap((j) => {
        const n = K.filter((k) => k.jalur === j).length;
        return n < 2 ? [{ check: "structure_complete", message: `Jalur ${JALUR_LABEL[j]} baru punya ${n} kegiatan (minimal 2).` }] : [];
      }),
    ];
    const cover = [0, 0, 0, 0];
    const mt: Failure[] = [];
    for (const m of out.maintenance) {
      if (m.dari > m.sampai) mt.push({ check: "maintenance_coverage", itemId: m.id, message: `${m.id} (${m.pj}): kuartal awal ${m.dari} setelah kuartal akhir ${m.sampai}.` });
      for (let q = Math.min(m.dari, m.sampai); q <= Math.max(m.dari, m.sampai); q++) cover[q - 1]++;
    }
    cover.forEach((c, q) => {
      if (c === 0) mt.push({ check: "maintenance_coverage", message: `${KUARTAL_LABEL[q]} belum punya penanggung jawab maintenance.` });
      if (c > 1) mt.push({ check: "maintenance_coverage", message: `${KUARTAL_LABEL[q]} punya ${c} penanggung jawab maintenance yang tumpang tindih.` });
    });
    const win: Failure[] = [];
    for (let t = 1; t < nT; t++) {
      const cur = K.filter((k) => k.tahap === t);
      const next = K.filter((k) => k.tahap === t + 1);
      if (!cur.length || !next.length) continue;
      const curMin = Math.min(...cur.map((k) => k.kuartal));
      const nextMax = Math.max(...next.map((k) => k.kuartal));
      for (const k of next)
        if (k.kuartal < curMin) win.push({ check: "stage_window", itemId: k.id, message: `${k.id} (${k.nama}, tahap ${t + 1}) di kuartal ${k.kuartal}, sebelum tahap ${t} dimulai (kuartal ${curMin}).` });
      for (const k of cur)
        if (k.kuartal > nextMax) win.push({ check: "stage_window", itemId: k.id, message: `${k.id} (${k.nama}, tahap ${t}) di kuartal ${k.kuartal}, setelah tahap ${t + 1} berakhir (kuartal ${nextMax}).` });
    }
    return [
      result("structure_complete", "code", st),
      result("maintenance_coverage", "code", mt),
      result("stage_window", "code", win),
      refCheck(K, validRefIds(ctx, UPSTREAM)),
      await strategyJudge(
        llm,
        ctx,
        "development_relevan",
        `Periksa apakah setiap kegiatan pengembangan membangun kompetensi yang dibutuhkan organisasi, sesuai jalurnya (wawasan = pengetahuan/pemahaman; sikap = sikap dan keterampilan), dan cocok dengan tahapnya (${out.tahap.map((t, i) => `tahap ${i + 1} ${t.nama}`).join(", ")}).`,
        K.map((k) => ({ id: k.id, text: `${k.nama} — ${JALUR_LABEL[k.jalur]}, tahap ${k.tahap}, kuartal ${k.kuartal}: ${k.deskripsi}` })),
      ),
    ];
  },
  repairHint: "Perbaiki hanya kegiatan/bagian yang ditolak; bagian lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as DevelopmentOutput)],
  blocks: (out) => blocks(out as DevelopmentOutput),
  formulas: [],
  summary: (out) => {
    const o = out as DevelopmentOutput;
    return `Development: ${o.kegiatan?.length ?? 0} kegiatan dalam ${o.tahap?.length ?? 0} tahap (${(o.tahap ?? []).map((t) => t.nama).join(" → ")}), ${o.maintenance?.length ?? 0} penanggung jawab maintenance.`;
  },
};
