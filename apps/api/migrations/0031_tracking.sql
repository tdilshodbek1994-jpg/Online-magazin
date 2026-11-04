-- Landing & Target P0C: ad-measurement consent, versioned event dictionary, tracking outbox, dispatch attempts,
-- single owner dataset settings. Additive only. No credentials are stored here (vault reference only, NULL by default).

-- Consent for optional ad measurement (Pixel/CAPI). Append-only: the latest row per subject wins; withdrawal is a new row.
CREATE TABLE tracking_consents (
  id bigserial PRIMARY KEY,
  subject_key text NOT NULL,                       -- 'u:<user_id>' or 'g:<sha256(guest token)>' — never a phone/email
  user_id uuid REFERENCES users(id),
  purpose text NOT NULL DEFAULT 'ad_measurement' CHECK (purpose IN ('ad_measurement')),
  status text NOT NULL CHECK (status IN ('granted','denied','withdrawn')),
  policy_version text NOT NULL,
  source text NOT NULL DEFAULT 'banner',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracking_consents_latest ON tracking_consents (subject_key, purpose, id DESC);

-- Versioned mapping internal_event -> provider event (from contracts/event_matrix.csv). NULL meta_event = internal only.
CREATE TABLE tracking_event_dictionary (
  mapping_version text NOT NULL,
  internal_event text NOT NULL,
  meta_event text,
  transport text NOT NULL CHECK (transport IN ('browser_and_server','server','internal')),
  value_rule text NOT NULL,
  PRIMARY KEY (mapping_version, internal_event)
);
INSERT INTO tracking_event_dictionary (mapping_version, internal_event, meta_event, transport, value_rule) VALUES
  ('v1','landing.rendered','PageView','browser_and_server','no purchase amount'),
  ('v1','product.viewed','ViewContent','browser_and_server','catalog product id + current visible price'),
  ('v1','cart.item_added','AddToCart','browser_and_server','accepted sku/qty/value from cart service'),
  ('v1','checkout.started','InitiateCheckout','browser_and_server','server quote value'),
  ('v1','customer.request_accepted','Lead','browser_and_server','optional verified value; never commission'),
  ('v1','sale.recognized','Purchase','server','gross sale value/currency; prepaid captured OR COD delivered+remitted'),
  ('v1','order.created',NULL,'internal','order total snapshot'),
  ('v1','order.confirmed',NULL,'internal','confirmed totals'),
  ('v1','order.delivered',NULL,'internal','units delivered'),
  ('v1','order.refunded',NULL,'internal','actual refund amount; never a negative Purchase'),
  ('v1','commission.matured',NULL,'internal','never exported'),
  ('v1','uzcoin.awarded',NULL,'internal','never exported')
ON CONFLICT DO NOTHING;

-- P0: exactly one owner-approved dataset for the shop (D12). Partner datasets are not supported.
CREATE TABLE tracking_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dataset_id text CHECK (dataset_id ~ '^[0-9]{6,20}$'),
  credentials_ref text,                            -- vault reference; never the token itself
  enabled boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL DEFAULT 'v1',
  consent_policy_version text NOT NULL DEFAULT 'ad-2026-11-v1',
  test_event_code text,                            -- refused in production
  api_version text,                                -- pinned provider API version (never 'latest')
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tracking_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Outbox: one row = one business event with one opaque event_id. business_key makes retries/replays the same event.
CREATE TABLE tracking_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_key text NOT NULL UNIQUE,
  mapping_version text NOT NULL,
  internal_event text NOT NULL,
  meta_event text,
  event_time timestamptz NOT NULL,                 -- when the real thing happened; never replaced by send time
  action_source text NOT NULL CHECK (action_source IN ('website','phone_call','chat','system_generated')),
  order_id uuid REFERENCES orders(id),
  landing_id uuid REFERENCES landing_pages(id),
  subject_key text,
  consent_id bigint REFERENCES tracking_consents(id),
  custom_data jsonb NOT NULL DEFAULT '{}'::jsonb,  -- value/currency/content_ids only
  user_data jsonb NOT NULL DEFAULT '{}'::jsonb,    -- hashed match fields + fbp/fbc only when supplied; never raw PII
  source_url text,                                 -- sanitized (no phone/email/address/query PII)
  is_test boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('internal','pending','blocked','sent','rejected','unknown','expired','suppressed')),
  blocked_reason text,
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracking_events_status ON tracking_events (status, created_at);
CREATE INDEX tracking_events_order ON tracking_events (order_id);

CREATE TABLE tracking_dispatch_attempts (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES tracking_events(event_id),
  outcome text NOT NULL CHECK (outcome IN ('sent','rejected','unknown','blocked','expired','suppressed')),
  http_status int,
  detail text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- Tracking context captured at order time (consent snapshot + browser identifiers the real customer supplied).
-- Partner-assisted (on-behalf) orders never carry the partner's browser identity.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_context jsonb;

INSERT INTO business_policies (key, version, value, status, is_demo, source_note) VALUES
  ('tracking.server_event_max_age_days', 1, '{"days": 7}', 'draft', true, 'DEMO default — provider acceptance window must be re-checked against the pinned API version before launch')
ON CONFLICT DO NOTHING;
