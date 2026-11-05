import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { myPartner } from '../partners/routes.js';
import { share } from './service.js';

/**
 * UZSHOP PRO — Charity Center (P0 + automatic share). Partner: totals, funds, one-time gifts (existing endpoint),
 * automatic % of own confirmed commission (default OFF, explicit consent), pause/cancel, preview, history.
 * Admin: funds lifecycle, disbursements with proof and two-step approval for big amounts. No admin can turn on a
 * partner's automatic giving — there is no such endpoint by design.
 */
const P = ['partner', 'charity'];
const A = ['admin', 'charity'];
const CONSENT_VERSION = 'charity-auto-v1';
const BIG_DISBURSEMENT_MINOR = 1_000_000_000n; // 10 000 000 so'm — demo default for the two-step rule (owner to confirm)
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');

export function registerCharityCenter(app: FastifyInstance, deps: Deps): void {
  // ---------------- Partner ----------------
  route(app, deps, { method: 'GET', url: '/partner/charity/center', tags: P, summary: 'My charity: totals, my rule, history (own only), open funds, shop-wide transparency totals' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const mine = await one<any>(db, `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status='transferred_to_fund'),0)::text AS given, COUNT(*)::int AS n FROM charity_donations WHERE partner_id=$1`, [p.id]);
    const rule = await maybeOne<any>(db, `SELECT r.*, f.name AS fund_name FROM charity_rules r LEFT JOIN charity_funds f ON f.id=r.fund_id WHERE r.partner_id=$1`, [p.id]);
    // "Kutilmoqda": what the rule would take from commissions that are not available yet (projection only — no money moved).
    const pendingComm = await one<{ s: string }>(db, `SELECT COALESCE(SUM(target_minor),0)::text AS s FROM commission_accruals WHERE partner_id=$1 AND state IN ('estimated','pending')`, [p.id]);
    const projected = rule && rule.status === 'active' ? share(BigInt(pendingComm.s), rule.percent_bps).toString() : '0';
    const shop = await one<any>(db, `SELECT (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations WHERE status='transferred_to_fund')::text AS collected,
        (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers WHERE status='disbursed')::text AS disbursed,
        (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers WHERE status='disbursement_pending')::text AS disbursement_pending`);
    return {
      totals: { my_given_minor: mine.given, my_count: mine.n, projected_pending_minor: projected, shop_collected_minor: shop.collected, shop_to_fund_minor: shop.collected, shop_disbursed_minor: shop.disbursed, shop_disbursement_pending_minor: shop.disbursement_pending },
      rule: rule ? { fund_id: rule.fund_id, fund_name: rule.fund_name, percent_bps: rule.percent_bps, monthly_cap_minor: rule.monthly_cap_minor, starts_at: rule.starts_at, status: rule.status, consent_at: rule.consent_at, version: rule.version } : null,
      funds: await many(db, `SELECT id, name, recipient_org, purpose FROM charity_funds WHERE status='approved' ORDER BY created_at`),
      history: await many(db, `SELECT d.id, d.amount_minor::text, d.source, d.status, d.created_at, d.percent_bps, d.commission_amount_minor::text, d.commission_accrual_id, f.name AS fund
        FROM charity_donations d LEFT JOIN charity_funds f ON f.id=d.fund_id WHERE d.partner_id=$1 ORDER BY d.created_at DESC LIMIT 200`, [p.id]),
      handovers: await many(db, `SELECT h.amount_minor::text, h.recipient, h.disbursed_at, f.name AS fund FROM charity_handovers h LEFT JOIN charity_funds f ON f.id=h.fund_id WHERE h.status='disbursed' ORDER BY h.created_at DESC LIMIT 20`),
    };
  });

  route(app, deps, { method: 'GET', url: '/partner/charity/preview', tags: P, summary: 'Preview: share of an amount (e.g. 300 000 × 1% = 3 000, 297 000 left)', query: z.object({ amount_minor: z.coerce.bigint().min(0n), percent_bps: z.coerce.number().int().min(1).max(10000) }) },
    async ({ actor, db, query }) => {
      await myPartner(db, actor, false);
      const s = share(query.amount_minor, query.percent_bps);
      return { amount_minor: query.amount_minor.toString(), percent_bps: query.percent_bps, share_minor: s.toString(), left_minor: (query.amount_minor - s).toString() };
    });

  route(app, deps, { method: 'PUT', url: '/partner/charity/rule', tags: P, summary: 'Turn on / change my automatic share (explicit consent; applies to FUTURE available commissions only)',
    body: z.object({ consent: z.literal(true), percent_bps: z.number().int().min(1).max(10000), fund_id: z.string().uuid().optional(), monthly_cap_minor: z.coerce.number().int().min(1).optional(), starts_at: z.string().datetime({ offset: true }).optional() }) },
  async ({ actor, db, body }) => {
    const p = await myPartner(db, actor);
    if (body.fund_id && !(await maybeOne(db, `SELECT 1 FROM charity_funds WHERE id=$1 AND status='approved'`, [body.fund_id]))) throw notFound('FUND');
    const r = await one<{ version: number }>(db, `INSERT INTO charity_rules (partner_id, fund_id, percent_bps, monthly_cap_minor, starts_at, status, consent_at, consent_text_version)
      VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, now()),'active', now(), $6)
      ON CONFLICT (partner_id) DO UPDATE SET fund_id=EXCLUDED.fund_id, percent_bps=EXCLUDED.percent_bps, monthly_cap_minor=EXCLUDED.monthly_cap_minor, starts_at=EXCLUDED.starts_at, status='active',
        consent_at=now(), consent_text_version=EXCLUDED.consent_text_version, version=charity_rules.version+1, updated_at=now() RETURNING version`,
      [p.id, body.fund_id ?? null, body.percent_bps, body.monthly_cap_minor ?? null, body.starts_at ?? null, CONSENT_VERSION]);
    await audit(db, actor, 'charity.rule_set', { type: 'partner', id: p.id }, { after: { ...body, version: r.version } });
    return { ok: true, version: r.version };
  });

  route(app, deps, { method: 'POST', url: '/partner/charity/rule/:action', tags: P, summary: 'Pause / resume / cancel my automatic share (past entries never change)', params: z.object({ action: z.enum(['pause', 'resume', 'cancel']) }) },
    async ({ actor, db, params }) => {
      const p = await myPartner(db, actor, false);
      const to = params.action === 'pause' ? 'paused' : params.action === 'resume' ? 'active' : 'canceled';
      const r = await db.query(`UPDATE charity_rules SET status=$2, version=version+1, updated_at=now() WHERE partner_id=$1 AND status <> 'canceled' RETURNING version`, [p.id, to]);
      if (!r.rowCount) throw conflict('NO_ACTIVE_RULE');
      await audit(db, actor, `charity.rule_${params.action}`, { type: 'partner', id: p.id }, {});
      return { ok: true, status: to };
    });

  // ---------------- Admin ----------------
  route(app, deps, { method: 'GET', url: '/admin/charity/center', tags: A, summary: 'Funds, collected vs disbursed, pending disbursements, recent gifts (no customer data)' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    return {
      funds: await many(db, `SELECT f.*, (SELECT COALESCE(SUM(amount_minor),0)::text FROM charity_donations d WHERE d.fund_id=f.id AND d.status='transferred_to_fund') AS collected_minor,
        (SELECT COALESCE(SUM(amount_minor),0)::text FROM charity_handovers h WHERE h.fund_id=f.id AND h.status='disbursed') AS disbursed_minor FROM charity_funds f ORDER BY f.created_at DESC`),
      totals: await one(db, `SELECT (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations WHERE status='transferred_to_fund')::text AS collected,
        (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers WHERE status='disbursed')::text AS disbursed,
        (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers WHERE status='disbursement_pending')::text AS pending,
        (SELECT COUNT(*) FROM charity_rules WHERE status='active')::int AS active_rules`),
      disbursements: await many(db, `SELECT h.*, f.name AS fund FROM charity_handovers h LEFT JOIN charity_funds f ON f.id=h.fund_id ORDER BY h.created_at DESC LIMIT 50`),
    };
  });

  route(app, deps, { method: 'POST', url: '/admin/charity/funds', tags: A, summary: 'Create a fund (draft)', body: z.object({ name: z.string().trim().min(3).max(160), recipient_org: z.string().max(200).optional(), requisites: z.string().max(500).optional(), purpose: z.string().max(1000).optional(), legal_basis: z.string().max(500).optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage');
      const f = await one<{ id: string }>(db, `INSERT INTO charity_funds (name, recipient_org, requisites, purpose, legal_basis, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [body.name, body.recipient_org ?? null, body.requisites ?? null, body.purpose ?? null, body.legal_basis ?? null, actor.userId]);
      await audit(db, actor, 'charity.fund_created', { type: 'charity_fund', id: f.id }, { after: body });
      return { id: f.id, status: 'draft' };
    });

  route(app, deps, { method: 'POST', url: '/admin/charity/funds/:id/status', tags: A, summary: 'Fund status: review → approved (owner) / paused / closed', params: zIdParam, body: z.object({ status: z.enum(['review', 'approved', 'paused', 'closed']) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      if (body.status === 'approved' && !isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
      const f = await maybeOne<any>(db, `SELECT status FROM charity_funds WHERE id=$1`, [params.id]);
      if (!f) throw notFound('FUND');
      if (body.status === 'approved' && !(await maybeOne(db, `SELECT 1 FROM charity_funds WHERE id=$1 AND recipient_org IS NOT NULL AND requisites IS NOT NULL`, [params.id]))) throw badRequest('FUND_RECIPIENT_REQUIRED');
      await db.query(`UPDATE charity_funds SET status=$2, approved_by=CASE WHEN $2='approved' THEN $3::uuid ELSE approved_by END, approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END, updated_at=now() WHERE id=$1`, [params.id, body.status, actor.userId]);
      await audit(db, actor, 'charity.fund_status', { type: 'charity_fund', id: params.id }, { before: { status: f.status }, after: { status: body.status } });
      return { ok: true };
    });

  // Disbursement = handing money to the recipient. Pending until proof; big amounts need a second approver.
  route(app, deps, { method: 'POST', url: '/admin/charity/disbursements', tags: A, summary: 'Plan a disbursement to the recipient (pending until proof)', body: z.object({ fund_id: z.string().uuid(), amount_minor: z.coerce.number().int().min(1), recipient: z.string().trim().min(3).max(200), note: z.string().max(500).optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('charity:disburse'))`);
        const f = await maybeOne<any>(tx, `SELECT status FROM charity_funds WHERE id=$1`, [body.fund_id]);
        if (!f || f.status !== 'approved') throw conflict('FUND_NOT_APPROVED');
        const bal = await one<{ v: string }>(tx, `SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations WHERE status='transferred_to_fund') - (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers WHERE status IN ('disbursed','disbursement_pending')))::text AS v`);
        if (BigInt(bal.v) < BigInt(body.amount_minor)) throw new AppError(422, 'FUND_BALANCE_INSUFFICIENT', { available_minor: bal.v });
        const h = await one<{ id: string }>(tx, `INSERT INTO charity_handovers (amount_minor, recipient, note, created_by, fund_id, status) VALUES ($1,$2,$3,$4,$5,'disbursement_pending') RETURNING id`, [body.amount_minor, body.recipient, body.note ?? null, actor.userId, body.fund_id]);
        await audit(tx, actor, 'charity.disbursement_planned', { type: 'charity_handover', id: h.id }, { after: body });
        return { id: h.id, status: 'disbursement_pending', second_approval_required: BigInt(body.amount_minor) >= BIG_DISBURSEMENT_MINOR };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/charity/disbursements/:id/confirm', tags: A, summary: 'Confirm the bank transfer with proof (second approver for big amounts)', params: zIdParam, body: z.object({ proof: z.string().trim().min(5).max(500) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const h = await maybeOne<any>(tx, `SELECT * FROM charity_handovers WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!h) throw notFound('DISBURSEMENT');
        if (h.status !== 'disbursement_pending') throw conflict('DISBURSEMENT_NOT_PENDING');
        if (BigInt(h.amount_minor) >= BIG_DISBURSEMENT_MINOR) {
          if (!h.approved_by) { await tx.query(`UPDATE charity_handovers SET approved_by=$2 WHERE id=$1`, [params.id, actor.userId]); return { ok: true, status: 'disbursement_pending', waiting_for: 'second_approver' }; }
          if (h.approved_by === actor.userId || h.created_by === actor.userId) throw new AppError(403, 'SECOND_APPROVER_MUST_DIFFER');
          await tx.query(`UPDATE charity_handovers SET second_approved_by=$2 WHERE id=$1`, [params.id, actor.userId]);
        } else await tx.query(`UPDATE charity_handovers SET approved_by=$2 WHERE id=$1`, [params.id, actor.userId]);
        await tx.query(`UPDATE charity_handovers SET status='disbursed', proof=$2, disbursed_at=now() WHERE id=$1`, [params.id, body.proof]);
        await audit(tx, actor, 'charity.disbursed', { type: 'charity_handover', id: params.id }, { after: { proof: body.proof } });
        return { ok: true, status: 'disbursed' };
      });
    });
}
