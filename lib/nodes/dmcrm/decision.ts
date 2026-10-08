// Decision making (tab DM-CRMDM): tabel Aspek | Deskripsi berisi Kondisi, Konsekuensi, Keputusan, dan Goals, ditambah
// INFLUENCE DIAGRAM (di Excel berupa gambar). Di sini diagram disimpan sebagai tautan antarbutir di output mentah:
// konsekuensi.dariKondisi (kondisi → konsekuensi), keputusan.menangani (kondisi/konsekuensi → keputusan),
// goals.dariKeputusan (keputusan → goal). Kode menyusun diagram, cakupan tiap keputusan, dan butir yang belum ditangani.
import { z } from "zod";
import { Evidence } from "../schemas";
import type { AnnotItem, CheckSpec, Failure, NodeDef } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { isNegative, sentencesOf, toClaim } from "../heuristics";
import type { CascadingComputed, DecisionMakingComputed, RenstraComputed } from "../contracts";
import { checkQuotes, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { arr, citedChunkIds, docChunks, rankedFactors, shortLabel, upstreamIds, upstreamSections, validEvidence } from "./common";

// ---------- Skema output mentah (AI) ----------

const Kondisi = z.object({
  id: z.string(), // "KD1"
  text: z.string(),
  /** Label pendek (2–5 kata) untuk kotak influence diagram. */
  singkat: z.string().default(""),
  /** ID butir analisis sebelumnya yang menjadi dasar (mis. W2, T1). */
  refs: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});
const Konsekuensi = z.object({
  id: z.string(), // "KQ1"
  text: z.string(),
  singkat: z.string().default(""),
  /** Kondisi penyebab (panah kondisi → konsekuensi). */
  dariKondisi: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
});
const Keputusan = z.object({
  id: z.string(), // "DM1"
  text: z.string(),
  singkat: z.string().default(""),
  /** Kondisi dan/atau konsekuensi yang ditangani (panah → keputusan). */
  menangani: z.array(z.string()).default([]),
  alasan: z.string().default(""),
});
const Goal = z.object({
  id: z.string(), // "G1"
  text: z.string(),
  singkat: z.string().default(""),
  /** Keputusan yang mendukung goal ini (panah keputusan → goal). */
  dariKeputusan: z.array(z.string()).default([]),
});

export const DecisionOutput = z.object({
  kondisi: z.array(Kondisi),
  konsekuensi: z.array(Konsekuensi),
  keputusan: z.array(Keputusan),
  goals: z.array(Goal),
});
export type DecisionOutput = z.infer<typeof DecisionOutput>;

// ---------- Hasil hitungan ----------

export type InfluenceKind = "kondisi" | "konsekuensi" | "keputusan" | "goal";
export type InfluenceNode = { id: string; jenis: InfluenceKind; level: 1 | 2 | 3 | 4; label: string; text: string };
export type InfluenceLink = { from: string; to: string; hubungan: "menyebabkan" | "ditangani oleh" | "mendukung" };
export type DecisionCakupan = { id: string; kondisi: string[]; konsekuensi: string[] };

export type DecisionComputed = DecisionOutput & {
  /** Influence diagram: simpul per lapisan (1 kondisi, 2 konsekuensi, 3 keputusan, 4 goals) + panah yang sah. */
  diagram: { nodes: InfluenceNode[]; links: InfluenceLink[] };
  /** Per keputusan: kondisi & konsekuensi yang ditangani (langsung, atau kondisi penyebab konsekuensi yang ditangani). */
  cakupan: DecisionCakupan[];
  /** Kondisi/konsekuensi yang tidak ditangani keputusan mana pun. */
  belumDitangani: string[];
  /** Keputusan yang tidak mendukung goal mana pun. */
  tanpaGoal: string[];
  /** Konsekuensi tanpa kondisi penyebab yang sah. */
  tanpaPenyebab: string[];
};

const ASPEK_LABEL: Record<InfluenceKind, string> = { kondisi: "Kondisi", konsekuensi: "Konsekuensi", keputusan: "Keputusan", goal: "Goals" };
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const labelOf = (x: { singkat?: string; text: string }) => x.singkat?.trim() || shortLabel(x.text, 5);

/** Normalisasi output (mentah atau sudah dihitung, bisa dari versi lama) tanpa melempar galat. */
export function readDecision(x: unknown): DecisionOutput {
  const o = (x ?? {}) as Partial<DecisionOutput>;
  const items = <T extends { id: string; text: string }>(v: unknown) =>
    arr<T>(v).filter((i) => i && typeof i.id === "string" && typeof i.text === "string");
  return {
    kondisi: items<DecisionOutput["kondisi"][number]>(o.kondisi).map((k) => ({ ...k, singkat: k.singkat ?? "", refs: arr<string>(k.refs), evidence: arr(k.evidence) })),
    konsekuensi: items<DecisionOutput["konsekuensi"][number]>(o.konsekuensi).map((k) => ({
      ...k,
      singkat: k.singkat ?? "",
      dariKondisi: arr<string>(k.dariKondisi),
      evidence: arr(k.evidence),
    })),
    keputusan: items<DecisionOutput["keputusan"][number]>(o.keputusan).map((k) => ({ ...k, singkat: k.singkat ?? "", menangani: arr<string>(k.menangani), alasan: k.alasan ?? "" })),
    goals: items<DecisionOutput["goals"][number]>(o.goals).map((g) => ({ ...g, singkat: g.singkat ?? "", dariKeputusan: arr<string>(g.dariKeputusan) })),
  };
}

/** Kalkulator: influence diagram, cakupan keputusan, butir yang belum ditangani. Murni dan tidak pernah melempar galat. */
export function computeDecision(raw: unknown): DecisionComputed {
  const o = readDecision(raw);
  const kd = new Set(o.kondisi.map((k) => k.id));
  const kq = new Set(o.konsekuensi.map((k) => k.id));
  const dm = new Set(o.keputusan.map((k) => k.id));
  const nodes: InfluenceNode[] = [
    ...o.kondisi.map((k) => ({ id: k.id, jenis: "kondisi" as const, level: 1 as const, label: labelOf(k), text: k.text })),
    ...o.konsekuensi.map((k) => ({ id: k.id, jenis: "konsekuensi" as const, level: 2 as const, label: labelOf(k), text: k.text })),
    ...o.keputusan.map((k) => ({ id: k.id, jenis: "keputusan" as const, level: 3 as const, label: labelOf(k), text: k.text })),
    ...o.goals.map((g) => ({ id: g.id, jenis: "goal" as const, level: 4 as const, label: labelOf(g), text: g.text })),
  ];
  const links: InfluenceLink[] = [];
  for (const q of o.konsekuensi) for (const k of uniq(q.dariKondisi)) if (kd.has(k)) links.push({ from: k, to: q.id, hubungan: "menyebabkan" });
  for (const d of o.keputusan) for (const t of uniq(d.menangani)) if (kd.has(t) || kq.has(t)) links.push({ from: t, to: d.id, hubungan: "ditangani oleh" });
  for (const g of o.goals) for (const d of uniq(g.dariKeputusan)) if (dm.has(d)) links.push({ from: d, to: g.id, hubungan: "mendukung" });

  const causes = new Map(o.konsekuensi.map((q) => [q.id, q.dariKondisi.filter((k) => kd.has(k))]));
  const order = new Map(o.kondisi.map((k, i) => [k.id, i]));
  const cakupan: DecisionCakupan[] = o.keputusan.map((d) => {
    const qs = uniq(d.menangani.filter((t) => kq.has(t)));
    const ks = uniq([...d.menangani.filter((t) => kd.has(t)), ...qs.flatMap((q) => causes.get(q) ?? [])]).sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    return { id: d.id, kondisi: ks, konsekuensi: qs };
  });
  const handled = new Set(cakupan.flatMap((c) => [...c.kondisi, ...c.konsekuensi]));
  const supported = new Set(o.goals.flatMap((g) => g.dariKeputusan));
  return {
    ...o,
    diagram: { nodes, links },
    cakupan,
    belumDitangani: [...o.kondisi, ...o.konsekuensi].map((x) => x.id).filter((id) => !handled.has(id)),
    tanpaGoal: o.keputusan.filter((d) => !supported.has(d.id)).map((d) => d.id),
    tanpaPenyebab: o.konsekuensi.filter((q) => !(causes.get(q.id) ?? []).length).map((q) => q.id),
  };
}

// ---------- Mock (tanpa LLM) ----------

/** Tema masalah → konsekuensi dan keputusan baku (mode uji). */
const THEMES: { re: RegExp; kq: string; kqS: string; dm: string; dmS: string }[] = [
  {
    re: /monitor|evaluasi|kinerja|target|okr|terukur/i,
    kq: "Kinerja pengurus dan keberjalanan program kurang terpantau sehingga perbaikan terlambat",
    kqS: "Monitoring & evaluasi kurang",
    dm: "Perancangan dan penerapan sistem monitoring & evaluasi kinerja pengurus",
    dmS: "Sistem monitoring kinerja",
  },
  {
    re: /koordinasi|komunikasi|rapat|informasi|mendadak|pleno/i,
    kq: "Arahan dan pembagian kerja kurang jelas sehingga program sering tertunda",
    kqS: "Pembagian kerja kurang optimal",
    dm: "Pembangunan alur koordinasi dan komunikasi internal yang terstruktur",
    dmS: "Sistem koordinasi terstruktur",
  },
  {
    re: /regenerasi|kader|staf|keaktifan|anggota|sdm|kompetensi|pelatihan|keterampilan|kemampuan/i,
    kq: "Kompetensi dan keberlanjutan pengurus belum terjamin",
    kqS: "Kompetensi pengurus belum optimal",
    dm: "Perancangan sistem pengembangan kompetensi dan kaderisasi berbasis kebutuhan",
    dmS: "Pengembangan kompetensi",
  },
  {
    re: /dokumentasi|laporan|sop|arsip|tata kelola|administrasi|prosedur/i,
    kq: "Akuntabilitas melemah dan pengetahuan organisasi mudah hilang antarperiode",
    kqS: "Akuntabilitas belum optimal",
    dm: "Penyusunan dan standardisasi SOP serta sistem dokumentasi",
    dmS: "Standardisasi SOP",
  },
  {
    re: /anggaran|dana|keuangan|kas|biaya|hibah/i,
    kq: "Program kerja berisiko kekurangan dana",
    kqS: "Pendanaan program terancam",
    dm: "Penguatan perencanaan anggaran dan diversifikasi sumber dana",
    dmS: "Diversifikasi pendanaan",
  },
  {
    re: /kepemimpinan|terpusat|inisiatif|wewenang/i,
    kq: "Staf kurang berinisiatif dan beban keputusan menumpuk pada pimpinan",
    kqS: "Inisiatif staf rendah",
    dm: "Penerapan pendelegasian wewenang dan kepemimpinan partisipatif",
    dmS: "Pendelegasian wewenang",
  },
  {
    re: /pesaing|persaingan|gratis|ukm|komunitas|bootcamp|serupa/i,
    kq: "Daya tarik program organisasi menurun dibanding penyelenggara lain",
    kqS: "Daya tarik program menurun",
    dm: "Penguatan nilai pembeda program unggulan dan kemitraan",
    dmS: "Penguatan program unggulan",
  },
];
const DEFAULT_THEME = {
  re: /.*/,
  kq: "Efektivitas dan akuntabilitas organisasi belum optimal",
  kqS: "Efektivitas belum optimal",
  dm: "Penyusunan rencana perbaikan terarah atas kondisi prioritas",
  dmS: "Rencana perbaikan prioritas",
};
const themeOf = (text: string) => THEMES.find((t) => t.re.test(text)) ?? DEFAULT_THEME;

function mockDecision(ctx: Parameters<NonNullable<NodeDef["mock"]>>[0]): DecisionOutput {
  type K = DecisionOutput["kondisi"][number];
  const kondisi: K[] = [];
  const w = rankedFactors(ctx.inputs, ["W"]).slice(0, 4);
  const t = rankedFactors(ctx.inputs, ["T"]).slice(0, 2);
  for (const f of [...w, ...t]) {
    kondisi.push({
      id: `KD${kondisi.length + 1}`,
      text: f.text,
      singkat: shortLabel(f.text, 4),
      refs: [f.id],
      evidence: validEvidence(f.evidence, ctx.evidence).slice(0, 1),
    });
  }
  if (!kondisi.length) {
    // Tanpa hasil faktor: kalimat bernada masalah dari dokumen menjadi kondisi (kutipan persis).
    const used = new Set<string>();
    for (const c of docChunks(ctx.evidence)) {
      for (const s of sentencesOf(c.content)) {
        if (kondisi.length >= 6 || used.has(s) || !isNegative(s)) continue;
        used.add(s);
        const text = toClaim(s);
        kondisi.push({ id: `KD${kondisi.length + 1}`, text, singkat: shortLabel(text, 4), refs: [], evidence: [{ chunkId: c.id, quote: s }] });
      }
    }
  }
  if (!kondisi.length)
    kondisi.push({ id: "KD1", text: "Data kondisi organisasi belum tersedia di dokumen", singkat: "Data kondisi belum ada", refs: [], evidence: [] });

  // Kelompokkan kondisi per tema → satu konsekuensi dan satu keputusan per tema.
  const groups: { theme: (typeof THEMES)[number]; ids: string[] }[] = [];
  for (const k of kondisi) {
    const th = themeOf(k.text);
    const g = groups.find((x) => x.theme === th);
    if (g) g.ids.push(k.id);
    else groups.push({ theme: th, ids: [k.id] });
  }
  while (groups.length > 6) {
    const last = groups.pop()!;
    groups[groups.length - 1].ids.push(...last.ids);
  }
  const konsekuensi = groups.map((g, i) => ({ id: `KQ${i + 1}`, text: g.theme.kq, singkat: g.theme.kqS, dariKondisi: g.ids, evidence: [] }));
  const keputusan = groups.map((g, i) => ({
    id: `DM${i + 1}`,
    text: g.theme.dm,
    singkat: g.theme.dmS,
    menangani: [`KQ${i + 1}`],
    alasan: `Menjawab ${g.ids.join(", ")} lewat konsekuensi KQ${i + 1} (mode uji).`,
  }));
  const visi = (ctx.inputs.cascading as CascadingComputed | undefined)?.visi ?? (ctx.inputs.renstra as RenstraComputed | undefined)?.visi;
  const goals = [
    {
      id: "G1",
      text: `Terwujudnya ${ctx.projectName} dengan tata kelola yang terstruktur, sistem kerja yang efektif, dan pengurus yang kompeten${typeof visi === "string" && visi ? ` sebagai langkah menuju visi: ${visi}` : ""}.`,
      singkat: "Goals",
      dariKeputusan: keputusan.map((d) => d.id),
    },
  ];
  return { kondisi, konsekuensi, keputusan, goals };
}

// ---------- Validator ----------

const CHECKS: CheckSpec[] = [
  { name: "quote_exists", kind: "code", description: "Kutipan bukti kondisi/konsekuensi benar-benar ada di potongan dokumen yang dirujuk" },
  { name: "grounded", kind: "code", description: "Setiap kondisi punya kutipan dokumen atau rujukan ke hasil analisis sebelumnya (mis. kelemahan W, ancaman T, temuan MSDM)" },
  {
    name: "ref_exists",
    kind: "code",
    description: "Semua rujukan ID ada: kondisi → butir analisis sebelumnya, konsekuensi → kondisi, keputusan → kondisi/konsekuensi, goals → keputusan",
  },
  {
    name: "struktur",
    kind: "code",
    description: "ID unik dengan awalan benar (KD, KQ, DM, G) dan jumlah butir sesuai metode (kondisi 3–8, konsekuensi 2–6, keputusan 2–6, goals 1–2)",
  },
  {
    name: "diagram_lengkap",
    kind: "code",
    description: "Influence diagram tersambung: setiap konsekuensi punya kondisi penyebab, setiap kondisi dan konsekuensi ditangani keputusan, setiap keputusan mendukung goal",
  },
  {
    name: "logika_pengaruh",
    kind: "llm",
    description: "Konsekuensi benar-benar akibat kondisi penyebabnya dan keputusan benar-benar menjawab kondisi/konsekuensi yang ditanganinya",
  },
];

const RANGE: Record<keyof DecisionOutput, { prefix: string; min: number; max: number; label: string }> = {
  kondisi: { prefix: "KD", min: 3, max: 8, label: "kondisi" },
  konsekuensi: { prefix: "KQ", min: 2, max: 6, label: "konsekuensi" },
  keputusan: { prefix: "DM", min: 2, max: 6, label: "keputusan" },
  goals: { prefix: "G", min: 1, max: 2, label: "goals" },
};

function structureFailures(o: DecisionOutput): Failure[] {
  const f: Failure[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(RANGE) as (keyof DecisionOutput)[]) {
    const { prefix, min, max, label } = RANGE[key];
    const xs = o[key];
    if (xs.length < min || xs.length > max)
      f.push({ check: "struktur", message: `Jumlah ${label} ${xs.length}; metode meminta ${min}–${max} butir.` });
    for (const x of xs) {
      if (!new RegExp(`^${prefix}\\d+$`).test(x.id)) f.push({ check: "struktur", itemId: x.id, message: `ID ${label} "${x.id}" harus berbentuk ${prefix}1, ${prefix}2, …` });
      if (seen.has(x.id)) f.push({ check: "struktur", itemId: x.id, message: `ID ${x.id} dipakai lebih dari sekali.` });
      seen.add(x.id);
      if (!x.text.trim()) f.push({ check: "struktur", itemId: x.id, message: `${x.id}: teks ${label} kosong.` });
    }
  }
  return f;
}

// ---------- Sheet ----------

const HEAD = "4A86E8";
const ASPEK_FILL = "C9DAF8";
const LEVEL_FILL: Record<InfluenceKind, string> = { kondisi: "FFF2CC", konsekuensi: "FFF2CC", keputusan: "D9EAD3", goal: "93C47D" };

function decisionSheet(o: DecisionComputed): Grid {
  const g = new GridBuilder("dm", "DM-CRMDM", "Decision making");
  g.set(0, 0, "Aspek", { style: "header", fill: HEAD, center: true });
  g.set(0, 1, "Deskripsi", { style: "header", fill: HEAD, center: true, cs: 2 });
  g.set(0, 3, "Keterkaitan", { style: "header", fill: HEAD, center: true, note: "Tambahan dari aplikasi: rujukan antarbutir yang membentuk influence diagram." });

  const byId = new Map(o.diagram.nodes.map((n) => [n.id, n]));
  const textOf = (id: string) => byId.get(id)?.text ?? "(tidak ada)";
  const cak = new Map(o.cakupan.map((c) => [c.id, c]));
  let r = 1;
  type Row = { id: string; text: string; path: (string | number)[]; link: string; note?: string; refs?: string[] };
  const block = (aspek: string, rows: Row[]) => {
    g.set(r, 0, aspek, { style: "label", fill: ASPEK_FILL, center: true, rs: Math.max(1, rows.length) });
    if (!rows.length) {
      g.set(r, 1, "(belum ada)", { style: "muted", cs: 2 });
      r++;
      return;
    }
    for (const x of rows) {
      g.set(r, 1, x.id, { style: "label", center: true });
      g.set(r, 2, x.text, { style: "text", src: "ai", edit: { path: x.path, type: "text" }, note: x.note, refs: x.refs });
      g.set(r, 3, x.link, { style: "muted" });
      r++;
    }
  };
  const quotes = (evs: { chunkId: string; quote: string }[]) => (evs.length ? evs.map((e) => `[${e.chunkId}] "${e.quote}"`).join("\n") : undefined);
  block(
    "Kondisi",
    o.kondisi.map((k, i) => ({
      id: k.id,
      text: k.text,
      path: ["kondisi", i, "text"],
      link: k.refs.length ? `Dasar: ${k.refs.join(", ")}` : "—",
      note: quotes(k.evidence),
      refs: k.evidence.map((e) => e.chunkId),
    })),
  );
  block(
    "Konsekuensi",
    o.konsekuensi.map((q, i) => ({
      id: q.id,
      text: q.text,
      path: ["konsekuensi", i, "text"],
      link: q.dariKondisi.length ? `Akibat dari: ${q.dariKondisi.join(", ")}` : "Akibat dari: —",
      note: [q.dariKondisi.map((k) => `${k}: ${textOf(k)}`).join("\n"), quotes(q.evidence)].filter(Boolean).join("\n") || undefined,
      refs: q.evidence.map((e) => e.chunkId),
    })),
  );
  block(
    "Keputusan",
    o.keputusan.map((d, i) => ({
      id: d.id,
      text: d.text,
      path: ["keputusan", i, "text"],
      link: d.menangani.length ? `Menangani: ${d.menangani.join(", ")}` : "Menangani: —",
      note: [d.alasan, d.menangani.map((t) => `${t}: ${textOf(t)}`).join("\n")].filter(Boolean).join("\n") || undefined,
    })),
  );
  block(
    "Goals",
    o.goals.map((x, i) => ({
      id: x.id,
      text: x.text,
      path: ["goals", i, "text"],
      link: x.dariKeputusan.length ? `Didukung: ${x.dariKeputusan.join(", ")}` : "Didukung: —",
    })),
  );

  // Cakupan tiap keputusan (di bawah tabel aspek).
  r++;
  g.set(r, 0, "Cakupan keputusan", { style: "subheader", cs: 4 });
  r++;
  g.row(r, 0, ["Keputusan", "Jumlah", "Kondisi & konsekuensi yang ditangani (langsung atau lewat konsekuensinya)", "Mendukung goal"], { style: "header" });
  r++;
  for (const d of o.keputusan) {
    const c = cak.get(d.id) ?? { kondisi: [], konsekuensi: [] };
    const n = c.kondisi.length + c.konsekuensi.length;
    const goals = o.goals.filter((x) => x.dariKeputusan.includes(d.id)).map((x) => x.id);
    g.set(r, 0, d.id, { style: "label", note: d.text });
    g.set(r, 1, n, {
      style: "int",
      src: "hitung",
      center: true,
      explain: `Cakupan ${d.id} = ${c.kondisi.length} kondisi (${c.kondisi.join(", ") || "–"}) + ${c.konsekuensi.length} konsekuensi (${c.konsekuensi.join(", ") || "–"}) = ${n}`,
    });
    g.set(r, 2, [...c.kondisi, ...c.konsekuensi].map((id) => `${id} ${byId.get(id)?.label ?? ""}`.trim()).join("; ") || "—", { style: "text" });
    g.set(r, 3, goals.join(", ") || "—", { style: "muted", fill: goals.length ? undefined : "FAD7D7" });
    r++;
  }
  const open = o.belumDitangani;
  g.set(r, 0, open.length ? `Belum ditangani keputusan: ${open.join(", ")}` : "Semua kondisi dan konsekuensi sudah ditangani minimal satu keputusan.", {
    style: "note",
    cs: 4,
    fill: open.length ? "FAD7D7" : "D9F2E3",
  });

  // INFLUENCE DIAGRAM (E2:L2 di Excel; di sana berupa gambar): peta lapisan + tabel panah.
  g.set(1, 4, "INFLUENCE DIAGRAM", { style: "header", fill: HEAD, center: true, cs: 8 });
  const levels: InfluenceKind[] = ["kondisi", "konsekuensi", "keputusan", "goal"];
  levels.forEach((lv, j) => g.set(2, 4 + j * 2, ASPEK_LABEL[lv], { style: "subheader", center: true, cs: 2 }));
  const perLevel = levels.map((lv) => o.diagram.nodes.filter((n) => n.jenis === lv));
  const depth = Math.max(1, ...perLevel.map((x) => x.length));
  perLevel.forEach((ns, j) =>
    ns.forEach((n, i) =>
      g.set(3 + i, 4 + j * 2, `${n.id} · ${n.label}`, { style: "text", fill: LEVEL_FILL[n.jenis], center: true, cs: 2, note: n.text }),
    ),
  );
  let rl = 3 + depth + 1;
  g.set(rl, 4, "Panah pengaruh (Kondisi → Konsekuensi → Keputusan → Goals)", { style: "subheader", cs: 8 });
  rl++;
  g.set(rl, 4, "Dari", { style: "header" });
  g.set(rl, 5, "Butir asal", { style: "header", cs: 2 });
  g.set(rl, 7, "Hubungan", { style: "header" });
  g.set(rl, 8, "Ke", { style: "header" });
  g.set(rl, 9, "Butir tujuan", { style: "header", cs: 3 });
  rl++;
  for (const l of o.diagram.links) {
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    g.set(rl, 4, l.from, { style: "label", fill: a ? LEVEL_FILL[a.jenis] : undefined });
    g.set(rl, 5, a?.label ?? "", { style: "text", cs: 2, note: a?.text });
    g.set(rl, 7, `${l.hubungan} →`, { style: "muted", center: true });
    g.set(rl, 8, l.to, { style: "label", fill: b ? LEVEL_FILL[b.jenis] : undefined });
    g.set(rl, 9, b?.label ?? "", { style: "text", cs: 3, note: b?.text });
    rl++;
  }
  if (!o.diagram.links.length) g.set(rl, 4, "Belum ada panah: isi rujukan antarbutir.", { style: "note", cs: 8 });

  return g.build({
    cols: [16, 9, 64, 22, 8, 18, 18, 14, 8, 18, 18, 18],
    freeze: { rows: 1, cols: 1 },
    chart: {
      type: "bar",
      title: "Cakupan tiap keputusan (jumlah kondisi + konsekuensi yang ditangani)",
      data: o.cakupan.map((c) => ({ label: c.id, value: c.kondisi.length + c.konsekuensi.length })),
    },
    notes: [
      "Baca dari atas ke bawah: Kondisi (masalah saat ini) → Konsekuensi (akibat bila dibiarkan) → Keputusan (langkah yang diambil) → Goals (hasil akhir yang dituju).",
      "Kolom Keterkaitan dan tabel INFLUENCE DIAGRAM menunjukkan panah pengaruh; misalnya KD1 → KQ2 berarti kondisi KD1 menyebabkan konsekuensi KQ2.",
      "Cakupan = jumlah kondisi dan konsekuensi yang dijawab sebuah keputusan, langsung atau lewat konsekuensi yang ditanganinya. Butir yang belum ditangani ditandai merah.",
      "Teks butir dari AI bisa Anda ubah langsung; diagram dan cakupan dihitung ulang otomatis.",
    ],
  });
}

// ---------- Ringkasan, butir, dokumen ----------

function summaryOf(o: DecisionComputed) {
  const tail = o.belumDitangani.length
    ? `${o.belumDitangani.length} butir belum ditangani keputusan (${o.belumDitangani.join(", ")})`
    : "semua kondisi & konsekuensi tertangani";
  return `${o.kondisi.length} kondisi → ${o.konsekuensi.length} konsekuensi → ${o.keputusan.length} keputusan → ${o.goals.length} goal; ${tail}`;
}

function itemsOf(out: unknown): AnnotItem[] {
  const o = computeDecision(out);
  const cak = new Map(o.cakupan.map((c) => [c.id, c]));
  return [
    ...o.kondisi.map((k) => ({ id: k.id, text: k.text, detail: `Kondisi${k.refs.length ? ` · dasar: ${k.refs.join(", ")}` : ""}` })),
    ...o.konsekuensi.map((q) => ({ id: q.id, text: q.text, detail: `Konsekuensi · akibat dari: ${q.dariKondisi.join(", ") || "–"}` })),
    ...o.keputusan.map((d) => {
      const c = cak.get(d.id);
      return {
        id: d.id,
        text: d.text,
        detail: `Keputusan · menangani: ${d.menangani.join(", ") || "–"} · cakupan ${(c?.kondisi.length ?? 0) + (c?.konsekuensi.length ?? 0)} butir`,
      };
    }),
    ...o.goals.map((x) => ({ id: x.id, text: x.text, detail: `Goals · didukung: ${x.dariKeputusan.join(", ") || "–"}` })),
  ];
}

function blocksOf(o: DecisionComputed): Block[] {
  const byId = new Map(o.diagram.nodes.map((n) => [n.id, n]));
  const rows = [
    ...o.kondisi.map((k) => ["Kondisi", k.id, k.text, k.refs.length ? `dasar: ${k.refs.join(", ")}` : "–"]),
    ...o.konsekuensi.map((q) => ["Konsekuensi", q.id, q.text, `akibat dari: ${q.dariKondisi.join(", ") || "–"}`]),
    ...o.keputusan.map((d) => ["Keputusan", d.id, d.text, `menangani: ${d.menangani.join(", ") || "–"}`]),
    ...o.goals.map((x) => ["Goals", x.id, x.text, `didukung: ${x.dariKeputusan.join(", ") || "–"}`]),
  ];
  const blocks: Block[] = [
    { type: "h2", text: "Decision making" },
    { type: "p", text: summaryOf(o) },
    { type: "table", head: ["Aspek", "ID", "Deskripsi", "Keterkaitan"], rows, widths: [14, 8, 56, 22] },
    { type: "p", text: "Influence diagram (panah pengaruh Kondisi → Konsekuensi → Keputusan → Goals):", italic: true },
    {
      type: "table",
      head: ["Dari", "Hubungan", "Ke"],
      rows: o.diagram.links.map((l) => [`${l.from} ${byId.get(l.from)?.label ?? ""}`.trim(), l.hubungan, `${l.to} ${byId.get(l.to)?.label ?? ""}`.trim()]),
      widths: [40, 20, 40],
    },
  ];
  if (o.belumDitangani.length) blocks.push({ type: "note", text: `Belum ditangani keputusan: ${o.belumDitangani.join(", ")}.` });
  return blocks;
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Influence diagram",
    rumus: "Panah: kondisi → konsekuensi (dariKondisi), kondisi/konsekuensi → keputusan (menangani), keputusan → goal (dariKeputusan)",
    arti: "Diagram pengaruh disusun dari rujukan antarbutir; rujukan ke ID yang tidak ada diabaikan dan dilaporkan pemeriksa.",
  },
  {
    name: "Cakupan keputusan",
    rumus: "Cakupan = kondisi & konsekuensi yang ditangani langsung + kondisi penyebab dari konsekuensi yang ditangani (tanpa duplikat)",
    arti: "Berapa banyak masalah (kondisi) dan akibat (konsekuensi) yang dijawab satu keputusan.",
  },
  {
    name: "Belum ditangani",
    rumus: "Kondisi/konsekuensi yang tidak masuk cakupan keputusan mana pun",
    arti: "Masalah yang belum punya keputusan penanganan — harus kosong agar influence diagram lengkap.",
  },
];

