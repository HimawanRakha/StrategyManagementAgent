// LTVMRENSTRA — Rencana strategis 3 tahun: VISI & MISI (dari cascading) → sasaran umum → target tiap tahun →
// milestone (A–F) → arah kerja (A1, A2, …) → indikator & target indikator yang terukur.
import { z } from "zod";
import type { CascadingComputed, RenstraComputed } from "../contracts";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { isMeasurable, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";

export const RENSTRA_YEARS = 3;

export const ArahRaw = z.object({
  /** "A1", "A2", "B1", … (huruf milestone + nomor). */
  id: z.string(),
  text: z.string(),
  indikator: z.string(),
  /** Target indikator yang terukur (angka/persentase/jumlah + waktu). */
  target: z.string(),
  /** Index Strategy Initiative cascading yang dijalankan (mis. "A.1.1"). */
  siRefs: z.array(z.string()).default([]),
});
export const MilestoneRaw = z.object({
  /** "A", "B", … berurutan lintas tahun. */
  id: z.string(),
  text: z.string(),
  /** ID misi yang didukung: "M1", "M2", … (urutan misi di cascading). */
  misiRefs: z.array(z.string()).default([]),
  arah: z.array(ArahRaw),
});
export const YearRaw = z.object({
  tahun: z.number().int(),
  /** Target/tema tahun ini (kolom TARGET TIAP TAHUN). */
  fokus: z.string(),
  milestones: z.array(MilestoneRaw),
});
export const RenstraRaw = z.object({
  sasaranUmum: z.string(),
  years: z.array(YearRaw),
});
export type RenstraRaw = z.infer<typeof RenstraRaw>;

export type MisiItem = { id: string; aspekId: string; aspek: string; text: string };
export type RenstraOutput = RenstraRaw &
  Omit<RenstraComputed, "years" | "sasaranUmum"> & {
    misiItems: MisiItem[];
    /** Index SI cascading yang sah (untuk rujukan arah kerja). */
    siIds: string[];
    counts: { milestones: number; arah: number };
  };

type Inputs = Partial<Record<string, unknown>>;

function misiOf(inputs: Inputs): { visi: string; misi: MisiItem[]; si: { id: string; text: string; aspekId: string }[] } {
  const c = inputs.cascading as CascadingComputed | undefined;
  const aspects = Array.isArray(c?.aspects) ? c!.aspects : [];
  return {
    visi: String(c?.visi ?? ""),
    misi: aspects.map((a, k) => ({ id: `M${k + 1}`, aspekId: a.id, aspek: a.aspek, text: a.misi })),
    si: aspects.flatMap((a) => a.objectives.flatMap((o) => o.initiatives.map((i) => ({ id: i.id, text: i.text, aspekId: a.id })))),
  };
}

export function computeRenstra(raw: RenstraRaw, inputs: Inputs): RenstraOutput {
  const { visi, misi, si } = misiOf(inputs);
  // Urutan tahun di output = urutan output mentah (agar path edit tetap benar); sheet/blok mengurutkan sendiri.
  const years = raw?.years ?? [];
  return {
    ...raw,
    sasaranUmum: raw?.sasaranUmum ?? "",
    years,
    visi,
    misi: misi.map((m) => m.text),
    misiItems: misi,
    siIds: si.map((s) => s.id),
    counts: {
      milestones: years.reduce((s, y) => s + y.milestones.length, 0),
      arah: years.reduce((s, y) => s + y.milestones.reduce((t, m) => t + m.arah.length, 0), 0),
    },
  };
}

const asOutput = (out: unknown, inputs: Inputs): RenstraOutput => {
  const o = (typeof out === "object" && out !== null ? out : {}) as Partial<RenstraOutput>;
  if (o.counts && Array.isArray(o.misiItems) && Array.isArray(o.years)) return o as RenstraOutput;
  return computeRenstra({ sasaranUmum: String(o.sasaranUmum ?? ""), years: Array.isArray(o.years) ? o.years : [] }, inputs);
};

/** Tahun diurutkan untuk tampilan, dengan index aslinya di output mentah (untuk path edit). */
const sortedYears = <Y extends { tahun: number }>(years: Y[]) =>
  years.map((y, i) => ({ y, i })).sort((a, b) => a.y.tahun - b.y.tahun || a.i - b.i);

// ---------- Prompt & mock ----------

function promptOf(ctx: NodeContext) {
  const { visi, misi, si } = misiOf(ctx.inputs);
  return {
    system: `Kamu perencana strategis organisasi. Susun RENSTRA (rencana strategis) ${RENSTRA_YEARS} tahun dari hasil cascading, seperti tab LTVMRENSTRA.
Struktur:
1. VISI RENSTRA dan MISI RENSTRA diambil otomatis dari cascading — JANGAN ditulis ulang.
2. sasaranUmum: sasaran umum dalam ${RENSTRA_YEARS} tahun (ringkas; sebut aspek visi yang dituju).
3. years: TEPAT ${RENSTRA_YEARS} tahun (tahun 1, 2, 3). fokus = target/tema tiap tahun yang bertahap (mis. tahun 1 mengunci fondasi internal, tahun 2 menjaga dan mengembangkan kekuatan internal, tahun 3 ekspansi eksternal dengan modal internal yang matang).
4. Setiap tahun punya ±2 MILESTONE (total 4–8). ID milestone huruf berurutan lintas tahun: A, B (tahun 1), C, D (tahun 2), E, F (tahun 3).
5. Setiap milestone punya 1–3 ARAH KERJA dengan ID huruf milestone + nomor: A1, A2, B1, ….
6. Setiap arah kerja punya INDIKATOR (apa yang diukur) dan TARGET INDIKATOR yang TERUKUR: memuat angka, persentase, atau jumlah, sebaiknya dengan batas waktu (mis. "100% di akhir tahun 1", "Minimal 2x per bidang/tahun", "≥90% sesuai RAB").
7. misiRefs: ID misi yang didukung milestone (${misi.map((m) => m.id).join(", ") || "M1, …"}); SETIAP misi harus didukung minimal satu milestone.
8. siRefs: index Strategy Initiative cascading yang dijalankan arah kerja itu (mis. "A.1.1"); kosongkan bila tidak ada.
9. ${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Visi: ${visi || "(belum ada)"}
Misi:
${misi.map((m) => `${m.id} (aspek ${m.aspekId} — ${m.aspek}): ${m.text}`).join("\n") || "(belum ada)"}

Strategy Initiatives (cascading):
${si.map((s) => `${s.id}: ${s.text}`).join("\n") || "(belum ada)"}

Potongan dokumen (untuk angka dasar/baseline bila ada):
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(RenstraRaw)}`,
  };
}

const FOKUS_MOCK = [
  "Mengunci dan mempertahankan kondisi internal agar menjadi fondasi kuat untuk 2 tahun berikutnya.",
  "Menjaga dan mengembangkan kekuatan internal.",
  "Ekspansi eksternal dengan modal internal yang sudah matang.",
];
const TARGET_MOCK = ["100% di akhir tahun 1", "Minimal 2 kegiatan per bidang/tahun", "≥80% terlaksana sesuai rencana"];

export function mockRenstra(inputs: Inputs): RenstraRaw {
  const { misi, si } = misiOf(inputs);
  const pool = si.length ? si : [{ id: "", text: "Menyusun program kerja prioritas organisasi", aspekId: "" }];
  let letter = 0;
  let k = 0;
  const years = Array.from({ length: RENSTRA_YEARS }, (_, y) => ({
    tahun: y + 1,
    fokus: FOKUS_MOCK[y] ?? `Target tahun ke-${y + 1}.`,
    milestones: Array.from({ length: 2 }, () => {
      const id = String.fromCharCode(65 + letter);
      const m = misi.length ? misi[letter % misi.length] : null;
      letter++;
      const arah = Array.from({ length: 2 }, (_, a) => {
        const s = pool[k++ % pool.length];
        return {
          id: `${id}${a + 1}`,
          text: s.text.replace(/\.$/, ""),
          indikator: `Persentase pelaksanaan "${s.text.slice(0, 40).replace(/\.$/, "")}…" sesuai rencana`,
          target: TARGET_MOCK[(y + a) % TARGET_MOCK.length].replace("tahun 1", `tahun ${y + 1}`),
          siRefs: s.id ? [s.id] : [],
        };
      });
      return { id, text: m ? `Tercapainya ${m.aspek.toLowerCase()} tahap ${y + 1}` : `Milestone ${id}`, misiRefs: m ? [m.id] : [], arah };
    }),
  }));
  return { sasaranUmum: misi.length ? misi.map((m) => m.aspek).join(", ") : "Penguatan organisasi dalam 3 tahun", years };
}

// ---------- Validator ----------

const CHECKS = [
  { name: "measurable", kind: "code" as const, description: "Target indikator arah kerja tidak terukur (tanpa angka, persentase, atau jumlah)" },
  { name: "misi_covered", kind: "code" as const, description: "Ada misi yang tidak didukung milestone mana pun" },
  { name: "years_complete", kind: "code" as const, description: "Tahun 1–3 tidak lengkap/ganda, atau ada tahun/milestone tanpa isi" },
  { name: "index_format", kind: "code" as const, description: "Index milestone (A, B, …) atau arah kerja (A1, A2, …) tidak sesuai format atau tidak berurutan" },
  { name: "ref_exists", kind: "code" as const, description: "Milestone/arah kerja merujuk misi atau Strategy Initiative yang tidak ada" },
  { name: "indikator_relevan", kind: "llm" as const, description: "Indikator tidak mengukur arah kerjanya atau targetnya tidak realistis" },
];

export function renstraCodeChecks(raw: RenstraRaw, inputs: Inputs): CheckResult[] {
  const { misi, si } = misiOf(inputs);
  const misiIds = new Set(misi.map((m) => m.id));
  const siIds = new Set(si.map((s) => s.id));
  const meas: Failure[] = [];
  const cov: Failure[] = [];
  const yrs: Failure[] = [];
  const idx: Failure[] = [];
  const refs: Failure[] = [];
  const years = raw.years ?? [];
  for (let t = 1; t <= RENSTRA_YEARS; t++) {
    const n = years.filter((y) => y.tahun === t).length;
    if (n !== 1) yrs.push({ check: "years_complete", itemId: `TAHUN ${t}`, message: n ? `Tahun ke-${t} ditulis ${n} kali.` : `Tahun ke-${t} belum ada.` });
  }
  for (const y of years) {
    if (y.tahun < 1 || y.tahun > RENSTRA_YEARS) yrs.push({ check: "years_complete", itemId: `TAHUN ${y.tahun}`, message: `Tahun ke-${y.tahun} di luar rentang 1–${RENSTRA_YEARS}.` });
    if (!y.milestones.length) yrs.push({ check: "years_complete", itemId: `TAHUN ${y.tahun}`, message: `Tahun ke-${y.tahun} belum punya milestone.` });
    if (!y.fokus.trim()) yrs.push({ check: "years_complete", itemId: `TAHUN ${y.tahun}`, message: `Target tahun ke-${y.tahun} masih kosong.` });
  }
  const ordered = [...years].sort((a, b) => a.tahun - b.tahun);
  let letter = 0;
  const used = new Set<string>();
  for (const y of ordered)
    for (const m of y.milestones) {
      const want = String.fromCharCode(65 + letter++);
      if (m.id !== want) idx.push({ check: "index_format", itemId: m.id, message: `Milestone "${m.id}" seharusnya ber-index "${want}" (huruf berurutan lintas tahun).` });
      if (!m.arah.length) yrs.push({ check: "years_complete", itemId: m.id, message: `Milestone ${m.id} belum punya arah kerja.` });
      m.arah.forEach((a, k) => {
        const wa = `${m.id}${k + 1}`;
        if (a.id !== wa) idx.push({ check: "index_format", itemId: a.id, message: `Arah kerja "${a.id}" seharusnya ber-index "${wa}".` });
        if (!isMeasurable(a.target))
          meas.push({ check: "measurable", itemId: a.id, message: `Target indikator ${a.id} ("${a.target}") tidak terukur — tulis angka, persentase, atau jumlah beserta waktunya.` });
        const badSi = (a.siRefs ?? []).filter((s) => siIds.size && !siIds.has(s));
        if (badSi.length) refs.push({ check: "ref_exists", itemId: a.id, message: `${a.id} merujuk Strategy Initiative yang tidak ada: ${badSi.join(", ")}.` });
      });
      for (const r of m.misiRefs ?? []) {
        if (misiIds.size && !misiIds.has(r)) refs.push({ check: "ref_exists", itemId: m.id, message: `Milestone ${m.id} merujuk misi ${r} yang tidak ada.` });
        used.add(r);
      }
    }
  for (const m of misi)
    if (!used.has(m.id)) cov.push({ check: "misi_covered", itemId: m.id, message: `Misi ${m.id} ("${m.text}") belum didukung milestone mana pun.` });
  return [
    result("measurable", "code", meas),
    result("misi_covered", "code", cov),
    result("years_complete", "code", yrs),
    result("index_format", "code", idx),
    result("ref_exists", "code", refs),
  ];
}

// ---------- Sheet ----------

const YEAR_FILL = ["F4CCCC", "FFF2CC", "D9EAD3"];
const BASE_FILL = "F3F3F3";

export function renstraSheet(o: RenstraOutput): Grid {
  const g = new GridBuilder("renstra", "LTVMRENSTRA", "Renstra");
  g.row(0, 0, ["VISI RENSTRA", "MISI RENSTRA", "SASARAN UMUM DALAM 3 TAHUN"], { style: "header", fill: "000000" });
  g.set(0, 3, "TARGET TIAP TAHUN", { style: "header", cs: 2, fill: "000000", center: true });
  g.row(0, 5, ["INDEX", "MILESTONE", "INDEX", "ARAH KERJA", "INDIKATOR", "TARGET INDIKATOR"], { style: "header", fill: "000000" });
  const r0 = 1;
  let r = r0;
  const years = sortedYears(o.years);
  years.forEach(({ y, i: yRaw }, yi) => {
    const fill = YEAR_FILL[(y.tahun - 1 + YEAR_FILL.length) % YEAR_FILL.length] ?? YEAR_FILL[yi % 3];
    const yRows = Math.max(1, y.milestones.reduce((s, m) => s + Math.max(1, m.arah.length), 0));
    g.set(r, 3, `TAHUN KE ${y.tahun}`, { style: "label", rs: yRows, fill, center: true });
    g.set(r, 4, y.fokus, { style: "text", rs: yRows, fill, src: "ai", edit: { path: ["years", yRaw, "fokus"], type: "text" } });
    if (!y.milestones.length) {
      g.set(r, 5, "(belum ada milestone)", { style: "muted", cs: 6, fill });
      r++;
      return;
    }
    y.milestones.forEach((m, mi) => {
      const mRows = Math.max(1, m.arah.length);
      const base = ["years", yRaw, "milestones", mi] as (string | number)[];
      g.set(r, 5, `${m.id}.`, { style: "label", rs: mRows, fill, center: true });
      g.set(r, 6, m.text, {
        style: "text",
        rs: mRows,
        fill,
        src: "ai",
        note: m.misiRefs?.length ? `Mendukung misi ${m.misiRefs.join(", ")}` : undefined,
        edit: { path: [...base, "text"], type: "text" },
      });
      if (!m.arah.length) g.set(r, 7, "(belum ada arah kerja)", { style: "muted", cs: 4, fill });
      m.arah.forEach((a, ai) => {
        const ab = [...base, "arah", ai];
        g.set(r + ai, 7, a.id, { style: "label", fill, center: true });
        g.set(r + ai, 8, a.text, { style: "text", fill, src: "ai", note: a.siRefs?.length ? `Menjalankan SI ${a.siRefs.join(", ")}` : undefined, edit: { path: [...ab, "text"], type: "text" } });
        g.set(r + ai, 9, a.indikator, { style: "text", fill, src: "ai", edit: { path: [...ab, "indikator"], type: "text" } });
        g.set(r + ai, 10, a.target, {
          style: "text",
          fill: isMeasurable(a.target) ? fill : "FAD7D7",
          src: "ai",
          note: isMeasurable(a.target) ? undefined : "Target belum terukur (tanpa angka/persentase/jumlah).",
          edit: { path: [...ab, "target"], type: "text" },
        });
      });
      r += mRows;
    });
  });
  const rEnd = Math.max(r, r0 + 1) - 1;
  const total = rEnd - r0 + 1;
  g.set(r0, 0, o.visi || "(visi dari cascading belum ada)", {
    style: "label",
    rs: total,
    fill: BASE_FILL,
    src: "hitung",
    f: o.visi ? "{{cascading!visi}}" : undefined,
    explain: o.visi ? "Visi renstra = visi di sheet Cascading (ubah di sana)." : undefined,
  });
  g.set(r0, 2, o.sasaranUmum, { style: "text", rs: total, fill: BASE_FILL, src: "ai", edit: { path: ["sasaranUmum"], type: "text" } });
  // Misi dibagi rata ke baris (seperti Excel: misi 1 sejajar tahun 1, dst. bila jumlahnya sama).
  const nM = o.misiItems.length;
  if (!nM) g.set(r0, 1, "(misi dari cascading belum ada)", { style: "muted", rs: total, fill: BASE_FILL });
  else {
    const counts = years.length === nM ? years.map(({ y }) => Math.max(1, y.milestones.reduce((s, m) => s + Math.max(1, m.arah.length), 0))) : null;
    let rr = r0;
    o.misiItems.forEach((m, k) => {
      const left = total - (rr - r0);
      const span = k === nM - 1 ? left : counts ? counts[k] : Math.max(1, Math.floor(total / nM) + (k < total % nM ? 1 : 0));
      if (left <= 0) return;
      const s = Math.min(span, left);
      g.set(rr, 1, m.text, {
        style: "text",
        rs: s,
        fill: BASE_FILL,
        src: "hitung",
        f: `{{cascading!misi_${m.aspekId}}}`,
        explain: `Misi ${m.id} = misi aspek ${m.aspekId} (${m.aspek}) di sheet Cascading (ubah di sana).`,
      });
      rr += s;
    });
  }
  return g.build({
    cols: [22, 24, 18, 10, 24, 7, 26, 7, 32, 26, 22],
    freeze: { rows: 1, cols: 0 },
    notes: [
      "Visi dan misi diambil dari Cascading; sasaran umum dipecah menjadi target tiap tahun, milestone (A–F), dan arah kerja (A1, A2, …).",
      "Setiap arah kerja punya indikator dan target yang terukur; target berlatar merah muda belum memuat angka/persentase/jumlah.",
      "Semua teks yang diusulkan AI bisa Anda ubah.",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Index renstra",
    rumus: "Milestone = huruf berurutan lintas tahun (A, B, …); arah kerja = huruf milestone + nomor (A1, A2)",
    arti: "Setiap arah kerja bisa ditelusuri ke milestone, tahun, dan misi yang didukungnya.",
  },
  { name: "Target terukur", rumus: "Target memuat angka / persentase / jumlah (+ waktu)", arti: "Agar capaian tiap tahun bisa dinilai secara objektif." },
];

export const renstra: NodeDef<RenstraRaw> = {
  key: "renstra",
  label: "Renstra",
  phase: 2,
  group: "ltv",
  sheetName: "LTVMRENSTRA",
  deps: ["cascading"],
  kind: "llm",
  computedBy: "LLM menyusun sasaran, target tahunan, milestone, arah kerja, dan indikator; visi & misi diambil dari cascading",
  description:
    "Rencana strategis 3 tahun: visi dan misi dari cascading, sasaran umum, target tiap tahun, milestone (A–F), arah kerja (A1, A2, …), indikator, dan target indikator yang terukur.",
  schema: RenstraRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  queries: () => [{ focus: "renstra", text: "rencana strategis jangka panjang target capaian periode kepengurusan baseline data", k: 5 }],
  prompt: promptOf,
  mock: (ctx) => mockRenstra(ctx.inputs),
  validate: async (out, ctx, llm) => {
    const items = (out.years ?? []).flatMap((y) =>
      y.milestones.flatMap((m) => m.arah.map((a) => ({ id: a.id, text: `${a.text} || indikator: ${a.indikator} || target: ${a.target} (tahun ${y.tahun})` }))),
    );
    return [
      ...renstraCodeChecks(out, ctx.inputs),
      await llmJudge(
        llm,
        "indikator_relevan",
        "Periksa apakah indikator benar-benar mengukur capaian arah kerjanya dan target indikatornya realistis untuk organisasi mahasiswa dalam tahun tersebut.",
        items,
        `Sasaran umum: ${out.sasaranUmum}`,
        (id) => {
          const a = items.find((x) => x.id === id);
          return !a || isMeasurable(a.text.split("target:")[1] ?? "");
        },
      ),
    ];
  },
  compute: (out, ctx) => computeRenstra(out, ctx.inputs),
  items: (out) => {
    const o = asOutput(out, {});
    return [
      { id: "SASARAN", text: o.sasaranUmum, detail: "sasaran umum 3 tahun" },
      ...o.years.flatMap((y) =>
        y.milestones.flatMap((m) => [
          { id: m.id, text: m.text, detail: `milestone tahun ${y.tahun}${m.misiRefs?.length ? ` · misi ${m.misiRefs.join(", ")}` : ""}` },
          ...m.arah.map((a) => ({ id: a.id, text: a.text, detail: `indikator: ${a.indikator}; target: ${a.target}${a.siRefs?.length ? ` · SI ${a.siRefs.join(", ")}` : ""}` })),
        ]),
      ),
    ];
  },
  sheets: (out, ctx) => {
    const o = asOutput(out, ctx.inputs);
    return [renstraSheet(o)];
  },
  blocks: (out, ctx): Block[] => {
    const o = asOutput(out, ctx.inputs);
    return [
      { type: "h2", text: "Rencana strategis (Renstra) 3 tahun" },
      { type: "p", text: `Visi: ${o.visi || "-"}` },
      { type: "bullets", items: o.misi.map((m, k) => `Misi ${k + 1}: ${m}`) },
      { type: "p", text: `Sasaran umum: ${o.sasaranUmum}` },
      {
        type: "table",
        head: ["Tahun", "Milestone", "Index", "Arah kerja", "Indikator", "Target"],
        rows: sortedYears(o.years).flatMap(({ y }) =>
          y.milestones.flatMap((m) =>
            m.arah.map((a, k) => [k === 0 && m === y.milestones[0] ? `Tahun ${y.tahun}: ${y.fokus}` : "", k === 0 ? `${m.id}. ${m.text}` : "", a.id, a.text, a.indikator, a.target]),
          ),
        ),
        widths: [18, 18, 6, 22, 18, 18],
      },
    ];
  },
  summary: (out) => {
    const o = asOutput(out, {});
    return `${o.years.length} tahun, ${o.counts.milestones} milestone, ${o.counts.arah} arah kerja untuk ${o.misi.length || "-"} misi`;
  },
  repairHint: "Perbaiki hanya milestone/arah kerja yang ditolak (index, rujukan, atau target terukur); bagian lain salin apa adanya.",
};
