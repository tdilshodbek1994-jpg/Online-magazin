-- Phase 1: single owner + partner (affiliate) sales + operator CRM + single warehouse + COD.
-- Expands 0001–0005 without destroying them (docs/phase1/PHASE1_TASK.txt §13, §15–§20).

-- ---------- Roles & permissions (§04) ----------
INSERT INTO roles (code, scope_kind, description) VALUES
 ('owner','platform','Owner / Superadmin'),
 ('catalog_manager','platform','Catalog manager'),
 ('operator','platform','Operator / Support'),
 ('warehouse','platform','Warehouse / Delivery staff'),
 ('courier','platform','Courier (assigned shipments only)'),
 ('finance','platform','Finance'),
 ('partner','self','Partner (affiliate)'),
 ('customer','self','Customer');

INSERT INTO permissions (code, description, sensitive) VALUES
 ('catalog.write','Create/edit products, SKUs, media, prices',false),
 ('catalog.read_internal','See cost and internal notes',true),
 ('inventory.write','Receive/adjust stock',false),
 ('commission_rules.write','Manage commission rules',true),
 ('orders.read_all','Read all orders',false),
 ('orders.operate','Claim, confirm by call, edit orders',false),
 ('orders.reassign','Reassign operator ownership',false),
 ('fulfillment.operate','Pick, pack, ship, deliver',false),
 ('courier.self','Courier own tasks and remittance',false),
 ('cod.confirm','Confirm COD remittance received',true),
 ('payments.read','Read payments and reconciliation',true),
 ('refunds.request','Create refund request',false),
 ('refunds.approve','Approve/execute refunds',true),
 ('returns.operate','Open/handle return requests',false),
 ('returns.inspect','Receive and inspect returned goods',false),
 ('partners.manage','Approve/suspend partners, attribution corrections',true),
 ('payouts.prepare','Prepare payouts',true),
 ('payouts.approve','Approve/pay payouts',true),
 ('staff.manage','Invite staff, change roles',true),
 ('policies.manage','Approve business policies',true),
 ('audit.read','Read audit log',true),
 ('reports.read','Read owner reports and exports',true),
 ('support.operate','Handle support tickets',false),
 ('delivery_zones.write','Manage delivery zones and tariffs',false);

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'owner', code FROM permissions;
INSERT INTO role_permissions (role_code, permission_code) VALUES
 ('catalog_manager','catalog.write'), ('catalog_manager','inventory.write'),
 ('operator','orders.read_all'), ('operator','orders.operate'), ('operator','returns.operate'), ('operator','refunds.request'), ('operator','support.operate'),
 ('warehouse','orders.read_all'), ('warehouse','fulfillment.operate'), ('warehouse','inventory.write'), ('warehouse','returns.inspect'),
 ('courier','courier.self'),
 ('finance','payments.read'), ('finance','cod.confirm'), ('finance','refunds.request'), ('finance','refunds.approve'), ('finance','payouts.prepare'), ('finance','payouts.approve'), ('finance','reports.read'), ('finance','orders.read_all');

-- ---------- Business policies, versioned (Appendix B) ----------
CREATE TABLE business_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  version int NOT NULL,
  value jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','retired')),
  is_demo boolean NOT NULL DEFAULT true,
  owner_user_id uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  effective_at timestamptz NOT NULL DEFAULT now(),
  source_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version),
  CHECK (status <> 'approved' OR approved_at IS NOT NULL)
);

