import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { isNodeKey } from "@/lib/nodes/registry";
import { isCustomKey } from "@/lib/nodes/custom";

/**
 * Hasil setiap analisis dalam satu run beserta bukti, riwayat validasi, biaya token, dan tinjauan terakhir.
 * Dipakai canvas (run utama) dan panel Laporan (run mana pun, mis. run eksperimen).
 */
export async function loadRunNodes(runId: string | null) {
  const db = await getDb();
  // Hasil analisis yang sudah tidak dikenal (node bawaan lama sebelum penggantian node) tidak ditampilkan.
  const nodeRuns = (runId ? await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId)) : []).filter(
    (n) => isNodeKey(n.nodeKey) || isCustomKey(n.nodeKey),
  );
  const ids = nodeRuns.map((n) => n.id);
  const validation = ids.length
    ? await db
        .select()
        .from(schema.validationEvents)
        .where(and(inArray(schema.validationEvents.nodeRunId, ids), isNull(schema.validationEvents.injectionId)))
        .orderBy(schema.validationEvents.attempt)
    : [];
  const costs = ids.length
    ? await queryRows<{ node_run_id: string; purpose: string; tokens: number; calls: number }>(sql`
        SELECT node_run_id, purpose, SUM(tokens_in + tokens_out)::int AS tokens, COUNT(*)::int AS calls
        FROM llm_calls WHERE injection_id IS NULL AND node_run_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
        GROUP BY node_run_id, purpose`)
    : [];
  const reviews = ids.length ? await db.select().from(schema.reviews).where(inArray(schema.reviews.nodeRunId, ids)) : [];

  return Object.fromEntries(
    nodeRuns.map((n) => [
      n.nodeKey,
      {
        nodeRunId: n.id,
        status: n.status,
        phase: n.phase, // tahap berjalan untuk animasi: retrieve|generate|validate|repair|review
        output: n.output,
        evidence: n.input?.evidence ?? [],
        validationPassed: n.validationPassed,
        validatorEnabled: n.validatorEnabled,
        humanEnabled: n.humanEnabled,
        error: n.error,
        attempts: n.attempts,
        formatFailures: n.formatFailures,
        startedAt: n.startedAt,
        finishedAt: n.finishedAt,
        // Perubahan manusia pada hasil (path sel yang diubah) — sel ditandai "diubah manusia" di tabel.
        edits: n.edits ?? [],
        editedAt: n.editedAt,
        tokens: Object.fromEntries(costs.filter((c) => c.node_run_id === n.id).map((c) => [c.purpose, c.tokens])),
        validation: validation.filter((v) => v.nodeRunId === n.id),
        review: reviews.filter((r) => r.nodeRunId === n.id).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] ?? null,
      },
    ]),
  );
}

/** Pertanyaan agen untuk node run tertentu (pertanyaan run lain tidak ikut terhitung). */
export async function loadRunQuestions(nodeRunIds: string[]) {
  if (!nodeRunIds.length) return [];
  const db = await getDb();
  return db
    .select({
      id: schema.agentQuestions.id,
      nodeRunId: schema.agentQuestions.nodeRunId,
      nodeKey: schema.nodeRuns.nodeKey,
      label: schema.agentQuestions.label,
      question: schema.agentQuestions.question,
      answer: schema.agentQuestions.answer,
      answeredAt: schema.agentQuestions.answeredAt,
      createdAt: schema.agentQuestions.createdAt,
    })
    .from(schema.agentQuestions)
    .innerJoin(schema.nodeRuns, eq(schema.nodeRuns.id, schema.agentQuestions.nodeRunId))
    .where(inArray(schema.agentQuestions.nodeRunId, nodeRunIds))
    .orderBy(desc(schema.agentQuestions.createdAt));
}
