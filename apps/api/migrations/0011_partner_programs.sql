-- Partner programs: contests, bonus rules/awards, penalties, charity box. All amounts are owner-defined; money moves
-- only through partner_ledger transfers + balanced journal entries (no silent balance edits).
INSERT INTO ledger_accounts (code, currency, type, name) VALUES
 ('bonus_expense','UZS','expense','Partner bonuses and contest prizes'),
 ('penalty_income','UZS','revenue','Partner penalties'),
 ('charity_fund','UZS','liability','Charity box (donated by partners, to be handed over)');

CREATE TABLE contests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  metric text NOT NULL CHECK (metric IN ('delivered_orders','delivered_sales')),
  min_delivered int NOT NULL DEFAULT 1 CHECK (min_delivered >= 0),
  prizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','cancelled')),
  results jsonb,
  prizes_paid_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (ends_at > starts_at)
);

CREATE TABLE bonus_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  period text NOT NULL CHECK (period IN ('week','month')),
  threshold_delivered int NOT NULL CHECK (threshold_delivered > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bonus_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  source text NOT NULL CHECK (source IN ('rule','manual','contest')),
  rule_id uuid REFERENCES bonus_rules(id),
  contest_id uuid REFERENCES contests(id),
  period_key text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bonus_awards_rule_once ON bonus_awards (rule_id, partner_id, period_key) WHERE source = 'rule';
CREATE UNIQUE INDEX bonus_awards_contest_once ON bonus_awards (contest_id, partner_id) WHERE source = 'contest';
CREATE INDEX bonus_awards_partner ON bonus_awards (partner_id, created_at DESC);

CREATE TABLE penalty_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  description text,
  default_amount_minor bigint CHECK (default_amount_minor IS NULL OR default_amount_minor > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE penalties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  reason_id uuid REFERENCES penalty_reasons(id),
  reason_text text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  from_available_minor bigint NOT NULL DEFAULT 0,
  to_debt_minor bigint NOT NULL DEFAULT 0,
  order_id uuid REFERENCES orders(id),
  note text,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','cancelled')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_reason text
);
CREATE INDEX penalties_partner ON penalties (partner_id, created_at DESC);

CREATE TABLE charity_donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE charity_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  recipient text NOT NULL,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
