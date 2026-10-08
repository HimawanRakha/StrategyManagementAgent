import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle, projectOfNodeRun, requireProject } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { getNode, isNodeKey } from "@/lib/nodes/registry";
import { isCustomKey } from "@/lib/nodes/custom";
import type { AnnotItem } from "@/lib/nodes/types";

/** Kunci analisis yang masih dikenal (kunci node lama yang sudah dihapus dilewati). */
const known = (key: string) => isNodeKey(key) || isCustomKey(key);

/** Butir output; [] bila output lama tidak cocok dengan bentuk analisis sekarang. */
function itemsOf(key: string, output: unknown): AnnotItem[] {
  if (!output) return [];
  try {
    const items = getNode(key).items(output);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** Daftar node run yang sudah dianotasi: label kedua penilai, kesepakatan, saran putusan. */
export const GET = handle(async () => {
  await requireResearcher();
  const db = await getDb();
  const ann = await db.select().from(schema.annotations);
  const ids = [...new Set(ann.map((a) => a.nodeRunId))];
  if (!ids.length) return { rows: [] };
  const nrsAll = await db
    .select({
      id: schema.nodeRuns.id, nodeKey: schema.nodeRuns.nodeKey, runId: schema.nodeRuns.runId,
      tag: schema.runs.experimentTag, projectId: schema.workflows.projectId, output: schema.nodeRuns.output,
    })
    .from(schema.nodeRuns)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.nodeRuns.runId))
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.runs.workflowId))
    .where(inArray(schema.nodeRuns.id, ids));
  const nrs = nrsAll.filter((n) => known(n.nodeKey));
  if (!nrs.length) return { rows: [] };
  const runIds = [...new Set(nrs.map((n) => n.runId))];
  const siblings = await db
    .select({ id: schema.nodeRuns.id, runId: schema.nodeRuns.runId, nodeKey: schema.nodeRuns.nodeKey })
    .from(schema.nodeRuns)
    .where(inArray(schema.nodeRuns.runId, runIds));
  const verdicts = await db.select().from(schema.nodeRunVerdicts).where(inArray(schema.nodeRunVerdicts.nodeRunId, siblings.map((s) => s.id)));
  const vBy = new Map(verdicts.map((v) => [v.nodeRunId, v]));

  const rows = nrs.map((nr) => {
    const def = getNode(nr.nodeKey);
    const items = itemsOf(nr.nodeKey, nr.output);
    const mine = ann.filter((a) => a.nodeRunId === nr.id);
    const annotators = [...new Set(mine.map((a) => a.annotator))];
    const perItem = items.map((it) => {
      const labels = annotators.map((an) => mine.find((a) => a.annotator === an && a.itemId === it.id) ?? null);
      const vals = labels.filter(Boolean).map((l) => l!.isError);
      return {
        ...it,
        labels: labels.map((l) => (l ? { isError: l.isError, errorType: l.errorType, note: l.note } : null)),
        agree: vals.length >= 2 ? vals.every((v) => v === vals[0]) : null,
      };
    });
    const parentRuns = siblings.filter((s) => s.runId === nr.runId && (def.deps as string[]).includes(s.nodeKey));
    const suggestedCarried = parentRuns.some((p) => {
      const v = vBy.get(p.id);
      return v ? v.ownError || v.carriedError : false;
    });
    const parentsDecided = parentRuns.every((p) => vBy.has(p.id));
    const anyError = perItem.some((p) => p.labels.some((l) => l?.isError));
    const allAgreeClean = perItem.every((p) => p.labels.filter(Boolean).every((l) => !l!.isError));
    return {
      nodeRunId: nr.id,
      runId: nr.runId,
      tag: nr.tag,
      nodeKey: nr.nodeKey,
      label: def.label,
      annotators,
      items: perItem,
      disagreements: perItem.filter((p) => p.agree === false).length,
      suggestedOwn: anyError && !allAgreeClean,
      suggestedCarried,
      parentsDecided,
      verdict: vBy.get(nr.id) ?? null,
    };
  });
  return { rows };
});

const Body = z.object({ nodeRunId: z.string().uuid(), ownError: z.boolean(), carriedError: z.boolean() });

/** Putusan akhir per node run setelah dua penilai sepakat atau berdiskusi. */
export const POST = handle(async (req: Request) => {
  const body = Body.parse(await req.json());
  const { user } = await requireProject(await projectOfNodeRun(body.nodeRunId));
  const db = await getDb();
  await db
    .insert(schema.nodeRunVerdicts)
    .values({ ...body, decidedBy: user.id })
    .onConflictDoUpdate({
      target: schema.nodeRunVerdicts.nodeRunId,
      set: { ownError: body.ownError, carriedError: body.carriedError, decidedBy: user.id, createdAt: new Date() },
    });
  return { ok: true };
});
