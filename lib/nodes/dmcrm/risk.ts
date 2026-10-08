// Risk management (tab DM-CRMRM, "EVALUASI DAN RENCANA PENANGANAN RISIKO"): register risiko per unit kerja.
// AI mengusulkan isi, Probabilitas (P) dan Dampak (I) 1–5 (bisa diubah pengguna); kode menghitung seperti Excel:
//   Skor Risiko Inherent (W) = M3*N3            (sel kosong dihitung 0)
//   Inherent Risk Rating     = IF(O3="", "", IF(O3<=4, "MINOR", IF(O3<=14, "MODERATE", "MAJOR")))
// Sheet juga memuat peta risiko (heat map P × I dengan COUNTIFS) dan grafik sebar P vs I.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { AnnotItem, CheckSpec, Failure, NodeContext, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { isNegative, pick, sentencesOf, toClaim } from "../heuristics";
import { checkQuotes, llmJudge, norm, result } from "@/lib/validators/common";
import { GridBuilder, addr, num, range, type Block, type CellEdit, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { computeDecision } from "./decision";
import { computeChange } from "./change";
import type { RiskManagementComputed } from "../contracts";
import {
  arr,
  citedChunkIds,
  docChunks,
  lowerFirst,
  numbered,
  rankedFactors,
  shortLabel,
  stakeholderRoles,
  unitKnown,
  unitsFromText,
  upstreamIds,
  upstreamSections,
  validEvidence,
} from "./common";

// ---------- Pilihan nilai (daftar validasi data di tab Excel) ----------

export const STATUS = ["Active", "Retired"] as const;
export const JENIS = ["Opportunity", "Threat"] as const;
/** Persis seperti daftar validasi data kolom E di Excel (termasuk ejaan "Eksternal risk"). */
export const KATEGORI = ["Strategy and Planning Risk", "Finance Risk", "Operational / Infrastructure Risk", "Technical Risk", "Eksternal risk"] as const;
/** Excel: Avoid, Mitigate, Transfer, Accept (ancaman). Ditambah respons risiko positif (peluang): Exploit, Enhance, Share. */
export const STRATEGI_ANCAMAN = ["Avoid", "Mitigate", "Transfer", "Accept"] as const;
export const STRATEGI_PELUANG = ["Exploit", "Enhance", "Share", "Accept"] as const;
export const STRATEGI = ["Avoid", "Mitigate", "Transfer", "Accept", "Exploit", "Enhance", "Share"] as const;

export type RiskRating = "MINOR" | "MODERATE" | "MAJOR";

/** Skala probabilitas (legenda di tab Excel, diterjemahkan). */
export const P_SCALE: Record<number, string> = {
  1: "Hampir tidak mungkin terjadi",
  2: "Kecil kemungkinan terjadi dalam keadaan normal",
  3: "Mungkin terjadi suatu waktu",
  4: "Diperkirakan terjadi suatu waktu",
  5: "Diperkirakan terjadi rutin dalam keadaan normal",
};
/** Skala dampak. Label Very Low–Very High dari legenda Excel; uraiannya disesuaikan untuk organisasi mahasiswa (legenda Excel memakai contoh cedera/K3). */
export const I_SCALE: Record<number, { label: string; arti: string }> = {
  1: { label: "VERY LOW", arti: "Gangguan kecil, tidak memengaruhi program" },
  2: { label: "LOW", arti: "Sebagian kecil kegiatan terganggu, mudah dipulihkan" },
  3: { label: "MEDIUM", arti: "Program/target unit terganggu, perlu penanganan khusus" },
  4: { label: "HIGH", arti: "Beberapa program gagal atau keuangan/reputasi terdampak serius" },
  5: { label: "VERY HIGH", arti: "Keberlangsungan organisasi atau kepengurusan terancam" },
};

const P_OPTIONS: NonNullable<CellEdit["options"]> = [1, 2, 3, 4, 5].map((v) => ({ label: `${v} – ${P_SCALE[v]}`, value: v }));
const I_OPTIONS: NonNullable<CellEdit["options"]> = [1, 2, 3, 4, 5].map((v) => ({ label: `${v} – ${I_SCALE[v].label} (${I_SCALE[v].arti})`, value: v }));

// ---------- Skema output mentah (AI) ----------

const Risk = z.object({
  id: z.string(), // "RM1"
  unitKerja: z.string(),
  status: z.enum(STATUS),
  /** Peluang atau Ancaman. */
  jenis: z.enum(JENIS),
  kategori: z.enum(KATEGORI),
  sasaran: z.string(),
  /** Periode identifikasi risiko, mis. "TRIWULAN 1–4". */
  periode: z.string(),
  /** Deskripsi atau kejadian risiko. */
  deskripsi: z.string(),
  /** Daftar bernomor "1. …\n2. …". */
  akarPenyebab: z.string(),
  indikator: z.string(),
  /** Faktor positif / internal control yang ada saat ini (daftar bernomor). */
  faktorPositif: z.string(),
  /** Dampak kualitatif (daftar bernomor). */
  dampakKualitatif: z.string(),
  /** Probabilitas 1–5 (kosong = dihitung 0 seperti Excel). */
  p: z.number().nullable(),
  /** Dampak 1–5. */
  i: z.number().nullable(),
  alasanP: z.string().default(""),
  alasanI: z.string().default(""),
  strategi: z.enum(STRATEGI),
  /** Wajib bila Accept dipakai untuk risiko MODERATE/MAJOR. */
  justifikasi: z.string().default(""),
  /** Penanganan risiko (risk treatment). */
  penanganan: z.string(),
  /** Penanganan yang telah dilakukan. */
  penangananSaatIni: z.string(),
  /** ID butir analisis sebelumnya yang terkait (KD…, DM…, CM…, W…, T…, O…). */
  refs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});
export const RiskOutput = z.object({ risks: z.array(Risk) });
export type RiskOutput = z.infer<typeof RiskOutput>;
export type RiskItem = RiskOutput["risks"][number];

// ---------- Rumus Excel ----------

/** O3 = M3*N3 (sel kosong = 0). */
export const riskScore = (p: number | null | undefined, i: number | null | undefined) => (p ?? 0) * (i ?? 0);

/** P3 = IF(O3="", "", IF(O3<=4, "MINOR", IF(O3<=14, "MODERATE", "MAJOR"))) — O3 berumus tidak pernah "", jadi skor 0 → MINOR. */
export const riskRating = (score: number): RiskRating => (score <= 4 ? "MINOR" : score <= 14 ? "MODERATE" : "MAJOR");

const RATING_FILL: Record<RiskRating, string> = { MINOR: "00B050", MODERATE: "E36C09", MAJOR: "C00000" };
const HEAT_FILL: Record<RiskRating, string> = { MINOR: "00B050", MODERATE: "FFC000", MAJOR: "FF0000" };

// ---------- Hasil hitungan ----------

export type RiskRow = RiskItem & {
  /** Indeks di output mentah (untuk path edit). */
  rawIndex: number;
  /** Nomor urut di dalam unit kerja (kolom "No." di Excel). */
  no: number;
  score: number;
  rating: RiskRating;
};
export type RiskComputed = RiskOutput & {
  /** Baris register, dikelompokkan per unit kerja (urutan kemunculan). */
  rows: RiskRow[];
  units: string[];
  counts: { total: number; MINOR: number; MODERATE: number; MAJOR: number; threat: number; opportunity: number };
  /** heat[p-1][i-1] = jumlah risiko dengan P = p dan I = i (hanya P/I bulat 1–5). */
  heat: number[][];
  maxScore: number;
};

export function computeRisk(raw: unknown): RiskComputed {
  const risks = arr<RiskItem>((raw as Partial<RiskOutput> | null)?.risks).filter((r) => r && typeof r === "object");
  const units: string[] = [];
  for (const r of risks) if (!units.includes(r.unitKerja ?? "")) units.push(r.unitKerja ?? "");
  const rows: RiskRow[] = [];
  for (const u of units) {
    let no = 0;
    risks.forEach((r, rawIndex) => {
      if ((r.unitKerja ?? "") !== u) return;
      const score = riskScore(r.p, r.i);
      rows.push({ ...r, refs: arr<string>(r.refs), evidence: arr<Evidence>(r.evidence), rawIndex, no: ++no, score, rating: riskRating(score) });
    });
  }
  const heat = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  for (const r of rows) if (isScale(r.p) && isScale(r.i)) heat[r.p! - 1][r.i! - 1]++;
  const count = (f: (r: RiskRow) => boolean) => rows.filter(f).length;
  return {
    risks,
    rows,
    units,
    counts: {
      total: rows.length,
      MINOR: count((r) => r.rating === "MINOR"),
      MODERATE: count((r) => r.rating === "MODERATE"),
      MAJOR: count((r) => r.rating === "MAJOR"),
      threat: count((r) => r.jenis === "Threat"),
      opportunity: count((r) => r.jenis === "Opportunity"),
    },
    heat,
    maxScore: rows.length ? Math.max(...rows.map((r) => r.score)) : 0,
  };
}

const isScale = (x: number | null | undefined): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 5;

// ---------- Mock (tanpa LLM) ----------

function kategoriOf(text: string): (typeof KATEGORI)[number] {
  if (/anggaran|dana|keuangan|kas|biaya|sponsor|hibah|iuran/i.test(text)) return "Finance Risk";
  if (/kampus|rektorat|fakultas|kebijakan|regulasi|aturan|pesaing|persaingan|eksternal|mitra|alumni|ukm|komunitas/i.test(text)) return "Eksternal risk";
  if (/sistem|akun|data|digital|teknologi|arsip|platform|media sosial|website/i.test(text)) return "Technical Risk";
  if (/strategi|rencana|program|target|evaluasi|monitoring|kinerja|visi/i.test(text)) return "Strategy and Planning Risk";
  return "Operational / Infrastructure Risk";
}

const SASARAN: Record<(typeof KATEGORI)[number], string> = {
  "Finance Risk": "Menjaga akuntabilitas dan kecukupan anggaran program",
  "Eksternal risk": "Menjaga dukungan dan hubungan dengan pihak eksternal",
  "Technical Risk": "Menjaga keamanan dan ketersediaan data serta aset digital",
  "Strategy and Planning Risk": "Memastikan program kerja tercapai sesuai rencana",
  "Operational / Infrastructure Risk": "Menjaga kelancaran operasional dan koordinasi kepengurusan",
};
const INDIKATOR: Record<(typeof KATEGORI)[number], string> = {
  "Finance Risk": "Selisih realisasi terhadap rencana anggaran dan jumlah laporan keuangan yang terlambat",
  "Eksternal risk": "Jumlah kebijakan atau perubahan eksternal yang mengganggu program",
  "Technical Risk": "Jumlah data, akun, atau arsip yang hilang atau tidak terdokumentasi",
  "Strategy and Planning Risk": "Persentase program kerja yang tercapai sesuai target",
  "Operational / Infrastructure Risk": "Jumlah kegiatan yang tertunda atau terlambat dari jadwal",
};

const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
const GENERIC = new Set(["biro", "divisi", "departemen", "kementerian", "bidang", "unit"]);
/** Petunjuk tugas unit (mode uji): nama unit ↔ kata di teks risiko. */
const UNIT_HINTS: { unit: RegExp; text: RegExp }[] = [
  { unit: /kader|psdm|sdm|internal/i, text: /regenerasi|kader|staf|keaktifan|anggota|kompetensi|pelatihan/i },
  { unit: /media|informasi|kominfo|publikasi/i, text: /media|publikasi|desain|informasi|konten|akun/i },
  { unit: /keuangan|bendahara|finansial/i, text: /dana|anggaran|kas|keuangan|biaya/i },
  { unit: /administrasi|sekretari|kesekjenan/i, text: /dokumen|dokumentasi|laporan|surat|arsip|administrasi|sop/i },
  { unit: /eksternal|hubungan|kemitraan|humas/i, text: /mitra|alumni|sponsor|perusahaan|eksternal|kerja sama|hibah/i },
  { unit: /akademik|riset|penelitian|keilmuan/i, text: /riset|akademik|kuliah|penelitian|data|pelatihan bersertifikat/i },
  { unit: /mutu|evaluasi|pengawas/i, text: /evaluasi|monitoring|kinerja|standar/i },
];
/** Unit yang kata pembedanya (atau bidang tugasnya) muncul di teks, mis. "media sosial" → Divisi Media. */
function unitFor(text: string, units: string[], idx: number) {
  const t = new Set(words(text));
  return (
    units.find((u) => words(u).some((w) => !GENERIC.has(w) && t.has(w))) ??
    units.find((u) => UNIT_HINTS.some((h) => h.unit.test(u) && h.text.test(text))) ??
    units[idx % units.length]
  );
}

function mockRisk(ctx: NodeContext): RiskOutput {
  const inp = ctx.inputs;
  const dec = inp.decision_making ? computeDecision(inp.decision_making) : null;
  const ch = inp.change_management ? computeChange(inp.change_management, dec) : null;
  const docs = docChunks(ctx.evidence);
  let units = unitsFromText(docs.map((d) => d.content), 4);
  if (!units.length) units = unitsFromText(stakeholderRoles(inp).map((r) => r.jabatan), 4);
  if (!units.length) units = [ctx.projectName];
  const strengths = rankedFactors(inp, ["S"]);

  type Src = { jenis: "Threat" | "Opportunity"; text: string; refs: string[]; evidence: Evidence[]; konsekuensi?: string; kep?: { id: string; text: string } };
  const threats: Src[] = [];
  for (const k of dec?.kondisi ?? []) {
    const c = dec!.cakupan.find((x) => x.kondisi.includes(k.id));
    const kep = c ? dec!.keputusan.find((d) => d.id === c.id) : undefined;
    const q = dec!.konsekuensi.find((x) => x.dariKondisi.includes(k.id));
    threats.push({ jenis: "Threat", text: k.text, refs: [k.id, ...(kep ? [kep.id] : [])], evidence: validEvidence(k.evidence, ctx.evidence).slice(0, 1), konsekuensi: q?.text, kep });
  }
  const used = new Set((dec?.kondisi ?? []).flatMap((k) => k.refs));
  for (const f of rankedFactors(inp, ["T"]))
    if (!used.has(f.id) && threats.length < 6) threats.push({ jenis: "Threat", text: f.text, refs: [f.id], evidence: validEvidence(f.evidence, ctx.evidence).slice(0, 1) });
  if (!threats.length) {
    for (const d of docs)
      for (const s of sentencesOf(d.content))
        if (isNegative(s) && threats.length < 5) threats.push({ jenis: "Threat", text: toClaim(s), refs: [], evidence: [{ chunkId: d.id, quote: s }] });
  }
  let opps: Src[] = rankedFactors(inp, ["O"])
    .slice(0, 2)
    .map((f) => ({ jenis: "Opportunity" as const, text: f.text, refs: [f.id], evidence: validEvidence(f.evidence, ctx.evidence).slice(0, 1) }));
  if (!opps.length) {
    opps = [];
    for (const d of docs)
      for (const s of sentencesOf(d.content))
        if (opps.length < 2 && /peluang|tertarik|bersedia|hibah|kesempatan|meningkat/i.test(s) && !isNegative(s))
          opps.push({ jenis: "Opportunity", text: toClaim(s), refs: [], evidence: [{ chunkId: d.id, quote: s }] });
  }

  const sources = [...threats.slice(0, 6), ...opps];
  const risks: RiskItem[] = sources.map((s, idx) => {
    const id = `RM${idx + 1}`;
    const unitKerja = unitFor(s.text, units, idx);
    const kategori = kategoriOf(s.text);
    const p = 2 + pick(`${s.text}|p`, 3);
    const i = 2 + pick(`${s.text}|i`, 3);
    const rating = riskRating(p * i);
    const threat = s.jenis === "Threat";
    const strategi: RiskItem["strategi"] = threat
      ? rating === "MINOR"
        ? "Accept"
        : "Mitigate"
      : rating === "MAJOR"
        ? "Exploit"
        : rating === "MODERATE"
          ? "Enhance"
          : "Accept";
    const step = s.kep ? ch?.steps.find((st) => st.keputusanRefs.includes(s.kep!.id) && (st.no === 5 || st.no === 6)) ?? ch?.steps.find((st) => st.keputusanRefs.includes(s.kep!.id)) : undefined;
    const kekuatan = strengths[idx % Math.max(1, strengths.length)]?.text;
    return {
      id,
      unitKerja,
      status: "Active",
      jenis: s.jenis,
      kategori,
      sasaran: threat ? SASARAN[kategori] : "Meningkatkan jangkauan dan manfaat program organisasi",
      periode: threat ? "TRIWULAN 1–4" : "TRIWULAN 2–4",
      deskripsi: threat
        ? `Berlanjutnya kondisi "${shortLabel(s.text, 12)}" sehingga sasaran unit terhambat`
        : `Peluang yang dapat dimanfaatkan: ${lowerFirst(shortLabel(s.text, 16))}`,
      akarPenyebab: threat
        ? numbered([shortLabel(s.text, 12), "Belum ada mekanisme penanganan yang terstruktur dan terdokumentasi"])
        : numbered([shortLabel(s.text, 12), "Kebutuhan anggota dan perkembangan lingkungan mendukung"]),
      indikator: threat ? INDIKATOR[kategori] : "Jumlah peluang yang berhasil dimanfaatkan (kerja sama, peserta, atau dana)",
      faktorPositif: numbered([kekuatan ? shortLabel(kekuatan, 12) : "Adanya struktur kepengurusan dan PIC program", "Adanya rapat evaluasi rutin pengurus"]),
      dampakKualitatif: threat
        ? numbered([s.konsekuensi ?? "Program kerja terhambat", "Kualitas layanan kepada anggota menurun"])
        : numbered(["Jangkauan dan manfaat program meningkat", "Reputasi organisasi menguat"]),
      p,
      i,
      alasanP: `Mode uji: ${P_SCALE[p].toLowerCase()} — kondisi ${s.refs[0] ?? "ini"} muncul di dokumen/analisis sebelumnya.`,
      alasanI: `Mode uji: dampak ${I_SCALE[i].label.toLowerCase()} — ${I_SCALE[i].arti.toLowerCase()}.`,
      strategi,
      justifikasi: "",
      penanganan: threat
        ? s.kep
          ? `Menjalankan keputusan ${s.kep.id} (${lowerFirst(s.kep.text)})${step ? ` melalui tahap ${step.id} (${step.aksi})` : ""} serta memantau indikator risiko setiap bulan`
          : "Menyusun SOP penanganan dan memantau indikator risiko setiap bulan"
        : "Menyusun rencana pemanfaatan peluang (PIC, jadwal, target) dan menjalin kerja sama dengan pihak terkait",
      penangananSaatIni: threat ? "Ditangani secara insidental dalam rapat pengurus; belum ada mekanisme baku" : "Belum dimanfaatkan secara terencana",
      refs: [...s.refs, ...(step ? [step.id] : [])],
      evidence: s.evidence,
    };
  });
  return { risks };
}

// ---------- Validator ----------

const CHECKS: CheckSpec[] = [
  { name: "skala_pi", kind: "code", description: "Probabilitas (P) dan Dampak (I) terisi bilangan bulat 1–5" },
  { name: "kelengkapan", kind: "code", description: "Setiap risiko punya ID unik, unit kerja, deskripsi, akar penyebab, indikator risiko, dan rencana penanganan" },
  {
    name: "strategi_sesuai_rating",
    kind: "code",
    description: "Risiko MODERATE/MAJOR tidak diberi strategi Accept tanpa justifikasi (legenda Excel: moderate perlu rencana respons, major perlu respons segera)",
  },
  { name: "strategi_sesuai_jenis", kind: "code", description: "Strategi cocok dengan jenis: ancaman → Avoid/Mitigate/Transfer/Accept, peluang → Exploit/Enhance/Share/Accept" },
  { name: "unit_kerja", kind: "code", description: "Unit kerja sesuai struktur organisasi (disebut di dokumen atau di daftar jabatan stakeholder internal)" },
  { name: "grounded", kind: "code", description: "Setiap risiko punya kutipan dokumen atau rujukan ke analisis sebelumnya (kondisi, keputusan, tahap perubahan, faktor)" },
  { name: "quote_exists", kind: "code", description: "Kutipan bukti benar-benar ada di potongan dokumen yang dirujuk" },
  { name: "ref_exists", kind: "code", description: "Rujukan ID (KD…, DM…, CM…, W…, T…, O…) ada di hasil analisis sebelumnya" },
  { name: "label_peluang_ancaman", kind: "llm", description: "Label Peluang (Opportunity) atau Ancaman (Threat) sesuai isi risiko" },
];

function codeChecks(o: RiskComputed, ctx: NodeContext) {
  const pi: Failure[] = [];
  const lengkap: Failure[] = [];
  const rating: Failure[] = [];
  const jenis: Failure[] = [];
  const unit: Failure[] = [];
  const seen = new Set<string>();
  const jabatan = stakeholderRoles(ctx.inputs).map((r) => r.jabatan);
  if (!o.rows.length) lengkap.push({ check: "kelengkapan", message: "Register risiko masih kosong." });
  for (const r of o.rows) {
    for (const [k, v] of [
      ["P", r.p],
      ["I", r.i],
    ] as const)
      if (!isScale(v))
        pi.push({
          check: "skala_pi",
          itemId: r.id,
          message:
            v === null || v === undefined
              ? `${r.id}: ${k} kosong — Excel menghitungnya 0 sehingga skor ${r.score} dan rating ${r.rating}. Isi ${k} dengan 1–5.`
              : `${r.id}: ${k} = ${num(v, 2, true)} di luar skala; isi bilangan bulat 1–5.`,
        });
    if (seen.has(r.id)) lengkap.push({ check: "kelengkapan", itemId: r.id, message: `ID ${r.id} dipakai lebih dari sekali.` });
    seen.add(r.id);
    const empty = (
      [
        ["unit kerja", r.unitKerja],
        ["deskripsi risiko", r.deskripsi],
        ["akar penyebab", r.akarPenyebab],
        ["indikator risiko", r.indikator],
        ["penanganan risiko (risk treatment)", r.penanganan],
      ] as const
    ).filter(([, v]) => !(v ?? "").trim());
    if (empty.length) lengkap.push({ check: "kelengkapan", itemId: r.id, message: `${r.id}: ${empty.map(([n]) => n).join(", ")} wajib diisi.` });
    if (r.strategi === "Accept" && r.rating !== "MINOR" && !r.justifikasi?.trim()) {
      const msg =
        r.jenis === "Threat"
          ? r.rating === "MAJOR"
            ? `${r.id}: ancaman MAJOR (skor ${r.score}) diberi strategi Accept tanpa justifikasi. Legenda Excel: risiko ekstrem perlu perhatian dan respons segera — pilih Avoid/Mitigate/Transfer atau tulis justifikasi.`
            : `${r.id}: ancaman MODERATE (skor ${r.score}) diberi strategi Accept tanpa justifikasi. Legenda Excel: risiko moderat perlu disusun rencana respons — pilih Mitigate/Transfer/Avoid atau tulis justifikasi.`
          : `${r.id}: peluang ${r.rating} (skor ${r.score}) hanya di-Accept tanpa justifikasi; peluang sebesar ini sebaiknya dikejar (Exploit/Enhance/Share) atau beri justifikasi.`;
      rating.push({ check: "strategi_sesuai_rating", itemId: r.id, message: msg });
    }
    const allowed: readonly string[] = r.jenis === "Threat" ? STRATEGI_ANCAMAN : STRATEGI_PELUANG;
    if (!allowed.includes(r.strategi))
      jenis.push({
        check: "strategi_sesuai_jenis",
        itemId: r.id,
        message:
          r.jenis === "Threat"
            ? `${r.id}: strategi ${r.strategi} untuk peluang, padahal risiko ini ancaman (Threat); pakai Avoid/Mitigate/Transfer/Accept.`
            : `${r.id}: strategi ${r.strategi} (${r.strategi === "Mitigate" ? "mengurangi" : r.strategi === "Avoid" ? "menghindari" : "mengalihkan"}) tidak cocok untuk peluang (Opportunity); pakai Exploit/Enhance/Share/Accept.`,
      });
    const known = unitKnown(r.unitKerja ?? "", { projectName: ctx.projectName, evidence: ctx.evidence, jabatan });
    if (known === false)
      unit.push({
        check: "unit_kerja",
        itemId: r.id,
        message: `${r.id}: unit kerja "${r.unitKerja}" tidak ditemukan di dokumen struktur organisasi maupun daftar jabatan; pakai nama unit (biro/divisi/departemen) yang ada, atau nama organisasi untuk risiko tingkat organisasi.`,
      });
  }
  const up = upstreamIds(ctx.inputs, ["risk_management"]);
  const refFail: Failure[] = o.rows
    .map((r) => ({ r, bad: r.refs.filter((x) => !up.has(x)) }))
    .filter((x) => x.bad.length)
    .map(({ r, bad }) => ({ check: "ref_exists", itemId: r.id, message: `${r.id} merujuk butir analisis sebelumnya yang tidak ada: ${bad.join(", ")}.` }));
  return [
    result("skala_pi", "code", pi),
    result("kelengkapan", "code", lengkap),
    result("strategi_sesuai_rating", "code", rating),
    result("strategi_sesuai_jenis", "code", jenis),
    result("unit_kerja", "code", unit),
    result(
      "grounded",
      "code",
      o.rows
        .filter((r) => !r.evidence.length && !r.refs.length)
        .map((r) => ({ check: "grounded", itemId: r.id, message: `${r.id} tidak punya kutipan dokumen maupun rujukan ke analisis sebelumnya.` })),
    ),
    checkQuotes(
      o.rows.filter((r) => r.evidence.length),
      ctx.evidence,
    ),
    result("ref_exists", "code", refFail),
  ];
}

// ---------- Sheet ----------

const BLUE = "6D9EEB";
const EXTRA = "C9DAF8";
const HEADERS = [
  "Unit Kerja",
  "No.",
  "Status Risiko",
  "Peluang atau Ancaman",
  "Kategori Risiko",
  "Sasaran",
  "Periode Identifikasi Risiko",
  "Deskripsi atau Kejadian Risiko",
  "Akar Penyebab",
  "Indikator Risiko",
  "Faktor Positif / Internal Control Yang Ada Saat Ini",
  "Dampak Kualitatif",
  "Probabilitas (P)",
  "Dampak\n (I)",
  "Skor Risiko Inherent (W)",
  "Inherent Risk Rating",
  "Strategi",
  "Penanganan Risiko\n (Risk Treatment)",
  "Penanganan Yang Telah Dilakukan",
];
const C = { unit: 0, no: 1, status: 2, jenis: 3, kat: 4, sas: 5, per: 6, desk: 7, akar: 8, ind: 9, pos: 10, damp: 11, p: 12, i: 13, w: 14, rat: 15, str: 16, pen: 17, now: 18, jus: 19, dasar: 20 };

function ratingExplain(score: number, rating: RiskRating) {
  return `Rating dari skor ${num(score, 0)}: ≤ 4 → MINOR, 5–14 → MODERATE, ≥ 15 → MAJOR → ${rating}`;
}

function riskSheet(o: RiskComputed): Grid {
  const g = new GridBuilder("rm", "DM-CRMRM", "Risk management");
  g.set(0, 0, "", { cs: 16 }); // A1:P1 digabung dan kosong seperti di Excel
  g.set(0, 16, "EVALUASI DAN RENCANA PENANGANAN RISIKO", { style: "subheader", fill: "FFCC00", center: true, cs: 3 });
  HEADERS.forEach((h, c) => g.set(1, c, h, { style: "header", fill: BLUE, center: true }));
  g.set(1, C.jus, "Justifikasi Strategi", { style: "header", fill: EXTRA, center: true, note: "Tambahan dari aplikasi: wajib bila Accept dipakai untuk risiko MODERATE/MAJOR." });
  g.set(1, C.dasar, "Dasar (rujukan & bukti)", { style: "header", fill: EXTRA, center: true });
  const r0 = 2;
  const text = (r: number, c: number, v: string, path: (string | number)[], extra: Parameters<GridBuilder["set"]>[3] = {}) =>
    g.set(r, c, v, { style: "text", src: "ai", edit: { path, type: "text" }, ...extra });
  o.rows.forEach((x, j) => {
    const r = r0 + j;
    const P = (k: string) => ["risks", x.rawIndex, k];
    text(r, C.unit, x.unitKerja, P("unitKerja"));
    g.set(r, C.no, x.no, { style: "int", src: "hitung", center: true, note: `Nomor urut risiko di ${x.unitKerja} (ID ${x.id}).` });
    g.set(r, C.status, x.status, {
      style: "label",
      src: "ai",
      center: true,
      fill: x.status === "Active" ? "C00000" : "33CC33",
      edit: { path: P("status"), type: "select", options: [...STATUS] },
    });
    g.set(r, C.jenis, x.jenis, { style: "label", src: "ai", center: true, edit: { path: P("jenis"), type: "select", options: [...JENIS] } });
    g.set(r, C.kat, x.kategori, { style: "text", src: "ai", center: true, edit: { path: P("kategori"), type: "select", options: [...KATEGORI] } });
    text(r, C.sas, x.sasaran, P("sasaran"));
    text(r, C.per, x.periode, P("periode"));
    text(r, C.desk, x.deskripsi, P("deskripsi"), {
      refs: x.evidence.map((e) => e.chunkId),
      note: x.evidence.length ? x.evidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join("\n") : undefined,
    });
    text(r, C.akar, x.akarPenyebab, P("akarPenyebab"));
    text(r, C.ind, x.indikator, P("indikator"));
    text(r, C.pos, x.faktorPositif, P("faktorPositif"));
    text(r, C.damp, x.dampakKualitatif, P("dampakKualitatif"));
    g.set(r, C.p, x.p, {
      style: "int",
      src: "ai",
      center: true,
      note: [isScale(x.p) ? `${x.p} = ${P_SCALE[x.p]}` : "", x.alasanP].filter(Boolean).join(" — ") || undefined,
      edit: { path: P("p"), type: "select", options: P_OPTIONS, min: 1, max: 5, step: 1, allowEmpty: true },
    });
    g.set(r, C.i, x.i, {
      style: "int",
      src: "ai",
      center: true,
      note: [isScale(x.i) ? `${x.i} = ${I_SCALE[x.i].label}: ${I_SCALE[x.i].arti}` : "", x.alasanI].filter(Boolean).join(" — ") || undefined,
      edit: { path: P("i"), type: "select", options: I_OPTIONS, min: 1, max: 5, step: 1, allowEmpty: true },
    });
    const pA = addr(r, C.p);
    const iA = addr(r, C.i);
    const wA = addr(r, C.w);
    const blank = x.p === null || x.p === undefined || x.i === null || x.i === undefined;
    g.set(r, C.w, x.score, {
      style: "int",
      src: "hitung",
      center: true,
      f: `${pA}*${iA}`,
      explain: `Skor = Probabilitas × Dampak = ${x.p ?? 0} × ${x.i ?? 0} = ${num(x.score, 0)}${blank ? " (sel kosong dihitung 0, seperti Excel)" : ""}`,
    });
    g.set(r, C.rat, x.rating, {
      style: "label",
      src: "hitung",
      center: true,
      fill: RATING_FILL[x.rating],
      f: `IF(${wA}="","",IF(${wA}<=4,"MINOR",IF(${wA}<=14,"MODERATE","MAJOR")))`,
      explain: ratingExplain(x.score, x.rating),
    });
    g.set(r, C.str, x.strategi, {
      style: "text",
      src: "ai",
      edit: { path: P("strategi"), type: "select", options: [...(x.jenis === "Threat" ? STRATEGI_ANCAMAN : STRATEGI_PELUANG)] },
      note: x.jenis === "Threat" ? "Ancaman: Avoid, Mitigate, Transfer, Accept" : "Peluang: Exploit, Enhance, Share, Accept",
    });
    text(r, C.pen, x.penanganan, P("penanganan"));
    text(r, C.now, x.penangananSaatIni, P("penangananSaatIni"));
    text(r, C.jus, x.justifikasi ?? "", P("justifikasi"), { style: "muted" });
    g.set(r, C.dasar, [x.refs.length ? `Rujukan: ${x.refs.join(", ")}` : "", ...x.evidence.map((e) => `[${e.chunkId}]`)].filter(Boolean).join(" ") || "—", {
      style: "muted",
      refs: x.evidence.map((e) => e.chunkId),
    });
  });
  const rN = r0 + Math.max(o.rows.length, 1) - 1;
  if (!o.rows.length) g.set(r0, 0, "Belum ada risiko.", { style: "note", cs: 8 });
  const col = (c: number) => range(r0, c, rN, c, true);

  // Ringkasan rating (COUNTIF).
  let r = rN + 2;
  g.set(r, 0, "Ringkasan register", { style: "subheader", cs: 3 });
  r++;
  const sum = (label: string, v: number, f: string, explain: string, anchor: string, fill?: string) => {
    g.set(r, 0, label, { style: "label", cs: 2, fill });
    g.set(r, 2, v, { style: "int", src: "hitung", center: true, f, explain });
    g.anchor(anchor, r, 2);
    r++;
  };
  sum("Jumlah risiko", o.counts.total, `COUNTA(${col(C.desk)})`, `Jumlah baris risiko yang terisi = ${o.counts.total}`, "total");
  for (const rt of ["MAJOR", "MODERATE", "MINOR"] as const)
    sum(rt, o.counts[rt], `COUNTIF(${col(C.rat)},"${rt}")`, `Jumlah risiko dengan rating ${rt} = ${o.counts[rt]}`, rt.toLowerCase(), RATING_FILL[rt]);
  sum("Ancaman (Threat)", o.counts.threat, `COUNTIF(${col(C.jenis)},"Threat")`, `Jumlah ancaman = ${o.counts.threat}`, "threat");
  sum("Peluang (Opportunity)", o.counts.opportunity, `COUNTIF(${col(C.jenis)},"Opportunity")`, `Jumlah peluang = ${o.counts.opportunity}`, "opportunity");
  sum("Skor tertinggi", o.maxScore, `MAX(${col(C.w)})`, `Skor risiko inherent tertinggi = ${num(o.maxScore, 0)} (${riskRating(o.maxScore)})`, "skor_maks");

  // Peta risiko (heat map) seperti legenda gambar di tab Excel: baris P 5→1, kolom I 1→5, isi = jumlah risiko (COUNTIFS).
  r++;
  g.set(r, 0, "PETA RISIKO (HEAT MAP) — jumlah risiko per kombinasi Probabilitas × Dampak", { style: "subheader", cs: 7 });
  r++;
  g.set(r, 0, "PROBABILITAS (P) ↓  /  SEVERITY – DAMPAK (I) →", { style: "header", cs: 2, rs: 2 });
  for (let i = 1; i <= 5; i++) {
    g.set(r, 1 + i, `${I_SCALE[i].label} ${i}`, { style: "header", center: true });
    g.set(r + 1, 1 + i, I_SCALE[i].arti, { style: "muted", center: true });
  }
  r += 2;
  for (let p = 5; p >= 1; p--) {
    g.set(r, 0, P_SCALE[p], { style: "text" });
    g.set(r, 1, p, { style: "int", center: true, src: "tetap" });
    for (let i = 1; i <= 5; i++) {
      const n = o.heat[p - 1][i - 1];
      const s = p * i;
      const rt = riskRating(s);
      const ids = o.rows.filter((x) => x.p === p && x.i === i).map((x) => x.id);
      g.set(r, 1 + i, n, {
        style: "int",
        src: "hitung",
        center: true,
        fill: HEAT_FILL[rt],
        display: n ? `${s} · ${n} risiko` : String(s),
        f: `COUNTIFS(${col(C.p)},${p},${col(C.i)},${i})`,
        explain: `Jumlah risiko dengan P = ${p} dan I = ${i} = ${n}. Skor sel = ${p} × ${i} = ${s} (${rt})${ids.length ? `: ${ids.join(", ")}` : ""}`,
      });
    }
    r++;
  }
  r++;
  const legend: [RiskRating, string, string][] = [
    ["MAJOR", "Extreme risk — MAJOR (skor 15–25)", "Perlu perhatian dan respons segera (Immediate attention & response needed)"],
    ["MODERATE", "Moderate risk — MODERATE (skor 5–14)", "Perlu disusun rencana respons (Requires response development)"],
    ["MINOR", "Low risk — MINOR (skor 1–4)", "Cukup diterima secara aktif atau pasif (Requires active or passive acceptance)"],
  ];
  for (const [rt, label, arti] of legend) {
    g.set(r, 0, "", { fill: HEAT_FILL[rt], cs: 2 });
    g.set(r, 2, label, { style: "label", cs: 2 });
    g.set(r, 4, arti, { style: "text", cs: 4 });
    r++;
  }

  return g.build({
    cols: [18, 5, 14, 13, 20, 20, 16, 26, 30, 24, 30, 26, 11, 11, 12, 14, 14, 32, 30, 24, 22],
    freeze: { rows: 2, cols: 2 },
    chart: {
      type: "scatter",
      title: "Peta risiko: Probabilitas (P) × Dampak (I)",
      xLabel: "Dampak (I)",
      yLabel: "Probabilitas (P)",
      max: 5,
      points: o.rows.filter((x) => isScale(x.p) && isScale(x.i)).map((x) => ({ label: x.id, x: x.i!, y: x.p! })),
    },
    notes: [
      "Satu baris = satu risiko di satu unit kerja. Probabilitas (P) dan Dampak (I) bernilai 1–5, diusulkan AI dan bisa Anda ubah; skor dan rating dihitung otomatis.",
      "Skor Risiko Inherent (W) = P × I. Rating: ≤ 4 MINOR (hijau), 5–14 MODERATE (oranye), ≥ 15 MAJOR (merah) — sama dengan rumus Excel.",
      "Peta risiko di bawah register menghitung berapa risiko jatuh di tiap kombinasi P dan I; makin ke kanan-atas makin berbahaya.",
      "Strategi ancaman: Avoid/Mitigate/Transfer/Accept; strategi peluang: Exploit/Enhance/Share/Accept. Accept untuk risiko MODERATE/MAJOR wajib diberi justifikasi.",
    ],
  });
}

// ---------- Ringkasan, butir, dokumen ----------

function summaryOf(o: RiskComputed) {
  if (!o.rows.length) return "Belum ada risiko.";
  const c = o.counts;
  return `${c.total} risiko (${c.threat} ancaman, ${c.opportunity} peluang): ${c.MAJOR} MAJOR, ${c.MODERATE} MODERATE, ${c.MINOR} MINOR; skor tertinggi ${num(o.maxScore, 0)}`;
}

function itemsOf(out: unknown): AnnotItem[] {
  return computeRisk(out).rows.map((r) => ({
    id: r.id,
    text: r.deskripsi,
    detail: `${r.unitKerja} · ${r.jenis} · ${r.kategori} · P ${r.p ?? "–"} × I ${r.i ?? "–"} = ${num(r.score, 0)} (${r.rating}) · ${r.strategi}: ${r.penanganan}`,
  }));
}

function blocksOf(o: RiskComputed): Block[] {
  const c = o.counts;
  return [
    { type: "h2", text: "Evaluasi dan rencana penanganan risiko" },
    { type: "p", text: summaryOf(o) },
    {
      type: "table",
      head: ["ID", "Unit kerja", "Risiko", "Jenis", "P × I = W", "Rating", "Strategi & penanganan"],
      rows: o.rows.map((r) => [
        r.id,
        r.unitKerja,
        r.deskripsi,
        r.jenis === "Threat" ? "Ancaman" : "Peluang",
        `${r.p ?? 0} × ${r.i ?? 0} = ${num(r.score, 0)}`,
        r.rating,
        `${r.strategi}: ${r.penanganan}`,
      ]),
      widths: [6, 14, 28, 9, 10, 10, 23],
    },
    {
      type: "bullets",
      items: [
        `MAJOR (skor ≥ 15): ${c.MAJOR} risiko — perlu respons segera.`,
        `MODERATE (skor 5–14): ${c.MODERATE} risiko — perlu rencana respons.`,
        `MINOR (skor ≤ 4): ${c.MINOR} risiko — cukup diterima dan dipantau.`,
      ],
    },
  ];
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Skor Risiko Inherent (W)",
    rumus: "W = Probabilitas (P) × Dampak (I)",
    arti: "Semakin mungkin terjadi dan semakin besar dampaknya, semakin tinggi skornya (1–25). Sel P/I kosong dihitung 0, seperti Excel.",
    excel: "=M3*N3",
  },
  {
    name: "Inherent Risk Rating",
    rumus: "W ≤ 4 → MINOR; 5 ≤ W ≤ 14 → MODERATE; W ≥ 15 → MAJOR",
    arti: "Golongan risiko untuk menentukan respons: MINOR cukup diterima, MODERATE perlu rencana respons, MAJOR perlu respons segera.",
    excel: '=IF(O3="", "", IF(O3<=4, "MINOR", IF(O3<=14, "MODERATE", "MAJOR")))',
  },
  {
    name: "Peta risiko (heat map)",
    rumus: "Isi sel = jumlah risiko dengan P = p dan I = i",
    arti: "Menunjukkan sebaran risiko; warna sel mengikuti rating skor p × i.",
    excel: "=COUNTIFS($M$3:$M$14,5,$N$3:$N$14,1)",
  },
  {
    name: "Jumlah per rating",
    rumus: "Jumlah = banyaknya baris dengan rating tertentu",
    arti: "Ringkasan berapa risiko MAJOR, MODERATE, dan MINOR.",
    excel: '=COUNTIF($P$3:$P$14,"MAJOR")',
  },
];

