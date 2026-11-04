import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, withTx } from '../../platform/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { event } from './routes.js';

/**
 * Operator Centre 3.0 — P1 (spec §15, §24): handoff request/accept and supervisor transfer.
 * The sender stays responsible until the receiver accepts (T14); an expired request goes back to the sender and is
 * visible to the supervisor. A supervisor transfer needs a reason and is audited; it does not reset task history.
 */
const T = ['operator-centre'];
const Package = z.object({
  done: z.string().min(2).max(1000),          // what was done
  customer_said: z.string().max(1000).default(''),
  promised: z.string().max(500).default(''),  // what was promised to whom
  missing: z.string().max(500).default(''),
  next: z.string().min(2).max(500),           // next action
  deadline: z.string().datetime().optional(),
});

async function isOperator(db: any, userId: string) {
  return !!(await maybeOne(db, `SELECT 1 FROM memberships WHERE user_id=$1 AND role_code IN ('operator','owner') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [userId]));
}

/** Expired pending handoffs return to the sender (no ownerless work). */
async function expireHandoffs(db: any) {
  const r = await db.query(`UPDATE ops_handoffs SET status='expired', decided_at=now() WHERE status='pending' AND expires_at < now() RETURNING task_id`);
  for (const x of r.rows) await event(db, x.task_id, null, 'handoff_expired', null, null, {});
}

export function registerOperatorCentreP1(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/handoff', tags: T, summary: 'Ask another operator to take over (with a handoff package)', params: zIdParam,
    body: z.object({ expected_version: z.number().int(), to_user_id: z.string().uuid(), package: Package }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    if (body.to_user_id === actor.userId) throw unprocessable('HANDOFF_TO_SELF');
    if (!(await isOperator(db, body.to_user_id))) throw unprocessable('HANDOFF_TARGET_NOT_OPERATOR');
    return withTx(db, async (tx) => {
      const t = await maybeOne<any>(tx, `SELECT * FROM ops_tasks WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!t) throw notFound('TASK');
      if (t.assignee_id !== actor.userId) throw forbidden();
      if (t.version !== body.expected_version) throw conflict('TASK_VERSION_CONFLICT', { current_version: t.version });
      if (['resolved', 'closed'].includes(t.state)) throw conflict('TASK_CLOSED');
      await expireHandoffs(tx);
      const h = await tx.query(`INSERT INTO ops_handoffs (task_id, from_user_id, to_user_id, package) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [t.id, actor.userId, body.to_user_id, JSON.stringify(body.package)]);
      if (!h.rowCount) throw conflict('HANDOFF_ALREADY_PENDING');
      await event(tx, t.id, actor.userId, 'handoff_requested', t.state, t.state, { to: body.to_user_id });
      return { handoff_id: h.rows[0].id };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/handoffs', tags: T, summary: 'Handoffs waiting for me, and mine waiting for others' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.operate');
    await expireHandoffs(db);
    const cols = `h.id, h.task_id, h.status, h.package, h.created_at, h.expires_at, t.reason, t.next_action, o.number, f.display_name AS from_name, tu.display_name AS to_name`;
    const from = `FROM ops_handoffs h JOIN ops_tasks t ON t.id=h.task_id JOIN orders o ON o.id=t.order_id JOIN users f ON f.id=h.from_user_id JOIN users tu ON tu.id=h.to_user_id`;
    return {
      incoming: await many(db, `SELECT ${cols} ${from} WHERE h.to_user_id=$1 AND h.status='pending' ORDER BY h.created_at`, [actor.userId]),
      outgoing: await many(db, `SELECT ${cols} ${from} WHERE h.from_user_id=$1 AND h.status='pending' ORDER BY h.created_at`, [actor.userId]),
    };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/handoffs/:id/:decision', tags: T, summary: 'Accept or decline a handoff',
    params: z.object({ id: z.string().uuid(), decision: z.enum(['accept', 'decline', 'cancel']) }), body: z.object({ reason: z.string().max(300).optional() }).default({}) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      await expireHandoffs(tx);
      const h = await maybeOne<any>(tx, `SELECT * FROM ops_handoffs WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!h) throw notFound('HANDOFF');
      if (h.status !== 'pending') throw conflict('HANDOFF_NOT_PENDING', { status: h.status });
      if (params.decision === 'cancel') {
        if (h.from_user_id !== actor.userId) throw forbidden();
        await tx.query(`UPDATE ops_handoffs SET status='cancelled', decided_at=now() WHERE id=$1`, [h.id]);
        await event(tx, h.task_id, actor.userId, 'handoff_cancelled', null, null, {});
        return { ok: true };
      }
      if (h.to_user_id !== actor.userId) throw forbidden();
      if (params.decision === 'decline') {
        if (!body.reason) throw unprocessable('REASON_REQUIRED');
        await tx.query(`UPDATE ops_handoffs SET status='declined', decline_reason=$2, decided_at=now() WHERE id=$1`, [h.id, body.reason]);
        await event(tx, h.task_id, actor.userId, 'handoff_declined', null, null, { reason: body.reason });
        return { ok: true };
      }
      const t = await maybeOne<any>(tx, `SELECT * FROM ops_tasks WHERE id=$1 FOR UPDATE`, [h.task_id]);
      if (!t || ['resolved', 'closed'].includes(t.state)) throw conflict('TASK_CLOSED');
      // Only now the owner changes; the lease restarts for the receiver. The package stays in the task history.
      const active = ['assigned', 'in_progress'].includes(t.state);
      await tx.query(`UPDATE ops_tasks SET assignee_id=$2, lease_until=${active ? `now() + interval '15 minutes'` : 'lease_until'}, version=version+1, updated_at=now() WHERE id=$1`, [t.id, actor.userId]);
      await tx.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1`, [t.order_id, actor.userId]);
      await tx.query(`UPDATE ops_handoffs SET status='accepted', decided_at=now() WHERE id=$1`, [h.id]);
      await event(tx, t.id, actor.userId, 'handoff_accepted', t.state, t.state, { from: h.from_user_id, package: h.package });
      return { ok: true, task_id: t.id };
    });
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/assign', tags: T, summary: 'Supervisor: transfer a task to an operator or back to the queue (reason required)', params: zIdParam,
    body: z.object({ to_user_id: z.string().uuid().nullable(), reason: z.string().min(3).max(300) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.reassign');
    if (body.to_user_id && !(await isOperator(db, body.to_user_id))) throw unprocessable('HANDOFF_TARGET_NOT_OPERATOR');
    return withTx(db, async (tx) => {
      const t = await maybeOne<any>(tx, `SELECT * FROM ops_tasks WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!t) throw notFound('TASK');
      if (['resolved', 'closed'].includes(t.state)) throw conflict('TASK_CLOSED');
      const toState = body.to_user_id ? (t.state === 'queued' ? 'assigned' : t.state === 'blocked' ? 'assigned' : t.state) : 'queued';
      await tx.query(`UPDATE ops_tasks SET assignee_id=$2, state=$3, lease_until=${body.to_user_id ? `now() + interval '15 minutes'` : 'NULL'}, blocked_by=CASE WHEN $3='blocked' THEN blocked_by ELSE NULL END,
          version=version+1, updated_at=now() WHERE id=$1`, [t.id, body.to_user_id, toState]);
      if (body.to_user_id) await tx.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1`, [t.order_id, body.to_user_id]);
      await tx.query(`UPDATE ops_handoffs SET status='cancelled', decided_at=now() WHERE task_id=$1 AND status='pending'`, [t.id]);
      await event(tx, t.id, actor.userId, 'supervisor_transfer', t.state, toState, { from: t.assignee_id, to: body.to_user_id, reason: body.reason });
      await audit(tx, actor, 'ops_task.transferred', { type: 'ops_task', id: t.id }, { before: { assignee: t.assignee_id }, after: { assignee: body.to_user_id }, reason: body.reason });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/operators', tags: T, summary: 'Operators I can hand work to (name + shift only)' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.operate');
    return { items: await many(db, `SELECT u.id, u.display_name, COALESCE(s.state,'off') AS shift FROM users u JOIN memberships m ON m.user_id=u.id AND m.role_code='operator' AND m.revoked_at IS NULL
        LEFT JOIN staff_shifts s ON s.user_id=u.id WHERE u.id <> $1 GROUP BY u.id, s.state ORDER BY (COALESCE(s.state,'off')='working') DESC, u.display_name`, [actor.userId]) };
  });
}
