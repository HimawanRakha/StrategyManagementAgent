import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { HttpError, handle, requireProject } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ answer: z.string().min(2) });

/**
 * Menyimpan jawaban pengguna atas pertanyaan agen. Jawaban menjadi bukti baru berlabel U…
 * (bersumber "jawaban pengguna") yang ikut diambil saat node dijalankan ulang.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const db = await getDb();
  const [q] = await db.select().from(schema.agentQuestions).where(eq(schema.agentQuestions.id, id));
  if (!q) throw new HttpError(404, "Pertanyaan tidak ditemukan");
  const { user } = await requireProject(q.projectId);
  const { answer } = Body.parse(await req.json());
  const [question] = await db
    .update(schema.agentQuestions)
    .set({ answer, answeredBy: user.id, answeredAt: new Date() })
    .where(eq(schema.agentQuestions.id, id))
    .returning();
  return { question };
});
