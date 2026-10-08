// Grand design: kompilasi semua analisis (dokumen/XLSX disusun lib/grand-design + lib/export) dan RINGKASAN EKSEKUTIF.
// LLM hanya menulis ringkasan eksekutif (4–8 kalimat) dari ringkasan dan hasil kunci tiap analisis; setiap kalimat
// wajib merujuk ID elemen yang benar-benar ada. Mode uji: ringkasan deterministik dari hasil yang sama.
import { z } from "zod";
import { ExecSummaryOutput, GrandDesignOutput } from "./schemas";
import type { AnnotItem, NodeContext, NodeDef } from "./types";
import type { CascadingComputed, KontinuitasComputed, MatrixScoreComputed, PosisiComputed, QspmComputedV2, RenstraComputed } from "./contracts";
import { JSON_ONLY, jsonSchemaText, orgLine } from "./prompt";
import { checkTraceComplete } from "@/lib/grand-design/trace";
import { validElementIds, validateSummaryLength, validateSummaryRefs, validateTrace } from "@/lib/validators/phase2";
import { llmJudge } from "@/lib/validators/common";
import { GridBuilder, num, type Block, type Grid } from "@/lib/sheets/grid";

export const GrandDesignNodeOutput = GrandDesignOutput.extend({
  /** Hasil utama tiap analisis (satu kalimat), dasar ringkasan eksekutif. */
  highlights: z.array(z.object({ key: z.string(), label: z.string(), text: z.string() })).default([]),
});
export type GrandDesignNodeOutput = z.infer<typeof GrandDesignNodeOutput>;

type Registry = typeof import("./registry");
// Registry mengimpor file ini; impor dinamis di dalam fungsi menghindari impor melingkar saat modul dimuat.
const loadRegistry = (): Promise<Registry> => import("./registry");

const obj = <T,>(x: unknown) => (x && typeof x === "object" ? (x as T) : undefined);
const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type Facts = {
  /** Baris fakta untuk prompt (memuat ID). */
  lines: string[];
  highlights: { key: string; label: string; text: string }[];
  /** ID butir semua analisis (sah untuk dirujuk). */
  ids: Set<string>;
  /** Kalimat ringkasan mode uji. */
  mock: { text: string; refs: string[] }[];
  /** Jumlah analisis yang tersedia. */
  available: number;
};