// ---------- Definisi node ----------

export const decisionMaking: NodeDef<DecisionOutput> = {
  key: "decision_making",
  label: "Decision making",
  phase: 2,
  group: "dmcrm",
  sheetName: "DM-CRMDM",
  deps: [],
  kind: "llm",
  description:
    "Kondisi (masalah nyata), konsekuensinya, keputusan yang diambil, dan goals, beserta influence diagram yang menghubungkan keempatnya.",
  computedBy: "LLM (isi & tautan) + kode (influence diagram, cakupan keputusan)",
  schema: DecisionOutput,
  checks: CHECKS,
  queries: () => [
    { focus: "masalah organisasi", text: "masalah kendala kelemahan kinerja pengurus staf belum optimal evaluasi", k: 6 },
    { focus: "tata kelola", text: "tata kelola koordinasi komunikasi SOP dokumentasi pembagian kerja struktur", k: 5 },
    { focus: "dampak", text: "dampak akibat program tertunda terhambat menurun kualitas kepercayaan", k: 4 },
    { focus: "SDM", text: "survei anggota keaktifan kepuasan pengembangan kompetensi pelatihan regenerasi", k: 5 },
    { focus: "arah perbaikan", text: "rencana perbaikan keputusan rapat disepakati tujuan visi sasaran", k: 4 },
  ],
  extraChunkIds: (ctx) => citedChunkIds(rankedFactors(ctx.inputs, ["W", "T"]).slice(0, 8), 12),
  prompt: (ctx) => {
    const sections = upstreamSections(ctx.inputs, { quadrants: ["W", "T"], skip: ctx.parents });
    return {
      system: `Kamu analis pengambilan keputusan (decision making) organisasi mahasiswa. Susun tabel DECISION MAKING (tab DM-CRMDM) berisi empat aspek dan INFLUENCE DIAGRAM yang menghubungkannya, HANYA berdasarkan hasil analisis sebelumnya dan potongan dokumen.

Aspek:
1. KONDISI (3–8 butir, ID KD1, KD2, …): permasalahan nyata organisasi saat ini yang perlu diputuskan penanganannya. Ambil dari kelemahan (W) dan ancaman (T) hasil analisis sebelumnya serta temuan dokumen (evaluasi, survei, MSDM). Tulis ringkas, mis. "Sistem pengukuran dan monitoring kinerja staf belum optimal". refs = ID butir analisis sebelumnya yang menjadi dasar (mis. W2, T1). evidence = kutipan dokumen.
2. KONSEKUENSI (2–6 butir, ID KQ1, …): akibat yang muncul bila kondisi dibiarkan. dariKondisi = ID kondisi penyebab (minimal satu; satu konsekuensi boleh disebabkan beberapa kondisi).
3. KEPUTUSAN (2–6 butir, ID DM1, …): langkah strategis yang diputuskan untuk menangani konsekuensi dan kondisinya, berbentuk perancangan/penerapan sistem atau program (mis. "Perancangan dan penerapan sistem monitoring & evaluasi kinerja staf"). menangani = ID konsekuensi dan/atau kondisi yang ditangani. alasan = alasan singkat mengapa keputusan ini dipilih.
4. GOALS (1–2 butir, ID G1, …): keadaan akhir yang ingin dicapai bila keputusan dijalankan, selaras dengan visi/sasaran organisasi. dariKeputusan = ID keputusan yang mendukungnya.

INFLUENCE DIAGRAM dibentuk dari rujukan di atas: Kondisi → Konsekuensi → Keputusan → Goals. Pastikan:
- setiap konsekuensi punya kondisi penyebab;
- setiap kondisi dan konsekuensi ditangani minimal satu keputusan (langsung, atau lewat konsekuensi yang ditangani);
- setiap keputusan mendukung minimal satu goal;
- hanya merujuk ID yang ada.
singkat = label pendek 2–5 kata untuk kotak diagram (mis. "Kinerja belum optimal").

Bukti: ${EVIDENCE_RULES}
Aturan bukti berlaku untuk KONDISI (dan konsekuensi yang memuat fakta). Kondisi yang disimpulkan dari analisis sebelumnya boleh tanpa kutipan, tetapi WAJIB menulis refs. Jangan mengarang fakta atau ID.
${JSON_ONLY}`,
      user: `${orgLine(ctx)}

Hasil analisis sebelumnya (dasar kondisi; rujuk ID-nya di refs):
${sections.length ? sections.join("\n\n") : "(belum ada — gunakan potongan dokumen)"}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(DecisionOutput)}`,
    };
  },
  mock: mockDecision,
  validate: async (out, ctx, llm) => {
    const o = computeDecision(out);
    const kd = new Set(o.kondisi.map((k) => k.id));
    const kq = new Set(o.konsekuensi.map((k) => k.id));
    const dm = new Set(o.keputusan.map((k) => k.id));
    const up = upstreamIds(ctx.inputs, ["decision_making"]);
    const refFail: Failure[] = [];
    const bad = (itemId: string, ids: string[], ok: (id: string) => boolean, what: string) => {
      const b = ids.filter((x) => !ok(x));
      if (b.length) refFail.push({ check: "ref_exists", itemId, message: `${itemId} merujuk ${what} yang tidak ada: ${b.join(", ")}.` });
    };
    for (const k of o.kondisi) bad(k.id, k.refs, (x) => up.has(x), "butir analisis sebelumnya");
    for (const q of o.konsekuensi) bad(q.id, q.dariKondisi, (x) => kd.has(x), "kondisi");
    for (const d of o.keputusan) bad(d.id, d.menangani, (x) => kd.has(x) || kq.has(x), "kondisi/konsekuensi");
    for (const x of o.goals) bad(x.id, x.dariKeputusan, (y) => dm.has(y), "keputusan");

    const diag: Failure[] = [
      ...o.tanpaPenyebab.map((id) => ({ check: "diagram_lengkap", itemId: id, message: `Konsekuensi ${id} belum punya kondisi penyebab (isi dariKondisi).` })),
      ...o.belumDitangani.map((id) => ({
        check: "diagram_lengkap",
        itemId: id,
        message: `${kd.has(id) ? "Kondisi" : "Konsekuensi"} ${id} belum ditangani keputusan mana pun (tambahkan ID-nya ke "menangani" sebuah keputusan).`,
      })),
      ...o.tanpaGoal.map((id) => ({ check: "diagram_lengkap", itemId: id, message: `Keputusan ${id} belum mendukung goal mana pun (tambahkan ke dariKeputusan sebuah goal).` })),
      ...(o.keputusan.length && !o.goals.length ? [{ check: "diagram_lengkap", message: "Goals belum diisi." }] : []),
    ];
    const textOf = new Map(o.diagram.nodes.map((n) => [n.id, n.text]));
    return [
      checkQuotes([...o.kondisi, ...o.konsekuensi].filter((x) => x.evidence.length), ctx.evidence),
      result(
        "grounded",
        "code",
        o.kondisi
          .filter((k) => !k.evidence.length && !k.refs.length)
          .map((k) => ({ check: "grounded", itemId: k.id, message: `Kondisi ${k.id} tidak punya kutipan dokumen maupun rujukan ke analisis sebelumnya.` })),
      ),
      result("ref_exists", "code", refFail),
      result("struktur", "code", structureFailures(o)),
      result("diagram_lengkap", "code", diag),
      await llmJudge(
        llm,
        "logika_pengaruh",
        "Periksa logika influence diagram: konsekuensi harus merupakan akibat masuk akal dari kondisi penyebabnya, dan keputusan harus benar-benar menjawab kondisi/konsekuensi yang ditanganinya.",
        [
          ...o.konsekuensi.map((q) => ({ id: q.id, text: `Konsekuensi "${q.text}" | disebabkan oleh: ${q.dariKondisi.map((k) => `${k} = ${textOf.get(k) ?? "?"}`).join("; ") || "–"}` })),
          ...o.keputusan.map((d) => ({ id: d.id, text: `Keputusan "${d.text}" | menangani: ${d.menangani.map((t) => `${t} = ${textOf.get(t) ?? "?"}`).join("; ") || "–"}` })),
        ],
        `${orgLine(ctx)}\nGoals: ${o.goals.map((x) => x.text).join("; ")}`,
      ),
    ];
  },
  repairHint: "Perbaiki hanya butir yang ditolak (teks, rujukan, atau bukti); butir lain dan ID-nya salin apa adanya.",
  compute: (out): DecisionMakingComputed => computeDecision(out),
  items: itemsOf,
  sheets: (out: unknown) => [decisionSheet(computeDecision(out))],
  blocks: (out: unknown) => blocksOf(computeDecision(out)),
  formulas: FORMULAS,
  summary: (out) => summaryOf(computeDecision(out)),
};
