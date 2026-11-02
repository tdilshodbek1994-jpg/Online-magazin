import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

export function registerSupport(app: FastifyInstance, deps: Deps): void {
  const T = ['support'];
  route(app, deps, { method: 'POST', url: '/support/tickets', tags: T, summary: 'Open ticket (optionally about own order)', body: z.object({ subject: z.string().min(3).max(140), body: z.string().min(1).max(4000), order_id: z.string().uuid().optional() }) },
    async ({ actor, db, body }) => {
      requireUser(actor);
      return withTx(db, async (tx) => {
        if (body.order_id) {
          const own = await maybeOne(tx, `SELECT 1 FROM orders o LEFT JOIN partners p ON p.id=o.attributed_partner_id JOIN users u ON u.id=$2
              WHERE o.id=$1 AND (o.user_id=$2 OR (o.user_id IS NULL AND o.customer_phone=u.phone_e164) OR p.user_id=$2)`, [body.order_id, actor.userId]);
          if (!own) throw notFound('ORDER');
        }
        const t = await one<{ id: string }>(tx, `INSERT INTO support_tickets (opened_by, order_id, subject) VALUES ($1,$2,$3) RETURNING id`, [actor.userId, body.order_id ?? null, body.subject]);
        await tx.query(`INSERT INTO support_messages (ticket_id, author_id, body) VALUES ($1,$2,$3)`, [t.id, actor.userId, body.body]);
        return { id: t.id };
      });
    });

  route(app, deps, { method: 'GET', url: '/support/tickets', tags: T, summary: 'My tickets (staff: all)' }, async ({ actor, db }) => {
    requireUser(actor);
    const staff = can(actor, 'support.operate');
    return { items: await many(db, `SELECT id, subject, status, order_id, created_at, updated_at FROM support_tickets WHERE $2 OR opened_by=$1 ORDER BY updated_at DESC LIMIT 200`, [actor.userId, staff]) };
  });

  route(app, deps, { method: 'GET', url: '/support/tickets/:id', tags: T, summary: 'Ticket thread (internal notes hidden from customer/partner)', params: zIdParam }, async ({ actor, db, params }) => {
    requireUser(actor);
    const staff = can(actor, 'support.operate');
    const t = await maybeOne(db, `SELECT * FROM support_tickets WHERE id=$1 AND ($3 OR opened_by=$2)`, [params.id, actor.userId, staff]);
    if (!t) throw notFound('TICKET');
    return { ...t, messages: await many(db, `SELECT id, author_id, body, internal, created_at FROM support_messages WHERE ticket_id=$1 AND ($2 OR NOT internal) ORDER BY id`, [params.id, staff]) };
  });

  route(app, deps, { method: 'POST', url: '/support/tickets/:id/messages', tags: T, summary: 'Reply (staff may add internal note)', params: zIdParam, body: z.object({ body: z.string().min(1).max(4000), internal: z.boolean().default(false), status: z.enum(['open', 'waiting_customer', 'resolved', 'closed']).optional() }) },
    async ({ actor, db, params, body }) => {
      requireUser(actor);
      const staff = can(actor, 'support.operate');
      const t = await maybeOne(db, `SELECT id FROM support_tickets WHERE id=$1 AND ($3 OR opened_by=$2)`, [params.id, actor.userId, staff]);
      if (!t) throw notFound('TICKET');
      await db.query(`INSERT INTO support_messages (ticket_id, author_id, body, internal) VALUES ($1,$2,$3,$4)`, [params.id, actor.userId, body.body, staff && body.internal]);
      if (staff && body.status) await db.query(`UPDATE support_tickets SET status=$2, assignee_id=COALESCE(assignee_id,$3), updated_at=now() WHERE id=$1`, [params.id, body.status, actor.userId]);
      else await db.query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [params.id]);
      return { ok: true };
    });
  void requirePerm;
}
