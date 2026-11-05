import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireStepUp } from '../../platform/auth.js';
import { type Db, many, maybeOne, one, withTx } from '../../platform/db.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { queueNotification } from '../notifications/service.js';

/**
 * Controlled automation. Allowed triggers and actions are a fixed list; there is NO financial action (money, coins,
 * penalties, charity, ads). A rule runs in shadow first (journal «would do»), the owner activates it (step-up), every
 * rule has a daily cap and a per-object cooldown, a rule never triggers another rule, and the global kill switch stops all.
 */
const zParams = z.object({ minutes: z.number().int().min(5).max(1440).optional(), days: z.number().int().min(1).max(60).optional(), target_days: z.number().int().min(7).max(120).optional() }).strict();
const ALLOWED: Record<string, string[]> = { order_unassigned: ['alert_owner'], cod_unremitted: ['alert_owner'], stock_low: ['alert_owner', 'reorder_draft'] };

interface Rule { id: string; name: string; trigger: string; params: { minutes?: number; days?: number; target_days?: number }; action: string; mode: string; daily_cap: number; cooldown_hours: number; created_by: string }

async function candidates(db: Db, r: Rule): Promise<{ type: string; id: string; label: string; sku_id?: string; qty?: number }[]> {
  if (r.trigger === 'order_unassigned') {
    return (await many<{ id: string; number: string }>(db, `SELECT id, number FROM orders WHERE commercial_status='awaiting_confirmation' AND assigned_operator_id IS NULL AND created_at < now() - make_interval(mins => $1) ORDER BY created_at LIMIT 200`, [r.params.minutes ?? 30]))
      .map((o) => ({ type: 'order', id: o.id, label: `${o.number}: ${r.params.minutes ?? 30} daqiqadan beri hech kim olmagan` }));
  }
  if (r.trigger === 'cod_unremitted') {
    return (await many<{ id: string; collected_minor: string }>(db, `SELECT id, collected_minor::text FROM cod_collections WHERE collected_minor IS NOT NULL AND remittance_id IS NULL AND collected_at < now() - make_interval(days => $1) LIMIT 200`, [r.params.days ?? 2]))
      .map((c) => ({ type: 'cod_collection', id: c.id, label: `Kuryerda ${r.params.days ?? 2} kundan ortiq turgan naqd: ${(BigInt(c.collected_minor) / 100n).toString()} so‘m` }));
  }
  const td = r.params.target_days ?? 30;
  return (await many<{ sku_id: string; sku_code: string; suggest: number }>(db, `
      WITH sold AS (SELECT ol.sku_id, SUM(ol.qty - ol.canceled_qty)::int AS units FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE o.created_at > now() - interval '30 days' AND o.commercial_status <> 'cancelled' AND o.confirmation_status='verified' GROUP BY ol.sku_id),
           stock AS (SELECT sku_id, SUM(atp)::int AS atp FROM stock_atp GROUP BY sku_id),
           open_po AS (SELECT l.sku_id, SUM(l.qty_ordered - l.qty_received)::int AS incoming FROM purchase_order_lines l JOIN purchase_orders p ON p.id=l.po_id WHERE p.status IN ('draft','approved','ordered','partially_received') GROUP BY l.sku_id)
      SELECT s.id AS sku_id, s.sku_code, GREATEST(0, CEIL(sold.units::numeric * $1 / 30) - COALESCE(st.atp,0) - COALESCE(op.incoming,0))::int AS suggest
        FROM skus s JOIN sold ON sold.sku_id=s.id LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN open_po op ON op.sku_id=s.id
       WHERE s.status='active' AND GREATEST(0, CEIL(sold.units::numeric * $1 / 30) - COALESCE(st.atp,0) - COALESCE(op.incoming,0)) > 0 LIMIT 200`, [td]))
    .map((x) => ({ type: 'sku', id: x.sku_id, label: `${x.sku_code}: ${x.suggest} dona to‘ldirish kerak`, sku_id: x.sku_id, qty: x.suggest }));
}