-- ---------- Orders: phase-1 status dimensions (§13) ----------
ALTER TABLE orders DROP CONSTRAINT orders_commercial_status_check;
ALTER TABLE orders DROP CONSTRAINT orders_payment_status_check;
ALTER TABLE orders DROP CONSTRAINT orders_fulfillment_status_check;
UPDATE orders SET commercial_status = 'confirmed' WHERE commercial_status IN ('awaiting_payment','in_fulfillment','on_hold');
UPDATE orders SET commercial_status = 'cancelled' WHERE commercial_status IN ('canceled','cancel_requested');
UPDATE orders SET fulfillment_status = 'unallocated' WHERE fulfillment_status = 'not_started';
ALTER TABLE orders ALTER COLUMN fulfillment_status SET DEFAULT 'unallocated';
ALTER TABLE orders ADD CONSTRAINT orders_commercial_status_check CHECK (commercial_status IN ('draft','awaiting_confirmation','confirmed','cancelled','completed'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('unpaid','pending','paid','partially_refunded','refunded','failed','reconciliation_required'));
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_status_check CHECK (fulfillment_status IN ('unallocated','reserved','picking','packed','shipped','delivered','failed','returned'));

ALTER TABLE orders
  ADD COLUMN confirmation_status text NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending','verified','rejected','expired')),
  ADD COLUMN channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','partner_assisted','operator')),
  ADD COLUMN created_by_user_id uuid REFERENCES users(id),
  ADD COLUMN customer_phone text,
  ADD COLUMN attributed_partner_id uuid,
  ADD COLUMN attribution jsonb,
  ADD COLUMN assigned_operator_id uuid REFERENCES users(id),
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN callback_at timestamptz,
  ADD COLUMN problem_reason text,
  ADD COLUMN cancel_reason text,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN terms_version text,
  ADD COLUMN duplicate_signal boolean NOT NULL DEFAULT false;
CREATE INDEX orders_queue ON orders (commercial_status, confirmation_status, fulfillment_status, created_at);
CREATE INDEX orders_partner ON orders (attributed_partner_id, created_at DESC);
CREATE INDEX orders_customer_phone ON orders (customer_phone);

-- Quotes for partner-assisted orders have no cart owner; cost snapshot is internal only.
ALTER TABLE checkout_quotes ALTER COLUMN cart_id DROP NOT NULL;
ALTER TABLE checkout_quotes ADD COLUMN created_by_user_id uuid REFERENCES users(id);
ALTER TABLE order_lines ADD COLUMN cost_snapshot_minor bigint, ADD COLUMN commission_rule_snapshot jsonb;
ALTER TABLE skus ADD COLUMN cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0);

-- Customer confirmation evidence (§12): OTP link or independent operator call. Partner checkbox is never evidence.
CREATE TABLE order_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  method text NOT NULL CHECK (method IN ('customer_otp','operator_call','checkout_verified_session')),
  status text NOT NULL CHECK (status IN ('pending','verified','rejected','expired')),
  token_hash bytea UNIQUE,
  code_hash bytea,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  expires_at timestamptz,
  consumed_at timestamptz,
  shown_total_minor bigint,
  shown_quote_hash text,
  actor_user_id uuid REFERENCES users(id),
  call_outcome text CHECK (call_outcome IN ('confirmed','no_answer','rejected','wrong_data','call_later')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts)
);
CREATE INDEX order_confirmations_order ON order_confirmations (order_id, created_at DESC);

CREATE TABLE call_logs (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('confirmed','no_answer','rejected','wrong_data','call_later')),
  note text,
  callback_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_notes (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Delivery (§16) ----------
CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code text NOT NULL REFERENCES service_regions(code),
  district text,
  name jsonb NOT NULL,
  tariff_minor bigint NOT NULL CHECK (tariff_minor >= 0),
  free_from_minor bigint CHECK (free_from_minor IS NULL OR free_from_minor > 0),
  eta_min_days int NOT NULL CHECK (eta_min_days >= 0),
  eta_max_days int NOT NULL,
  cod_allowed boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  CHECK (eta_max_days >= eta_min_days)
);
CREATE UNIQUE INDEX delivery_zones_unique ON delivery_zones (region_code, COALESCE(district, '')) WHERE active;

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id), -- phase 1: one shipment per order (§16)
  status text NOT NULL CHECK (status IN ('picking','packed','shipped','delivered','failed','returned')),
  courier_user_id uuid REFERENCES users(id),
  tracking_id text,
  handed_over_at timestamptz,
  delivered_at timestamptz,
  proof jsonb,
  failed_attempts int NOT NULL DEFAULT 0,
  last_failure_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- COD: collected from customer -> held by courier -> remitted to shop -> reconciled by finance (§16).
