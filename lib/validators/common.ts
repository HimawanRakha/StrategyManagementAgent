import type { EvidenceChunk } from "@/lib/db/schema";
import { JudgeOutput, type Evidence } from "@/lib/nodes/schemas";
import type { CheckResult, Failure, LlmSession } from "@/lib/nodes/types";

/** Normalisasi sebelum mencocokkan kutipan: huruf kecil, spasi tunggal, tanda kutip/pisah seragam. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export function chunkMap(evidence: EvidenceChunk[]) {
  return new Map(evidence.map((c) => [c.id, c.content]));
}

export function quoteFound(ev: Evidence, chunks: Map<string, string>) {
  const chunk = chunks.get(ev.chunkId);
  return chunk !== undefined && norm(chunk).includes(norm(ev.quote));
}

export function result(check: string, kind: "code" | "llm", failures: Failure[]): CheckResult {
  return { check, kind, passed: failures.length === 0, failures };
}

/** Cek kode: setiap kutipan benar-benar ada di potongan yang dirujuk. */
export function checkQuotes(items: { id: string; evidence: Evidence[] }[], evidence: EvidenceChunk[]): CheckResult {
  const chunks = chunkMap(evidence);
  const failures: Failure[] = [];
  for (const it of items) {
    for (const ev of it.evidence) {
      if (!quoteFound(ev, chunks)) {
        failures.push({
          check: "quote_exists",
          itemId: it.id,
          message: chunks.has(ev.chunkId)
            ? `Faktor ${it.id} ditolak: kutipan tidak ditemukan di ${ev.chunkId}.`
            : `Faktor ${it.id} ditolak: potongan ${ev.chunkId} tidak ada di bukti yang diberikan.`,
        });
      }
    }
  }
  return result("quote_exists", "code", failures);
}

/** Cek kode: semua rujukan ID ada di himpunan ID yang sah. */
export function checkRefs(
  check: string,
  items: { id: string; refs: string[] }[],
  valid: Set<string>,
  what: string,
): CheckResult {
  const failures: Failure[] = [];
  for (const it of items) {
    const bad = it.refs.filter((r) => !valid.has(r));
    if (bad.length) failures.push({ check, itemId: it.id, message: `${it.id} merujuk ${what} yang tidak ada: ${bad.join(", ")}.` });
  }
  return result(check, "code", failures);
}

const NUMBER_WORDS =
  /\b(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas|belas|puluh|seratus|ratus|ribu|juta|persen|setengah|separuh|seluruh|semua)\b/i;
/** Target/KPI memuat ukuran: angka, persentase, atau kata bilangan. */
export function isMeasurable(s: string) {
  return /\d/.test(s) || /%/.test(s) || NUMBER_WORDS.test(s);
}

/** Cek berbasis LLM: menilai makna setiap item; mock memakai heuristik agar penyuntikan galat tetap bermakna. */
export async function llmJudge(
  llm: LlmSession,
  check: string,
  instruction: string,
  items: { id: string; text: string }[],
  context: string,
  mockOk: (id: string) => boolean = () => true,
): Promise<CheckResult> {
  // Pemeriksaan yang dimatikan pengguna tidak dipanggil (hemat token).
  if (!items.length || (llm as LlmSession & { disabled?: Set<string> }).disabled?.has(check)) return result(check, "llm", []);
  const system = `Kamu pemeriksa mutu analisis strategi organisasi. ${instruction}
Nilai setiap item secara terpisah. ok=true bila item memenuhi aturan, ok=false bila tidak.
Balas HANYA JSON: {"results":[{"id":"<id item>","ok":true|false,"reason":"<alasan singkat>"}]}`;
  const user = `Konteks:\n${context}\n\nItem yang diperiksa:\n${items.map((i) => `- ${i.id}: ${i.text}`).join("\n")}`;
  const out = await llm.json("validate", system, user, JudgeOutput, () => ({
    results: items.map((i) => ({ id: i.id, ok: mockOk(i.id), reason: mockOk(i.id) ? "sesuai" : "tidak sesuai (heuristik mock)" })),
  }));
  const failures: Failure[] = out.results
    .filter((r) => !r.ok)
    .map((r) => ({ check, itemId: r.id, message: `${r.id} ditolak (${check}): ${r.reason}` }));
  return result(check, "llm", failures);
}

/** Tumpang-tindih kata sederhana (dipakai heuristik mock). */
export function overlap(a: string, b: string) {
  const wa = new Set(norm(a).split(/\W+/).filter((w) => w.length > 3));
  const wb = norm(b).split(/\W+/).filter((w) => w.length > 3);
  if (!wa.size || !wb.length) return 0;
  return wb.filter((w) => wa.has(w)).length / Math.min(wa.size, wb.length);
}
