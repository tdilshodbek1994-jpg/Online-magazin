import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { can, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { logOrderCall } from '../orders/routes.js';

/**
 * Operator Centre 3.0 — P0 work layer (spec §06, §09–§12, §14–§15).
 * Orders stay the source of truth; tasks say WHO does WHAT next and WHEN. Claims are atomic (conditional UPDATE /
 * FOR UPDATE SKIP LOCKED), every write carries expected_version, a lease limits how long a claim lives, and a call
 * result can never close a task without a next action or a final reason.
 */
const T = ['operator-centre'];
const LEASE_MIN = 15;            // claim lease; heartbeat extends it
const MAX_ACTIVE = 5;            // workload limit per operator (policy register: owner may change)
const MAX_ATTEMPTS = 5;          // unanswered calls before the task needs a supervisor decision
const OPEN = `('resolved','closed')`;
// Contact hours in Asia/Tashkent (UTC+5, no DST): no calls outside them (spec §12, T16). Policy register: owner may change.
export const CONTACT_FROM_H = 9, CONTACT_TO_H = 21;
const tashHour = (d: Date) => (d.getUTCHours() + 5) % 24 + d.getUTCMinutes() / 60;
export const inContactHours = (d: Date) => { const h = tashHour(d); return h >= CONTACT_FROM_H && h < CONTACT_TO_H; };
/** Moves a time that falls into quiet hours to the next 09:00 Tashkent. */
export function fitContactHours(d: Date): Date {
  if (inContactHours(d)) return d;
  const t = new Date(d.getTime() + 5 * 3600e3);              // shift to Tashkent wall clock
  if ((t.getUTCHours() + t.getUTCMinutes() / 60) >= CONTACT_TO_H) t.setUTCDate(t.getUTCDate() + 1);
  t.setUTCHours(CONTACT_FROM_H, 0, 0, 0);
  return new Date(t.getTime() - 5 * 3600e3);
}

const OUTCOMES = ['no_answer', 'busy', 'wrong_number', 'callback_requested', 'info_given', 'confirmed', 'rejected', 'problem'] as const;
type Outcome = typeof OUTCOMES[number];

/** Creates missing confirm tasks and closes tasks whose order no longer needs them. Idempotent (unique open index). */
export async function syncTasks(db: any): Promise<void> {
  await db.query(`
    INSERT INTO ops_tasks (order_id, type, reason, next_action, source, priority, not_before, due_at, created_at)
    SELECT o.id, 'confirm',
           CASE WHEN o.channel='partner_assisted' THEN 'Hamkor kiritgan buyurtma — mijoz tasdig‘i kerak' ELSE 'Yangi buyurtma — mijoz bilan tasdiqlash kerak' END,
           'Mijozga qo‘ng‘iroq qilib, tarkib va summani tasdiqlash',
           COALESCE(o.channel, 'site'), CASE WHEN o.address_snapshot->>'quick'='true' THEN 1 ELSE 0 END,
           o.callback_at, o.created_at + interval '30 minutes', o.created_at -- the customer has been waiting since the order came in
      FROM orders o
     WHERE o.commercial_status='awaiting_confirmation'
       AND NOT EXISTS (SELECT 1 FROM ops_tasks t WHERE t.order_id=o.id AND t.type='confirm' AND t.state NOT IN ${OPEN})
       AND NOT EXISTS (SELECT 1 FROM ops_tasks t WHERE t.order_id=o.id AND t.type='confirm' AND t.state IN ${OPEN} AND t.resolved_at > now() - interval '1 minute')
    ON CONFLICT DO NOTHING`);
  const closed = await db.query(`
    UPDATE ops_tasks t SET state='closed', resolution='order_moved_on', resolved_at=now(), lease_until=NULL, version=t.version+1, updated_at=now()
      FROM orders o WHERE o.id=t.order_id AND t.type='confirm' AND t.state NOT IN ${OPEN} AND o.commercial_status <> 'awaiting_confirmation'
    RETURNING t.id`);
  for (const r of closed.rows) await db.query(`INSERT INTO ops_task_events (task_id, kind, to_state, data) VALUES ($1,'auto_closed','closed','{"why":"order_moved_on"}')`, [r.id]);
}

export async function event(tx: any, taskId: string, actor: string | null, kind: string, from: string | null, to: string | null, data: Record<string, unknown> = {}) {
  await tx.query(`INSERT INTO ops_task_events (task_id, actor_id, kind, from_state, to_state, data) VALUES ($1,$2,$3,$4,$5,$6)`, [taskId, actor, kind, from, to, JSON.stringify(data)]);
}

export async function shiftState(db: any, userId: string): Promise<string> {
  return (await maybeOne<{ state: string }>(db, `SELECT state FROM staff_shifts WHERE user_id=$1`, [userId]))?.state ?? 'off';
}

export const TASK_COLS = `t.id, t.order_id, t.type, t.state, t.priority, t.reason, t.team, t.assignee_id, t.lease_until, t.due_at, t.not_before, t.next_action, t.blocked_by,
  t.source, t.attempts, t.version, t.created_at, t.updated_at, o.number, o.channel, o.payable_minor::text, o.contact_snapshot->>'name' AS customer_name,
  o.address_snapshot->>'district' AS district, u.display_name AS assignee_name,
  (SELECT string_agg((ol.product_snapshot->'name'->>'uz-Latn') || ' × ' || (ol.qty - ol.canceled_qty), ', ') FROM order_lines ol WHERE ol.order_id=o.id AND ol.qty > ol.canceled_qty) AS items_text,
  EXTRACT(EPOCH FROM now()-t.created_at)::int AS age_seconds`;

/** Claimable = queued, or a scheduled callback whose time came, or an expired lease (owner went silent). */
const CLAIMABLE = `(t.state='queued' AND (t.not_before IS NULL OR t.not_before <= now()))
  OR (t.state='scheduled' AND t.not_before <= now())
  OR (t.state IN ('assigned','in_progress') AND t.lease_until < now())`;

async function claim(tx: any, actor: any, taskId: string, expected?: number) {
  const t = await maybeOne<any>(tx, `SELECT t.* FROM ops_tasks t WHERE t.id=$1 FOR UPDATE`, [taskId]);
  if (!t) throw notFound('TASK');
  if (t.assignee_id === actor.userId && ['assigned', 'in_progress'].includes(t.state) && t.lease_until > new Date()) return t; // already mine
  if (expected !== undefined && t.version !== expected) throw conflict('TASK_VERSION_CONFLICT', { current_version: t.version, state: t.state, assignee_id: t.assignee_id });
  const ok = await maybeOne<{ ok: boolean }>(tx, `SELECT (${CLAIMABLE}) AS ok FROM ops_tasks t WHERE t.id=$1`, [taskId]);
  // A scheduled callback is reserved for its owner only until its time; nobody takes it early (T15).
  if (!ok?.ok) throw conflict('TASK_ALREADY_CLAIMED', { assignee_id: t.assignee_id, state: t.state });
  const r = await one<any>(tx, `UPDATE ops_tasks SET assignee_id=$2, state='assigned', lease_until=now() + interval '${LEASE_MIN} minutes', version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [taskId, actor.userId]);
  // Keep the legacy order owner in step so the existing order card actions work for the new owner.
  await tx.query(`UPDATE orders SET assigned_operator_id=$2, assigned_at=now(), version=version+1 WHERE id=$1 AND assigned_operator_id IS DISTINCT FROM $2`, [t.order_id, actor.userId]);
  await event(tx, taskId, actor.userId, t.assignee_id && t.assignee_id !== actor.userId ? 'reclaimed_after_lease' : 'claimed', t.state, 'assigned', { previous: t.assignee_id });
  return r;
}

/** Five answers every task card must give (spec §06): what happened, what is missing, who, next action, when. */
export function fiveAnswers(t: any) {
  const when = t.not_before ? { kind: 'callback', at: t.not_before } : t.due_at ? { kind: 'due', at: t.due_at } : null;
  return {
    what: t.reason,
    missing: t.blocked_by ?? (t.type === 'confirm' ? 'Mijoz tasdig‘i' : null),
    who: t.assignee_name ?? (t.team === 'operators' ? 'Operatorlar navbati' : t.team),
    next: t.next_action,
    when,
  };
}

export function registerOperatorCentre(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/center', tags: T, summary: 'Operator first screen: shift, my work, due callbacks, overdue, queue size' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.operate');
    await syncTasks(db);
    const shift = await shiftState(db, actor.userId!);
    const mine = await many(db, `SELECT ${TASK_COLS} FROM ops_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.assignee_id=$1 AND t.state NOT IN ${OPEN} ORDER BY (t.state='scheduled'), t.not_before NULLS FIRST, t.priority DESC, t.created_at LIMIT 50`, [actor.userId]);
    const c = await one<any>(db, `SELECT
        COUNT(*) FILTER (WHERE (${CLAIMABLE}))::int AS available,
        COUNT(*) FILTER (WHERE t.state='scheduled' AND t.not_before <= now())::int AS callbacks_due,
        COUNT(*) FILTER (WHERE t.due_at < now() AND t.state IN ('queued','assigned','in_progress'))::int AS overdue,
        COUNT(*) FILTER (WHERE t.state='blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unowned
      FROM ops_tasks t WHERE t.state NOT IN ${OPEN}`);
    return { shift, limits: { max_active: MAX_ACTIVE, lease_minutes: LEASE_MIN, max_attempts: MAX_ATTEMPTS }, counts: c, mine: mine.map((t) => ({ ...t, five: fiveAnswers(t) })) };
  });

  route(app, deps, { method: 'PUT', url: '/ops/center/shift', tags: T, summary: 'Set my shift state', body: z.object({ state: z.enum(['off', 'working', 'break', 'busy']) }) }, async ({ actor, db, body }) => {
    requirePerm(actor, 'orders.operate');
    await db.query(`INSERT INTO staff_shifts (user_id, state) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, changed_at=now()`, [actor.userId, body.state]);
    await audit(db, actor, 'shift.changed', { type: 'user', id: actor.userId! }, { after: { state: body.state } });
    // Going on break/off does NOT drop active work (T13): tasks keep their owner; the lease simply runs out and a
    // supervisor or the next operator can take them over afterwards.
    return { shift: body.state };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/next', tags: T, summary: 'Take the next eligible task (atomic)' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.operate');
    await syncTasks(db);
    if ((await shiftState(db, actor.userId!)) !== 'working') throw unprocessable('SHIFT_NOT_WORKING');
    return withTx(db, async (tx) => {
      const active = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM ops_tasks WHERE assignee_id=$1 AND state IN ('assigned','in_progress') AND lease_until > now()`, [actor.userId]);
      if (active.n >= MAX_ACTIVE) throw unprocessable('WORKLOAD_LIMIT', { max: MAX_ACTIVE });
      // Order: my own due callbacks first, then priority, then the longest-waiting (aging) — never price alone (§09).
      const cand = await maybeOne<{ id: string }>(tx, `SELECT t.id FROM ops_tasks t WHERE (${CLAIMABLE})
          ORDER BY (t.state='scheduled' AND t.assignee_id=$1) DESC, t.priority DESC, COALESCE(t.not_before, t.created_at) ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED`, [actor.userId]);
      if (!cand) return { task: null };
      const t = await claim(tx, actor, cand.id);
      return { task: t };
    });
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/claim', tags: T, summary: 'Claim a specific task', params: zIdParam, body: z.object({ expected_version: z.number().int().optional() }).default({}) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    if ((await shiftState(db, actor.userId!)) !== 'working') throw unprocessable('SHIFT_NOT_WORKING');
    return withTx(db, async (tx) => ({ task: await claim(tx, actor, params.id, body.expected_version) }));
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/heartbeat', tags: T, summary: 'Extend my lease', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const r = await db.query(`UPDATE ops_tasks SET lease_until=now() + interval '${LEASE_MIN} minutes' WHERE id=$1 AND assignee_id=$2 AND state IN ('assigned','in_progress') AND lease_until > now() RETURNING lease_until`, [params.id, actor.userId]);
    if (!r.rowCount) throw conflict('LEASE_LOST');
    return { lease_until: r.rows[0].lease_until };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/release', tags: T, summary: 'Return a task to the team queue', params: zIdParam,
    body: z.object({ expected_version: z.number().int(), reason: z.string().min(3).max(300) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const t = await maybeOne<any>(tx, `SELECT * FROM ops_tasks WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!t) throw notFound('TASK');
      if (t.assignee_id !== actor.userId && !can(actor, 'orders.reassign')) throw forbidden();
      if (t.version !== body.expected_version) throw conflict('TASK_VERSION_CONFLICT', { current_version: t.version });
      await tx.query(`UPDATE ops_tasks SET state='queued', assignee_id=NULL, lease_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
      await event(tx, params.id, actor.userId, 'released', t.state, 'queued', { reason: body.reason });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/tasks/:id', tags: T, summary: 'Task card: five answers, order, history', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.operate');
    const t = await maybeOne<any>(db, `SELECT ${TASK_COLS} FROM ops_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    const events = await many(db, `SELECT e.kind, e.from_state, e.to_state, e.data, e.created_at, u.display_name AS actor_name FROM ops_task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=$1 ORDER BY e.id`, [params.id]);
    const calls = await many(db, `SELECT c.outcome, c.note, c.callback_at, c.created_at, u.display_name AS operator_name FROM call_logs c JOIN users u ON u.id=c.operator_id WHERE c.order_id=$1 ORDER BY c.id DESC LIMIT 20`, [t.order_id]);
    return { ...t, five: fiveAnswers(t), events, calls, mine: t.assignee_id === actor.userId && t.lease_until && new Date(t.lease_until) > new Date() };
  });

  route(app, deps, { method: 'POST', url: '/ops/center/tasks/:id/contact', tags: T, summary: 'Record a contact result; always leads to a next action or a final reason', params: zIdParam,
    body: z.object({
      expected_version: z.number().int(),
      outcome: z.enum(OUTCOMES),
      note: z.string().max(1000).optional(),
      next_contact_at: z.string().datetime().optional(),
      confirmed_total_minor: z.string().regex(/^\d+$/).optional(),
    }) }, async ({ actor, db, cfg, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const t = await maybeOne<any>(tx, `SELECT * FROM ops_tasks WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!t) throw notFound('TASK');
      // Only the current lease holder writes; a stale tab or an expired session cannot (T10, T12).
      if (t.version !== body.expected_version) throw conflict('TASK_VERSION_CONFLICT', { current_version: t.version, state: t.state, assignee_id: t.assignee_id });
      if (t.assignee_id !== actor.userId || !['assigned', 'in_progress'].includes(t.state)) throw conflict('TASK_NOT_YOURS', { assignee_id: t.assignee_id, state: t.state });
      if (!t.lease_until || new Date(t.lease_until) <= new Date()) throw conflict('LEASE_LOST');
      const o: Outcome = body.outcome;
      const needsTime = o === 'callback_requested';
      if (needsTime && !body.next_contact_at) throw unprocessable('NEXT_CONTACT_REQUIRED');
      if (body.next_contact_at && new Date(body.next_contact_at) <= new Date()) throw unprocessable('NEXT_CONTACT_IN_PAST');
      if (body.next_contact_at && !inContactHours(new Date(body.next_contact_at))) throw unprocessable('OUTSIDE_CONTACT_HOURS', { from: CONTACT_FROM_H, to: CONTACT_TO_H });
      if ((o === 'problem' || o === 'wrong_number') && !body.note) throw unprocessable('REASON_REQUIRED');

      // Order-level effect goes through the existing, tested path (confirmation evidence, total read-back, cancel).
      const legacy = o === 'confirmed' ? 'confirmed' : o === 'rejected' ? 'rejected' : o === 'wrong_number' ? 'wrong_data' : o === 'callback_requested' ? 'call_later' : (o === 'no_answer' || o === 'busy') ? 'no_answer' : null;
      if (legacy) await logOrderCall(tx, cfg, actor, t.order_id, { outcome: legacy as any, note: body.note, callback_at: body.next_contact_at, confirmed_total_minor: body.confirmed_total_minor });
      if (legacy) await tx.query(`UPDATE call_logs SET task_id=$2, outcome=$3 WHERE id=(SELECT MAX(id) FROM call_logs WHERE order_id=$1)`, [t.order_id, t.id, o]);
      else await tx.query(`INSERT INTO call_logs (order_id, operator_id, outcome, note, callback_at, task_id) VALUES ($1,$2,$3,$4,$5,$6)`, [t.order_id, actor.userId, o, body.note ?? null, body.next_contact_at ?? null, t.id]);

      let next: { state: string; next_action: string; not_before?: string | null; blocked_by?: string | null; resolution?: string | null; release?: boolean };
      const attempts = t.attempts + ((o === 'no_answer' || o === 'busy') ? 1 : 0);
      if (o === 'confirmed') next = { state: 'resolved', next_action: 'Buyurtma omborga o‘tdi', resolution: 'confirmed' };
      else if (o === 'rejected') next = { state: 'resolved', next_action: 'Buyurtma bekor qilindi (mijoz rad etdi)', resolution: 'rejected' };
      else if (o === 'no_answer' || o === 'busy') {
        if (attempts >= MAX_ATTEMPTS) next = { state: 'blocked', next_action: 'Rahbar qarori: yana urinish yoki bekor qilish', blocked_by: `${attempts} marta javob bo‘lmadi` };
        else {
          const at = body.next_contact_at ?? fitContactHours(new Date(Date.now() + 2 * 3600e3)).toISOString();
          next = { state: 'scheduled', next_action: `Qayta qo‘ng‘iroq (${attempts}-urinishdan keyin)`, not_before: at };
        }
      } else if (o === 'callback_requested') next = { state: 'scheduled', next_action: 'Mijoz so‘ragan vaqtda qayta qo‘ng‘iroq', not_before: body.next_contact_at! };
      else if (o === 'wrong_number') next = { state: 'blocked', next_action: 'To‘g‘ri raqamni aniqlash (hamkor yoki mijoz orqali)', blocked_by: 'Telefon raqami noto‘g‘ri' };
      else if (o === 'problem') next = { state: 'waiting_internal', next_action: 'Muammoni hal qilish', blocked_by: body.note ?? 'Muammo' };
      else next = { state: 'in_progress', next_action: 'Ma’lumot berildi — tasdiqlashni davom ettirish' };

      const done = next.state === 'resolved';
      const keepLease = next.state === 'in_progress';
      const r = await one<any>(tx, `UPDATE ops_tasks SET state=$2, next_action=$3, not_before=$4, blocked_by=$5, resolution=$6, attempts=$7,
          lease_until=${keepLease ? 'lease_until' : 'NULL'}, resolved_at=${done ? 'now()' : 'NULL'}, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [t.id, next.state, next.next_action, next.not_before ?? null, next.blocked_by ?? null, next.resolution ?? null, attempts]);
      await event(tx, t.id, actor.userId, 'contact', t.state, next.state, { outcome: o, note: body.note ?? null, next_contact_at: next.not_before ?? null, attempts });
      return { task: r };
    });
  });

  route(app, deps, { method: 'GET', url: '/ops/center/board', tags: T, summary: 'Supervisor: open work by state/team with oldest wait', query: z.object({}).default({}) }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.reassign');
    await syncTasks(db);
    const rows = await many(db, `SELECT ${TASK_COLS} FROM ops_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.state NOT IN ${OPEN} ORDER BY t.state='blocked' DESC, t.created_at LIMIT 200`);
    const staff = await many(db, `SELECT u.id, u.display_name, COALESCE(s.state,'off') AS shift,
        (SELECT COUNT(*)::int FROM ops_tasks t WHERE t.assignee_id=u.id AND t.state IN ('assigned','in_progress') AND t.lease_until > now()) AS active
      FROM users u JOIN memberships m ON m.user_id=u.id AND m.role_code='operator' AND m.revoked_at IS NULL LEFT JOIN staff_shifts s ON s.user_id=u.id GROUP BY u.id, s.state ORDER BY u.display_name`);
    return { items: rows.map((t) => ({ ...t, five: fiveAnswers(t) })), staff, computed_at: new Date().toISOString() };
  });
}
