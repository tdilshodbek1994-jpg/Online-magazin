import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { myPartner } from '../partners/routes.js';
import { event } from './routes.js';

/**
 * Partner → operator requests (spec §08): "change the call time", "I'll complete the address", "variant change",
 * "commission question", "message to the owner". The partner never edits a submitted order directly; the request lands
 * in the operator queue as one partner_request task per order, and the partner sees only the partner-visible answer.
 */
const T = ['operator-centre'];
const KIND_UZ: Record<string, string> = { callback_time: 'Qo‘ng‘iroq vaqtini o‘zgartirish', address: 'Manzilni to‘ldirish', variant_change: 'Variantni almashtirish', commission_question: 'Komissiya savoli', message: 'Mas’ulga xabar' };

export function registerPartnerRequests(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/partner/orders/:id/requests', tags: T, summary: 'Partner: ask the operator about my order', params: zIdParam,
    body: z.object({ kind: z.enum(['callback_time', 'address', 'variant_change', 'commission_question', 'message']), body: z.string().min(3).max(1000), preferred_at: z.string().datetime().optional() }) },
  async ({ actor, db, params, body }) => {
    const p = await myPartner(db, actor, false);
    if (body.kind === 'callback_time' && !body.preferred_at) throw unprocessable('PREFERRED_TIME_REQUIRED');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ id: string; channel: string }>(tx, `SELECT id, channel FROM orders WHERE id=$1 AND attributed_partner_id=$2`, [params.id, p.id]);
      if (!o) throw notFound('ORDER'); // other partners' orders look non-existent
      // Join the open partner_request task of this order, or open one (unique open index keeps it single).
      await tx.query(`INSERT INTO ops_tasks (order_id, type, reason, next_action, source, priority)
        VALUES ($1,'partner_request',$2,'Hamkorga javob berish','partner',1) ON CONFLICT DO NOTHING`, [o.id, `Hamkor so‘rovi: ${KIND_UZ[body.kind]}`]);
      const task = await one<{ id: string; state: string }>(tx, `SELECT id, state FROM ops_tasks WHERE order_id=$1 AND type='partner_request' AND state NOT IN ('resolved','closed') FOR UPDATE`, [o.id]);
      const r = await one<{ id: string }>(tx, `INSERT INTO partner_order_requests (order_id, partner_id, kind, body, preferred_at, task_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [o.id, p.id, body.kind, body.body, body.preferred_at ?? null, task.id]);
      await event(tx, task.id, actor.userId!, 'partner_request', task.state, task.state, { request_id: r.id, kind: body.kind });
      return { id: r.id, status: 'open' };
    });
  });

  route(app, deps, { method: 'GET', url: '/partner/orders/:id/requests', tags: T, summary: 'Partner: my requests on this order with the answers meant for me', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const o = await maybeOne(db, `SELECT 1 FROM orders WHERE id=$1 AND attributed_partner_id=$2`, [params.id, p.id]);
    if (!o) throw notFound('ORDER');
    return { items: await many(db, `SELECT id, kind, body, preferred_at, status, answer, created_at, answered_at FROM partner_order_requests WHERE order_id=$1 AND partner_id=$2 ORDER BY created_at DESC`, [params.id, p.id]) };
  });

  route(app, deps, { method: 'GET', url: '/ops/center/tasks/:id/partner-requests', tags: T, summary: 'Operator: partner requests of the task order', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const t = await maybeOne<{ order_id: string }>(db, `SELECT order_id FROM ops_tasks WHERE id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    return { items: await many(db, `SELECT r.id, r.kind, r.body, r.preferred_at, r.status, r.answer, r.created_at, r.answered_at, p.display_name AS partner_name, p.code AS partner_code
      FROM partner_order_requests r JOIN partners p ON p.id=r.partner_id WHERE r.order_id=$1 ORDER BY r.created_at DESC`, [t.order_id]) };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/partner-requests/:id/answer', tags: T, summary: 'Operator: answer a partner request (the partner sees this text)', params: zIdParam,
    body: z.object({ answer: z.string().min(2).max(1000) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const r = await maybeOne<any>(tx, `SELECT * FROM partner_order_requests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('REQUEST');
      if (r.status === 'answered') throw conflict('REQUEST_ALREADY_ANSWERED');
      await tx.query(`UPDATE partner_order_requests SET status='answered', answer=$2, answered_by=$3, answered_at=now() WHERE id=$1`, [r.id, body.answer, actor.userId]);
      // A requested call time updates the order's callback (inside contact hours is the operator's responsibility to check).
      if (r.kind === 'callback_time' && r.preferred_at) await tx.query(`UPDATE orders SET callback_at=$2, contact_time_note=left(COALESCE(contact_time_note || ' ', '') || '(hamkor so‘ragan vaqt)', 120) WHERE id=$1 AND commercial_status='awaiting_confirmation'`, [r.order_id, r.preferred_at]);
      const left = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM partner_order_requests WHERE task_id=$1 AND status='open'`, [r.task_id]);
      if (left.n === 0 && r.task_id) {
        const t = await one<any>(tx, `UPDATE ops_tasks SET state='resolved', resolution='partner_answered', resolved_at=now(), lease_until=NULL, version=version+1, updated_at=now() WHERE id=$1 AND state NOT IN ('resolved','closed') RETURNING id, state`, [r.task_id]).catch(() => null);
        if (t) await event(tx, r.task_id, actor.userId!, 'partner_answered', null, 'resolved', { request_id: r.id });
      } else if (r.task_id) await event(tx, r.task_id, actor.userId!, 'partner_answered', null, null, { request_id: r.id });
      return { ok: true, open_left: left.n };
    });
  });
}
