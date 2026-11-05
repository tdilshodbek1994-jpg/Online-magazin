-- Final release PR-02: customer self-service.
-- 1) Phone change: both the current and the new phone confirm with a one-time code; challenges are bound to the user.
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);

-- 2) Minimal order-status link (opaque, expiring, revocable). Shows stages only: no address, phone or money.
CREATE TABLE order_status_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  token_hash bytea NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_links_order ON order_status_links (order_id);

-- 3) Data export / deletion requests: recorded and handled by an authorised person (legal retention applies to ledgers).
CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('export','delete')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_review','done','rejected')),
  note text,
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX data_requests_open ON data_requests (user_id, kind) WHERE status IN ('requested','in_review');
