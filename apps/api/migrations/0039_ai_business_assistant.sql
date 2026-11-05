-- AI Business Assistant P0 (read-only). Scope always comes from the server (auth → workspace → partner/team/grants);
-- the model never supplies identity. No ledger/order/partner tables are duplicated: tools read the existing services.
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('ai.business.read', true, 'AI biznes yordamchi: faqat o‘qish (deterministik hisobotlar). O‘chirilsa oddiy kabinet ishlashda davom etadi.'),
  ('ai.business.llm', false, 'AI biznes yordamchi: tashqi LLM (savolni tushunish). Provayder, byudjet va ma’lumot siyosati tasdiqlanmaguncha o‘chiq.'),
  ('ai.business.voice', false, 'AI biznes yordamchi: ovozli savol (P1).'),
  ('ai.business.export', false, 'AI biznes yordamchi: hisobot eksporti (P1).'),
  ('ai.business.actions', false, 'AI biznes yordamchi: amal qoralamalari (P1). Pul/coin/jarima/reklama amallari hech qachon AI orqali bajarilmaydi.')
ON CONFLICT (key) DO NOTHING;

-- One chat thread per user and workspace; messages keep redacted text + a reference to the stored report (no raw PII).
CREATE TABLE ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace text NOT NULL CHECK (workspace IN ('partner','operator','operator_lead','admin','superadmin')),
  title text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,      -- structured follow-up context: tool/metric/period/filters (never a permission source)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ai_sessions_user ON ai_sessions (user_id, workspace, updated_at DESC) WHERE deleted_at IS NULL;

-- Immutable report revision: UI answer, drilldown and (later) export are rendered from the same stored facts.
CREATE TABLE ai_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace text NOT NULL,
  scope_hash text NOT NULL,                       -- hash of the server-derived scope (partner id / team / grants revision)
  tool text NOT NULL,
  arguments jsonb NOT NULL,
  result jsonb NOT NULL,
  metric_version int NOT NULL DEFAULT 1,
  as_of timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_report_user ON ai_report_snapshots (user_id, created_at DESC);

CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  text text NOT NULL,                             -- user text with phones/emails/cards masked; assistant = deterministic summary
  report_id uuid REFERENCES ai_report_snapshots(id),
  status text,                                    -- ok | zero | unknown | partial | forbidden | unsupported | unavailable
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_session ON ai_messages (session_id, created_at);

-- Request trace without personal data: which tool, status and how long it took.
CREATE TABLE ai_query_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  workspace text NOT NULL,
  intent text,
  tool text,
  status text NOT NULL,
  duration_ms int,
  provider text NOT NULL DEFAULT 'deterministic',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_query_runs_day ON ai_query_runs (created_at);

CREATE TABLE ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  report_id uuid REFERENCES ai_report_snapshots(id),
  verdict text NOT NULL CHECK (verdict IN ('correct','wrong','unclear')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
