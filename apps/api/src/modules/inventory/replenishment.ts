import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { can, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { ownerOrgId } from '../catalog/routes.js';
import { moveStock } from './service.js';

/**
 * Replenishment: deterministic suggestion (cover TARGET_DAYS of the last 30 days' confirmed sales minus available),
 * purchase draft → owner approval (step-up) → ordered → receipts. Receipts are idempotent per reference and are the
 * only thing that adds stock. Costs stay in the admin scope.
 */
const TARGET_DAYS_DEFAULT = 30;
const zLine = z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(100000), unit_cost_minor: z.string().regex(/^\d{1,13}$/).optional() });

async function po(db: Parameters<typeof many>[0], id: string) {
  const h = await maybeOne<any>(db, `SELECT p.*, s.name AS supplier, (SELECT display_name FROM users WHERE id=p.approved_by) AS approved_by_name FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1`, [id]);
  if (!h) throw notFound('PURCHASE_ORDER');
  const lines = await many(db, `SELECT l.id, l.sku_id, sk.sku_code, pr.name, l.qty_ordered, l.qty_received, l.unit_cost_minor::text FROM purchase_order_lines l JOIN skus sk ON sk.id=l.sku_id JOIN products pr ON pr.id=sk.product_id WHERE l.po_id=$1 ORDER BY sk.sku_code`, [id]);
  return { ...h, lines };
}

