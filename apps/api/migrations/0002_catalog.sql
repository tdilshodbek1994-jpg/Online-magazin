-- M06 categories/brands, M19 product/SKU/offer, M20 media/import/moderation, M07 search support.

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','archived')),
  requires_moderation boolean NOT NULL DEFAULT true,
  return_policy_code text,
  sort int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Cycle prevention in the tree (AC-M06: no cycles).
CREATE FUNCTION categories_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur uuid := NEW.parent_id; depth int := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN RAISE EXCEPTION 'CATEGORY_CYCLE' USING ERRCODE = 'P0001'; END IF;
    SELECT parent_id INTO cur FROM categories WHERE id = cur;
    depth := depth + 1;
    IF depth > 32 THEN RAISE EXCEPTION 'CATEGORY_TOO_DEEP' USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER categories_cycle BEFORE INSERT OR UPDATE OF parent_id ON categories FOR EACH ROW EXECUTE FUNCTION categories_no_cycle();

CREATE TABLE slug_redirects (
  entity_type text NOT NULL CHECK (entity_type IN ('category','product')),
  old_slug text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, old_slug)
);

CREATE TABLE attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name jsonb NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text','number','boolean','enum')),
  unit_code text,
  enum_values jsonb,
  CHECK (data_type <> 'enum' OR jsonb_typeof(enum_values) = 'array')
);

CREATE TABLE category_attributes (
  category_id uuid NOT NULL REFERENCES categories(id),
  attribute_id uuid NOT NULL REFERENCES attribute_definitions(id),
  required boolean NOT NULL DEFAULT false,
  variant_axis boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT true,
  PRIMARY KEY (category_id, attribute_id)
);

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id uuid NOT NULL REFERENCES organizations(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  brand_id uuid REFERENCES brands(id),
  slug text NOT NULL UNIQUE,
  name jsonb NOT NULL,
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text,
  warranty_months int CHECK (warranty_months IS NULL OR warranty_months >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_moderation','published','rejected','archived')),
  search_doc text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX products_category ON products (category_id) WHERE status = 'published';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_search_trgm ON products USING gin (search_doc gin_trgm_ops);

CREATE TABLE product_attributes (
  product_id uuid NOT NULL REFERENCES products(id),
  attribute_id uuid NOT NULL REFERENCES attribute_definitions(id),
  value jsonb NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','ai_suggested')),
  confirmed boolean NOT NULL DEFAULT true,
  confirmed_by uuid,
  PRIMARY KEY (product_id, attribute_id),
  -- AI suggestions are never confirmed facts without a human reviewer (AC-M08-2, AC-M50-1).
  CHECK (source <> 'ai_suggested' OR confirmed = false OR confirmed_by IS NOT NULL)
);

CREATE TABLE skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  sku_code text NOT NULL UNIQUE,
  barcode text UNIQUE,
  variant jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_key text NOT NULL,
  weight_g int CHECK (weight_g IS NULL OR weight_g > 0),
  length_mm int, width_mm int, height_mm int,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','recalled')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, variant_key)
);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES skus(id),
  merchant_org_id uuid NOT NULL REFERENCES organizations(id),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  compare_at_minor bigint,
  currency text NOT NULL DEFAULT 'UZS',
  tax_policy text NOT NULL DEFAULT 'vat_included' CHECK (tax_policy IN ('vat_included','vat_exempt','vat_added')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','quarantined')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, merchant_org_id),
  -- No fake "old price": compare-at must be genuinely higher (M12).
  CHECK (compare_at_minor IS NULL OR compare_at_minor > price_minor)
);

CREATE TABLE offer_versions (
  id bigserial PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offers(id),
  version int NOT NULL,
  price_minor bigint NOT NULL,
  compare_at_minor bigint,
  changed_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, version)
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  sku_id uuid REFERENCES skus(id),
  storage_key text NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','video/mp4')),
  width int, height int, bytes int,
  sha256 text NOT NULL,
  alt jsonb NOT NULL DEFAULT '{}'::jsonb,
  rights_source text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('product','review','media','attribute','merchant','brand_claim')),
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','appealed')),
  reason text,
  decision_reason text,
  created_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR status = 'appealed' OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX moderation_one_open ON moderation_cases (subject_type, subject_id) WHERE status = 'open';

CREATE TABLE search_synonyms (
  term text NOT NULL,
  synonym text NOT NULL,
  PRIMARY KEY (term, synonym)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('products_csv')),
  status text NOT NULL CHECK (status IN ('dry_run','committed','failed')),
  file_sha256 text NOT NULL,
  total_rows int NOT NULL,
  accepted_rows int NOT NULL,
  rejected_rows int NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
