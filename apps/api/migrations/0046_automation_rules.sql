-- Controlled automation (P1): trigger → condition → allowed action → journal. New rules start in SHADOW mode (only log
-- what they would do); the owner activates after seeing shadow results. Only non-financial actions exist here.
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('automation.enabled', true, 'Avtomatlashtirish qoidalari (kill switch). O‘chirilsa hech bir qoida ishlamaydi.')
ON CONFLICT (key) DO NOTHING;
CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('order_unassigned','stock_low','cod_unremitted')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  action text NOT NULL CHECK (action IN ('alert_owner','reorder_draft')),
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','active','paused')),
  daily_cap int NOT NULL DEFAULT 20 CHECK (daily_cap BETWEEN 1 AND 500),
  cooldown_hours int NOT NULL DEFAULT 24 CHECK (cooldown_hours BETWEEN 1 AND 720),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  object_id text NOT NULL,
  mode text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('would_do','done','skipped_cap','failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_rule ON automation_runs (rule_id, object_id, created_at DESC);
