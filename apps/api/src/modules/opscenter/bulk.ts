import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { maybeOne, withTx } from '../../platform/db.js';
import { unprocessable } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';
import { event } from './routes.js';

/**
 * Bulk-safe supervisor actions (spec §24, T53): only low-risk ones — transfer to an operator or back to the queue.
 * Preview first (dry_run), then execute item by item in separate transactions with a per-item result and a failure
 * summary. Money actions (paid, refund, commission) are deliberately not available in bulk.
 */
const T = ['operator-centre'];

export function registerBulkActions(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ops/center/bulk/assign', tags: T, summary: 'Supervisor: transfer many tasks (preview with dry_run)',
    body: z.object({ task_ids: z.array(z.string().uuid()).min(1).max(100), to_user_id: z.string().uuid().nullable(), reason: z.string().min(3).max(300), dry_run: z.boolean().default(true) }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'orders.reassign');
    if (body.to_user_id) {
      const ok = await maybeOne(db, `SELECT 1 FROM memberships WHERE user_id=$1 AND role_code IN ('operator','owner') AND revoked_at IS NULL`, [body.to_user_id]);
      if (!ok) throw unprocessable('HANDOFF_TARGET_NOT_OPERATOR');
    }
    const results: { task_id: string; number?: string; result: 'would_move' | 'moved' | 'skipped' | 'failed'; reason?: string }[] = [];
    for (const id of [...new Set(body.task_ids)]) {
      try {
        const r = await withTx(db, async (tx) => {
          const t = await maybeOne<any>(tx, `SELECT t.*, o.number FROM ops_tasks t JOIN orders o ON o.id=t.order_id WHERE t.id=$1 FOR UPDATE OF t`, [id]);
          if (!t) return { task_id: id, result: 'skipped' as const, reason: 'topilmadi' };
          if (['resolved', 'closed'].includes(t.state)) return { task_id: id, number: t.number, result: 'skipped' as const, reason: 'ish yopilgan' };
          if (t.assignee_id === body.to_user_id) return { task_id: id, number: t.number, result: 'skipped' as const, reason: 'allaqachon shu xodimda' };
          const live = ['assigned', 'in_progress'].includes(t.state) && t.lease_until && new Date(t.lease_until) > new Date();
          if (body.dry_run) return { task_id: id, number: t.number, result: 'would_move' as const, reason: live ? 'diqqat: hozir operator ishlayapti' : undefined };
          const toState = body.to_user_id ? (['queued', 'blocked'].includes(t.state) ? 'assigned' : t.state) : 'queued';
          await tx.query(`UPDATE ops_tasks SET assignee_id=$2, state=$3, lease_until=${body.to_user_id ? `now() + interval '15 minutes'` : 'NULL'}, version=version+1, updated_at=now() WHERE id=$1`, [id, body.to_user_id, toState]);
          if (body.to_user_id) await tx.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1`, [t.order_id, body.to_user_id]);
          await tx.query(`UPDATE ops_handoffs SET status='cancelled', decided_at=now() WHERE task_id=$1 AND status='pending'`, [id]);
          await event(tx, id, actor.userId!, 'supervisor_transfer', t.state, toState, { from: t.assignee_id, to: body.to_user_id, reason: body.reason, bulk: true });
          return { task_id: id, number: t.number, result: 'moved' as const };
        });
        results.push(r);
      } catch (e: any) { results.push({ task_id: id, result: 'failed', reason: e?.code ?? 'xato' }); }
    }
    const summary = results.reduce((a: Record<string, number>, r) => { a[r.result] = (a[r.result] ?? 0) + 1; return a; }, {});
    if (!body.dry_run) await audit(db, actor, 'ops_task.bulk_transfer', { type: 'ops_task', id: body.task_ids[0]! }, { after: { to: body.to_user_id, count: body.task_ids.length, summary }, reason: body.reason });
    return { dry_run: body.dry_run, selected: body.task_ids.length, summary, results };
  });
}
