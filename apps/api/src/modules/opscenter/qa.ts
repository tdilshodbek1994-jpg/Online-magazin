import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one } from '../../platform/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

/** QA sampling with human review and the operator's right to object (spec §25). */
const T = ['operator-centre'];
const LAST_HANDLER = `(SELECT e.actor_id FROM ops_task_events e WHERE e.task_id=t.id AND e.kind='contact' AND e.actor_id IS NOT NULL ORDER BY e.id DESC LIMIT 1)`;

export function registerQa(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/center/qa/sample', tags: T, summary: 'Random sample of finished tasks to review (not my own work)', query: z.object({ n: z.coerce.number().int().min(1).max(20).default(5) }) },
  async ({ actor, db, query }) => {
    requirePerm(actor, 'orders.reassign');
    const items = await many(db, `
      SELECT * FROM (
        SELECT t.id, t.type, t.resolution, t.resolved_at, o.number, ${LAST_HANDLER} AS operator_id,
               (SELECT string_agg(e.data->>'outcome', ' → ' ORDER BY e.id) FROM ops_task_events e WHERE e.task_id=t.id AND e.kind='contact') AS outcomes,
               (SELECT string_agg(c.note, ' | ') FROM call_logs c WHERE c.task_id=t.id AND c.note IS NOT NULL) AS notes
          FROM ops_tasks t JOIN orders o ON o.id=t.order_id
         WHERE t.state='resolved' AND t.resolved_at > now() - interval '14 days'
           AND NOT EXISTS (SELECT 1 FROM ops_qa_reviews q WHERE q.task_id=t.id)) x
       WHERE x.operator_id IS NOT NULL AND x.operator_id <> $1
       ORDER BY random() LIMIT $2`, [actor.userId, query.n]);
    const names = await many<any>(db, `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [items.map((i: any) => i.operator_id)]);
    return { items: items.map((i: any) => ({ ...i, operator_name: names.find((n) => n.id === i.operator_id)?.display_name ?? '—' })) };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/qa/:id', tags: T, summary: 'Review one finished task', params: zIdParam,
    body: z.object({ checks: z.object({ correct_outcome: z.boolean(), data_complete: z.boolean(), clear_communication: z.boolean() }), score: z.number().int().min(1).max(5), note: z.string().max(1000).optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.reassign');
    const t = await maybeOne<{ id: string; state: string; operator_id: string | null }>(db, `SELECT t.id, t.state, ${LAST_HANDLER} AS operator_id FROM ops_tasks t WHERE t.id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    if (t.state !== 'resolved' || !t.operator_id) throw unprocessable('TASK_NOT_REVIEWABLE');
    if (t.operator_id === actor.userId) throw forbidden(); // no reviewing your own work
    if (body.score <= 2 && !body.note) throw unprocessable('REASON_REQUIRED');
    const r = await db.query(`INSERT INTO ops_qa_reviews (task_id, operator_id, reviewer_id, checks, score, note) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (task_id) DO NOTHING RETURNING id`,
      [t.id, t.operator_id, actor.userId, JSON.stringify(body.checks), body.score, body.note ?? null]);
    if (!r.rowCount) throw conflict('ALREADY_REVIEWED');
    await audit(db, actor, 'ops_qa.reviewed', { type: 'ops_task', id: t.id }, { after: { score: body.score } });
    return { id: r.rows[0].id };
  });

  route(app, deps, { method: 'GET', url: '/ops/center/qa/mine', tags: T, summary: 'My QA reviews (operator)' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.operate');
    return { items: await many(db, `SELECT q.id, q.checks, q.score, q.note, q.operator_reply, q.status, q.created_at, o.number, u.display_name AS reviewer
      FROM ops_qa_reviews q JOIN ops_tasks t ON t.id=q.task_id JOIN orders o ON o.id=t.order_id JOIN users u ON u.id=q.reviewer_id WHERE q.operator_id=$1 ORDER BY q.created_at DESC LIMIT 30`, [actor.userId]) };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/qa/reviews/:id/reply', tags: T, summary: 'Operator objects to / comments on a review', params: zIdParam, body: z.object({ text: z.string().min(3).max(1000) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    const q = await maybeOne<{ operator_id: string; operator_reply: string | null }>(db, `SELECT operator_id, operator_reply FROM ops_qa_reviews WHERE id=$1`, [params.id]);
    if (!q) throw notFound('REVIEW');
    if (q.operator_id !== actor.userId) throw forbidden();
    if (q.operator_reply) throw conflict('ALREADY_REPLIED');
    await one(db, `UPDATE ops_qa_reviews SET operator_reply=$2, status='disputed', replied_at=now() WHERE id=$1 RETURNING id`, [params.id, body.text]);
    return { ok: true };
  });
}
