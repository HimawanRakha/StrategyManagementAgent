// Node proses kustom buatan pengguna: nama + instruksi bebas. Hasilnya tetap butir-butir berbukti
// (kutipan dokumen) dan/atau berujukan ke butir analisis sebelumnya, sehingga tetap bisa ditelusuri dan divalidasi.
import { z } from "zod";
import type { CustomSpec } from "@/lib/db/schema";
import { Evidence } from "./schemas";
import type { NodeContext, NodeDef, NodeKey } from "./types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "./prompt";
import { firstSentence, toClaim } from "./heuristics";
import { checkQuotes, checkRefs, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, type Grid } from "@/lib/sheets/grid";

export const CUSTOM_PREFIX = "custom_";
export const isCustomKey = (k: string) => k.startsWith(CUSTOM_PREFIX);
export const customKeyOf = (nodeId: string) => `${CUSTOM_PREFIX}${nodeId}`;

export const CustomOutput = z.object({
  summary: z.string(),
  /** Bentuk tabel: nama kolom (diisi sesuai kolom yang ditentukan pengguna). */
  columns: z.array(z.string()).optional(),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      /** Bentuk tabel: isi sel, urut sesuai `columns`. */
      cells: z.array(z.string()).optional(),
      detail: z.string().optional(),
      refs: z.array(z.string()).default([]), // ID butir analisis sebelumnya yang menjadi dasar
      evidence: z.array(Evidence).default([]),
    }),
  ),
});
export type CustomOutput = z.infer<typeof CustomOutput>;

