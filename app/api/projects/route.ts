import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle, requireUser } from "@/lib/access";
import { createSyntheticCase } from "@/lib/seed/create";
import { templateGraph } from "@/lib/engine/canvas";

export const maxDuration = 60;

export const GET = handle(async () => {
  await requireUser();
  const db = await getDb();
  return { projects: await db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt)) };
});

const Body = z.union([
  z.object({ template: z.literal("synthetic") }),
  z.object({
    name: z.string().min(2),
    orgType: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    isSynthetic: z.boolean().optional(),
    /** "empty" = canvas kosong (bawaan), "full"/"mvp" = langsung diisi templat alur. */
    canvas: z.enum(["empty", "mvp", "full"]).optional(),
  }),
]);

/** Membuat proyek; canvas alur berpikirnya kosong kecuali memilih templat. */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());
  if ("template" in body) return { project: await createSyntheticCase(user.id) };
  const db = await getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ name: body.name, orgType: body.orgType, description: body.description, isSynthetic: !!body.isSynthetic, createdBy: user.id })
    .returning();
  const graph = body.canvas && body.canvas !== "empty" ? templateGraph(body.canvas) : { nodes: [], edges: [] };
  await db.insert(schema.workflows).values({ projectId: project.id, name: "Alur berpikir", graph });
  return { project };
});
