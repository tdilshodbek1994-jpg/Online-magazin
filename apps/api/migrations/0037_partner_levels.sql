-- UZSHOP Partner Level & Loyalty PRO. Additive only. Levels count qualified units from the UzCoin ledger (delivered +
-- settled, minus returns); benefits change only the commission snapshot of NEW order lines; gift discount per level.
CREATE TABLE partner_level_defs (
  level int PRIMARY KEY CHECK (level BETWEEN 0 AND 99),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  threshold int NOT NULL CHECK (threshold >= 0),
  badge text NOT NULL DEFAULT '⭐' CHECK (char_length(badge) <= 8),
  color text NOT NULL DEFAULT '#0b7a55' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  gift_discount_bps int NOT NULL DEFAULT 0 CHECK (gift_discount_bps BETWEEN 0 AND 5000),
  perks text,
  UNIQUE (threshold)
);
INSERT INTO partner_level_defs (level, name, threshold, badge, color, gift_discount_bps, perks) VALUES
 (0,'Boshlovchi',0,'🌱','#6b7280',0,NULL),
 (1,'Do‘st',50,'🤝','#10b981',100,NULL),
 (2,'Qadrdon',100,'💚','#059669',200,NULL),
 (3,'Ishonchli hamkor',500,'🛡️','#0d9488',300,NULL),
 (4,'Faol hamkor',1000,'⚡','#0284c7',400,NULL),
 (5,'Tajribali hamkor',2000,'🎯','#2563eb',500,NULL),
 (6,'Professional',3000,'💼','#4f46e5',600,NULL),
 (7,'Usta sotuvchi',4000,'🛠️','#7c3aed',700,NULL),
 (8,'Oltin hamkor',5000,'🥇','#ca8a04',800,NULL),
 (9,'Platina hamkor',7500,'💿','#64748b',900,NULL),
 (10,'Elita hamkor',10000,'👑','#b45309',1000,'Bir martalik 50% komissiya kuponi'),
 (11,'Brilliant',15000,'💎','#0891b2',1100,NULL),
 (12,'VIP hamkor',20000,'🌟','#be185d',1200,NULL),
 (13,'Ambassador',30000,'🎖️','#9333ea',1300,NULL),
 (14,'Grandmaster',40000,'♟️','#1e293b',1400,NULL),
 (15,'Legenda',50000,'🔥','#dc2626',1500,NULL),
 (16,'Royal Partner',60000,'🏰','#7e22ce',1600,NULL),
 (17,'Crown Partner',75000,'👑','#a16207',1700,NULL),
 (18,'Ultimate Partner',90000,'🚀','#0f766e',1800,NULL),
 (19,'UzShop Legend',100000,'🏆','#b91c1c',2000,'50% komissiya VIP huquqi')
ON CONFLICT DO NOTHING;

CREATE TABLE partner_level_def_versions (
  id bigserial PRIMARY KEY,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_level_state (
  partner_id uuid PRIMARY KEY REFERENCES partners(id),
  units int NOT NULL DEFAULT 0,
  level int NOT NULL DEFAULT 0,
  vip_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_level_state_units ON partner_level_state (units DESC);

CREATE TABLE partner_level_history (
  id bigserial PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  from_level int NOT NULL,
  to_level int NOT NULL,
  units int NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_level_adjustments (
  id bigserial PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  units int NOT NULL CHECK (units <> 0),
  reason text NOT NULL CHECK (char_length(reason) >= 5),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE level_benefit_products (
  product_id uuid PRIMARY KEY REFERENCES products(id),
  enabled boolean NOT NULL DEFAULT true,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_commission_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL UNIQUE REFERENCES partners(id),   -- one one-time 50% coupon per partner, ever
  rate_bps int NOT NULL DEFAULT 5000,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','armed','reserved','used','void')),
  order_id uuid REFERENCES orders(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE level_promos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  min_level int NOT NULL DEFAULT 0,
  extra_discount_bps int NOT NULL CHECK (extra_discount_bps BETWEEN 1 AND 5000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id),
  CHECK (ends_at > starts_at)
);

ALTER TABLE uzcoin_gift_orders ADD COLUMN IF NOT EXISTS base_price_coins bigint;
ALTER TABLE uzcoin_gift_orders ADD COLUMN IF NOT EXISTS discount_bps int NOT NULL DEFAULT 0;
ALTER TABLE uzcoin_gift_orders ADD COLUMN IF NOT EXISTS level_snapshot int;
