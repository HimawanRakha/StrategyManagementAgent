import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle, projectOfNodeRun, requireProject } from "@/lib/access";

const Body = z.object({
  nodeRunId: z.string().uuid(),
  annotator: z.string().trim().min(1, "Isi nama penilai"), // satu akun bersama: penilai dibedakan lewat nama
  labels: z
    .array(
      z.object({
        itemId: z.string(),
        isError: z.boolean(),
        errorType: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/** Menyimpan label penilai (galat atau tidak, beserta jenisnya) per item. */
export const POST = handle(async (req: Request) => {
  const body = Body.parse(await req.json());
  await requireProject(await projectOfNodeRun(body.nodeRunId));
  const db = await getDb();
  for (const l of body.labels) {
    await db
      .insert(schema.annotations)
      .values({
        nodeRunId: body.nodeRunId,
        annotator: body.annotator,
        itemId: l.itemId,
        isError: l.isError,
        errorType: l.isError ? (l.errorType ?? "other") : null,
        note: l.note ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.annotations.nodeRunId, schema.annotations.annotator, schema.annotations.itemId],
        set: { isError: l.isError, errorType: l.isError ? (l.errorType ?? "other") : null, note: l.note ?? null },
      });
  }
  return { ok: true, saved: body.labels.length };
});
