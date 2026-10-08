// ESS+W / ESO+T — faktor internal (Strength + Weakness, kerangka McKinsey 7S) dan eksternal (Opportunities + Threat,
// kerangka PRL: Politic, Relation, Legal; boleh juga Economic, Social, Technology, Environment) beserta bobotnya.
//
// AI mengusulkan faktor (dengan kutipan dokumen), kategorinya, dan perbandingan berpasangan AHP BERTINGKAT:
//   tingkat 1: S vs W (atau O vs T) → bobot kuadran
//   tingkat 2: antarfaktor di dalam kuadran → bobot lokal
//   bobot faktor = bobot lokal × bobot kuadran (jumlah semua faktor = 1, seperti Excel: SUM(D2:D22) = 1)
// Modul murni (aman di client).
import { z } from "zod";
import { Evidence } from "../schemas";
import { AHP_RULES, AhpSetSchema, computeAhpSet, mockAhpSet, pairList, weightsOf } from "../ahp-common";
import type { AhpSetComputed, AhpSetRaw, FactorComputed, FaktorComputed, Quadrant } from "../contracts";
import type { CheckResult, CheckSpec, Failure, LlmSession, NodeContext, NodeDef, NodeKey, SheetContext } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { bestCategory, guessQuadrant, isExternal, isNegative, pick, sentencesOf, toClaim } from "../heuristics";
import { checkQuotes, chunkMap, llmJudge, overlap, result } from "@/lib/validators/common";
import { GridBuilder, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { ahpGrid, type AhpSheetSet } from "@/lib/sheets/ahp-sheet";
import {
  FILL,
  VIEW_TAG,
  ahpView,
  checkAhpViews,
  checkAhpViewsConsistency,
  idNum,
  normText,
  remapAhpEdits,
  similarity,
  sum,
  type AhpView,
} from "./es-common";

export type FaktorScope = "internal" | "eksternal";

const KEY: Record<FaktorScope, NodeKey> = { internal: "faktor_internal", eksternal: "faktor_eksternal" };
const SHEET: Record<FaktorScope, string> = { internal: "ESS+W", eksternal: "ESO+T" };
export const QUADS: Record<FaktorScope, [Quadrant, Quadrant]> = { internal: ["S", "W"], eksternal: ["O", "T"] };
/** Judul kolom seperti di Excel. */
export const QUADRANT_NAME: Record<Quadrant, string> = { S: "Strength", W: "Weakness", O: "Opportunities", T: "Threat" };
export const QUADRANT_ID_LABEL: Record<Quadrant, string> = { S: "Kekuatan", W: "Kelemahan", O: "Peluang", T: "Ancaman" };

/** Kategori 7S persis seperti Excel (urutan baris ESS+W). */
export const SEVEN_S = ["Strategy", "System", "Structure", "Staff", "Style", "Skill", "Shared Value"] as const;
/** Kategori lingkungan: PRL seperti Excel, ditambah PESTEL lain bila dokumen memerlukan. */
export const PRL = ["Politic", "Relation", "Legal"] as const;
export const ENV_EXTRA = ["Economic", "Social", "Technology", "Environment"] as const;
export const CATEGORIES: Record<FaktorScope, readonly string[]> = { internal: SEVEN_S, eksternal: [...PRL, ...ENV_EXTRA] };

export const CATEGORY_HINT: Record<string, string> = {
  Strategy: "arah, tujuan, rencana, prioritas, kesesuaian program dengan visi-misi",
  System: "prosedur, SOP, administrasi, persuratan, monitoring/evaluasi, alur kerja, keuangan",
  Structure: "struktur organisasi, pembagian wewenang dan tugas, hubungan pelaporan",
  Staff: "SDM: jumlah pengurus, rekrutmen, beban kerja, keaktifan, regenerasi",
  Style: "gaya kepemimpinan, cara mengambil keputusan, pola komunikasi pimpinan",
  Skill: "kompetensi, keterampilan, pengetahuan, pelatihan, transfer knowledge",
  "Shared Value": "nilai bersama, budaya, identitas, semangat organisasi",
  Politic: "dinamika politik, kebijakan pimpinan kampus/pemerintah, kekuasaan pihak lain atas organisasi",
  Relation: "hubungan, jejaring, koordinasi, dan kolaborasi dengan pihak luar",
  Legal: "aturan, hukum, regulasi, AD/ART atau undang-undang organisasi, hak cipta, kewajiban pelaporan",
  Economic: "pendanaan, sponsor, biaya, kondisi ekonomi",
  Social: "minat, perilaku, dan tren mahasiswa/masyarakat",
  Technology: "teknologi, media digital, platform",
  Environment: "lingkungan fisik, fasilitas, lokasi, cuaca",
};

const SYNONYM: Record<string, string> = {
  strategi: "Strategy",
  strategy: "Strategy",
  system: "System",
  systems: "System",
  sistem: "System",
  structure: "Structure",
  struktur: "Structure",
  staff: "Staff",
  staf: "Staff",
  style: "Style",
  gaya: "Style",
  "gaya kepemimpinan": "Style",
  skill: "Skill",
  skills: "Skill",
  keterampilan: "Skill",
  keahlian: "Skill",
  kompetensi: "Skill",
  "shared value": "Shared Value",
  "shared values": "Shared Value",
  "nilai bersama": "Shared Value",
  politic: "Politic",
  politics: "Politic",
  political: "Politic",
  politik: "Politic",
  relation: "Relation",
  relations: "Relation",
  relasi: "Relation",
  hubungan: "Relation",
  legal: "Legal",
  hukum: "Legal",
  economic: "Economic",
  economy: "Economic",
  ekonomi: "Economic",
  social: "Social",
  sosial: "Social",
  technology: "Technology",
  technological: "Technology",
  teknologi: "Technology",
  environment: "Environment",
  environmental: "Environment",
  lingkungan: "Environment",
};

/** Kategori baku ("style" → "Style", "Structure " → "Structure", "Politik" → "Politic"); tidak dikenal → apa adanya. */
export function canonicalCategory(c: string, scope: FaktorScope): string {
  const t = (c ?? "").trim();
  const s = SYNONYM[t.toLowerCase().replace(/\s+/g, " ")];
  if (s && CATEGORIES[scope].includes(s)) return s;
  return CATEGORIES[scope].find((x) => x.toLowerCase() === t.toLowerCase()) ?? t;
}

// ---------- Skema output mentah (AI) ----------

function factorSchema(scope: FaktorScope) {
  const [a, b] = QUADS[scope];
  return z.object({
    id: z
      .string()
      .regex(new RegExp(`^[${a}${b}][1-9][0-9]*$`))
      .describe(`${a}1, ${a}2, … untuk ${QUADRANT_NAME[a]}; ${b}1, ${b}2, … untuk ${QUADRANT_NAME[b]} (nomor urut per kuadran)`),
    category: z.string().min(1).describe(`Tepat satu dari: ${CATEGORIES[scope].join(", ")}`),
    text: z.string().min(5).describe("Pernyataan faktor (satu gagasan, kalimat jelas)"),
    evidence: z.array(Evidence).default([]),
  });
}

function outputSchema(scope: FaktorScope) {
  return z.object({
    factors: z.array(factorSchema(scope)),
    /** AHP bertingkat: {"id":"SW","items":["S","W"]}, {"id":"S","items":[S1…]}, {"id":"W","items":[W1…]} (O/T untuk eksternal). */
    ahp: z.array(AhpSetSchema).default([]),
    /** Dugaan faktor yang tidak didukung dokumen → pertanyaan untuk pengguna. */
    unsupported: z.array(z.string()).default([]),
  });
}

export const FaktorInternalOutput = outputSchema("internal");
export const FaktorEksternalOutput = outputSchema("eksternal");
const SCHEMA: Record<FaktorScope, typeof FaktorInternalOutput> = { internal: FaktorInternalOutput, eksternal: FaktorEksternalOutput };
export type FaktorOutput = z.infer<typeof FaktorInternalOutput>;
type FactorRaw = FaktorOutput["factors"][number];

// ---------- Output setelah compute ----------

export type FactorOut = FactorComputed & {
  /** Posisi faktor di output mentah (untuk path edit). */
  rawIndex: number;
  /** Bobot lokal di dalam kuadrannya (AHP tingkat 2). */
  localBobot: number;
};

export type FaktorOut = Omit<FaktorOutput, "factors" | "ahp"> &
  Omit<FaktorComputed, "factors"> & {
    factors: FactorOut[];
    /** Bobot kuadran (AHP tingkat 1), mis. { S: 0,667, W: 0,333 }. */
    groupWeights: Partial<Record<Quadrant, number>>;
    /** Salinan himpunan AHP mentah (untuk sheet AHP yang bisa diedit). */
    ahpRaw: AhpSetRaw[];
  };

// ---------- Perhitungan ----------

export const quadrantOf = (id: string) => (id ?? "").charAt(0).toUpperCase() as Quadrant;

type Views = {
  members: Partial<Record<Quadrant, string[]>>;
  active: Quadrant[];
  level1: AhpView | null;
  byQ: Partial<Record<Quadrant, AhpView>>;
};

function faktorViews(factors: { id: string }[], sets: AhpSetRaw[] | undefined, scope: FaktorScope): Views {
  const [a, b] = QUADS[scope];
  const members: Views["members"] = {};
  for (const q of [a, b])
    members[q] = [...new Set(factors.map((f) => f.id).filter((id) => quadrantOf(id) === q))].sort((x, y) => idNum(x) - idNum(y));
  const active = [a, b].filter((q) => members[q]!.length);
  const level1 = active.length === 2 ? ahpView(sets, `${a}${b}`, [a, b]) : null;
  const byQ: Views["byQ"] = {};
  for (const q of active) if (members[q]!.length >= 2) byQ[q] = ahpView(sets, q, members[q]!);
  return { members, active, level1, byQ };
}

const viewLabel = (id: string) =>
  id.length === 2 && id in { SW: 1, OT: 1 }
    ? `${QUADRANT_NAME[id[0] as Quadrant]} vs ${QUADRANT_NAME[id[1] as Quadrant]}`
    : id in QUADRANT_NAME
      ? `antar-${QUADRANT_NAME[id as Quadrant]}`
      : id;

/** Kalkulator kode: urutan S→W (O→T), kategori baku, bobot AHP bertingkat, total. */
export function computeFaktor(out: FaktorOutput, scope: FaktorScope): FaktorOut {
  const raw = out.factors ?? [];
  const [a, b] = QUADS[scope];
  const v = faktorViews(raw, out.ahp, scope);
  const ahpSets: AhpSetComputed[] = [];
  const gw: Partial<Record<Quadrant, number>> = { [a]: 0, [b]: 0 };
  if (v.level1) {
    const c = computeAhpSet(v.level1.raw, viewLabel(v.level1.raw.id));
    ahpSets.push(c);
    Object.assign(gw, weightsOf(c));
  } else if (v.active.length === 1) gw[v.active[0]] = 1;
  const local = new Map<string, number>();
  for (const q of v.active) {
    const view = v.byQ[q];
    if (view) {
      const c = computeAhpSet(view.raw, viewLabel(q));
      ahpSets.push(c);
      for (const [id, w] of Object.entries(weightsOf(c))) local.set(id, w);
    } else for (const id of v.members[q] ?? []) local.set(id, 1);
  }
  const order = (q: Quadrant) => (q === a ? 0 : q === b ? 1 : 2);
  const factors: FactorOut[] = raw
    .map((f, i) => {
      const quadrant = quadrantOf(f.id);
      const localBobot = local.get(f.id) ?? 0;
      return {
        id: f.id,
        quadrant,
        category: canonicalCategory(f.category, scope),
        text: f.text,
        bobot: localBobot * (gw[quadrant] ?? 0),
        localBobot,
        evidence: f.evidence ?? [],
        rawIndex: i,
      };
    })
    .sort((x, y) => order(x.quadrant) - order(y.quadrant) || idNum(x.id) - idNum(y.id) || x.rawIndex - y.rawIndex);
  return {
    ...out,
    scope,
    factors,
    total: sum(factors.map((f) => f.bobot)),
    ahp: ahpSets,
    groupWeights: gw,
    ahpRaw: out.ahp ?? [],
  };
}

const isComputed = (o: unknown): o is FaktorOut =>
  !!o && typeof o === "object" && typeof (o as FaktorOut).total === "number" && Array.isArray((o as FaktorOut).factors);

/** Output (mentah atau sudah dihitung) → bentuk hasil hitung. */
export function asFaktor(o: unknown, scope: FaktorScope): FaktorOut {
  if (isComputed(o)) return o;
  const p = SCHEMA[scope].safeParse(o ?? {});
  return computeFaktor(p.success ? p.data : { factors: [], ahp: [], unsupported: [] }, scope);
}

// ---------- Sheet ----------

const quoteText = (f: { evidence: Evidence[] }) => f.evidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join("\n");

export function faktorSheets(o: FaktorOut, scope: FaktorScope): Grid[] {
  const key = KEY[scope];
  const [a, b] = QUADS[scope];
  const views = faktorViews(
    [...o.factors].sort((x, y) => x.rawIndex - y.rawIndex),
    o.ahpRaw,
    scope,
  );
  const catHead = scope === "internal" ? "7S" : o.factors.every((f) => (PRL as readonly string[]).includes(f.category)) ? "PRL" : "Kategori";
  const g = new GridBuilder("faktor", SHEET[scope], scope === "internal" ? "Faktor internal — Strength & Weakness (7S)" : "Faktor eksternal — Opportunities & Threat (PRL)");
  let r = 0;
  const firstRow = 1;
  for (const q of [a, b]) {
    g.row(r, 0, ["No", catHead], { style: "header", fill: FILL.navy, center: true });
    g.row(r, 2, [QUADRANT_NAME[q], "Bobot"], { style: "header", fill: FILL.blue });
    g.set(r, 4, "Bukti dokumen", { style: "header", fill: FILL.blue });
    r++;
    const fs = o.factors.filter((f) => f.quadrant === q);
    if (!fs.length) {
      g.set(r, 2, `(belum ada ${QUADRANT_NAME[q]} yang didukung dokumen)`, { style: "note" });
      r++;
    }
    fs.forEach((f, k) => {
      g.set(r, 0, k + 1, {
        style: "int",
        fill: FILL.navy,
        center: true,
        ...(k ? { f: `A${r}+1`, src: "hitung" as const, explain: `Nomor urut = nomor di atasnya + 1 = ${k + 1}` } : { src: "tetap" as const }),
      });
      g.set(r, 1, f.category, {
        fill: FILL.navy,
        src: "ai",
        note: CATEGORY_HINT[f.category] ? `${f.category}: ${CATEGORY_HINT[f.category]}` : "Kategori tidak dikenal — pilih dari daftar",
        edit: { path: ["factors", f.rawIndex, "category"], type: "select", options: [...CATEGORIES[scope]] },
      });
      g.set(r, 2, f.text, {
        style: "text",
        fill: FILL.factor,
        src: "ai",
        note: `${f.id} — ${QUADRANT_ID_LABEL[q]}`,
        refs: f.evidence.map((e) => e.chunkId),
        edit: { path: ["factors", f.rawIndex, "text"], type: "text" },
      });
      const gwq = o.groupWeights[q] ?? 0;
      const ref = views.byQ[q] ? `{{${key}!w_${f.id}}}` : views.level1 ? `{{${key}!w_${q}}}` : undefined;
      g.set(r, 3, f.bobot, {
        fill: FILL.factor,
        fmt: "0.000",
        src: ref ? "ahp" : "tetap",
        ...(ref
          ? {
              f: ref,
              explain: `Bobot ${f.id} = bobot lokal × bobot ${QUADRANT_NAME[q]} = ${num(f.localBobot)} × ${num(gwq)} = ${num(f.bobot)} (lihat sheet AHP)`,
            }
          : { note: "Satu-satunya faktor → bobot 1" }),
      });
      g.anchor(`b_${f.id}`, r, 3);
      g.set(r, 4, quoteText(f), { style: "muted", src: "dokumen", refs: f.evidence.map((e) => e.chunkId) });
      r++;
    });
  }
  g.set(r, 2, "Total", { style: "total", fill: FILL.blue });
  g.set(r, 3, o.total, {
    style: "total",
    fill: FILL.blue,
    fmt: "0.000",
    src: "hitung",
    f: r > firstRow ? `SUM(D${firstRow + 1}:D${r})` : "0",
    explain: `Total bobot = jumlah bobot semua faktor = ${num(o.total)} (harus 1). ${QUADRANT_NAME[a]} ${num(sum(o.factors.filter((f) => f.quadrant === a).map((f) => f.bobot)))}, ${QUADRANT_NAME[b]} ${num(sum(o.factors.filter((f) => f.quadrant === b).map((f) => f.bobot)))}.`,
  });
  g.anchor("total", r, 3);
  const main = g.build({
    cols: [6, 14, 70, 9, 60],
    notes: [
      scope === "internal"
        ? "Strength = kondisi internal yang menguntungkan; Weakness = kondisi internal yang merugikan. Kolom 7S menunjukkan aspek organisasi (Strategy, System, Structure, Staff, Style, Skill, Shared Value)."
        : "Opportunities = kondisi di luar organisasi yang menguntungkan; Threat = kondisi luar yang mengancam. Kolom PRL menunjukkan aspek Politic, Relation, atau Legal (boleh juga Economic, Social, Technology, Environment).",
      `Bobot dihitung dengan AHP bertingkat: ${QUADRANT_NAME[a]} dibanding ${QUADRANT_NAME[b]} memberi bobot kuadran, lalu antarfaktor di dalam kuadran memberi bobot lokal. Bobot = bobot lokal × bobot kuadran; jumlah semua = 1.`,
      "Teks faktor dan kategorinya bisa Anda ubah; perbandingan AHP diubah di sheet AHP dan bobot dihitung ulang otomatis.",
    ],
  });

  // Sheet AHP bertingkat
  const sheetViews: AhpView[] = [];
  const sets: AhpSheetSet[] = [];
  const textOf = (id: string) => o.factors.find((f) => f.id === id)?.text ?? id;
  let parentAnchor: Partial<Record<Quadrant, string>> = {};
  if (views.level1) {
    const l1: AhpSheetSet = {
      raw: views.level1.raw,
      label: `${QUADRANT_NAME[a]} vs ${QUADRANT_NAME[b]} (bobot kuadran)`,
      path: [VIEW_TAG, 0],
      itemLabel: (id) => QUADRANT_NAME[id as Quadrant] ?? id,
    };
    // Alamat sel bobot kuadran di sheet AHP (himpunan pertama → letaknya tetap walau himpunan lain ditambah)
    const pre = ahpGrid({ name: "x", title: "x", sets: [l1] });
    parentAnchor = { [a]: pre.anchors?.[`w_${a}`], [b]: pre.anchors?.[`w_${b}`] };
    sets.push(l1);
    sheetViews.push(views.level1);
  }
  for (const q of [a, b]) {
    const view = views.byQ[q];
    if (!view) continue;
    sets.push({
      raw: view.raw,
      label: `Antar-${QUADRANT_NAME[q]} (bobot lokal)`,
      path: [VIEW_TAG, sheetViews.length],
      itemLabel: textOf,
      ...(views.level1 ? { parent: { label: QUADRANT_NAME[q], weight: o.groupWeights[q] ?? 0, anchor: parentAnchor[q] } } : {}),
    });
    sheetViews.push(view);
  }
  if (!sets.length) return [main];
  const ag = remapAhpEdits(
    ahpGrid({ id: "ahp", name: scope === "internal" ? "AHP S+W" : "AHP O+T", title: `AHP bertingkat — bobot faktor ${scope}`, sets }),
    sheetViews,
  );
  return [main, ag];
}

function faktorSummary(o: FaktorOut): string {
  const [a, b] = QUADS[o.scope];
  const part = (q: Quadrant) => {
    const fs = o.factors.filter((f) => f.quadrant === q);
    return `${fs.length} ${QUADRANT_NAME[q]} (Σ bobot ${num(sum(fs.map((f) => f.bobot)))})`;
  };
  return `${part(a)} dan ${part(b)}; total bobot ${num(o.total)}.`;
}

function faktorBlocks(o: FaktorOut, label: string): Block[] {
  const catHead = o.scope === "internal" ? "7S" : "Kategori";
  const out: Block[] = [
    { type: "h2", text: label },
    { type: "p", text: faktorSummary(o) },
  ];
  for (const q of QUADS[o.scope]) {
    const fs = o.factors.filter((f) => f.quadrant === q);
    out.push({
      type: "table",
      head: ["ID", catHead, QUADRANT_NAME[q], "Bobot"],
      rows: fs.map((f) => [f.id, f.category, f.text, num(f.bobot)]),
      widths: [8, 16, 64, 12],
    });
  }
  out.push({ type: "note", text: "Bobot dari AHP bertingkat (antar-kuadran × antarfaktor); jumlah semua bobot = 1." });
  return out;
}

export const FAKTOR_FORMULAS: FormulaDoc[] = [
  { name: "Bobot kuadran", rumus: "AHP tingkat 1: S vs W (atau O vs T)", arti: "Seberapa besar porsi kekuatan dibanding kelemahan (peluang dibanding ancaman) dalam penilaian." },
  { name: "Bobot lokal", rumus: "AHP tingkat 2: antarfaktor di dalam kuadran (rata-rata geometrik baris ÷ jumlahnya)", arti: "Seberapa penting faktor dibanding faktor lain di kuadran yang sama; jumlah per kuadran = 1." },
  { name: "Bobot faktor", rumus: "Bobot = Bobot lokal × Bobot kuadran", arti: "Bobot akhir faktor; dipakai di IFAS/EFAS dan QSPM." },
  { name: "Total bobot", rumus: "Σ bobot semua faktor", arti: "Harus 1 (100%).", excel: "=SUM(D2:D22)" },
];

// ---------- Prompt ----------

const QUERIES: Record<FaktorScope, Record<string, string>> = {
  internal: {
    Strategy: "strategi tujuan arah rencana program kerja prioritas visi misi kabinet",
    System: "sistem prosedur SOP administrasi persuratan keuangan dokumentasi monitoring evaluasi",
    Structure: "struktur organisasi divisi biro kementerian pembagian wewenang tugas koordinasi",
    Staff: "staf anggota pengurus jumlah keaktifan regenerasi kaderisasi rekrutmen beban kerja",
    Style: "gaya kepemimpinan ketua pengambilan keputusan rapat komunikasi pimpinan",
    Skill: "keterampilan kompetensi kemampuan pelatihan keahlian transfer knowledge",
    "Shared Value": "nilai bersama budaya organisasi identitas AD/ART kekeluargaan profesionalitas loyalitas",
  },
  eksternal: {
    Politic: "kebijakan kampus rektorat fakultas pemerintah politik birokrasi kekuasaan independensi",
    Relation: "hubungan jejaring kolaborasi koordinasi mitra alumni organisasi lain himpunan komunikasi",
    Legal: "aturan peraturan hukum undang-undang AD/ART regulasi pelaporan hak cipta izin",
    Economic: "ekonomi pendanaan sponsor biaya dana hibah anggaran",
    Social: "sosial minat mahasiswa tren gaya hidup masyarakat partisipasi",
    Technology: "teknologi digital media sosial platform aplikasi daring",
    Environment: "lingkungan fasilitas ruang tempat lokasi cuaca",
  },
};
const FOCUS: Record<FaktorScope, { focus: string; text: string }[]> = {
  internal: [
    { focus: "S", text: "kekuatan internal keberhasilan program berjalan baik optimal jelas prestasi solid" },
    { focus: "W", text: "kelemahan internal kendala kurang lambat belum terbatas masalah terlambat" },
  ],
  eksternal: [
    { focus: "O", text: "peluang eksternal dukungan kesempatan kolaborasi tren minat mitra sponsor" },
    { focus: "T", text: "ancaman eksternal risiko kebijakan ketat intervensi pesaing persaingan pemotongan" },
  ],
};

function faktorPrompt(ctx: NodeContext, scope: FaktorScope) {
  const [a, b] = QUADS[scope];
  const cats = CATEGORIES[scope].map((c) => `  - ${c}: ${CATEGORY_HINT[c]}`).join("\n");
  const what =
    scope === "internal"
      ? `- Strength (S) = kondisi INTERNAL yang positif/menguntungkan dan bisa dikendalikan organisasi (orang, proses, program, struktur, nilai).
- Weakness (W) = kondisi INTERNAL yang negatif/merugikan.
- Faktor eksternal (kebijakan kampus, pihak luar, tren) BUKAN bagian node ini.`
      : `- Opportunities (O) = kondisi EKSTERNAL (di luar kendali organisasi) yang menguntungkan.
- Threat (T) = kondisi EKSTERNAL yang mengancam/merugikan.
- Kondisi internal organisasi (pengurus, SOP, program sendiri) BUKAN bagian node ini.`;
  return {
    system: `Kamu analis strategi organisasi. Susun FAKTOR ${scope === "internal" ? "INTERNAL (Strength + Weakness) dengan kerangka McKinsey 7S" : "EKSTERNAL (Opportunities + Threat) dengan kerangka PRL (Politic, Relation, Legal)"} HANYA dari potongan dokumen, lalu isi perbandingan berpasangan AHP untuk bobotnya.

FAKTOR
${what}
- category: pilih tepat satu:
${cats}
- ID: ${a}1, ${a}2, … untuk ${QUADRANT_NAME[a]} dan ${b}1, ${b}2, … untuk ${QUADRANT_NAME[b]} (nomor urut per kuadran mulai 1, tanpa loncat). Tulis ${QUADRANT_NAME[a]} dulu, lalu ${QUADRANT_NAME[b]}.
- Satu faktor = satu gagasan dalam kalimat jelas (gaya Excel: "Sistem WBS telah dirancang dan dinilai optimal dalam pembagian fungsi kerja."). Jangan ada faktor ganda.
- Jumlah faktor mengikuti bukti (biasanya 3–13 per kuadran); usahakan kedua kuadran terisi.

BUKTI
${EVIDENCE_RULES}
- Jika kamu menduga ada faktor tetapi tidak menemukan bukti, JANGAN masukkan; tulis sebagai pertanyaan di "unsupported".

${AHP_RULES}

HIMPUNAN AHP YANG WAJIB DIISI (field "ahp") — AHP BERTINGKAT
1. {"id":"${a}${b}","items":["${a}","${b}"]} — seberapa penting kelompok ${QUADRANT_NAME[a]} dibanding ${QUADRANT_NAME[b]} bagi kondisi organisasi saat ini (1 pasangan: ${pairList([a, b])}).
2. {"id":"${a}","items":[semua ID ${QUADRANT_NAME[a]} berurutan]} — seberapa besar pengaruh/urgensi faktor a dibanding faktor b. Isi SEMUA pasangan: n faktor → n(n−1)/2 pasangan (13 faktor → 78 pasangan). Contoh 4 faktor: ${pairList([`${a}1`, `${a}2`, `${a}3`, `${a}4`])}.
3. {"id":"${b}","items":[semua ID ${QUADRANT_NAME[b]} berurutan]} — sama seperti nomor 2.
Kode menghitung: bobot faktor = bobot lokal (dalam kuadran) × bobot kuadran, sehingga jumlah semua faktor = 1.

${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(SCHEMA[scope])}`,
  };
}

// ---------- Mock (tanpa LLM) ----------

/** Kalimat cita-cita/harapan bukan kondisi saat ini → tidak dijadikan faktor oleh mock. */
const ASPIRATION = /\b(ingin|berharap|harapan|menargetkan|bercita-cita|diharapkan)\b/i;

export function mockFaktor(ctx: NodeContext, scope: FaktorScope): FaktorOutput {
  const [a, b] = QUADS[scope];
  const cap = scope === "internal" ? 7 : 5;
  const count: Partial<Record<Quadrant, number>> = { [a]: 0, [b]: 0 };
  const factors: FactorRaw[] = [];
  const seen = new Set<string>();
  for (const c of ctx.evidence.filter((e) => e.kind === "document")) {
    for (const quote of sentencesOf(c.content)) {
      if (ASPIRATION.test(quote)) continue;
      const ext = isExternal(quote);
      if (scope === "internal" ? ext : !ext) continue;
      const q = isNegative(quote) ? b : a;
      const text = toClaim(quote);
      const k = normText(text);
      if (seen.has(k) || (count[q] ?? 0) >= cap) continue;
      seen.add(k);
      count[q] = (count[q] ?? 0) + 1;
      factors.push({ id: `${q}${count[q]}`, category: bestCategory(quote, QUERIES[scope]).key, text, evidence: [{ chunkId: c.id, quote }] });
    }
  }
  factors.sort((x, y) => (quadrantOf(x.id) === quadrantOf(y.id) ? idNum(x.id) - idNum(y.id) : quadrantOf(x.id) === a ? -1 : 1));
  const ids = (q: Quadrant) => factors.filter((f) => quadrantOf(f.id) === q).map((f) => f.id);
  const textOf = new Map(factors.map((f) => [f.id, f.text]));
  const imp = (id: string) => 1 + pick(textOf.get(id) ?? id, 5);
  return {
    factors,
    ahp: [
      mockAhpSet(`${a}${b}`, [a, b], (q) => Math.max(1, ids(q as Quadrant).length)),
      mockAhpSet(a, ids(a), imp),
      mockAhpSet(b, ids(b), imp),
    ],
    unsupported: [a, b]
      .filter((q) => !count[q])
      .map((q) => `Apakah ada ${QUADRANT_ID_LABEL[q].toLowerCase()} (${QUADRANT_NAME[q]}) organisasi yang belum tercatat di dokumen?`),
  };
}

// ---------- Validasi ----------

export const FAKTOR_CHECKS: CheckSpec[] = [
  { name: "quote_exists", kind: "code", description: "Kutipan bukti faktor tidak ditemukan di potongan dokumen yang dirujuk" },
  { name: "grounded", kind: "code", description: "Faktor tidak punya kutipan dokumen sama sekali" },
  { name: "id_format", kind: "code", description: "ID faktor ganda atau nomor urut per kuadran meloncat (S1, S2, …)" },
  { name: "quadrant_coverage", kind: "code", description: "Salah satu kuadran (S/W atau O/T) kosong" },
  { name: "category_valid", kind: "code", description: "Kategori bukan 7S (internal) atau PRL/lingkungan (eksternal)" },
  { name: "duplicate", kind: "code", description: "Dua faktor menyatakan hal yang sama" },
  { name: "ahp_complete", kind: "code", description: "Ada perbandingan AHP (antar-kuadran atau antarfaktor) yang belum diisi atau merujuk faktor yang tidak ada" },
  { name: "ahp_consistency", kind: "code", description: "Rasio konsistensi AHP (CR) lebih dari 0,10 — penilaian berpasangan saling bertentangan" },
  { name: "quote_supports", kind: "llm", description: "Kutipan ada, tetapi tidak mendukung pernyataan faktor" },
  { name: "quadrant_fit", kind: "llm", description: "Faktor salah kuadran: internal/eksternal atau positif/negatif tidak sesuai S/W/O/T" },
];

export async function validateFaktor(out: FaktorOutput, ctx: NodeContext, llm: LlmSession, scope: FaktorScope): Promise<CheckResult[]> {
  const fs = out.factors ?? [];
  const [a, b] = QUADS[scope];
  const checks: CheckResult[] = [];
  checks.push(
    checkQuotes(
      fs.filter((f) => f.evidence.length),
      ctx.evidence,
    ),
  );
  checks.push(
    result(
      "grounded",
      "code",
      fs.filter((f) => !f.evidence.length).map((f) => ({ check: "grounded", itemId: f.id, message: `Faktor ${f.id} ditolak: tidak punya kutipan dokumen.` })),
    ),
  );
  const idFail: Failure[] = [];
  const cnt = new Map<string, number>();
  for (const f of fs) cnt.set(f.id, (cnt.get(f.id) ?? 0) + 1);
  for (const [id, n] of cnt) if (n > 1) idFail.push({ check: "id_format", itemId: id, message: `ID ${id} dipakai ${n} faktor; setiap faktor harus punya ID unik.` });
  for (const q of [a, b]) {
    const nums = [...new Set(fs.filter((f) => quadrantOf(f.id) === q).map((f) => idNum(f.id)))].sort((x, y) => x - y);
    const gap = nums.findIndex((n, i) => n !== i + 1);
    if (gap >= 0)
      idFail.push({ check: "id_format", itemId: `${q}${nums[gap]}`, message: `Nomor ${QUADRANT_NAME[q]} harus berurutan ${q}1, ${q}2, … tanpa loncat (ditemukan ${nums.map((n) => q + n).join(", ")}).` });
  }
  checks.push(result("id_format", "code", idFail));
  checks.push(
    result(
      "quadrant_coverage",
      "code",
      [a, b]
        .filter((q) => !fs.some((f) => quadrantOf(f.id) === q))
        .map((q) => ({ check: "quadrant_coverage", itemId: q, message: `Belum ada faktor ${QUADRANT_NAME[q]} (${q}); cari bukti di dokumen atau tanyakan ke pengguna lewat unsupported.` })),
    ),
  );
  checks.push(
    result(
      "category_valid",
      "code",
      fs
        .filter((f) => !CATEGORIES[scope].includes(canonicalCategory(f.category, scope)))
        .map((f) => ({ check: "category_valid", itemId: f.id, message: `Kategori "${f.category}" pada ${f.id} tidak dikenal; pilih salah satu: ${CATEGORIES[scope].join(", ")}.` })),
    ),
  );
  const dup: Failure[] = [];
  fs.forEach((x, i) =>
    fs.slice(i + 1).forEach((y) => {
      if (normText(x.text) === normText(y.text) || similarity(x.text, y.text) >= 0.75)
        dup.push({ check: "duplicate", itemId: y.id, message: `Faktor ${y.id} sama dengan ${x.id} ("${x.text}"); gabungkan atau hapus salah satu.` });
    }),
  );
  checks.push(result("duplicate", "code", dup));
  const v = faktorViews(fs, out.ahp, scope);
  const viewSets = [v.level1, v.byQ[a], v.byQ[b]].filter((x): x is AhpView => !!x).map((x) => x.raw);
  checks.push(checkAhpViews(viewSets, out.ahp ?? [], new Set<string>([a, b, ...fs.map((f) => f.id)]), viewLabel));
  checks.push(checkAhpViewsConsistency(viewSets, viewLabel));
  const chunks = chunkMap(ctx.evidence);
  const byId = new Map(fs.map((f) => [f.id, f]));
  const quotesOf = (f: FactorRaw) => f.evidence.map((e) => `[${e.chunkId}] "${e.quote}"`).join("; ");
  checks.push(
    await llmJudge(
      llm,
      "quote_supports",
      "Periksa apakah kutipan bukti benar-benar MENDUKUNG pernyataan faktor (bukan sekadar ada di dokumen).",
      fs.filter((f) => f.evidence.length).map((f) => ({ id: f.id, text: `${f.text} | bukti: ${quotesOf(f)}` })),
      "Pernyataan faktor harus dapat disimpulkan langsung dari kutipannya.",
      (id) => {
        const f = byId.get(id);
        if (!f) return true;
        return f.evidence.some((e) => overlap(f.text, e.quote) >= 0.2 || overlap(f.text, chunks.get(e.chunkId) ?? "") >= 0.4);
      },
    ),
  );
  checks.push(
    await llmJudge(
      llm,
      "quadrant_fit",
      `Klasifikasikan setiap faktor: INTERNAL (bisa dikendalikan organisasi) atau EKSTERNAL (di luar kendali), dan positif atau negatif. ok=false bila kuadran tertulis tidak sesuai (S = internal positif, W = internal negatif, O = eksternal positif, T = eksternal negatif).`,
      fs.map((f) => ({ id: f.id, text: `[kuadran tertulis: ${quadrantOf(f.id)}] ${f.text}` })),
      scope === "internal" ? "Node ini hanya berisi faktor INTERNAL (S dan W)." : "Node ini hanya berisi faktor EKSTERNAL (O dan T).",
      (id) => {
        const f = byId.get(id);
        if (!f) return true;
        return guessQuadrant(f.text, scope === "internal" ? "internal" : "external") === quadrantOf(f.id);
      },
    ),
  );
  return checks;
}

// ---------- Definisi node ----------

function faktorItems(out: unknown, scope: FaktorScope) {
  const o = asFaktor(out, scope);
  return o.factors.map((f) => ({ id: f.id, text: f.text, detail: `${QUADRANT_NAME[f.quadrant]} · ${f.category} · bobot ${num(f.bobot)}` }));
}

function makeFaktorNode(scope: FaktorScope): NodeDef<FaktorOutput> {
  const label = scope === "internal" ? "Faktor internal (S+W)" : "Faktor eksternal (O+T)";
  const [a, b] = QUADS[scope];
  return {
    key: KEY[scope],
    label,
    phase: 1,
    group: "es",
    sheetName: SHEET[scope],
    deps: [],
    kind: "llm",
    description:
      scope === "internal"
        ? "Strength dan Weakness per aspek McKinsey 7S dengan kutipan dokumen; bobot dari AHP bertingkat (S vs W, lalu antarfaktor)."
        : "Opportunities dan Threat per aspek PRL (Politic, Relation, Legal; boleh Economic, Social, Technology, Environment) dengan kutipan dokumen; bobot dari AHP bertingkat.",
    computedBy: "LLM mengusulkan faktor, kategori, dan perbandingan AHP; kode menghitung bobot bertingkat dan total",
    schema: SCHEMA[scope],
    checks: FAKTOR_CHECKS,
    queries: () => [
      ...Object.entries(QUERIES[scope]).map(([focus, text]) => ({ focus, text, k: 3 })),
      ...FOCUS[scope].map((f) => ({ ...f, k: 5 })),
    ],
    prompt: (ctx) => faktorPrompt(ctx, scope),
    mock: (ctx) => mockFaktor(ctx, scope),
    validate: (out, ctx, llm) => validateFaktor(out, ctx, llm, scope),
    compute: (out) => computeFaktor(out, scope),
    items: (out) => faktorItems(out, scope),
    repairHint: `Perbaiki hanya faktor/perbandingan yang ditolak; faktor lain salin apa adanya (ID ${a}…/${b}… tetap). Lengkapi SEMUA pasangan AHP yang disebut belum diisi. Bila bukti tidak ditemukan, hapus faktor itu (nomori ulang agar berurutan, sesuaikan AHP) dan tulis pertanyaannya di unsupported.`,
    sheets: (out: unknown) => faktorSheets(asFaktor(out, scope), scope),
    blocks: (out: unknown, ctx: SheetContext) => faktorBlocks(asFaktor(out, scope), ctx.label || label),
    formulas: FAKTOR_FORMULAS,
    summary: (out) => faktorSummary(asFaktor(out, scope)),
  };
}

export const faktorInternal = makeFaktorNode("internal");
export const faktorEksternal = makeFaktorNode("eksternal");
