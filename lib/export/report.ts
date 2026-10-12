// Laporan kajian (format laporan audit/strategi organisasi): dokumen grand design → blok laporan bernomor.
// Struktur mengikuti laporan kajian LKMM: sampul → daftar isi → BAB I Pendahuluan → BAB II Analisis (per kelompok tab
// Excel) → BAB III Pembahasan dan Rekomendasi → BAB IV Kesimpulan → Daftar Pustaka → Lampiran.
// Bagian yang tidak dihasilkan run (analisis belum dijalankan/gagal, data tidak ada) TIDAK dimunculkan.
// Modul murni (aman di client).
import type { Block, Grid } from "@/lib/sheets/grid";
import type { DocSection, GrandDesignDoc } from "@/lib/grand-design/doc";
import type { CascadingComputed, KontinuitasComputed, PosisiComputed, QspmComputedV2 } from "@/lib/nodes/contracts";
import { NODE_GROUPS } from "@/lib/nodes/groups";
import { appendixBlocks } from "./blocks";

export type ReportBlock =
  | { type: "cover"; title: string; org: string; sub: string; date: string }
  | { type: "toc" }
  | { type: "chapter"; id: string; num: string; title: string }
  | { type: "h2"; id: string; text: string }
  | { type: "h3"; id: string; text: string }
  | { type: "h4"; text: string }
  | { type: "p"; text: string; italic?: boolean }
  | { type: "caption"; text: string }
  | { type: "table"; head: string[]; rows: string[][]; widths?: number[] }
  /** Tabel ala sheet Excel framework (sel gabungan, warna, format angka). */
  | { type: "grid"; grid: Grid }
  | { type: "bullets"; items: string[]; ordered?: boolean }
  | { type: "note"; text: string };