CREATE TABLE cod_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  courier_user_id uuid NOT NULL REFERENCES users(id),
  expected_minor bigint NOT NULL CHECK (expected_minor >= 0),
  collected_minor bigint NOT NULL CHECK (collected_minor >= 0),
  collected_at timestamptz NOT NULL DEFAULT now(),
  remittance_id uuid,
  status text NOT NULL DEFAULT 'with_courier' CHECK (status IN ('with_courier','remitted','reconciled','discrepancy'))
);

CREATE TABLE cod_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_user_id uuid NOT NULL REFERENCES users(id),
  declared_minor bigint NOT NULL CHECK (declared_minor >= 0),
  expected_minor bigint NOT NULL CHECK (expected_minor >= 0),
  received_minor bigint CHECK (received_minor IS NULL OR received_minor >= 0),
  status text NOT NULL CHECK (status IN ('submitted','reconciled','discrepancy')),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confirmed_by IS NULL OR confirmed_by <> courier_user_id)
);
ALTER TABLE cod_collections ADD CONSTRAINT cod_collections_remittance_fk FOREIGN KEY (remittance_id) REFERENCES cod_remittances(id);

CREATE TABLE finance_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('cod_discrepancy','extra_payment','late_payment_no_stock','refund_unknown','payout_unknown','payment_unknown')),
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  amount_minor bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by uuid REFERENCES users(id),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (kind, ref_type, ref_id),
  CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolution IS NOT NULL))
);

-- ---------- Returns (§18) ----------
CREATE TABLE return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  opened_by uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('requested','reviewing','approved','received','inspected','resolved','rejected')),
  reason text NOT NULL,
  desired_resolution text NOT NULL CHECK (desired_resolution IN ('refund','exchange','repair')),
  policy_version text,
  decision_note text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES return_requests(id),
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  qty int NOT NULL CHECK (qty > 0),
  received_qty int NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  sellable_qty int NOT NULL DEFAULT 0 CHECK (sellable_qty >= 0),
  damaged_qty int NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  CHECK (received_qty <= qty),
  CHECK (sellable_qty + damaged_qty <= received_qty),
  UNIQUE (return_id, order_line_id)
);
ALTER TABLE refunds ADD COLUMN return_id uuid REFERENCES return_requests(id), ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN method text NOT NULL DEFAULT 'provider' CHECK (method IN ('provider','manual_cash','manual_bank'));
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('requested','approved','reserved','submitted','succeeded','failed','unknown_result','rejected'));

-- ---------- Partners (§11, §12, §19, §20) ----------
CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{5,12}$'),
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','suspended','rejected')),
  agreement_acceptance_id uuid REFERENCES acceptances(id),
  channels text,
  status_reason text,
  payout_destination jsonb,
  payout_destination_verified_at timestamptz,
  payout_destination_verified_by uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD CONSTRAINT orders_partner_fk FOREIGN KEY (attributed_partner_id) REFERENCES partners(id);

