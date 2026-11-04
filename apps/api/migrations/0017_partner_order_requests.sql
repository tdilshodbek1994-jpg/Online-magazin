-- Operator Centre 3.0 — P1: partner requests from the order card go to the operator queue (spec §08, §16).
-- Several requests on one order join the same open partner_request task (no duplicate cases). The answer the partner
-- sees is stored separately from internal notes.
CREATE TABLE partner_order_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  kind text NOT NULL CHECK (kind IN ('callback_time','address','variant_change','commission_question','message')),
  body text NOT NULL,
  preferred_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  answer text,                       -- partner-visible answer only
  answered_by uuid REFERENCES users(id),
  task_id uuid REFERENCES ops_tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX partner_order_requests_order ON partner_order_requests (order_id, created_at DESC);
CREATE INDEX partner_order_requests_partner ON partner_order_requests (partner_id, created_at DESC);
