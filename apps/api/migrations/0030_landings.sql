-- UZSHOP PRO — Landing Builder (P0B). Pages are versioned, immutable revisions of an allowlisted block schema
-- (no HTML/JS). Prices/stock are never stored in a revision: they are read live from the catalog at render time and
-- re-checked by the existing quote/order services. Orders keep a landing + revision snapshot.

CREATE TABLE landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  template text NOT NULL CHECK (template IN ('simple','pro','boom','multi')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  product_ids uuid[] NOT NULL CHECK (cardinality(product_ids) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','published','archived','revoked')),
  draft_revision int NOT NULL DEFAULT 1,
  approved_revision int, approved_digest text, approved_by uuid REFERENCES users(id), approved_at timestamptz,
  published_revision int, published_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE landing_revisions (
  landing_id uuid NOT NULL REFERENCES landing_pages(id),
  revision int NOT NULL,
  definition jsonb NOT NULL,
  digest text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (landing_id, revision)
);
CREATE TRIGGER landing_revisions_immutable BEFORE UPDATE OR DELETE ON landing_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Partner flow = existing referral link + approved landing + channel.
ALTER TABLE referral_links ADD COLUMN landing_id uuid REFERENCES landing_pages(id);
ALTER TABLE referral_links ADD COLUMN channel text CHECK (channel IS NULL OR channel IN ('telegram','instagram','facebook','other'));

-- Order snapshot of the landing the customer saw.
ALTER TABLE orders ADD COLUMN landing_snapshot jsonb;