const items = (out: unknown) => {
  const cols = (out as CustomOutput)?.columns ?? [];
  return ((out as CustomOutput)?.items ?? []).map((i) => ({
    id: i.id,
    text: i.text,
    detail: [
      cols.length && i.cells?.length ? cols.map((c, j) => `${c}: ${i.cells?.[j] ?? ""}`).join(" | ") : "",
      i.detail,
      i.refs?.length ? `dasar: ${i.refs.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
};

const CHECKS = [
  { name: "quote_exists", kind: "code" as const, description: "Kutipan tidak ditemukan di potongan yang dirujuk" },
  { name: "grounded", kind: "code" as const, description: "Butir tidak punya kutipan dokumen maupun rujukan ke analisis sebelumnya" },
  { name: "ref_exists", kind: "code" as const, description: "Butir merujuk ID yang tidak ada di analisis sebelumnya" },
  { name: "follows_instruction", kind: "llm" as const, description: "Butir tidak sesuai instruksi pengguna" },
  { name: "table_shape", kind: "code" as const, description: "Bentuk tabel: baris tidak mengisi semua kolom yang ditentukan" },
];

/** Kolom tabel yang diminta pengguna (kosong = bentuk daftar). */
export function tableColumns(spec: CustomSpec | null | undefined): string[] {
  if (spec?.format !== "table") return [];
  return (spec.columns ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 8);
}

/** Definisi umum (tanpa konfigurasi) untuk keperluan daftar butir, anotasi, dan ekspor. */
export function genericCustomDef(key: string): NodeDef<CustomOutput> {
  return {
    key: key as NodeKey,
    label: "Proses kustom",
    phase: 2,
    group: "custom",
    sheetName: "KUSTOM",
    deps: [],
    kind: "llm",
    description: "Analisis buatan pengguna.",
    computedBy: "LLM (instruksi pengguna)",
    schema: CustomOutput,
    checks: CHECKS,
    items,
    sheets: (out, ctx) => [customSheet(out as CustomOutput, ctx.label)],
  };
}

/** Sheet ala Excel untuk hasil node kustom: satu baris per butir (kolom tabel pengguna bila bentuk tabel). */
export function customSheet(out: CustomOutput, label: string): Grid {
  const g = new GridBuilder("custom", label.toUpperCase(), label);
  const cols = out.columns?.length ? out.columns : ["Butir"];
  const width = cols.length + 3;
  g.set(0, 0, label, { style: "title", cs: width });
  if (out.summary) g.set(1, 0, out.summary, { style: "note", cs: width });
  g.row(3, 0, ["ID", ...cols, "Dasar (rujukan)", "Bukti"], { style: "header" });
  out.items.forEach((it, i) => {
    const r = 4 + i;
    g.set(r, 0, it.id, { style: "label" });
    const cells = out.columns?.length ? cols.map((_, j) => it.cells?.[j] ?? "") : [it.detail ? `${it.text} — ${it.detail}` : it.text];
    cells.forEach((v, j) => g.set(r, 1 + j, v, { style: "text", src: "ai" }));
    g.set(r, cols.length + 1, it.refs.join(", "), { style: "muted" });
    g.set(r, cols.length + 2, it.evidence.map((e) => `[${e.chunkId}] ${e.quote}`).join("\n"), {
      style: "muted",
      refs: it.evidence.map((e) => e.chunkId),
    });
  });
  return g.build({ cols: [8, ...cols.map(() => Math.max(18, Math.round(90 / cols.length))), 16, 40] });
}

/**
 * Definisi lengkap node kustom. `parentKeys` = analisis yang panahnya masuk ke node ini;
 * `describeItems(key, output)` menghasilkan daftar butir induk untuk prompt dan validasi rujukan.
 */
export function makeCustomNode(
  key: string,
  spec: CustomSpec,
  parentKeys: string[],
  describeItems: (key: string, output: unknown) => { label: string; items: { id: string; text: string }[] },
): NodeDef<CustomOutput> {
  const prefix = (spec.prefix || "K").replace(/[^A-Za-z]/g, "").slice(0, 4) || "K";
  const columns = tableColumns(spec);
  const isTable = columns.length > 0;
  const requireEvidence = spec.requireEvidence !== false;
  const parentItems = (ctx: NodeContext) =>
    parentKeys.filter((k) => ctx.inputs[k as NodeKey] !== undefined).map((k) => ({ key: k, ...describeItems(k, ctx.inputs[k as NodeKey]) }));

  return {
    ...genericCustomDef(key),
    label: spec.name || "Proses kustom",
    description: spec.instruction,
    queries: () => [{ focus: "kustom", text: `${spec.name} ${spec.instruction}`.slice(0, 500), k: 8 }],
    prompt: (ctx) => {
      const parents = parentItems(ctx);
      return {
        system: `Kamu analis strategi organisasi. Kerjakan analisis "${spec.name}" sesuai INSTRUKSI PENGGUNA, HANYA berdasarkan potongan dokumen dan hasil analisis sebelumnya yang diberikan.

INSTRUKSI PENGGUNA:
${spec.instruction}

Aturan:
1. Tulis hasil sebagai butir-butir (items) dengan ID ${prefix}1, ${prefix}2, ...; satu butir satu gagasan.
2. ${requireEvidence ? EVIDENCE_RULES : "Sertakan kutipan dokumen bila ada. Butir yang disimpulkan dari analisis sebelumnya boleh tanpa kutipan, tetapi WAJIB menulis rujukannya di refs."}
3. refs berisi ID butir dari hasil analisis sebelumnya yang menjadi dasar (mis. S1, SO2). Jangan mengarang ID.
4. summary: ringkasan 2–4 kalimat.
5. Jangan mengarang fakta yang tidak ada di dokumen atau hasil analisis sebelumnya.
${
  isTable
    ? `6. BENTUK HASIL: TABEL. Isi "columns" PERSIS dengan: ${JSON.stringify(columns)}. Setiap butir adalah satu baris: "cells" berisi tepat ${columns.length} sel berurutan sesuai kolom (tidak boleh kosong), dan "text" berisi ringkasan singkat baris itu.
7. ${JSON_ONLY}`
    : `6. BENTUK HASIL: DAFTAR BUTIR (abaikan "columns" dan "cells").
7. ${JSON_ONLY}`
}`,
        user: `${orgLine(ctx)}

Hasil analisis sebelumnya:
${parents.length ? parents.map((p) => `## ${p.label}\n${p.items.map((i) => `${i.id}: ${i.text}`).join("\n")}`).join("\n\n") : "(tidak ada — node ini hanya membaca dokumen)"}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(CustomOutput)}`,
      };
    },
    mock: (ctx) => {
      const parents = parentItems(ctx);
      const refs = parents.flatMap((p) => p.items.slice(0, 1).map((i) => i.id));
      const docs = ctx.evidence.filter((e) => e.kind === "document").slice(0, 4);
      return {
        summary: `Hasil mode uji untuk "${spec.name}": butir disusun dari kalimat dokumen yang paling relevan dengan instruksi.`,
        ...(isTable ? { columns } : {}),
        items: docs.map((c, i) => {
          const quote = firstSentence(c.content);
          const text = toClaim(quote);
          return {
            id: `${prefix}${i + 1}`,
            text,
            ...(isTable ? { cells: columns.map((col, j) => (j === 0 ? text : `(${col} — mode uji)`)) } : {}),
            refs: refs.slice(0, 1),
            evidence: [{ chunkId: c.id, quote }],
          };
        }),
      };
    },
    validate: async (out, ctx, llm) => {
      const valid = new Set(parentItems(ctx).flatMap((p) => p.items.map((i) => i.id)));
      const checks = [
        checkQuotes(out.items.filter((i) => i.evidence.length), ctx.evidence),
        result(
          "grounded",
          "code",
          out.items
            .filter((i) => (requireEvidence ? !i.evidence.length : !i.evidence.length && !i.refs.length))
            .map((i) => ({ check: "grounded", itemId: i.id, message: `${i.id} ditolak: ${requireEvidence ? "tidak punya kutipan dokumen" : "tidak punya kutipan maupun rujukan"}.` })),
        ),
        checkRefs("ref_exists", out.items.map((i) => ({ id: i.id, refs: i.refs })), valid, "butir analisis sebelumnya"),
        // Bentuk tabel dijamin kode: kolom sama persis dan setiap baris mengisi semua sel.
        result(
          "table_shape",
          "code",
          !isTable
            ? []
            : [
                ...(JSON.stringify((out.columns ?? []).map((c) => c.trim())) !== JSON.stringify(columns)
                  ? [{ check: "table_shape", message: `Kolom tabel harus persis: ${columns.join(" | ")}.` }]
                  : []),
                ...out.items
                  .filter((i) => (i.cells ?? []).length !== columns.length || (i.cells ?? []).some((c) => !c.trim()))
                  .map((i) => ({ check: "table_shape", itemId: i.id, message: `Baris ${i.id} harus mengisi ${columns.length} kolom: ${columns.join(" | ")}.` })),
              ],
        ),
        await llmJudge(
          llm,
          "follows_instruction",
          `Periksa apakah setiap butir sesuai dengan instruksi pengguna berikut: "${spec.instruction}".`,
          out.items.map((i) => ({ id: i.id, text: i.text })),
          `Analisis: ${spec.name}`,
        ),
      ];
      return checks;
    },
    repairHint: "Perbaiki hanya butir yang ditolak; butir lain salin apa adanya.",
  };
}
