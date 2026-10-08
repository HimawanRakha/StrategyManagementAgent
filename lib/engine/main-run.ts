import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { WorkflowGraph } from "@/lib/db/schema";
import { engineGraph, normalizeGraph } from "./canvas";

// Setiap proyek punya satu canvas (workflow) dan satu run "utama" yang menyimpan hasil terakhir tiap node.
// Run lain (tag berbeda) dibuat oleh modul eksperimen.

export const MAIN_TAG = "utama";
/** Tag run utama yang diarsipkan lewat "Ulang dari awal" (tetap tersimpan sebagai data eksperimen). */
export const ARCHIVE_TAG = "arsip";

/** Canvas proyek (dibuat kosong bila belum ada). */
export async function getCanvas(projectId: string) {
  const db = await getDb();
  const [wf] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.projectId, projectId))
    .orderBy(schema.workflows.createdAt)
    .limit(1);
  if (wf) return { ...wf, graph: normalizeGraph(wf.graph) };
  const [created] = await db
    .insert(schema.workflows)
    .values({ projectId, name: "Alur berpikir", graph: { nodes: [], edges: [] } })
    .returning();
  return created;
}

export async function getMainRun(workflowId: string) {
  const db = await getDb();
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.workflowId, workflowId), eq(schema.runs.experimentTag, MAIN_TAG)))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * Pastikan run utama ada dan setiap analisis di canvas punya node run.
 * Sakelar validator/tinjauan dari canvas disalin ke node run yang belum selesai.
 */
export async function ensureMainRun(workflowId: string, graph: WorkflowGraph) {
  const db = await getDb();
  const eg = engineGraph(graph);
  let run = await getMainRun(workflowId);
  if (!run) {
    [run] = await db
      .insert(schema.runs)
      .values({ workflowId, experimentTag: MAIN_TAG, config: { placement: {}, mode: "manual" } })
      .returning();
  }
  const existing = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, run.id));
  const byKey = new Map(existing.map((n) => [n.nodeKey, n]));
  const placement: Record<string, { validator: boolean; human: boolean }> = {};
  for (const n of eg.nodes) {
    const key = n.key!;
    const flags = { validator: n.validator ?? true, human: n.human ?? false };
    placement[key] = flags;
    const nr = byKey.get(key);
    if (!nr) {
      await db.insert(schema.nodeRuns).values({ runId: run.id, nodeKey: key, validatorEnabled: flags.validator, humanEnabled: flags.human });
    } else if (nr.status !== "done" && (nr.validatorEnabled !== flags.validator || nr.humanEnabled !== flags.human)) {
      await db
        .update(schema.nodeRuns)
        .set({ validatorEnabled: flags.validator, humanEnabled: flags.human })
        .where(eq(schema.nodeRuns.id, nr.id));
    }
  }
  await db.update(schema.runs).set({ config: { ...run.config, placement } }).where(eq(schema.runs.id, run.id));
  return run;
}