export async function runAutomation(db: Db): Promise<{ rules: number; would_do: number; done: number; skipped: number }> {
  const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='automation.enabled'`);
  const totals = { rules: 0, would_do: 0, done: 0, skipped: 0 };
  if (!flag?.enabled) return totals;
  const rules = await many<Rule>(db, `SELECT * FROM automation_rules WHERE mode IN ('shadow','active') ORDER BY created_at`);
  for (const r of rules) {
    totals.rules++;
    const today = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM automation_runs WHERE rule_id=$1 AND outcome IN ('would_do','done') AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent')`, [r.id]);
    let used = today.n;
    for (const c of await candidates(db, r)) {
      const recent = await maybeOne(db, `SELECT 1 FROM automation_runs WHERE rule_id=$1 AND object_id=$2 AND outcome IN ('would_do','done') AND created_at > now() - make_interval(hours => $3)`, [r.id, c.id, r.cooldown_hours]);
      if (recent) continue; // cooldown: the same object is not acted on again
      if (used >= r.daily_cap) { await db.query(`INSERT INTO automation_runs (rule_id, object_type, object_id, mode, outcome, detail) VALUES ($1,$2,$3,$4,'skipped_cap',$5)`, [r.id, c.type, c.id, r.mode, c.label]); totals.skipped++; break; }
      used++;
      if (r.mode === 'shadow') { await db.query(`INSERT INTO automation_runs (rule_id, object_type, object_id, mode, outcome, detail) VALUES ($1,$2,$3,'shadow','would_do',$4)`, [r.id, c.type, c.id, c.label]); totals.would_do++; continue; }
      try {
        await withTx(db, async (tx) => {
          if (r.action === 'alert_owner') {
            const owners = await many<{ user_id: string }>(tx, `SELECT DISTINCT user_id FROM memberships WHERE role_code='owner' AND revoked_at IS NULL`);
            for (const o of owners) await queueNotification(tx, { userId: o.user_id, channel: 'in_app', purpose: 'transactional', template: 'automation.alert', locale: 'uz-Latn', params: { text: `${r.name}: ${c.label}` }, dedupeKey: `auto:${r.id}:${c.id}:${o.user_id}:${new Date().toISOString().slice(0, 13)}` });
          } else if (r.action === 'reorder_draft' && c.sku_id && c.qty) {
            // Draft only: the owner still approves it; nothing is bought or paid here.
            const h = await one<{ id: string }>(tx, `INSERT INTO purchase_orders (note, created_by) VALUES ($1,$2) RETURNING id`, [`Avto: ${r.name}`, r.created_by]);
            await tx.query(`INSERT INTO purchase_order_lines (po_id, sku_id, qty_ordered) VALUES ($1,$2,$3)`, [h.id, c.sku_id, c.qty]);
          }
          await tx.query(`INSERT INTO automation_runs (rule_id, object_type, object_id, mode, outcome, detail) VALUES ($1,$2,$3,'active','done',$4)`, [r.id, c.type, c.id, c.label]);
        });
        totals.done++;
      } catch (e) {
        await db.query(`INSERT INTO automation_runs (rule_id, object_type, object_id, mode, outcome, detail) VALUES ($1,$2,$3,'active','failed',$4)`, [r.id, c.type, c.id, String((e as Error).message).slice(0, 200)]);
      }
    }
  }
  return totals;
}

export function registerAutomation(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/automation', tags: ['admin'], summary: 'Rules with recent runs' }, async ({ actor, db }) => {
    requirePerm(actor, 'staff.manage');
    const rules = await many(db, `SELECT r.*, (SELECT COUNT(*)::int FROM automation_runs x WHERE x.rule_id=r.id AND x.outcome='would_do') AS shadow_runs, (SELECT COUNT(*)::int FROM automation_runs x WHERE x.rule_id=r.id AND x.outcome='done') AS done_runs FROM automation_rules r ORDER BY r.created_at DESC`);
    const runs = await many(db, `SELECT x.rule_id, x.mode, x.outcome, x.detail, x.created_at FROM automation_runs x ORDER BY x.created_at DESC LIMIT 50`);
    return { rules, runs, allowed: ALLOWED };
  });

  route(app, deps, { method: 'POST', url: '/admin/automation/rules', tags: ['admin'], summary: 'New rule (starts in shadow mode)',
    body: z.object({ name: z.string().trim().min(3).max(120), trigger: z.enum(['order_unassigned', 'stock_low', 'cod_unremitted']), action: z.enum(['alert_owner', 'reorder_draft']), params: zParams.default({}), daily_cap: z.number().int().min(1).max(500).optional(), cooldown_hours: z.number().int().min(1).max(720).optional() }).strict() },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'staff.manage');
    if (!ALLOWED[body.trigger]!.includes(body.action)) throw unprocessable('ACTION_NOT_ALLOWED_FOR_TRIGGER');
    const r = await one<{ id: string }>(db, `INSERT INTO automation_rules (name, trigger, params, action, daily_cap, cooldown_hours, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [body.name, body.trigger, JSON.stringify(body.params), body.action, body.daily_cap ?? 20, body.cooldown_hours ?? 24, actor.userId]);
    await audit(db, actor, 'automation.rule_created', { type: 'automation_rule', id: r.id });
    return { id: r.id, mode: 'shadow' };
  });

  route(app, deps, { method: 'POST', url: '/admin/automation/rules/:id/activate', tags: ['admin'], summary: 'Activate after shadow results (owner, step-up)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'staff.manage'); requireStepUp(actor);
    const shadow = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM automation_runs WHERE rule_id=$1 AND mode='shadow'`, [params.id]);
    const r = await maybeOne(db, `SELECT 1 FROM automation_rules WHERE id=$1`, [params.id]);
    if (!r) throw notFound('AUTOMATION_RULE');
    if (shadow.n === 0) throw conflict('SHADOW_RUN_REQUIRED');
    await db.query(`UPDATE automation_rules SET mode='active', approved_by=$2, approved_at=now(), version=version+1 WHERE id=$1`, [params.id, actor.userId]);
    await audit(db, actor, 'automation.rule_activated', { type: 'automation_rule', id: params.id });
    return { ok: true, mode: 'active' };
  });

  route(app, deps, { method: 'POST', url: '/admin/automation/rules/:id/pause', tags: ['admin'], summary: 'Pause a rule (already done actions are not undone)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'staff.manage');
    const r = await maybeOne(db, `UPDATE automation_rules SET mode='paused', version=version+1 WHERE id=$1 RETURNING id`, [params.id]);
    if (!r) throw notFound('AUTOMATION_RULE');
    await audit(db, actor, 'automation.rule_paused', { type: 'automation_rule', id: params.id });
    return { ok: true, mode: 'paused' };
  });

  route(app, deps, { method: 'POST', url: '/admin/automation/run', tags: ['admin'], summary: 'Run all rules now (shadow → journal only)' }, async ({ actor, db }) => {
    requirePerm(actor, 'staff.manage');
    return runAutomation(db);
  });
}
