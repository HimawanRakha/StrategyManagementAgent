// MSDM – Penilaian staf (tab MSDMGD-DEVELOPMENT, "Lembar Penilaian Staff").
// Hierarki: Output → Nilai Utama (bobot) → Atribut Nilai (bobot) → Indikator (bobot) dengan deskripsi level 1–3,
// Target (M) dan Realisasi (N). Rumus Excel:
//   Ketercapaian indikator  L = IF(N>M, 1, N/M)
//   Ketercapaian atribut    H = Σ (bobot indikator × L)          (mis. H6 = I6*L6 + I9*L9)
//   Ketercapaian nilai utama E = Σ (bobot atribut × H)            (mis. E15 = H15*F15 + F17*H17)
//   Ketercapaian output     A = Σ (bobot nilai utama × E)        (A4 = C4*E4 + C15*E15 + C20*E20 + C31*E31)
// AI menyusun RUBRIK (nilai utama, atribut, indikator, deskripsi level, target, tools); bobot setiap tingkat = AHP
// (kelompok berisi satu butir → bobot 1). Realisasi per staf tidak diketahui AI → null (diisi pengguna); null = belum dinilai,
// dan ketercapaian di atasnya ikut kosong ("–") sampai semua indikator di bawahnya dinilai.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { AhpSetComputed, AhpSetRaw } from "../contracts";
import type { Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText } from "../prompt";
import { AHP_CHECKS, AHP_RULES, AhpSetSchema, checkAhpComplete, checkAhpConsistency, computeAhpSet, mockAhpSet, pairList } from "../ahp-common";
import { GridBuilder, addr, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { ahpGrid, type AhpSheetSet } from "@/lib/sheets/ahp-sheet";
import { result } from "@/lib/validators/common";
import { QUOTE_CHECK, blank, contextBlock, idProblems, quoteCheck, strategyJudge, type Upstream } from "./common";
import { msdmAttraction } from "./attraction";
import { msdmRecruitment, type RecruitmentOutput } from "./recruitment";
import { msdmDevelopment } from "./development";

const Indikator = z.object({
  id: z.string(), // I1…
  /** Nama singkat indikator (label AHP dan catatan sel). */
  nama: z.string().min(2),
  /** Deskripsi perilaku per level: indeks 0 = level 1 (terendah). Excel memakai 3 level. */
  levels: z.array(z.string().min(1)).min(1).max(5),
  /** Target level (M). */
  target: z.number().int().min(1).max(5),
  /** Realisasi level staf (N); null = belum dinilai. */
  realisasi: z.number().min(0).max(5).nullable().default(null),
  /** Alat/kegiatan untuk mengukur atau membina (kolom Tools). */
  tools: z.string().default(""),
  /** Dasar target/realisasi (wajib bila realisasi diisi AI dari dokumen). */
  alasan: z.string().default(""),
});
const Atribut = z.object({ id: z.string(), nama: z.string().min(2), indikator: z.array(Indikator).min(1) }); // A1…
const NilaiUtama = z.object({ id: z.string(), nama: z.string().min(2), atribut: z.array(Atribut).min(1) }); // N1…

export const PenilaianOutput = z.object({
  /** Nama samaran staf yang dinilai (jangan nama asli di hasil AI). */
  staffName: z.string().default("Staf A"),
  /** Departemen/biro/bidang staf. */
  unit: z.string().default(""),
  /** Profil output staf yang diharapkan (kolom Output). */
  output: z.string().min(5),
  nilaiUtama: z.array(NilaiUtama).min(1),
  /** Perbandingan AHP: id "NU" = antar-nilai utama; id = ID nilai utama → antar-atributnya; id = ID atribut → antar-indikatornya. */
  ahp: z.array(AhpSetSchema).default([]),
  /** Bukti data penilaian di dokumen (wajib bila ada realisasi yang diisi AI). */
  realisasiEvidence: z.array(Evidence).default([]),
});
export type PenilaianOutput = z.infer<typeof PenilaianOutput>;
export type NilaiUtamaRaw = z.infer<typeof NilaiUtama>;

export type PenilaianComputed = PenilaianOutput & {
  /** Bobot lokal (AHP; 1 bila sendirian di kelompoknya) per ID nilai utama/atribut/indikator. */
  bobot: Record<string, number>;
  /** Ketercapaian (0–1) per ID indikator (L), atribut (H), nilai utama (E); null = belum lengkap dinilai. */
  ketercapaian: Record<string, number | null>;
  /** Ketercapaian output (A); null bila masih ada indikator yang belum dinilai. */
  total: number | null;
  dinilai: number;
  jumlahIndikator: number;
  ahpSets: AhpSetComputed[];
};

// ---------- Perhitungan ----------

/** Kelompok AHP: semua nilai utama ("NU"), atribut per nilai utama, indikator per atribut. */
export function ahpGroups(o: Pick<PenilaianOutput, "nilaiUtama">): { setId: string; label: string; items: string[] }[] {
  const nu = o.nilaiUtama ?? [];
  return [
    { setId: "NU", label: "Nilai utama", items: nu.map((n) => n.id) },
    ...nu.map((n) => ({ setId: n.id, label: `Atribut nilai — ${n.nama}`, items: n.atribut.map((a) => a.id) })),
    ...nu.flatMap((n) => n.atribut.map((a) => ({ setId: a.id, label: `Indikator — ${a.nama}`, items: a.indikator.map((i) => i.id) }))),
  ];
}

/** Ketercapaian indikator = IF(N>M, 1, N/M); null bila realisasi kosong. */
export function ketercapaianIndikator(target: number, realisasi: number | null | undefined): number | null {
  if (realisasi === null || realisasi === undefined) return null;
  if (realisasi > target) return 1;
  return target > 0 ? realisasi / target : 0;
}

/** Jumlah tertimbang; null bila salah satu anak null (belum dinilai). */
function weighted(xs: { w: number; v: number | null }[]): number | null {
  if (!xs.length || xs.some((x) => x.v === null)) return null;
  return xs.reduce((s, x) => s + x.w * (x.v as number), 0);
}

/** Roll-up seperti Excel (L → H → E → A) dengan bobot lokal `w(id)`. */
export function rollUp(nilaiUtama: NilaiUtamaRaw[], w: (id: string) => number): { ketercapaian: Record<string, number | null>; total: number | null } {
  const k: Record<string, number | null> = {};
  for (const n of nilaiUtama) {
    for (const a of n.atribut) {
      for (const i of a.indikator) k[i.id] = ketercapaianIndikator(i.target, i.realisasi);
      k[a.id] = weighted(a.indikator.map((i) => ({ w: w(i.id), v: k[i.id] })));
    }
    k[n.id] = weighted(n.atribut.map((a) => ({ w: w(a.id), v: k[a.id] })));
  }
  return { ketercapaian: k, total: weighted(nilaiUtama.map((n) => ({ w: w(n.id), v: k[n.id] }))) };
}

export function computePenilaian(out: PenilaianOutput): PenilaianComputed {
  const bobot: Record<string, number> = {};
  const ahpSets: AhpSetComputed[] = [];
  for (const g of ahpGroups(out)) {
    if (g.items.length === 1) bobot[g.items[0]] = 1;
    if (g.items.length < 2) continue;
    const raw = out.ahp.find((s) => s.id === g.setId);
    const s = computeAhpSet({ id: g.setId, items: g.items, pairs: raw?.pairs ?? [] }, g.label);
    ahpSets.push(s);
    s.items.forEach((id, i) => (bobot[id] = s.weights[i] ?? 0));
  }
  const { ketercapaian, total } = rollUp(out.nilaiUtama, (id) => bobot[id] ?? 0);
  const inds = out.nilaiUtama.flatMap((n) => n.atribut.flatMap((a) => a.indikator));
  return { ...out, bobot, ketercapaian, total, dinilai: inds.filter((i) => i.realisasi !== null).length, jumlahIndikator: inds.length, ahpSets };
}

// ---------- Mock ----------

const UPSTREAM: Upstream[] = [msdmAttraction, msdmRecruitment, msdmDevelopment];

type MockInd = [nama: string, levels: [string, string, string], target: number, tools: string];
const MOCK_RUBRIC: { nama: string; atribut: { nama: string; ind: MockInd[] }[] }[] = [
  {
    nama: "Komunikatif",
    atribut: [
      { nama: "Komunikasi Internal", ind: [["Penguasaan informasi internal", ["Staf tidak mengetahui informasi internal yang berkaitan dengan tugasnya", "Staf mengetahui informasi internal setelah diberi tahu", "Staf aktif mencari dan memahami informasi internal yang berkaitan dengan tugasnya"], 3, "Pencerdasan staf"]] },
      {
        nama: "Koordinasi",
        ind: [
          ["Keterlibatan koordinasi", ["Staf tidak terlibat dalam koordinasi kebutuhan bidang", "Staf membantu koordinasi kebutuhan bidang", "Staf mampu mengoordinasikan kebutuhan bidang secara mandiri"], 3, "Rapat bidang"],
          ["Koordinasi dengan pihak terkait", ["Staf tidak mampu berkoordinasi dengan pihak terkait", "Staf mulai mampu berkoordinasi setelah diberi arahan", "Staf berkoordinasi secara aktif dan efektif dengan pihak terkait"], 2, "Rapat koordinasi"],
        ],
      },
      { nama: "Kejelasan Komunikasi", ind: [["Kejelasan penyampaian", ["Staf menyampaikan informasi dengan tidak jelas", "Staf menyampaikan informasi dengan cukup jelas", "Staf menyampaikan informasi secara jelas, ringkas, dan mudah dipahami"], 3, "Evaluasi komunikasi"]] },
    ],
  },
  {
    nama: "Bertanggung Jawab",
    atribut: [
      { nama: "Ketepatan Waktu", ind: [["Penyelesaian tugas tepat waktu", ["Staf sering terlambat menyelesaikan tugas", "Staf menyelesaikan tugas sesuai tenggat setelah diingatkan", "Staf konsisten menyelesaikan tugas sebelum tenggat"], 3, "Timeline kerja"]] },
      { nama: "Kualitas Hasil Kerja", ind: [["Mutu hasil kerja", ["Hasil kerja staf belum sesuai standar", "Hasil kerja sesuai standar setelah revisi", "Hasil kerja sesuai standar tanpa revisi berarti"], 3, "Review hasil kerja"]] },
    ],
  },
  {
    nama: "Kolaboratif",
    atribut: [
      { nama: "Kerja Sama Tim", ind: [["Kontribusi dalam tim", ["Staf jarang berkontribusi dalam kerja tim", "Staf berkontribusi ketika diminta", "Staf aktif berkontribusi dan membantu anggota lain"], 3, "Penilaian rekan kerja"]] },
      {
        nama: "Inisiatif",
        ind: [
          ["Inisiatif gagasan", ["Staf tidak memberikan gagasan", "Staf memberikan gagasan ketika diarahkan", "Staf aktif menawarkan gagasan perbaikan"], 3, "Brainstorming bidang"],
          ["Inisiatif pelaksanaan", ["Staf menunggu perintah untuk bekerja", "Staf membantu pelaksanaan ketika diberi tugas", "Staf berinisiatif mengambil pekerjaan yang dibutuhkan"], 2, "Monitoring kegiatan"],
        ],
      },
    ],
  },
  {
    nama: "Adaptif",
    atribut: [
      { nama: "Pemanfaatan Teknologi", ind: [["Penggunaan alat kerja digital", ["Staf belum mampu menggunakan alat kerja digital organisasi", "Staf mampu menggunakan alat kerja digital setelah diberi arahan", "Staf mahir dan membantu anggota lain menggunakan alat kerja digital"], 3, "Evaluasi alat kerja"]] },
    ],
  },
];
const MOCK_IMPORTANCE = [3, 3, 2, 1.5];

function mock(ctx: NodeContext): PenilaianOutput {
  const rec = ctx.inputs.msdm_recruitment as RecruitmentOutput | undefined;
  const unit = rec?.positions?.find((p) => /staf|staff|asisten|anggota/i.test(p.name))?.name ?? `Pengurus ${ctx.projectName}`;
  let a = 0;
  let i = 0;
  const nilaiUtama = MOCK_RUBRIC.map((n, ni) => ({
    id: `N${ni + 1}`,
    nama: n.nama,
    atribut: n.atribut.map((at) => ({
      id: `A${++a}`,
      nama: at.nama,
      indikator: at.ind.map(([nama, levels, target, tools]) => ({ id: `I${++i}`, nama, levels: [...levels], target, realisasi: null, tools, alasan: "" })),
    })),
  }));
  const ahp: AhpSetRaw[] = [];
  const nuIds = nilaiUtama.map((n) => n.id);
  ahp.push(mockAhpSet("NU", nuIds, (id) => MOCK_IMPORTANCE[nuIds.indexOf(id)] ?? 1));
  for (const n of nilaiUtama) {
    if (n.atribut.length > 1) {
      const ids = n.atribut.map((x) => x.id);
      ahp.push(mockAhpSet(n.id, ids, (id) => (ids.length - ids.indexOf(id)) * 1.0 + 1));
    }
    for (const at of n.atribut)
      if (at.indikator.length > 1) {
        const ids = at.indikator.map((x) => x.id);
        ahp.push(mockAhpSet(at.id, ids, (id) => ids.length - ids.indexOf(id) + 1));
      }
  }
  return {
    staffName: "Staf A",
    unit,
    output: `Staf ${ctx.projectName} yang komunikatif, bertanggung jawab, kolaboratif, dan adaptif dalam menjalankan program kerja secara berkualitas`,
    nilaiUtama,
    ahp,
    realisasiEvidence: [],
  };
}

// ---------- Butir, sheet, blok ----------

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${num(x * 100, 1)}%`);

function items(out: unknown) {
  const o = out as PenilaianComputed;
  const w = o.bobot ?? {};
  const k = o.ketercapaian ?? {};
  return (o.nilaiUtama ?? []).flatMap((n) => [
    { id: n.id, text: n.nama, detail: `Nilai utama · bobot ${num(w[n.id])} · ketercapaian ${pct(k[n.id])}` },
    ...n.atribut.flatMap((a) => [
      { id: a.id, text: a.nama, detail: `Atribut ${n.nama} · bobot ${num(w[a.id])} · ketercapaian ${pct(k[a.id])}` },
      ...a.indikator.map((i) => ({
        id: i.id,
        text: i.nama,
        detail: `Indikator ${a.nama} · bobot ${num(w[i.id])} · target ${i.target} · realisasi ${i.realisasi ?? "belum dinilai"} · level: ${i.levels.map((l, x) => `${x + 1}) ${l}`).join(" ")}`,
      })),
    ]),
  ]);
}

const HEAD = "6D9EEB";
const OUTFILL = "C9DAF8";
const NU_FILL = ["A4C2F4", "A2C4C9", "CFE2F3", "D9D2E9"];
const NODE = "msdm_penilaian";

/** Sel bobot: AHP → rujukan ke sheet AHP; sendirian di kelompoknya → 1 (tetap). */
function bobotCell(o: PenilaianComputed, id: string, nama: string, group: string, single: boolean, fill: string, rs: number) {
  const w = o.bobot[id] ?? 0;
  return single
    ? { v: 1, opts: { style: "num" as const, fmt: "0.000", fill, rs, src: "tetap" as const, center: true, note: `${nama}: satu-satunya butir di kelompok ${group} → bobot 1.` } }
    : {
        v: w,
        opts: {
          style: "num" as const,
          fmt: "0.000",
          fill,
          rs,
          src: "ahp" as const,
          center: true,
          f: `{{${NODE}!w_${id}}}`,
          explain: `Bobot ${nama} = hasil AHP kelompok ${group} = ${num(w)} (ubah perbandingannya di sheet AHP).`,
        },
      };
}

function sheet(o: PenilaianComputed): Grid {
  const g = new GridBuilder("penilaian", "MSDMGD-DEVELOPMENT", "Lembar Penilaian Staff");
  // Baris 1 (Excel): Nama | staf | Departemen | unit | judul
  g.set(0, 0, "Nama", { style: "header", fill: HEAD });
  g.set(0, 1, o.staffName, { style: "label", fill: HEAD, cs: 4, src: "ai", note: "Nama samaran; ganti dengan nama staf yang dinilai bila perlu.", edit: { path: ["staffName"], type: "text" } });
  g.set(0, 5, "Departemen", { style: "header", fill: HEAD, cs: 2 });
  g.set(0, 7, o.unit || "(belum diisi)", { style: "label", fill: HEAD, cs: 3, src: "ai", edit: { path: ["unit"], type: "text" } });
  g.set(0, 10, "Lembar Penilaian Staff", { style: "title", fill: HEAD, cs: 5 });
  const H = { style: "header" as const, fill: HEAD };
  g.row(2, 0, ["Ketercapaian Output", "Output", "Bobot Nilai Utama", "Nilai Utama", "Ketercapaian Nilai Utama", "Bobot Atribut Nilai", "Atribut Nilai", "Ketercapaian Atribut Nilai", "Bobot Indikator"], H);
  g.set(2, 9, "Indikator", { ...H, cs: 2 });
  g.row(2, 11, ["Ketercapaian Indikator", "Target", "Realisasi", "Tools"], H);

  const rowsOfInd = (i: { levels: string[] }) => Math.max(1, i.levels.length);
  const rowsOfAt = (a: NilaiUtamaRaw["atribut"][number]) => a.indikator.reduce((s, i) => s + rowsOfInd(i), 0);
  const rowsOfNu = (n: NilaiUtamaRaw) => n.atribut.reduce((s, a) => s + rowsOfAt(a), 0);
  const R0 = 3; // Excel baris 4
  const totalRows = Math.max(1, o.nilaiUtama.reduce((s, n) => s + rowsOfNu(n), 0));
  const K = o.ketercapaian;
  const nuRows: { r: number; id: string; nama: string }[] = [];
  const nuSingle = o.nilaiUtama.length === 1;
  let r = R0;
  o.nilaiUtama.forEach((n, ni) => {
    const fill = NU_FILL[ni % NU_FILL.length];
    const nRows = rowsOfNu(n);
    const rN = r;
    nuRows.push({ r: rN, id: n.id, nama: n.nama });
    const bc = bobotCell(o, n.id, n.nama, "nilai utama", nuSingle, fill, nRows);
    g.set(rN, 2, bc.v, bc.opts);
    g.set(rN, 3, n.nama, { style: "label", fill, rs: nRows, src: "ai", edit: { path: ["nilaiUtama", ni, "nama"], type: "text" } });
    const atRows: { r: number; nama: string; id: string }[] = [];
    n.atribut.forEach((a, ai) => {
      const aRows = rowsOfAt(a);
      const rA = r;
      atRows.push({ r: rA, nama: a.nama, id: a.id });
      const ba = bobotCell(o, a.id, a.nama, `atribut ${n.nama}`, n.atribut.length === 1, fill, aRows);
      g.set(rA, 5, ba.v, ba.opts);
      g.set(rA, 6, a.nama, { style: "label", fill, rs: aRows, src: "ai", edit: { path: ["nilaiUtama", ni, "atribut", ai, "nama"], type: "text" } });
      const indRows: { r: number; nama: string; id: string }[] = [];
      a.indikator.forEach((ind, ii) => {
        const iRows = rowsOfInd(ind);
        const rI = r;
        indRows.push({ r: rI, nama: ind.nama, id: ind.id });
        const base = ["nilaiUtama", ni, "atribut", ai, "indikator", ii] as (string | number)[];
        const bi = bobotCell(o, ind.id, ind.nama, `indikator ${a.nama}`, a.indikator.length === 1, fill, iRows);
        g.set(rI, 8, bi.v, { ...bi.opts, note: [`Indikator: ${ind.nama}`, bi.opts.note].filter(Boolean).join("\n") });
        ind.levels.forEach((lv, li) => {
          g.set(rI + li, 9, li + 1, { style: "int", fill, center: true, src: "tetap" });
          g.set(rI + li, 10, lv, { style: "text", fill, src: "ai", note: li === 0 ? `Indikator: ${ind.nama}` : undefined, edit: { path: [...base, "levels", li], type: "text" } });
        });
        const M = addr(rI, 12);
        const N = addr(rI, 13);
        const L = K[ind.id] ?? null;
        g.set(rI, 11, L, {
          style: "pct",
          fmt: "0.0%",
          fill,
          rs: iRows,
          src: "hitung",
          display: L === null ? "–" : undefined,
          f: `IF(${N}="","",IF(${N}>${M},1,${N}/${M}))`,
          explain:
            ind.realisasi === null
              ? `Ketercapaian ${ind.nama} = JIKA realisasi > target MAKA 1, SELAIN ITU realisasi ÷ target. Realisasi belum diisi → belum dinilai (–).`
              : ind.realisasi > ind.target
                ? `Ketercapaian ${ind.nama}: realisasi ${num(ind.realisasi, 2, true)} > target ${ind.target} → dibatasi 1 (100%).`
                : `Ketercapaian ${ind.nama} = realisasi ÷ target = ${num(ind.realisasi, 2, true)} ÷ ${ind.target} = ${num(L)} (${pct(L)})`,
        });
        const lvOpts = ind.levels.map((lv, li) => ({ label: `${li + 1} — ${lv.length > 50 ? lv.slice(0, 47) + "…" : lv}`, value: li + 1 }));
        g.set(rI, 12, ind.target, { style: "int", fill, rs: iRows, center: true, src: "ai", note: ind.alasan || undefined, edit: { path: [...base, "target"], type: "select", options: lvOpts } });
        g.set(rI, 13, ind.realisasi, {
          style: "int",
          fill,
          rs: iRows,
          center: true,
          src: "ai",
          display: ind.realisasi === null ? "(isi)" : undefined,
          note: ind.realisasi === null ? "Belum dinilai — pilih level yang dicapai staf." : ind.alasan || undefined,
          edit: { path: [...base, "realisasi"], type: "select", options: lvOpts, allowEmpty: true },
        });
        g.set(rI, 14, ind.tools, { style: "text", fill, rs: iRows, src: "ai", edit: { path: [...base, "tools"], type: "text" } });
        r += iRows;
      });
      // Ketercapaian atribut (H)
      const H = K[a.id] ?? null;
      const termsH = indRows.map((x) => `${addr(x.r, 8)}*${addr(x.r, 11)}`).join("+");
      const condH = indRows.map((x) => `${addr(x.r, 11)}=""`).join(",");
      g.set(rA, 7, H, {
        style: "pct",
        fmt: "0.0%",
        fill,
        rs: aRows,
        src: "hitung",
        display: H === null ? "–" : undefined,
        f: `IF(OR(${condH}),"",${termsH})`,
        explain:
          H === null
            ? `Ketercapaian ${a.nama} = Σ (bobot indikator × ketercapaian indikator); masih ada indikator yang belum dinilai (–).`
            : `Ketercapaian ${a.nama} = ${a.indikator.map((i) => `${num(o.bobot[i.id])} × ${num(K[i.id])}`).join(" + ")} = ${num(H)} (${pct(H)})`,
      });
    });
    // Ketercapaian nilai utama (E)
    const E = K[n.id] ?? null;
    g.set(rN, 4, E, {
      style: "pct",
      fmt: "0.0%",
      fill,
      rs: nRows,
      src: "hitung",
      display: E === null ? "–" : undefined,
      f: `IF(OR(${atRows.map((x) => `${addr(x.r, 7)}=""`).join(",")}),"",${atRows.map((x) => `${addr(x.r, 5)}*${addr(x.r, 7)}`).join("+")})`,
      explain:
        E === null
          ? `Ketercapaian ${n.nama} = Σ (bobot atribut × ketercapaian atribut); masih ada atribut yang belum lengkap dinilai (–).`
          : `Ketercapaian ${n.nama} = ${n.atribut.map((a) => `${num(o.bobot[a.id])} × ${num(K[a.id])}`).join(" + ")} = ${num(E)} (${pct(E)})`,
    });
  });
  // Ketercapaian output (A) dan Output (B)
  g.set(R0, 0, o.total, {
    style: "pct",
    fmt: "0.0%",
    fill: OUTFILL,
    rs: totalRows,
    src: "hitung",
    display: o.total === null ? "–" : undefined,
    f: nuRows.length ? `IF(OR(${nuRows.map((x) => `${addr(x.r, 4)}=""`).join(",")}),"",${nuRows.map((x) => `${addr(x.r, 2)}*${addr(x.r, 4)}`).join("+")})` : undefined,
    explain:
      o.total === null
        ? `Ketercapaian output = Σ (bobot nilai utama × ketercapaian nilai utama). Baru ${o.dinilai} dari ${o.jumlahIndikator} indikator yang dinilai — isi kolom Realisasi untuk menghitungnya.`
        : `Ketercapaian output = ${o.nilaiUtama.map((n) => `${num(o.bobot[n.id])} × ${num(K[n.id])}`).join(" + ")} = ${num(o.total)} (${pct(o.total)})`,
  });
  g.anchor("total", R0, 0);
  g.set(R0, 1, o.output, { style: "text", fill: OUTFILL, rs: totalRows, src: "ai", edit: { path: ["output"], type: "text" } });

  const chartData = o.nilaiUtama.filter((n) => K[n.id] !== null && K[n.id] !== undefined).map((n) => ({ label: n.nama, value: K[n.id] as number }));
  return g.build({
    cols: [14, 30, 10, 18, 13, 10, 22, 13, 10, 5, 48, 13, 9, 10, 22],
    freeze: { rows: 3, cols: 0 },
    chart: chartData.length ? { type: "bar", title: `Performa ${o.staffName}: ketercapaian nilai utama`, data: chartData, max: 1 } : undefined,
    notes: [
      "Baca dari kanan ke kiri: realisasi level staf dibanding target → ketercapaian indikator → dijumlah tertimbang ke atribut → nilai utama → ketercapaian output.",
      "Ketercapaian indikator = 1 bila realisasi melebihi target, selain itu realisasi ÷ target. Bobot tiap tingkat dari AHP (lihat sheet AHP); butir yang sendirian di kelompoknya berbobot 1.",
      o.dinilai < o.jumlahIndikator
        ? `Realisasi diisi per staf oleh penilai: baru ${o.dinilai} dari ${o.jumlahIndikator} indikator dinilai, sehingga ketercapaian di atasnya masih "–" dan grafik baru muncul setelah satu nilai utama lengkap.`
        : "Semua indikator sudah dinilai; grafik menampilkan ketercapaian tiap nilai utama.",
    ],
  });
}

function ahpSheet(o: PenilaianComputed): Grid {
  const name = new Map<string, string>();
  for (const n of o.nilaiUtama) {
    name.set(n.id, n.nama);
    for (const a of n.atribut) {
      name.set(a.id, a.nama);
      for (const i of a.indikator) name.set(i.id, i.nama);
    }
  }
  const sets: AhpSheetSet[] = ahpGroups(o)
    .filter((g) => g.items.length >= 2)
    .map((g) => {
      const k = o.ahp.findIndex((s) => s.id === g.setId);
      return { raw: { id: g.setId, items: g.items, pairs: k >= 0 ? o.ahp[k].pairs : [] }, label: g.label, path: ["ahp", Math.max(0, k)], itemLabel: (id: string) => name.get(id) ?? id };
    });
  return ahpGrid({ id: "ahp", name: "MSDMGD-DEVELOPMENT AHP", title: "AHP — bobot nilai utama, atribut, dan indikator", sets });
}

function blocks(o: PenilaianComputed): Block[] {
  return [
    { type: "h2", text: "Penilaian staf (rubrik)" },
    { type: "p", text: `Output yang diharapkan: ${o.output}` },
    {
      type: "table",
      head: ["Nilai utama", "Bobot", "Atribut (bobot)", "Indikator (bobot)", "Target", "Ketercapaian"],
      rows: o.nilaiUtama.flatMap((n) =>
        n.atribut.flatMap((a) =>
          a.indikator.map((i) => [
            `${n.nama}`,
            num(o.bobot[n.id]),
            `${a.nama} (${num(o.bobot[a.id])})`,
            `${i.nama} (${num(o.bobot[i.id])}): ${i.levels.map((l, x) => `${x + 1}) ${l}`).join(" ")}`,
            String(i.target),
            pct(o.ketercapaian[i.id]),
          ]),
        ),
      ),
      widths: [14, 8, 18, 40, 8, 12],
    },
    { type: "p", text: o.total === null ? `Ketercapaian output belum dihitung: ${o.dinilai} dari ${o.jumlahIndikator} indikator sudah dinilai.` : `Ketercapaian output ${o.staffName}: ${pct(o.total)}.` },
  ];
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Ketercapaian indikator",
    rumus: "L = 1 bila Realisasi > Target, selain itu Realisasi ÷ Target (kosong bila realisasi belum diisi)",
    arti: "Seberapa jauh level perilaku staf mencapai target level indikator (maksimal 100%).",
    excel: '=IF(N4>M4,1,N4/M4) — di ekspor: =IF(N4="","",IF(N4>M4,1,N4/M4))',
  },
  { name: "Ketercapaian atribut nilai", rumus: "H = Σ (bobot indikator × ketercapaian indikator)", arti: "Rata-rata tertimbang indikator dalam satu atribut.", excel: "=(I6*L6)+(I9*L9)" },
  { name: "Ketercapaian nilai utama", rumus: "E = Σ (bobot atribut × ketercapaian atribut)", arti: "Rata-rata tertimbang atribut dalam satu nilai utama.", excel: "=(H15*F15)+(F17*H17)" },
  { name: "Ketercapaian output", rumus: "A = Σ (bobot nilai utama × ketercapaian nilai utama)", arti: "Nilai akhir staf terhadap profil output yang diharapkan.", excel: "=(C4*E4)+(C15*E15)+(C20*E20)+(C31*E31)" },
  { name: "Bobot (AHP)", rumus: "Bobot = rata-rata geometrik baris matriks perbandingan ÷ jumlahnya; butir tunggal = 1", arti: "Bobot tiap nilai utama, atribut, dan indikator dihitung dari perbandingan berpasangan.", excel: "=GEOMEAN(baris)/SUM(GEOMEAN semua baris)" },
];

export const msdmPenilaian: NodeDef<PenilaianOutput> = {
  key: "msdm_penilaian",
  label: "MSDM – Penilaian staf (GD development)",
  phase: 2,
  group: "msdm",
  sheetName: "MSDMGD-DEVELOPMENT",
  deps: [],
  kind: "llm",
  description:
    "Lembar penilaian staf: rubrik nilai utama → atribut → indikator dengan deskripsi level, target, dan tools; bobot tiap tingkat dari AHP; realisasi diisi penilai per staf lalu ketercapaian dihitung seperti rumus Excel.",
  computedBy: "LLM (rubrik) + AHP + kode (ketercapaian)",
  schema: PenilaianOutput,
  checks: [
    { name: "rubric_structure", kind: "code", description: "Rubrik belum lengkap: 3–6 nilai utama, tiap atribut 1–3 indikator, tiap indikator minimal 2 deskripsi level dan tools, ID unik di semua tingkat" },
    { name: "target_range", kind: "code", description: "Target atau realisasi di luar level yang dideskripsikan (mis. target 3 padahal hanya ada level 1–2)" },
    { name: "realisasi_grounded", kind: "code", description: "Realisasi diisi AI tanpa data penilaian di dokumen (seharusnya dikosongkan untuk diisi penilai)" },
    { name: "staff_anonim", kind: "code", description: "Nama staf di hasil AI harus nama samaran (mis. Staf A), bukan nama orang" },
    ...AHP_CHECKS,
    QUOTE_CHECK,
    { name: "rubric_relevance", kind: "llm", description: "Nilai utama/atribut tidak relevan dengan profil output staf dan arah organisasi" },
  ],
  queries: () => [
    { focus: "penilaian kinerja", text: "penilaian kinerja staf pengurus evaluasi raport indikator target capaian keaktifan", k: 6 },
    { focus: "nilai organisasi", text: "nilai organisasi budaya kerja sikap kompetensi yang diharapkan dari pengurus", k: 4 },
  ],
  prompt: (ctx) => ({
    system: `Kamu konsultan manajemen SDM organisasi kemahasiswaan. Susun RUBRIK "Lembar Penilaian Staff" untuk staf organisasi ini.
Struktur (ID unik di semua tingkat):
- output: profil staf yang diharapkan (1 kalimat), mis. "Staf … yang handal, adaptif, …".
- nilaiUtama (N1, N2, …; 3–5): nilai/sikap utama yang dinilai.
- atribut (A1, A2, … berurutan lintas nilai utama; 1–4 per nilai utama): aspek yang membentuk nilai utama.
- indikator (I1, I2, … berurutan lintas atribut; 1–2 per atribut): "nama" singkat, "levels" = TEPAT 3 deskripsi perilaku berjenjang (level 1 = belum/tidak, level 2 = dengan arahan, level 3 = mandiri/konsisten), "target" = level yang diharapkan (1–3), "tools" = kegiatan/alat untuk mengukur atau membina (mis. rapat bidang, review hasil kerja), "alasan" singkat.
- realisasi: level yang DICAPAI staf. Isi null untuk semua indikator, KECUALI dokumen memuat data penilaian staf yang jelas — bila begitu boleh mengisi contoh realisasi dan WAJIB menaruh buktinya di "realisasiEvidence". ${EVIDENCE_RULES}
- staffName: tulis "Staf A" (nama samaran, jangan nama orang); unit: bidang/departemen staf yang dinilai.

${AHP_RULES}
Himpunan AHP yang wajib diisi (lewati kelompok yang hanya berisi satu butir; bobotnya otomatis 1):
- id "NU": semua nilai utama.
- id = ID nilai utama (mis. "N1"): atribut di dalam nilai utama itu.
- id = ID atribut (mis. "A2"): indikator di dalam atribut itu.
Contoh: bila N1 punya atribut A1, A2, A3 maka pasangan yang wajib diisi ${pairList(["A1", "A2", "A3"])} → {"id":"N1","items":["A1","A2","A3"],"pairs":[{"a":"A1","b":"A2","v":2},{"a":"A1","b":"A3","v":3},{"a":"A2","b":"A3","v":2}]}.

Selaraskan rubrik dengan kebutuhan organisasi (attraction), tugas posisi (recruitment), dan rencana pengembangan (development). ${JSON_ONLY}`,
    user: `${contextBlock(ctx, UPSTREAM)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(PenilaianOutput)}`,
  }),
  mock,
  validate: async (out, ctx, llm) => {
    const NU = out.nilaiUtama;
    const ATs = NU.flatMap((n) => n.atribut);
    const INDs = ATs.flatMap((a) => a.indikator);
    const st: Failure[] = [
      ...(NU.length < 3 || NU.length > 6 ? [{ check: "rubric_structure", message: `Jumlah nilai utama ${NU.length}; seharusnya 3–6.` }] : []),
      ...(blank(out.output) ? [{ check: "rubric_structure", message: "Output (profil staf yang diharapkan) belum diisi." }] : []),
      ...idProblems([...NU, ...ATs, ...INDs], "Penilaian", "rubric_structure"),
      ...([...NU, ...ATs, ...INDs].some((y) => y.id === "NU") ? [{ check: "rubric_structure", itemId: "NU", message: 'ID "NU" dipakai khusus untuk himpunan AHP nilai utama.' }] : []),
      ...ATs.filter((a) => a.indikator.length > 3).map((a) => ({ check: "rubric_structure", itemId: a.id, message: `${a.id} (${a.nama}) punya ${a.indikator.length} indikator; maksimal 3.` })),
      ...INDs.flatMap((i) => [
        ...(i.levels.length < 2 || i.levels.some((l) => blank(l))
          ? [{ check: "rubric_structure", itemId: i.id, message: `${i.id} (${i.nama}) harus punya minimal 2 deskripsi level yang terisi (Excel memakai 3).` }]
          : []),
        ...(blank(i.tools) ? [{ check: "rubric_structure", itemId: i.id, message: `${i.id} (${i.nama}): kolom Tools belum diisi.` }] : []),
      ]),
    ];
    const rng: Failure[] = INDs.flatMap((i) => [
      ...(i.target > i.levels.length ? [{ check: "target_range", itemId: i.id, message: `${i.id} (${i.nama}): target level ${i.target}, padahal hanya ada ${i.levels.length} level yang dideskripsikan.` }] : []),
      ...(i.realisasi !== null && i.realisasi > i.levels.length
        ? [{ check: "target_range", itemId: i.id, message: `${i.id} (${i.nama}): realisasi ${i.realisasi} melebihi level tertinggi (${i.levels.length}).` }]
        : []),
    ]);
    const filled = INDs.filter((i) => i.realisasi !== null);
    const grounded: Failure[] =
      filled.length && !out.realisasiEvidence.length
        ? [{ check: "realisasi_grounded", message: `${filled.length} realisasi diisi tanpa bukti data penilaian di dokumen (${filled.map((i) => i.id).join(", ")}); kosongkan (null) agar diisi penilai.` }]
        : [];
    const anon: Failure[] = /^(staf|staff|pengurus|anggota|responden)\b/i.test(out.staffName.trim())
      ? []
      : [{ check: "staff_anonim", message: `Nama staf "${out.staffName}" harus nama samaran seperti "Staf A".` }];
    const expected: AhpSetRaw[] = ahpGroups(out)
      .filter((g) => g.items.length >= 2)
      .map((g) => ({ id: g.setId, items: g.items, pairs: out.ahp.find((s) => s.id === g.setId)?.pairs ?? [] }));
    const label = new Map(ahpGroups(out).map((g) => [g.setId, g.label]));
    const labelOf = (id: string) => label.get(id) ?? id;
    return [
      result("rubric_structure", "code", st),
      result("target_range", "code", rng),
      result("realisasi_grounded", "code", grounded),
      result("staff_anonim", "code", anon),
      checkAhpComplete(expected, labelOf),
      checkAhpConsistency(expected, labelOf),
      quoteCheck([{ id: "REALISASI", evidence: out.realisasiEvidence }], ctx.evidence),
      await strategyJudge(
        llm,
        ctx,
        "rubric_relevance",
        `Periksa apakah setiap nilai utama (N…) dan atribut (A…) relevan untuk menilai staf menuju profil output "${out.output}" dan selaras dengan arah organisasi; atribut harus benar-benar bagian dari nilai utamanya.`,
        [...NU.map((n) => ({ id: n.id, text: `Nilai utama: ${n.nama}` })), ...NU.flatMap((n) => n.atribut.map((a) => ({ id: a.id, text: `Atribut ${a.nama} (dari nilai utama ${n.nama}); indikator: ${a.indikator.map((i) => i.nama).join("; ")}` })))],
      ),
    ];
  },
  compute: (out) => computePenilaian(out),
  repairHint: "Perbaiki hanya bagian yang ditolak (struktur rubrik, perbandingan AHP yang bertentangan/kurang, atau realisasi tanpa bukti); bagian lain salin apa adanya.",
  items,
  sheets: (out) => [sheet(out as PenilaianComputed), ahpSheet(out as PenilaianComputed)],
  blocks: (out) => blocks(out as PenilaianComputed),
  formulas: FORMULAS,
  summary: (out) => {
    const o = out as PenilaianComputed;
    const nA = (o.nilaiUtama ?? []).reduce((s, n) => s + n.atribut.length, 0);
    return o.total === null || o.total === undefined
      ? `Rubrik penilaian ${o.nilaiUtama?.length ?? 0} nilai utama, ${nA} atribut, ${o.jumlahIndikator ?? 0} indikator; realisasi baru ${o.dinilai ?? 0}/${o.jumlahIndikator ?? 0} indikator dinilai.`
      : `Ketercapaian output ${o.staffName}: ${pct(o.total)} (${o.nilaiUtama.length} nilai utama, ${o.jumlahIndikator} indikator).`;
  },
};
