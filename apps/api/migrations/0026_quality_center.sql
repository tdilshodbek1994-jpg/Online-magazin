-- UZSHOP PRO — Quality Center (partner warnings, order authenticity). A low conversion is a SIGNAL, never an automatic
-- fault or money penalty. Money penalties need an active policy with legal approval AND the feature flag.

-- Who was at fault when a courier could not deliver (courier delay is never the partner's fault).
ALTER TABLE shipments ADD COLUMN failure_fault text CHECK (failure_fault IS NULL OR failure_fault IN ('customer','courier','warehouse','operator','other'));

-- Independent customer confirmation by a one-time link ("Men buyurtma bermaganman" included).
ALTER TABLE order_confirmations DROP CONSTRAINT IF EXISTS order_confirmations_method_check;
ALTER TABLE order_confirmations ADD CONSTRAINT order_confirmations_method_check CHECK (method IN ('customer_otp','operator_call','checkout_verified_session','customer_link'));
ALTER TABLE order_confirmations DROP CONSTRAINT IF EXISTS order_confirmations_status_check;
ALTER TABLE order_confirmations ADD CONSTRAINT order_confirmations_status_check CHECK (status IN ('pending','verified','rejected','expired','denied','disputed','unreachable'));

CREATE TABLE quality_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL UNIQUE,
  metric text NOT NULL CHECK (metric IN ('confirmation_rate','delivery_rate','customer_denial_rate','verified_invalid_rate')),
  threshold_pct numeric(5,2) NOT NULL CHECK (threshold_pct BETWEEN 0 AND 100),
  min_sample int NOT NULL DEFAULT 20 CHECK (min_sample >= 1),
  period_days int NOT NULL DEFAULT 30 CHECK (period_days BETWEEN 1 AND 365),
  effective_date timestamptz NOT NULL DEFAULT now(),
  contract_version text,
  monetary_enabled boolean NOT NULL DEFAULT false,
  monetary_cap_minor bigint,
  legal_approved_by uuid REFERENCES users(id), legal_approved_at timestamptz, legal_reference text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quality_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  status text NOT NULL DEFAULT 'detected' CHECK (status IN ('detected','triage','investigating','awaiting_partner_response','reviewed','resolved_no_fault','confirmed_violation','inconclusive','appealed','final')),
  reason_code text NOT NULL CHECK (reason_code IN ('low_metric','customer_denied','same_phone','wrong_address_repeat','unreachable_customers','many_returns','unusual_campaign','other')),
  fault text CHECK (fault IS NULL OR fault IN ('partner','operator','warehouse','courier','customer','none')),
  order_ids uuid[] NOT NULL DEFAULT '{}',
  policy_version int,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  partner_response text,
  decision text,
  reviewer_id uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  idem_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_cases_partner ON quality_cases (partner_id, created_at DESC);

CREATE TABLE quality_warnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  case_id uuid NOT NULL REFERENCES quality_cases(id) UNIQUE,     -- one warning per case (repeats are no-ops)
  level int NOT NULL CHECK (level >= 1),
  message text NOT NULL,
  acknowledged_at timestamptz,
  partner_response text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quality_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  case_id uuid NOT NULL REFERENCES quality_cases(id),
  kind text NOT NULL CHECK (kind IN ('extra_verification','assisted_orders_paused','contest_review')),
  reason text NOT NULL,
  ends_at timestamptz NOT NULL,
  lifted_at timestamptz, lifted_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, kind)
);

CREATE TABLE quality_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES quality_cases(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 5 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','overturned')),
  resolution text, resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, enabled, description) VALUES ('quality.monetary_penalties', false, 'Money penalties for partners — only after contract + legal approval')
  ON CONFLICT (key) DO NOTHING;
