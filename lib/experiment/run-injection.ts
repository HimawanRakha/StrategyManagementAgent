import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { getNode } from "@/lib/nodes/registry";
import { createLlmSession } from "@/lib/engine/llm-session";
import { loadContext, logValidation, MAX_REPAIR_ATTEMPTS, repair, runValidators } from "@/lib/engine/run-node";
import { inject } from "./injectors";

/** Output mentah (usulan AI, sebelum kalkulator) dari node run; output lama disaring skema bila kolom raw kosong. */
function rawOutput(nr: { raw: unknown; output: unknown }, def: ReturnType<typeof getNode>): unknown {
  if (nr.raw !== null && nr.raw !== undefined) return nr.raw;
  const p = def.schema.safeParse(nr.output);
  return p.success ? p.data : nr.output;
}

/**
 * 1. Ambil output node yang putusannya bersih.  2. Sisipkan satu galat yang diketahui (penyuntik generik, lihat injectors.ts).
 * 3. Jalankan validator dan siklus perbaikan.    4. Catat detected dan repaired.
 */
export async function runInjection(nodeRunId: string, errorType: string, opts: { requireClean?: boolean; seed?: number } = {}) {
  const db = await getDb();
  const { nr, run, ctx } = await loadContext(nodeRunId);
  if (nr.status !== "done" || !nr.output) throw new Error("Node run belum selesai");
  if (opts.requireClean !== false) {
    const [v] = await db.select().from(schema.nodeRunVerdicts).where(eq(schema.nodeRunVerdicts.nodeRunId, nodeRunId));
    if (!v) throw new Error("Node run ini belum punya putusan anotasi; penyuntikan hanya untuk output yang putusannya bersih");
    if (v.ownError || v.carriedError) throw new Error("Putusan node run ini tidak bersih");
  }
  const def = getNode(nr.nodeKey);
  if (def.kind === "code") throw new Error(`${def.label} dihitung program (bukan AI); penyuntikan galat tidak berlaku`);
  if (!def.validate) throw new Error(`${def.label} belum punya validator`);
  // Validator di mesin memeriksa output MENTAH (sebelum kalkulator), jadi penyuntikan juga pada output mentah.
  const original = rawOutput(nr, def);
  const seed = opts.seed ?? Math.floor(Math.random() * 1000);
  const inj = inject(nr.nodeKey, errorType, original, ctx.evidence, seed);
  if (!inj) throw new Error("Output ini tidak punya bagian yang bisa disuntik dengan jenis galat tersebut");

  const [row] = await db
    .insert(schema.injections)
    .values({ nodeRunId, nodeKey: nr.nodeKey, errorType, itemId: inj.itemId, original, injected: inj.injected })
    .returning();
  const llm = createLlmSession({ nodeRunId, injectionId: row.id, model: run.config.model, temperature: run.config.temperature });

  let out = inj.injected;
  let detected = false;
  let repaired: boolean | null = null;
  for (let attempt = 0; ; attempt++) {
    const report = await runValidators(def, out, ctx, llm);
    await logValidation(nodeRunId, attempt, report, row.id);
    // Terdeteksi bila validator menolak bagian yang disuntik (pada pemeriksaan pertama).
    if (attempt === 0) detected = report.failures.some((f) => inj.matches(f));
    if (!detected) break;
    if (report.passed || attempt >= MAX_REPAIR_ATTEMPTS) break;
    out = await repair(def, ctx, out, report.failures, llm);
  }
  if (detected) repaired = inj.isRepaired(out);

  await db
    .update(schema.injections)
    .set({ detected, repaired, repairedOutput: detected ? out : null })
    .where(eq(schema.injections.id, row.id));
  return {
    id: row.id,
    nodeKey: nr.nodeKey,
    errorType,
    itemId: inj.itemId,
    location: inj.location,
    description: inj.description,
    detected,
    repaired,
  };
}