export function registerReplenishment(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/replenishment/suggestions', tags: ['inventory'], summary: 'Deterministic reorder suggestions (no AI forecast)',
    query: z.object({ target_days: z.coerce.number().int().min(7).max(120).default(TARGET_DAYS_DEFAULT) }) },
  async ({ actor, db, query }) => {
    if (!can(actor, 'inventory.write') && !can(actor, 'reports.read')) throw forbidden();
    const rows = await many<any>(db, `
      WITH sold AS (SELECT ol.sku_id, SUM(ol.qty - ol.canceled_qty)::int AS units FROM order_lines ol JOIN orders o ON o.id=ol.order_id
                     WHERE o.created_at > now() - interval '30 days' AND o.commercial_status <> 'cancelled' AND o.confirmation_status='verified' GROUP BY ol.sku_id),
           stock AS (SELECT sku_id, SUM(atp)::int AS atp FROM stock_atp GROUP BY sku_id),
           open_po AS (SELECT l.sku_id, SUM(l.qty_ordered - l.qty_received)::int AS incoming FROM purchase_order_lines l JOIN purchase_orders p ON p.id=l.po_id
                        WHERE p.status IN ('draft','approved','ordered','partially_received') GROUP BY l.sku_id)
      SELECT s.id AS sku_id, s.sku_code, p.name, COALESCE(st.atp,0) AS available, COALESCE(sold.units,0) AS sold_30d, COALESCE(op.incoming,0) AS incoming, s.cost_minor::text AS last_cost_minor,
             GREATEST(0, CEIL(COALESCE(sold.units,0)::numeric * $1 / 30) - COALESCE(st.atp,0) - COALESCE(op.incoming,0))::int AS suggest
        FROM skus s JOIN products p ON p.id=s.product_id AND p.status='published' LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN sold ON sold.sku_id=s.id LEFT JOIN open_po op ON op.sku_id=s.id
       WHERE s.status='active' AND COALESCE(sold.units,0) > 0
         AND GREATEST(0, CEIL(COALESCE(sold.units,0)::numeric * $1 / 30) - COALESCE(st.atp,0) - COALESCE(op.incoming,0)) > 0
       ORDER BY COALESCE(st.atp,0) = 0 DESC, (COALESCE(st.atp,0) / (sold.units / 30.0)) ASC LIMIT 100`, [query.target_days]);
    return { target_days: query.target_days, items: rows, method: `Taklif = oxirgi 30 kunlik tasdiqlangan sotuv bo‘yicha ${query.target_days} kunlik ehtiyoj − hozirgi sotish mumkin bo‘lgan qoldiq − ochiq xarid buyurtmalaridagi kutilayotgan tovar. Bu prognoz emas; buyurtmani inson tasdiqlaydi.` };
  });

  route(app, deps, { method: 'GET', url: '/admin/suppliers', tags: ['inventory'], summary: 'Suppliers' }, async ({ actor, db }) => {
    requirePerm(actor, 'inventory.write');
    return { items: await many(db, `SELECT id, name, phone, lead_days, note FROM suppliers ORDER BY name`) };
  });
  route(app, deps, { method: 'POST', url: '/admin/suppliers', tags: ['inventory'], summary: 'Add a supplier', body: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().max(32).optional(), lead_days: z.number().int().min(0).max(365).optional(), note: z.string().max(500).optional() }).strict() },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'inventory.write');
      return one(db, `INSERT INTO suppliers (name, phone, lead_days, note) VALUES ($1,$2,$3,$4) RETURNING id, name`, [body.name, body.phone ?? null, body.lead_days ?? null, body.note ?? null]);
    });

  route(app, deps, { method: 'GET', url: '/admin/purchase-orders', tags: ['inventory'], summary: 'Purchase orders' }, async ({ actor, db }) => {
    requirePerm(actor, 'inventory.write');
    return { items: await many(db, `SELECT p.id, p.number, p.status, p.created_at, p.ordered_at, s.name AS supplier,
        (SELECT COUNT(*)::int FROM purchase_order_lines WHERE po_id=p.id) AS lines, (SELECT COALESCE(SUM(qty_ordered),0)::int FROM purchase_order_lines WHERE po_id=p.id) AS units,
        (SELECT COALESCE(SUM(qty_received),0)::int FROM purchase_order_lines WHERE po_id=p.id) AS received
      FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.created_at DESC LIMIT 100`) };
  });
  route(app, deps, { method: 'GET', url: '/admin/purchase-orders/:id', tags: ['inventory'], summary: 'Purchase order detail', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'inventory.write');
    return po(db, params.id);
  });

  route(app, deps, { method: 'POST', url: '/admin/purchase-orders', tags: ['inventory'], summary: 'Create a purchase draft',
    body: z.object({ supplier_id: z.string().uuid().optional(), note: z.string().max(500).optional(), lines: z.array(zLine).min(1).max(200) }).strict() },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'inventory.write');
    const ids = body.lines.map((l) => l.sku_id);
    if (new Set(ids).size !== ids.length) throw unprocessable('DUPLICATE_SKU');
    return withTx(db, async (tx) => {
      const h = await one<{ id: string; number: string }>(tx, `INSERT INTO purchase_orders (supplier_id, note, created_by) VALUES ($1,$2,$3) RETURNING id, number`, [body.supplier_id ?? null, body.note ?? null, actor.userId]);
      for (const l of body.lines) await tx.query(`INSERT INTO purchase_order_lines (po_id, sku_id, qty_ordered, unit_cost_minor) VALUES ($1,$2,$3,$4)`, [h.id, l.sku_id, l.qty, l.unit_cost_minor ?? null]);
      await audit(tx, actor, 'purchase.drafted', { type: 'purchase_order', id: h.id }, { after: { lines: body.lines.length } });
      return h;
    });
  });

  const transition = (to: 'approved' | 'ordered' | 'cancelled', from: string[]) => async ({ actor, db, params }: any) => {
    requirePerm(actor, 'inventory.write');
    if (to === 'approved') { requirePerm(actor, 'staff.manage'); requireStepUp(actor); } // owner approves the spend
    const r = await maybeOne<{ id: string }>(db, `UPDATE purchase_orders SET status=$2, version=version+1, updated_at=now(),
        approved_by = CASE WHEN $2='approved' THEN $4::uuid ELSE approved_by END, approved_at = CASE WHEN $2='approved' THEN now() ELSE approved_at END,
        ordered_at = CASE WHEN $2='ordered' THEN now() ELSE ordered_at END
      WHERE id=$1 AND status = ANY($3::text[]) RETURNING id`, [params.id, to, from, actor.userId]);
    if (!r) throw conflict('PURCHASE_ORDER_STATE');
    await audit(db, actor, `purchase.${to}`, { type: 'purchase_order', id: params.id });
    return po(db, params.id);
  };
  route(app, deps, { method: 'POST', url: '/admin/purchase-orders/:id/approve', tags: ['inventory'], summary: 'Owner approves the draft (step-up)', params: zIdParam }, transition('approved', ['draft']));
  route(app, deps, { method: 'POST', url: '/admin/purchase-orders/:id/ordered', tags: ['inventory'], summary: 'Mark as sent to the supplier', params: zIdParam }, transition('ordered', ['approved']));
  route(app, deps, { method: 'POST', url: '/admin/purchase-orders/:id/cancel', tags: ['inventory'], summary: 'Cancel before any receipt', params: zIdParam }, transition('cancelled', ['draft', 'approved', 'ordered']));

  route(app, deps, { method: 'POST', url: '/admin/purchase-orders/:id/receive', tags: ['inventory'], summary: 'Record goods actually received (idempotent per reference); adds sellable stock',
    params: zIdParam, body: z.object({ ref: z.string().trim().min(1).max(60), lines: z.array(z.object({ line_id: z.string().uuid(), qty: z.number().int().min(1) })).min(1) }).strict() },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'inventory.write');
    return withTx(db, async (tx) => {
      const h = await maybeOne<{ status: string }>(tx, `SELECT status FROM purchase_orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!h) throw notFound('PURCHASE_ORDER');
      if (!['ordered', 'partially_received'].includes(h.status)) throw conflict('PURCHASE_ORDER_NOT_ORDERED');
      for (const l of body.lines) {
        const line = await maybeOne<{ sku_id: string; left: number }>(tx, `SELECT l.sku_id, (l.qty_ordered - l.qty_received) AS left FROM purchase_order_lines l WHERE l.id=$1 AND l.po_id=$2 FOR UPDATE`, [l.line_id, params.id]);
        if (!line) throw notFound('PURCHASE_ORDER_LINE');
        // Same receipt reference replayed (double tap / retry) → nothing happens a second time.
        if (await maybeOne(tx, `SELECT 1 FROM inventory_movements WHERE ref_type='po_receipt' AND ref_id=$1`, [`${l.line_id}:${body.ref}`])) continue;
        if (l.qty > line.left) throw unprocessable('RECEIVE_EXCEEDS_ORDERED', { line_id: l.line_id });
        const applied = await moveStock(tx, { skuId: line.sku_id, merchantOrgId: await ownerOrgId(tx), kind: 'receipt', bucket: 'on_hand_sellable', qty: l.qty, refType: 'po_receipt', refId: `${l.line_id}:${body.ref}`, actorId: actor.userId, reason: `PO receipt ${body.ref}` });
        if (!applied) continue; // same reference replayed → no second stock movement
        await tx.query(`UPDATE purchase_order_lines SET qty_received = qty_received + $2 WHERE id=$1`, [l.line_id, l.qty]);
      }
      const left = await one<{ n: number }>(tx, `SELECT COALESCE(SUM(qty_ordered - qty_received),0)::int AS n FROM purchase_order_lines WHERE po_id=$1`, [params.id]);
      await tx.query(`UPDATE purchase_orders SET status=$2, version=version+1, updated_at=now() WHERE id=$1`, [params.id, left.n === 0 ? 'received' : 'partially_received']);
      await audit(tx, actor, 'purchase.received', { type: 'purchase_order', id: params.id }, { after: { ref: body.ref } });
      return po(tx, params.id);
    });
  });
}
