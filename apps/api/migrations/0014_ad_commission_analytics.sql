-- Ad spend, quantity-matrix commission and revenue analytics (UZSHOP_REKLAMA_KOMISSIYA_ANALITIKA spec).
-- Additive only: existing orders, accruals, ledger, payouts and links are untouched (spec §23).
-- Rollback: drop the new tables/columns below; no existing column is altered destructively.

-- ---------- §4–5 Quantity matrix commission (versioned rule kind, never applied retroactively) ----------
ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_kind_check;
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_kind_check CHECK (kind IN ('percent','fixed_per_unit','quantity_matrix'));
ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_check1;
ALTER TABLE commission_rules ADD COLUMN commission_group text;
-- {"1":[10000],"2":[10000,2500],"3":[10000,5000,2500]} — basis points of the base commission per unit position.
ALTER TABLE commission_rules ADD COLUMN quantity_matrix jsonb;
ALTER TABLE commission_rules ADD COLUMN rounding_policy text NOT NULL DEFAULT 'per_unit_half_up' CHECK (rounding_policy IN ('per_unit_half_up'));
ALTER TABLE commission_rules ADD COLUMN return_policy text NOT NULL DEFAULT 'recompute_retained_qty' CHECK (return_policy IN ('recompute_retained_qty'));
ALTER TABLE commission_rules ADD COLUMN note text;
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_fixed_check CHECK ((kind IN ('fixed_per_unit','quantity_matrix')) = (fixed_minor IS NOT NULL));
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_matrix_check CHECK ((kind = 'quantity_matrix') = (quantity_matrix IS NOT NULL));

-- Accrual knows its group; an unsupported quantity is parked for review instead of inventing a rate (§4, T06).
ALTER TABLE commission_accruals ADD COLUMN commission_group text;
ALTER TABLE commission_accruals ADD COLUMN group_qty int;
ALTER TABLE commission_accruals ADD COLUMN review_required boolean NOT NULL DEFAULT false;
ALTER TABLE commission_accruals ADD COLUMN review_reason text;

-- ---------- §9 Telegram / Instagram placements under one root link ----------
CREATE TABLE campaign_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  root_link_id uuid NOT NULL REFERENCES referral_links(id),
  channel text NOT NULL CHECK (channel IN ('telegram_channel','telegram_ads','instagram_target','organic','unknown')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{6,16}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_placements_link ON campaign_placements (root_link_id);
ALTER TABLE referral_touches ADD COLUMN placement_id uuid REFERENCES campaign_placements(id);
ALTER TABLE sales_drafts ADD COLUMN placement_id uuid REFERENCES campaign_placements(id);
ALTER TABLE sales_drafts ADD COLUMN root_link_id uuid REFERENCES referral_links(id);
ALTER TABLE referral_links ADD COLUMN archived_at timestamptz;

-- ---------- §10–12 Ad expenses, allocation, FX ----------
CREATE TABLE fx_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_date date NOT NULL,
  rate numeric(20,6) NOT NULL CHECK (rate > 0),       -- UZS per `nominal` units (CBU "Rate")
  nominal int NOT NULL DEFAULT 1 CHECK (nominal > 0),  -- CBU "Nominal"
  source text NOT NULL CHECK (source IN ('cbu','manual','bank_actual')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users(id),
  UNIQUE (currency, effective_date, source)
);

CREATE TABLE ad_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  channel text NOT NULL CHECK (channel IN ('telegram_channel','telegram_ads','instagram_target','meta_mixed','organic','other')),
  placement_name text CHECK (char_length(placement_name) <= 120),
  amount_original numeric(20,2) NOT NULL,
  currency text NOT NULL DEFAULT 'UZS' CHECK (currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(20,6),              -- frozen at entry; never recomputed with today's rate (§12)
  fx_nominal int,
  fx_date date,
  fx_source text CHECK (fx_source IN ('identity','cbu','manual','bank_actual')),
  amount_uzs_minor bigint,            -- NULL while FX_PENDING
  fx_status text NOT NULL DEFAULT 'ok' CHECK (fx_status IN ('ok','pending')),
  service_from date NOT NULL,
  service_to date NOT NULL,           -- inclusive
  paid_at date,
  payer text NOT NULL DEFAULT 'partner' CHECK (payer IN ('partner','shop')),
  kind text NOT NULL DEFAULT 'actual' CHECK (kind IN ('planned','actual','adjustment','zero_confirmed')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconcile','superseded','void')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','meta','legacy_p2')),
  external_key text,                  -- provider/CSV identity: one key = one spend row (versioned updates, §11)
  note text CHECK (char_length(note) <= 300),
  receipt_url text CHECK (char_length(receipt_url) <= 500),
  version int NOT NULL DEFAULT 1,
  reconciles_id uuid REFERENCES ad_expenses(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_to >= service_from),
  -- 0 is only valid as an explicit "no spend in this period" confirmation (unknown ≠ 0, T19).
  CHECK ((kind = 'zero_confirmed') = (amount_original = 0)),
  CHECK (kind <> 'actual' OR amount_original > 0),
  UNIQUE (partner_id, source, external_key)
);
CREATE INDEX ad_expenses_partner ON ad_expenses (partner_id, service_from);
-- Every edit is kept (old/new values + reason) — no silent overwrite (§10, §22).
CREATE TABLE ad_expense_versions (
  id bigserial PRIMARY KEY,
  expense_id uuid NOT NULL REFERENCES ad_expenses(id),
  version int NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, version)
);
CREATE TABLE expense_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES ad_expenses(id),
  root_link_id uuid REFERENCES referral_links(id),
  placement_id uuid REFERENCES campaign_placements(id),
  share_bps int CHECK (share_bps BETWEEN 1 AND 10000),
  amount_original numeric(20,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((share_bps IS NULL) <> (amount_original IS NULL)),
  CHECK (root_link_id IS NOT NULL OR placement_id IS NOT NULL)
);
CREATE INDEX expense_allocations_expense ON expense_allocations (expense_id);

