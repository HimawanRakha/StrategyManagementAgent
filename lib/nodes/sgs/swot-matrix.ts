// SGSSWOT-SM — Matriks SWOT: strategi SO / WO / ST / WT yang menggabungkan kode faktor (mis. "S1 + S2 + O1 …").
import { z } from "zod";
import type { StrategyType } from "../contracts";
import type { CheckResult, Failure, NodeContext, NodeDef } from "../types";
import { JSON_ONLY, jsonSchemaText, orgLine } from "../prompt";
import { llmJudge, norm, overlap, result } from "@/lib/validators/common";
import { GridBuilder, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import {
  QUADRANT_LABEL,
  STRATEGY_TYPES,
  TYPE_INFO,
  clip,
  cleanRefs,
  factorsOf,
  isObj,
  lcFirst,
  posisiOf,
  quadrantOf,
  strategyCode,
  typeOfId,
  type FactorLite,
  type Inputs,
} from "./common";

/** Kode faktor: daftar ID, atau teks "S1 + S2 + O1" (dari sel yang diedit pengguna) yang diurai menjadi daftar. */
const FactorRefs = z.preprocess(
  (v) => (typeof v === "string" ? v.split(/[^A-Za-z0-9]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) : v),
  z.array(z.string()),
);

export const SwotStrategyRaw = z.object({
  /** "SO1", "WO2", "ST1", "WT3" — nomor urut per tipe. */
  id: z.string(),
  type: z.enum(["SO", "WO", "ST", "WT"]),
  /** Kode faktor yang digabung, mis. ["S1","S2","O1"]: minimal satu faktor internal dan satu eksternal sesuai tipe. */
  factorRefs: FactorRefs,
  /** Kalimat strategi (tanpa kode faktor di depannya). */
  text: z.string(),
});
export const SwotMatrixRaw = z.object({ strategies: z.array(SwotStrategyRaw) });
export type SwotMatrixRaw = z.infer<typeof SwotMatrixRaw>;

export type SwotStrategyOut = SwotMatrixRaw["strategies"][number] & { code: string; label: string };
export type SwotMatrixOutput = {
  strategies: SwotStrategyOut[];
  counts: Record<StrategyType, number>;
  fokus: StrategyType | null;
  /** "Kuadran II — Diversifikasi" bila posisi organisasi tersedia. */
  posisi: string | null;
};

export function computeSwotMatrix(raw: SwotMatrixRaw, inputs: Inputs): SwotMatrixOutput {
  const strategies = (raw?.strategies ?? []).map((s) => {
    const refs = cleanRefs(s.factorRefs);
    const code = strategyCode(refs);
    return { ...s, factorRefs: refs, code, label: code ? `${code} ${s.text}` : s.text };
  });
  const counts = Object.fromEntries(STRATEGY_TYPES.map((t) => [t, strategies.filter((s) => s.type === t).length])) as Record<StrategyType, number>;
  const pos = posisiOf(inputs);
  return { ...raw, strategies, counts, fokus: pos?.fokus ?? null, posisi: pos ? `Kuadran ${pos.kuadran} — ${pos.strategi}` : null };
}

const asOutput = (out: unknown, inputs: Inputs): SwotMatrixOutput => {
  const o = isObj(out) ? (out as Partial<SwotMatrixOutput>) : {};
  if (o.counts && Array.isArray(o.strategies)) return o as SwotMatrixOutput;
  return computeSwotMatrix({ strategies: Array.isArray(o.strategies) ? (o.strategies as SwotMatrixRaw["strategies"]) : [] }, inputs);
};

// ---------- Prompt ----------

const factorLine = (f: FactorLite) => `${f.id} [${f.quadrant}${f.category ? `, ${f.category}` : ""}] ${f.text} (bobot ${f.bobot.toFixed(3)})`;

function promptOf(ctx: NodeContext) {
  const factors = factorsOf(ctx.inputs);
  const pos = posisiOf(ctx.inputs);
  const fokus = pos?.fokus;
  const posLine = pos
    ? `Posisi organisasi (diagram SWOT): kuadran ${pos.kuadran} — ${pos.strategi}; IFAS ${pos.x.toFixed(3)}, EFAS ${pos.y.toFixed(3)}. Strategi yang DIUTAMAKAN: ${fokus}. Buat strategi ${fokus} paling banyak dan paling kuat (3–6 strategi), tipe lain tetap ada (2–4 strategi).`
    : "Posisi organisasi belum tersedia: buat 2–5 strategi untuk setiap tipe.";
  return {
    system: `Kamu analis strategi organisasi. Susun MATRIKS SWOT (SWOT Strategy Matrix): rumuskan strategi dengan MENGGABUNGKAN faktor internal dan eksternal.
Kriteria tipe strategi:
- SO: gunakan kekuatan (S) untuk meraih peluang (O). (${TYPE_INFO.SO.criteria})
- WO: perbaiki kelemahan (W) dengan memanfaatkan peluang (O). (${TYPE_INFO.WO.criteria})
- ST: gunakan kekuatan (S) untuk menghindari/mengurangi dampak ancaman (T). (${TYPE_INFO.ST.criteria})
- WT: taktik bertahan untuk mengurangi kelemahan (W) dan menghindari ancaman (T). (${TYPE_INFO.WT.criteria})
Aturan:
1. Setiap strategi menulis factorRefs = kode faktor yang benar-benar digabung (2–4 kode), minimal SATU faktor internal dan SATU eksternal sesuai tipe: SO → S dan O saja; WO → W dan O saja; ST → S dan T saja; WT → W dan T saja.
2. Hanya pakai kode faktor yang ada di daftar. Utamakan faktor berbobot tinggi; usahakan setiap faktor penting terpakai minimal sekali.
3. text = satu kalimat strategi yang konkret dan dapat dilaksanakan (diawali kata kerja, mis. "Memperkuat …", "Menyusun …"), menjelaskan bagaimana faktor-faktor itu digabung. JANGAN menulis kode faktor di dalam text (kode ditulis di factorRefs dan ditampilkan otomatis di depan kalimat).
4. ID per tipe berurutan: SO1, SO2, …, WO1, …, ST1, …, WT1, …. Tidak boleh ada strategi ganda.
5. Total strategi 8–18 (semua akan dinilai di QSPM).
6. ${JSON_ONLY}`,
    user: `${orgLine(ctx)}
${posLine}

Faktor internal dan eksternal (bobot = bobot AHP):
${factors.length ? factors.map(factorLine).join("\n") : "(belum ada faktor)"}

Skema output:
${jsonSchemaText(SwotMatrixRaw)}`,
  };
}

// ---------- Mock ----------

const TEMPLATES: Record<StrategyType, (i: string, e: string) => string> = {
  SO: (i, e) => `Memanfaatkan kekuatan (${i}) untuk meraih peluang (${e}).`,
  WO: (i, e) => `Memperbaiki kelemahan (${i}) dengan memanfaatkan peluang (${e}).`,
  ST: (i, e) => `Menggunakan kekuatan (${i}) untuk menghadapi ancaman (${e}).`,
  WT: (i, e) => `Mengurangi kelemahan (${i}) agar tidak diperparah ancaman (${e}).`,
};

export function mockSwotMatrix(inputs: Inputs): SwotMatrixRaw {
  const factors = factorsOf(inputs);
  const fokus = posisiOf(inputs)?.fokus;
  const byQ = (q: string) => factors.filter((f) => f.quadrant === q).sort((a, b) => b.bobot - a.bobot);
  const strategies: SwotMatrixRaw["strategies"] = [];
  for (const type of STRATEGY_TYPES) {
    const I = byQ(TYPE_INFO[type].internal);
    const E = byQ(TYPE_INFO[type].external);
    if (!I.length || !E.length) continue;
    const n = Math.min(type === fokus ? 3 : 2, Math.max(I.length, E.length));
    for (let k = 0; k < n; k++) {
      const i1 = I[k % I.length];
      const i2 = I.length > 1 ? I[(k + 1) % I.length] : null;
      const e1 = E[k % E.length];
      const refs = [i1.id, ...(i2 && i2.id !== i1.id ? [i2.id] : []), e1.id];
      strategies.push({ id: `${type}${k + 1}`, type, factorRefs: refs, text: TEMPLATES[type](lcFirst(clip(i1.text, 70)), lcFirst(clip(e1.text, 70))) });
    }
  }
  return { strategies };
}

// ---------- Validator ----------

const CHECKS = [
  { name: "ref_exists", kind: "code" as const, description: "Strategi merujuk kode faktor yang tidak ada di Faktor S+W / O+T" },
  { name: "ref_type_match", kind: "code" as const, description: "Kode faktor tidak sesuai tipe strategi (mis. SO wajib memakai minimal satu S dan satu O, tanpa W/T)" },
  { name: "id_format", kind: "code" as const, description: "ID strategi tidak sesuai tipenya, tidak berurutan, atau ganda (format SO1, WO2, ST1, WT3)" },
  { name: "no_duplicate", kind: "code" as const, description: "Ada strategi ganda (kalimat sama atau hampir sama dalam tipe yang sama)" },
  { name: "type_coverage", kind: "code" as const, description: "Ada tipe strategi (SO, WO, ST, WT) yang kosong padahal faktornya tersedia" },
  { name: "combines_factors", kind: "llm" as const, description: "Kalimat strategi tidak benar-benar menggabungkan faktor yang dirujuknya" },
];

export function codeChecks(out: SwotMatrixRaw, inputs: Inputs): CheckResult[] {
  const factors = factorsOf(inputs);
  const valid = new Set(factors.map((f) => f.id));
  const strategies = out.strategies ?? [];
  const exist: Failure[] = [];
  const match: Failure[] = [];
  const ids: Failure[] = [];
  const dup: Failure[] = [];
  const cov: Failure[] = [];
  const seen = new Map<string, number>();
  const perType: Record<string, number[]> = {};
  for (const s of strategies) {
    const refs = cleanRefs(s.factorRefs);
    if (valid.size) {
      const bad = refs.filter((r) => !valid.has(r));
      if (bad.length) exist.push({ check: "ref_exists", itemId: s.id, message: `${s.id} merujuk faktor yang tidak ada: ${bad.join(", ")}.` });
    }
    const info = TYPE_INFO[s.type];
    const qs = refs.map((r) => quadrantOf(r));
    const wrong = refs.filter((_, i) => qs[i] !== info.internal && qs[i] !== info.external);
    const lacks = [info.internal, info.external].filter((q) => !qs.includes(q));
    if (wrong.length || lacks.length)
      match.push({
        check: "ref_type_match",
        itemId: s.id,
        message: `${s.id} (${s.type}) harus memakai minimal satu faktor ${info.internal} dan satu ${info.external}${wrong.length ? `; kode ${wrong.join(", ")} tidak sesuai tipe ini` : ""}${lacks.length ? `; belum ada faktor ${lacks.join(" dan ")}` : ""}.`,
      });
    const t = typeOfId(s.id);
    if (t !== s.type || !/^(SO|WO|ST|WT)\d+$/.test(s.id))
      ids.push({ check: "id_format", itemId: s.id, message: `ID ${s.id} tidak sesuai tipe ${s.type} (format ${s.type}1, ${s.type}2, …).` });
    seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    if (t === s.type) (perType[s.type] ??= []).push(Number(s.id.slice(2)));
  }
  for (const [id, n] of seen) if (n > 1) ids.push({ check: "id_format", itemId: id, message: `ID ${id} dipakai ${n} kali.` });
  for (const [type, nums] of Object.entries(perType)) {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1)) ids.push({ check: "id_format", itemId: type, message: `Nomor strategi ${type} tidak berurutan (${sorted.join(", ")}); seharusnya ${type}1, ${type}2, ….` });
  }
  for (let i = 0; i < strategies.length; i++)
    for (let j = i + 1; j < strategies.length; j++) {
      const a = strategies[i];
      const b = strategies[j];
      if (a.type !== b.type) continue;
      if (norm(a.text) === norm(b.text) || overlap(a.text, b.text) >= 0.85)
        dup.push({ check: "no_duplicate", itemId: b.id, message: `${b.id} hampir sama dengan ${a.id}; gabungkan atau bedakan isinya.` });
    }
  const have = new Set(factors.map((f) => f.quadrant));
  for (const type of STRATEGY_TYPES) {
    const info = TYPE_INFO[type];
    if (have.has(info.internal) && have.has(info.external) && !strategies.some((s) => s.type === type))
      cov.push({ check: "type_coverage", itemId: type, message: `Belum ada strategi ${type} (${info.arti})` });
  }
  return [
    result("ref_exists", "code", exist),
    result("ref_type_match", "code", match),
    result("id_format", "code", ids),
    result("no_duplicate", "code", dup),
    result("type_coverage", "code", cov),
  ];
}

