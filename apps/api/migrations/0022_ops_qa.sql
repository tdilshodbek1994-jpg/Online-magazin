-- Operator Centre 3.0 — P2: QA sampling (spec §25). A person reviews a random sample of finished tasks; the operator
-- sees the review and can object. Nobody reviews their own work. Reviews never trigger automatic penalties.
CREATE TABLE ops_qa_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES ops_tasks(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  checks jsonb NOT NULL,             -- {correct_outcome, data_complete, clear_communication}: booleans
  score int NOT NULL CHECK (score BETWEEN 1 AND 5),
  note text,
  operator_reply text,
  status text NOT NULL DEFAULT 'reviewed' CHECK (status IN ('reviewed','disputed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  replied_at timestamptz,
  CHECK (operator_id <> reviewer_id)
);
CREATE INDEX ops_qa_reviews_operator ON ops_qa_reviews (operator_id, created_at DESC);
