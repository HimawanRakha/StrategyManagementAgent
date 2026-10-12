import "server-only";
// Susun dokumen grand design dari run: satu bagian per analisis dalam URUTAN ALUR canvas, lengkap dengan sheet,
// blok dokumen, rumus, ringkasan, jumlah edit manusia, hasil pemeriksaan terakhir, pertanyaan agen, jejak rujukan, dan sumber.
// Laporan jujur: analisis yang gagal/belum selesai tetap tercantum beserta statusnya, dan semua pemeriksaan yang gagal dicatat.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { EvidenceChunk, NodeRunStatus } from "@/lib/db/schema";
import type { CheckResult, Failure } from "@/lib/nodes/types";
import { NODE_KEYS, isNodeKey } from "@/lib/nodes/registry";
import { labelOf, normalizeGraph, processKeys } from "@/lib/engine/canvas";
import { checkTraceComplete, traceChains } from "./trace";
import { STATUS_LABEL, collectCitations, gridCitations, type GrandDesignDoc, type SectionStatus } from "./doc";
import { buildSection } from "./section";

export type { GrandDesignDoc, DocSection, DocCheck, GrandDesignDocJson } from "./doc";
export { docForJson } from "./doc";

type ExecSentence = { text: string; refs: string[] };

/** Urutan bagian: urutan alur canvas, lalu analisis lain yang diminta/ada di run (urutan registry, kustom di akhir). */
function orderKeys(flow: string[], scope: Set<string> | null, runKeys: string[]): string[] {
  const inScope = (k: string) => k !== "grand_design" && (!scope || scope.has(k));
  const out = flow.filter(inScope);
  const rest = [...new Set([...(scope ? [...scope] : []), ...runKeys])].filter((k) => inScope(k) && !out.includes(k));
  const rank = (k: string) => (isNodeKey(k) ? NODE_KEYS.indexOf(k) : 1000);
  rest.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...out, ...rest];
}

/**
 * Susun dokumen grand design.
 * `keys`: analisis yang disusun (hulu node output); kosong = semua analisis di canvas/run.
 * `labels`: label tampilan per kunci (bawaan: label di canvas).
 */