/** Entri daftar isi (bab, subbab, sub-subbab) dalam urutan muncul. */
export type TocEntry = { id: string; level: 1 | 2 | 3; text: string };

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** Pengertian singkat tiap analisis bawaan (metode yang dipakai), ditulis di awal subbab. */
export const DEFINITIONS: Record<string, string> = {
  stakeholder_internal:
    "Stakeholder mapping internal memetakan jabatan di dalam organisasi menurut tingkat pengaruh (power) dan kepentingan (interest) memakai Power–Interest Matrix. Setiap kelompok (Manage Closely, Keep Satisfied, Keep Informed, Monitor) diberi bobot dengan AHP, lalu bobot dibagi ke jabatan di dalamnya.",
  stakeholder_eksternal:
    "Stakeholder mapping eksternal memetakan pihak di luar organisasi yang memengaruhi atau terdampak oleh organisasi, memakai Power–Interest Matrix dan pembobotan AHP yang sama dengan stakeholder internal.",
  faktor_internal:
    "Faktor internal berupa kekuatan (Strength) dan kelemahan (Weakness) diidentifikasi dengan kerangka McKinsey 7S (Strategy, Structure, Systems, Shared Values, Style, Staff, Skills). Bobot faktor dihitung dengan perbandingan berpasangan AHP sehingga jumlah seluruh bobot sama dengan 1.",
  faktor_eksternal:
    "Faktor eksternal berupa peluang (Opportunities) dan ancaman (Threat) dipetakan menurut aspek Politic, Relation, dan Legal (PRL). Bobot faktor dihitung dengan perbandingan berpasangan AHP.",
  ifas: "IFAS (Internal Factor Analysis Summary) mengevaluasi faktor internal: skor setiap faktor adalah bobot dikali rating rata-rata dari penilai stakeholder; total IFAS adalah skor kekuatan dikurangi skor kelemahan.",
  efas: "EFAS (External Factor Analysis Summary) mengevaluasi faktor eksternal dengan cara yang sama: total EFAS adalah skor peluang dikurangi skor ancaman.",
  posisi_organisasi:
    "Matriks posisi organisasi memakai total IFAS sebagai sumbu X dan total EFAS sebagai sumbu Y. Kuadran tempat titik tersebut berada menentukan arah strategi utama (SO, ST, WO, atau WT).",
  swot_matrix:
    "Matriks SWOT (TOWS) menggabungkan faktor internal dan eksternal menjadi alternatif strategi SO (kekuatan untuk meraih peluang), WO (peluang untuk menutup kelemahan), ST (kekuatan untuk menghadapi ancaman), dan WT (meminimalkan kelemahan sekaligus menghindari ancaman).",
  qspm: "QSPM (Quantitative Strategic Planning Matrix) menilai daya tarik relatif tiap alternatif strategi terhadap faktor kunci internal dan eksternal. Strategi dengan total skor daya tarik (TAS) tertinggi menjadi prioritas.",
  cascading:
    "Cascading menurunkan visi menjadi misi, sasaran strategis (strategy objectives), dan inisiatif strategis (strategy initiatives) secara berjenjang, sehingga setiap inisiatif dapat ditelusuri ke strategi terpilih dan visi organisasi.",
  kontinuitas_proker:
    "Analisis kontinuitas program kerja menilai keberlanjutan setiap program kerja dari satu kepengurusan ke berikutnya berdasarkan usaha (effort) dan dampak (impact), lalu memberi rekomendasi: dilanjutkan, diperbaiki, digabung, diganti, atau dihentikan.",
  renstra: "Rencana strategis (renstra) menjabarkan visi dan misi menjadi fokus, tonggak capaian (milestone), arah kerja, indikator, dan target untuk setiap tahun kepengurusan.",
  msdm_attraction: "Attraction merumuskan kebutuhan organisasi, kebutuhan calon pengurus, dan pembeda utama yang membuat organisasi menarik bagi calon pengurus.",
  msdm_recruitment: "Recruitment menyusun posisi yang dibutuhkan, kriteria seleksi, pertanyaan penyaringan, dan alur waktu perekrutan.",
  msdm_onboarding: "Onboarding menyusun rangkaian kegiatan pengenalan agar pengurus baru memahami visi, struktur, sistem kerja, dan budaya organisasi.",
  msdm_development: "Development menyusun tahapan pengembangan kapasitas pengurus selama masa kepengurusan beserta penanggung jawabnya.",
  msdm_penilaian: "Penilaian staf menyusun rubrik penilaian kinerja pengurus berdasarkan nilai utama, atribut, dan indikator perilaku.",
  msdm_retention: "Retention memetakan hal yang perlu dimulai, dipertahankan, ditingkatkan, dikurangi, dan dihentikan untuk menjaga keterlibatan pengurus.",
  msdm_separation: "Separation menyusun survei keterlibatan (engagement survey) dan tindak lanjutnya untuk memahami alasan pengurus bertahan atau keluar.",
  decision_making: "Decision making memetakan kondisi yang dihadapi, konsekuensinya, keputusan yang diambil, dan tujuan yang ingin dicapai dari keputusan tersebut.",
  change_management: "Change management menjalankan keputusan organisasi melalui delapan tahap perubahan Kotter, dari membangun urgensi sampai menanamkan perubahan ke budaya organisasi.",
  risk_management:
    "Risk management mengidentifikasi risiko berupa ancaman maupun peluang, menilai probabilitas dan dampaknya, lalu menetapkan strategi penanganan dan indikator pemantauannya.",
};

/** Pengertian singkat tiap kelompok, ditulis di awal subbab kelompok. */
const GROUP_INTRO: Record<string, string> = {
  es: "Environmental scanning adalah proses mengidentifikasi dan menganalisis kondisi lingkungan internal maupun eksternal organisasi yang dapat memengaruhi pencapaian tujuan. Hasilnya menjadi dasar perumusan strategi yang tepat dan adaptif.",
  sgs: "Strategy generation and selection merumuskan alternatif strategi dari hasil environmental scanning, lalu memilih strategi prioritas secara kuantitatif dan menurunkannya ke visi, misi, dan inisiatif.",
  si: "Strategy implementation menilai program kerja yang ada agar sejalan dengan strategi terpilih.",
  ltv: "Long-term vision menjabarkan arah organisasi untuk beberapa tahun kepengurusan ke depan.",
  dmcrm: "Decision, change, and risk management memastikan keputusan strategis dijalankan melalui proses perubahan yang terkelola dan risikonya diantisipasi.",
  msdm: "Manajemen sumber daya manusia mengatur siklus pengurus, mulai dari menarik calon pengurus sampai pengurus selesai menjabat.",
  custom: "Bagian ini memuat analisis tambahan yang disusun khusus untuk organisasi ini.",
};

