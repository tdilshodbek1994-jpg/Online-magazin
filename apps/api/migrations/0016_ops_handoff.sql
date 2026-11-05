-- Operator Centre 3.0 — P1: handoff between operators (spec §15). Until the receiver accepts, the task stays with
-- the sender (or the named team); nothing becomes ownerless. A supervisor transfer is a separate, reasoned event.
CREATE TABLE ops_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ops_tasks(id),
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  package jsonb NOT NULL,            -- done, customer_said, promised, missing, next, deadline
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  decided_at timestamptz
);
-- One pending handoff per task.
CREATE UNIQUE INDEX ops_handoffs_one_pending ON ops_handoffs (task_id) WHERE status='pending';
CREATE INDEX ops_handoffs_to ON ops_handoffs (to_user_id, status);
