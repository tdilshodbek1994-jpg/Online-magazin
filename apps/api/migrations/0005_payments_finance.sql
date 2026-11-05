-- M14 payments, M42 double-entry ledger, M15 fiscal queue, M16 refund core.

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  method text NOT NULL CHECK (method IN ('online','cod')),
  status text NOT NULL CHECK (status IN ('requires_payment','processing','succeeded','canceled','not_required')),
  captured_minor bigint NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  refund_reserved_minor bigint NOT NULL DEFAULT 0 CHECK (refund_reserved_minor >= 0),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- INV09: completed + pending refunds never exceed captured.
  CHECK (refunded_minor + refund_reserved_minor <= captured_minor)
);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES payment_intents(id),
  provider text NOT NULL CHECK (provider IN ('payme','click','mock','cod')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL CHECK (status IN ('created','pending','succeeded','failed','canceled','unknown_result')),
  provider_ref text,
  provider_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payment_attempts_intent ON payment_attempts (intent_id);

CREATE TABLE provider_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  event_key text NOT NULL,
  signature_valid boolean NOT NULL,
  payload jsonb NOT NULL,
  result text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

CREATE TABLE excess_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','refund_pending','refunded','resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES payment_intents(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  product_amount_minor bigint NOT NULL DEFAULT 0 CHECK (product_amount_minor >= 0),
  delivery_amount_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_amount_minor >= 0),
  status text NOT NULL CHECK (status IN ('reserved','submitted','succeeded','failed','unknown_result')),
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  provider_ref text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor = product_amount_minor + delivery_amount_minor)
);

CREATE TABLE refund_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  qty int NOT NULL CHECK (qty >= 0),
  product_amount_minor bigint NOT NULL CHECK (product_amount_minor >= 0),
  UNIQUE (refund_id, order_line_id)
);

-- M42 ledger: immutable, balanced per transaction & currency (INV07, INV08).
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  currency text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','revenue','expense','equity')),
  name text NOT NULL,
  owner_type text,
  owner_id uuid,
  UNIQUE (code, currency, owner_type, owner_id)
);
CREATE UNIQUE INDEX ledger_accounts_system ON ledger_accounts (code, currency) WHERE owner_id IS NULL;

CREATE TABLE journal_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_event_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  currency text NOT NULL,
  description text,
  reverses_id uuid REFERENCES journal_transactions(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES journal_transactions(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
CREATE INDEX journal_entries_account ON journal_entries (account_id);

CREATE TRIGGER journal_tx_immutable BEFORE UPDATE OR DELETE ON journal_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; n int; bad int;
BEGIN
  SELECT COALESCE(SUM(debit_minor),0), COALESCE(SUM(credit_minor),0), COUNT(*) INTO d, c, n
    FROM journal_entries WHERE transaction_id = NEW.transaction_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'JOURNAL_UNBALANCED tx=% debit=% credit=%', NEW.transaction_id, d, c USING ERRCODE = 'P0001';
  END IF;
  SELECT COUNT(*) INTO bad FROM journal_entries e JOIN ledger_accounts a ON a.id = e.account_id
    JOIN journal_transactions t ON t.id = e.transaction_id
   WHERE e.transaction_id = NEW.transaction_id AND a.currency <> t.currency;
  IF bad > 0 THEN RAISE EXCEPTION 'JOURNAL_CURRENCY_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced();

CREATE VIEW ledger_balances AS
SELECT a.id AS account_id, a.code, a.currency, a.owner_type, a.owner_id,
       COALESCE(SUM(e.debit_minor),0) AS debit_minor, COALESCE(SUM(e.credit_minor),0) AS credit_minor
FROM ledger_accounts a LEFT JOIN journal_entries e ON e.account_id = a.id
GROUP BY a.id;

-- M15 fiscal documents: one per (order, kind, refund); provider timeout never creates a second receipt.
CREATE TABLE fiscal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  refund_id uuid REFERENCES refunds(id),
  kind text NOT NULL CHECK (kind IN ('sale','refund')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','issued','rejected','unknown')),
  external_id text UNIQUE,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'refund') = (refund_id IS NOT NULL))
);
CREATE UNIQUE INDEX fiscal_one_sale ON fiscal_documents (order_id) WHERE kind = 'sale';
CREATE UNIQUE INDEX fiscal_one_per_refund ON fiscal_documents (refund_id) WHERE kind = 'refund';

-- M17 notifications (transactional first). Marketing kept separate by purpose.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  phone_e164 text,
  channel text NOT NULL CHECK (channel IN ('sms','in_app','telegram','email','push')),
  purpose text NOT NULL CHECK (purpose IN ('otp','transactional','marketing','security')),
  template text NOT NULL,
  locale text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','suppressed')),
  provider_ref text,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
