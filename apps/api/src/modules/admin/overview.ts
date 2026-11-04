import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../../platform/auth.js';
import { many, maybeOne } from '../../platform/db.js';
import { forbidden, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
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
    query: z.object({ status: z.enum(['all', ...BUCKETS]).default('all'), period: zPeriod, q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
      partner_id: z.string().uuid().optional(), operator_id: z.string().uuid().optional() }),
  }, async ({ actor, db, query }) => {
    requirePerm(actor, 'orders.read_all');
    const base = [periodSql('o.created_at', query.period)];
    const params: unknown[] = [];
    // Supervisor drill-down: one partner's or one operator's orders (operator = assigned or ever called).
    if (query.partner_id) { params.push(query.partner_id); base.push(`o.attributed_partner_id=$${params.length}`); }
    if (query.operator_id) { params.push(query.operator_id); base.push(`(o.assigned_operator_id=$${params.length} OR EXISTS (SELECT 1 FROM call_logs cl WHERE cl.order_id=o.id AND cl.operator_id=$${params.length}))`); }
    if (query.q) {
      params.push(`%${query.q}%`);
      const n = params.length;
      base.push(`(o.number ILIKE $${n} OR o.customer_phone ILIKE $${n} OR o.contact_snapshot->>'name' ILIKE $${n} OR EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id=o.id AND ol.product_snapshot::text ILIKE $${n}))`);
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

  /** "Who sells my products": every partner with traffic, orders by status, sales value and commission for the period. */
  route(app, deps, {
    method: 'GET', url: '/admin/partners/performance', tags: T, summary: 'Partner leaderboard: clicks, orders by status, delivered sales, commission, balances, top products',
    query: z.object({ period: zPeriod, q: z.string().max(80).optional(), id: z.string().uuid().optional() }),
  }, async ({ actor, db, query }) => {
    if (!can(actor, 'partners.manage') && !can(actor, 'reports.read')) throw forbidden();
    const params: unknown[] = [];
    let filter = '';
    if (query.q) { params.push(`%${query.q}%`); filter = `WHERE (pa.display_name ILIKE $1 OR pa.code ILIKE $1)`; }
    else if (query.id) { params.push(query.id); filter = `WHERE pa.id=$1`; }
    const per = periodSql('o.created_at', query.period);
    const rows = await many(db, `
      WITH ord AS (
        SELECT o.attributed_partner_id AS pid, ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n, SUM(o.payable_minor) AS value
          FROM orders o WHERE o.attributed_partner_id IS NOT NULL AND ${per} GROUP BY 1, 2),
      clk AS (SELECT t.partner_id AS pid, COUNT(*)::int AS n FROM referral_touches t WHERE t.eligible AND ${periodSql('t.touched_at', query.period)} GROUP BY 1),
      com AS (SELECT o.attributed_partner_id AS pid, SUM(a.target_minor) FILTER (WHERE a.state IN ('estimated','pending')) AS pending, SUM(a.target_minor) FILTER (WHERE a.state='available') AS earned
                FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE ${per} GROUP BY 1),
      top AS (
        SELECT pid, json_agg(json_build_object('product_id', product_id, 'name', name, 'orders', n) ORDER BY n DESC) FILTER (WHERE rn <= 3) AS products FROM (
          SELECT o.attributed_partner_id AS pid, p.id AS product_id, p.name, COUNT(DISTINCT o.id)::int AS n,
                 ROW_NUMBER() OVER (PARTITION BY o.attributed_partner_id ORDER BY COUNT(DISTINCT o.id) DESC) AS rn
            FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus s ON s.id=ol.sku_id JOIN products p ON p.id=s.product_id
           WHERE o.attributed_partner_id IS NOT NULL AND ${per} GROUP BY 1, 2, 3) x GROUP BY pid)
      SELECT pa.id, pa.code, pa.display_name, pa.status, pa.created_at,
             pa.payout_destination->>'masked' AS destination, pa.payout_destination_verified_at,
             b.available_minor::text, b.pending_minor::text, b.paid_minor::text, b.debt_minor::text,
             (SELECT COUNT(*)::int FROM referral_links l WHERE l.partner_id=pa.id AND l.status='active') AS streams,
             COALESCE(clk.n, 0) AS clicks,
             (SELECT json_object_agg(bucket, json_build_object('n', n, 'value', value::text)) FROM ord WHERE ord.pid=pa.id) AS by_status,
             COALESCE(com.pending, 0)::text AS commission_pending_minor, COALESCE(com.earned, 0)::text AS commission_earned_minor,
             top.products AS top_products
        FROM partners pa LEFT JOIN partner_balances b ON b.partner_id=pa.id LEFT JOIN clk ON clk.pid=pa.id LEFT JOIN com ON com.pid=pa.id LEFT JOIN top ON top.pid=pa.id
        ${filter}`, params);
    const items = rows.map((r) => {
      const bs = (r.by_status as Record<string, { n: number; value: string }> | null) ?? {};
      const orders = Object.fromEntries(BUCKETS.map((k) => [k, bs[k]?.n ?? 0])) as Record<string, number>;
      const total = Object.values(orders).reduce((a, b) => a + b, 0);
      const finished = orders.delivered! + orders.returned! + orders.cancelled!;
      return { ...r, clicks: Number(r.clicks), by_status: undefined, orders: { ...orders, total } as Record<string, number>, delivered_sales_minor: bs.delivered?.value ?? '0',
        delivery_rate_pct: finished ? Math.round((orders.delivered! / finished) * 100) : null,
        conversion_pct: Number(r.clicks) ? Math.round((total / Number(r.clicks)) * 1000) / 10 : null };
    }).sort((a, b) => b.orders.delivered! - a.orders.delivered! || b.orders.total! - a.orders.total! || b.clicks - a.clicks);
    return { period: query.period, items: items.map((x, i) => ({ rank: i + 1, ...x })) };
  });

  /** One partner's products: what they sell, how much got delivered (supervisor watch page). */
  route(app, deps, { method: 'GET', url: '/admin/partners/:id/products', tags: T, summary: 'Products a partner sold in the period: orders, delivered, units', params: zIdParam, query: z.object({ period: zPeriod }) },
    async ({ actor, db, params, query }) => {
      if (!can(actor, 'partners.manage') && !can(actor, 'reports.read')) throw forbidden();
      const rows = await many(db, `
        SELECT p.id, p.name, p.slug, COUNT(DISTINCT o.id)::int AS orders,
               COUNT(DISTINCT o.id) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered,
               COALESCE(SUM(ol.qty - ol.canceled_qty), 0)::int AS units
          FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus s ON s.id=ol.sku_id JOIN products p ON p.id=s.product_id
         WHERE o.attributed_partner_id=$1 AND ${periodSql('o.created_at', query.period)}
         GROUP BY p.id, p.name, p.slug ORDER BY orders DESC, delivered DESC LIMIT 100`, [params.id]);
      return { items: rows };
    });

  /** Operator watch page: when they came to work, how many orders they took, conversion, last actions. */
  route(app, deps, { method: 'GET', url: '/admin/operators/:id/watch', tags: T, summary: 'Supervisor view of one operator: shift, calls, outcomes, conversion, daily trend', params: zIdParam, query: z.object({ period: zPeriod }) },
    async ({ actor, db, params, query }) => {
      if (!can(actor, 'orders.reassign') && !can(actor, 'reports.read')) throw forbidden();
      const u = await maybeOne<Record<string, unknown>>(db, `
        SELECT u.id, u.display_name, u.created_at, coalesce(ss.state, 'off') AS shift, ss.changed_at AS shift_changed_at,
               (SELECT json_agg(m.role_code ORDER BY m.role_code) FROM memberships m WHERE m.user_id=u.id AND m.revoked_at IS NULL) AS roles
          FROM users u LEFT JOIN staff_shifts ss ON ss.user_id=u.id WHERE u.id=$1`, [params.id]);
      if (!u) throw notFound('USER');
      const per = periodSql('c.created_at', query.period);
      const st = await maybeOne<Record<string, number>>(db, `
        SELECT COUNT(*)::int AS calls, COUNT(DISTINCT c.order_id)::int AS orders,
               COUNT(DISTINCT c.order_id) FILTER (WHERE c.outcome='confirmed')::int AS confirmed,
               COUNT(DISTINCT c.order_id) FILTER (WHERE c.outcome='rejected')::int AS rejected,
               COUNT(*) FILTER (WHERE c.outcome='no_answer')::int AS no_answer,
               COUNT(*) FILTER (WHERE c.outcome='call_later')::int AS call_later,
               COUNT(*) FILTER (WHERE c.outcome='wrong_data')::int AS wrong_data,
               MIN(c.created_at) AS first_call, MAX(c.created_at) AS last_call
          FROM call_logs c WHERE c.operator_id=$1 AND ${per}`, [params.id]);
      const delivered = await maybeOne<{ n: number }>(db, `
        SELECT COUNT(DISTINCT o.id)::int AS n FROM orders o JOIN call_logs c ON c.order_id=o.id AND c.operator_id=$1 AND c.outcome='confirmed'
         WHERE ${per} AND ${BUCKET_SQL}='delivered'`, [params.id]);
      const daily = await many(db, `
        SELECT to_char(date_trunc('day', c.created_at AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS calls, COUNT(DISTINCT c.order_id) FILTER (WHERE c.outcome='confirmed')::int AS confirmed,
               MIN(c.created_at) AS first_call
          FROM call_logs c WHERE c.operator_id=$1 AND c.created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1 DESC`, [params.id]);
      const shifts = await many(db, `
        SELECT occurred_at, after->>'state' AS state FROM audit_events
         WHERE action='shift.changed' AND actor_user_id=$1 ORDER BY id DESC LIMIT 12`, [params.id]);
      const s0 = st ?? ({} as Record<string, number>);
      const orders = Number(s0.orders ?? 0);
      return { user: u, period: query.period,
        stats: { ...s0, delivered: delivered?.n ?? 0, conversion_pct: orders ? Math.round((Number(s0.confirmed ?? 0) / orders) * 100) : null },
        daily, shifts };
    });

  route(app, deps, { method: 'GET', url: '/admin/products/:id/sellers', tags: T, summary: 'Which partners sell this product: clicks, orders, delivered qty, commission', params: zIdParam, query: z.object({ period: zPeriod }) },
    async ({ actor, db, params, query }) => {
      if (!can(actor, 'partners.manage') && !can(actor, 'reports.read') && !can(actor, 'catalog.write')) throw forbidden();
      const per = periodSql('o.created_at', query.period);
      const rows = await many(db, `
        WITH ord AS (
          SELECT o.attributed_partner_id AS pid, COUNT(DISTINCT o.id)::int AS orders,
                 COUNT(DISTINCT o.id) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered_orders,
                 SUM(ol.qty - ol.canceled_qty) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered_qty,
                 SUM(ol.qty - ol.canceled_qty)::int AS qty
            FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus s ON s.id=ol.sku_id
           WHERE s.product_id=$1 AND o.attributed_partner_id IS NOT NULL AND ${per} GROUP BY 1),
        clk AS (SELECT l.partner_id AS pid, COUNT(t.*)::int AS n, COUNT(DISTINCT l.id)::int AS streams FROM referral_links l LEFT JOIN referral_touches t ON t.link_id=l.id AND t.eligible AND ${periodSql('t.touched_at', query.period)} WHERE l.product_id=$1 GROUP BY 1),
        com AS (SELECT o.attributed_partner_id AS pid, SUM(a.target_minor) AS amount FROM commission_accruals a JOIN order_lines ol ON ol.id=a.order_line_id JOIN skus s ON s.id=ol.sku_id JOIN orders o ON o.id=a.order_id
                 WHERE s.product_id=$1 AND a.state <> 'reversed' AND ${per} GROUP BY 1)
        SELECT pa.id, pa.code, pa.display_name, pa.status, COALESCE(clk.streams, 0) AS streams, COALESCE(clk.n, 0) AS clicks,
               COALESCE(ord.orders, 0) AS orders, COALESCE(ord.qty, 0) AS qty, COALESCE(ord.delivered_orders, 0) AS delivered_orders, COALESCE(ord.delivered_qty, 0) AS delivered_qty,
               COALESCE(com.amount, 0)::text AS commission_minor
          FROM partners pa LEFT JOIN ord ON ord.pid=pa.id LEFT JOIN clk ON clk.pid=pa.id LEFT JOIN com ON com.pid=pa.id
         WHERE ord.pid IS NOT NULL OR clk.pid IS NOT NULL
         ORDER BY COALESCE(ord.delivered_qty, 0) DESC, COALESCE(ord.orders, 0) DESC, COALESCE(clk.n, 0) DESC`, [params.id]);
      return { items: rows };
    });
}
