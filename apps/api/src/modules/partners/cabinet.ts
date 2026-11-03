import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { many, maybeOne, one } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { myPartner } from './routes.js';

/**
 * Partner cabinet v2 read models: dashboard, market, streams ("oqim"), statistics, requests, leaderboard.
 * Read-only projections over orders / referral data / commission accruals; money movements stay in commissions/service.
 * Partners only ever see masked customer data (T004).
 */

/** One customer-facing bucket per order, derived from the separate status dimensions. */
export const BUCKET_SQL = `CASE
  WHEN o.commercial_status='cancelled' OR o.confirmation_status IN ('rejected','expired') THEN 'cancelled'
  WHEN o.fulfillment_status IN ('returned','failed') THEN 'returned'
  WHEN o.fulfillment_status='delivered' OR o.commercial_status='completed' THEN 'delivered'
  WHEN o.fulfillment_status='shipped' THEN 'shipping'
  WHEN o.commercial_status='confirmed' AND o.confirmation_status='verified' THEN 'accepted'
  ELSE 'new' END`;
export const BUCKETS = ['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled'] as const;

const zPeriod = z.enum(['today', 'yesterday', 'week', 'month', 'half_year', 'all']).default('all');
type Period = z.infer<typeof zPeriod>;
const TZ = `'Asia/Tashkent'`;
const dayStart = `(date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;
/** SQL predicate for a timestamp column, in Tashkent local days. */
export function periodSql(col: string, p: Period): string {
  switch (p) {
    case 'today': return `${col} >= ${dayStart}`;
    case 'yesterday': return `${col} >= ${dayStart} - interval '1 day' AND ${col} < ${dayStart}`;
    case 'week': return `${col} >= now() - interval '7 days'`;
    case 'month': return `${col} >= (date_trunc('month', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;
    case 'half_year': return `${col} >= now() - interval '182 days'`;
    default: return 'true';
  }
}

/** Current commission per unit at the lowest active price (what the partner earns for one sold unit). */
const PAYOUT_SQL = `(SELECT CASE cr.kind WHEN 'percent' THEN (price.min_price * cr.rate_bps / 10000) ELSE cr.fixed_minor END
   FROM commission_rules cr WHERE cr.product_id=p.id AND cr.effective_from <= now() AND (cr.effective_to IS NULL OR cr.effective_to > now()) ORDER BY cr.version DESC LIMIT 1)`;

type Counts = Record<(typeof BUCKETS)[number] | 'total', number>;
const counts = (rows: { bucket: string; n: number }[]): Counts => {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<(typeof BUCKETS)[number], number>;
  for (const r of rows) if (r.bucket in c) c[r.bucket as (typeof BUCKETS)[number]] = Number(r.n);
  return { ...c, total: Object.values(c).reduce((a, b) => a + b, 0) };
};

export function maskName(n: unknown): string {
  const s = typeof n === 'string' ? n.trim() : '';
  return s ? `${Array.from(s)[0]}***` : '—';
}
export function maskTail(phone: unknown): string {
  const d = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  return d.length >= 2 ? `+998 ** *** ** ${d.slice(-2)}` : '—';
}