/** Kumpulkan hasil kunci dari output analisis yang tersedia (tanpa LLM, deterministik). */
export function collectFacts(ctx: Pick<NodeContext, "inputs" | "projectName">, reg: Pick<Registry, "getNode" | "NODE_KEYS">): Facts {
  const inputs = ctx.inputs as Record<string, unknown>;
  const present = Object.keys(inputs).filter((k) => k !== "grand_design" && inputs[k] !== undefined && inputs[k] !== null);
  const ordered = [
    ...reg.NODE_KEYS.filter((k) => present.includes(k)),
    ...present.filter((k) => !(reg.NODE_KEYS as readonly string[]).includes(k)).sort(),
  ];
  const lines: string[] = [];
  const highlights: Facts["highlights"] = [];
  const ids = new Set<string>();
  const itemsOf: Record<string, AnnotItem[]> = {};
  let customN = 0;
  for (const k of ordered) {
    const out = inputs[k];
    let label = k;
    let items: AnnotItem[] = [];
    let summary: string | null = null;
    try {
      const def = reg.getNode(k);
      label = def.group === "custom" ? `Analisis tambahan ${++customN}` : def.label;
      items = def.items(out) ?? [];
      summary = def.summary?.(out) ?? obj<{ summary?: string }>(out)?.summary ?? null;
    } catch {
      /* output lama/tak terduga: lewati bagian yang gagal dibaca */
    }
    itemsOf[k] = items;
    items.forEach((i) => ids.add(i.id));
    const text = summary?.trim() || (items.length ? `${items.length} butir, antara lain ${items.slice(0, 3).map((i) => `${i.id} ${short(i.text, 60)}`).join("; ")}` : "tersedia");
    highlights.push({ key: k, label, text: short(text, 400) });
    lines.push(`- ${label}: ${short(text, 300)}${items.length ? ` [ID: ${items.slice(0, 12).map((i) => i.id).join(", ")}${items.length > 12 ? ", …" : ""}]` : ""}`);
  }

  const firstId = (k: string) => itemsOf[k]?.[0]?.id;
  const mock: Facts["mock"] = [];
  const push = (text: string, refs: (string | undefined)[]) => {
    const r = [...new Set(refs.filter((x): x is string => !!x))];
    if (r.length && mock.length < 8) mock.push({ text, refs: r });
  };

  // Posisi organisasi (SGSOP)
  const pos = obj<PosisiComputed>(inputs.posisi_organisasi);
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    lines.push(`- Posisi organisasi: IFAS ${num(pos.x)} dan EFAS ${num(pos.y)} → kuadran ${pos.kuadran} (${pos.strategi}), fokus strategi ${pos.fokus}.`);
    push(
      `Hasil IFAS–EFAS menempatkan ${ctx.projectName} di kuadran ${pos.kuadran} (${pos.strategi}) dengan skor IFAS ${num(pos.x)} dan EFAS ${num(pos.y)}, sehingga strategi ${pos.fokus} diutamakan.`,
      [firstId("posisi_organisasi"), firstId("ifas"), firstId("efas")],
    );
  } else {
    const ifas = obj<MatrixScoreComputed>(inputs.ifas);
    const efas = obj<MatrixScoreComputed>(inputs.efas);
    if (ifas && efas && Number.isFinite(ifas.total) && Number.isFinite(efas.total)) {
      lines.push(`- Total IFAS ${num(ifas.total)}, total EFAS ${num(efas.total)}.`);
      push(`Total skor IFAS ${num(ifas.total)} dan EFAS ${num(efas.total)} menjadi dasar penentuan posisi organisasi.`, [firstId("ifas"), firstId("efas")]);
    }
  }

  // QSPM (SGS-QSPM): strategi teratas
  const ranking = [...(obj<QspmComputedV2>(inputs.qspm)?.ranking ?? [])].filter((r) => r && r.id).sort((a, b) => a.rank - b.rank);
  ranking.forEach((r) => ids.add(r.id));
  if (ranking.length) {
    const top = ranking.slice(0, 3);
    lines.push(`- Strategi teratas QSPM: ${top.map((r) => `${r.id} (${r.type}, TAS ${num(r.tas)}): ${short(r.text, 120)}`).join(" | ")}`);
    push(
      `Strategi paling menarik menurut QSPM adalah ${top[0].id} (TAS ${num(top[0].tas)}): ${short(top[0].text, 160)}${top.length > 1 ? `, disusul ${top.slice(1).map((r) => r.id).join(" dan ")}` : ""}.`,
      top.map((r) => r.id),
    );
  }

  // Cascading (SGSCASCADING): visi → misi → SO → SI
  const cas = obj<CascadingComputed>(inputs.cascading);
  if (cas && Array.isArray(cas.aspects)) {
    const sos = cas.aspects.flatMap((a) => a.objectives ?? []);
    const sis = sos.flatMap((o) => o.initiatives ?? []);
    [...cas.aspects, ...sos, ...sis].forEach((x) => x?.id && ids.add(x.id));
    lines.push(`- Visi: ${cas.visi || "-"}`);
    for (const a of cas.aspects.slice(0, 6)) lines.push(`  - ${a.id} ${a.aspek}: misi "${short(a.misi ?? "", 140)}"; SO: ${(a.objectives ?? []).map((o) => o.id).join(", ") || "-"}`);
    if (cas.aspects.length)
      push(
        `Visi "${short(cas.visi || "-", 160)}" diturunkan menjadi ${cas.aspects.length} misi, ${sos.length} sasaran strategis, dan ${sis.length} inisiatif strategis.`,
        cas.aspects.slice(0, 3).map((a) => a.id),
      );
  }

  // Renstra (LTVMRENSTRA)
  const ren = obj<RenstraComputed>(inputs.renstra);
  if (ren && Array.isArray(ren.years) && ren.years.length) {
    const ms = ren.years.flatMap((y) => y.milestones ?? []);
    const arah = ms.flatMap((m) => m.arah ?? []);
    [...ms, ...arah].forEach((x) => x?.id && ids.add(x.id));
    for (const y of ren.years) {
      lines.push(
        `- Renstra tahun ${y.tahun}: fokus ${y.fokus}; ${(y.milestones ?? [])
          .slice(0, 4)
          .map((m) => `${m.id} ${short(m.text, 80)} (target: ${(m.arah ?? []).slice(0, 2).map((a) => `${a.indikator} ${a.target}`).join("; ") || "-"})`)
          .join(" | ")}`,
      );
    }
    push(
      `Renstra ${ren.years.length} tahun menetapkan fokus ${ren.years.map((y) => `${y.tahun}: ${short(y.fokus, 60)}`).join("; ")} dengan ${ms.length} milestone dan ${arah.length} arah kerja bertarget.`,
      ms.slice(0, 3).map((m) => m.id),
    );
  }

  // Kontinuitas proker (SIKONTINUITAS)
  const kon = obj<KontinuitasComputed>(inputs.kontinuitas_proker);
  if (kon && Array.isArray(kon.proker) && kon.proker.length) {
    const count = new Map<string, number>();
    kon.proker.forEach((p) => count.set(p.rekomendasi, (count.get(p.rekomendasi) ?? 0) + 1));
    const txt = [...count].map(([r, n]) => `${n} ${r}`).join(", ");
    lines.push(`- Kontinuitas program kerja: ${txt}.`);
    push(`Dari ${kon.proker.length} program kerja yang dievaluasi, rekomendasinya: ${txt}.`, kon.proker.slice(0, 3).map((p) => p.id));
  }

  // Risiko utama (DM-CRMRM): butir teratas sesuai urutan node
  const risks = itemsOf.risk_management ?? [];
  if (risks.length) {
    lines.push(`- Risiko utama: ${risks.slice(0, 5).map((r) => `${r.id} ${short(r.text, 80)}${r.detail ? ` (${short(r.detail, 80)})` : ""}`).join(" | ")}`);
    push(`Risiko yang perlu dikelola antara lain ${risks.slice(0, 3).map((r) => `${r.id} (${short(r.text, 70)})`).join(", ")}.`, risks.slice(0, 3).map((r) => r.id));
  }

  // Lengkapi hingga minimal 4 kalimat dengan hasil analisis lain.
  for (const h of highlights) {
    if (mock.length >= 4) break;
    if (["posisi_organisasi", "qspm", "cascading", "renstra", "kontinuitas_proker", "risk_management", "ifas", "efas"].includes(h.key)) continue;
    push(`Hasil ${h.label}: ${short(h.text, 200)}`, [firstId(h.key)]);
  }
  return { lines, highlights, ids, mock, available: ordered.length };
}

