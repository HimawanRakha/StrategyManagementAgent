// Bentuk respons API (setelah JSON: tanggal berupa string) untuk halaman run, kanvas, dan grand design.
import type { EvidenceChunk, NodeRunStatus, RunConfig, RunStatus, WorkflowGraph } from "@/lib/db/schema";
import type { Evidence } from "@/lib/nodes/schemas";

export type ProjectJson = { id: string; name: string; orgType: string | null; description: string | null; createdAt: string };
export type WorkflowJson = { id: string; projectId: string; name: string; graph: WorkflowGraph; createdAt: string; updatedAt: string };
export type RunJson = { id: string; workflowId: string; experimentTag: string; config: RunConfig; status: RunStatus | string; createdBy: string | null; createdAt: string };

export type NodeRunJson = {
  id: string;
  runId: string;
  nodeKey: string;
  status: NodeRunStatus | string;
  input: { evidence: EvidenceChunk[]; parents: string[] } | null;
  output: unknown;
  attempts: number;
  validatorEnabled: boolean;
  humanEnabled: boolean;
  validationPassed: boolean | null;
  formatFailures: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ValidationEventJson = {
  id: string;
  nodeRunId: string;
  attempt: number;
  checkName: string;
  passed: boolean;
  detail: { kind?: "code" | "llm"; failures?: { check: string; itemId?: string; message: string }[] } | null;
  createdAt?: string;
};

export type CostRow = { node_run_id: string; purpose: string; calls: number; tokens_in: number; tokens_out: number; latency_ms: number; format_errors: number };
export type ReviewJson = { id: string; nodeRunId: string; reviewer: string; startedAt: string; endedAt: string | null; approved: boolean | null; changes: unknown };
export type QuestionJson = {
  id: string;
  nodeRunId: string;
  projectId: string;
  label: string;
  question: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};
export type JobJson = { nodeKey: string; status: string; attempts: number; lastError: string | null };

export type RunDetail = {
  run: RunJson;
  workflow: WorkflowJson;
  project: ProjectJson;
  role: string;
  user: { id: string; name: string | null };
  nodeRuns: NodeRunJson[];
  validation: ValidationEventJson[];
  costs: CostRow[];
  reviews: ReviewJson[];
  questions: QuestionJson[];
  jobs: JobJson[];
  order: string[];
};

export type ExecResult = { ran: string | null; status: string | null | undefined; remaining: string[]; message: string | null };

/** Elemen yang diklik di tampilan output (faktor, temuan, strategi, dst.). */
export type Picked = { id: string; text?: string; evidence?: Evidence[] };

/** Sumber potongan untuk penampil kutipan. */
export type ChunkInfo = { content: string; source: string; kind?: "document" | "user_answer"; similarity?: number; focus?: string };
export type ChunkLookup = (chunkId: string) => ChunkInfo | undefined;

export const isUserChunk = (id: string, kind?: string) => kind === "user_answer" || id.startsWith("U");
export const hasUserEvidence = (ev: Evidence[] | undefined) => !!ev?.some((e) => e.chunkId?.startsWith("U"));
