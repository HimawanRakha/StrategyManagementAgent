import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import type { EvidenceChunk } from "@/lib/db/schema";
import { embed, embedderId } from "@/lib/llm/provider";

export type RetrievalQuery = { focus: string; text: string; k?: number; valuesOnly?: boolean };
export type RetrieveOptions = { inputNodeIds?: string[] };

/**
 * Ambil potongan terdekat untuk setiap kueri (pencarian vektor, selalu difilter project_id),
 * lalu gabungkan tanpa duplikat. Jawaban pengguna atas pertanyaan agen ikut menjadi bukti (ID "U…").
 */
export async function retrieve(projectId: string, queries: RetrievalQuery[], opts: RetrieveOptions = {}): Promise<EvidenceChunk[]> {
  const only = opts.inputNodeIds?.length ? sql`AND d.input_node IN (${sql.join(opts.inputNodeIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
  const seen = new Map<string, EvidenceChunk>();
  if (queries.length) {
    await ensureEmbeddings(projectId);
    const vectors = await embed(queries.map((q) => q.text), "query");
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const vec = JSON.stringify(vectors[i]);
      const rows = await queryRows<{ label: string; content: string; meta: { filename?: string }; similarity: number }>(sql`
        SELECT c.label, c.content, c.meta, 1 - (c.embedding <=> ${vec}::vector) AS similarity
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.project_id = ${projectId} ${only} ${q.valuesOnly ? sql`AND d.is_values` : sql``}
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${q.k ?? 8}`);
      for (const r of rows) {
        if (seen.has(r.label)) continue;
        seen.set(r.label, {
          id: r.label,
          content: r.content,
          source: r.meta?.filename ?? "dokumen",
          similarity: Number(r.similarity),
          focus: q.focus,
          kind: "document",
        });
      }
    }
  }
  for (const a of await userAnswers(projectId)) seen.set(a.id, a);
  return [...seen.values()];
}

/**
 * Pastikan semua potongan proyek diembed dengan cara yang SAMA dengan yang dipakai untuk kueri.
 * Bila Anda pindah dari mode uji (mock) ke Gemini (atau mengganti model embedding), vektor lama tidak lagi
 * sebanding dengan vektor kueri — potongan itu dihitung ulang otomatis di sini (sekali saja).
 */
export async function ensureEmbeddings(projectId: string) {
  const id = embedderId();
  const stale = await queryRows<{ id: string; content: string }>(sql`
    SELECT id, content FROM chunks WHERE project_id = ${projectId} AND coalesce(meta->>'embedder', '') <> ${id} ORDER BY label`);
  for (let i = 0; i < stale.length; i += 50) {
    const batch = stale.slice(i, i + 50);
    const vectors = await embed(batch.map((b) => b.content), "document");
    for (let j = 0; j < batch.length; j++) {
      await queryRows(sql`UPDATE chunks SET embedding = ${JSON.stringify(vectors[j])}::vector, meta = meta || ${JSON.stringify({ embedder: id })}::jsonb WHERE id = ${batch[j].id}`);
    }
  }
  return stale.length;
}

/** Potongan dokumen dari node input tertentu (dokumen yang diunggah di node input di canvas), urut dokumen lalu isi. */
export async function chunksOfInputs(projectId: string, inputNodeIds: string[], limit = 14): Promise<EvidenceChunk[]> {
  if (!inputNodeIds.length) return [];
  const rows = await queryRows<{ label: string; content: string; meta: { filename?: string } }>(sql`
    SELECT c.label, c.content, c.meta
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE d.project_id = ${projectId} AND d.input_node IN (${sql.join(inputNodeIds.map((x) => sql`${x}`), sql`, `)})
    ORDER BY d.created_at, c.idx
    LIMIT ${limit}`);
  return rows.map((r) => ({ id: r.label, content: r.content, source: r.meta?.filename ?? "dokumen", focus: "input tersambung", kind: "document" as const }));
}

/** Jawaban pengguna diperlakukan sebagai bukti baru bersumber "jawaban pengguna". */
export async function userAnswers(projectId: string): Promise<EvidenceChunk[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.agentQuestions)
    .where(and(eq(schema.agentQuestions.projectId, projectId), isNotNull(schema.agentQuestions.answer)));
  return rows.map((r) => ({
    id: r.label,
    content: `Pertanyaan: ${r.question}\nJawaban: ${r.answer}`,
    source: "Jawaban pengguna",
    kind: "user_answer" as const,
  }));
}

/** Ambil potongan tertentu berdasarkan label (mis. bukti yang dikutip node induk). */
export async function chunksByLabel(projectId: string, labels: string[]): Promise<EvidenceChunk[]> {
  const docLabels = [...new Set(labels.filter((l) => /^C\d+$/.test(l)))];
  if (!docLabels.length) return [];
  const db = await getDb();
  const rows = await db
    .select({ label: schema.chunks.label, content: schema.chunks.content, meta: schema.chunks.meta })
    .from(schema.chunks)
    .where(and(eq(schema.chunks.projectId, projectId), inArray(schema.chunks.label, docLabels)));
  return rows.map((r) => ({ id: r.label, content: r.content, source: r.meta?.filename ?? "dokumen", focus: "induk", kind: "document" as const }));
}

export { formatEvidence } from "./format";
