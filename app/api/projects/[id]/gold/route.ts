import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle, requireProject } from "@/lib/access";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const db = await getDb();
  return { gold: await db.select().from(schema.goldFactors).where(eq(schema.goldFactors.projectId, id)) };
});

const Body = z.object({
  factors: z.array(z.object({ quadrant: z.enum(["S", "W", "O", "T"]), text: z.string().min(2) })),
});

/** Menyimpan (mengganti) kunci jawaban kasus sintetis. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const { factors } = Body.parse(await req.json());
  const db = await getDb();
  await db.delete(schema.goldFactors).where(eq(schema.goldFactors.projectId, id));
  if (factors.length) await db.insert(schema.goldFactors).values(factors.map((f) => ({ ...f, projectId: id })));
  return { gold: await db.select().from(schema.goldFactors).where(eq(schema.goldFactors.projectId, id)) };
});
