-- Partner sales drafts (UZSHOP_HAMKOR_KABINETI_V2 §05–07): server-side autosaved order drafts, customer self-fill links.
-- A draft is NOT an order: no stock, no commission. Converting creates exactly one partner-assisted order (unique order_id).
CREATE TABLE sales_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_customer','converted','cancelled','expired')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','message','customer_link')),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 120),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 32),
  delivery_zone_id uuid REFERENCES delivery_zones(id),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  address_later boolean NOT NULL DEFAULT false,
  contact_time text CHECK (contact_time IS NULL OR char_length(contact_time) <= 120),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  raw_message text CHECK (raw_message IS NULL OR char_length(raw_message) <= 2000),
  fill_token_hash bytea UNIQUE,
  fill_expires_at timestamptz,
  fill_status text NOT NULL DEFAULT 'none' CHECK (fill_status IN ('none','shared','filled','expired','revoked')),
  order_id uuid UNIQUE REFERENCES orders(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_drafts_partner ON sales_drafts (partner_id, updated_at DESC);
-- Customer-chosen contact time travels with the order to the operator card (§10, T19).
ALTER TABLE orders ADD COLUMN contact_time_note text CHECK (contact_time_note IS NULL OR char_length(contact_time_note) <= 120);
