-- Operator Centre 3.0 — P2: incident grouping (spec §24). One root cause (courier outage, warehouse shortage, payment
-- provider down) links many tasks; each order keeps its own history. Closing an incident never marks orders delivered
-- or paid — it returns the linked tasks to the queue with a clear next action.
CREATE TABLE ops_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  kind text NOT NULL CHECK (kind IN ('delivery','warehouse','payment','provider','other')),
  customer_note text,                -- customer-safe explanation (optional)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz
);
ALTER TABLE ops_tasks ADD COLUMN incident_id uuid REFERENCES ops_incidents(id);
CREATE INDEX ops_tasks_incident ON ops_tasks (incident_id) WHERE incident_id IS NOT NULL;
