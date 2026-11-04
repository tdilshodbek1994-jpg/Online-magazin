-- Operator Centre 3.0 — P0 (docs/ops/AUDIT.md). Additive only: existing orders/call_logs/confirmations stay the
-- source of truth for the order; this adds the WORK layer on top (who does what next, by when), shifts and audit.

-- Shift state of a staff member: only "working" may take new work; break/busy/off keep their active tasks.
CREATE TABLE staff_shifts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  state text NOT NULL DEFAULT 'off' CHECK (state IN ('off','working','break','busy')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- One unit of operator work. An order can have several tasks (confirm, callback, missing info, problem, partner
-- request); each has its own owner, state, due time and next action. Never a second order store.
CREATE TABLE ops_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  type text NOT NULL CHECK (type IN ('confirm','missing_info','problem','partner_request')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','assigned','in_progress','waiting_customer','waiting_internal','scheduled','blocked','resolved','closed')),
  priority int NOT NULL DEFAULT 0,
  reason text NOT NULL,
  team text NOT NULL DEFAULT 'operators',
  assignee_id uuid REFERENCES users(id),
  lease_until timestamptz,
  due_at timestamptz,
  not_before timestamptz,           -- callback time: the task is not offered before this moment
  next_action text NOT NULL,
  blocked_by text,
  source text NOT NULL,             -- site | quick_order | partner_assisted | operator | system
  attempts int NOT NULL DEFAULT 0,
  resolution text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- Idempotent creation: at most one OPEN task of a type per order (T02).
CREATE UNIQUE INDEX ops_tasks_one_open ON ops_tasks (order_id, type) WHERE state NOT IN ('resolved','closed');
CREATE INDEX ops_tasks_queue ON ops_tasks (state, not_before, priority DESC, created_at) WHERE state NOT IN ('resolved','closed');
CREATE INDEX ops_tasks_assignee ON ops_tasks (assignee_id, state) WHERE state NOT IN ('resolved','closed');

CREATE TABLE ops_task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES ops_tasks(id),
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL,
  from_state text,
  to_state text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_task_events_task ON ops_task_events (task_id, id);

-- Richer, honest call results (a tel: tap is not "answered").
ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_outcome_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_outcome_check CHECK (outcome IN ('confirmed','no_answer','rejected','wrong_data','call_later','busy','wrong_number','callback_requested','info_given','problem'));
ALTER TABLE call_logs ADD COLUMN task_id uuid REFERENCES ops_tasks(id);
