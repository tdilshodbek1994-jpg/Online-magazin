-- T095 load fixture (synthetic): 10 000 active SKUs and 100 000 historical orders. Run on a disposable DB only.
\set ON_ERROR_STOP on
INSERT INTO categories (slug, name) VALUES ('load-cat', '{"uz-Latn":"Load"}') ON CONFLICT DO NOTHING;
WITH org AS (SELECT id FROM organizations WHERE kind='platform_owner'), cat AS (SELECT id FROM categories WHERE slug='load-cat'),
p AS (
  INSERT INTO products (owner_org_id, category_id, slug, name, status, search_doc, published_at)
  SELECT org.id, cat.id, 'load-' || g, jsonb_build_object('uz-Latn', 'Yuklama mahsulot ' || g), 'published', 'yuklama mahsulot ' || g || ' quloqchin', now()
    FROM org, cat, generate_series(1, 10000) g RETURNING id, slug)
INSERT INTO skus (product_id, sku_code, variant, variant_key) SELECT id, 'LD-' || slug, '{}', 'default' FROM p;
INSERT INTO offers (sku_id, merchant_org_id, price_minor) SELECT s.id, o.id, 1000000 + (random()*50000000)::bigint FROM skus s, organizations o WHERE o.kind='platform_owner' AND s.sku_code LIKE 'LD-%';
INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id, on_hand_sellable)
  SELECT s.id, o.id, w.id, 100000 FROM skus s, organizations o, warehouses w WHERE o.kind='platform_owner' AND w.code='MAIN' AND s.sku_code LIKE 'LD-%';
-- historical orders
WITH q AS (
  INSERT INTO checkout_quotes (currency, address_snapshot, contact_snapshot, delivery_method, subtotal_minor, delivery_minor, payable_minor, config_version, quote_hash, status, expires_at, created_at)
  SELECT 'UZS', '{}', '{}', 'zone:hist', 10000000, 0, 10000000, 0, md5(g::text), 'confirmed', now(), now() - (g || ' minutes')::interval FROM generate_series(1, 100000) g RETURNING id, created_at)
INSERT INTO orders (guest_ref, quote_id, currency, commercial_status, payment_status, fulfillment_status, payment_method, subtotal_minor, discount_minor, delivery_minor, payable_minor, address_snapshot, contact_snapshot, config_version, confirmation_status, customer_phone, created_at)
SELECT 'hist', q.id, 'UZS', 'completed', 'paid', 'delivered', 'cod', 10000000, 0, 0, 10000000, '{}', '{}', 0, 'verified', '+99890' || lpad((random()*9999999)::int::text, 7, '0'), q.created_at FROM q;
ANALYZE;
