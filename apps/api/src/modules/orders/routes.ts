import { maskPhone } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { can, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { emit } from '../../platform/outbox.js';
import { getPolicy, POLICY } from '../../platform/policies.js';
import { promoteToPending } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { consumeOnDispatch } from '../inventory/service.js';
import { queueNotification } from '../notifications/service.js';
import { cancelOrder, confirmOrder, statusEvent } from './service.js';
import { assertNoPendingAmendment } from './amendments.js';

const QUEUES: Record<string, string> = {
  new: `o.commercial_status='awaiting_confirmation' AND o.assigned_operator_id IS NULL AND o.callback_at IS NULL`,
  awaiting_customer: `o.commercial_status='awaiting_confirmation' AND o.channel='partner_assisted'`,
  callback: `o.commercial_status='awaiting_confirmation' AND o.callback_at IS NOT NULL`,
  awaiting_payment: `o.commercial_status='confirmed' AND o.payment_method='online' AND o.payment_status IN ('unpaid','pending')`,
  ready_to_pick: `o.commercial_status='confirmed' AND o.fulfillment_status IN ('reserved','picking','packed') AND (o.payment_method='cod' OR o.payment_status='paid')`,
  in_delivery: `o.fulfillment_status='shipped'`,
  problem: `(o.problem_reason IS NOT NULL OR o.duplicate_signal OR o.fulfillment_status='failed' OR o.payment_status='reconciliation_required') AND o.commercial_status NOT IN ('cancelled','completed')`,
  returns: `EXISTS (SELECT 1 FROM return_requests r WHERE r.order_id=o.id AND r.status NOT IN ('resolved','rejected'))`,
  closed: `o.commercial_status IN ('cancelled','completed')`,
};

export function registerOrders(app: FastifyInstance, deps: Deps): void {
  const T = ['operator'];

  route(app, deps, { method: 'GET', url: '/ops/queues', tags: T, summary: 'Queue counters' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.read_all');
    const out: Record<string, number> = {};
    for (const [k, w] of Object.entries(QUEUES)) out[k] = (await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM orders o WHERE ${w}`)).n;
    return out;
  });

  route(app, deps, { method: 'GET', url: '/ops/orders', tags: T, summary: 'Orders by queue', query: z.object({ queue: z.enum(Object.keys(QUEUES) as [string, ...string[]]).default('new'), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    async ({ actor, db, query }) => {
      requirePerm(actor, 'orders.read_all');
      const rows = await many(db, `
        SELECT o.id, o.number, o.channel, o.commercial_status, o.confirmation_status, o.payment_status, o.fulfillment_status, o.payment_method, o.payable_minor::text,
               o.customer_phone, o.assigned_operator_id, o.callback_at, o.problem_reason, o.duplicate_signal, o.created_at, o.version,
               EXTRACT(EPOCH FROM now()-o.created_at)::int AS age_seconds, u.display_name AS operator_name,
               o.contact_snapshot->>'name' AS customer_name, o.address_snapshot->>'district' AS district, (o.address_snapshot->>'quick'='true' AND o.address_snapshot->>'house'='-') AS quick_pending,
               (SELECT string_agg((ol.product_snapshot->'name'->>'uz-Latn') || ' × ' || (ol.qty - ol.canceled_qty), ', ') FROM order_lines ol WHERE ol.order_id=o.id AND ol.qty > ol.canceled_qty) AS items_text
          FROM orders o LEFT JOIN users u ON u.id=o.assigned_operator_id WHERE ${QUEUES[query.queue]} ORDER BY o.callback_at NULLS LAST, o.created_at LIMIT $1`, [query.limit]);
      return { items: rows };
    });

  route(app, deps, { method: 'GET', url: '/ops/couriers', tags: T, summary: 'Active couriers for hand-over' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.read_all');
    return { items: await many(db, `SELECT u.id, u.display_name, u.phone_e164 FROM users u JOIN memberships m ON m.user_id=u.id AND m.role_code='courier' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) GROUP BY u.id ORDER BY u.display_name`) };
  });

  route(app, deps, { method: 'GET', url: '/ops/orders/:id', tags: T, summary: 'Order card with timeline', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.read_all');
    const o = await maybeOne<Record<string, unknown>>(db, `SELECT o.*, p.display_name AS partner_name, p.code AS partner_code FROM orders o LEFT JOIN partners p ON p.id=o.attributed_partner_id WHERE o.id=$1`, [params.id]);
    if (!o) throw notFound('ORDER');
    const internal = can(actor, 'catalog.read_internal');
    const lines = await many(db, `SELECT id, product_snapshot, qty, canceled_qty, shipped_qty, delivered_qty, returned_qty, unit_price_minor::text, line_net_minor::text, refunded_product_minor::text ${internal ? ', cost_snapshot_minor::text' : ''} FROM order_lines WHERE order_id=$1`, [params.id]);
    const [timeline, calls, notes, confirmations, shipment, cod] = await Promise.all([
      many(db, `SELECT e.*, u.display_name AS actor_name FROM order_status_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE order_id=$1 ORDER BY id`, [params.id]),
      many(db, `SELECT c.*, u.display_name AS operator_name FROM call_logs c JOIN users u ON u.id=c.operator_id WHERE order_id=$1 ORDER BY id`, [params.id]),
      many(db, `SELECT n.id, n.body, n.internal, n.created_at, u.display_name AS author FROM order_notes n JOIN users u ON u.id=n.author_id WHERE order_id=$1 ORDER BY id`, [params.id]),
      many(db, `SELECT id, method, status, call_outcome, actor_user_id, created_at, consumed_at FROM order_confirmations WHERE order_id=$1 ORDER BY created_at`, [params.id]),
      maybeOne(db, `SELECT * FROM shipments WHERE order_id=$1`, [params.id]),
      maybeOne(db, `SELECT * FROM cod_collections WHERE order_id=$1`, [params.id]),
    ]);
    return { ...o, lines, timeline, calls, notes, confirmations, shipment, cod };
  });

  // Transactional claim: only one operator wins (T048).
  route(app, deps, { method: 'POST', url: '/ops/orders/:id/claim', tags: T, summary: 'Claim order', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const r = await db.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1 AND assigned_operator_id IS NULL RETURNING version`, [params.id, actor.userId]);
    if (!r.rowCount) {
      const cur = await maybeOne<{ assigned_operator_id: string | null }>(db, `SELECT assigned_operator_id FROM orders WHERE id=$1`, [params.id]);
      if (!cur) throw notFound('ORDER');
      if (cur.assigned_operator_id === actor.userId) return { ok: true, already: true };
      throw conflict('ORDER_ALREADY_CLAIMED');
    }
    await audit(db, actor, 'order.claimed', { type: 'order', id: params.id });
    return { ok: true, version: r.rows[0].version };
  });

  route(app, deps, { method: 'POST', url: '/ops/orders/:id/reassign', tags: T, summary: 'Reassign (owner)', params: zIdParam, body: z.object({ operator_id: z.string().uuid().nullable(), reason: z.string().min(3).max(300) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'orders.reassign');
      const r = await db.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1 RETURNING id`, [params.id, body.operator_id]);
      if (!r.rowCount) throw notFound('ORDER');
      await audit(db, actor, 'order.reassigned', { type: 'order', id: params.id }, { after: { operator_id: body.operator_id }, reason: body.reason });
      return { ok: true };
    });

  // Structured call result; 'confirmed' is an independent operator confirmation with evidence (T045).
  route(app, deps, { method: 'POST', url: '/ops/orders/:id/calls', tags: T, summary: 'Log call result (confirmed|no_answer|rejected|wrong_data|call_later)', params: zIdParam,
    body: z.object({ outcome: z.enum(['confirmed', 'no_answer', 'rejected', 'wrong_data', 'call_later']), note: z.string().max(1000).optional(), callback_at: z.string().datetime().optional(), confirmed_total_minor: z.string().regex(/^\d+$/).optional() }) },
  async ({ actor, db, cfg, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ assigned_operator_id: string | null; payable_minor: string; commercial_status: string; quick_pending: boolean }>(tx,
        `SELECT assigned_operator_id, payable_minor, commercial_status, (address_snapshot->>'quick'='true' AND address_snapshot->>'house'='-') AS quick_pending FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.assigned_operator_id !== actor.userId && !can(actor, 'orders.reassign')) throw forbidden();
      await tx.query(`INSERT INTO call_logs (order_id, operator_id, outcome, note, callback_at) VALUES ($1,$2,$3,$4,$5)`, [params.id, actor.userId, body.outcome, body.note ?? null, body.callback_at ?? null]);
      if (body.outcome === 'confirmed') {
        // The operator must read back the exact total; mismatch means the customer agreed to something else (AC-M39-2).
        if (body.confirmed_total_minor !== o.payable_minor) throw unprocessable('CONFIRMED_TOTAL_MISMATCH', { payable_minor: o.payable_minor });
        // Quick orders carry no street/house yet: the operator must record the address before confirming.
        if (o.quick_pending) throw unprocessable('ADDRESS_REQUIRED');
        await tx.query(`INSERT INTO order_confirmations (order_id, method, status, actor_user_id, call_outcome, shown_total_minor, note) VALUES ($1,'operator_call','verified',$2,'confirmed',$3,$4)`, [params.id, actor.userId, o.payable_minor, body.note ?? null]);
        await confirmOrder(tx, cfg, actor, params.id, 'operator_call', { operator_id: actor.userId });
        await tx.query(`UPDATE orders SET callback_at=NULL WHERE id=$1`, [params.id]);
      } else if (body.outcome === 'rejected') {
        await tx.query(`INSERT INTO order_confirmations (order_id, method, status, actor_user_id, call_outcome, note) VALUES ($1,'operator_call','rejected',$2,'rejected',$3)`, [params.id, actor.userId, body.note ?? null]);
        await cancelOrder(tx, actor, params.id, 'customer_rejected_by_phone', true);
      } else if (body.outcome === 'call_later' || body.outcome === 'no_answer') {
        await tx.query(`UPDATE orders SET callback_at=COALESCE($2::timestamptz, now() + interval '2 hours') WHERE id=$1`, [params.id, body.callback_at ?? null]);
      } else {
        await tx.query(`UPDATE orders SET problem_reason='wrong_data' WHERE id=$1`, [params.id]);
      }
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/ops/orders/:id/notes', tags: T, summary: 'Internal note', params: zIdParam, body: z.object({ body: z.string().min(1).max(2000) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    await one(db, `INSERT INTO order_notes (order_id, author_id, body, internal) SELECT id, $2, $3, true FROM orders WHERE id=$1 RETURNING id`, [params.id, actor.userId, body.body]).catch(() => { throw notFound('ORDER'); });
    return { ok: true };
  });

  // Address edit with optimistic revision (T049). Content/total changes after confirmation are not allowed here (T050).
  route(app, deps, { method: 'PATCH', url: '/ops/orders/:id/address', tags: T, summary: 'Edit delivery address (expected_version)', params: zIdParam,
    body: z.object({ expected_version: z.number().int(), address: z.record(z.string(), z.string().max(300)), reason: z.string().min(3).max(300) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ version: number; fulfillment_status: string; address_snapshot: Record<string, unknown> }>(tx, `SELECT version, fulfillment_status, address_snapshot FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: o.version });
      if (['shipped', 'delivered', 'returned'].includes(o.fulfillment_status)) throw conflict('ORDER_ALREADY_SHIPPED');
      const r = await one(tx, `UPDATE orders SET address_snapshot = address_snapshot || $2::jsonb, version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, [params.id, JSON.stringify(body.address)]);
      await audit(tx, actor, 'order.address_changed', { type: 'order', id: params.id }, { before: o.address_snapshot, after: body.address, reason: body.reason });
      return r;
    });
  });

  route(app, deps, { method: 'POST', url: '/ops/orders/:id/cancel', tags: T, summary: 'Cancel (reason required)', params: zIdParam, body: z.object({ reason: z.enum(['customer_request', 'out_of_stock', 'duplicate', 'fraud_suspected', 'no_contact', 'other']), note: z.string().max(500).optional() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'orders.operate');
      await withTx(db, (tx) => cancelOrder(tx, actor, params.id, body.reason + (body.note ? `: ${body.note}` : '')));
      return { ok: true };
    });

  // ---------- Warehouse & delivery (§15, §16) ----------
  const fulfil = (to: 'picking' | 'packed', from: string[]) => async ({ actor, db, params }: { actor: import('../../platform/auth.js').Actor; db: import('../../platform/db.js').Db; params: { id: string } }) => {
    requirePerm(actor, 'fulfillment.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ fulfillment_status: string; commercial_status: string; payment_method: string; payment_status: string }>(tx, `SELECT fulfillment_status, commercial_status, payment_method, payment_status FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.fulfillment_status === to) return { ok: true, noop: true };
      if (o.commercial_status !== 'confirmed' || !from.includes(o.fulfillment_status)) throw conflict('INVALID_FULFILLMENT_TRANSITION', { from: o.fulfillment_status, to });
      if (o.payment_method === 'online' && o.payment_status !== 'paid') throw conflict('ONLINE_PAYMENT_NOT_CONFIRMED');
      await assertNoPendingAmendment(tx, params.id);
      await tx.query(`INSERT INTO shipments (order_id, status) VALUES ($1,$2) ON CONFLICT (order_id) DO UPDATE SET status=$2, version=shipments.version+1, updated_at=now()`, [params.id, to]);
      await tx.query(`UPDATE orders SET fulfillment_status=$2, version=version+1, updated_at=now() WHERE id=$1`, [params.id, to]);
      await statusEvent(tx, params.id, 'fulfillment', o.fulfillment_status, to, actor, null);
      return { ok: true };
    });
  };
  route(app, deps, { method: 'POST', url: '/ops/orders/:id/pick', tags: ['warehouse'], summary: 'Start picking', params: zIdParam }, (c) => fulfil('picking', ['reserved'])(c));
  route(app, deps, { method: 'POST', url: '/ops/orders/:id/pack', tags: ['warehouse'], summary: 'Packed', params: zIdParam }, (c) => fulfil('packed', ['picking'])(c));

  route(app, deps, { method: 'POST', url: '/ops/orders/:id/ship', tags: ['warehouse'], summary: 'Hand over to courier: consumes reservation, stock out', params: zIdParam,
    body: z.object({ courier_user_id: z.string().uuid(), tracking_id: z.string().max(80).optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'fulfillment.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ fulfillment_status: string; commercial_status: string }>(tx, `SELECT fulfillment_status, commercial_status FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.fulfillment_status === 'shipped') return { ok: true, noop: true };
      if (o.fulfillment_status !== 'packed' || o.commercial_status !== 'confirmed') throw conflict('INVALID_FULFILLMENT_TRANSITION', { from: o.fulfillment_status, to: 'shipped' });
      const courier = await maybeOne(tx, `SELECT 1 FROM memberships WHERE user_id=$1 AND role_code IN ('courier','warehouse') AND revoked_at IS NULL`, [body.courier_user_id]);
      if (!courier) throw unprocessable('COURIER_UNKNOWN');
      await consumeOnDispatch(tx, params.id, actor.userId);
      await tx.query(`UPDATE order_lines SET shipped_qty = qty - canceled_qty WHERE order_id=$1`, [params.id]);
      await tx.query(`UPDATE shipments SET status='shipped', courier_user_id=$2, tracking_id=$3, handed_over_at=now(), version=version+1, updated_at=now() WHERE order_id=$1`, [params.id, body.courier_user_id, body.tracking_id ?? null]);
      await tx.query(`UPDATE orders SET fulfillment_status='shipped', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
      await statusEvent(tx, params.id, 'fulfillment', 'packed', 'shipped', actor, null);
      await emit(tx, { type: 'ShipmentHandedOver', aggregateType: 'order', aggregateId: params.id, payload: { courier_user_id: body.courier_user_id } });
      return { ok: true };
    });
  });

  // Courier sees only assigned shipments with minimal contact data (§16).
  route(app, deps, { method: 'GET', url: '/courier/tasks', tags: ['courier'], summary: 'My assigned shipments' }, async ({ actor, db }) => {
    requirePerm(actor, 'courier.self');
    return { items: await many(db, `SELECT o.id, o.number, o.payment_method, CASE WHEN o.payment_method='cod' THEN o.payable_minor::text END AS cod_amount_minor, o.address_snapshot, o.contact_snapshot->>'name' AS recipient, o.contact_snapshot->>'phone' AS phone, s.status, s.tracking_id
        FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.courier_user_id=$1 AND s.status='shipped' ORDER BY s.handed_over_at`, [actor.userId]) };
  });

  route(app, deps, { method: 'POST', url: '/courier/orders/:id/deliver', tags: ['courier'], summary: 'Delivered (+COD collected amount)', params: zIdParam,
    body: z.object({ proof: z.object({ method: z.enum(['otp', 'signature', 'photo', 'handover_note']), value: z.string().max(500) }), cod_collected_minor: z.string().regex(/^\d+$/).optional() }) },
  async ({ actor, db, cfg, params, body }) => {
    return withTx(db, async (tx) => {
      const s = await maybeOne<{ courier_user_id: string; status: string }>(tx, `SELECT courier_user_id, status FROM shipments WHERE order_id=$1 FOR UPDATE`, [params.id]);
      if (!s) throw notFound('ORDER');
      if (s.courier_user_id !== actor.userId && !can(actor, 'fulfillment.operate')) throw notFound('ORDER');
      if (s.status === 'delivered') return { ok: true, noop: true };
      if (s.status !== 'shipped') throw conflict('INVALID_FULFILLMENT_TRANSITION');
      const o = await one<{ payment_method: string; payable_minor: string }>(tx, `SELECT payment_method, payable_minor FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      await tx.query(`UPDATE shipments SET status='delivered', delivered_at=now(), proof=$2, version=version+1, updated_at=now() WHERE order_id=$1`, [params.id, JSON.stringify(body.proof)]);
      await tx.query(`UPDATE order_lines SET delivered_qty = shipped_qty WHERE order_id=$1`, [params.id]);
      await tx.query(`UPDATE orders SET fulfillment_status='delivered', delivered_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
      await statusEvent(tx, params.id, 'fulfillment', 'shipped', 'delivered', actor, body.proof.method);
      if (o.payment_method === 'cod') {
        // Delivered != paid: COD money is only "with courier" until remitted and reconciled (T057).
        const collected = body.cod_collected_minor ?? o.payable_minor;
        await tx.query(`INSERT INTO cod_collections (order_id, courier_user_id, expected_minor, collected_minor) VALUES ($1,$2,$3,$4) ON CONFLICT (order_id) DO NOTHING`, [params.id, s.courier_user_id, o.payable_minor, collected]);
        await tx.query(`UPDATE orders SET payment_status='pending' WHERE id=$1 AND payment_status='unpaid'`, [params.id]);
        await postJournal(tx, `cod_collected:${params.id}`, 'cod_collected', [{ account: 'courier_cash', debit: BigInt(collected) }, { account: 'sales_clearing', credit: BigInt(collected) }]);
      } else {
        await tx.query(`UPDATE orders SET commercial_status='completed' WHERE id=$1 AND payment_status='paid'`, [params.id]);
        const hold = await getPolicy<{ days: number }>(tx, POLICY.commissionHoldDays, cfg.env);
        await promoteToPending(tx, params.id, hold?.value.days ?? null);
      }
      await emit(tx, { type: 'ShipmentDelivered', aggregateType: 'order', aggregateId: params.id, payload: {} });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/courier/orders/:id/fail', tags: ['courier'], summary: 'Failed delivery attempt', params: zIdParam, body: z.object({ reason: z.string().min(3).max(300), return_to_warehouse: z.boolean().default(false) }) },
    async ({ actor, db, params, body }) =>
      withTx(db, async (tx) => {
        const s = await maybeOne<{ courier_user_id: string; status: string }>(tx, `SELECT courier_user_id, status FROM shipments WHERE order_id=$1 FOR UPDATE`, [params.id]);
        if (!s || (s.courier_user_id !== actor.userId && !can(actor, 'fulfillment.operate'))) throw notFound('ORDER');
        if (s.status !== 'shipped') throw conflict('INVALID_FULFILLMENT_TRANSITION');
        await tx.query(`UPDATE shipments SET failed_attempts=failed_attempts+1, last_failure_reason=$2, status=CASE WHEN $3 THEN 'failed' ELSE status END, updated_at=now() WHERE order_id=$1`, [params.id, body.reason, body.return_to_warehouse]);
        if (body.return_to_warehouse) {
          await tx.query(`UPDATE orders SET fulfillment_status='failed', problem_reason='delivery_failed', version=version+1 WHERE id=$1`, [params.id]);
          await statusEvent(tx, params.id, 'fulfillment', 'shipped', 'failed', actor, body.reason);
        }
        return { ok: true };
      }));

  // ---------- COD remittance & finance reconciliation (§16, T058) ----------
  route(app, deps, { method: 'POST', url: '/courier/remittances', tags: ['courier'], summary: 'Courier hands cash to shop', body: z.object({ order_ids: z.array(z.string().uuid()).min(1).max(200), declared_minor: z.string().regex(/^\d+$/) }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'courier.self');
      return withTx(db, async (tx) => {
        const rows = await many<{ id: string; collected_minor: string }>(tx, `SELECT id, collected_minor FROM cod_collections WHERE order_id = ANY($1::uuid[]) AND courier_user_id=$2 AND status='with_courier' FOR UPDATE`, [body.order_ids, actor.userId]);
        if (rows.length !== body.order_ids.length) throw unprocessable('COD_COLLECTIONS_NOT_ELIGIBLE');
        const expected = rows.reduce((a, r) => a + BigInt(r.collected_minor), 0n);
        const rem = await one<{ id: string }>(tx, `INSERT INTO cod_remittances (courier_user_id, declared_minor, expected_minor, status) VALUES ($1,$2,$3,'submitted') RETURNING id`, [actor.userId, body.declared_minor, expected.toString()]);
        await tx.query(`UPDATE cod_collections SET status='remitted', remittance_id=$2 WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), rem.id]);
        return { remittance_id: rem.id, expected: expected.toString() };
      });
    });

  route(app, deps, { method: 'POST', url: '/finance/remittances/:id/confirm', tags: ['finance'], summary: 'Finance confirms received cash; discrepancy goes to finance queue', params: zIdParam, body: z.object({ received_minor: z.string().regex(/^\d+$/), note: z.string().max(500).optional() }) },
    async ({ actor, db, cfg, params, body }) => {
      requirePerm(actor, 'cod.confirm'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const r = await maybeOne<{ id: string; status: string; courier_user_id: string; expected_minor: string }>(tx, `SELECT * FROM cod_remittances WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!r) throw notFound('REMITTANCE');
        if (r.status !== 'submitted') return { ok: true, noop: true };
        if (r.courier_user_id === actor.userId) throw forbidden(); // no self-confirmation
        const received = BigInt(body.received_minor);
        const expected = BigInt(r.expected_minor);
        const ok = received === expected;
        await tx.query(`UPDATE cod_remittances SET received_minor=$2, status=$3, confirmed_by=$4, confirmed_at=now(), note=$5 WHERE id=$1`, [params.id, body.received_minor, ok ? 'reconciled' : 'discrepancy', actor.userId, body.note ?? null]);
        const credit = received < expected ? received : expected;
        await postJournal(tx, `cod_remitted:${params.id}`, 'cod_remitted', [
          { account: 'cash_bank', debit: received },
          { account: 'courier_cash', credit },
          ...(received > expected ? [{ account: 'suspense', credit: received - expected }] : []),
        ]);
        if (!ok) {
          // Never "approximately" reconciled: the difference is an open finance exception (T058).
          await tx.query(`INSERT INTO finance_exceptions (kind, ref_type, ref_id, amount_minor, details) VALUES ('cod_discrepancy','cod_remittance',$1,$2,$3) ON CONFLICT DO NOTHING`,
            [params.id, (received - expected).toString(), JSON.stringify({ expected: expected.toString(), received: received.toString(), courier_user_id: r.courier_user_id })]);
          await tx.query(`UPDATE cod_collections SET status='discrepancy' WHERE remittance_id=$1`, [params.id]);
          await audit(tx, actor, 'cod.discrepancy', { type: 'cod_remittance', id: params.id }, { after: { expected: expected.toString(), received: received.toString() } });
          return { ok: true, status: 'discrepancy' };
        }
        const orders = await many<{ order_id: string }>(tx, `UPDATE cod_collections SET status='reconciled' WHERE remittance_id=$1 RETURNING order_id`, [params.id]);
        const hold = await getPolicy<{ days: number }>(tx, POLICY.commissionHoldDays, cfg.env);
        for (const { order_id } of orders) {
          await tx.query(`UPDATE payment_intents SET captured_minor = amount_minor, status='succeeded', version=version+1, updated_at=now() WHERE order_id=$1 AND status <> 'succeeded'`, [order_id]);
          await tx.query(`UPDATE orders SET payment_status='paid', paid_at=now(), commercial_status = CASE WHEN fulfillment_status='delivered' THEN 'completed' ELSE commercial_status END, version=version+1 WHERE id=$1`, [order_id]);
          await statusEvent(tx, order_id, 'payment', 'pending', 'paid', actor, 'cod_reconciled');
          await promoteToPending(tx, order_id, hold?.value.days ?? null);
          await queueNotification(tx, { userId: null, phone: null, channel: 'in_app', purpose: 'transactional', template: 'payment_settled', locale: 'uz-Latn', params: { order_id }, dedupeKey: `paid:${order_id}` });
        }
        await audit(tx, actor, 'cod.reconciled', { type: 'cod_remittance', id: params.id });
        return { ok: true, status: 'reconciled', orders: orders.length };
      });
    });

  route(app, deps, { method: 'GET', url: '/finance/remittances', tags: ['finance'], summary: 'Remittances list' }, async ({ actor, db }) => {
    requirePerm(actor, 'cod.confirm');
    return { items: await many(db, `SELECT r.*, u.display_name AS courier_name FROM cod_remittances r JOIN users u ON u.id=r.courier_user_id ORDER BY created_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'GET', url: '/finance/exceptions', tags: ['finance'], summary: 'Open finance exceptions' }, async ({ actor, db }) => {
    requirePerm(actor, 'payments.read');
    return { items: await many(db, `SELECT * FROM finance_exceptions ORDER BY status, created_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/finance/exceptions/:id/resolve', tags: ['finance'], summary: 'Resolve with reason (no silent "all good")', params: zIdParam, body: z.object({ resolution: z.string().min(10).max(1000) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'cod.confirm');
      const r = await db.query(`UPDATE finance_exceptions SET status='resolved', resolved_by=$2, resolution=$3, resolved_at=now() WHERE id=$1 AND status='open' RETURNING id`, [params.id, actor.userId, body.resolution]);
      if (!r.rowCount) throw notFound('EXCEPTION');
      await audit(db, actor, 'finance_exception.resolved', { type: 'finance_exception', id: params.id }, { reason: body.resolution });
      return { ok: true };
    });

  void maskPhone;
}
