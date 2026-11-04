import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { cancelOrder } from '../orders/service.js';
import { event } from './routes.js';

/**
 * Duplicate review (spec §18, T03): candidates are shown with the evidence (same phone, time gap, shared SKUs, source);
 * the operator decides. "Not a duplicate" clears the signal for good; "duplicate" cancels THIS order with a link to the
 * one we keep — both IDs and histories stay. Two real customers on one phone are never merged automatically.
 */
const T = ['operator-centre'];

export function registerDuplicateReview(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/center/tasks/:id/duplicates', tags: T, summary: 'Possible duplicates of the task order, with evidence', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const t = await maybeOne<{ order_id: string }>(db, `SELECT order_id FROM ops_tasks WHERE id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    const o = await one<any>(db, `SELECT id, number, customer_phone, created_at, duplicate_signal, duplicate_review, duplicate_of FROM orders WHERE id=$1`, [t.order_id]);
    const items = await many(db, `
      SELECT o2.id, o2.number, o2.created_at, o2.commercial_status, o2.fulfillment_status, o2.payment_status, o2.channel, o2.payable_minor::text,
             o2.contact_snapshot->>'name' AS customer_name, o2.address_snapshot->>'district' AS district,
             ROUND(ABS(EXTRACT(EPOCH FROM o2.created_at - $3::timestamptz)) / 60)::int AS minutes_apart,
             (SELECT string_agg(DISTINCT (l.product_snapshot->'name'->>'uz-Latn'), ', ') FROM order_lines l WHERE l.order_id=o2.id
                AND l.sku_id IN (SELECT sku_id FROM order_lines WHERE order_id=$1)) AS shared_items
        FROM orders o2
       WHERE o2.id <> $1 AND o2.customer_phone=$2 AND o2.commercial_status <> 'cancelled'
         AND o2.created_at BETWEEN $3::timestamptz - interval '7 days' AND $3::timestamptz + interval '7 days'
       ORDER BY ABS(EXTRACT(EPOCH FROM o2.created_at - $3::timestamptz)) LIMIT 10`, [o.id, o.customer_phone, o.created_at]);
    return { order: { id: o.id, number: o.number, signal: o.duplicate_signal, review: o.duplicate_review, duplicate_of: o.duplicate_of }, items };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/duplicate-decision', tags: T, summary: 'Decide: not a duplicate, or cancel this order as a duplicate of another', params: zIdParam,
    body: z.object({ decision: z.enum(['not_duplicate', 'duplicate']), keep_order_id: z.string().uuid().optional(), reason: z.string().min(3).max(300) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const t = await maybeOne<{ id: string; order_id: string; state: string }>(tx, `SELECT id, order_id, state FROM ops_tasks WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!t) throw notFound('TASK');
      const o = await one<any>(tx, `SELECT id, customer_phone, duplicate_review FROM orders WHERE id=$1 FOR UPDATE`, [t.order_id]);
      if (o.duplicate_review) throw conflict('DUPLICATE_ALREADY_REVIEWED', { review: o.duplicate_review });
      if (body.decision === 'not_duplicate') {
        await tx.query(`UPDATE orders SET duplicate_signal=false, duplicate_review='not_duplicate', duplicate_reviewed_by=$2, duplicate_reviewed_at=now(), version=version+1 WHERE id=$1`, [o.id, actor.userId]);
        await event(tx, t.id, actor.userId!, 'duplicate_cleared', null, null, { reason: body.reason });
        await audit(tx, actor, 'order.duplicate_cleared', { type: 'order', id: o.id }, { reason: body.reason });
        return { ok: true, decision: 'not_duplicate' };
      }
      if (!body.keep_order_id) throw unprocessable('KEEP_ORDER_REQUIRED');
      const keep = await maybeOne<any>(tx, `SELECT id, customer_phone, commercial_status FROM orders WHERE id=$1`, [body.keep_order_id]);
      if (!keep || keep.id === o.id || keep.customer_phone !== o.customer_phone || keep.commercial_status === 'cancelled') throw unprocessable('KEEP_ORDER_INVALID');
      // cancelOrder refuses paid or shipped orders (refund/return flows instead) and releases the reservation.
      await cancelOrder(tx, actor, o.id, 'duplicate_order');
      await tx.query(`UPDATE orders SET duplicate_of=$2, duplicate_review='duplicate', duplicate_reviewed_by=$3, duplicate_reviewed_at=now() WHERE id=$1`, [o.id, keep.id, actor.userId]);
      await tx.query(`UPDATE ops_tasks SET state='resolved', resolution='duplicate', resolved_at=now(), lease_until=NULL, version=version+1, updated_at=now() WHERE order_id=$1 AND state NOT IN ('resolved','closed')`, [o.id]);
      await event(tx, t.id, actor.userId!, 'duplicate_cancelled', t.state, 'resolved', { keep: keep.id, reason: body.reason });
      await audit(tx, actor, 'order.duplicate_cancelled', { type: 'order', id: o.id }, { after: { duplicate_of: keep.id }, reason: body.reason });
      return { ok: true, decision: 'duplicate', duplicate_of: keep.id };
    });
  });
}
