-- Landing & Target P2A: owner-approved safety rules (pause requests only), automation receipts, spending envelopes with
-- concurrent-safe reservations, pause/sync bookkeeping. Additive only; live spend remains behind ads.live_spend.
CREATE TABLE ad_safety_rules (
  kind text PRIMARY KEY CHECK (kind IN ('stock_out','landing_unpublished','price_changed')),
  enabled boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz
);
INSERT INTO ad_safety_rules (kind) VALUES ('stock_out'), ('landing_unpublished'), ('price_changed') ON CONFLICT DO NOTHING;

CREATE TABLE ad_automation_receipts (
  id bigserial PRIMARY KEY,
  draft_id uuid REFERENCES campaign_drafts(id),
  action text NOT NULL CHECK (action IN ('pause_requested','pause_failed','kill_switch','alert')),
  reason text NOT NULL,
  result text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_spend_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  note text,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE TABLE ad_envelope_reservations (
  draft_id uuid PRIMARY KEY REFERENCES campaign_drafts(id),
  envelope_id uuid NOT NULL REFERENCES ad_spend_envelopes(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

ALTER TABLE campaign_drafts ADD COLUMN IF NOT EXISTS synced_at timestamptz;
ALTER TABLE campaign_drafts ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE campaign_drafts ADD COLUMN IF NOT EXISTS safety_reason text;
