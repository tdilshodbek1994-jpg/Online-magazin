-- Partner cabinet 2.0 — P2 (V2 spec §08, §09, §14, §17): offer sets, short partner holds, waitlist,
-- partner contact notebook, partner-entered ad spend. Additive only: existing orders, links and balances are untouched (T36).

-- §08 Offer set: 2–3 catalog products in one choice link. Prices/texts always come from the catalog;
-- the partner adds only a short note. A product the customer did not choose never becomes an order.
CREATE TABLE partner_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  token_hash bytea NOT NULL UNIQUE,
  product_ids uuid[] NOT NULL CHECK (cardinality(product_ids) BETWEEN 2 AND 3),
  note text CHECK (char_length(note) <= 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','thinking','chosen','closed','expired')),
  seen_at timestamptz,                -- set by an explicit client call, never by a GET (link previews are not customers)
  chosen_sku_id uuid REFERENCES skus(id),
  draft_id uuid REFERENCES sales_drafts(id),
  order_id uuid UNIQUE REFERENCES orders(id),
  remind_phone text,                  -- only when the customer asked to be reminded (consent)
  remind_consent_at timestamptz,
  remind_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_offers_partner ON partner_offers (partner_id, created_at DESC);

-- §09 Short hold for a ready customer: a real server-side reservation with expiry (reservations.sales_draft_id).
ALTER TABLE reservations ADD COLUMN sales_draft_id uuid REFERENCES sales_drafts(id);
ALTER TABLE reservations ADD COLUMN partner_id uuid REFERENCES partners(id);
CREATE UNIQUE INDEX reservations_one_live_per_draft ON reservations (sales_draft_id) WHERE sales_draft_id IS NOT NULL AND status = 'active_unpaid';
CREATE INDEX reservations_partner_live ON reservations (partner_id) WHERE partner_id IS NOT NULL AND status = 'active_unpaid';

-- §09 Waitlist for sold-out products (consent stored; one entry per phone+product; notified once).
CREATE TABLE stock_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  sku_id uuid REFERENCES skus(id),
  phone text NOT NULL,
  consent_at timestamptz NOT NULL,
  partner_id uuid REFERENCES partners(id),   -- the referral that brought the customer (for the partner's count only)
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, phone)
);
CREATE INDEX stock_waitlist_waiting ON stock_waitlist (product_id) WHERE status = 'waiting';

-- §14 Partner contact notebook: only contacts the partner entered themselves (drafts / own orders).
-- It never makes a customer the partner's property: every new sale follows the current attribution policy.
CREATE TABLE partner_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  phone text NOT NULL,
  name text CHECK (char_length(name) <= 120),
  contact_time text CHECK (char_length(contact_time) <= 120),
  note text CHECK (char_length(note) <= 500),
  do_not_contact boolean NOT NULL DEFAULT false,
  entered_by_partner boolean NOT NULL DEFAULT true,  -- false: the customer typed it into the partner's link → partner sees it masked
  last_order_id uuid REFERENCES orders(id),
  last_draft_id uuid REFERENCES sales_drafts(id),
  interested jsonb NOT NULL DEFAULT '[]',     -- product ids the contact asked about
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, phone)
);

-- §17 Ad spend entered by the partner (labelled as partner-entered; never mixed with ledger money).
CREATE TABLE partner_ad_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  spent_on date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  channel text CHECK (char_length(channel) <= 60),
  note text CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_ad_spend_partner ON partner_ad_spend (partner_id, spent_on DESC);

-- DEMO-only policy fixtures (honoured outside production only; the owner approves real values in the admin panel).
INSERT INTO business_policies (key, version, value, status, is_demo, source_note) VALUES
  ('partner_hold.minutes', 1, '{"minutes": 15}', 'draft', true, 'DEMO fixture from V2 spec §09 ("demo: e.g. 15 minutes") — not an approved business value'),
  ('partner_hold.max_active', 1, '{"count": 3}', 'draft', true, 'DEMO fixture — not an approved business value'),
  ('partner_offer.ttl_hours', 1, '{"hours": 72}', 'draft', true, 'DEMO fixture — not an approved business value')
ON CONFLICT DO NOTHING;
