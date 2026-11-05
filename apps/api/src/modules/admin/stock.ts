import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '../../platform/auth.js';
import { many } from '../../platform/db.js';
import { forbidden } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';

/**
 * Low-stock alerts: per active SKU — sellable stock now, units sold in the last 30 days (confirmed, not cancelled),
 * and how many days the stock lasts at that pace. A SKU without sales gets no "days" (no invented forecast).
 */
export function registerStockAlerts(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/stock/low', tags: ['admin'], summary: 'SKUs running out: stock, 30-day sales, days of cover',
    query: z.object({ days: z.coerce.number().int().min(1).max(90).default(14), min_units: z.coerce.number().int().min(0).max(100).default(3) }) },
  async ({ actor, db, query }) => {
    if (!can(actor, 'catalog.write') && !can(actor, 'reports.read')) throw forbidden();
    const rows = await many<any>(db, `
      WITH sold AS (
        SELECT ol.sku_id, SUM(ol.qty - ol.canceled_qty)::int AS units
          FROM order_lines ol JOIN orders o ON o.id=ol.order_id
         WHERE o.created_at > now() - interval '30 days' AND o.commercial_status <> 'cancelled' AND o.confirmation_status='verified'
         GROUP BY ol.sku_id),
      stock AS (SELECT sku_id, SUM(atp)::int AS atp FROM stock_atp GROUP BY sku_id)
      SELECT s.id AS sku_id, s.sku_code, s.variant, p.id AS product_id, p.slug, p.name,
             COALESCE(st.atp, 0) AS available, COALESCE(sold.units, 0) AS sold_30d,
             CASE WHEN COALESCE(sold.units, 0) > 0 THEN ROUND(COALESCE(st.atp, 0) / (sold.units / 30.0), 1) END AS days_left,
             (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image
        FROM skus s JOIN products p ON p.id=s.product_id
        LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN sold ON sold.sku_id=s.id
       WHERE s.status='active' AND p.status='published'
         AND (COALESCE(st.atp, 0) <= $2
              OR (COALESCE(sold.units, 0) > 0 AND COALESCE(st.atp, 0) / (sold.units / 30.0) <= $1))
       ORDER BY (COALESCE(st.atp, 0) = 0 AND COALESCE(sold.units, 0) > 0) DESC,
                CASE WHEN COALESCE(sold.units, 0) > 0 THEN COALESCE(st.atp, 0) / (sold.units / 30.0) END ASC NULLS LAST,
                COALESCE(st.atp, 0) ASC
       LIMIT 200`, [query.days, query.min_units]);
    const items = rows.map((r) => ({ ...r, days_left: r.days_left === null ? null : Number(r.days_left),
      level: r.available === 0 ? (r.sold_30d > 0 ? 'out_selling' : 'out') : r.days_left !== null && Number(r.days_left) <= 7 ? 'critical' : 'low' }));
    const summary = items.reduce((a: Record<string, number>, r) => { a[r.level] = (a[r.level] ?? 0) + 1; return a; }, {});
    return { days: query.days, min_units: query.min_units, summary, items, note: 'Kunlar oxirgi 30 kunlik tasdiqlangan sotuv tezligi bo‘yicha. Sotuv bo‘lmagan mahsulotga prognoz qilinmaydi.' };
  });
}