const SYSTEM = `Kamu penulis dokumen perencanaan strategis organisasi mahasiswa. Tulis RINGKASAN EKSEKUTIF grand design (4–8 kalimat, bahasa Indonesia baku yang mudah dipahami orang awam).
Aturan:
1. Isi hanya berasal dari HASIL ANALISIS yang diberikan (posisi organisasi, strategi teratas QSPM, cascading visi–misi, target renstra, risiko utama, dan ringkasan analisis lain). Jangan menambah klaim, angka, atau program baru.
2. Setiap kalimat WAJIB merujuk minimal satu ID elemen yang ada di hasil analisis (mis. S1, SO2, A1, SI1.1, M1) di "refs". Jangan mengarang ID; jangan menulis nama analisis sebagai ID.
3. Angka ditulis sama persis dengan hasil analisis (koma desimal).
4. Urutan: posisi organisasi → strategi terpilih → visi–misi dan sasaran → target renstra → program/risiko yang perlu dikelola.
5. ${JSON_ONLY}`;

/** Output tersimpan (bisa versi lama/tidak lengkap) → bentuk lengkap dengan nilai aman. */
function asOutput(out: unknown): GrandDesignNodeOutput {
  const p = GrandDesignNodeOutput.safeParse(out);
  if (p.success) return p.data;
  const o = (out ?? {}) as Partial<GrandDesignNodeOutput>;
  return {
    executiveSummary: Array.isArray(o.executiveSummary) ? o.executiveSummary : [],
    highlights: Array.isArray(o.highlights) ? o.highlights : [],
    missingNodes: Array.isArray(o.missingNodes) ? o.missingNodes : [],
    trace: o.trace && typeof o.trace === "object" ? { total: o.trace.total ?? 0, complete: o.trace.complete ?? 0, broken: o.trace.broken ?? [] } : { total: 0, complete: 0, broken: [] },
  };
}