export async function composeGrandDesign(runId: string, keys?: string[], labels: Record<string, string> = {}): Promise<GrandDesignDoc> {
  const db = await getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error("Run tidak ditemukan");
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId));
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, wf.projectId));
  const graph = normalizeGraph(wf.graph);
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  const byKey = new Map(nrs.map((n) => [n.nodeKey, n]));

  let flow: string[] = [];
  try {
    flow = processKeys(graph);
  } catch {
    flow = [];
  }
  const scope = keys?.length ? new Set(keys) : null;
  const ordered = orderKeys(flow, scope, nrs.map((n) => n.nodeKey));
  const label = (k: string) => labels[k] ?? labelOf(graph, k);

  // Output selesai seluruh run (konteks sheet: node boleh menampilkan teks butir yang dirujuknya).
  const inputs: Record<string, unknown> = {};
  for (const n of nrs) if (n.status === "done" && n.output !== null && n.output !== undefined) inputs[n.nodeKey] = n.output;

  // Hasil pemeriksaan pada percobaan terakhir tiap node run (tanpa hasil uji penyuntikan galat).
  const ids = nrs.map((n) => n.id);
  const events = ids.length
    ? await db
        .select()
        .from(schema.validationEvents)
        .where(and(inArray(schema.validationEvents.nodeRunId, ids), isNull(schema.validationEvents.injectionId)))
    : [];
  const lastAttempt = new Map<string, number>();
  for (const e of events) lastAttempt.set(e.nodeRunId, Math.max(lastAttempt.get(e.nodeRunId) ?? -1, e.attempt));
  const checksOf = (nodeRunId: string): CheckResult[] =>
    events
      .filter((e) => e.nodeRunId === nodeRunId && e.attempt === lastAttempt.get(nodeRunId))
      .map((e) => {
        const d = (e.detail ?? {}) as { kind?: "code" | "llm"; failures?: Failure[]; label?: string };
        return { check: e.checkName, kind: d.kind ?? "code", passed: e.passed, failures: Array.isArray(d.failures) ? d.failures : [], label: d.label };
      });

  // Pertanyaan agen yang belum dijawab.
  const questions = ids.length
    ? await db
        .select({ nodeRunId: schema.agentQuestions.nodeRunId, label: schema.agentQuestions.label, question: schema.agentQuestions.question })
        .from(schema.agentQuestions)
        .where(and(inArray(schema.agentQuestions.nodeRunId, ids), isNull(schema.agentQuestions.answer)))
        .orderBy(schema.agentQuestions.createdAt)
    : [];

  const sections = ordered.map((k) => {
    const nr = byKey.get(k);
    const status: SectionStatus = nr?.status ?? "absent";
    return buildSection({
      key: k,
      label: label(k),
      status,
      output: nr?.status === "done" ? nr.output : undefined,
      inputs,
      error: nr?.error ?? null,
      edits: nr?.edits ?? [],
      validatorEnabled: nr?.validatorEnabled ?? false,
      validationPassed: nr?.validationPassed ?? null,
      checks: nr ? checksOf(nr.id) : [],
      questions: nr ? questions.filter((q) => q.nodeRunId === nr.id).map((q) => ({ label: q.label, question: q.question })) : [],
    });
  });

  // Ringkasan eksekutif dari node grand design.
  const gd = byKey.get("grand_design");
  const gdOut = gd?.status === "done" ? (gd.output as { executiveSummary?: ExecSentence[] } | null) : null;
  const executiveSummary = Array.isArray(gdOut?.executiveSummary) ? gdOut!.executiveSummary! : null;
  const gdStatus = (gd?.status ?? "absent") as NodeRunStatus | "absent";

  const unavailable = sections.filter((s) => !s.available).map((s) => ({ key: s.key, label: s.label, status: s.statusLabel }));
  if (!executiveSummary)
    unavailable.push({ key: "grand_design", label: "Ringkasan eksekutif (grand design)", status: gd ? STATUS_LABEL[gdStatus] : "tidak ada node output" });

  // Jejak rujukan atas analisis dalam cakupan.
  const scoped: Record<string, unknown> = {};
  for (const s of sections) if (s.available) scoped[s.key] = s.output;
  const trace = { ...checkTraceComplete(scoped), chains: traceChains(scoped) };

  // Sumber yang dikutip (output + sel sheet), isi dari bukti node run atau tabel potongan.
  const evidence = new Map<string, EvidenceChunk>();
  for (const nr of nrs) for (const e of nr.input?.evidence ?? []) if (!evidence.has(e.id)) evidence.set(e.id, e);
  const cited = new Set<string>();
  for (const s of sections) {
    if (!s.available) continue;
    collectCitations(s.output, cited);
    gridCitations(s.grids, cited);
  }
  for (const sent of executiveSummary ?? []) for (const r of sent.refs ?? []) if (/^[CU]\d+$/.test(r)) cited.add(r);
  const missing = [...cited].filter((c) => !evidence.has(c) && /^C\d+$/.test(c));
  if (missing.length) {
    const rows = await db
      .select({ label: schema.chunks.label, content: schema.chunks.content, meta: schema.chunks.meta })
      .from(schema.chunks)
      .where(and(eq(schema.chunks.projectId, project.id), inArray(schema.chunks.label, missing)));
    for (const r of rows) evidence.set(r.label, { id: r.label, content: r.content, source: r.meta?.filename ?? "dokumen", kind: "document" });
  }
  const sources: GrandDesignDoc["sources"] = {};
  for (const c of [...cited].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const e = evidence.get(c);
    sources[c] = e ? { source: e.source, kind: e.kind, content: e.content } : { source: "(potongan tidak ditemukan)", kind: c.startsWith("U") ? "user_answer" : "document", content: "" };
  }

  const keyResults = sections.filter((s) => s.available && s.summary).map((s) => ({ key: s.key, label: s.label, text: s.summary! }));
  const openQuestions = sections.flatMap((s) => s.questions.map((q) => ({ ...q, nodeKey: s.key, nodeLabel: s.label })));
  if (gd) {
    for (const q of questions.filter((x) => x.nodeRunId === gd.id))
      openQuestions.push({ label: q.label, question: q.question, nodeKey: "grand_design", nodeLabel: label("grand_design") });
  }

  return {
    projectName: project.name,
    orgType: project.orgType,
    description: project.description ?? null,
    runId,
    experimentTag: run.experimentTag,
    generatedAt: new Date().toISOString(),
    executiveSummary,
    executiveStatus: gd ? STATUS_LABEL[gdStatus] : "tidak ada node output",
    keyResults,
    sections,
    unavailable,
    trace,
    sources,
    questions: openQuestions,
    keys: ordered,
  };
}

/** Bukti dari jawaban pengguna (label U…). */
export const fromUser = (evidence: { chunkId: string }[]) => evidence.some((e) => e.chunkId.startsWith("U"));
