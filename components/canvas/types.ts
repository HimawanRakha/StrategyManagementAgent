// Bentuk respons GET /api/projects/[id] untuk halaman canvas (tanggal berupa string setelah JSON).
import type { CustomSpec, EvidenceChunk, GraphNode, NodeSettings, ValidatorSettings, WorkflowGraph } from "@/lib/db/schema";
import type { CanvasWarning } from "@/lib/engine/canvas";

export type ValidationRow = {
  id: string;
  attempt: number;
  checkName: string;
  passed: boolean;
  detail: { kind?: "code" | "llm"; label?: string; failures?: { check?: string; itemId?: string; message: string }[] } | null;
};

/** Tahap analisis yang sedang berjalan (untuk animasi canvas). */
export type RunPhase = "retrieve" | "generate" | "validate" | "repair" | "review";

export type NodeState = {
  nodeRunId: string;
  status: string;
  phase?: RunPhase | string | null;
  output: unknown;
  evidence: EvidenceChunk[];
  validationPassed: boolean | null;
  validatorEnabled: boolean;
  humanEnabled: boolean;
  error: string | null;
  attempts: number;
  formatFailures: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Perubahan manusia pada output mentah (path → nilai lama/baru). */
  edits?: { path: (string | number)[]; from: unknown; to: unknown; at: string }[];
  /** Waktu perubahan manusia terakhir (null bila belum pernah diubah). */
  editedAt?: string | null;
  tokens: Record<string, number>;
  validation: ValidationRow[];
  review: { startedAt: string; endedAt: string | null; approved: boolean | null } | null;
};

export type DocRow = { id: string; filename: string; input_node: string | null; is_values: boolean; created_at: string; chars: number; chunks: number };

export type QuestionRow = {
  id: string;
  nodeRunId: string;
  nodeKey: string;
  label: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
};

export type ProjectData = {
  project: { id: string; name: string; orgType: string | null; description: string | null };
  workflowId: string;
  canvas: WorkflowGraph;
  warnings: CanvasWarning[];
  runId: string | null;
  nodes: Record<string, NodeState>;
  documents: DocRow[];
  questions: QuestionRow[];
};

export type ExecResult = { runId?: string; ran: string | null; status: string | null | undefined; remaining: string[]; message: string | null };

/** Data node React Flow (dipetakan 1:1 ke GraphNode). */
export type FlowData = {
  gtype: GraphNode["type"];
  key?: string; // process: node_key bawaan atau "custom"
  label?: string;
  values?: boolean; // input
  text?: string; // note
  settings?: NodeSettings & ValidatorSettings;
  custom?: CustomSpec; // process kustom
};

/** Perubahan data node: objek, atau fungsi dari data terbaru (aman untuk perubahan beruntun yang cepat). */
export type FlowPatch = Partial<FlowData> | ((current: FlowData) => Partial<FlowData>);

/** Item yang ditarik dari palet. */
export type PaletteItem = { type: GraphNode["type"]; key?: string; label?: string; values?: boolean };

/** Penempatan validator/tinjauan per kunci analisis (mis. hasil optimasi). */
export type PlacementMap = Record<string, { validator: boolean; human: boolean }>;

/** Status jalannya analisis (satu runner untuk seluruh halaman). */
export type RunState = {
  target: string | null; // kunci tujuan; null = semua
  current: string | null; // analisis yang sedang/akan dijalankan
  label?: string; // nama tampilan analisis `current`
  phase?: string | null; // tahap berjalan (retrieve|generate|validate|repair|review)
  step: number;
  total: number;
};
