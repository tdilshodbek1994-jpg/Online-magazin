-- Final release: daily finance close. A close is a snapshot of the day's figures; a later correction creates a NEW
-- version (the earlier snapshot stays). Nothing here moves money or «fixes» a balance.
CREATE TABLE finance_day_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL,
  version int NOT NULL,
  snapshot jsonb NOT NULL,
  mismatches int NOT NULL DEFAULT 0,
  note text,
  closed_by uuid NOT NULL REFERENCES users(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, version)
);
