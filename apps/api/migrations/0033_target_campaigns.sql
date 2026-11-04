-- Landing & Target P1B: owner Meta connection (OAuth state binding, encrypted token, separated scopes, verified assets),
-- campaign drafts (AI/template drafts only), preflight, owner approval bound to a digest with TTL, idempotent
-- provisioning operations that create remote objects PAUSED, remote object map with configured vs effective status.
-- live spend is OFF by default (feature flag). Additive only.

CREATE TABLE meta_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','revoked','expired','error')),
  state_hash text,                                  -- sha256(OAuth state); single use
  state_session_id uuid,                            -- the admin session that started the flow
  state_expires_at timestamptz,
  token_ciphertext text,                            -- AES-GCM; never returned by any API/log/export
  token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  business_id text,
  ad_account_id text,
  account_currency text,
  account_timezone text,
  page_id text,
  instagram_id text,
  dataset_id text,
  verified_assets jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"ad_account":"act_1","page":"2","dataset":"3"} only what the provider confirmed
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_id uuid NOT NULL REFERENCES landing_pages(id),
  landing_revision int NOT NULL,
  flow_id uuid REFERENCES referral_links(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  objective text NOT NULL DEFAULT 'OUTCOME_SALES' CHECK (objective IN ('OUTCOME_SALES','OUTCOME_TRAFFIC','OUTCOME_LEADS')),
  ad_account_id text,
  page_id text,
  dataset_id text,
  payer_label text,                                 -- who pays (shown to the owner in the approval task)
  currency text NOT NULL DEFAULT 'UZS' CHECK (currency ~ '^[A-Z]{3}$'),
  budget_type text NOT NULL DEFAULT 'daily' CHECK (budget_type IN ('daily','lifetime')),
  budget_minor bigint NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
  start_at timestamptz,
  end_at timestamptz,
  audience jsonb NOT NULL DEFAULT '{"geo":["UZ"],"age_min":18,"age_max":65}'::jsonb,
  placements jsonb NOT NULL DEFAULT '["facebook","instagram"]'::jsonb,
  creative jsonb NOT NULL DEFAULT '{}'::jsonb,
  creative_revision int NOT NULL DEFAULT 1,
  policy_version text NOT NULL DEFAULT 'target-2026-11-v1',
  generator text NOT NULL DEFAULT 'manual' CHECK (generator IN ('manual','template','ai')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preflight_failed','review','owner_approved','provisioning','provisioned_paused','activation_requested',
    'delivery_pending','delivering','pause_requested','paused','rejected','blocked','completed','unknown')),
  blocked_reason text,
  preflight jsonb,
  configured_status text,                           -- what we asked the provider for (PAUSED/ACTIVE)
  effective_status text,                            -- what the provider reports (e.g. PENDING_REVIEW, ACTIVE, DISAPPROVED)
  review_feedback text,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES campaign_drafts(id),
  digest text NOT NULL,
  scope jsonb NOT NULL,                             -- the exact approved snapshot
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX campaign_approvals_draft ON campaign_approvals (draft_id, approved_at DESC);

CREATE TABLE provisioning_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES campaign_drafts(id),
  kind text NOT NULL CHECK (kind IN ('provision','activate','pause')),
  digest text NOT NULL,
  client_ref text NOT NULL UNIQUE,                  -- sent to the provider so an unknown outcome can be reconciled
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','succeeded','unknown','failed','blocked')),
  attempts int NOT NULL DEFAULT 0,
  error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, kind, digest)                   -- double click / queue retry = the same operation
);

CREATE TABLE remote_objects (
  id bigserial PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES campaign_drafts(id),
  level text NOT NULL CHECK (level IN ('campaign','adset','creative','ad')),
  remote_id text NOT NULL,
  configured_status text,
  effective_status text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, level)
);

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('ads.live_spend', false, 'Allow activating owner-approved PAUSED Meta campaigns (real money). Off until a separate owner-approved amount/asset/time scope.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO business_policies (key, version, value, status, is_demo, source_note) VALUES
  ('target.approval_ttl_hours', 1, '{"hours": 24}', 'draft', true, 'DEMO default — owner approval of a campaign scope expires after this many hours')
ON CONFLICT DO NOTHING;
