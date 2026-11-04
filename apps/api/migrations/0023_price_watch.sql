-- "Narxi tushsa xabar bering": explicit opt-in per product and phone; one SMS when the lowest active price drops below
-- the price the customer saw. Never marketing: one notice, then the watch closes.
CREATE TABLE price_watch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  phone text NOT NULL,
  price_minor_at bigint NOT NULL CHECK (price_minor_at > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  notified_price_minor bigint,
  UNIQUE (product_id, phone)
);
CREATE INDEX price_watch_waiting ON price_watch (product_id) WHERE status='waiting';
