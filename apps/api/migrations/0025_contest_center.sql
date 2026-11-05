-- UZSHOP PRO — Contest Center (Konkurs markazi). A new module next to the old simple `contests` (kept as is).
-- Ledger is the source of truth: scores come only from verified orders / commission accruals; aggregates are derived.
-- Money is integer tiyin (bigint), consistent with the rest of the schema. Instants are UTC; the local period zone is stored.

CREATE TABLE cc_contests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','scheduled','active','calculating','provisional','appeal_window','finalized','awarded','archived','paused','canceled','voided')),
  current_version int NOT NULL DEFAULT 1,
  version int NOT NULL DEFAULT 1,                       -- optimistic lock for admin edits
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id), approved_at timestamptz,
  published_at timestamptz,
  closed_at timestamptz, appeal_deadline timestamptz,
  finalized_by uuid REFERENCES users(id), finalized_at timestamptz,
  canceled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rules are versioned: a started contest is never edited silently — a new version with a reason is created.
CREATE TABLE cc_versions (
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  version int NOT NULL,
  title_latn text NOT NULL CHECK (char_length(title_latn) BETWEEN 3 AND 120),
  title_cyrl text,
  description text,
  banner_url text,
  timezone text NOT NULL DEFAULT 'Asia/Tashkent',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  metric text NOT NULL CHECK (metric IN ('settled_orders','settled_units','confirmed_commission','net_sales')),
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,      -- {product_ids?, category_ids?, partners_joined_after?}
  min_score bigint NOT NULL DEFAULT 1 CHECK (min_score >= 0),
  appeal_days int NOT NULL DEFAULT 3 CHECK (appeal_days BETWEEN 0 AND 30),
  tie_break text[] NOT NULL DEFAULT ARRAY['score','net_sales','refund_ratio','reached_at'],
  name_privacy text NOT NULL DEFAULT 'alias' CHECK (name_privacy IN ('alias','consent')),
  terms text,
  budget_minor bigint NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
  reason text,                                           -- why this revision exists (required from v2)
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contest_id, version),
  CHECK (ends_at > starts_at)
);

CREATE TABLE cc_enrollments (
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  terms_version int NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  display_consent boolean NOT NULL DEFAULT false,      -- show my real name on the leaderboard
  notify_opt_in boolean NOT NULL DEFAULT true,
  PRIMARY KEY (contest_id, partner_id)
);

-- Deterministic score journal: deltas only, never updated or deleted. Duplicate deliveries collapse on idem_key.
CREATE TABLE cc_score_events (
  id bigserial PRIMARY KEY,
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  order_id uuid REFERENCES orders(id),
  kind text NOT NULL CHECK (kind IN ('order','adjustment','correction')),
  prov_points bigint NOT NULL DEFAULT 0,
  final_points bigint NOT NULL DEFAULT 0,
  final_units int NOT NULL DEFAULT 0,
  final_net_sales_minor bigint NOT NULL DEFAULT 0,
  final_commission_minor bigint NOT NULL DEFAULT 0,
  refunded_units int NOT NULL DEFAULT 0,
  contest_version int NOT NULL,
  idem_key text NOT NULL UNIQUE,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,           -- which order lines / accrual ids produced this
  reason text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cc_score_events_contest ON cc_score_events (contest_id, partner_id);
CREATE INDEX cc_score_events_order ON cc_score_events (contest_id, order_id);

-- Frozen rankings. Exactly one final snapshot per contest (two workers cannot both finalize).
CREATE TABLE cc_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  kind text NOT NULL CHECK (kind IN ('provisional','final')),
  contest_version int NOT NULL,
  rows jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  computed_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX cc_rankings_one_final ON cc_rankings (contest_id) WHERE kind = 'final';

CREATE TABLE cc_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 5 AND 2000),
  order_id uuid REFERENCES orders(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  resolution text,
  resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cc_prizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  place int CHECK (place IS NULL OR place >= 1),        -- NULL = nomination
  nomination text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  kind text NOT NULL CHECK (kind IN ('money','item')),
  value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  qty int NOT NULL DEFAULT 1 CHECK (qty >= 1),
  awarded int NOT NULL DEFAULT 0 CHECK (awarded >= 0),
  claim_days int NOT NULL DEFAULT 14 CHECK (claim_days BETWEEN 1 AND 365),
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (awarded <= qty)
);

CREATE TABLE cc_prize_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_id uuid NOT NULL REFERENCES cc_prizes(id),
  contest_id uuid NOT NULL REFERENCES cc_contests(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  rank int,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('reserved','assigned','claimed','shipped','delivered','expired','paid')),
  claim_deadline timestamptz NOT NULL,
  proof text,
  bonus_award_id uuid,
  awarded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prize_id, partner_id)
);

-- Money prizes go through the existing bonus → wallet ledger, once per award.
ALTER TABLE bonus_awards DROP CONSTRAINT IF EXISTS bonus_awards_source_check;
ALTER TABLE bonus_awards ADD CONSTRAINT bonus_awards_source_check CHECK (source IN ('rule','manual','contest','cc_prize'));
ALTER TABLE bonus_awards ADD COLUMN cc_award_id uuid REFERENCES cc_prize_awards(id);
CREATE UNIQUE INDEX bonus_awards_cc_once ON bonus_awards (cc_award_id) WHERE cc_award_id IS NOT NULL;
