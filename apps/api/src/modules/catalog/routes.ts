import { normalizeSearch, slugify, tokenize } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { can, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam, zLocalized } from '../../platform/http.js';
import { moveStock } from '../inventory/service.js';
import { m } from '../orders/service.js';

export async function ownerOrgId(q: { query: (s: string) => Promise<{ rows: { id: string }[] }> }): Promise<string> {
  const r = await q.query(`SELECT id FROM organizations WHERE kind='platform_owner'`);
  if (!r.rows[0]) throw new Error('owner organization missing (run seed)');
  return r.rows[0].id;
}

function searchDoc(name: Record<string, string>, extra: string[]): string {
  return normalizeSearch([...Object.values(name), ...extra].join(' '));
}

const PUBLIC_PRODUCT_SQL = `
  SELECT p.id, p.slug, p.name, p.description, p.model, p.warranty_months, b.name AS brand, c.slug AS category_slug, c.name AS category_name,
         (SELECT json_agg(json_build_object('id', ma.id, 'url', '/media/' || ma.storage_key, 'alt', ma.alt) ORDER BY ma.sort) FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved') AS media,
         (SELECT json_agg(json_build_object('sku_id', s.id, 'sku_code', s.sku_code, 'variant', s.variant, 'price_minor', o.price_minor::text, 'compare_at_minor', o.compare_at_minor::text,
                 'available', GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0))) ORDER BY s.sku_code)
            FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' LEFT JOIN stock_balances sb ON sb.sku_id=s.id
           WHERE s.product_id=p.id AND s.status='active') AS variants
    FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id`;

