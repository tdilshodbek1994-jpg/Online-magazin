-- UZSHOP PRO — UzCoin rewards. A reward unit (not crypto, not tradable): 1 eligible sold unit = 1 UzCoin.
-- Separate immutable coin ledger + derived balances (does not touch the money wallet); exchange to money goes
-- through the existing wallet → payout flow at a versioned rate snapshot. Gift shop is separate from the catalog.

CREATE TABLE uzcoin_rates (
  version int PRIMARY KEY,
  som_per_coin_minor bigint NOT NULL CHECK (som_per_coin_minor > 0),   -- 3 000 so'm = 300 000 tiyin
  effective_from timestamptz NOT NULL DEFAULT now(),
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO uzcoin_rates (version, som_per_coin_minor, reason) VALUES (1, 300000, 'boshlang‘ich kurs: 1 UzCoin = 3 000 so‘m');

CREATE TABLE uzcoin_balances (
  partner_id uuid PRIMARY KEY REFERENCES partners(id),
  available bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  earned_total bigint NOT NULL DEFAULT 0,
  exchanged_total bigint NOT NULL DEFAULT 0,
  spent_total bigint NOT NULL DEFAULT 0,
  adjusted_total bigint NOT NULL DEFAULT 0,       -- coins taken back because of returns (positive number)
  debt bigint NOT NULL DEFAULT 0 CHECK (debt >= 0),  -- adjustment that could not be taken yet (shown openly)
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE uzcoin_ledger (
  id bigserial PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  kind text NOT NULL CHECK (kind IN ('earned_sale','return_adjustment','contest_prize','exchange_reserve','exchange_release','exchange_paid','gift_reserve','gift_release','gift_spent','correction')),
  coins bigint NOT NULL,                           -- signed effect on available (reserve/release move between available and reserved)
  source_type text NOT NULL, source_id text NOT NULL, effect_key text NOT NULL,
  order_id uuid REFERENCES orders(id), order_line_id uuid REFERENCES order_lines(id),
  product_name text, qty int,
  reason text,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, effect_key)
);
CREATE INDEX uzcoin_ledger_partner ON uzcoin_ledger (partner_id, id DESC);
CREATE TRIGGER uzcoin_ledger_immutable BEFORE UPDATE OR DELETE ON uzcoin_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE uzcoin_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  coins bigint NOT NULL CHECK (coins > 0),
  rate_version int NOT NULL REFERENCES uzcoin_rates(version),
  som_per_coin_minor bigint NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','canceled')),
  idem_key text NOT NULL,
  decided_by uuid REFERENCES users(id), decided_at timestamptz, reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, idem_key)
);

CREATE TABLE uzcoin_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  description text, category text, brand text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb, videos jsonb NOT NULL DEFAULT '[]'::jsonb,
  variant text, kit text, delivery_terms text, conditions text,
  price_coins bigint NOT NULL CHECK (price_coins > 0),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),   -- real purchase cost (finance report)
  stock int NOT NULL DEFAULT 0 CHECK (stock >= 0),
  per_partner_limit int CHECK (per_partner_limit IS NULL OR per_partner_limit >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE uzcoin_gift_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_id uuid NOT NULL REFERENCES uzcoin_gifts(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  price_coins bigint NOT NULL,                     -- snapshot: later price changes never touch this order
  gift_title text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','confirmed','preparing','shipped','delivered','canceled')),
  address text, idem_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, idem_key)
);

-- Contest prizes can be UzCoin (separate ledger source, once per award).
ALTER TABLE cc_prizes DROP CONSTRAINT IF EXISTS cc_prizes_kind_check;
ALTER TABLE cc_prizes ADD CONSTRAINT cc_prizes_kind_check CHECK (kind IN ('money','item','uzcoin'));

INSERT INTO ledger_accounts (code, currency, type, name) VALUES ('reward_expense','UZS','expense','UzCoin rewards exchanged to money') ON CONFLICT DO NOTHING;
