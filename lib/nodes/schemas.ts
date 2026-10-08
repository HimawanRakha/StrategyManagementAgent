// Skema Zod bersama. Skema output tiap node ada di file node masing-masing (lib/nodes/<kelompok>/*.ts).
// LLM hanya mengusulkan isi dan angka penilaian; angka hasil hitungan dibuat kode.
import { z } from "zod";

export const Evidence = z.object({
  chunkId: z.string(), // ID potongan dokumen, mis. "C12" (atau "U3" untuk jawaban pengguna)
  quote: z.string().min(10), // kutipan persis dari potongan
});
export type Evidence = z.infer<typeof Evidence>;

/** Alasan singkat + rujukan bukti untuk angka yang diusulkan AI (boleh kosong). */
export const Reason = z.object({
  reason: z.string().default(""),
  refs: z.array(z.string()).default([]),
});

// ===== Grand design =====
export const ExecSummaryOutput = z.object({
  sentences: z.array(
    z.object({
      text: z.string(),
      refs: z.array(z.string()).min(1), // ID elemen (S1, SO2, A.1.1, R3, ...)
    }),
  ),
});
export type ExecSummaryOutput = z.infer<typeof ExecSummaryOutput>;

export const GrandDesignOutput = z.object({
  executiveSummary: ExecSummaryOutput.shape.sentences,
  missingNodes: z.array(z.string()),
  trace: z.object({
    total: z.number(),
    complete: z.number(),
    broken: z.array(z.object({ id: z.string(), reason: z.string() })),
  }),
});
export type GrandDesignOutput = z.infer<typeof GrandDesignOutput>;

// Hasil cek LLM (validator berbasis LLM)
export const JudgeOutput = z.object({
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), reason: z.string() })),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;
