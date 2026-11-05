-- M54/M55/M41/M02/M03/M56/M53 foundation. Times are timestamptz (UTC); money is BIGINT minor units.

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('platform_owner','merchant','supplier','b2b_customer')),
  name text NOT NULL,
  legal_name text,
  tin text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','needs_information','approved','probation','active','restricted','suspended','closing','closed')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_one_owner ON organizations ((kind)) WHERE kind = 'platform_owner';

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at timestamptz,
  display_name text,
  locale text NOT NULL DEFAULT 'uz-Latn' CHECK (locale IN ('uz-Latn','uz-Cyrl','ru')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','closed')),
  kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','service','ai')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A phone number belongs to at most one active account (AC-M02-2). Closed accounts release the number.
CREATE UNIQUE INDEX users_phone_active ON users (phone_e164) WHERE status <> 'closed' AND phone_e164 IS NOT NULL;

CREATE TABLE phone_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  old_phone text,
  new_phone text NOT NULL,
  method text NOT NULL CHECK (method IN ('otp_both','controlled_recovery','initial')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE,
  phone_at_issue text,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login','phone_change_old','phone_change_new','recovery')),
  code_hash bytea NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  ip inet,
  CHECK (attempts <= max_attempts)
);
CREATE INDEX otp_phone_created ON otp_challenges (phone_e164, created_at DESC);

CREATE TABLE roles (
  code text PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform','organization','self')),
  description text NOT NULL
);
CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false
);
CREATE TABLE role_permissions (
  role_code text NOT NULL REFERENCES roles(code),
  permission_code text NOT NULL REFERENCES permissions(code),
  max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor >= 0),
  PRIMARY KEY (role_code, permission_code)
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  role_code text NOT NULL REFERENCES roles(code),
  granted_by uuid REFERENCES users(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX memberships_active ON memberships (user_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), role_code) WHERE revoked_at IS NULL;

-- Immutable audit trail (M41, AC-M41-2): no UPDATE/DELETE, even for superadmin through the app.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','system','ai','anonymous')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  organization_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  request_id text,
  ip inet
);
CREATE INDEX audit_target ON audit_events (target_type, target_id);
CREATE INDEX audit_actor ON audit_events (actor_user_id, occurred_at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Idempotency (MASTER 8.5): key scoped by actor+operation; fingerprint conflict detection.
CREATE TABLE idempotency_records (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','completed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (scope, key)
);

-- Transactional outbox / inbox (M53, ADR-005).
CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version int,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  organization_id uuid,
  correlation_id text,
  causation_id text,
  payload jsonb NOT NULL,
  dispatched_at timestamptz
);
CREATE INDEX outbox_undispatched ON outbox_events (id) WHERE dispatched_at IS NULL;

CREATE TABLE inbox_receipts (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  queue text NOT NULL DEFAULT 'default',
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 10,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs (queue, run_at) WHERE status = 'pending';

-- Scheduler leadership lock (M55, AC-M55-2) uses pg advisory locks; job runs are recorded here.
CREATE TABLE scheduled_runs (
  task text NOT NULL,
  window_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (task, window_key)
);

-- Business configuration (M01): immutable versions with effective time.
CREATE TABLE business_config_versions (
  version int PRIMARY KEY,
  effective_from timestamptz NOT NULL,
  config jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER business_config_immutable BEFORE UPDATE OR DELETE ON business_config_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  description text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);

CREATE TABLE service_regions (
  code text PRIMARY KEY,
  name jsonb NOT NULL,
  country_code text NOT NULL DEFAULT 'UZ',
  active boolean NOT NULL DEFAULT true,
  restriction_reason jsonb
);

-- M03 addresses. Orders store a snapshot, so deleting a saved address never alters history (AC-M03-2).
CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  label text,
  recipient_name text NOT NULL,
  recipient_phone text NOT NULL,
  region_code text NOT NULL REFERENCES service_regions(code),
  district text NOT NULL,
  mahalla text,
  street text NOT NULL,
  house text NOT NULL,
  apartment text,
  floor int,
  landmark text,
  lat numeric(9,6),
  lng numeric(9,6),
  delivery_note text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','map')),
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user ON addresses (user_id) WHERE deleted_at IS NULL;

-- M56 legal document versions and acceptance evidence (AC-M56-1).
CREATE TABLE legal_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL CHECK (doc_type IN ('offer','privacy','returns','partner','merchant','reward_terms')),
  version int NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  effective_from timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, version, locale)
);
CREATE TRIGGER legal_docs_immutable BEFORE UPDATE OR DELETE ON legal_document_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  guest_ref text,
  legal_document_version_id uuid NOT NULL REFERENCES legal_document_versions(id),
  context text NOT NULL CHECK (context IN ('checkout','partner_signup','merchant_signup','account')),
  context_ref text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  CHECK (user_id IS NOT NULL OR guest_ref IS NOT NULL)
);

CREATE TABLE consents (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('marketing','personalization','analytics')),
  channel text NOT NULL CHECK (channel IN ('sms','email','push','telegram','in_app','any')),
  granted boolean NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_latest ON consents (user_id, purpose, channel, created_at DESC);
