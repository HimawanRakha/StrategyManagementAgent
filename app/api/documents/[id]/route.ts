import { asc, eq } from "drizzle-orm";
import { z } from "zod";
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
  return {
    document: { id: doc.id, filename: doc.filename, isValues: doc.isValues, chars: doc.rawText.length, reviewedAt: doc.reviewedAt, quality: doc.quality },
    chunks,
  };
});

const Body = z.object({ action: z.enum(["approve", "unapprove"]) });

/** Tinjauan dokumen: setujui (mulai dibaca analisis) atau batalkan persetujuan. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const doc = await load(id);
  await requireProject(doc.projectId);
  const { action } = Body.parse(await req.json());
  const db = await getDb();
  const [row] = await db
    .update(schema.documents)
    .set({ reviewedAt: action === "approve" ? new Date() : null })
    .where(eq(schema.documents.id, id))
    .returning({ reviewedAt: schema.documents.reviewedAt });
  return { reviewedAt: row.reviewedAt };
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const doc = await load(id);
  await requireProject(doc.projectId);
  const db = await getDb();
  await db.delete(schema.documents).where(eq(schema.documents.id, id));
  return { ok: true };
});