// ---------- Sheet ----------

const listCell = (title: string, fs: FactorLite[]) => `${title}\n${fs.length ? fs.map((f) => `${f.id}. ${f.text}`).join("\n") : "(belum ada faktor)"}`;

export function swotSheet(o: SwotMatrixOutput, inputs: Inputs): Grid {
  const factors = factorsOf(inputs);
  const byQ = (q: string) => factors.filter((f) => f.quadrant === q);
  const g = new GridBuilder("swot", "SGSSWOT-SM", "SWOT Matrix");
  const W = 7;
  g.set(0, 0, "SWOT MATRIX", { style: "title", cs: W });
  if (o.fokus) g.set(1, 0, `Posisi organisasi: ${o.posisi ?? "-"} → strategi ${o.fokus} diutamakan.`, { style: "note", cs: W });
  const DARK = "002060";
  const MID = "0070C0";
  g.set(2, 0, "SWOT MATRIX", { style: "header", fill: DARK, center: true });
  g.set(2, 1, listCell("Strength", byQ("S")), { style: "text", fill: DARK, cs: 3, src: "ai", note: "Daftar faktor S dari Faktor S+W (ubah di sana)." });
  g.set(2, 4, listCell("Weakness", byQ("W")), { style: "text", fill: DARK, cs: 3, src: "ai", note: "Daftar faktor W dari Faktor S+W (ubah di sana)." });
  const idx = new Map(o.strategies.map((s, i) => [s, i]));
  let r = 3;
  const block = (ext: "O" | "T", left: StrategyType, right: StrategyType) => {
    const L = o.strategies.filter((s) => s.type === left);
    const R = o.strategies.filter((s) => s.type === right);
    const n = Math.max(1, L.length, R.length);
    g.set(r, 0, listCell(QUADRANT_LABEL[ext], byQ(ext)), { style: "text", fill: DARK, rs: n + 2, src: "ai", note: `Daftar faktor ${ext} dari Faktor O+T (ubah di sana).` });
    g.set(r, 1, `${left} Strategy`, { style: "header", fill: MID, cs: 3, note: TYPE_INFO[left].criteria });
    g.set(r, 4, `${right} Strategy`, { style: "header", fill: MID, cs: 3, note: TYPE_INFO[right].criteria });
    g.row(r + 1, 1, ["No", "Kode faktor", "Strategi", "No", "Kode faktor", "Strategi"], { style: "subheader" });
    const put = (list: typeof L, c: number, type: StrategyType) => {
      if (!list.length) {
        g.set(r + 2, c, `(belum ada strategi ${type})`, { style: "muted", cs: 3 });
        return;
      }
      list.forEach((s, k) => {
        const i = idx.get(s)!;
        g.set(r + 2 + k, c, s.id, { style: "label", src: "ai" });
        g.set(r + 2 + k, c + 1, s.code, {
          src: "ai",
          note: s.factorRefs.map((id) => `${id}: ${factors.find((f) => f.id === id)?.text ?? "(faktor tidak ditemukan)"}`).join("\n"),
          edit: { path: ["strategies", i, "factorRefs"], type: "text" },
        });
        g.set(r + 2 + k, c + 2, s.text, { style: "text", src: "ai", edit: { path: ["strategies", i, "text"], type: "text" } });
      });
    };
    put(L, 1, left);
    put(R, 4, right);
    r += n + 2;
  };
  block("O", "SO", "WO");
  block("T", "ST", "WT");

  r += 1;
  g.set(r, 0, "Criteria", { style: "subheader", cs: W });
  for (const t of STRATEGY_TYPES) {
    r++;
    g.set(r, 0, TYPE_INFO[t].criteria, { style: "text", cs: 4, src: "tetap" });
    g.set(r, 4, `${t}: ${TYPE_INFO[t].arti}`, { style: "muted", cs: 3, src: "tetap" });
  }
  return g.build({
    cols: [40, 6, 14, 46, 6, 14, 46],
    notes: [
      "Baris = faktor eksternal (Opportunity, Threat), kolom = faktor internal (Strength, Weakness); pertemuannya berisi strategi SO, WO, ST, WT.",
      "Kode faktor di depan strategi (mis. S1 + S2 + O1) menunjukkan faktor yang digabung. Anda bisa mengubah kodenya (pisahkan dengan +) atau kalimat strateginya.",
      "Semua strategi di sini akan dinilai daya tariknya di QSPM.",
    ],
  });
}

