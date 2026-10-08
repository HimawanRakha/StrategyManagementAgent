import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { embed, embedderId } from "@/lib/llm/provider";
import { chunkText } from "./chunk";

/** Simpan dokumen, pecah menjadi potongan bernomor (C1, C2, ...), embed, dan simpan ke chunks. */
export async function ingestDocument(projectId: string, filename: string, rawText: string, isValues = false, inputNode: string | null = null) {
  const db = await getDb();
  const [doc] = await db
    .insert(schema.documents)
    .values({ projectId, filename, rawText, isValues, inputNode })
    .returning();

  const pieces = chunkText(rawText);
  if (!pieces.length) return { document: doc, chunks: 0 };

  // Nomor label melanjutkan nomor terbesar yang sudah ada di proyek ini.
  const [{ maxN }] = await db
    .select({ maxN: sql<number>`coalesce(max(substring(${schema.chunks.label} from 2)::int), 0)` })
    .from(schema.chunks)
    .where(eq(schema.chunks.projectId, projectId));

  const vectors = await embed(pieces.map((p) => p.content), "document");
  const rows = pieces.map((p, i) => ({
    documentId: doc.id,
    projectId,
    label: `C${Number(maxN) + i + 1}`,
    idx: p.idx,
    content: p.content,
    embedding: vectors[i],
    meta: { filename, paragraphs: p.paragraphs, embedder: embedderId() },
  }));
  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(schema.chunks).values(rows.slice(i, i + 50));
  }
  return { document: doc, chunks: rows.length };
}
