import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { type Db, many, maybeOne, one, type Queryable } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { catalogFacts } from '../landings/routes.js';
import { metaAdapter } from './adapter.js';
import { approvalScope, connection, connectionBlocker, getDraft, remoteIdsOf, tokenOf } from './routes.js';

/**
 * AI TARGET PRO — P2A safety. Automation can only REDUCE risk: owner-approved rules send pause requests for
 * UZSHOP-managed campaigns (never activate, never raise budgets). A safety pause revokes the approval, so a restart
 * always needs the owner again. The kill switch touches only campaign ids this system created. Every automated action
 * leaves a receipt + audit. Stale/unknown insights never drive budget changes.
 */
const A = ['admin', 'target'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
function ownerOnly(a: Actor) { requirePerm(a, 'catalog.write'); if (!isOwner(a)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED'); }
const RUNNING = `('activation_requested','delivery_pending','delivering')`;

async function receipt(q: Queryable, draftId: string | null, action: string, reason: string, result: string | null) {
  await q.query(`INSERT INTO ad_automation_receipts (draft_id, action, reason, result) VALUES ($1,$2,$3,$4)`, [draftId, action, reason, result]);
}

/** Send a pause request; the campaign is "pause_requested" until the provider confirms PAUSED (sync). */
async function requestPause(db: Db, cfg: AppConfig, draftId: string, reason: string, actor: Actor | null) {
  const ids = await remoteIdsOf(db, draftId);
  if (!ids) return 'no_remote';
  await db.query(`UPDATE campaign_drafts SET status='pause_requested', safety_reason=$2, paused_at=now(), updated_at=now() WHERE id=$1`, [draftId, reason]);
  // A safety stop invalidates the old authorization: restarting needs a fresh owner approval (LT-075).
  await db.query(`UPDATE campaign_approvals SET revoked_at=now() WHERE draft_id=$1 AND revoked_at IS NULL`, [draftId]);
  const c = await connection(db);
  let result = 'requested';
  try {
    if (connectionBlocker(c, true)) throw Object.assign(new Error('x'), { code: 'NOT_CONNECTED' });
    await metaAdapter().pause(tokenOf(cfg, c!), ids);
    await db.query(`UPDATE campaign_drafts SET configured_status='PAUSED' WHERE id=$1`, [draftId]);
  } catch (e) {
    result = `provider_no_answer:${(e as { code?: string }).code ?? 'error'}`; // stays "pause_requested" — never shown as paused
  }
  await receipt(db, draftId, result === 'requested' ? 'pause_requested' : 'pause_failed', reason, result);
  if (actor) await audit(db, actor, 'campaign.safety_pause', { type: 'campaign', id: draftId }, { after: { reason, result } });
  return result;
}

/** Evaluate enabled rules for running managed campaigns. Returns what was requested. */
export async function runAdSafety(db: Db, cfg: AppConfig) {
  const rules = new Set((await many<{ kind: string }>(db, `SELECT kind FROM ad_safety_rules WHERE enabled AND approved_by IS NOT NULL`)).map((r) => r.kind));
  if (!rules.size) return [];
  const out: { draft_id: string; reason: string; result: string }[] = [];
  const running = await many<{ id: string; landing_id: string }>(db, `SELECT id, landing_id FROM campaign_drafts WHERE status IN ${RUNNING}`);
  for (const r of running) {
    const l = await one<{ status: string; product_ids: string[] }>(db, `SELECT status, product_ids FROM landing_pages WHERE id=$1`, [r.landing_id]);
    let reason: string | null = null;
    if (rules.has('landing_unpublished') && l.status !== 'published') reason = 'landing_unpublished';
    else if (rules.has('stock_out')) {
      const facts = await catalogFacts(db, l.product_ids) as any[];
      if (!facts.some((p) => (p.skus ?? []).some((s: any) => s.available > 0))) reason = 'stock_out';
    }
    if (!reason && rules.has('price_changed')) {
      const appr = await maybeOne<{ scope: { offer_prices?: string[] } }>(db, `SELECT scope FROM campaign_approvals WHERE draft_id=$1 ORDER BY approved_at DESC LIMIT 1`, [r.id]);
      const d = await getDraft(db, r.id);
      const now = (await approvalScope(db, cfg, d)).scope.offer_prices;
      if (appr?.scope.offer_prices && JSON.stringify(appr.scope.offer_prices) !== JSON.stringify(now)) reason = 'price_changed';
    }
    if (reason) out.push({ draft_id: r.id, reason, result: await requestPause(db, cfg, r.id, reason, null) });
  }
  return out;
}

export function registerTargetSafety(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/ad-safety', tags: A, summary: 'Safety rules, spending envelopes, recent automation receipts' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    const envelopes = await many(db, `SELECT e.id, e.currency, e.total_minor::text, e.note, e.approved_at, e.closed_at,
        (SELECT COALESCE(SUM(r.amount_minor),0)::text FROM ad_envelope_reservations r WHERE r.envelope_id=e.id AND r.released_at IS NULL) AS reserved_minor
      FROM ad_spend_envelopes e ORDER BY e.approved_at DESC LIMIT 10`);
    return {
      rules: await many(db, `SELECT kind, enabled, approved_at FROM ad_safety_rules ORDER BY kind`), envelopes,
      receipts: await many(db, `SELECT r.id, r.action, r.reason, r.result, r.created_at, c.title FROM ad_automation_receipts r LEFT JOIN campaign_drafts c ON c.id=r.draft_id ORDER BY r.id DESC LIMIT 30`),
    };
  });

  route(app, deps, { method: 'PUT', url: '/admin/ad-safety/rules/:kind', tags: A, summary: 'Owner: enable/disable a protective rule (rules can only pause)',
    params: z.object({ kind: z.enum(['stock_out', 'landing_unpublished', 'price_changed']) }), body: z.object({ enabled: z.boolean() }).strict() }, async ({ actor, db, params, body }) => {
    ownerOnly(actor);
    await db.query(`UPDATE ad_safety_rules SET enabled=$2, approved_by=$3, approved_at=now() WHERE kind=$1`, [params.kind, body.enabled, actor.userId]);
    await audit(db, actor, 'ad_safety.rule', { type: 'ad_safety_rule', id: params.kind }, { after: body });
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-safety/envelopes', tags: A, summary: 'Owner: approve a spending envelope (activations reserve from it; never exceeded)',
    body: z.object({ currency: z.string().regex(/^[A-Z]{3}$/).default('UZS'), total_minor: z.string().regex(/^\d{1,15}$/), note: z.string().trim().max(200).optional() }).strict() }, async ({ actor, db, body }) => {
    ownerOnly(actor);
    if (BigInt(body.total_minor) <= 0n) throw new AppError(400, 'AMOUNT_REQUIRED');
    await db.query(`UPDATE ad_spend_envelopes SET closed_at=now() WHERE closed_at IS NULL AND currency=$1`, [body.currency]);
    const e = await one<{ id: string }>(db, `INSERT INTO ad_spend_envelopes (currency, total_minor, note, approved_by) VALUES ($1,$2,$3,$4) RETURNING id`, [body.currency, body.total_minor, body.note ?? null, actor.userId]);
    await audit(db, actor, 'ad_safety.envelope', { type: 'ad_spend_envelope', id: e.id }, { after: body });
    return { id: e.id };
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-safety/run', tags: A, summary: 'Run the protective rules now (same as the worker)' }, async ({ actor, db, cfg }) => {
    requirePerm(actor, 'catalog.write');
    return { requested: await runAdSafety(db, cfg) };
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-safety/kill-switch', tags: A, summary: 'Master kill switch: pause requests to every UZSHOP-managed campaign (external campaigns untouched)',
    body: z.object({ reason: z.string().trim().min(3).max(200) }).strict() }, async ({ actor, db, cfg, body }) => {
    requirePerm(actor, 'catalog.write'); // stopping is always allowed for staff with campaign rights; starting is owner-only
    const managed = await many<{ id: string }>(db, `SELECT DISTINCT c.id FROM campaign_drafts c JOIN remote_objects r ON r.draft_id=c.id WHERE c.status NOT IN ('paused','provisioned_paused','completed','rejected')`);
    const results = [];
    for (const m of managed) results.push({ draft_id: m.id, result: await requestPause(db, cfg, m.id, `kill_switch: ${body.reason}`, actor) });
    await receipt(db, null, 'kill_switch', body.reason, `${results.length} campaigns`);
    return { requested: results.length, results };
  });

  route(app, deps, { method: 'GET', url: '/admin/ad-campaigns/:id/recommendation', tags: A, summary: 'Advisory only; stale/unknown data → warning and no budget suggestion. Never applied automatically.', params: zIdParam },
    async ({ actor, db, params }) => {
      requirePerm(actor, 'catalog.write');
      const d = await maybeOne<{ synced_at: string | null; status: string; effective_status: string | null }>(db, `SELECT synced_at, status, effective_status FROM campaign_drafts WHERE id=$1`, [params.id]);
      if (!d) throw new AppError(404, 'CAMPAIGN_NOT_FOUND');
      const stale = !d.synced_at || Date.now() - Date.parse(d.synced_at) > 24 * 3600_000;
      if (stale) return { stale: true, warning: 'Meta ma’lumoti eski yoki yo‘q — tavsiya berilmaydi, budjet avtomatik o‘zgarmaydi.', budget_change: null };
      return { stale: false, budget_change: null, note: 'Budjetni faqat egasi o‘zgartiradi (yangi tasdiq bilan). Bu bo‘lim faqat maslahat beradi.', effective_status: d.effective_status };
    });
}
