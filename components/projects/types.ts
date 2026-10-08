// Tipe respons API proyek (sisi client; tanggal datang sebagai string ISO).
import type { ChunkMeta, RunConfig, RunStatus, WorkflowGraph } from "@/lib/db/schema";

export const ORG_TYPES = ["ormawa", "UMKM", "perusahaan", "komunitas", "lainnya"] as const;

export type Project = {
  id: string;
  name: string;
  orgType: string | null;
  description: string | null;
  isSynthetic: boolean;
  createdBy?: string | null;
  createdAt: string;
};

export type ProjectDocument = { id: string; filename: string; is_values: boolean; created_at: string; chars: number; chunks: number };

export type Workflow = { id: string; name: string; graph: WorkflowGraph; createdAt: string; updatedAt: string };

export type Run = { id: string; workflowId: string; experimentTag: string; config: RunConfig; status: RunStatus | string; createdAt: string };

export type Quadrant = "S" | "W" | "O" | "T";
export type GoldFactor = { id: string; quadrant: Quadrant; text: string };

export type AgentQuestion = {
  id: string;
  nodeRunId: string;
  runId?: string;
  nodeKey?: string;
  label: string;
  question: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};

export type ProjectDetail = {
  project: Project;
  documents: ProjectDocument[];
  workflows: Workflow[];
  runs: Run[];
  gold: GoldFactor[];
  questions: AgentQuestion[];
};

export type Chunk = { id: string; label: string; idx: number; content: string; meta: ChunkMeta };
