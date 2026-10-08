// Change management (tab DM-CRMCM, "GAGASAN PERUBAHAN"): 8 langkah perubahan Kotter — No | Tahapan | Deskripsi | Aksi.
// Setiap tahap merujuk keputusan (DM…) dari Decision making yang dijalankannya; kode memeriksa kelengkapan 8 tahap dan
// bahwa setiap keputusan punya tahap pelaksana (kolom COUNTIF di sheet).
import { z } from "zod";
import { Evidence } from "../schemas";
import type { AnnotItem, CheckSpec, Failure, NodeContext, NodeDef, SheetContext } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { checkQuotes, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, addr, num, range, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { computeDecision, type DecisionComputed } from "./decision";
import { arr, lowerFirst, shortLabel, stakeholderRoles } from "./common";
import type { ChangeManagementComputed } from "../contracts";

// ---------- Metode Kotter (urutan dan nama persis seperti tab Excel) ----------

export const KOTTER = [
  { tahap: "Increase Urgency", arti: "Menumbuhkan rasa mendesak: tunjukkan mengapa perubahan harus dilakukan sekarang dan apa akibatnya bila tidak." },
  { tahap: "Build the Guiding Team", arti: "Membentuk tim penggerak perubahan yang punya wewenang, kapasitas, dan dipercaya anggota." },
  { tahap: "Get the Right Vision", arti: "Merumuskan visi dan strategi perubahan yang jelas, lalu menerjemahkannya menjadi rencana kerja." },
  { tahap: "Communicate for Buy-In", arti: "Mengomunikasikan visi dan alasan perubahan agar sebanyak mungkin orang memahami dan mendukung." },
  { tahap: "Empower Action", arti: "Menghilangkan hambatan dan memberi ruang bagi orang untuk bertindak serta menyampaikan masukan." },
  { tahap: "Create Short-Term Wins", arti: "Menetapkan target jangka pendek yang terukur, mencapainya, dan memberi apresiasi." },
  { tahap: "Don't Let Up", arti: "Menjaga momentum: evaluasi dan penyempurnaan berkala, jangan berhenti terlalu cepat." },
  { tahap: "Make it Stick", arti: "Melembagakan perubahan ke dalam budaya, SOP, dan sistem kerja agar diteruskan kepengurusan berikutnya." },
] as const;
export type KotterName = (typeof KOTTER)[number]["tahap"];
const KOTTER_NAMES = KOTTER.map((k) => k.tahap) as [KotterName, ...KotterName[]];

// ---------- Skema output mentah (AI) ----------

const Tahap = z.object({
  /** Nama tahap Kotter persis (urutan 1–8). */
  tahap: z.enum(KOTTER_NAMES),
  /** Apa yang dilakukan (rencana/strategi), 2–4 kalimat. */
  deskripsi: z.string(),
  /** Nama aksi/kegiatan singkat. */
  aksi: z.string(),
  /** ID keputusan Decision making (DM…) yang dijalankan tahap ini. */
  keputusanRefs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});
export const ChangeOutput = z.object({ tahapan: z.array(Tahap) });
export type ChangeOutput = z.infer<typeof ChangeOutput>;

// ---------- Hasil hitungan ----------

export type ChangeStep = {
  /** "CM1" … "CM8" = nomor tahap Kotter. */
  id: string;
  no: number;
  tahap: KotterName;
  arti: string;
  deskripsi: string;
  aksi: string;
  keputusanRefs: string[];
  evidence: Evidence[];
  /** Indeks di output mentah (untuk path edit); null = tahap belum diisi AI. */
  rawIndex: number | null;
};
export type ChangeKeputusan = {
  id: string;
  text: string;
  /** Tahap (CM…) yang merujuk keputusan ini secara persis. */
  tahap: string[];
  /** Jumlah tahap yang kolom keputusannya memuat ID ini (sama dengan COUNTIF(…,"*ID*") di Excel). */
  jumlah: number;
};
export type ChangeComputed = ChangeOutput & {
  steps: ChangeStep[];
  keputusan: ChangeKeputusan[];
  /** Keputusan yang belum dirujuk tahap mana pun (rujukan persis). */
  belumDijalankan: string[];
  /** Bagian keputusan yang punya ≥ 1 tahap (0–1), rumus COUNTIF/COUNTA. */
  cakupan: number;
  /** Tahap Kotter yang belum diisi dan yang diisi lebih dari sekali. */
  hilang: KotterName[];
  duplikat: KotterName[];
};

const refsText = (refs: string[]) => refs.join(", ");
/** Semantik COUNTIF(range,"*id*"): sel memuat id (tanpa beda huruf besar/kecil). */
const containsId = (cell: string, id: string) => cell.toLowerCase().includes(id.toLowerCase());

/** Keputusan dari output Decision making (mentah atau sudah dihitung). */
export function decisionOf(inputs: Partial<Record<string, unknown>>): DecisionComputed | null {
  const d = inputs.decision_making;
  return d && typeof d === "object" ? computeDecision(d) : null;
}

/** Kalkulator: urutkan ke 8 tahap Kotter, hubungkan ke keputusan, hitung cakupan. Murni, tidak melempar galat. */
export function computeChange(raw: unknown, decision: DecisionComputed | null): ChangeComputed {
  const tahapan = arr<ChangeOutput["tahapan"][number]>((raw as Partial<ChangeOutput> | null)?.tahapan).filter((t) => t && typeof t === "object");
  const first = new Map<string, number>();
  const duplikat: KotterName[] = [];
  tahapan.forEach((t, i) => {
    if (first.has(t.tahap)) {
      if (!duplikat.includes(t.tahap)) duplikat.push(t.tahap);
    } else first.set(t.tahap, i);
  });
  const steps: ChangeStep[] = KOTTER.map((k, j) => {
    const idx = first.get(k.tahap);
    const t = idx !== undefined ? tahapan[idx] : undefined;
    return {
      id: `CM${j + 1}`,
      no: j + 1,
      tahap: k.tahap,
      arti: k.arti,
      deskripsi: t?.deskripsi ?? "",
      aksi: t?.aksi ?? "",
      keputusanRefs: arr<string>(t?.keputusanRefs),
      evidence: arr<Evidence>(t?.evidence),
      rawIndex: idx ?? null,
    };
  });
  const keputusan: ChangeKeputusan[] = (decision?.keputusan ?? []).map((d) => ({
    id: d.id,
    text: d.text,
    tahap: steps.filter((s) => s.keputusanRefs.includes(d.id)).map((s) => s.id),
    jumlah: steps.filter((s) => containsId(refsText(s.keputusanRefs), d.id)).length,
  }));
  const covered = keputusan.filter((k) => k.jumlah > 0).length;
  return {
    tahapan,
    steps,
    keputusan,
    belumDijalankan: keputusan.filter((k) => !k.tahap.length).map((k) => k.id),
    cakupan: keputusan.length ? covered / keputusan.length : 0,
    hilang: KOTTER.filter((k) => !first.has(k.tahap)).map((k) => k.tahap),
    duplikat,
  };
}

/** Output tersimpan (sudah dihitung) atau hitung ulang dari mentah tanpa data hulu. */
function asComputed(out: unknown, ctx?: { inputs: Partial<Record<string, unknown>> }): ChangeComputed {
  if (ctx) return computeChange(out, decisionOf(ctx.inputs));
  const o = out as Partial<ChangeComputed> | null;
  if (o && Array.isArray(o.steps) && Array.isArray(o.keputusan)) return o as ChangeComputed;
  return computeChange(out, null);
}

// ---------- Mock (tanpa LLM) ----------

function mockChange(ctx: NodeContext): ChangeOutput {
  const dec = decisionOf(ctx.inputs);
  const ks = dec?.keputusan ?? [];
  const ids = ks.map((k) => k.id);
  const org = ctx.projectName;
  const kondisi = (dec?.kondisi ?? []).slice(0, 3).map((k) => lowerFirst(shortLabel(k.text, 8)));
  const kondisiText = kondisi.length ? kondisi.join("; ") : "kinerja dan tata kelola yang belum optimal";
  const goal = dec?.goals[0]?.text ?? `tata kelola ${org} yang terstruktur dan efektif`;
  const roles = stakeholderRoles(ctx.inputs)
    .filter((r) => r.group === "KP" || r.group === "KS")
    .sort((a, b) => (b.bobotTotal ?? 0) - (a.bobotTotal ?? 0))
    .map((r) => r.jabatan);
  const tim = roles.length ? roles.slice(0, 3).join(", ") : "pengurus inti";
  const kepList = ks.length ? ks.map((k) => `${k.id} ${lowerFirst(k.text)}`).join("; ") : "rencana perbaikan prioritas";
  const half = Math.max(1, Math.ceil(ids.length / 2));
  const first = ks[0] ? lowerFirst(ks[0].text) : "keputusan prioritas";
  const rows: [KotterName, string, string, string[]][] = [
    [
      "Increase Urgency",
      `Menyampaikan hasil evaluasi kondisi ${org} kepada seluruh pengurus (${kondisiText}) beserta dampaknya bila tidak segera ditangani, untuk membangun rasa mendesak akan perubahan.`,
      "Sosialisasi urgensi perubahan",
      ids,
    ],
    [
      "Build the Guiding Team",
      `Membentuk tim penggerak perubahan yang terdiri dari ${tim} dan perangkat yang memahami permasalahan, bertugas menentukan prioritas dan mengawal ${ids.length || "seluruh"} keputusan perubahan.`,
      "Pembentukan tim penggerak perubahan",
      ids,
    ],
    [
      "Get the Right Vision",
      `Merumuskan visi perubahan menuju ${lowerFirst(goal.replace(/\.$/, ""))}, lalu menerjemahkannya menjadi rencana kerja: ${kepList}.`,
      "Perumusan visi dan peta jalan perubahan",
      ids,
    ],
    [
      "Communicate for Buy-In",
      "Mengomunikasikan visi, alasan, dan manfaat perubahan secara terbuka dan bertahap melalui forum pengurus dan kanal komunikasi internal, termasuk peran setiap jabatan dalam perubahan.",
      "Komunikasi visi perubahan",
      ids,
    ],
    [
      "Empower Action",
      `Membuka ruang aspirasi dan masukan pengurus serta menghilangkan hambatan pelaksanaan, dimulai dari ${first}.`,
      "Ruang masukan dan penghapusan hambatan",
      ids.slice(0, half),
    ],
    [
      "Create Short-Term Wins",
      "Menetapkan target jangka pendek yang terukur untuk setiap keputusan (mis. tersusunnya SOP prioritas atau berjalannya monitoring bulan pertama) dan memberi apresiasi kepada pengurus yang mencapainya.",
      "Penetapan indikator capaian jangka pendek",
      ids.slice(half).length ? ids.slice(half) : ids,
    ],
    [
      "Don't Let Up",
      "Mengevaluasi capaian perubahan secara berkala (setiap bulan) memakai hasil monitoring dan masukan pengurus, lalu menyempurnakan sistem yang sudah diterapkan.",
      "Evaluasi berkala",
      ids,
    ],
    [
      "Make it Stick",
      "Melembagakan sistem baru ke dalam SOP, budaya kerja, dan dokumen serah terima agar diteruskan kepengurusan berikutnya.",
      "Integrasi perubahan ke sistem organisasi",
      ids,
    ],
  ];
  return { tahapan: rows.map(([tahap, deskripsi, aksi, keputusanRefs]) => ({ tahap, deskripsi, aksi, keputusanRefs, evidence: [] })) };
}

// ---------- Validator ----------

const CHECKS: CheckSpec[] = [
  {
    name: "kotter_lengkap",
    kind: "code",
    description: "Kedelapan tahap Kotter (Increase Urgency … Make it Stick) terisi tepat sekali, masing-masing dengan deskripsi dan aksi",
  },
  { name: "ref_exists", kind: "code", description: "Rujukan keputusan (DM…) ada di hasil Decision making" },
  { name: "keputusan_tercakup", kind: "code", description: "Setiap keputusan dari Decision making dijalankan minimal oleh satu tahap perubahan" },
  { name: "quote_exists", kind: "code", description: "Kutipan bukti (bila ada) benar-benar ada di potongan dokumen yang dirujuk" },
  {
    name: "sesuai_tahap",
    kind: "llm",
    description: "Deskripsi dan aksi sesuai makna tahap Kotter-nya dan benar-benar menjalankan keputusan yang dirujuk",
  },
];

// ---------- Sheet ----------

const ORANGE = "FF9900";
const EXTRA = "FCE5CD";

function changeSheet(o: ChangeComputed): Grid {
  const g = new GridBuilder("cm", "DM-CRMCM", "Change management (Kotter)");
  g.set(0, 0, "GAGASAN PERUBAHAN", { style: "header", fill: ORANGE, center: true, cs: 4 });
  g.row(1, 0, ["No.", "Tahapan (based on Kotter)", "Deskripsi (Apa yang dilakukan, bisa rencana, strategi apapun)", "Aksi Yang Dilakukan"], {
    style: "header",
    fill: ORANGE,
    center: true,
  });
  g.set(1, 4, "Keputusan yang dijalankan", { style: "header", fill: EXTRA, center: true, note: "Tambahan dari aplikasi: ID keputusan (Decision making) yang diwujudkan tahap ini." });
  g.set(1, 5, "Bukti", { style: "header", fill: EXTRA, center: true });
  const kepText = new Map(o.keputusan.map((k) => [k.id, k.text]));
  const r0 = 2;
  o.steps.forEach((s, j) => {
    const r = r0 + j;
    g.set(r, 0, s.no, { style: "int", src: "tetap", center: true });
    g.set(r, 1, s.tahap, { style: "label", src: "tetap", note: s.arti });
    if (s.rawIndex === null) {
      g.set(r, 2, "(tahap ini belum diisi)", { style: "muted", fill: "FAD7D7" });
      g.set(r, 3, "", { style: "muted" });
    } else {
      g.set(r, 2, s.deskripsi, { style: "text", src: "ai", edit: { path: ["tahapan", s.rawIndex, "deskripsi"], type: "text" } });
      g.set(r, 3, s.aksi, { style: "text", src: "ai", edit: { path: ["tahapan", s.rawIndex, "aksi"], type: "text" } });
    }
    g.set(r, 4, refsText(s.keputusanRefs), {
      style: "muted",
      src: s.rawIndex === null ? undefined : "ai",
      note: s.keputusanRefs.map((id) => `${id}: ${kepText.get(id) ?? "(tidak ada di Decision making)"}`).join("\n") || undefined,
    });
    g.set(r, 5, s.evidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join("\n"), { style: "muted", refs: s.evidence.map((e) => e.chunkId) });
  });
  const rN = r0 + o.steps.length - 1;
  const refRange = range(r0, 4, rN, 4, true);

  // Keterkaitan keputusan → tahap (COUNTIF).
  let r = rN + 2;
  g.set(r, 0, "Keputusan (Decision making) yang dijalankan", { style: "subheader", cs: 4 });
  r++;
  g.row(r, 0, ["ID", "Jumlah tahap", "Keputusan", "Tahap yang menjalankan"], { style: "header" });
  r++;
  const k0 = r;
  for (const k of o.keputusan) {
    g.set(r, 0, k.id, { style: "label" });
    g.set(r, 1, k.jumlah, {
      style: "int",
      src: "hitung",
      center: true,
      f: `COUNTIF(${refRange},"*"&${addr(r, 0)}&"*")`,
      explain: `Jumlah tahap yang kolom "Keputusan yang dijalankan"-nya memuat ${k.id} = ${k.jumlah}${k.jumlah ? "" : " → keputusan ini belum dijalankan tahap mana pun"}`,
      fill: k.jumlah ? undefined : "FAD7D7",
    });
    g.set(r, 2, k.text, { style: "text" });
    g.set(r, 3, k.tahap.join(", ") || "—", { style: "muted" });
    r++;
  }
  if (!o.keputusan.length) {
    g.set(r, 0, "Hasil Decision making belum tersedia — keputusan tidak bisa dicocokkan.", { style: "note", cs: 4 });
    r++;
  } else {
    const kN = r - 1;
    const covered = o.keputusan.filter((k) => k.jumlah > 0).length;
    g.set(r, 0, "Cakupan keputusan", { style: "total" });
    g.set(r, 1, o.cakupan, {
      style: "total",
      fmt: "0%",
      src: "hitung",
      center: true,
      f: `IF(COUNTA(${range(k0, 0, kN, 0)})=0,0,COUNTIF(${range(k0, 1, kN, 1)},">0")/COUNTA(${range(k0, 0, kN, 0)}))`,
      explain: `Cakupan = keputusan yang punya ≥ 1 tahap ÷ jumlah keputusan = ${covered} ÷ ${o.keputusan.length} = ${num(o.cakupan * 100, 0)}%`,
    });
    g.anchor("cakupan", r, 1);
    g.set(r, 2, o.belumDijalankan.length ? `Belum dijalankan: ${o.belumDijalankan.join(", ")}` : "Semua keputusan sudah punya tahap pelaksana.", {
      style: "note",
      cs: 2,
      fill: o.belumDijalankan.length ? "FAD7D7" : "D9F2E3",
    });
  }
  return g.build({
    cols: [7, 24, 90, 28, 20, 36],
    freeze: { rows: 2, cols: 2 },
    notes: [
      "Delapan baris = delapan langkah perubahan Kotter, dijalankan berurutan dari menumbuhkan rasa mendesak sampai melembagakan perubahan.",
      "Kolom \"Keputusan yang dijalankan\" menunjukkan keputusan dari Decision making (DM…) yang diwujudkan tahap itu; tabel di bawahnya menghitung berapa tahap yang menjalankan setiap keputusan.",
      "Cakupan 100% berarti setiap keputusan punya minimal satu tahap pelaksana. Deskripsi dan aksi dari AI bisa Anda ubah langsung di tabel.",
    ],
  });
}

// ---------- Ringkasan, butir, dokumen ----------

function summaryOf(o: ChangeComputed) {
  const filled = o.steps.filter((s) => s.rawIndex !== null).length;
  const kep = o.keputusan.length
    ? `${o.keputusan.length - o.belumDijalankan.length}/${o.keputusan.length} keputusan dijalankan (cakupan ${num(o.cakupan * 100, 0)}%)`
    : "keputusan Decision making belum tersedia";
  return `${filled}/8 tahap Kotter terisi; ${kep}`;
}

function itemsOf(out: unknown): AnnotItem[] {
  return asComputed(out)
    .steps.filter((s) => s.rawIndex !== null)
    .map((s) => ({
      id: s.id,
      text: `${s.tahap}: ${s.aksi}`,
      detail: `${s.deskripsi}${s.keputusanRefs.length ? ` · menjalankan: ${s.keputusanRefs.join(", ")}` : ""}`,
    }));
}

function blocksOf(o: ChangeComputed): Block[] {
  const blocks: Block[] = [
    { type: "h2", text: "Change management (Kotter)" },
    { type: "p", text: summaryOf(o) },
    {
      type: "table",
      head: ["No.", "Tahapan", "Deskripsi", "Aksi", "Keputusan"],
      rows: o.steps.map((s) => [String(s.no), s.tahap, s.deskripsi || "(belum diisi)", s.aksi, refsText(s.keputusanRefs) || "–"]),
      widths: [5, 16, 49, 18, 12],
    },
  ];
  if (o.belumDijalankan.length) blocks.push({ type: "note", text: `Keputusan yang belum dijalankan tahap mana pun: ${o.belumDijalankan.join(", ")}.` });
  return blocks;
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Jumlah tahap per keputusan",
    rumus: "Jumlah = banyaknya tahap yang kolom Keputusan-nya memuat ID keputusan",
    arti: "Berapa langkah perubahan yang mewujudkan satu keputusan; 0 berarti keputusan itu belum dijalankan.",
    excel: '=COUNTIF($E$3:$E$10,"*"&A14&"*")',
  },
  {
    name: "Cakupan keputusan",
    rumus: "Cakupan = keputusan dengan ≥ 1 tahap ÷ jumlah keputusan",
    arti: "Persentase keputusan Decision making yang sudah punya tahap pelaksana; harus 100%.",
    excel: '=COUNTIF(B14:B17,">0")/COUNTA(A14:A17)',
  },
];

