import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import type { EvidenceChunk } from "@/lib/db/schema";
import { embed, embedderId } from "@/lib/llm/provider";
import { rrf } from "./rrf";
export { rrf } from "./rrf";

export type RetrievalQuery = { focus: string; text: string; k?: number; valuesOnly?: boolean };
export type RetrieveOptions = { inputNodeIds?: string[] };

/**
 * Mode pencarian: "hybrid" (bawaan) = peringkat vektor dan kata kunci digabung dengan Reciprocal Rank Fusion;
 * "vector" = vektor saja (perilaku lama; dipakai run pembanding eksperimen). Evaluasi RAG (scripts/eval-rag.ts):
 * hybrid menaikkan recall 57,9% → 62,6% dan MRR 0,771 → 0,823 tanpa panggilan AI tambahan.
 */
export const ragMode = (): "hybrid" | "vector" => (process.env.RAG_MODE === "vector" ? "vector" : "hybrid");

type KwRow = { label: string; content: string; meta: { filename?: string }; is_values: boolean };
const kwWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

/** Peringkat kata kunci: skor = porsi kata kueri (≥ 4 huruf, cocok awalan 5 huruf) yang muncul di potongan. */
function keywordRanked(rows: KwRow[], q: RetrievalQuery) {
  const qw = [...new Set(kwWords(q.text))].map((w) => w.slice(0, 5));
  return rows
    .filter((r) => !q.valuesOnly || r.is_values)
    .map((r) => {
      const cw = kwWords(r.content);
      return { r, s: qw.length ? qw.filter((w) => cw.some((x) => x.startsWith(w))).length / qw.length : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
}

async function corpusRows(projectId: string, inputNodeIds?: string[]) {
  const only = inputNodeIds?.length ? sql`AND d.input_node IN (${sql.join(inputNodeIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
  return queryRows<KwRow>(sql`
    SELECT c.label, c.content, c.meta, d.is_values FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE d.project_id = ${projectId} AND d.reviewed_at IS NOT NULL ${only}`);
}

/**
 * Ambil potongan terbaik untuk setiap kueri (selalu difilter project_id dan dokumen yang sudah ditinjau), lalu gabungkan
 * tanpa duplikat. Jawaban pengguna atas pertanyaan agen ikut menjadi bukti (ID "U…").
 */
export async function retrieve(projectId: string, queries: RetrievalQuery[], opts: RetrieveOptions = {}): Promise<EvidenceChunk[]> {
  const only = opts.inputNodeIds?.length ? sql`AND d.input_node IN (${sql.join(opts.inputNodeIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
  const seen = new Map<string, EvidenceChunk>();
  if (queries.length) {
    let vectors: number[][] | null = null;
    try {
      await ensureEmbeddings(projectId);
      vectors = await embed(queries.map((q) => q.text), "query");
    } catch (e) {
      // Layanan embedding padat/kuota habis: analisis tetap jalan dengan pencarian kata kunci (dicatat di log server).
      console.warn(`[rag] embedding gagal, memakai pencarian kata kunci: ${(e as Error).message.slice(0, 160)}`);
    }
    if (!vectors) {
      for (const c of await keywordSearch(projectId, queries, opts.inputNodeIds)) if (!seen.has(c.id)) seen.set(c.id, c);
      for (const a of await userAnswers(projectId)) seen.set(a.id, a);
      return [...seen.values()];
    }
    const hybrid = ragMode() === "hybrid";
    const corpus = hybrid ? await corpusRows(projectId, opts.inputNodeIds) : [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const k = q.k ?? 8;
      const vec = JSON.stringify(vectors[i]);
      // Hybrid: ambil kandidat lebih banyak dari kedua cara, lalu satukan peringkatnya dan ambil k teratas.
      const rows = await queryRows<{ label: string; content: string; meta: { filename?: string }; similarity: number }>(sql`
        SELECT c.label, c.content, c.meta, 1 - (c.embedding <=> ${vec}::vector) AS similarity
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.project_id = ${projectId} AND d.reviewed_at IS NOT NULL ${only} ${q.valuesOnly ? sql`AND d.is_values` : sql``}
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${hybrid ? k * 3 : k}`);
      const byLabel = new Map(rows.map((r) => [r.label, { content: r.content, meta: r.meta, similarity: Number(r.similarity) as number | undefined }]));
      let picked = rows.slice(0, k).map((r) => r.label);
      if (hybrid) {
        const kw = keywordRanked(corpus, q).slice(0, k * 3);
        for (const x of kw) if (!byLabel.has(x.r.label)) byLabel.set(x.r.label, { content: x.r.content, meta: x.r.meta, similarity: undefined });
        picked = rrf([rows.map((r) => r.label), kw.map((x) => x.r.label)]).slice(0, k);
      }
      for (const label of picked) {
        const r = byLabel.get(label)!;
        if (seen.has(label)) continue;
        seen.set(label, {
          id: label,
          content: r.content,
          source: r.meta?.filename ?? "dokumen",
          ...(r.similarity !== undefined ? { similarity: r.similarity } : {}),
          focus: q.focus,
          kind: "document",
        });
      }
    }
  }
  for (const a of await userAnswers(projectId)) seen.set(a.id, a);
  return [...seen.values()];
}

/** Cadangan tanpa embedding: pencarian kata kunci saja. */
async function keywordSearch(projectId: string, queries: RetrievalQuery[], inputNodeIds?: string[]): Promise<EvidenceChunk[]> {
  const rows = await corpusRows(projectId, inputNodeIds);
  const out: EvidenceChunk[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const scored = keywordRanked(rows, q).slice(0, q.k ?? 8);
    for (const { r, s } of scored) {
      if (seen.has(r.label)) continue;
      seen.add(r.label);
      out.push({ id: r.label, content: r.content, source: r.meta?.filename ?? "dokumen", similarity: s, focus: `${q.focus} (kata kunci)`, kind: "document" });
    }
  }
  return out;
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
    WHERE d.project_id = ${projectId} AND d.reviewed_at IS NOT NULL AND d.input_node IN (${sql.join(inputNodeIds.map((x) => sql`${x}`), sql`, `)})
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
