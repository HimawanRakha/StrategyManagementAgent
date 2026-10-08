import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { HttpError, handle, projectOfNodeRun, requireProject } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { INJECTORS, injectorsFor } from "@/lib/experiment/injectors";
import { runInjection } from "@/lib/experiment/run-injection";
import { NODES, NODE_KEYS } from "@/lib/nodes/registry";

export const maxDuration = 60;

/** Analisis yang bisa disuntik: disusun AI (bukan kalkulator kode) dan punya validator. */
const CODE_NODES = new Set<string>(["posisi_organisasi", "grand_design"]);
const injectableKeys = () => NODE_KEYS.filter((k) => !CODE_NODES.has(k) && NODES[k].kind !== "code" && !!NODES[k].validate);

/**
 * Penyuntik yang tersedia per analisis (generik; disaring menurut output selesai terakhir analisis itu),
 * jumlah output bersih yang bisa disuntik, dan riwayat penyuntikan.
 */
export const GET = handle(async () => {
  await requireResearcher();
  const db = await getDb();
  const keys = injectableKeys();
  // Contoh output (mentah bila ada) terakhir per analisis untuk menentukan penyuntik yang berlaku.
  const samples = await queryRows<{ node_key: string; raw: unknown; output: unknown }>(sql`
    SELECT DISTINCT ON (node_key) node_key, raw, output FROM node_runs
    WHERE status = 'done' ORDER BY node_key, finished_at DESC NULLS LAST`);
  const sampleOf = (k: string) => {
    const r = samples.find((x) => x.node_key === k);
    return r ? (r.raw ?? r.output) : undefined;
  };
  const clean = await db
    .select({ nodeRunId: schema.nodeRunVerdicts.nodeRunId, nodeKey: schema.nodeRuns.nodeKey })
    .from(schema.nodeRunVerdicts)
    .innerJoin(schema.nodeRuns, eq(schema.nodeRuns.id, schema.nodeRunVerdicts.nodeRunId))
    .where(eq(schema.nodeRunVerdicts.ownError, false));
  const recent = await db.select({
    id: schema.injections.id, nodeKey: schema.injections.nodeKey, errorType: schema.injections.errorType,
    itemId: schema.injections.itemId, detected: schema.injections.detected, repaired: schema.injections.repaired,
    createdAt: schema.injections.createdAt,
  }).from(schema.injections).orderBy(desc(schema.injections.createdAt)).limit(100);
  return {
    injectors: Object.fromEntries(keys.map((k) => [k, injectorsFor(sampleOf(k))])),
    eligible: Object.fromEntries(keys.map((k) => [k, clean.filter((c) => c.nodeKey === k).length])),
    all: INJECTORS.map(({ type, label, check, description }) => ({ type, label, check, description })),
    recent,
  };
});

const Body = z.object({
  nodeKey: z.string(),
  errorType: z.string(),
  nodeRunId: z.string().uuid().optional(),
  count: z.number().int().min(1).max(5).default(1),
  requireClean: z.boolean().default(true),
});

/** Menyuntik galat ke output bersih, menjalankan validator + perbaikan, mencatat detected dan repaired. */
export const POST = handle(async (req: Request) => {
  const body = Body.parse(await req.json());
  if (!INJECTORS.some((i) => i.type === body.errorType)) throw new HttpError(400, `Jenis galat tidak dikenal: ${body.errorType}`);
  if (!(injectableKeys() as string[]).includes(body.nodeKey)) throw new HttpError(400, "Analisis ini tidak bisa disuntik (dihitung program atau belum punya validator).");
  const db = await getDb();
  let candidates: string[];
  if (body.nodeRunId) {
    await requireProject(await projectOfNodeRun(body.nodeRunId));
    candidates = [body.nodeRunId];
  } else {
    await requireResearcher();
    const rows = await db
      .select({
        id: schema.nodeRuns.id,
        projectId: schema.workflows.projectId,
        own: schema.nodeRunVerdicts.ownError,
        carried: schema.nodeRunVerdicts.carriedError,
      })
      .from(schema.nodeRuns)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.nodeRuns.runId))
      .innerJoin(schema.workflows, eq(schema.workflows.id, schema.runs.workflowId))
      .leftJoin(schema.nodeRunVerdicts, eq(schema.nodeRunVerdicts.nodeRunId, schema.nodeRuns.id))
      .where(and(eq(schema.nodeRuns.nodeKey, body.nodeKey), eq(schema.nodeRuns.status, "done")));
    candidates = rows
      // "Ambil output node yang putusannya bersih"
      .filter((r) => !body.requireClean || (r.own === false && r.carried === false))
      .map((r) => r.id);
  }
  if (!candidates.length)
    throw new HttpError(
      409,
      body.requireClean
        ? "Belum ada output node ini yang putusannya bersih. Anotasi dan beri putusan dulu, atau matikan syarat 'harus bersih'."
        : "Belum ada output node ini yang selesai.",
    );
  const results = [];
  for (let i = 0; i < body.count; i++) {
    const nodeRunId = candidates[Math.floor(Math.random() * candidates.length)];
    try {
      results.push(await runInjection(nodeRunId, body.errorType, { requireClean: body.requireClean }));
    } catch (e) {
      results.push({ error: (e as Error).message, nodeRunId });
    }
  }
  return { results };
});