// ---------- Definisi node ----------

export const changeManagement: NodeDef<ChangeOutput> = {
  key: "change_management",
  label: "Change management (Kotter)",
  phase: 2,
  group: "dmcrm",
  sheetName: "DM-CRMCM",
  deps: ["decision_making"],
  kind: "llm",
  description: "Gagasan perubahan dengan 8 langkah Kotter (deskripsi dan aksi) untuk menjalankan keputusan hasil decision making.",
  computedBy: "LLM (isi tahap) + kode (urutan Kotter, cakupan keputusan)",
  schema: ChangeOutput,
  checks: CHECKS,
  queries: () => [
    { focus: "perubahan & komunikasi", text: "perubahan sosialisasi komunikasi internal forum pengurus penyamaan persepsi", k: 4 },
    { focus: "tim penggerak", text: "pengurus inti kepemimpinan ketua sekretaris kepala biro divisi wewenang", k: 4 },
    { focus: "evaluasi & capaian", text: "evaluasi berkala capaian target program monitoring apresiasi", k: 4 },
    { focus: "pelembagaan", text: "budaya organisasi SOP dokumentasi serah terima regenerasi kepengurusan berikutnya", k: 4 },
  ],
  prompt: (ctx) => {
    const dec = decisionOf(ctx.inputs);
    const roles = stakeholderRoles(ctx.inputs);
    const decText = dec
      ? [
          `Kondisi:\n${dec.kondisi.map((k) => `${k.id}: ${k.text}`).join("\n")}`,
          `Konsekuensi:\n${dec.konsekuensi.map((q) => `${q.id}: ${q.text} (akibat dari ${q.dariKondisi.join(", ") || "–"})`).join("\n")}`,
          `KEPUTUSAN (wajib dijalankan semua):\n${dec.keputusan.map((d) => `${d.id}: ${d.text} (menangani ${d.menangani.join(", ") || "–"})`).join("\n")}`,
          `Goals:\n${dec.goals.map((x) => `${x.id}: ${x.text}`).join("\n")}`,
        ].join("\n\n")
      : "(hasil Decision making belum tersedia)";
    return {
      system: `Kamu konsultan manajemen perubahan organisasi mahasiswa. Susun GAGASAN PERUBAHAN (tab DM-CRMCM) memakai model 8 langkah perubahan Kotter untuk MENJALANKAN keputusan hasil Decision making.

Isi TEPAT 8 baris "tahapan", satu untuk setiap tahap, berurutan, dengan nama tahap persis:
${KOTTER.map((k, i) => `${i + 1}. ${k.tahap} — ${k.arti}`).join("\n")}

Untuk setiap tahap:
- deskripsi: apa yang dilakukan (rencana/strategi) secara konkret untuk organisasi ini, 2–4 kalimat; sebut kondisi dan keputusan yang relevan, siapa pelakunya (jabatan), dan kapan bila ada.
- aksi: nama aksi/kegiatan singkat 3–8 kata, mis. "Sosialisasi urgensi tata kelola", "Evaluasi berkala".
- keputusanRefs: ID keputusan (DM…) yang dijalankan atau didukung tahap ini. SETIAP keputusan wajib muncul di minimal satu tahap; tahap Get the Right Vision, Empower Action, dan Create Short-Term Wins sebaiknya merujuk keputusan secara spesifik. Jangan mengarang ID.
- evidence: kutipan dokumen bila deskripsi memuat fakta (mis. hasil survei atau evaluasi); boleh kosong untuk rencana murni.
Bukti: ${EVIDENCE_RULES}
(Aturan bukti hanya berlaku untuk tahap yang memuat fakta dari dokumen.) Jangan mengarang fakta.
${JSON_ONLY}`,
      user: `${orgLine(ctx)}

Hasil Decision making:
${decText}
${roles.length ? `\nJabatan di organisasi (untuk tim penggerak):\n${roles.map((r) => `${r.id}: ${r.jabatan} (${r.group})`).join("\n")}\n` : ""}
Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(ChangeOutput)}`,
    };
  },
  mock: mockChange,
  validate: async (out, ctx, llm) => {
    const o = computeChange(out, decisionOf(ctx.inputs));
    const known = new Set(o.keputusan.map((k) => k.id));
    const lengkap: Failure[] = [
      ...o.hilang.map((t) => ({ check: "kotter_lengkap", itemId: `CM${KOTTER_NAMES.indexOf(t) + 1}`, message: `Tahap Kotter "${t}" belum diisi.` })),
      ...o.duplikat.map((t) => ({ check: "kotter_lengkap", itemId: `CM${KOTTER_NAMES.indexOf(t) + 1}`, message: `Tahap "${t}" diisi lebih dari sekali; gabungkan menjadi satu baris.` })),
      ...o.steps
        .filter((s) => s.rawIndex !== null && (!s.deskripsi.trim() || !s.aksi.trim()))
        .map((s) => ({ check: "kotter_lengkap", itemId: s.id, message: `${s.id} (${s.tahap}): deskripsi dan aksi wajib diisi.` })),
    ];
    if (!o.duplikat.length && !o.hilang.length) {
      const order = o.tahapan.map((t) => KOTTER_NAMES.indexOf(t.tahap));
      if (order.some((v, i) => i > 0 && v < order[i - 1]))
        lengkap.push({ check: "kotter_lengkap", message: "Urutan tahap tidak sesuai urutan Kotter (Increase Urgency → … → Make it Stick)." });
    }
    const refFail: Failure[] = [];
    if (!o.keputusan.length)
      refFail.push({ check: "ref_exists", message: "Hasil Decision making tidak tersedia, sehingga rujukan keputusan tidak bisa diperiksa." });
    else
      for (const s of o.steps) {
        const bad = s.keputusanRefs.filter((id) => !known.has(id));
        if (bad.length) refFail.push({ check: "ref_exists", itemId: s.id, message: `${s.id} (${s.tahap}) merujuk keputusan yang tidak ada: ${bad.join(", ")}.` });
      }
    return [
      result("kotter_lengkap", "code", lengkap),
      result("ref_exists", "code", refFail),
      result(
        "keputusan_tercakup",
        "code",
        o.belumDijalankan.map((id) => ({
          check: "keputusan_tercakup",
          itemId: id,
          message: `Keputusan ${id} belum dijalankan tahap perubahan mana pun; rujuk ${id} di keputusanRefs tahap yang mewujudkannya.`,
        })),
      ),
      checkQuotes(
        o.steps.filter((s) => s.evidence.length),
        ctx.evidence,
      ),
      await llmJudge(
        llm,
        "sesuai_tahap",
        "Periksa apakah deskripsi dan aksi setiap tahap sesuai makna tahap Kotter-nya (lihat arti tahap) dan benar-benar menjalankan keputusan yang dirujuk.",
        o.steps
          .filter((s) => s.rawIndex !== null)
          .map((s) => ({
            id: s.id,
            text: `Tahap ${s.tahap} (arti: ${s.arti}) | deskripsi: ${s.deskripsi} | aksi: ${s.aksi} | keputusan: ${s.keputusanRefs.map((r) => `${r} = ${o.keputusan.find((k) => k.id === r)?.text ?? "?"}`).join("; ") || "–"}`,
          })),
        orgLine(ctx),
        (id) => (o.steps.find((s) => s.id === id)?.deskripsi.trim().length ?? 0) >= 40,
      ),
    ];
  },
  repairHint: "Perbaiki hanya tahap yang ditolak; tahap lain salin apa adanya. Tetap 8 tahap berurutan dengan nama persis.",
  compute: (out, ctx): ChangeManagementComputed => computeChange(out, decisionOf(ctx.inputs)),
  items: itemsOf,
  sheets: (out: unknown, ctx: SheetContext) => [changeSheet(asComputed(out, ctx.inputs.decision_making ? ctx : undefined))],
  blocks: (out: unknown, ctx: SheetContext) => blocksOf(asComputed(out, ctx.inputs.decision_making ? ctx : undefined)),
  formulas: FORMULAS,
  summary: (out) => summaryOf(asComputed(out)),
};
