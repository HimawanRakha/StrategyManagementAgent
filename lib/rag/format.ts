import type { EvidenceChunk } from "@/lib/db/schema";

/** Format potongan untuk prompt: [C12] (Notulensi.pdf) isi ... */
export function formatEvidence(chunks: EvidenceChunk[]) {
  return chunks.map((c) => `[${c.id}] (${c.source}) ${c.content}`).join("\n\n");
}