export function registerPartnerCabinet(app: FastifyInstance, deps: Deps): void {
  const T = ['partner'];

  route(app, deps, { method: 'GET', url: '/partner/dashboard', tags: T, summary: 'Cabinet home: today/period results, delivery rate, balances, rank', query: z.object({ period: zPeriod.default('today') }) },
    async ({ actor, db, query }) => {
      const p = await myPartner(db, actor, false);
      const per = counts(await many(db, `SELECT ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)} GROUP BY 1`, [p.id]));
      const d30 = counts(await many(db, `SELECT ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at >= now() - interval '30 days' GROUP BY 1`, [p.id]));
      const finished = d30.delivered + d30.returned + d30.cancelled;
      const clicks = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM referral_touches t WHERE t.partner_id=$1 AND t.eligible AND ${periodSql('t.touched_at', query.period)}`, [p.id]);
      const earned = await one<{ estimated: string; confirmed: string }>(db, `
        SELECT COALESCE(SUM(a.target_minor) FILTER (WHERE a.state IN ('estimated','pending')),0)::text AS estimated,
               COALESCE(SUM(a.target_minor) FILTER (WHERE a.state='available'),0)::text AS confirmed
          FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)}`, [p.id]);
      const bal = await maybeOne(db, `SELECT estimated_minor::text, pending_minor::text, available_minor::text, reserved_minor::text, paid_minor::text, debt_minor::text FROM partner_balances WHERE partner_id=$1`, [p.id]);
      const rank = await maybeOne<{ rank: number; delivered: number }>(db, `
        WITH r AS (SELECT o.attributed_partner_id AS pid, COUNT(*) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered, COUNT(*)::int AS total
                     FROM orders o WHERE o.attributed_partner_id IS NOT NULL AND ${periodSql('o.created_at', 'month')} GROUP BY 1)
        SELECT rank, delivered FROM (SELECT pid, delivered, RANK() OVER (ORDER BY delivered DESC, total DESC)::int AS rank FROM r) x WHERE pid=$1`, [p.id]);
      return {
        partner: { id: p.id, code: p.code, display_name: p.display_name, status: p.status, since: (p as unknown as { created_at?: string }).created_at ?? null },
        period: query.period, orders: per, clicks: clicks.n,
        conversion_pct: clicks.n ? Math.round((per.total / clicks.n) * 1000) / 10 : null,
        delivery_rate_30d: finished ? Math.round((d30.delivered / finished) * 1000) / 10 : null,
        earned: { estimated_minor: earned.estimated, confirmed_minor: earned.confirmed },
        balances: bal ?? { estimated_minor: '0', pending_minor: '0', available_minor: '0', reserved_minor: '0', paid_minor: '0', debt_minor: '0' },
        month_rank: rank ?? null,
      };
    });

  route(app, deps, {
    method: 'GET', url: '/partner/market', tags: T, summary: 'Products to promote: price, partner payout per unit, stock, platform accept/delivery rates, my stream',
    query: z.object({ q: z.string().max(100).optional(), sort: z.enum(['new', 'top', 'payout']).default('new'), category: z.string().max(120).optional() }),
  }, async ({ actor, db, query }) => {
    const p = await myPartner(db, actor, false);
    const params: unknown[] = [p.id];
    const where = [`p.status='published'`];
    if (query.q) { params.push(`%${query.q.toLowerCase()}%`); where.push(`(p.search_doc LIKE $${params.length} OR lower(p.name::text) LIKE $${params.length})`); }
    if (query.category) { params.push(query.category); where.push(`p.category_id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE slug=$${params.length} UNION ALL SELECT c2.id FROM categories c2 JOIN t ON c2.parent_id=t.id) SELECT id FROM t)`); }
    const order = query.sort === 'payout' ? 'payout_minor DESC NULLS LAST' : query.sort === 'top' ? 'delivered_30d DESC, orders_30d DESC' : 'p.published_at DESC NULLS LAST';
    const rows = await many(db, `
      WITH stats AS (
        SELECT s.product_id, COUNT(DISTINCT o.id)::int AS orders_30d,
               COUNT(DISTINCT o.id) FILTER (WHERE ${BUCKET_SQL} IN ('accepted','shipping','delivered','returned'))::int AS accepted_30d,
               COUNT(DISTINCT o.id) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered_30d,
               AVG(EXTRACT(EPOCH FROM (sh.handed_over_at - o.created_at))) FILTER (WHERE sh.handed_over_at IS NOT NULL) AS ship_secs
          FROM order_lines ol JOIN skus s ON s.id=ol.sku_id JOIN orders o ON o.id=ol.order_id
          LEFT JOIN shipments sh ON sh.order_id=o.id
         WHERE o.created_at >= now() - interval '30 days' GROUP BY s.product_id)
      SELECT p.id, p.slug, p.name, b.name AS brand, c.slug AS category_slug, p.published_at,
             price.min_price::text AS price_minor, price.compare_at::text AS compare_at_minor,
             (${PAYOUT_SQL})::text AS payout_minor,
             COALESCE(stock.available, 0)::int AS stock,
             COALESCE(st.orders_30d, 0) AS orders_30d, COALESCE(st.accepted_30d, 0) AS accepted_30d, COALESCE(st.delivered_30d, 0) AS delivered_30d,
             ROUND(st.ship_secs)::int AS avg_ship_seconds,
             (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
             (SELECT json_build_object('id', l.id, 'code', l.code) FROM referral_links l WHERE l.partner_id=$1 AND l.product_id=p.id AND l.status='active' ORDER BY l.created_at DESC LIMIT 1) AS my_stream,
             (p.published_at >= now() - interval '7 days') AS is_new
        FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
        JOIN LATERAL (SELECT MIN(o.price_minor) AS min_price, MAX(o.compare_at_minor) FILTER (WHERE o.compare_at_minor > o.price_minor) AS compare_at
                        FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id AND s.status='active') price ON price.min_price IS NOT NULL
        LEFT JOIN LATERAL (SELECT SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)) AS available FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') stock ON true
        LEFT JOIN stats st ON st.product_id=p.id
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
    return {
      items: rows.map((r) => {
        const o = Number(r.orders_30d), a = Number(r.accepted_30d), d = Number(r.delivered_30d);
        return { ...r, accept_rate_pct: o ? Math.round((a / o) * 100) : null, delivery_rate_pct: a ? Math.round((d / a) * 100) : null, low_stock: Number(r.stock) > 0 && Number(r.stock) <= 5 };
      }),
    };
  });

  route(app, deps, { method: 'POST', url: '/partner/streams', tags: T, summary: 'Create a named stream (referral link) for a product', body: z.object({ product_id: z.string().uuid(), name: z.string().trim().min(1).max(80) }) },
    async ({ actor, db, cfg, body }) => {
      const p = await myPartner(db, actor);
      const pr = await maybeOne<{ slug: string }>(db, `SELECT slug FROM products WHERE id=$1 AND status='published'`, [body.product_id]);
      if (!pr) throw notFound('PRODUCT');
      const code = randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12);
      const l = await one<{ id: string }>(db, `INSERT INTO referral_links (partner_id, product_id, code, name) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, body.product_id, code, body.name]);
      return { id: l.id, code, name: body.name, url: `${cfg.publicWebUrl}/r/${code}` };
    });

  route(app, deps, { method: 'GET', url: '/partner/streams', tags: T, summary: 'My streams with clicks, orders by status and earnings', query: z.object({ q: z.string().max(100).optional(), period: zPeriod }) },
    async ({ actor, db, cfg, query }) => {
      const p = await myPartner(db, actor, false);
      const params: unknown[] = [p.id];
      let filter = '';
      if (query.q) { params.push(`%${query.q.toLowerCase()}%`); filter = `AND (lower(coalesce(l.name,'')) LIKE $2 OR lower(pr.name::text) LIKE $2 OR lower(l.code) LIKE $2)`; }
      const rows = await many(db, `
        SELECT l.id, l.code, l.name, l.status, l.created_at, pr.id AS product_id, pr.slug, pr.name AS product_name,
               (SELECT MIN(o.price_minor) FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=pr.id AND s.status='active')::text AS price_minor,
               (SELECT COALESCE(SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)),0) FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=pr.id AND s.status='active')::int AS stock,
               (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=pr.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
               (SELECT COUNT(*)::int FROM referral_touches t WHERE t.link_id=l.id AND t.eligible AND ${periodSql('t.touched_at', query.period)}) AS clicks,
               (SELECT json_object_agg(b, n) FROM (SELECT ${BUCKET_SQL} AS b, COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND o.attribution->>'link_id'=l.id::text AND ${periodSql('o.created_at', query.period)} GROUP BY 1) x) AS buckets,
               (SELECT COALESCE(SUM(a.target_minor) FILTER (WHERE a.state='available'),0)::text FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE o.attributed_partner_id=$1 AND o.attribution->>'link_id'=l.id::text) AS earned_minor,
               (SELECT COALESCE(SUM(a.target_minor) FILTER (WHERE a.state IN ('estimated','pending')),0)::text FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE o.attributed_partner_id=$1 AND o.attribution->>'link_id'=l.id::text) AS pending_minor
          FROM referral_links l LEFT JOIN products pr ON pr.id=l.product_id
         WHERE l.partner_id=$1 AND l.status='active' ${filter} ORDER BY l.created_at DESC LIMIT 300`, params);
      return { items: rows.map((r) => ({ ...r, url: `${cfg.publicWebUrl}/r/${r.code}`, orders: counts(Object.entries((r.buckets as Record<string, number>) ?? {}).map(([bucket, n]) => ({ bucket, n }))) })) };
    });

  route(app, deps, { method: 'DELETE', url: '/partner/streams/:id', tags: T, summary: 'Archive a stream (link stops attributing; history kept)', params: zIdParam },
    async ({ actor, db, params }) => {
      const p = await myPartner(db, actor, false);
      const r = await db.query(`UPDATE referral_links SET status='disabled' WHERE id=$1 AND partner_id=$2 AND status='active' RETURNING id`, [params.id, p.id]);
      if (!r.rowCount) throw notFound('STREAM');
      await audit(db, actor, 'partner.stream_archived', { type: 'referral_link', id: params.id }, {});
      return { ok: true };
    });

  route(app, deps, { method: 'GET', url: '/partner/stats', tags: T, summary: 'Statistics grouped by stream or by day', query: z.object({ group: z.enum(['stream', 'day']).default('stream'), period: zPeriod.default('month') }) },
    async ({ actor, db, query }) => {
      const p = await myPartner(db, actor, false);
      const key = query.group === 'day' ? `to_char(o.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD')` : `coalesce(o.attribution->>'link_id', 'direct')`;
      const rows = await many<{ k: string; bucket: string; n: number; earned: string; pending: string }>(db, `
        SELECT ${key} AS k, ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n,
               COALESCE(SUM((SELECT SUM(a.target_minor) FROM commission_accruals a WHERE a.order_id=o.id AND a.state='available')),0)::text AS earned,
               COALESCE(SUM((SELECT SUM(a.target_minor) FROM commission_accruals a WHERE a.order_id=o.id AND a.state IN ('estimated','pending'))),0)::text AS pending
          FROM orders o WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)} GROUP BY 1, 2`, [p.id]);
      const clickKey = query.group === 'day' ? `to_char(t.touched_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD')` : `t.link_id::text`;
      const clicks = await many<{ k: string; n: number }>(db, `SELECT ${clickKey} AS k, COUNT(*)::int AS n FROM referral_touches t WHERE t.partner_id=$1 AND t.eligible AND ${periodSql('t.touched_at', query.period)} GROUP BY 1`, [p.id]);
      const names = query.group === 'stream'
        ? Object.fromEntries((await many<{ id: string; name: string | null; code: string; product_name: unknown }>(db, `SELECT l.id, l.name, l.code, pr.name AS product_name FROM referral_links l LEFT JOIN products pr ON pr.id=l.product_id WHERE l.partner_id=$1`, [p.id])).map((l) => [l.id, l]))
        : {};
      const by = new Map<string, { key: string; clicks: number; rows: { bucket: string; n: number }[]; earned: bigint; pending: bigint }>();
      const get = (k: string) => { if (!by.has(k)) by.set(k, { key: k, clicks: 0, rows: [], earned: 0n, pending: 0n }); return by.get(k)!; };
      for (const r of rows) { const g = get(r.k); g.rows.push({ bucket: r.bucket, n: r.n }); g.earned += BigInt(r.earned); g.pending += BigInt(r.pending); }
      for (const c of clicks) get(c.k).clicks = Number(c.n);
      const items = [...by.values()].map((g) => {
        const o = counts(g.rows);
        const l = names[g.key];
        return { key: g.key, label: l ? (l.name ?? l.code) : g.key === 'direct' ? null : g.key, product_name: l?.product_name ?? null, clicks: g.clicks, orders: o, earned_minor: g.earned.toString(), pending_minor: g.pending.toString(),
          delivery_rate_pct: o.delivered + o.returned + o.cancelled ? Math.round((o.delivered / (o.delivered + o.returned + o.cancelled)) * 100) : null };
      }).sort((a, b) => (query.group === 'day' ? b.key.localeCompare(a.key) : b.orders.total - a.orders.total));
      return { group: query.group, period: query.period, items };
    });

  route(app, deps, {
    method: 'GET', url: '/partner/requests', tags: T, summary: 'My orders ("so\'rovlar") with status buckets, masked customer, region',
    query: z.object({ status: z.enum(['all', 'callback', 'duplicate', ...BUCKETS]).default('all'), period: zPeriod, q: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  }, async ({ actor, db, query }) => {
    const p = await myPartner(db, actor, false);
    const params: unknown[] = [p.id];
    const where = [`o.attributed_partner_id=$1`, periodSql('o.created_at', query.period)];
    if (query.status === 'callback') where.push(`o.callback_at IS NOT NULL AND ${BUCKET_SQL}='new'`);
    else if (query.status === 'duplicate') where.push(`o.duplicate_signal`);
    else if (query.status !== 'all') { params.push(query.status); where.push(`${BUCKET_SQL}=$${params.length}`); }
    if (query.q) { params.push(`%${query.q}%`); where.push(`(o.number ILIKE $${params.length} OR EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id=o.id AND ol.product_snapshot::text ILIKE $${params.length}))`); }
    const tally = counts(await many(db, `SELECT ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)} GROUP BY 1`, [p.id]));
    const extra = await one<{ callback: number; duplicate: number }>(db, `SELECT COUNT(*) FILTER (WHERE o.callback_at IS NOT NULL AND ${BUCKET_SQL}='new')::int AS callback, COUNT(*) FILTER (WHERE o.duplicate_signal)::int AS duplicate FROM orders o WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)}`, [p.id]);
    params.push(query.limit, query.offset);
    const rows = await many(db, `
      SELECT o.id, 'OM-***' || right(o.number, 3) AS masked_number, o.channel, ${BUCKET_SQL} AS bucket, o.created_at, o.delivered_at, (o.callback_at IS NOT NULL) AS callback, o.duplicate_signal AS duplicate,
             o.contact_snapshot->>'name' AS cname, coalesce(o.customer_phone, o.contact_snapshot->>'phone') AS cphone,
             o.address_snapshot->>'district' AS district, o.address_snapshot->>'region_code' AS region,
             l.name AS stream_name, l.code AS stream_code,
             (SELECT json_agg(json_build_object('product', ol.product_snapshot->'name', 'qty', ol.qty)) FROM order_lines ol WHERE ol.order_id=o.id) AS items,
             (SELECT COALESCE(SUM(a.target_minor),0)::text FROM commission_accruals a WHERE a.order_id=o.id) AS commission_minor
        FROM orders o LEFT JOIN referral_links l ON l.id::text = o.attribution->>'link_id'
       WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { counts: { ...tally, ...extra }, items: rows.map(({ cname, cphone, ...r }) => ({ ...r, customer: maskName(cname), customer_phone: maskTail(cphone) })) };
  });

  route(app, deps, { method: 'GET', url: '/partner/leaderboard', tags: T, summary: 'Top partners by delivered orders (names masked)', query: z.object({ period: z.enum(['today', 'week', 'month']).default('month') }) },
    async ({ actor, db, query }) => {
      const p = await myPartner(db, actor, false);
      const rows = await many<{ pid: string; display_name: string; delivered: number; total: number; rank: number }>(db, `
        WITH r AS (SELECT o.attributed_partner_id AS pid, COUNT(*) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered, COUNT(*)::int AS total
                     FROM orders o WHERE o.attributed_partner_id IS NOT NULL AND ${periodSql('o.created_at', query.period)} GROUP BY 1)
        SELECT r.pid, pa.display_name, r.delivered, r.total, RANK() OVER (ORDER BY r.delivered DESC, r.total DESC)::int AS rank FROM r JOIN partners pa ON pa.id=r.pid ORDER BY rank LIMIT 50`);
      const mask = (s: string) => { const a = Array.from(s.trim()); return a.length <= 2 ? `${a[0] ?? ''}*` : `${a.slice(0, 2).join('')}${'*'.repeat(Math.min(4, a.length - 2))}`; };
      return {
        period: query.period,
        items: rows.slice(0, 10).map((r) => ({ rank: r.rank, name: r.pid === p.id ? r.display_name : mask(r.display_name), delivered: r.delivered, total: r.total, me: r.pid === p.id })),
        me: rows.find((r) => r.pid === p.id) ? { rank: rows.find((r) => r.pid === p.id)!.rank, delivered: rows.find((r) => r.pid === p.id)!.delivered } : null,
      };
    });
}
