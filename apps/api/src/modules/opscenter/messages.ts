import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { queueNotification } from '../notifications/service.js';
import { event } from './routes.js';

/**
 * Three-audience messaging from the task card (spec §16): internal note / to the partner / to the customer.
 * The composer always names the audience; an internal note is never copied outside. Delivery state is honest:
 * "stored" means visible in their cabinet; "queued" means handed to the notification outbox — never "read".
 * Customers are not sent SMS from here (no unsolicited texts from fixtures, T60): logged-in customers get an in-app
 * notice, guests see the message on their order page.
 */
const T = ['operator-centre'];

export function registerOrderMessages(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/messages', tags: T, summary: 'Write to the customer, the partner, or an internal note', params: zIdParam,
    body: z.object({ audience: z.enum(['internal', 'partner', 'customer']), body: z.string().min(2).max(1000) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const t = await maybeOne<{ id: string; order_id: string; state: string }>(tx, `SELECT id, order_id, state FROM ops_tasks WHERE id=$1`, [params.id]);
      if (!t) throw notFound('TASK');
      const o = await one<{ number: string; user_id: string | null; partner_user: string | null; partner_id: string | null }>(tx,
        `SELECT o.number, o.user_id, p.user_id AS partner_user, p.id AS partner_id FROM orders o LEFT JOIN partners p ON p.id=o.attributed_partner_id WHERE o.id=$1`, [t.order_id]);
      if (body.audience === 'internal') {
        await tx.query(`INSERT INTO order_notes (order_id, author_id, body, internal) VALUES ($1,$2,$3,true)`, [t.order_id, actor.userId, body.body]);
        await event(tx, t.id, actor.userId!, 'note_internal', null, null, {});
        return { audience: 'internal', delivery_state: 'stored' };
      }
      // A saved reply with an unfilled {placeholder} is never sent outside (no invented dates/prices).
      const unfilled = body.body.match(/\{[a-z_]+\}/g);
      if (unfilled) throw unprocessable('TEMPLATE_UNFILLED', { fields: [...new Set(unfilled)] });
      if (body.audience === 'partner' && !o.partner_id) return { audience: 'partner', delivery_state: 'no_partner' };
      let channel = 'cabinet', state = 'stored';
      if (body.audience === 'partner' && o.partner_user) {
        await queueNotification(tx, { userId: o.partner_user, channel: 'telegram', purpose: 'transactional', template: 'partner.operator_message', locale: 'uz-Latn', params: { number: o.number, text: body.body } });
        channel = 'telegram'; state = 'queued';
      } else if (body.audience === 'customer' && o.user_id) {
        await queueNotification(tx, { userId: o.user_id, channel: 'in_app', purpose: 'transactional', template: 'customer.operator_message', locale: 'uz-Latn', params: { number: o.number, text: body.body } });
        channel = 'in_app'; state = 'queued';
      }
      const m = await one<{ id: string }>(tx, `INSERT INTO order_messages (order_id, audience, body, author_id, channel, delivery_state) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [t.order_id, body.audience, body.body, actor.userId, channel, state]);
      await event(tx, t.id, actor.userId!, `message_${body.audience}`, null, null, { message_id: m.id, delivery_state: state });
      return { id: m.id, audience: body.audience, channel, delivery_state: state };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/tasks/:id/messages', tags: T, summary: 'Messages and internal notes of the task order, labelled by audience', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const t = await maybeOne<{ order_id: string }>(db, `SELECT order_id FROM ops_tasks WHERE id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    return { items: await many(db, `
      SELECT m.id::text, m.audience, m.body, m.channel, m.delivery_state, m.created_at, u.display_name AS author FROM order_messages m JOIN users u ON u.id=m.author_id WHERE m.order_id=$1
      UNION ALL
      SELECT n.id::text, 'internal', n.body, 'note', 'stored', n.created_at, u.display_name FROM order_notes n JOIN users u ON u.id=n.author_id WHERE n.order_id=$1 AND n.internal
      ORDER BY created_at DESC LIMIT 50`, [t.order_id]) };
  });
}

/** Messages a customer may see on their own order (no author identity, no internal notes). */
export async function customerMessages(db: any, orderId: string) {
  return many(db, `SELECT body, created_at FROM order_messages WHERE order_id=$1 AND audience='customer' ORDER BY created_at`, [orderId]);
}
/** Messages a partner may see on their own order. */
export async function partnerMessages(db: any, orderId: string) {
  return many(db, `SELECT body, created_at FROM order_messages WHERE order_id=$1 AND audience='partner' ORDER BY created_at`, [orderId]);
}
