import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { event } from './routes.js';

/** Incident grouping (spec §24): link tasks to one root cause; resolving returns them to work, never fakes outcomes. */
const T = ['operator-centre'];
const KIND_UZ: Record<string, string> = { delivery: 'Yetkazish', warehouse: 'Ombor', payment: 'To‘lov', provider: 'Tashqi xizmat', other: 'Boshqa' };

export function registerIncidents(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ops/center/incidents', tags: T, summary: 'Supervisor: open an incident and link tasks to it',
    body: z.object({ title: z.string().min(3).max(160), kind: z.enum(['delivery', 'warehouse', 'payment', 'provider', 'other']), customer_note: z.string().max(500).optional(), task_ids: z.array(z.string().uuid()).min(1).max(200) }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'orders.reassign');
    return withTx(db, async (tx) => {
      const inc = await one<{ id: string }>(tx, `INSERT INTO ops_incidents (title, kind, customer_note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [body.title, body.kind, body.customer_note ?? null, actor.userId]);
      const linked = await tx.query(`UPDATE ops_tasks SET incident_id=$1, state=CASE WHEN state IN ('queued','assigned','in_progress') THEN 'waiting_internal' ELSE state END,
          blocked_by=$2, lease_until=NULL, version=version+1, updated_at=now()
        WHERE id = ANY($3::uuid[]) AND state NOT IN ('resolved','closed') RETURNING id, state`, [inc.id, `Umumiy muammo: ${body.title}`, body.task_ids]);
      for (const r of linked.rows) await event(tx, r.id, actor.userId!, 'incident_linked', null, r.state, { incident_id: inc.id, title: body.title });
      await audit(tx, actor, 'ops_incident.opened', { type: 'ops_incident', id: inc.id }, { after: { title: body.title, kind: body.kind, linked: linked.rowCount } });
      return { id: inc.id, linked: linked.rowCount };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/incidents', tags: T, summary: 'Incidents with linked task counts' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.reassign');
    const items = await many<any>(db, `SELECT i.*, u.display_name AS author,
        (SELECT COUNT(*)::int FROM ops_tasks t WHERE t.incident_id=i.id) AS tasks,
        (SELECT COUNT(*)::int FROM ops_tasks t WHERE t.incident_id=i.id AND t.state NOT IN ('resolved','closed')) AS open_tasks
      FROM ops_incidents i JOIN users u ON u.id=i.created_by ORDER BY (i.status='open') DESC, i.created_at DESC LIMIT 50`);
    return { items: items.map((i) => ({ ...i, kind_uz: KIND_UZ[i.kind] })) };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/incidents/:id/resolve', tags: T, summary: 'Close the incident: linked open tasks go back to the queue to finish each order', params: zIdParam,
    body: z.object({ resolution: z.string().min(3).max(500) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.reassign');
    return withTx(db, async (tx) => {
      const inc = await maybeOne<any>(tx, `SELECT * FROM ops_incidents WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!inc) throw notFound('INCIDENT');
      if (inc.status === 'resolved') throw conflict('INCIDENT_ALREADY_RESOLVED');
      await tx.query(`UPDATE ops_incidents SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1`, [inc.id, body.resolution, actor.userId]);
      // Orders are NOT changed here: each one is finished by an operator with its own evidence.
      const back = await tx.query(`UPDATE ops_tasks SET state='queued', assignee_id=NULL, blocked_by=NULL, next_action='Umumiy muammo hal bo‘ldi — mijozga xabar berib, buyurtmani davom ettirish',
          priority=priority+1, version=version+1, updated_at=now() WHERE incident_id=$1 AND state='waiting_internal' RETURNING id`, [inc.id]);
      for (const r of back.rows) await event(tx, r.id, actor.userId!, 'incident_resolved', 'waiting_internal', 'queued', { incident_id: inc.id, resolution: body.resolution });
      await audit(tx, actor, 'ops_incident.resolved', { type: 'ops_incident', id: inc.id }, { after: { returned: back.rowCount }, reason: body.resolution });
      return { ok: true, returned_to_queue: back.rowCount };
    });
  });
}

/**
 * Fair operator quality (spec §25): several measures side by side with their sample size, never a single
 * "calls count" ranking. Below MIN_SAMPLE the UI says "ma'lumot kam" instead of drawing conclusions.
 */
export const QUALITY_MIN_SAMPLE = 20;
export function registerOperatorQuality(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/center/quality', tags: T, summary: 'Supervisor: operator quality with denominators', query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) },
  async ({ actor, db, query }) => {
    requirePerm(actor, 'orders.reassign');
    const rows = await many<any>(db, `
      WITH ev AS (
        SELECT e.actor_id, e.task_id, e.kind, e.data, e.created_at, t.created_at AS task_created
          FROM ops_task_events e JOIN ops_tasks t ON t.id=e.task_id
         WHERE e.created_at > now() - make_interval(days => $1) AND e.actor_id IS NOT NULL),
      first_contact AS (
        SELECT actor_id, task_id, MIN(created_at) AS at, MIN(task_created) AS task_created FROM ev WHERE kind='contact' GROUP BY actor_id, task_id)
      SELECT u.id, u.display_name,
             (SELECT COUNT(DISTINCT task_id)::int FROM ev WHERE ev.actor_id=u.id AND kind='contact') AS tasks_contacted,
             (SELECT COUNT(*)::int FROM ev WHERE ev.actor_id=u.id AND kind='contact') AS contacts,
             (SELECT COUNT(*)::int FROM ev WHERE ev.actor_id=u.id AND kind='contact' AND data->>'outcome'='confirmed') AS confirmed,
             (SELECT COUNT(*)::int FROM ev WHERE ev.actor_id=u.id AND kind='contact' AND data->>'outcome'='rejected') AS rejected,
             (SELECT COUNT(*)::int FROM ev WHERE ev.actor_id=u.id AND kind IN ('handoff_requested')) AS handoffs,
             (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM fc.at - fc.task_created) / 60))::int FROM first_contact fc WHERE fc.actor_id=u.id) AS median_first_contact_min
        FROM users u JOIN memberships m ON m.user_id=u.id AND m.role_code='operator' AND m.revoked_at IS NULL
       GROUP BY u.id ORDER BY u.display_name`, [query.days]);
    return {
      days: query.days, min_sample: QUALITY_MIN_SAMPLE, computed_at: new Date().toISOString(),
      note: 'Tasdiqlash ulushi = tasdiqladi / aloqa qilingan ishlar. Ombordagi kamomad yoki kuryer kechikishi operatorga yozilmaydi.',
      items: rows.map((r) => ({ ...r, confirm_rate_pct: r.tasks_contacted ? Math.round((r.confirmed / r.tasks_contacted) * 1000) / 10 : null, enough_data: r.tasks_contacted >= QUALITY_MIN_SAMPLE })),
    };
  });
}