const FORMULAS: FormulaDoc[] = [
  {
    name: "Strategi SWOT",
    rumus: "Strategi = gabungan ≥ 1 faktor internal (S/W) + ≥ 1 faktor eksternal (O/T) sesuai tipe",
    arti: "SO memakai kekuatan untuk peluang, WO memperbaiki kelemahan lewat peluang, ST memakai kekuatan menghadapi ancaman, WT bertahan dari ancaman sambil mengurangi kelemahan.",
  },
];

export const swotMatrix: NodeDef<SwotMatrixRaw> = {
  key: "swot_matrix",
  label: "Matriks SWOT",
  phase: 1,
  group: "sgs",
  sheetName: "SGSSWOT-SM",
  deps: ["faktor_internal", "faktor_eksternal"],
  kind: "llm",
  computedBy: "LLM merumuskan strategi; kode memeriksa rujukan dan tipe faktor",
  description: "Strategi SO, WO, ST, WT yang menggabungkan kode faktor S/W/O/T (mis. S1 + S2 + O1), dengan penekanan pada kuadran posisi organisasi.",
  schema: SwotMatrixRaw,
  checks: CHECKS,
  formulas: FORMULAS,
  prompt: promptOf,
  mock: (ctx) => mockSwotMatrix(ctx.inputs),
  validate: async (out, ctx, llm) => {
    const factors = factorsOf(ctx.inputs);
    const text = new Map(factors.map((f) => [f.id, f.text]));
    const strategies = out.strategies ?? [];
    return [
      ...codeChecks(out, ctx.inputs),
      await llmJudge(
        llm,
        "combines_factors",
        "Periksa apakah setiap strategi BENAR-BENAR menggabungkan faktor yang dirujuknya: isi strategi harus memakai/menjawab setiap faktor internal dan eksternal yang disebut (bukan sekadar menempelkan kode), dan sesuai tipe (SO/WO/ST/WT).",
        strategies.map((s) => ({
          id: s.id,
          text: `[${s.type}] ${s.text} || Faktor dirujuk: ${cleanRefs(s.factorRefs).map((r) => `${r} = ${text.get(r) ?? "(tidak ada)"}`).join("; ")}`,
        })),
        `Faktor organisasi:\n${factors.map((f) => `${f.id}: ${f.text}`).join("\n")}`,
        (id) => {
          const s = strategies.find((x) => x.id === id);
          if (!s) return true;
          const refs = cleanRefs(s.factorRefs);
          const int = refs.filter((r) => /^[SW]/.test(r));
          const ext = refs.filter((r) => /^[OT]/.test(r));
          const hit = (rs: string[]) => !rs.length || rs.some((r) => overlap(s.text, text.get(r) ?? "") > 0);
          return hit(int) && hit(ext);
        },
      ),
    ];
  },
  compute: (out, ctx) => computeSwotMatrix(out, ctx.inputs),
  items: (out) =>
    asOutput(out, {}).strategies.map((s) => ({ id: s.id, text: s.label, detail: `${s.type} · faktor ${s.factorRefs.join(", ")}` })),
  sheets: (out, ctx) => [swotSheet(asOutput(out, ctx.inputs), ctx.inputs)],
  blocks: (out, ctx): Block[] => {
    const o = asOutput(out, ctx.inputs);
    return [
      { type: "h2", text: "Matriks SWOT" },
      {
        type: "p",
        text: `${o.strategies.length} strategi alternatif: ${STRATEGY_TYPES.map((t) => `${o.counts[t]} ${t}`).join(", ")}${o.fokus ? `; strategi ${o.fokus} diutamakan sesuai posisi organisasi` : ""}.`,
      },
      {
        type: "table",
        head: ["ID", "Tipe", "Kode faktor", "Strategi"],
        rows: o.strategies.map((s) => [s.id, s.type, s.code, s.text]),
        widths: [8, 8, 18, 66],
      },
    ];
  },
  summary: (out) => {
    const o = asOutput(out, {});
    return `${o.strategies.length} strategi: ${STRATEGY_TYPES.map((t) => `${o.counts[t]} ${t}`).join(", ")}`;
  },
  repairHint: "Perbaiki hanya strategi yang ditolak (kode faktor, tipe, ID, atau kalimatnya); strategi lain salin apa adanya.",
};
