-- Skema awal platform eksperimen alur agen LLM untuk perencanaan strategis.
-- Bisa dijalankan langsung di SQL Editor Neon, atau lewat `npm run db:migrate`.
-- PENTING: dimensi vector(768) harus sama dengan EMBEDDING_DIM.

CREATE EXTENSION IF NOT EXISTS vector;

-- ===== Auth.js (tabel bawaan adapter Drizzle) =====
CREATE TABLE IF NOT EXISTS "user" (
  id              text PRIMARY KEY,
  name            text,
  email           text UNIQUE,
  "emailVerified" timestamp,
  image           text
);

CREATE TABLE IF NOT EXISTS account (
  "userId"            text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  type                text NOT NULL,
  provider            text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          integer,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  PRIMARY KEY (provider, "providerAccountId")
);

CREATE TABLE IF NOT EXISTS session (
  "sessionToken" text PRIMARY KEY,
  "userId"       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires        timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "verificationToken" (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamp NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- ===== Data kasus =====
CREATE TABLE IF NOT EXISTS projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  org_type     text,                          -- ormawa, UMKM, perusahaan, ...
  description  text,
  is_synthetic boolean NOT NULL DEFAULT false,-- kasus sintetis dengan kunci jawaban
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename   text NOT NULL,
  raw_text   text NOT NULL,
  is_values  boolean NOT NULL DEFAULT false, -- dokumen nilai organisasi (untuk visi-misi)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       text NOT NULL,                  -- ID sitasi, mis. "C12" (unik per proyek)
  idx         int  NOT NULL,                  -- urutan potongan dalam dokumen
  content     text NOT NULL,
  embedding   vector(768) NOT NULL,           -- samakan dengan EMBEDDING_DIM
  meta        jsonb NOT NULL DEFAULT '{}',    -- nama file, paragraf
  UNIQUE (project_id, label)
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (project_id);

-- Kunci jawaban untuk kasus sintetis
CREATE TABLE IF NOT EXISTS gold_factors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  quadrant   char(1) NOT NULL CHECK (quadrant IN ('S','W','O','T')),
  text       text NOT NULL
);

-- ===== Data eksekusi =====
CREATE TABLE IF NOT EXISTS workflows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  graph      jsonb NOT NULL,                  -- {nodes:[{key,type,position,validator,human}], edges:[{from,to}]}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  experiment_tag text NOT NULL,               -- mis. 'baseline', 'val-swot', 'opt-B10'
  config         jsonb NOT NULL,              -- {placement:{swot:{validator,human}}, model, temperature, mode}
  status         text NOT NULL DEFAULT 'pending', -- pending|running|waiting_review|done|failed
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_key          text NOT NULL,            -- 'swot', 'ifas_efas', 'tows', ...
  status            text NOT NULL DEFAULT 'pending', -- pending|running|needs_review|done|failed
  input             jsonb,                    -- {evidence:[...], parents:[...]}
  output            jsonb,
  attempts          int  NOT NULL DEFAULT 0,
  validator_enabled boolean NOT NULL,
  human_enabled     boolean NOT NULL,
  validation_passed boolean,                  -- null = validator mati
  format_failures   int  NOT NULL DEFAULT 0,  -- kegagalan format JSON (dicatat terpisah dari galat isi)
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  UNIQUE (run_id, node_key)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id  uuid NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  injection_id uuid,                          -- terisi bila panggilan berasal dari uji penyuntikan
  purpose      text NOT NULL CHECK (purpose IN ('generate','validate','repair','judge')),
  model        text,
  tokens_in    int  NOT NULL,
  tokens_out   int  NOT NULL,
  latency_ms   int  NOT NULL,
  format_error boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_node_run_idx ON llm_calls (node_run_id);

CREATE TABLE IF NOT EXISTS validation_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id  uuid NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  injection_id uuid,
  attempt      int  NOT NULL,
  check_name   text NOT NULL,                 -- 'quote_exists', 'quadrant', 'ref_valid', ...
  passed       boolean NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id uuid NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  reviewer    text NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  approved    boolean,
  changes     jsonb                           -- faktor yang diubah peninjau
);

-- ===== Data eksperimen =====
CREATE TABLE IF NOT EXISTS annotations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id uuid NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  annotator   text NOT NULL,
  item_id     text NOT NULL,                  -- ID faktor/strategi di output
  is_error    boolean NOT NULL,
  error_type  text,                           -- 'unsupported', 'wrong_quadrant', 'invalid_ref', ...
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_run_id, annotator, item_id)
);

-- Putusan akhir per node run setelah dua penilai sepakat/berdiskusi
CREATE TABLE IF NOT EXISTS node_run_verdicts (
  node_run_id   uuid PRIMARY KEY REFERENCES node_runs(id) ON DELETE CASCADE,
  own_error     boolean NOT NULL,             -- galat baru di tahap ini
  carried_error boolean NOT NULL,             -- galat terbawa dari tahap sebelumnya
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS injections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id uuid REFERENCES node_runs(id) ON DELETE CASCADE,
  node_key    text NOT NULL,
  error_type  text NOT NULL,
  item_id     text,
  original    jsonb NOT NULL,
  injected    jsonb NOT NULL,
  repaired_output jsonb,
  detected    boolean,
  repaired    boolean,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS optimization_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_tag text NOT NULL,
  method         text NOT NULL DEFAULT 'brute', -- brute | dp
  budget_tokens  int  NOT NULL,
  budget_minutes numeric NOT NULL,
  placement      jsonb NOT NULL,
  predicted_p    numeric NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',   -- parameter tahap yang dipakai
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ===== Platform lengkap (fase 2–3) =====
CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    text NOT NULL,                 -- ID dari tabel "user" Auth.js (atau email)
  role       text NOT NULL CHECK (role IN ('researcher','annotator','reviewer','org_user')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_key    text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',  -- queued|running|waiting_review|done|failed
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_key)
);

CREATE TABLE IF NOT EXISTS grand_design_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  format     text NOT NULL CHECK (format IN ('docx','pdf')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pertanyaan agen ke pengguna saat bukti kurang
CREATE TABLE IF NOT EXISTS agent_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id uuid NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       text NOT NULL,                -- ID sitasi jawaban, mis. "U3"
  question    text NOT NULL,
  answer      text,
  answered_by text,
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Pengaturan platform (model, anggaran default, codebook)
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
