import { z } from "zod";
import { formatEvidence } from "@/lib/rag/format";
import type { NodeContext } from "./types";

const schemaCache = new WeakMap<object, string>();

/** Skema output dalam bentuk JSON Schema untuk disisipkan ke prompt ({jsonSchema} di brief). */
export function jsonSchemaText(schema: z.ZodType) {
  let s = schemaCache.get(schema);
  if (!s) {
    s = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 1);
    schemaCache.set(schema, s);
  }
  return s;
}

export function orgLine(ctx: NodeContext) {
  const about = ctx.description?.trim();
  return `Organisasi: ${ctx.projectName}${ctx.orgType ? ` (${ctx.orgType})` : ""}${about ? `. ${about.slice(0, 400)}` : ""}`;
}

export const JSON_ONLY = "Balas HANYA dengan JSON sesuai skema. Tanpa teks lain.";

export const EVIDENCE_RULES = `Setiap butir WAJIB punya minimal satu bukti: chunkId dan kutipan PERSIS (salin kata demi kata, minimal 10 karakter) dari potongan tersebut. Jangan parafrase kutipan.
Potongan berlabel [U…] adalah jawaban pengguna atas pertanyaan agen; boleh dipakai sebagai bukti dengan aturan yang sama.`;

export function evidenceBlock(ctx: NodeContext) {
  return ctx.evidence.length ? formatEvidence(ctx.evidence) : "(tidak ada potongan dokumen)";
}

export const pretty = (x: unknown) => JSON.stringify(x, null, 1);