/** Referensi metode (hanya yang analisisnya ada di laporan). */
const METHOD_REFS: { when: (keys: Set<string>) => boolean; text: string }[] = [
  {
    when: (k) => ["faktor_internal", "faktor_eksternal", "stakeholder_internal", "stakeholder_eksternal"].some((x) => k.has(x)),
    text: "Saaty, T. L. (1990). How to make a decision: The analytic hierarchy process. European Journal of Operational Research, 48(1), 9–26. https://doi.org/10.1016/0377-2217(90)90057-I",
  },
  {
    when: (k) => k.has("faktor_internal"),
    text: "Waterman, R. H., Peters, T. J., & Phillips, J. R. (1980). Structure is not organization. Business Horizons, 23(3), 14–26. https://doi.org/10.1016/0007-6813(80)90027-0",
  },
  {
    when: (k) => k.has("swot_matrix") || k.has("posisi_organisasi"),
    text: "Weihrich, H. (1982). The TOWS matrix: A tool for situational analysis. Long Range Planning, 15(2), 54–66. https://doi.org/10.1016/0024-6301(82)90120-0",
  },
  {
    when: (k) => k.has("qspm"),
    text: "David, F. R. (1986). The strategic planning matrix: A quantitative approach. Long Range Planning, 19(5), 102–107. https://doi.org/10.1016/0024-6301(86)90015-4",
  },
  { when: (k) => k.has("change_management"), text: "Kotter, J. P. (1996). Leading change. Harvard Business School Press." },
];

const dateText = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("id-ID", { dateStyle: "long" });
  } catch {
    return iso.slice(0, 10);
  }
};
const num = (x: number | null | undefined, d = 3) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d).replace(".", ",") : "–");

/** Kelompok analisis di BAB II, urut laporan kajian. */
const ORDER = ["custom", "es", "sgs", "si", "ltv", "dmcrm", "msdm"] as const;
const isLatarBelakang = (s: DocSection) => s.group === "custom" && /latar\s*belakang/i.test(s.label);

function out<T>(d: GrandDesignDoc, key: string): T | null {
  const s = d.sections.find((x) => x.key === key && x.available);
  return s ? (s.output as T) : null;
}