-- ---------- §11 Provider sync bookkeeping (Meta Insights adapter, CSV) ----------
CREATE TABLE provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  provider text NOT NULL CHECK (provider IN ('meta')),
  account_id text NOT NULL,
  token_ciphertext text,              -- AES-GCM (server key); never returned by any API, log or export
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','error')),
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, provider, account_id)
);
CREATE TABLE provider_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES provider_connections(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  provider text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','ok','partial','error')),
  rows_seen int NOT NULL DEFAULT 0,
  rows_changed int NOT NULL DEFAULT 0,
  error text,
  provider_timezone text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- ---------- §14 Closed-month report snapshots (versioned; never silently replaced) ----------
CREATE TABLE monthly_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  month date NOT NULL,                -- first day of month (Asia/Tashkent)
  report_basis text NOT NULL CHECK (report_basis IN ('financial','cohort')),
  version int NOT NULL,
  data jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, month, report_basis, version)
);

-- ---------- Feature flags (independent: rule activation / analytics UI / external sync, §23) ----------
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('commission.quantity_matrix', false, 'Quantity-matrix commission rules take effect for new orders'),
  ('analytics.partner_v2', true, 'Partner ad/commission analytics UI'),
  ('ads.provider_sync', false, 'External ad provider sync (Meta Insights)')
ON CONFLICT (key) DO NOTHING;

-- P2 ad spend rows are carried over as partner-paid actual UZS expenses (originals kept in partner_ad_spend).
INSERT INTO ad_expenses (partner_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, service_from, service_to, paid_at, payer, kind, source, external_key, note, created_at)
SELECT partner_id, CASE WHEN channel ILIKE '%insta%' THEN 'instagram_target' WHEN channel ILIKE '%telegram%' THEN 'telegram_channel' ELSE 'other' END,
       channel, amount_minor / 100.0, 'UZS', 1, 1, spent_on, 'identity', amount_minor, spent_on, spent_on, spent_on, 'partner', 'actual', 'legacy_p2', id::text, note, created_at
  FROM partner_ad_spend;

-- Matrix rule content is immutable once created (a change = a new version).
CREATE TRIGGER commission_rules_matrix_immutable BEFORE UPDATE OF quantity_matrix, commission_group, rounding_policy, return_policy ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
