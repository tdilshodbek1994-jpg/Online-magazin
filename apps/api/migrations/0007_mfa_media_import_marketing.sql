-- Phase 1 completion: MFA/step-up (T020), media (T030), CSV import rows (T029), marketing campaigns (T087), order amendments (T050).

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  secret_enc text NOT NULL,
  enabled_at timestamptz,
  recovery_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE media_assets ADD COLUMN original_name text, ADD COLUMN variants jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN uploaded_by uuid REFERENCES users(id);
ALTER TABLE media_assets DROP CONSTRAINT media_assets_mime_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_check CHECK (mime IN ('image/jpeg','image/png','image/webp'));
CREATE UNIQUE INDEX media_assets_product_sha ON media_assets (product_id, sha256);

ALTER TABLE import_batches DROP CONSTRAINT import_batches_status_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check CHECK (status IN ('preview','committed','failed','expired'));
ALTER TABLE import_batches ADD COLUMN rows jsonb, ADD COLUMN committed_at timestamptz, ADD COLUMN result jsonb;

CREATE TABLE marketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','telegram','in_app')),
  template text NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','canceled')),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  audience_size int,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE TABLE marketing_recipients (
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','suppressed')),
  suppress_reason text,
  PRIMARY KEY (campaign_id, user_id)
);

-- Content/total change after confirmation: new version requires customer re-confirmation (T050).
CREATE TABLE order_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  proposed_by uuid NOT NULL REFERENCES users(id),
  new_quote_id uuid NOT NULL REFERENCES checkout_quotes(id),
  old_payable_minor bigint NOT NULL,
  new_payable_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_customer' CHECK (status IN ('awaiting_customer','accepted','rejected','expired')),
  confirmation_id uuid REFERENCES order_confirmations(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX order_amendments_one_open ON order_amendments (order_id) WHERE status = 'awaiting_customer';

INSERT INTO permissions (code, description, sensitive) VALUES ('marketing.manage','Create/approve/send marketing campaigns',true);
INSERT INTO role_permissions (role_code, permission_code) VALUES ('owner','marketing.manage');