// ---------- Definisi node ----------

export const riskManagement: NodeDef<RiskOutput> = {
  key: "risk_management",
  label: "Risk management",
  phase: 2,
  group: "dmcrm",
  sheetName: "DM-CRMRM",
  deps: [],
  kind: "llm",
  description:
    "Register risiko per unit kerja: penyebab, indikator, kontrol yang ada, probabilitas × dampak (skor & rating seperti Excel), strategi, dan rencana penanganan, dengan peta risiko.",
  computedBy: "LLM (isi, usulan P & I) + kode (skor W = P × I, rating, peta risiko)",
  schema: RiskOutput,
  checks: CHECKS,
  queries: () => [
    { focus: "struktur unit kerja", text: "struktur organisasi biro divisi departemen kementerian unit kerja wewenang", k: 5 },
    { focus: "risiko", text: "risiko kendala hambatan keterlambatan masalah gagal terhambat", k: 6 },
    { focus: "keuangan", text: "keuangan anggaran dana kas pertanggungjawaban laporan", k: 3 },
    { focus: "administrasi & data", text: "administrasi surat arsip dokumen data akun aset digital", k: 3 },
    { focus: "peluang", text: "peluang kerja sama mitra hibah digitalisasi tertarik bersedia", k: 4 },
    { focus: "kontrol yang ada", text: "SOP pengawasan monitoring evaluasi PIC template mekanisme yang sudah berjalan", k: 4 },
  ],
  extraChunkIds: (ctx) =>
    citedChunkIds([(ctx.inputs.decision_making as { kondisi?: unknown } | undefined)?.kondisi, rankedFactors(ctx.inputs, ["T", "O"]).slice(0, 6)], 14),
  prompt: (ctx) => {
    const dec = ctx.inputs.decision_making ? computeDecision(ctx.inputs.decision_making) : null;
    const ch = ctx.inputs.change_management ? computeChange(ctx.inputs.change_management, dec) : null;
    const roles = stakeholderRoles(ctx.inputs);
    const units = unitsFromText(docChunks(ctx.evidence).map((d) => d.content), 10);
    const skip = (ctx.parents ?? []).filter((p) => p !== "decision_making" && p !== "change_management");
    const sections = upstreamSections(ctx.inputs, { quadrants: ["S", "W", "O", "T"], skip, perFactor: 5 });
    const decText = dec
      ? `## Decision making\n${[...dec.kondisi, ...dec.konsekuensi, ...dec.keputusan].map((x) => `${x.id}: ${x.text}`).join("\n")}`
      : "";
    const chText = ch?.steps.some((s) => s.rawIndex !== null)
      ? `## Change management (Kotter)\n${ch.steps
          .filter((s) => s.rawIndex !== null)
          .map((s) => `${s.id} ${s.tahap}: ${s.aksi} (keputusan ${s.keputusanRefs.join(", ") || "–"})`)
          .join("\n")}`
      : "";
    return {
      system: `Kamu analis manajemen risiko organisasi mahasiswa. Susun register "EVALUASI DAN RENCANA PENANGANAN RISIKO" (tab DM-CRMRM).

Aturan:
1. Tulis 6–15 risiko dengan ID RM1, RM2, …; kelompokkan per unit kerja (2–4 risiko per unit). unitKerja = nama unit di struktur organisasi (biro/divisi/departemen/kementerian) yang disebut di dokumen; untuk risiko tingkat organisasi boleh memakai nama organisasi.
2. status: "Active" (risiko masih berlaku) atau "Retired" (sudah tidak relevan).
3. jenis: "Threat" bila kejadian itu MERUGIKAN sasaran; "Opportunity" bila kejadian itu MENGUNTUNGKAN sasaran bila dimanfaatkan. Sertakan minimal satu peluang bila ada dasarnya.
4. kategori: salah satu dari ${KATEGORI.map((k) => `"${k}"`).join(", ")}.
5. sasaran: sasaran unit/organisasi yang terdampak; periode: periode identifikasi risiko (mis. "TRIWULAN 1–4").
6. deskripsi: kejadian risiko. akarPenyebab: daftar bernomor "1. …\\n2. …" (2–3 butir). indikator: ukuran yang menunjukkan risiko sedang terjadi. faktorPositif: kontrol/faktor positif yang SUDAH ada (daftar bernomor). dampakKualitatif: daftar bernomor dampak bila terjadi.
7. p (probabilitas) dan i (dampak): bilangan bulat 1–5.
   Probabilitas: ${[1, 2, 3, 4, 5].map((v) => `${v} = ${P_SCALE[v]}`).join("; ")}.
   Dampak: ${[1, 2, 3, 4, 5].map((v) => `${v} = ${I_SCALE[v].label} (${I_SCALE[v].arti})`).join("; ")}.
   alasanP dan alasanI: alasan singkat berdasarkan bukti. JANGAN menulis skor atau rating — kode menghitung W = P × I dan rating (≤ 4 MINOR, 5–14 MODERATE, ≥ 15 MAJOR).
8. strategi: untuk Threat pilih Avoid (hindari/hentikan kegiatan berisiko), Mitigate (kurangi P atau I), Transfer (alihkan ke pihak lain), atau Accept (terima). Untuk Opportunity pilih Exploit (pastikan terjadi), Enhance (perbesar peluang/manfaat), Share (bagi dengan mitra), atau Accept. Risiko MODERATE/MAJOR tidak boleh Accept kecuali diberi justifikasi.
9. penanganan: rencana risk treatment yang konkret — sebaiknya menjalankan keputusan (DM…) dan tahap perubahan (CM…) yang ada. penangananSaatIni: penanganan yang sudah dilakukan.
10. refs: ID butir analisis sebelumnya yang terkait (KD…, KQ…, DM…, CM…, W…, T…, O…). Jangan mengarang ID.
11. Bukti: ${EVIDENCE_RULES}
    Setiap risiko minimal punya kutipan dokumen ATAU refs. Jangan mengarang fakta.
${JSON_ONLY}`,
      user: `${orgLine(ctx)}

Unit kerja yang disebut di dokumen: ${units.length ? units.join(", ") : "(tidak terdeteksi — baca struktur di potongan dokumen)"}
${roles.length ? `Jabatan (stakeholder internal): ${roles.map((r) => r.jabatan).join(", ")}\n` : ""}
Hasil analisis sebelumnya:
${[decText, chText, ...sections].filter(Boolean).join("\n\n") || "(belum ada)"}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(RiskOutput)}`,
    };
  },
  mock: mockRisk,
  validate: async (out, ctx, llm) => {
    const o = computeRisk(out);
    return [
      ...codeChecks(o, ctx),
      await llmJudge(
        llm,
        "label_peluang_ancaman",
        'Periksa label setiap risiko: "Threat" (ancaman) = kejadian yang bila terjadi MERUGIKAN sasaran; "Opportunity" (peluang) = kejadian yang bila dimanfaatkan MENGUNTUNGKAN sasaran. ok=false bila labelnya terbalik.',
        o.rows.map((r) => ({ id: r.id, text: `[${r.jenis}] ${r.deskripsi} | sasaran: ${r.sasaran} | dampak: ${r.dampakKualitatif.replace(/\n/g, "; ")}` })),
        orgLine(ctx),
        (id) => {
          const r = o.rows.find((x) => x.id === id);
          if (!r) return true;
          if (r.jenis === "Opportunity") return /peluang|kesempatan|potensi|tersedia/i.test(r.deskripsi) || !isNegative(r.deskripsi);
          return !/^(peluang|kesempatan)\b/i.test(r.deskripsi.trim());
        },
      ),
    ];
  },
  repairHint: "Perbaiki hanya risiko yang ditolak; risiko lain (termasuk P dan I) salin apa adanya.",
  compute: (out): RiskManagementComputed => computeRisk(out),
  items: itemsOf,
  sheets: (out: unknown) => [riskSheet(computeRisk(out))],
  blocks: (out: unknown) => blocksOf(computeRisk(out)),
  formulas: FORMULAS,
  summary: (out) => summaryOf(computeRisk(out)),
};
