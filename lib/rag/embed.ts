import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { embed, embedderId } from "@/lib/llm/provider";
import { chunkText } from "./chunk";
import { assessDocument, textFingerprint } from "./quality";

/**
 * Simpan dokumen, pecah menjadi potongan bernomor (C1, C2, ...), embed, dan simpan ke chunks.
 * Dokumen baru menunggu tinjauan (`approved` false): belum dibaca analisis sampai disetujui pengguna.
 */
export async function ingestDocument(projectId: string, filename: string, rawText: string, isValues = false, inputNode: string | null = null, approved = false) {
  const db = await getDb();
  const pieces = chunkText(rawText);
  const others = await db.select({ filename: schema.documents.filename, rawText: schema.documents.rawText }).from(schema.documents).where(eq(schema.documents.projectId, projectId));
  const quality = assessDocument(
    rawText,
    pieces,
    others.map((o) => ({ filename: o.filename, fingerprint: textFingerprint(o.rawText) })),
  );
  const [doc] = await db
    .insert(schema.documents)
    .values({ projectId, filename, rawText, isValues, inputNode, quality, reviewedAt: approved ? new Date() : null })
    .returning();

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
  return { document: doc, chunks: rows.length, quality };
}