function summarySheet(out: GrandDesignNodeOutput, label: string): Grid {
  const g = new GridBuilder("ringkasan", "GRAND DESIGN", `${label} — ringkasan eksekutif`);
  g.set(0, 0, `${label} — ringkasan eksekutif`, { style: "title", cs: 3 });
  g.set(1, 0, "Disusun AI dari hasil semua analisis; setiap kalimat merujuk ID elemen sehingga bisa ditelusuri ke sheet analisisnya.", {
    style: "note",
    cs: 3,
  });
  let r = 3;
  g.row(r++, 0, ["No", "Kalimat", "Rujukan elemen"], { style: "header" });
  out.executiveSummary.forEach((s, i) => {
    g.set(r, 0, `K${i + 1}`, { style: "label", center: true });
    g.set(r, 1, s.text, { style: "text", src: "ai" });
    g.set(r, 2, s.refs.join(", "), { style: "muted" });
    r++;
  });
  if (!out.executiveSummary.length) g.set(r++, 0, "(belum ada kalimat)", { style: "muted", cs: 3 });
  r++;
  if (out.highlights?.length) {
    g.set(r++, 0, "Hasil utama per analisis", { style: "subheader", cs: 3 });
    g.row(r++, 0, ["No", "Analisis", "Hasil"], { style: "header" });
    out.highlights.forEach((h, i) => {
      g.set(r, 0, i + 1, { style: "int", center: true });
      g.set(r, 1, h.label, { style: "label" });
      g.set(r, 2, h.text, { style: "text", src: "hitung" });
      r++;
    });
    r++;
  }
  g.set(r++, 0, "Ketertelusuran rantai rujukan", { style: "subheader", cs: 3 });
  const t = out.trace;
  g.set(r, 0, "Elemen lengkap", { style: "label", cs: 2 });
  g.set(r, 2, t.total ? t.complete / t.total : null, {
    style: "pct",
    fmt: "0%",
    src: "hitung",
    display: `${t.complete} dari ${t.total}`,
    explain: `Ketertelusuran = elemen yang rantai rujukannya sampai ke kutipan sumber ÷ elemen yang diperiksa = ${t.complete} ÷ ${t.total}${t.total ? ` = ${num((t.complete / t.total) * 100, 0)}%` : ""}.`,
  });
  r++;
  if (t.broken.length) {
    g.row(r++, 0, ["Elemen", "Masalah", ""], { style: "header" });
    for (const b of t.broken) {
      g.set(r, 0, b.id, { style: "label" });
      g.set(r, 1, b.reason, { style: "text", cs: 2 });
      r++;
    }
  }
  if (out.missingNodes.length) {
    r++;
    g.set(r++, 0, `Analisis yang belum ada hasilnya saat ringkasan disusun: ${out.missingNodes.join(", ")}`, { style: "note", cs: 3 });
  }
  return g.build({
    cols: [12, 80, 30],
    notes: [
      "Baca kalimat ringkasan dari atas ke bawah; kolom rujukan menunjuk ID butir di sheet analisis terkait.",
      "Ketertelusuran menunjukkan berapa banyak elemen (strategi, SI, SO, misi, dan butir berujukan) yang rantai rujukannya sampai ke kutipan dokumen.",
    ],
  });
}

