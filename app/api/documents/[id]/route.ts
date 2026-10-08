import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { HttpError, handle, requireProject } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const db = await getDb();
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc) throw new HttpError(404, "Dokumen tidak ditemukan");
  return doc;
}

/** Pratinjau potongan dokumen (label sitasi, isi, metadata). */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const doc = await load(id);
  await requireProject(doc.projectId);
  const db = await getDb();
  const chunks = await db
    .select({ id: schema.chunks.id, label: schema.chunks.label, idx: schema.chunks.idx, content: schema.chunks.content, meta: schema.chunks.meta })
    .from(schema.chunks)
    .where(eq(schema.chunks.documentId, id))
    .orderBy(asc(schema.chunks.idx));
  return { document: { id: doc.id, filename: doc.filename, isValues: doc.isValues, chars: doc.rawText.length }, chunks };
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const doc = await load(id);
  await requireProject(doc.projectId);
  const db = await getDb();
  await db.delete(schema.documents).where(eq(schema.documents.id, id));
  return { ok: true };
});