export function docToReport(d: GrandDesignDoc): { blocks: ReportBlock[]; toc: TocEntry[] } {
  const b: ReportBlock[] = [];
  const toc: TocEntry[] = [];
  let chap = 0;
  let sec = 0;
  let sub = 0;
  let tableNo = 0;
  const org = d.projectName;
  const chapter = (title: string, roman = true) => {
    chap++;
    sec = 0;
    tableNo = 0;
    const id = `c${chap}`;
    const num = roman ? `BAB ${ROMAN[chap - 1]}` : "";
    b.push({ type: "chapter", id, num, title });
    toc.push({ id, level: 1, text: num ? `${num} ${title}` : title });
  };
  const h2 = (title: string, numbered = true) => {
    sec++;
    sub = 0;
    const id = `c${chap}s${sec}`;
    const text = numbered ? `${chap}.${sec} ${title}` : title;
    b.push({ type: "h2", id, text });
    toc.push({ id, level: 2, text });
  };
  const h3 = (title: string) => {
    sub++;
    const id = `c${chap}s${sec}u${sub}`;
    const text = `${chap}.${sec}.${sub} ${title}`;
    b.push({ type: "h3", id, text });
    toc.push({ id, level: 3, text });
  };
  /** Blok isi analisis (tabel diberi nomor "Tabel bab.n"). */
  const body = (blocks: Block[], label: string) => {
    const tables = blocks.filter((x) => x.type === "table").length;
    let k = 0;
    for (const x of blocks) {
      if (x.type === "title") continue;
      if (x.type === "h1" || x.type === "h2") b.push({ type: "h4", text: x.text });
      else if (x.type === "table") {
        k++;
        b.push({ type: "caption", text: `Tabel ${chap}.${++tableNo} ${label}${tables > 1 ? ` (${k})` : ""}` });
        b.push(x);
      } else b.push(x);
    }
  };

  /** Sheet ala Excel: judul tabel bernomor, tabel, lalu catatan cara membaca. */
  const gridBody = (grids: Grid[], label: string) => {
    for (const g of grids) {
      b.push({ type: "caption", text: `Tabel ${chap}.${++tableNo} ${g.title || label}` });
      b.push({ type: "grid", grid: g });
      for (const n of g.notes ?? []) b.push({ type: "note", text: n });
    }
  };

  const avail = d.sections.filter((s) => s.available);
  const keys = new Set(avail.map((s) => s.key));
  const latar = avail.find(isLatarBelakang);

  // ---------- Sampul + daftar isi ----------
  b.push({
    type: "cover",
    title: "KAJIAN AUDIT, STRATEGI, DAN REKOMENDASI",
    org: org.toUpperCase(),
    sub: d.orgType ? d.orgType[0].toUpperCase() + d.orgType.slice(1) : "",
    date: dateText(d.generatedAt),
  });
  b.push({ type: "toc" });

  // ---------- BAB I ----------
  chapter("PENDAHULUAN");
  h2("Latar Belakang");
  if (latar) body(latar.blocks, latar.label);
  else
    b.push({
      type: "p",
      text: `Kajian ini disusun untuk memahami kondisi ${org} secara sistematis, mengidentifikasi permasalahan dan potensi yang dimiliki, serta merumuskan strategi dan rekomendasi yang dapat ditindaklanjuti oleh kepengurusan.`,
    });
  if (d.description?.trim()) {
    h2(`Tentang ${org}`);
    b.push({ type: "p", text: d.description.trim() });
  }
  h2("Tujuan");
  b.push({ type: "p", text: "Tujuan penyusunan kajian audit, strategi, dan rekomendasi ini adalah sebagai berikut." });
  b.push({
    type: "bullets",
    ordered: true,
    items: [
      `Mengetahui kondisi internal dan eksternal ${org} beserta pihak-pihak yang berkepentingan.`,
      `Merumuskan dan memilih strategi prioritas berdasarkan analisis yang terukur.`,
      `Menyusun rekomendasi dan rencana tindak lanjut yang selaras dengan visi dan misi organisasi.`,
    ],
  });
  h2("Alur Pengerjaan");
  const docs = [...new Set(Object.values(d.sources).filter((s) => s.kind === "document").map((s) => s.source))];
  b.push({
    type: "p",
    text: `Kajian disusun dari ${docs.length ? `${docs.length} dokumen organisasi` : "dokumen organisasi"} (misalnya notulensi, laporan kegiatan, survei, dan struktur organisasi) melalui rangkaian analisis berikut. Setiap analisis dirumuskan dari potongan dokumen yang relevan dan setiap butir merujuk ke kutipan sumbernya (Lampiran A dan B). Bobot, skor, dan peringkat dihitung dengan rumus yang sama seperti framework Excel (Lampiran E).`,
  });
  const flow = ORDER.map((g) => ({ g, secs: avail.filter((s) => s.group === g && s !== latar) })).filter((x) => x.secs.length);
  b.push({
    type: "bullets",
    ordered: true,
    items: flow.map(({ g, secs }) => `${g === "custom" ? "Analisis awal" : NODE_GROUPS.find((x) => x.id === g)!.label}: ${secs.map((s) => (s.group === "custom" ? titleCase(s.label) : s.label)).join(", ")}.`),
  });

  // ---------- BAB II ----------
  chapter(`ANALISIS ${org.toUpperCase()}`);
  for (const { g, secs } of flow) {
    h2(g === "custom" ? "Analisis Awal" : NODE_GROUPS.find((x) => x.id === g)!.label);
    if (GROUP_INTRO[g]) b.push({ type: "p", text: GROUP_INTRO[g] });
    for (const s of secs) {
      h3(s.group === "custom" ? titleCase(s.label) : s.label);
      if (DEFINITIONS[s.key]) b.push({ type: "p", text: DEFINITIONS[s.key] });
      const sheets = s.grids.filter((g) => !isAhpGrid(g));
      if (sheets.length) gridBody(sheets, s.group === "custom" ? titleCase(s.label) : s.label);
      else body(s.blocks, s.label);
      if (s.summary) b.push({ type: "p", text: `Berdasarkan hasil ${s.group === "custom" ? titleCase(s.label) : lowerFirst(s.label)}, ${lowerFirst(s.summary)}` });
    }
  }

  // ---------- BAB III ----------
  chapter("PEMBAHASAN DAN REKOMENDASI");
  h2("Pembahasan");
  const posisi = out<PosisiComputed>(d, "posisi_organisasi");
  if (posisi && Number.isFinite(posisi.x) && Number.isFinite(posisi.y))
    b.push({
      type: "p",
      text: `Total IFAS sebesar ${num(posisi.x)} dan total EFAS sebesar ${num(posisi.y)} menempatkan ${org} pada Kuadran ${posisi.kuadran} (${posisi.strategi}), sehingga arah strategi utama yang disarankan adalah strategi ${posisi.fokus}.`,
    });
  if (d.executiveSummary?.length) for (const s of d.executiveSummary) b.push({ type: "p", text: s.text });
  else if (!posisi?.kuadran) b.push({ type: "p", text: `Pembahasan disusun dari hasil analisis pada BAB II.` });

  h2("Rekomendasi");
  b.push({ type: "p", text: "Rekomendasi disusun berdasarkan hasil pemilihan strategi, cascading visi dan misi, serta analisis program kerja." });
  const qspm = out<QspmComputedV2>(d, "qspm");
  if (qspm?.ranking?.length) {
    b.push({ type: "h4", text: "Strategi prioritas (hasil QSPM)" });
    b.push({
      type: "bullets",
      ordered: true,
      items: qspm.ranking.slice(0, 5).map((r) => `${r.text} (${r.id}, total TAS ${num(r.tas)})`),
    });
  }
  const cas = out<CascadingComputed>(d, "cascading");
  if (cas?.aspects?.length) {
    b.push({ type: "h4", text: "Inisiatif strategis per aspek visi" });
    for (const a of cas.aspects) {
      const items = (a.objectives ?? []).flatMap((o) => (o.initiatives ?? []).map((i) => `${i.id} ${i.text}${i.strategyRef ? ` (${i.strategyRef})` : ""}`));
      if (!items.length) continue;
      b.push({ type: "p", text: `${a.aspek}${a.misi ? ` — ${a.misi}` : ""}` });
      b.push({ type: "bullets", items });
    }
  }
  const pro = out<KontinuitasComputed>(d, "kontinuitas_proker");
  if (pro?.proker?.length) {
    b.push({ type: "h4", text: "Tindak lanjut program kerja" });
    b.push({ type: "caption", text: `Tabel ${chap}.${++tableNo} Rekomendasi kontinuitas program kerja` });
    b.push({
      type: "table",
      head: ["Program kerja", "Effort", "Impact", "Rekomendasi"],
      widths: [46, 17, 17, 20],
      rows: pro.proker.map((p) => [p.name, p.effortLevel, p.impactLevel, p.rekomendasi]),
    });
  }
  if (!qspm && !cas && !pro) b.push({ type: "bullets", items: d.keyResults.map((k) => `${k.label}: ${k.text}`) });

  // ---------- BAB IV ----------
  chapter("KESIMPULAN");
  h2("Kesimpulan");
  b.push({ type: "p", text: `Berdasarkan seluruh rangkaian analisis terhadap ${org}, dapat disimpulkan hal-hal berikut.` });
  b.push({ type: "bullets", ordered: true, items: d.keyResults.map((k) => `${k.label}: ${k.text}`) });

  // ---------- Daftar pustaka ----------
  chapter("DAFTAR PUSTAKA", false);
  const refs = METHOD_REFS.filter((r) => r.when(keys)).map((r) => r.text);
  if (refs.length) b.push({ type: "bullets", items: refs });
  if (docs.length) {
    b.push({ type: "h4", text: "Dokumen sumber organisasi" });
    b.push({ type: "bullets", items: docs.sort((x, y) => x.localeCompare(y)) });
  }

  // ---------- Lampiran ----------
  chapter("LAMPIRAN", false);
  for (const x of appendixBlocks(d)) {
    if (x.type === "h1") h2(x.text, false);
    else if (x.type === "h2") b.push({ type: "h4", text: x.text });
    else if (x.type === "title") continue;
    else b.push(x);
  }
  const ahp = avail.filter((s) => s.grids.some(isAhpGrid));
  if (ahp.length) {
    h2("Lampiran D. Matriks perbandingan berpasangan (AHP)", false);
    for (const s of ahp)
      for (const g of s.grids.filter(isAhpGrid)) {
        b.push({ type: "caption", text: `${s.label} — ${g.title}` });
        b.push({ type: "grid", grid: g });
      }
  }
  const withFormulas = avail.filter((s) => s.formulas.length);
  if (withFormulas.length) {
    h2("Lampiran E. Rumus perhitungan", false);
    for (const s of withFormulas) {
      b.push({ type: "h4", text: s.label });
      b.push({ type: "table", head: ["Besaran", "Rumus", "Arti"], widths: [22, 38, 40], rows: s.formulas.map((f) => [f.name, f.rumus, f.arti]) });
    }
  }
  return { blocks: b, toc };
}

/** Sheet matriks perbandingan berpasangan AHP (dipindah ke lampiran agar bab analisis ringkas). */
const isAhpGrid = (g: Grid) => /^ahp/i.test(g.id);

const lowerFirst = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t);

/** Judul yang ditulis HURUF KAPITAL SEMUA (mis. nama node kustom) dirapikan menjadi Huruf Awal Kapital. */
export const titleCase = (t: string) =>
  /[a-z]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s(/–-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
