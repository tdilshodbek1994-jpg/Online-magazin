-- M12 pricing/promotions, M11 cart & quote, M13 orders (MASTER 8.2 CHECKOUT/ORDERS, 9.2).

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  name jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cart_percent','cart_fixed','free_delivery')),
  value_bps int CHECK (value_bps IS NULL OR (value_bps > 0 AND value_bps <= 10000)),
  value_minor bigint CHECK (value_minor IS NULL OR value_minor > 0),
  min_subtotal_minor bigint NOT NULL DEFAULT 0,
  funding_owner text NOT NULL CHECK (funding_owner IN ('platform','merchant','brand')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  budget_minor bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  budget_reserved_minor bigint NOT NULL DEFAULT 0,
  max_redemptions int CHECK (max_redemptions IS NULL OR max_redemptions >= 0),
  redemptions_reserved int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','ended')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'cart_percent' OR value_bps IS NOT NULL),
  CHECK (kind <> 'cart_fixed' OR value_minor IS NOT NULL),
  -- Concurrency-safe caps (AC-M12-1, AC-X10): the DB refuses to exceed them.
  CHECK (budget_minor IS NULL OR budget_reserved_minor <= budget_minor),
  CHECK (max_redemptions IS NULL OR redemptions_reserved <= max_redemptions)
);

CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  guest_token_hash bytea UNIQUE,
  currency text NOT NULL DEFAULT 'UZS',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','converted','abandoned')),
  coupon_code text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR guest_token_hash IS NOT NULL)
);
CREATE UNIQUE INDEX carts_one_active_per_user ON carts (user_id) WHERE status = 'active' AND user_id IS NOT NULL;

CREATE TABLE cart_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id),
  offer_id uuid NOT NULL REFERENCES offers(id),
  qty int NOT NULL CHECK (qty > 0 AND qty <= 999),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, offer_id)
);

CREATE TABLE checkout_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id),
  user_id uuid REFERENCES users(id),
  currency text NOT NULL,
  address_snapshot jsonb NOT NULL,
  contact_snapshot jsonb NOT NULL,
  delivery_method text NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  line_discount_minor bigint NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
  cart_discount_minor bigint NOT NULL DEFAULT 0 CHECK (cart_discount_minor >= 0),
  delivery_minor bigint NOT NULL CHECK (delivery_minor >= 0),
  delivery_discount_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_discount_minor >= 0),
  payable_minor bigint NOT NULL CHECK (payable_minor >= 0),
  promotion_id uuid REFERENCES promotions(id),
  attribution jsonb,
  config_version int NOT NULL,
  quote_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','confirmed','expired','superseded')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- INV05: lines + fees = payable, to the minor unit.
  CHECK (payable_minor = subtotal_minor - line_discount_minor - cart_discount_minor + delivery_minor - delivery_discount_minor)
);

CREATE TABLE quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES checkout_quotes(id),
  offer_id uuid NOT NULL REFERENCES offers(id),
  offer_version int NOT NULL,
  sku_id uuid NOT NULL REFERENCES skus(id),
  merchant_org_id uuid NOT NULL REFERENCES organizations(id),
  qty int NOT NULL CHECK (qty > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  line_gross_minor bigint NOT NULL,
  line_discount_minor bigint NOT NULL DEFAULT 0,
  allocated_cart_discount_minor bigint NOT NULL DEFAULT 0,
  line_net_minor bigint NOT NULL CHECK (line_net_minor >= 0),
  tax_policy text NOT NULL,
  product_snapshot jsonb NOT NULL,
  CHECK (line_gross_minor = unit_price_minor * qty),
  CHECK (line_net_minor = line_gross_minor - line_discount_minor - allocated_cart_discount_minor)
);

CREATE SEQUENCE order_number_seq START 100001;

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT ('OM-' || nextval('order_number_seq')),
  user_id uuid REFERENCES users(id),
  guest_ref text,
  quote_id uuid NOT NULL UNIQUE REFERENCES checkout_quotes(id),
  currency text NOT NULL,
  -- Separate status dimensions (M13): never one overloaded status.
  commercial_status text NOT NULL CHECK (commercial_status IN ('awaiting_payment','confirmed','in_fulfillment','completed','cancel_requested','canceled','on_hold')),
  payment_status text NOT NULL CHECK (payment_status IN ('unpaid','pending','paid','partially_refunded','refunded','unknown')),
  fulfillment_status text NOT NULL DEFAULT 'not_started' CHECK (fulfillment_status IN ('not_started','allocated','partially_shipped','shipped','partially_delivered','delivered','returned_to_sender')),
  refund_status text NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','partial','full','pending')),
  payment_method text NOT NULL CHECK (payment_method IN ('online','cod')),
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  delivery_minor bigint NOT NULL,
  payable_minor bigint NOT NULL CHECK (payable_minor >= 0),
  address_snapshot jsonb NOT NULL,
  contact_snapshot jsonb NOT NULL,
  config_version int NOT NULL,
  legal_acceptance_id uuid REFERENCES acceptances(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR guest_ref IS NOT NULL)
);
CREATE INDEX orders_user ON orders (user_id, created_at DESC);

CREATE TABLE merchant_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  merchant_org_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','canceled','fulfilled','partially_fulfilled')),
  subtotal_net_minor bigint NOT NULL,
  version int NOT NULL DEFAULT 1,
  UNIQUE (order_id, merchant_org_id)
);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  merchant_order_id uuid NOT NULL REFERENCES merchant_orders(id),
  offer_id uuid NOT NULL REFERENCES offers(id),
  sku_id uuid NOT NULL REFERENCES skus(id),
  merchant_org_id uuid NOT NULL REFERENCES organizations(id),
  qty int NOT NULL CHECK (qty > 0),
  canceled_qty int NOT NULL DEFAULT 0 CHECK (canceled_qty >= 0),
  shipped_qty int NOT NULL DEFAULT 0 CHECK (shipped_qty >= 0),
  delivered_qty int NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
  returned_qty int NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  unit_price_minor bigint NOT NULL,
  line_gross_minor bigint NOT NULL,
  line_discount_minor bigint NOT NULL,
  allocated_cart_discount_minor bigint NOT NULL,
  line_net_minor bigint NOT NULL CHECK (line_net_minor >= 0),
  refunded_product_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_product_minor >= 0),
  tax_policy text NOT NULL,
  product_snapshot jsonb NOT NULL,
  offer_snapshot jsonb NOT NULL,
  attribution_snapshot jsonb,
  -- INV04: quantities never contradict each other.
  CHECK (canceled_qty + shipped_qty <= qty),
  CHECK (delivered_qty <= shipped_qty),
  CHECK (returned_qty <= delivered_qty),
  CHECK (refunded_product_minor <= line_net_minor)
);
CREATE INDEX order_lines_order ON order_lines (order_id);

ALTER TABLE reservations ADD CONSTRAINT reservations_order_fk FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE reservation_lines ADD CONSTRAINT reservation_lines_ol_fk FOREIGN KEY (order_line_id) REFERENCES order_lines(id);
CREATE UNIQUE INDEX reservations_one_live_per_order ON reservations (order_id) WHERE status IN ('active_unpaid','allocated_for_fulfillment');

CREATE TABLE promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL CHECK (status IN ('reserved','committed','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, order_id)
);

CREATE TABLE order_status_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  dimension text NOT NULL CHECK (dimension IN ('commercial','payment','fulfillment','refund')),
  from_status text,
  to_status text NOT NULL,
  actor_kind text NOT NULL,
  actor_user_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_events_order ON order_status_events (order_id, id);
