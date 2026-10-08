import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { HttpError, handle, projectOfNodeRun, requireProject } from "@/lib/access";
import { approveNodeRun } from "@/lib/engine/run-node";
import { resetNode } from "@/lib/engine/run-workflow";
import { enqueueReady } from "@/lib/engine/queue";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  action: z.enum(["start", "approve", "reject"]),
  changes: z.unknown().optional(), // output yang sudah diedit peninjau
  note: z.string().max(2000).optional(), // alasan menolak / catatan peninjau
});

/**
 * Tinjauan manusia.
 * - Saat run berhenti di titik tinjau (status needs_review): setujui → lanjut; tolak → analisis dijalankan ulang.
 * - Hasil yang sudah selesai juga bisa ditinjau kapan saja (mis. elemen tinjauan dipasang setelah run):
 *   setujui → dicatat; tolak → hasil analisis itu dan analisis sesudahnya dikosongkan untuk dijalankan ulang.
 * Waktu tinjauan dicatat dari "start" (otomatis saat panel tinjauan dibuka) sampai keputusan — data c_i^h untuk optimasi.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireProject(await projectOfNodeRun(id));
  const body = Body.parse(await req.json());
  const db = await getDb();
  const [nr] = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.id, id));
  if (nr.status !== "needs_review" && nr.status !== "done")
    throw new HttpError(409, "Belum ada hasil untuk ditinjau. Jalankan analisisnya dulu.");

  const [open] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.nodeRunId, id), isNull(schema.reviews.endedAt)))
    .orderBy(desc(schema.reviews.startedAt));

  if (body.action === "start") {
    if (open) return { review: open };
    const [review] = await db.insert(schema.reviews).values({ nodeRunId: id, reviewer: user.id, startedAt: new Date() }).returning();
    return { review };
  }
  // Tanpa "start" sebelumnya, waktu tinjauan dihitung dari saat ini (durasi ≈ 0).
  const review = open ?? (await db.insert(schema.reviews).values({ nodeRunId: id, reviewer: user.id, startedAt: new Date() }).returning())[0];

  if (body.action === "approve") {
    if (nr.status === "needs_review") await approveNodeRun(id, body.changes);
    await db
      .update(schema.reviews)
      .set({ endedAt: new Date(), approved: true, changes: body.changes ?? (body.note ? { note: body.note } : null) })
      .where(eq(schema.reviews.id, review.id));
    // Mode otomatis: anak-anak node ini masuk antrean setelah disetujui.
    await db
      .update(schema.jobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(schema.jobs.runId, nr.runId), eq(schema.jobs.nodeKey, nr.nodeKey)));
    const queued = await enqueueReady(nr.runId);
    return { ok: true, queued };
  }

  // Tolak: hasil dikosongkan (beserta analisis sesudahnya bila sudah selesai) agar dijalankan ulang.
  await db
    .update(schema.reviews)
    .set({ endedAt: new Date(), approved: false, changes: body.note ? { note: body.note } : null })
    .where(eq(schema.reviews.id, review.id));
  const reset = await resetNode(nr.runId, nr.nodeKey);
  return { ok: true, reset };
});