export const grandDesign: NodeDef<GrandDesignNodeOutput> = {
  key: "grand_design",
  label: "Grand design",
  phase: 2,
  group: "output",
  sheetName: "GRAND DESIGN",
  // Dijalankan setelah semua analisis lain di canvas (lihat engineGraph); memakai output apa pun yang sudah selesai.
  deps: [],
  kind: "code",
  computedBy: "Kode (templat) + LLM untuk ringkasan eksekutif",
  description:
    "Kompilasi dokumen grand design (DOCX, PDF, XLSX) dari semua analisis; LLM hanya menulis ringkasan eksekutif yang setiap kalimatnya merujuk ID elemen.",
  schema: GrandDesignNodeOutput,
  checks: [
    { name: "summary_refs", kind: "code", description: "Kalimat ringkasan eksekutif merujuk ID elemen yang tidak ada" },
    { name: "summary_length", kind: "code", description: "Ringkasan eksekutif tidak 4–8 kalimat" },
    {
      name: "trace_complete",
      kind: "code",
      description: "Ada strategi, SI, SO, misi, atau butir berujukan yang rantai rujukannya tidak sampai ke kutipan dokumen atau jawaban pengguna",
    },
    { name: "faithful", kind: "llm", description: "Kalimat ringkasan menambah klaim atau angka yang tidak ada di hasil analisis" },
  ],
  run: async (ctx, llm) => {
    const reg = await loadRegistry();
    const f = collectFacts(ctx, reg);
    const summary = await llm.json(
      "generate",
      SYSTEM,
      `${orgLine(ctx)}

HASIL ANALISIS:
${f.lines.join("\n") || "(belum ada hasil analisis)"}

Skema output:
${jsonSchemaText(ExecSummaryOutput)}`,
      ExecSummaryOutput,
      () => ({
        sentences: f.mock.length ? f.mock : [{ text: `Belum ada hasil analisis yang cukup untuk meringkas grand design ${ctx.projectName}.`, refs: ["-"] }],
      }),
    );
    // Node ini tidak tahu isi canvas: yang dianggap "belum ada" = dependensi analisis yang ada, atau anggota
    // kelompok tab yang sebagian analisisnya sudah ada (dokumen hasil memakai status node run yang sebenarnya).
    const builtins = reg.NODE_KEYS.filter((k) => k !== "grand_design");
    const present = builtins.filter((k) => ctx.inputs[k] !== undefined);
    const groups = new Set(present.map((k) => reg.NODES[k].group));
    const needed = new Set(present.flatMap((k) => reg.NODES[k].deps));
    return {
      executiveSummary: summary.sentences,
      highlights: f.highlights,
      missingNodes: builtins
        .filter((k) => ctx.inputs[k] === undefined && (groups.has(reg.NODES[k].group) || needed.has(k)))
        .map((k) => reg.NODES[k].label),
      trace: checkTraceComplete(ctx.inputs as Record<string, unknown>),
    };
  },
  validate: async (out, ctx, llm) => {
    const reg = await loadRegistry();
    const f = collectFacts(ctx, reg);
    const valid = validElementIds(ctx.inputs as Record<string, unknown>, f.ids);
    return [
      validateSummaryRefs(out.executiveSummary, valid),
      validateSummaryLength(out.executiveSummary, f.available),
      validateTrace(ctx.inputs as Record<string, unknown>),
      await llmJudge(
        llm,
        "faithful",
        "Periksa apakah setiap kalimat ringkasan eksekutif DIDUKUNG hasil analisis yang diberikan (angka, ID, kuadran, dan arah strategi sama). Tolak kalimat yang menambah klaim, angka, atau program baru.",
        out.executiveSummary.map((s, i) => ({ id: `K${i + 1}`, text: `${s.text} [rujukan: ${s.refs.join(", ")}]` })),
        f.lines.join("\n"),
      ),
    ];
  },
  items: (out) =>
    ((out as GrandDesignNodeOutput)?.executiveSummary ?? []).map((s, i) => ({ id: `K${i + 1}`, text: s.text, detail: `rujukan: ${s.refs.join(", ")}` })),
  sheets: (out, ctx) => [summarySheet(asOutput(out), ctx.label || "Grand design")],
  blocks: (out) => {
    const o = out as GrandDesignNodeOutput;
    const b: Block[] = [];
    if (o?.executiveSummary?.length) b.push({ type: "p", text: o.executiveSummary.map((s) => `${s.text} [${s.refs.join(", ")}]`).join(" ") });
    if (o?.highlights?.length) b.push({ type: "bullets", items: o.highlights.map((h) => `${h.label}: ${h.text}`) });
    return b;
  },
  formulas: [
    {
      name: "Ketertelusuran",
      rumus: "Ketertelusuran = elemen lengkap ÷ elemen yang diperiksa",
      arti: "Bagian strategi, SI, SO, misi, dan butir berujukan yang rantai rujukannya sampai ke kutipan dokumen atau jawaban pengguna.",
    },
  ],
  summary: (out) => {
    const o = out as GrandDesignNodeOutput;
    const t = o?.trace;
    return `Ringkasan eksekutif ${o?.executiveSummary?.length ?? 0} kalimat; ketertelusuran ${t?.complete ?? 0} dari ${t?.total ?? 0} elemen.`;
  },
};