CREATE TABLE partner_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  name text NOT NULL,
  utm_source text, utm_medium text, utm_campaign text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referral_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  campaign_id uuid REFERENCES partner_campaigns(id),
  product_id uuid REFERENCES products(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{8,16}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referral_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES referral_links(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  visitor_hash bytea NOT NULL,
  user_id uuid REFERENCES users(id),
  is_bot boolean NOT NULL DEFAULT false,
  eligible boolean NOT NULL,
  ineligible_reason text,
  touched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_touches_visitor ON referral_touches (visitor_hash, touched_at DESC) WHERE eligible;
CREATE INDEX referral_touches_user ON referral_touches (user_id, touched_at DESC) WHERE eligible;

-- Commission rules per product, versioned; one of percent/fixed (§19).
CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  version int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent','fixed_per_unit')),
  rate_bps int CHECK (rate_bps IS NULL OR (rate_bps > 0 AND rate_bps <= 10000)),
  fixed_minor bigint CHECK (fixed_minor IS NULL OR fixed_minor > 0),
  basis text NOT NULL DEFAULT 'goods_net_after_discount_tax_included' CHECK (basis IN ('goods_net_after_discount_tax_included')),
  currency text NOT NULL DEFAULT 'UZS',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version),
  CHECK ((kind = 'percent') = (rate_bps IS NOT NULL)),
  CHECK ((kind = 'fixed_per_unit') = (fixed_minor IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE TRIGGER commission_rules_immutable BEFORE UPDATE OF kind, rate_bps, fixed_minor, product_id, version, effective_from ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER commission_rules_no_delete BEFORE DELETE ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- One accrual per order line (INV11); target recalculated, deltas journaled.
CREATE TABLE commission_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  rule_snapshot jsonb NOT NULL,
  target_minor bigint NOT NULL CHECK (target_minor >= 0),
  state text NOT NULL CHECK (state IN ('estimated','pending','available','reversed','superseded')),
  pending_at timestamptz,
  available_after timestamptz,
  available_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'superseded' OR target_minor = 0)
);
-- One live accrual per order line (INV11); superseded rows remain as history after attribution correction.
CREATE UNIQUE INDEX commission_accruals_one_live ON commission_accruals (order_line_id) WHERE state <> 'superseded';

-- Immutable partner money journal: transfers between buckets; projections rebuildable (Appendix C).
CREATE TABLE partner_ledger (
  id bigserial PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  from_bucket text NOT NULL CHECK (from_bucket IN ('external','estimated','pending','available','reserved','paid','debt')),
  to_bucket text NOT NULL CHECK (to_bucket IN ('external','estimated','pending','available','reserved','paid','debt')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  effect_key text NOT NULL,
  reason text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_bucket <> to_bucket),
  UNIQUE (source_type, source_id, effect_key)
);
CREATE TRIGGER partner_ledger_immutable BEFORE UPDATE OR DELETE ON partner_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE partner_balances (
  partner_id uuid PRIMARY KEY REFERENCES partners(id),
  estimated_minor bigint NOT NULL DEFAULT 0 CHECK (estimated_minor >= 0),
  pending_minor bigint NOT NULL DEFAULT 0 CHECK (pending_minor >= 0),
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  debt_minor bigint NOT NULL DEFAULT 0 CHECK (debt_minor <= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'UZS',
  status text NOT NULL CHECK (status IN ('requested','approved','processing','processing_unknown','paid','rejected')),
  destination_snapshot jsonb NOT NULL,
  idempotency_key text NOT NULL,
  prepared_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approval_mode text CHECK (approval_mode IN ('two_person','owner_only')),
  paid_reference text,
  paid_evidence text,
  reject_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, idempotency_key),
  CHECK (approval_mode IS DISTINCT FROM 'two_person' OR prepared_by IS DISTINCT FROM approved_by)
);

CREATE TABLE partner_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  order_id uuid REFERENCES orders(id),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attribution_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  old_partner_id uuid REFERENCES partners(id),
  new_partner_id uuid REFERENCES partners(id),
  reason text NOT NULL,
  evidence text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Support (§23) ----------
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by uuid NOT NULL REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_customer','resolved','closed')),
  assignee_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_messages (
  id bigserial PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Staff invitations & step-up auth (§07) ----------
CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  role_code text NOT NULL REFERENCES roles(code),
  token_hash bytea NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role_code NOT IN ('customer','partner'))
);
ALTER TABLE sessions ADD COLUMN elevated_until timestamptz;
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('login','phone_change_old','phone_change_new','recovery','step_up'));

-- Telegram linking (§23): one-time, short-lived token.
CREATE TABLE telegram_link_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  chat_id bigint
);
CREATE TABLE telegram_links (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  chat_id bigint NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now()
);

-- Ledger accounts for phase 1 (M42 minimal).
INSERT INTO ledger_accounts (code, currency, type, name) VALUES
 ('customer_receivable','UZS','asset','Customer receivable (confirmed orders, unpaid)'),
 ('courier_cash','UZS','asset','COD cash held by couriers'),
 ('cash_bank','UZS','asset','Shop cash/bank'),
 ('psp_receivable','UZS','asset','Payment provider receivable'),
 ('sales_clearing','UZS','liability','Sales clearing (goods to deliver / delivered)'),
 ('refund_liability','UZS','liability','Refunds payable to customers'),
 ('partner_payable','UZS','liability','Partner commission payable (available)'),
 ('commission_expense','UZS','expense','Partner commission expense'),
 ('suspense','UZS','liability','Unmatched money (extra payments, discrepancies)');
