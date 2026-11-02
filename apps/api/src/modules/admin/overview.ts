import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../../platform/auth.js';
import { many } from '../../platform/db.js';
import { forbidden } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';
import { BUCKET_SQL, BUCKETS, periodSql } from '../partners/cabinet.js';

const zPeriod = z.enum(['today', 'yesterday', 'week', 'month', 'half_year', 'all']).default('all');

/**
 * Owner/staff overview read models: one place to see every order by status and how much of each product
 * is ordered vs in stock ("qabul qilingan tovarlar"). Staff with orders.read_all already see contacts in the operator queue.
 */
export function registerAdminOverview(app: FastifyInstance, deps: Deps): void {
  const T = ['admin'];

  route(app, deps, {
    method: 'GET', url: '/admin/orders', tags: T, summary: 'All orders by status bucket with customer, address, items, partner',
    query: z.object({ status: z.enum(['all', ...BUCKETS]).default('all'), period: zPeriod, q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  }, async ({ actor, db, query }) => {
    requirePerm(actor, 'orders.read_all');
    const base = [periodSql('o.created_at', query.period)];
    const params: unknown[] = [];
    if (query.q) {
      params.push(`%${query.q}%`);
      base.push(`(o.number ILIKE $1 OR o.customer_phone ILIKE $1 OR o.contact_snapshot->>'name' ILIKE $1 OR EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id=o.id AND ol.product_snapshot::text ILIKE $1))`);
    }
    const counts = await many<{ bucket: string; n: number }>(db, `SELECT ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n FROM orders o WHERE ${base.join(' AND ')} GROUP BY 1`, params);
    const c: Record<string, number> = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const r of counts) c[r.bucket] = r.n;
    const where = [...base];
    const p2 = [...params];
    if (query.status !== 'all') { p2.push(query.status); where.push(`${BUCKET_SQL}=$${p2.length}`); }
    p2.push(query.limit, query.offset);
    const rows = await many(db, `
      SELECT o.id, o.number, o.created_at, o.delivered_at, ${BUCKET_SQL} AS bucket, o.channel, o.payment_method, o.payable_minor::text,
             o.contact_snapshot->>'name' AS customer_name, coalesce(o.customer_phone, o.contact_snapshot->>'phone') AS customer_phone,
             o.address_snapshot, o.callback_at, o.problem_reason, o.cancel_reason,
             pa.code AS partner_code, pa.display_name AS partner_name, l.name AS stream_name, u.display_name AS operator_name,
             (SELECT json_agg(json_build_object('name', ol.product_snapshot->'name', 'variant', ol.product_snapshot->'variant', 'sku', ol.product_snapshot->>'sku_code', 'qty', ol.qty - ol.canceled_qty) ORDER BY ol.id) FROM order_lines ol WHERE ol.order_id=o.id AND ol.qty > ol.canceled_qty) AS items
        FROM orders o LEFT JOIN partners pa ON pa.id=o.attributed_partner_id LEFT JOIN referral_links l ON l.id::text = o.attribution->>'link_id' LEFT JOIN users u ON u.id=o.assigned_operator_id
       WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT $${p2.length - 1} OFFSET $${p2.length}`, p2);
    return { counts: { ...c, total: Object.values(c).reduce((a, b) => a + b, 0) }, items: rows };
  });

  route(app, deps, {
    method: 'GET', url: '/admin/products/flow', tags: T, summary: 'Per product: stock (on hand / reserved / available) vs ordered quantity by order status',
    query: z.object({ period: zPeriod, q: z.string().max(80).optional() }),
  }, async ({ actor, db, query }) => {
    if (!can(actor, 'catalog.write') && !can(actor, 'reports.read') && !can(actor, 'orders.read_all')) throw forbidden();
    const params: unknown[] = [];
    let filter = '';
    if (query.q) { params.push(`%${query.q.toLowerCase()}%`); filter = `AND (p.search_doc LIKE $1 OR lower(p.name::text) LIKE $1)`; }
    const rows = await many(db, `
      WITH ord AS (
        SELECT s.product_id, ${BUCKET_SQL} AS bucket, SUM(ol.qty - ol.canceled_qty)::int AS qty, COUNT(DISTINCT o.id)::int AS orders
          FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN skus s ON s.id=ol.sku_id
         WHERE ${periodSql('o.created_at', query.period)} GROUP BY 1, 2),
      st AS (
        SELECT s.product_id, SUM(sb.on_hand_sellable)::int AS on_hand, SUM(sb.reserved)::int AS reserved,
               SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer))::int AS available
          FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.status='active' GROUP BY 1)
      SELECT p.id, p.slug, p.name, p.status,
             (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
             COALESCE(st.on_hand, 0) AS on_hand, COALESCE(st.reserved, 0) AS reserved, COALESCE(st.available, 0) AS available,
             (SELECT json_object_agg(bucket, json_build_object('qty', qty, 'orders', orders)) FROM ord WHERE ord.product_id=p.id) AS by_status
        FROM products p LEFT JOIN st ON st.product_id=p.id
       WHERE p.status <> 'archived' ${filter}
       ORDER BY (SELECT COALESCE(SUM(qty),0) FROM ord WHERE ord.product_id=p.id) DESC, p.updated_at DESC LIMIT 300`, params);
    return {
      items: rows.map((r) => {
        const b = (r.by_status as Record<string, { qty: number; orders: number }> | null) ?? {};
        const q = (k: string) => b[k]?.qty ?? 0;
        return { ...r, by_status: undefined, ordered: Object.fromEntries(BUCKETS.map((k) => [k, q(k)])), accepted_to_ship: q('accepted'), in_delivery: q('shipping'), delivered: q('delivered'), total_orders: Object.values(b).reduce((a, x) => a + x.orders, 0) };
      }),
    };
  });
}
