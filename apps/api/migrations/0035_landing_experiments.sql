-- Landing & Target P2B: A/B experiments between two revisions of one landing. Sticky assignment per visitor
-- (subject key = user or hashed guest token — no PII), experiment snapshot on orders, no automatic winner.
CREATE TABLE landing_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_id uuid NOT NULL REFERENCES landing_pages(id),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped')),
  variant_a_revision int NOT NULL,
  variant_b_revision int NOT NULL,
  split_bps int NOT NULL DEFAULT 5000 CHECK (split_bps BETWEEN 100 AND 9900),
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CHECK (variant_a_revision <> variant_b_revision)
);
CREATE UNIQUE INDEX landing_experiments_one_running ON landing_experiments (landing_id) WHERE status='running';
CREATE TABLE experiment_assignments (
  experiment_id uuid NOT NULL REFERENCES landing_experiments(id),
  subject_key text NOT NULL,
  variant text NOT NULL CHECK (variant IN ('A','B')),
  revision int NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_key)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS experiment_snapshot jsonb;
INSERT INTO business_policies (key, version, value, status, is_demo, source_note) VALUES
  ('experiments.min_evidence', 1, '{"exposures_per_variant": 100, "orders_total": 20}', 'draft', true, 'DEMO default — below this the result is "insufficient data"; the owner always decides, no auto-winner')
ON CONFLICT DO NOTHING;
