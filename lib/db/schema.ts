// Skema Drizzle; cermin dari drizzle/0000_init.sql (SQL adalah sumber kebenaran migrasi).
import {
  pgTable, uuid, text, boolean, timestamp, jsonb, integer, numeric, char, vector,
  unique,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 768);

// ===== Data kasus =====
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  orgType: text("org_type"),
  description: text("description"),
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  rawText: text("raw_text").notNull(),
  isValues: boolean("is_values").notNull().default(false),
  inputNode: text("input_node"), // ID node input di canvas
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  idx: integer("idx").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
  meta: jsonb("meta").$type<ChunkMeta>().notNull().default({} as ChunkMeta),
}, (t) => [unique().on(t.projectId, t.label)]);

export type ChunkMeta = { filename?: string; paragraphs?: [number, number]; page?: number; embedder?: string };

export const goldFactors = pgTable("gold_factors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  quadrant: char("quadrant", { length: 1 }).$type<"S" | "W" | "O" | "T">().notNull(),
  text: text("text").notNull(),
});

// ===== Data eksekusi =====
/**
 * Node canvas alur berpikir:
 *  input     = dokumen (jajar genjang)            process   = analisis bawaan atau kustom (persegi panjang)
 *  output    = dokumen hasil                      validator = pemeriksaan otomatis untuk proses yang menyambung ke sini
 *  review    = tinjauan manusia (belah ketupat)   note      = catatan tempel (tidak dijalankan)
 */
export type CanvasNodeType = "input" | "process" | "output" | "validator" | "review" | "note";

/** Pengaturan per node proses (bawaan maupun kustom). */
export type NodeSettings = {
  note?: string;                     // catatan/instruksi tambahan untuk AI
  focus?: string;                    // kata kunci tambahan untuk mencari bukti di dokumen
  depth?: "sedikit" | "sedang" | "banyak"; // jumlah potongan dokumen yang diambil
  /** Dokumen yang dibaca: hanya dari node input yang tersambung, atau semua dokumen proyek. Bawaan: tersambung bila ada input tersambung. */
  sourceScope?: "tersambung" | "semua";
  temperature?: number;              // kreativitas AI (0–1)
  model?: string;                    // ganti model untuk node ini
};

/**
 * Aturan pemeriksaan buatan pengguna pada elemen validator.
 *  ai           = AI menilai setiap butir terhadap aturan yang ditulis (mis. "setiap strategi menyebut divisi penanggung jawab")
 *  contains     = setiap butir wajib memuat salah satu kata (dipisah koma)
 *  not_contains = tidak boleh ada butir yang memuat kata-kata ini
 *  measurable   = setiap butir wajib memuat ukuran (angka, persentase, jumlah)
 *  min_items / max_items = jumlah butir minimal / maksimal
 */
export type ValidatorRule = {
  id: string;
  kind: "ai" | "contains" | "not_contains" | "measurable" | "min_items" | "max_items";
  text?: string;                     // aturan (ai) atau kata-kata (contains/not_contains)
  value?: number;                    // untuk min_items / max_items
  enabled?: boolean;                 // bawaan: aktif
};

/** Pengaturan elemen validator. */
export type ValidatorSettings = {
  disabledChecks?: string[];         // pemeriksaan bawaan yang dimatikan
  maxRepair?: number;                // batas percobaan perbaikan (0–3)
  rules?: ValidatorRule[];           // aturan pemeriksaan tambahan buatan pengguna
};

/** Definisi node proses kustom buatan pengguna. */
export type CustomSpec = {
  name: string;
  instruction: string;               // apa yang harus dikerjakan AI
  prefix?: string;                   // awalan ID butir, mis. "K" → K1, K2
  requireEvidence?: boolean;         // setiap butir wajib berkutipan dokumen (bawaan: ya)
  format?: "list" | "table";         // bentuk hasil (bawaan: daftar butir)
  columns?: string[];                // bentuk tabel: nama kolom yang diminta pengguna
};

