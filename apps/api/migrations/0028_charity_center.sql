-- UZSHOP PRO — Charity Center. Built on the existing charity box (charity_donations / charity_handovers) and the
-- partner ledger: no second balance. Automatic share is OFF by default and only from the partner's own confirmed
-- commission (never shop revenue). Collected ≠ moved to fund ≠ handed to the recipient.

CREATE TABLE charity_funds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 160),
  recipient_org text,
  requisites text,
  purpose text,
  legal_basis text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','paused','closed')),
  created_by uuid REFERENCES users(id), approved_by uuid REFERENCES users(id), approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One rule per partner (versioned by updates + audit). Consent is explicit and recorded.
CREATE TABLE charity_rules (
  partner_id uuid PRIMARY KEY REFERENCES partners(id),
  fund_id uuid REFERENCES charity_funds(id),
  percent_bps int NOT NULL CHECK (percent_bps BETWEEN 1 AND 10000),
  monthly_cap_minor bigint CHECK (monthly_cap_minor IS NULL OR monthly_cap_minor > 0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','canceled')),
  consent_at timestamptz NOT NULL,
  consent_text_version text NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE charity_donations ADD COLUMN fund_id uuid REFERENCES charity_funds(id);
ALTER TABLE charity_donations ADD COLUMN source text NOT NULL DEFAULT 'one_time' CHECK (source IN ('one_time','auto'));
ALTER TABLE charity_donations ADD COLUMN status text NOT NULL DEFAULT 'transferred_to_fund' CHECK (status IN ('pending_eligibility','reserved','transferred_to_fund','reversed','failed','disputed'));
ALTER TABLE charity_donations ADD COLUMN commission_accrual_id uuid REFERENCES commission_accruals(id);
ALTER TABLE charity_donations ADD COLUMN commission_amount_minor bigint;
ALTER TABLE charity_donations ADD COLUMN percent_bps int;
ALTER TABLE charity_donations ADD COLUMN rule_version int;
ALTER TABLE charity_donations ADD COLUMN idem_key text;
CREATE UNIQUE INDEX charity_donations_auto_once ON charity_donations (commission_accrual_id) WHERE commission_accrual_id IS NOT NULL;
CREATE UNIQUE INDEX charity_donations_idem ON charity_donations (partner_id, idem_key) WHERE idem_key IS NOT NULL;

-- Disbursement to the recipient: pending until proof; big amounts need a second approver.
ALTER TABLE charity_handovers ADD COLUMN fund_id uuid REFERENCES charity_funds(id);
ALTER TABLE charity_handovers ADD COLUMN status text NOT NULL DEFAULT 'disbursed' CHECK (status IN ('disbursement_pending','disbursed','failed'));
ALTER TABLE charity_handovers ADD COLUMN proof text;
ALTER TABLE charity_handovers ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE charity_handovers ADD COLUMN second_approved_by uuid REFERENCES users(id);
ALTER TABLE charity_handovers ADD COLUMN disbursed_at timestamptz;
