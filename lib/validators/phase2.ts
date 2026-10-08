// Validator lintas-analisis untuk kompilasi grand design: ketertelusuran rantai rujukan dan rujukan ringkasan eksekutif.
// (Pemeriksaan khusus metode tiap analisis ada di file node masing-masing.)
import type { CheckResult } from "@/lib/nodes/types";
import { buildTraceIndex, checkTraceComplete, type TraceOutputs } from "@/lib/grand-design/trace";
import { checkRefs, result } from "./common";

/**
 * trace_complete: setiap strategi, SI, SO, misi (cascading), dan setiap butir yang menyatakan rujukan
 * (renstra, DM-CRM, MSDM, kustom) harus berujung pada kutipan dokumen atau jawaban pengguna.
 */
export function validateTrace(outputs: TraceOutputs): CheckResult {
  const t = checkTraceComplete(outputs);
  return result(
    "trace_complete",
    "code",
    t.broken.map((b) => ({ check: "trace_complete", itemId: b.id, message: `${b.id}: ${b.reason}.` })),
  );
}

/** ID elemen yang sah untuk dirujuk: elemen jejak + ID butir tambahan (mis. dari items() setiap analisis). */
export function validElementIds(outputs: TraceOutputs, extra: Iterable<string> = []): Set<string> {
  const ids = new Set<string>();
  for (const el of buildTraceIndex(outputs).values()) ids.add(el.id);
  for (const x of extra) ids.add(x);
  return ids;
}

/** summary_refs: setiap kalimat ringkasan eksekutif merujuk ID elemen yang benar-benar ada. */
export function validateSummaryRefs(sentences: { text: string; refs: string[] }[], valid: Set<string>): CheckResult {
  return checkRefs(
    "summary_refs",
    sentences.map((s, i) => ({ id: `K${i + 1}`, refs: s.refs })),
    valid,
    "elemen",
  );
}

/** summary_length: ringkasan eksekutif 4–8 kalimat (lebih sedikit boleh bila analisis yang tersedia sedikit). */
export function validateSummaryLength(sentences: unknown[], availableAnalyses: number): CheckResult {
  const min = Math.max(1, Math.min(4, availableAnalyses));
  const n = sentences.length;
  return result(
    "summary_length",
    "code",
    n < min || n > 8
      ? [{ check: "summary_length", message: `Ringkasan eksekutif berisi ${n} kalimat; seharusnya ${min === 4 ? "4" : min}–8 kalimat.` }]
      : [],
  );
}