export function registerCatalog(app: FastifyInstance, deps: Deps): void {
  const T = ['catalog'];

  // ---------- Public (no cost, internal notes or commission rules — §08) ----------
  route(app, deps, { method: 'GET', url: '/categories', tags: T, summary: 'Category tree' }, async ({ db }) => ({
    // cover: a real product photo from the category (or its children) for image tiles on the home page.
    items: await many(db, `SELECT c.id, c.parent_id, c.slug, c.name, c.sort,
        (SELECT '/media/' || ma.storage_key FROM products p JOIN media_assets ma ON ma.product_id=p.id AND ma.status='approved'
          WHERE p.status='published' AND p.category_id IN (SELECT id FROM categories x WHERE x.id=c.id OR x.parent_id=c.id)
          ORDER BY p.published_at DESC NULLS LAST, ma.sort LIMIT 1) AS cover
      FROM categories c WHERE c.status='active' ORDER BY c.sort, c.slug`),
  }));

  route(app, deps, {
    method: 'GET', url: '/products', tags: T, summary: 'Catalog list / search (cyrillic+latin, SKU)',
    query: z.object({ q: z.string().max(200).optional(), category: z.string().max(120).optional(), sort: z.enum(['new', 'price_asc', 'price_desc', 'popular', 'discount']).default('new'), in_stock: z.coerce.boolean().optional(), max_price: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).max(10000).default(0) }),
  }, async ({ db, query }) => {
    const params: unknown[] = [];
    const where = [`p.status='published'`];
    if (query.category) {
      params.push(query.category);
      where.push(`c.id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE slug=$${params.length} UNION ALL SELECT c2.id FROM categories c2 JOIN t ON c2.parent_id=t.id) SELECT id FROM t)`);
    }
    if (query.q) {
      const tokens = tokenize(query.q).slice(0, 8);
      // Synonyms resolved once; each token becomes LIKE (trigram-indexable) + boundary regex recheck (T095).
      const syn = tokens.length ? await many<{ term: string; synonym: string }>(db, `SELECT term, synonym FROM search_synonyms WHERE term = ANY($1)`, [tokens]) : [];
      const conds: string[] = [];
      for (const tok of tokens) {
        const alts = [tok, ...syn.filter((x) => x.term === tok).map((x) => x.synonym)];
        const ors: string[] = [];
        for (const a of alts) {
          params.push(`%${a}%`);
          const li = params.length;
          params.push('(^|[^a-z0-9])' + a + (/^\d+$/.test(a) ? '([^0-9]|$)' : ''));
          ors.push(`(p.search_doc LIKE $${li} AND p.search_doc ~ $${params.length})`);
        }
        conds.push(`(${ors.join(' OR ')})`);
      }
      params.push(query.q.trim().toLowerCase());
      const raw = params.length;
      const skuExact = `p.id IN (SELECT s2.product_id FROM skus s2 WHERE lower(s2.sku_code)=$${raw} OR s2.barcode=$${raw})`;
      where.push(conds.length ? `((${conds.join(' AND ')}) OR ${skuExact})` : skuExact);
    }
    // Aggregates are computed set-wise (GROUP BY) and, for the default "new" sort, only for the requested page (T095).
    const limitFirst = query.sort === 'new' && !query.in_stock && !query.max_price;
    params.push(query.limit, query.offset);
    const L = params.length - 1, O = params.length;
    const order = query.sort === 'price_asc' ? 'min_price ASC NULLS LAST, published_at DESC' : query.sort === 'price_desc' ? 'min_price DESC NULLS LAST, published_at DESC'
      : query.sort === 'popular' ? 'sold_30d DESC, published_at DESC NULLS LAST, id'
      : query.sort === 'discount' ? 'COALESCE(1 - min_price::numeric / NULLIF(compare_at, 0), 0) DESC, published_at DESC NULLS LAST, id'
      : 'published_at DESC NULLS LAST, id';
    const rows = await many(db, `
      WITH cand AS (
        SELECT p.id, p.slug, p.name, p.brand_id, p.published_at FROM products p JOIN categories c ON c.id=p.category_id
         WHERE ${where.join(' AND ')}
         ${limitFirst ? `ORDER BY p.published_at DESC NULLS LAST, p.id LIMIT $${L} OFFSET $${O}` : ''}),
      price AS (SELECT s.product_id, MIN(o.price_minor) AS min_price, MAX(o.compare_at_minor) FILTER (WHERE o.compare_at_minor > o.price_minor) AS compare_at FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.status='active' AND s.product_id IN (SELECT id FROM cand) GROUP BY s.product_id),
      avail AS (SELECT s.product_id, SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)) AS available FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.status='active' AND s.product_id IN (SELECT id FROM cand) GROUP BY s.product_id),
      -- Real popularity: units in confirmed (not cancelled) orders in the last 30 days. Never invented.
      sold AS (SELECT s.product_id, SUM(ol.qty)::int AS sold_30d FROM order_lines ol JOIN skus s ON s.id=ol.sku_id JOIN orders o ON o.id=ol.order_id
                WHERE o.created_at > now() - interval '30 days' AND o.commercial_status <> 'cancelled' AND o.confirmation_status = 'verified' AND s.product_id IN (SELECT id FROM cand) GROUP BY s.product_id),
      page AS (
        SELECT cand.*, price.min_price, price.compare_at, COALESCE(avail.available, 0) AS available, COALESCE(sold.sold_30d, 0) AS sold_30d
          FROM cand LEFT JOIN price ON price.product_id=cand.id LEFT JOIN avail ON avail.product_id=cand.id LEFT JOIN sold ON sold.product_id=cand.id
         WHERE TRUE ${query.in_stock ? 'AND COALESCE(avail.available,0) > 0' : ''} ${query.sort === 'discount' ? 'AND price.compare_at IS NOT NULL' : ''} ${query.max_price ? `AND price.min_price <= ${Number(query.max_price) * 100}` : ''}
         ORDER BY ${order} ${limitFirst ? '' : `LIMIT $${L} OFFSET $${O}`})
      SELECT page.id, page.slug, page.name, b.name AS brand, page.published_at, page.min_price, page.compare_at, page.available, page.sold_30d,
             (SELECT '/media/' || storage_key FROM media_assets ma WHERE ma.product_id=page.id AND ma.status='approved' ORDER BY sort LIMIT 1) AS image
        FROM page LEFT JOIN brands b ON b.id=page.brand_id ORDER BY ${order}`, params);
    return { items: rows.map((r) => ({ ...r, min_price: r.min_price ? m(r.min_price as string) : null, compare_at: r.compare_at ? m(r.compare_at as string) : null, available: Number(r.available) })) };
  });

  // "Bular bilan birga olishadi": products that really appeared in the same orders as the given products (no invented
  // pairings). When there is no history yet the response says so (basis: 'category') and the UI labels it "O'xshash".
  route(app, deps, { method: 'GET', url: '/products/also-bought', tags: T, summary: 'Products bought together with the given products (real order history)',
    query: z.object({ product_ids: z.string().max(2000) }) },
  async ({ db, query }) => {
    const ids = query.product_ids.split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 20);
    if (!ids.length) return { basis: 'none', items: [] };
    const cols = `p.id, p.slug, p.name, b.name AS brand, p.published_at,
        (SELECT MIN(o.price_minor) FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id AND s.status='active') AS min_price,
        (SELECT MAX(o.compare_at_minor) FILTER (WHERE o.compare_at_minor > o.price_minor) FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id) AS compare_at,
        (SELECT COALESCE(SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)),0) FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') AS available,
        (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image`;
    let basis = 'together';
    let rows = await many(db, `
      WITH src AS (SELECT DISTINCT ol.order_id FROM order_lines ol JOIN skus s ON s.id=ol.sku_id JOIN orders o ON o.id=ol.order_id
                    WHERE s.product_id = ANY($1::uuid[]) AND o.commercial_status <> 'cancelled'),
           co AS (SELECT s.product_id, COUNT(DISTINCT ol.order_id) AS n FROM order_lines ol JOIN skus s ON s.id=ol.sku_id
                   WHERE ol.order_id IN (SELECT order_id FROM src) AND NOT (s.product_id = ANY($1::uuid[])) GROUP BY 1)
      SELECT ${cols}, co.n AS together FROM co JOIN products p ON p.id=co.product_id LEFT JOIN brands b ON b.id=p.brand_id
       WHERE p.status='published' ORDER BY co.n DESC, p.published_at DESC LIMIT 8`, [ids]);
    rows = rows.filter((r) => Number(r.available) > 0);
    if (rows.length < 2) {
      basis = 'category';
      rows = await many(db, `SELECT ${cols}, 0 AS together FROM products p LEFT JOIN brands b ON b.id=p.brand_id
         WHERE p.status='published' AND NOT (p.id = ANY($1::uuid[])) AND p.category_id IN (SELECT category_id FROM products WHERE id = ANY($1::uuid[]))
         ORDER BY p.published_at DESC LIMIT 12`, [ids]);
      rows = rows.filter((r) => Number(r.available) > 0).slice(0, 8);
    }
    return { basis, items: rows.map((r) => ({ ...r, min_price: r.min_price ? m(String(r.min_price)) : null, compare_at: r.compare_at ? m(String(r.compare_at)) : null, available: Number(r.available), together: Number(r.together) })) };
  });

  route(app, deps, { method: 'GET', url: '/products/:slug', tags: T, summary: 'Product page', params: z.object({ slug: z.string().max(140) }) }, async ({ db, params }) => {
    const p = await maybeOne(db, `${PUBLIC_PRODUCT_SQL} WHERE p.slug=$1 AND p.status='published'`, [params.slug]);
    if (!p) {
      const red = await maybeOne<{ slug: string }>(db, `SELECT p.slug FROM slug_redirects r JOIN products p ON p.id=r.entity_id WHERE r.entity_type='product' AND r.old_slug=$1`, [params.slug]);
      if (red) return { redirect: red.slug };
      throw notFound('PRODUCT');
    }
    // Real social proof: units in verified, not-cancelled orders over the last 30 days.
    const sold = await maybeOne<{ n: number }>(db, `SELECT COALESCE(SUM(ol.qty),0)::int AS n FROM order_lines ol JOIN skus s ON s.id=ol.sku_id JOIN orders o ON o.id=ol.order_id
        WHERE s.product_id=$1 AND o.created_at > now() - interval '30 days' AND o.commercial_status <> 'cancelled' AND o.confirmation_status='verified'`, [(p as { id: string }).id]);
    return { ...p, sold_30d: sold?.n ?? 0 };
  });

  // ---------- Admin (catalog.write) ----------
  const zSku = z.object({
    sku_code: z.string().min(2).max(64).regex(/^[A-Za-z0-9._-]+$/),
    barcode: z.string().max(32).optional(),
    variant: z.record(z.string(), z.string().max(60)).default({}),
    price_minor: z.string().regex(/^[1-9]\d{0,15}$/),
    compare_at_minor: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
    cost_minor: z.string().regex(/^\d{1,16}$/).optional(),
    weight_g: z.number().int().positive().optional(),
  });
  const zProduct = z.object({
    name: zLocalized,
    description: z.object({ 'uz-Latn': z.string().max(10000).optional(), 'uz-Cyrl': z.string().max(10000).optional(), ru: z.string().max(10000).optional() }).default({}),
    category_id: z.string().uuid(),
    brand: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
    warranty_months: z.number().int().min(0).max(120).optional(),
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120).optional(),
    skus: z.array(zSku).min(1).max(50),
  });

  route(app, deps, { method: 'GET', url: '/admin/products', tags: T, summary: 'Admin product list (incl. drafts)', query: z.object({ q: z.string().optional(), status: z.string().optional() }) }, async ({ actor, db, query }) => {
    requirePerm(actor, 'catalog.write');
    const internal = can(actor, 'catalog.read_internal');
    const rows = await many(db, `
      SELECT p.id, p.slug, p.name, p.description, p.category_id, p.warranty_months, b.name AS brand, p.status, p.version, p.updated_at,
             (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
             (SELECT json_agg(json_build_object('sku_id', s.id, 'sku_code', s.sku_code, 'variant', s.variant, 'status', s.status, 'price_minor', o.price_minor::text, 'compare_at_minor', o.compare_at_minor::text, 'offer_version', o.version,
                     'cost_minor', CASE WHEN $3 THEN s.cost_minor::text END, 'on_hand', sb.on_hand_sellable, 'reserved', sb.reserved) ORDER BY s.sku_code)
                FROM skus s LEFT JOIN offers o ON o.sku_id=s.id LEFT JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') AS skus,
             (SELECT json_build_object('kind', kind, 'rate_bps', rate_bps, 'fixed_minor', fixed_minor::text, 'version', version) FROM commission_rules cr WHERE cr.product_id=p.id AND (cr.effective_to IS NULL OR cr.effective_to > now()) ORDER BY version DESC LIMIT 1) AS commission_rule
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE ($1::text IS NULL OR p.search_doc LIKE '%' || $1 || '%') AND ($2::text IS NULL OR p.status=$2)
       ORDER BY p.updated_at DESC LIMIT 200`, [query.q ? normalizeSearch(query.q) : null, query.status ?? null, internal]);
    return { items: rows };
  });

  route(app, deps, { method: 'POST', url: '/admin/products', tags: T, summary: 'Create product with SKUs (draft)', body: zProduct }, async ({ actor, db, body }) => {
    // Partners have no catalog.write: owner_only mode (AC-M01-1, T003).
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const org = await ownerOrgId(tx);
      const cat = await maybeOne(tx, `SELECT id FROM categories WHERE id=$1`, [body.category_id]);
      if (!cat) throw badRequest('CATEGORY_UNKNOWN', { 'body.category_id': 'validation.category' });
      let brandId: string | null = null;
      if (body.brand) {
        const b = await one<{ id: string }>(tx, `INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=brands.name RETURNING id`, [slugify(body.brand) || 'brand', body.brand]);
        brandId = b.id;
      }
      const baseSlug = body.slug ?? slugify(body.name['uz-Latn'] ?? body.name['uz-Cyrl'] ?? body.name.ru ?? 'product');
      const slugTaken = await maybeOne(tx, `SELECT 1 FROM products WHERE slug=$1`, [baseSlug]);
      const slug = slugTaken ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
      const p = await one<{ id: string }>(tx, `INSERT INTO products (owner_org_id, category_id, brand_id, slug, name, description, model, warranty_months, search_doc, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [org, body.category_id, brandId, slug, JSON.stringify(body.name), JSON.stringify(body.description), body.model ?? null, body.warranty_months ?? null,
         searchDoc(body.name as Record<string, string>, [body.brand ?? '', body.model ?? '', ...body.skus.map((s) => s.sku_code)]), actor.userId]);
      const skus: { sku_id: string; offer_id: string; sku_code: string }[] = [];
      for (const s of body.skus) skus.push({ ...(await insertSku(tx, p.id, org, s, actor.userId!)), sku_code: s.sku_code });
      await audit(tx, actor, 'product.created', { type: 'product', id: p.id }, { after: { slug, skus: body.skus.map((s) => s.sku_code) } });
      return { id: p.id, slug, version: 1, skus };
    });
  });

  route(app, deps, {
    method: 'PATCH', url: '/admin/products/:id', tags: T, summary: 'Edit name / description / category / brand / warranty (expected_version)', params: zIdParam,
    body: z.object({ expected_version: z.number().int(), name: zLocalized.optional(), description: z.object({ 'uz-Latn': z.string().max(10000).optional(), 'uz-Cyrl': z.string().max(10000).optional() }).optional(),
      category_id: z.string().uuid().optional(), brand: z.string().max(80).nullable().optional(), warranty_months: z.number().int().min(0).max(120).nullable().optional() }),
  }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const p = await maybeOne<{ version: number; name: Record<string, string>; description: Record<string, string>; brand_id: string | null; model: string | null }>(tx, `SELECT version, name, description, brand_id, model FROM products WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!p) throw notFound('PRODUCT');
      if (p.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: p.version });
      if (body.category_id && !(await maybeOne(tx, `SELECT 1 FROM categories WHERE id=$1`, [body.category_id]))) throw badRequest('CATEGORY_UNKNOWN');
      let brandId: string | null | undefined;
      if (body.brand !== undefined) brandId = body.brand ? (await one<{ id: string }>(tx, `INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=brands.name RETURNING id`, [slugify(body.brand) || 'brand', body.brand])).id : null;
      const name = body.name ?? p.name;
      const skuCodes = (await tx.query(`SELECT sku_code FROM skus WHERE product_id=$1`, [params.id])).rows.map((r: { sku_code: string }) => r.sku_code);
      const r = await one(tx, `UPDATE products SET name=$2, description=COALESCE($3, description), category_id=COALESCE($4, category_id), brand_id=CASE WHEN $5 THEN $6 ELSE brand_id END,
          warranty_months=CASE WHEN $7 THEN $8 ELSE warranty_months END, search_doc=$9, version=version+1, updated_at=now() WHERE id=$1 RETURNING id, version`,
        [params.id, JSON.stringify(name), body.description ? JSON.stringify(body.description) : null, body.category_id ?? null, brandId !== undefined, brandId ?? null,
         body.warranty_months !== undefined, body.warranty_months ?? null, searchDoc(name as Record<string, string>, [body.brand ?? '', p.model ?? '', ...skuCodes])]);
      await audit(tx, actor, 'product.updated', { type: 'product', id: params.id }, { before: { name: p.name }, after: { name } });
      return r;
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/products/:id/status', tags: T, summary: 'Publish / archive (draft|active|archived)', params: zIdParam, body: z.object({ status: z.enum(['draft', 'published', 'archived']), expected_version: z.number().int() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'catalog.write');
      return withTx(db, async (tx) => {
        const p = await maybeOne<{ version: number; status: string }>(tx, `SELECT version, status FROM products WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!p) throw notFound('PRODUCT');
        if (p.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: p.version });
        if (body.status === 'published') {
          const ok = await maybeOne(tx, `SELECT 1 FROM skus s JOIN offers o ON o.sku_id=s.id WHERE s.product_id=$1 AND s.status='active' AND o.status='active' LIMIT 1`, [params.id]);
          if (!ok) throw unprocessable('PRODUCT_HAS_NO_SELLABLE_SKU');
        }
        const r = await one(tx, `UPDATE products SET status=$2, version=version+1, updated_at=now(), published_at = CASE WHEN $2='published' THEN COALESCE(published_at, now()) ELSE published_at END WHERE id=$1 RETURNING id, status, version`, [params.id, body.status]);
        await audit(tx, actor, 'product.status', { type: 'product', id: params.id }, { before: { status: p.status }, after: { status: body.status } });
        return r;
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/products/:id/skus', tags: T, summary: 'Add SKU', params: zIdParam, body: zSku }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const org = await ownerOrgId(tx);
      if (!(await maybeOne(tx, `SELECT 1 FROM products WHERE id=$1`, [params.id]))) throw notFound('PRODUCT');
      return insertSku(tx, params.id, org, body, actor.userId!);
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/skus/:id/archive', tags: T, summary: 'Archive SKU (never physically deleted, §08)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    const r = await db.query(`UPDATE skus SET status='archived', version=version+1 WHERE id=$1 RETURNING id`, [params.id]);
    if (!r.rowCount) throw notFound('SKU');
    await audit(db, actor, 'sku.archived', { type: 'sku', id: params.id });
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/skus/:id/price', tags: T, summary: 'Change price (versioned, old orders keep snapshot)', params: zIdParam,
    body: z.object({ price_minor: z.string().regex(/^[1-9]\d{0,15}$/), compare_at_minor: z.string().regex(/^[1-9]\d{0,15}$/).nullable().optional(), expected_version: z.number().int(), reason: z.string().max(300).optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ id: string; version: number; price_minor: string }>(tx, `SELECT id, version, price_minor FROM offers WHERE sku_id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('OFFER');
      if (o.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: o.version });
      const r = await one<{ version: number }>(tx, `UPDATE offers SET price_minor=$2, compare_at_minor=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, [o.id, body.price_minor, body.compare_at_minor ?? null]);
      await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, compare_at_minor, changed_by, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [o.id, r.version, body.price_minor, body.compare_at_minor ?? null, actor.userId, body.reason ?? null]);
      await audit(tx, actor, 'offer.price_changed', { type: 'offer', id: o.id }, { before: { price_minor: o.price_minor }, after: { price_minor: body.price_minor }, reason: body.reason });
      return { offer_version: r.version };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/skus/:id/stock', tags: T, summary: 'Stock receipt / adjustment / write-off (movement journal)', params: zIdParam,
    body: z.object({ kind: z.enum(['receipt', 'adjustment', 'to_damaged']), qty: z.number().int().refine((v) => v !== 0), reason: z.string().min(2).max(300), ref: z.string().min(4).max(80) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'inventory.write');
    return withTx(db, async (tx) => {
      const org = await ownerOrgId(tx);
      if (!(await maybeOne(tx, `SELECT 1 FROM skus WHERE id=$1`, [params.id]))) throw notFound('SKU');
      if (body.kind === 'receipt' && body.qty < 0) throw badRequest('RECEIPT_QTY_POSITIVE');
      if (body.kind === 'to_damaged') {
        await moveStock(tx, { skuId: params.id, merchantOrgId: org, kind: 'to_damaged', bucket: 'on_hand_sellable', qty: -Math.abs(body.qty), refType: 'manual', refId: body.ref, actorId: actor.userId, reason: body.reason });
        await moveStock(tx, { skuId: params.id, merchantOrgId: org, kind: 'to_damaged', bucket: 'damaged', qty: Math.abs(body.qty), refType: 'manual', refId: body.ref, actorId: actor.userId, reason: body.reason });
      } else {
        const applied = await moveStock(tx, { skuId: params.id, merchantOrgId: org, kind: body.kind, bucket: 'on_hand_sellable', qty: body.qty, refType: 'manual', refId: body.ref, actorId: actor.userId, reason: body.reason });
        if (!applied) return { ok: true, replayed: true };
      }
      // Reserved goods cannot be adjusted away silently (§15).
      const sb = await one<{ on_hand_sellable: number; reserved: number }>(tx, `SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [params.id]);
      if (sb.on_hand_sellable < sb.reserved) throw conflict('ADJUSTMENT_BELOW_RESERVED');
      await audit(tx, actor, 'stock.' + body.kind, { type: 'sku', id: params.id }, { after: { qty: body.qty, ref: body.ref }, reason: body.reason });
      return { ok: true, on_hand: sb.on_hand_sellable, reserved: sb.reserved };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/products/:id/commission-rules', tags: T, summary: 'New commission rule version (percent XOR fixed)', params: zIdParam,
    body: z.object({ kind: z.enum(['percent', 'fixed_per_unit']), rate_bps: z.number().int().min(1).max(10000).optional(), fixed_minor: z.string().regex(/^[1-9]\d{0,15}$/).optional(), effective_from: z.string().datetime().optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'commission_rules.write'); requireStepUp(actor);
    if ((body.kind === 'percent') !== (body.rate_bps !== undefined) || (body.kind === 'fixed_per_unit') !== (body.fixed_minor !== undefined)) throw badRequest('COMMISSION_RULE_SHAPE');
    return withTx(db, async (tx) => {
      if (!(await maybeOne(tx, `SELECT 1 FROM products WHERE id=$1`, [params.id]))) throw notFound('PRODUCT');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rule:${params.id}`]);
      const from = body.effective_from ? new Date(body.effective_from) : new Date();
      await tx.query(`UPDATE commission_rules SET effective_to=$2 WHERE product_id=$1 AND effective_to IS NULL AND effective_from < $2`, [params.id, from]);
      const v = await one<{ v: number }>(tx, `SELECT COALESCE(MAX(version),0)+1 AS v FROM commission_rules WHERE product_id=$1`, [params.id]);
      const r = await one(tx, `INSERT INTO commission_rules (product_id, version, kind, rate_bps, fixed_minor, effective_from, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version`,
        [params.id, v.v, body.kind, body.rate_bps ?? null, body.fixed_minor ?? null, from, actor.userId]);
      await audit(tx, actor, 'commission_rule.created', { type: 'product', id: params.id }, { after: body });
      return r;
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/categories', tags: T, summary: 'Create category', body: z.object({ slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), name: zLocalized, parent_id: z.string().uuid().nullable().optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'catalog.write');
      const r = await one(db, `INSERT INTO categories (slug, name, parent_id) VALUES ($1,$2,$3) RETURNING id, slug`, [body.slug, JSON.stringify(body.name), body.parent_id ?? null]);
      await audit(db, actor, 'category.created', { type: 'category', id: (r as { id: string }).id });
      return r;
    });
}

async function insertSku(tx: import('../../platform/db.js').Tx, productId: string, org: string, s: { sku_code: string; barcode?: string; variant: Record<string, string>; price_minor: string; compare_at_minor?: string; cost_minor?: string; weight_g?: number }, actorId: string) {
  const variantKey = Object.keys(s.variant).sort().map((k) => `${k}=${s.variant[k]}`).join('|') || 'default';
  const sku = await one<{ id: string }>(tx, `INSERT INTO skus (product_id, sku_code, barcode, variant, variant_key, weight_g, cost_minor) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [productId, s.sku_code, s.barcode ?? null, JSON.stringify(s.variant), variantKey, s.weight_g ?? null, s.cost_minor ?? null])
    .catch((e: { code?: string; constraint?: string }) => { if (e.code === '23505') throw conflict(String(e.constraint ?? '').includes('variant') ? 'VARIANT_DUPLICATE' : 'SKU_CODE_TAKEN'); throw e; });
  const o = await one<{ id: string }>(tx, `INSERT INTO offers (sku_id, merchant_org_id, price_minor, compare_at_minor) VALUES ($1,$2,$3,$4) RETURNING id`, [sku.id, org, s.price_minor, s.compare_at_minor ?? null]);
  await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, compare_at_minor, changed_by, reason) VALUES ($1,1,$2,$3,$4,'created')`, [o.id, s.price_minor, s.compare_at_minor ?? null, actorId]);
  const wh = await tx.query(`SELECT id FROM warehouses WHERE code='MAIN'`);
  await tx.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [sku.id, org, wh.rows[0].id]);
  return { sku_id: sku.id, offer_id: o.id };
}
