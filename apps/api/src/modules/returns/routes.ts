import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { can, requirePerm, requireStepUp, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { idempotent } from '../../platform/idempotency.js';
import { type Deps, requireIdempotencyKey, route, zIdParam } from '../../platform/http.js';
import { emit } from '../../platform/outbox.js';
import { recalcOrder } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { moveStock } from '../inventory/service.js';
import { statusEvent } from '../orders/service.js';

export function registerReturns(app: FastifyInstance, deps: Deps): void {
  const T = ['returns'];

  route(app, deps, { method: 'POST', url: '/returns', tags: T, summary: 'Open return request (customer own order or operator)',
    body: z.object({ order_id: z.string().uuid(), lines: z.array(z.object({ order_line_id: z.string().uuid(), qty: z.number().int().min(1) })).min(1), reason: z.string().min(3).max(1000), desired_resolution: z.enum(['refund', 'exchange', 'repair']) }) },
  async ({ actor, db, body }) => {
    requireUser(actor);
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ user_id: string | null; customer_phone: string; fulfillment_status: string }>(tx, `SELECT user_id, customer_phone, fulfillment_status FROM orders WHERE id=$1 FOR UPDATE`, [body.order_id]);
      if (!o) throw notFound('ORDER');
      if (!can(actor, 'returns.operate')) {
        const u = await one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
        if (o.user_id !== actor.userId && !(o.user_id === null && o.customer_phone === u.phone_e164)) throw notFound('ORDER'); // T005
      }
      if (o.fulfillment_status !== 'delivered') throw unprocessable('RETURN_REQUIRES_DELIVERED_ORDER');
      const r = await one<{ id: string }>(tx, `INSERT INTO return_requests (order_id, opened_by, status, reason, desired_resolution, policy_version) VALUES ($1,$2,'requested',$3,$4,'draft-v1') RETURNING id`, [body.order_id, actor.userId, body.reason, body.desired_resolution]);
      for (const l of body.lines) {
        // Open return quantity per line is bounded by delivered minus already returned/claimed (AC-X31).
        const ok = await maybeOne(tx, `SELECT 1 FROM order_lines ol WHERE ol.id=$1 AND ol.order_id=$2 AND
            ol.delivered_qty - ol.returned_qty - COALESCE((SELECT SUM(rl.qty - rl.received_qty) FROM return_lines rl JOIN return_requests rr ON rr.id=rl.return_id WHERE rl.order_line_id=ol.id AND rr.status NOT IN ('rejected','resolved')),0) >= $3`, [l.order_line_id, body.order_id, l.qty]);
        if (!ok) throw unprocessable('RETURN_QTY_EXCEEDS_DELIVERED', { order_line_id: l.order_line_id });
        await tx.query(`INSERT INTO return_lines (return_id, order_line_id, qty) VALUES ($1,$2,$3)`, [r.id, l.order_line_id, l.qty]);
      }
      await audit(tx, actor, 'return.requested', { type: 'return', id: r.id });
      return { id: r.id, status: 'requested' };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/returns', tags: T, summary: 'Return requests' }, async ({ actor, db }) => {
    requirePerm(actor, 'returns.operate');
    return { items: await many(db, `SELECT r.*, o.number FROM return_requests r JOIN orders o ON o.id=r.order_id ORDER BY r.created_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/ops/returns/:id/decision', tags: T, summary: 'Approve / reject return', params: zIdParam, body: z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().min(3).max(1000) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'returns.operate');
      const r = await db.query(`UPDATE return_requests SET status=$2, decision_note=$3, version=version+1, updated_at=now() WHERE id=$1 AND status IN ('requested','reviewing') RETURNING id`, [params.id, body.decision, body.note]);
      if (!r.rowCount) throw conflict('RETURN_INVALID_TRANSITION');
      await audit(db, actor, `return.${body.decision}`, { type: 'return', id: params.id }, { reason: body.note });
      return { ok: true };
    });

  // Goods physically back: quarantine only — never sellable before inspection (T059, INV17).
  route(app, deps, { method: 'POST', url: '/ops/returns/:id/receive', tags: T, summary: 'Receive returned goods into quarantine', params: zIdParam, body: z.object({ lines: z.array(z.object({ return_line_id: z.string().uuid(), received_qty: z.number().int().min(0) })).min(1) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'returns.inspect');
      return withTx(db, async (tx) => {
        const r = await maybeOne<{ status: string; order_id: string }>(tx, `SELECT status, order_id FROM return_requests WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!r) throw notFound('RETURN');
        if (r.status !== 'approved') throw conflict('RETURN_INVALID_TRANSITION');
        for (const l of body.lines) {
          const rl = await maybeOne<{ order_line_id: string; qty: number; sku_id: string; merchant_org_id: string }>(tx, `SELECT rl.order_line_id, rl.qty, ol.sku_id, ol.merchant_org_id FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id WHERE rl.id=$1 AND rl.return_id=$2`, [l.return_line_id, params.id]);
          if (!rl) throw notFound('RETURN_LINE');
          if (l.received_qty > rl.qty) throw badRequest('RECEIVED_EXCEEDS_REQUESTED');
          await tx.query(`UPDATE return_lines SET received_qty=$2 WHERE id=$1`, [l.return_line_id, l.received_qty]);
          if (l.received_qty > 0) {
            await moveStock(tx, { skuId: rl.sku_id, merchantOrgId: rl.merchant_org_id, kind: 'return_receipt', bucket: 'quarantine', qty: l.received_qty, refType: 'return_line', refId: l.return_line_id, actorId: actor.userId });
            await tx.query(`UPDATE order_lines SET returned_qty = returned_qty + $2 WHERE id=$1`, [rl.order_line_id, l.received_qty]);
          }
        }
        await tx.query(`UPDATE return_requests SET status='received', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
        await recalcOrder(tx, r.order_id, 'goods_returned', actor.userId);
        await audit(tx, actor, 'return.received', { type: 'return', id: params.id }, { after: body.lines });
        return { ok: true };
      });
    });

  route(app, deps, { method: 'POST', url: '/ops/returns/:id/inspect', tags: T, summary: 'Inspection: move quarantine → sellable / damaged', params: zIdParam,
    body: z.object({ lines: z.array(z.object({ return_line_id: z.string().uuid(), sellable_qty: z.number().int().min(0), damaged_qty: z.number().int().min(0) })).min(1) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'returns.inspect');
    return withTx(db, async (tx) => {
      const r = await maybeOne<{ status: string }>(tx, `SELECT status FROM return_requests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('RETURN');
      if (r.status !== 'received') throw conflict('RETURN_INVALID_TRANSITION');
      for (const l of body.lines) {
        const rl = await maybeOne<{ received_qty: number; sku_id: string; merchant_org_id: string }>(tx, `SELECT rl.received_qty, ol.sku_id, ol.merchant_org_id FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id WHERE rl.id=$1 AND rl.return_id=$2`, [l.return_line_id, params.id]);
        if (!rl) throw notFound('RETURN_LINE');
        if (l.sellable_qty + l.damaged_qty !== rl.received_qty) throw badRequest('INSPECTION_QTY_MISMATCH');
        await tx.query(`UPDATE return_lines SET sellable_qty=$2, damaged_qty=$3 WHERE id=$1`, [l.return_line_id, l.sellable_qty, l.damaged_qty]);
        const base = { skuId: rl.sku_id, merchantOrgId: rl.merchant_org_id, refType: 'return_inspection', refId: l.return_line_id, actorId: actor.userId };
        if (l.sellable_qty) {
          await moveStock(tx, { ...base, kind: 'from_quarantine', bucket: 'quarantine', qty: -l.sellable_qty });
          await moveStock(tx, { ...base, kind: 'from_quarantine', bucket: 'on_hand_sellable', qty: l.sellable_qty });
        }
        if (l.damaged_qty) {
          await moveStock(tx, { ...base, kind: 'to_damaged', bucket: 'quarantine', qty: -l.damaged_qty });
          await moveStock(tx, { ...base, kind: 'to_damaged', bucket: 'damaged', qty: l.damaged_qty });
        }
      }
      await tx.query(`UPDATE return_requests SET status='inspected', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
      await audit(tx, actor, 'return.inspected', { type: 'return', id: params.id }, { after: body.lines });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/ops/returns/:id/resolve', tags: T, summary: 'Close return', params: zIdParam, body: z.object({ note: z.string().min(3).max(500) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'returns.operate');
    const r = await db.query(`UPDATE return_requests SET status='resolved', decision_note=COALESCE(decision_note,'') || ' | ' || $2, updated_at=now() WHERE id=$1 AND status IN ('inspected','approved') RETURNING id`, [params.id, body.note]);
    if (!r.rowCount) throw conflict('RETURN_INVALID_TRANSITION');
    return { ok: true };
  });

  // ---------- Refunds: line-level, bounded by captured − refunded − reserved (T068/T069) ----------
  route(app, deps, { method: 'POST', url: '/refunds', tags: T, summary: 'Request refund (line amounts from original allocation, Idempotency-Key)',
    body: z.object({ order_id: z.string().uuid(), return_id: z.string().uuid().optional(), lines: z.array(z.object({ order_line_id: z.string().uuid(), qty: z.number().int().min(0), amount_minor: z.string().regex(/^\d+$/) })).default([]),
      delivery_amount_minor: z.string().regex(/^\d+$/).default('0'), reason: z.string().min(3).max(500), method: z.enum(['provider', 'manual_cash', 'manual_bank']) }) },
  async ({ actor, db, body, idempotencyKey, reply }) => {
    requirePerm(actor, 'refunds.request');
    const key = requireIdempotencyKey(idempotencyKey);
    const res = await withTx(db, (tx) => idempotent(tx, `refund:${actor.userId}`, key, body, async () => {
      const pi = await maybeOne<{ id: string; captured_minor: string; refunded_minor: string; refund_reserved_minor: string }>(tx, `SELECT * FROM payment_intents WHERE order_id=$1 FOR UPDATE`, [body.order_id]);
      if (!pi) throw notFound('PAYMENT');
      let product = 0n;
      for (const l of body.lines) {
        const ol = await maybeOne<{ line_net_minor: string; refunded_product_minor: string }>(tx, `SELECT line_net_minor, refunded_product_minor FROM order_lines WHERE id=$1 AND order_id=$2`, [l.order_line_id, body.order_id]);
        if (!ol) throw notFound('ORDER_LINE');
        if (BigInt(l.amount_minor) > BigInt(ol.line_net_minor) - BigInt(ol.refunded_product_minor)) throw unprocessable('REFUND_EXCEEDS_LINE_REMAINING', { order_line_id: l.order_line_id });
        product += BigInt(l.amount_minor);
      }
      const delivery = BigInt(body.delivery_amount_minor);
      const total = product + delivery;
      if (total <= 0n) throw badRequest('REFUND_AMOUNT_REQUIRED');
      const refundable = BigInt(pi.captured_minor) - BigInt(pi.refunded_minor) - BigInt(pi.refund_reserved_minor);
      if (total > refundable) throw unprocessable('REFUND_EXCEEDS_REFUNDABLE', { refundable_minor: refundable.toString() });
      const r = await one<{ id: string }>(tx, `INSERT INTO refunds (intent_id, order_id, amount_minor, product_amount_minor, delivery_amount_minor, status, reason, idempotency_key, created_by, return_id, method) VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9,$10) RETURNING id`,
        [pi.id, body.order_id, total.toString(), product.toString(), delivery.toString(), body.reason, `${actor.userId}:${key}`, actor.userId, body.return_id ?? null, body.method]);
      for (const l of body.lines) await tx.query(`INSERT INTO refund_lines (refund_id, order_line_id, qty, product_amount_minor) VALUES ($1,$2,$3,$4)`, [r.id, l.order_line_id, l.qty, l.amount_minor]);
      await audit(tx, actor, 'refund.requested', { type: 'refund', id: r.id }, { after: { amount_minor: total.toString() } });
      return { status: 201, body: { refund_id: r.id, status: 'requested' } };
    }));
    reply.status(res.replayed ? 200 : res.status);
    return res.body;
  });

  route(app, deps, { method: 'POST', url: '/refunds/:id/approve', tags: T, summary: 'Approve: reserves refundable amount (requester cannot approve)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'refunds.approve'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const r = await maybeOne<{ status: string; created_by: string; intent_id: string; amount_minor: string }>(tx, `SELECT * FROM refunds WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('REFUND');
      if (r.status !== 'requested') throw conflict('REFUND_INVALID_TRANSITION');
      if (r.created_by === actor.userId) throw new AppError(403, 'MAKER_CANNOT_APPROVE');
      // INV09 enforced by CHECK (refunded + reserved <= captured): parallel approvals cannot over-refund (AC-X20).
      const u = await tx.query(`UPDATE payment_intents SET refund_reserved_minor = refund_reserved_minor + $2, version=version+1 WHERE id=$1 AND refunded_minor + refund_reserved_minor + $2 <= captured_minor RETURNING id`, [r.intent_id, r.amount_minor]);
      if (!u.rowCount) throw unprocessable('REFUND_EXCEEDS_REFUNDABLE');
      await tx.query(`UPDATE refunds SET status='reserved', approved_by=$2, updated_at=now() WHERE id=$1`, [params.id, actor.userId]);
      await audit(tx, actor, 'refund.approved', { type: 'refund', id: params.id });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/refunds/:id/result', tags: T, summary: 'Record refund outcome (succeeded | failed | unknown_result)', params: zIdParam,
    body: z.object({ outcome: z.enum(['succeeded', 'failed', 'unknown_result']), reference: z.string().max(120).optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'refunds.approve'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const r = await maybeOne<{ status: string; intent_id: string; order_id: string; amount_minor: string; product_amount_minor: string; method: string }>(tx, `SELECT * FROM refunds WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('REFUND');
      if (r.status === body.outcome) return { ok: true, noop: true }; // retry never refunds twice (T070)
      if (!['reserved', 'submitted', 'unknown_result'].includes(r.status)) throw conflict('REFUND_INVALID_TRANSITION');
      const amt = BigInt(r.amount_minor);
      if (body.outcome === 'unknown_result') {
        await tx.query(`UPDATE refunds SET status='unknown_result', provider_ref=COALESCE($2, provider_ref), updated_at=now() WHERE id=$1`, [params.id, body.reference ?? null]);
        await tx.query(`INSERT INTO finance_exceptions (kind, ref_type, ref_id, amount_minor) VALUES ('refund_unknown','refund',$1,$2) ON CONFLICT DO NOTHING`, [params.id, r.amount_minor]);
        await tx.query(`UPDATE orders SET payment_status='reconciliation_required' WHERE id=$1`, [r.order_id]);
        return { ok: true };
      }
      if (body.outcome === 'failed') {
        await tx.query(`UPDATE payment_intents SET refund_reserved_minor = refund_reserved_minor - $2 WHERE id=$1`, [r.intent_id, r.amount_minor]);
        await tx.query(`UPDATE refunds SET status='failed', updated_at=now() WHERE id=$1`, [params.id]);
        return { ok: true };
      }
      if (!body.reference) throw badRequest('REFUND_REFERENCE_REQUIRED');
      await tx.query(`UPDATE payment_intents SET refund_reserved_minor = refund_reserved_minor - $2, refunded_minor = refunded_minor + $2, version=version+1 WHERE id=$1`, [r.intent_id, r.amount_minor]);
      await tx.query(`UPDATE refunds SET status='succeeded', provider_ref=$2, updated_at=now() WHERE id=$1`, [params.id, body.reference]);
      const lines = await many<{ order_line_id: string; product_amount_minor: string }>(tx, `SELECT order_line_id, product_amount_minor FROM refund_lines WHERE refund_id=$1`, [params.id]);
      for (const l of lines) await tx.query(`UPDATE order_lines SET refunded_product_minor = refunded_product_minor + $2 WHERE id=$1`, [l.order_line_id, l.product_amount_minor]);
      const pi = await one<{ captured_minor: string; refunded_minor: string }>(tx, `SELECT captured_minor, refunded_minor FROM payment_intents WHERE id=$1`, [r.intent_id]);
      const full = BigInt(pi.refunded_minor) >= BigInt(pi.captured_minor);
      await tx.query(`UPDATE orders SET payment_status=$2, refund_status=$3, version=version+1, updated_at=now() WHERE id=$1`, [r.order_id, full ? 'refunded' : 'partially_refunded', full ? 'full' : 'partial']);
      await statusEvent(tx, r.order_id, 'refund', null, full ? 'refunded' : 'partially_refunded', actor, params.id);
      await postJournal(tx, `refund:${params.id}`, 'refund', [{ account: 'sales_clearing', debit: amt }, { account: r.method === 'provider' ? 'psp_receivable' : 'cash_bank', credit: amt }]);
      await recalcOrder(tx, r.order_id, 'refund_succeeded', actor.userId);
      await emit(tx, { type: 'RefundSucceeded', aggregateType: 'order', aggregateId: r.order_id, payload: { refund_id: params.id, amount_minor: r.amount_minor } });
      return { ok: true };
    });
  });

  void forbidden;
}