export type GraphNode = {
  id: string;
  type: CanvasNodeType;
  key?: string;                      // process: node_key bawaan (mis. "swot") atau "custom"
  label?: string;                    // judul tampilan
  position?: { x: number; y: number };
  values?: boolean;                  // input: dokumen nilai organisasi (untuk visi-misi)
  text?: string;                     // note: isi catatan
  settings?: NodeSettings & ValidatorSettings;
  custom?: CustomSpec;               // process kustom
  /** @deprecated graf lama; penempatan kini lewat elemen validator/review di canvas */
  validator?: boolean;
  /** @deprecated */
  human?: boolean;
};
export type GraphEdge = { from: string; to: string };
export type WorkflowGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  graph: jsonb("graph").$type<WorkflowGraph>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Placement = Record<string, { validator: boolean; human: boolean }>;
export type RunConfig = {
  placement: Placement;
  model?: string;
  temperature?: number;
  mode?: "manual" | "auto";
  /** Dihentikan sementara oleh pengguna: analisis yang sedang berjalan diselesaikan, berikutnya tidak dimulai. */
  paused?: boolean;
};

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  experimentTag: text("experiment_tag").notNull(),
  config: jsonb("config").$type<RunConfig>().notNull(),
  status: text("status").$type<RunStatus>().notNull().default("pending"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Diisi saat run utama diarsipkan lewat "Ulang dari awal". */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
export type RunStatus = "pending" | "running" | "waiting_review" | "done" | "failed";

export type NodeRunStatus = "pending" | "running" | "needs_review" | "done" | "failed";
export const nodeRuns = pgTable("node_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  nodeKey: text("node_key").notNull(),
  status: text("status").$type<NodeRunStatus>().notNull().default("pending"),
  input: jsonb("input").$type<NodeRunInput>(),
  output: jsonb("output"),
  attempts: integer("attempts").notNull().default(0),
  validatorEnabled: boolean("validator_enabled").notNull(),
  humanEnabled: boolean("human_enabled").notNull(),
  validationPassed: boolean("validation_passed"),
  formatFailures: integer("format_failures").notNull().default(0),
  phase: text("phase"), // tahap berjalan: retrieve|generate|validate|repair (animasi canvas)
  /** Output mentah (usulan AI, sesuai skema node) sebelum kalkulator; sumber untuk edit manusia. */
  raw: jsonb("raw"),
  /** Riwayat perubahan manusia pada output mentah. */
  edits: jsonb("edits").$type<NodeEdit[]>().notNull().default([]),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  /** Keterangan terkini saat berjalan (menunggu AI, coba ulang, pindah model). */
  notice: text("notice"),
  noticeAt: timestamp("notice_at", { withTimezone: true }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [unique().on(t.runId, t.nodeKey)]);

export type EvidenceChunk = {
  id: string;            // label sitasi, "C12" atau "U3" (jawaban pengguna)
  content: string;
  source: string;        // nama file atau "Jawaban pengguna"
  similarity?: number;
  focus?: string;        // fokus kueri yang menemukannya
  kind: "document" | "user_answer";
};
export type NodeRunInput = { evidence: EvidenceChunk[]; parents: string[] };
/** Satu perubahan manusia pada output mentah node: path (mis. ["ratings",0,"values",2,"rating"]), nilai lama → baru. */
export type NodeEdit = { path: (string | number)[]; from: unknown; to: unknown; at: string };

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").notNull().references(() => nodeRuns.id, { onDelete: "cascade" }),
  injectionId: uuid("injection_id"),
  purpose: text("purpose").$type<"generate" | "validate" | "repair" | "judge">().notNull(),
  model: text("model"),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  formatError: boolean("format_error").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const validationEvents = pgTable("validation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").notNull().references(() => nodeRuns.id, { onDelete: "cascade" }),
  injectionId: uuid("injection_id"),
  attempt: integer("attempt").notNull(),
  checkName: text("check_name").notNull(),
  passed: boolean("passed").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").notNull().references(() => nodeRuns.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  approved: boolean("approved"),
  changes: jsonb("changes"),
});

// ===== Data eksperimen =====
export const annotations = pgTable("annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").notNull().references(() => nodeRuns.id, { onDelete: "cascade" }),
  annotator: text("annotator").notNull(),
  itemId: text("item_id").notNull(),
  isError: boolean("is_error").notNull(),
  errorType: text("error_type"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.nodeRunId, t.annotator, t.itemId)]);

export const nodeRunVerdicts = pgTable("node_run_verdicts", {
  nodeRunId: uuid("node_run_id").primaryKey().references(() => nodeRuns.id, { onDelete: "cascade" }),
  ownError: boolean("own_error").notNull(),
  carriedError: boolean("carried_error").notNull(),
  decidedBy: text("decided_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const injections = pgTable("injections", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").references(() => nodeRuns.id, { onDelete: "cascade" }),
  nodeKey: text("node_key").notNull(),
  errorType: text("error_type").notNull(),
  itemId: text("item_id"),
  original: jsonb("original").notNull(),
  injected: jsonb("injected").notNull(),
  repairedOutput: jsonb("repaired_output"),
  detected: boolean("detected"),
  repaired: boolean("repaired"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const optimizationResults = pgTable("optimization_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentTag: text("experiment_tag").notNull(),
  method: text("method").notNull().default("brute"),
  budgetTokens: integer("budget_tokens").notNull(),
  budgetMinutes: numeric("budget_minutes", { mode: "number" }).notNull(),
  placement: jsonb("placement").$type<Placement>().notNull(),
  predictedP: numeric("predicted_p", { mode: "number" }).notNull(),
  params: jsonb("params").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ===== Platform lengkap =====
export type JobStatus = "queued" | "running" | "waiting_review" | "done" | "failed";
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  nodeKey: text("node_key").notNull(),
  status: text("status").$type<JobStatus>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.runId, t.nodeKey)]);

export const grandDesignExports = pgTable("grand_design_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  format: text("format").$type<"docx" | "pdf" | "xlsx">().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentQuestions = pgTable("agent_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeRunId: uuid("node_run_id").notNull().references(() => nodeRuns.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  answeredBy: text("answered_by"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
