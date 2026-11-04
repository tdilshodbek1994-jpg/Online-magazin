-- Landing & Target P2B: custom domains for landings. Ownership only by a DNS TXT challenge the owner publishes
-- (we never change DNS). DNS ownership, TLS and Meta domain verification are separate statuses. One host = one claim.
CREATE TABLE landing_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text NOT NULL CHECK (host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  landing_id uuid NOT NULL REFERENCES landing_pages(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','disconnected')),
  txt_token text NOT NULL,
  verified_at timestamptz,
  last_check_at timestamptz,
  last_check_result text,
  tls_status text NOT NULL DEFAULT 'unknown' CHECK (tls_status IN ('unknown','pending','ready','failed')),
  meta_status text NOT NULL DEFAULT 'unknown' CHECK (meta_status IN ('unknown','token_saved','verified','unverified')),
  meta_token text CHECK (meta_token ~ '^[a-z0-9]{20,40}$'),
  fallback_domain_id uuid REFERENCES landing_domains(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE UNIQUE INDEX landing_domains_host_active ON landing_domains (host) WHERE status <> 'disconnected';
