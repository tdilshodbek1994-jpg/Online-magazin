import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { myPartner } from '../partners/routes.js';

/**
 * UZSHOP PRO — Quality Center (P0). Metrics are explained (numerator / denominator / period / sample); a low value is
 * only a SIGNAL for a human. Cases go through a reviewed workflow; warnings and restrictions are per case and
 * idempotent; money penalties stay blocked until an active policy has legal approval AND the feature flag is on.
 */
const A = ['admin', 'quality'];
const P = ['partner', 'quality'];
const TZ = 'Asia/Tashkent';
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
const OPEN = ['detected', 'triage', 'investigating', 'awaiting_partner_response', 'reviewed', 'appealed'];
const TRANSITIONS: Record<string, string[]> = {
  detected: ['triage', 'resolved_no_fault'], triage: ['investigating', 'resolved_no_fault'], investigating: ['awaiting_partner_response', 'reviewed'],
  awaiting_partner_response: ['reviewed'], reviewed: ['resolved_no_fault', 'confirmed_violation', 'inconclusive'],
  resolved_no_fault: ['final'], confirmed_violation: ['appealed', 'final'], inconclusive: ['final'], appealed: ['confirmed_violation', 'resolved_no_fault', 'final'],
};

export interface Rate { metric: string; numerator: number; denominator: number; value_pct: number | null; sample_size: number; period_days: number; timezone: string; excluded: Record<string, number>; complete: boolean; explain: string }
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Pure rates (Q01–Q04): pending never enters a denominator; shop/courier faults are reported separately. */
export function rates(c: { confirmed: number; resolved: number; pending: number; delivered: number; resolvedConfirmed: number; notPartnerFault: number; denied: number; checked: number; invalid: number; investigated: number }, days: number): Rate[] {
  const r = (metric: string, n: number, d: number, excluded: Record<string, number>, explain: string): Rate => ({ metric, numerator: n, denominator: d, value_pct: pct(n, d), sample_size: d, period_days: days, timezone: TZ, excluded, complete: (excluded.pending ?? 0) === 0, explain });
  return [
    r('confirmation_rate', c.confirmed, c.resolved, { pending: c.pending }, 'Tasdiqlangan / yakunlangan buyurtmalar (kutilayotganlar, dublikatlar va do‘kon sababli bekorlar kirmaydi)'),
    r('delivery_rate', c.delivered, c.resolvedConfirmed, { not_partner_fault: c.notPartnerFault }, 'Yetkazilgan / yakunlangan tasdiqlangan buyurtmalar (kuryer, ombor, operator aybi kirmaydi)'),
    r('customer_denial_rate', c.denied, c.checked, {}, '«Men buyurtma bermaganman» / mustaqil tekshirilgan buyurtmalar'),
    r('verified_invalid_rate', c.invalid, c.investigated, {}, 'Isbotlangan qoidabuzarlik (hamkor aybi) / ko‘rib chiqilgan holatlar'),
  ];
}

export async function partnerRates(q: Queryable, partnerId: string, days: number): Promise<Rate[]> {
  const o = await one<any>(q, `
    SELECT COUNT(*) FILTER (WHERE o.commercial_status IN ('confirmed','completed'))::int AS confirmed,
           COUNT(*) FILTER (WHERE o.commercial_status <> 'awaiting_confirmation' AND COALESCE(o.cancel_reason,'') NOT IN ('duplicate','out_of_stock'))::int AS resolved,
           COUNT(*) FILTER (WHERE o.commercial_status = 'awaiting_confirmation')::int AS pending,
           COUNT(*) FILTER (WHERE o.fulfillment_status IN ('delivered','returned'))::int AS delivered,
           COUNT(*) FILTER (WHERE o.commercial_status IN ('confirmed','completed') AND (o.fulfillment_status IN ('delivered','returned') OR (o.fulfillment_status='failed' AND s.failure_fault='customer')))::int AS resolved_confirmed,
           COUNT(*) FILTER (WHERE o.fulfillment_status='failed' AND COALESCE(s.failure_fault,'other') <> 'customer')::int AS not_partner_fault
      FROM orders o LEFT JOIN shipments s ON s.order_id=o.id
     WHERE o.attributed_partner_id=$1 AND o.created_at > now() - make_interval(days => $2)`, [partnerId, days]);
  const v = await one<any>(q, `
    SELECT COUNT(*) FILTER (WHERE c.status='denied' OR (c.status='rejected' AND c.method IN ('customer_otp','customer_link')))::int AS denied,
           COUNT(*) FILTER (WHERE c.status IN ('verified','denied','rejected'))::int AS checked
      FROM order_confirmations c JOIN orders o ON o.id=c.order_id
     WHERE o.attributed_partner_id=$1 AND o.created_at > now() - make_interval(days => $2) AND c.method IN ('customer_otp','customer_link','operator_call')`, [partnerId, days]);
  const k = await one<any>(q, `
    SELECT COUNT(*) FILTER (WHERE status IN ('confirmed_violation','final') AND fault='partner')::int AS invalid,
           COUNT(*) FILTER (WHERE status IN ('resolved_no_fault','confirmed_violation','inconclusive','final','appealed'))::int AS investigated
      FROM quality_cases WHERE partner_id=$1 AND created_at > now() - make_interval(days => $2)`, [partnerId, days]);
  return rates({ confirmed: o.confirmed, resolved: o.resolved, pending: o.pending, delivered: o.delivered, resolvedConfirmed: o.resolved_confirmed, notPartnerFault: o.not_partner_fault, denied: v.denied, checked: v.checked, invalid: k.invalid, investigated: k.investigated }, days);
}

/** Signal check against ONE metric chosen by the admin policy; small samples never produce a signal (Q04). */
export function signalFor(rate: Rate, policy: { metric: string; threshold_pct: number | string; min_sample: number }): { signal: boolean; reason: string } {
  if (rate.metric !== policy.metric) return { signal: false, reason: 'other_metric' };
  if (rate.sample_size < policy.min_sample) return { signal: false, reason: 'insufficient_sample' };
  if (rate.value_pct === null) return { signal: false, reason: 'no_data' };
  const t = Number(policy.threshold_pct);
  const lowIsBad = rate.metric === 'confirmation_rate' || rate.metric === 'delivery_rate';
  return (lowIsBad ? rate.value_pct < t : rate.value_pct > t) ? { signal: true, reason: 'threshold' } : { signal: false, reason: 'ok' };
}

export async function activePolicy(q: Queryable) {
  return maybeOne<any>(q, `SELECT * FROM quality_policies WHERE status='active' AND effective_date <= now() ORDER BY version DESC LIMIT 1`);
}

/** Q13: money penalties need the flag AND an active policy with monetary_enabled and legal approval. */
export async function assertMonetaryPenaltyAllowed(q: Queryable): Promise<void> {
  const f = await maybeOne<{ enabled: boolean }>(q, `SELECT enabled FROM feature_flags WHERE key='quality.monetary_penalties'`);
  const p = await maybeOne<any>(q, `SELECT 1 FROM quality_policies WHERE status='active' AND monetary_enabled AND legal_approved_at IS NOT NULL AND effective_date <= now() LIMIT 1`);
  if (!f?.enabled || !p) throw new AppError(403, 'MONETARY_PENALTY_NOT_APPROVED');
}

/** Customer said "I did not order" on the independent confirmation: a case for a human (signal, not a verdict). */
export async function openDeniedCase(q: Queryable, orderId: string, via: string): Promise<void> {
  const o = await maybeOne<{ partner_id: string | null }>(q, `SELECT attributed_partner_id AS partner_id FROM orders WHERE id=$1`, [orderId]);
  if (!o?.partner_id) return;
  await q.query(`INSERT INTO quality_cases (partner_id, reason_code, order_ids, evidence, idem_key) VALUES ($1,'customer_denied',ARRAY[$2::uuid],$3,$4) ON CONFLICT (idem_key) DO NOTHING`,
    [o.partner_id, orderId, JSON.stringify([{ kind: via, at: new Date().toISOString() }]), `denied:${orderId}`]);
}

async function caseFor(q: Queryable, id: string, partnerId?: string) {
  const c = await maybeOne<any>(q, `SELECT * FROM quality_cases WHERE id=$1 ${partnerId ? 'AND partner_id=$2' : ''}`, partnerId ? [id, partnerId] : [id]);
  if (!c) throw notFound('CASE'); // Q17: another partner's case id looks like "not found"
  return c;
}

export function registerQualityCenter(app: FastifyInstance, deps: Deps): void {
  // ---------------- Admin ----------------
  route(app, deps, { method: 'GET', url: '/admin/quality/inbox', tags: A, summary: 'Risk inbox: partners whose policy metric crosses the threshold (with enough sample), same-phone signals, open cases' },
    async ({ actor, db }) => {
      requirePerm(actor, 'partners.manage');
      const policy = await activePolicy(db);
      const partners = await many<{ id: string; display_name: string; code: string }>(db, `SELECT id, display_name, code FROM partners WHERE status='active' ORDER BY created_at LIMIT 500`);
      const signals: any[] = [];
      if (policy) for (const p of partners) {
        const rs = await partnerRates(db, p.id, policy.period_days);
        const r = rs.find((x) => x.metric === policy.metric)!;
        const s = signalFor(r, policy);
        if (s.signal) signals.push({ kind: 'metric', partner: p, rate: r });
      }
      const phones = await many(db, `SELECT o.attributed_partner_id AS partner_id, p.display_name, p.code, COUNT(*)::int AS orders, COUNT(DISTINCT o.customer_phone)::int AS phones
          FROM orders o JOIN partners p ON p.id=o.attributed_partner_id WHERE o.created_at > now() - interval '30 days' AND o.customer_phone IS NOT NULL
         GROUP BY 1,2,3 HAVING COUNT(*) > COUNT(DISTINCT o.customer_phone) ORDER BY COUNT(*) - COUNT(DISTINCT o.customer_phone) DESC LIMIT 50`);
      const cases = await many(db, `SELECT c.id, c.partner_id, c.status, c.reason_code, c.fault, c.created_at, cardinality(c.order_ids) AS orders, p.display_name, p.code FROM quality_cases c JOIN partners p ON p.id=c.partner_id WHERE c.status = ANY($1::text[]) ORDER BY c.created_at DESC LIMIT 100`, [OPEN]);
      return { policy, signals, same_phone: phones.map((x) => ({ ...x, note: 'Bitta telefon — bir oilaning haqiqiy buyurtmalari ham bo‘lishi mumkin; faqat tekshiruv signali.' })), open_cases: cases, note: 'Signal — ayb emas va avtomatik jarima emas.' };
    });

  route(app, deps, { method: 'GET', url: '/admin/quality/partners/:id', tags: A, summary: 'Partner quality: explained metrics, cases, warnings, restrictions', params: zIdParam, query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) },
    async ({ actor, db, params, query }) => {
      requirePerm(actor, 'partners.manage');
      const policy = await activePolicy(db);
      const rs = await partnerRates(db, params.id, query.days);
      return { rates: rs, policy, signal: policy ? signalFor(rs.find((x) => x.metric === policy.metric)!, policy) : null,
        cases: await many(db, `SELECT * FROM quality_cases WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 50`, [params.id]),
        warnings: await many(db, `SELECT * FROM quality_warnings WHERE partner_id=$1 ORDER BY created_at DESC`, [params.id]),
        restrictions: await many(db, `SELECT * FROM quality_restrictions WHERE partner_id=$1 ORDER BY created_at DESC`, [params.id]) };
    });

  route(app, deps, { method: 'POST', url: '/admin/quality/policies', tags: A, summary: 'New policy version (one metric, threshold, min sample). Money stays off until legal approval.',
    body: z.object({ metric: z.enum(['confirmation_rate', 'delivery_rate', 'customer_denial_rate', 'verified_invalid_rate']), threshold_pct: z.number().min(0).max(100), min_sample: z.number().int().min(1).default(20), period_days: z.number().int().min(1).max(365).default(30), contract_version: z.string().max(60).optional(), monetary_enabled: z.boolean().default(false), monetary_cap_minor: z.coerce.number().int().min(0).optional() }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    return withTx(db, async (tx) => {
      const v = (await one<{ v: number }>(tx, `SELECT COALESCE(MAX(version),0)+1 AS v FROM quality_policies`)).v;
      await tx.query(`UPDATE quality_policies SET status='retired' WHERE status='active'`);
      const p = await one<{ id: string }>(tx, `INSERT INTO quality_policies (version, metric, threshold_pct, min_sample, period_days, contract_version, monetary_enabled, monetary_cap_minor, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [v, body.metric, body.threshold_pct, body.min_sample, body.period_days, body.contract_version ?? null, body.monetary_enabled, body.monetary_cap_minor ?? null, actor.userId]);
      await audit(tx, actor, 'quality.policy_created', { type: 'quality_policy', id: p.id }, { after: { ...body, version: v } });
      return { id: p.id, version: v };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/quality/policies/:id/legal-approval', tags: A, summary: 'Record legal approval (owner) — required before any money penalty', params: zIdParam, body: z.object({ legal_reference: z.string().trim().min(5).max(300) }) },
    async ({ actor, db, params, body }) => {
      if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
      const r = await db.query(`UPDATE quality_policies SET legal_approved_by=$2, legal_approved_at=now(), legal_reference=$3 WHERE id=$1 RETURNING id`, [params.id, actor.userId, body.legal_reference]);
      if (!r.rowCount) throw notFound('POLICY');
      await audit(db, actor, 'quality.legal_approved', { type: 'quality_policy', id: params.id }, { after: { legal_reference: body.legal_reference } });
      return { ok: true };
    });

  route(app, deps, { method: 'POST', url: '/admin/quality/cases', tags: A, summary: 'Open a case from a signal (idempotent by idem_key)',
    body: z.object({ partner_id: z.string().uuid(), reason_code: z.enum(['low_metric', 'customer_denied', 'same_phone', 'wrong_address_repeat', 'unreachable_customers', 'many_returns', 'unusual_campaign', 'other']), order_ids: z.array(z.string().uuid()).max(200).default([]), evidence: z.array(z.record(z.string(), z.unknown())).max(50).default([]), idem_key: z.string().max(120).optional() }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage');
    const policy = await activePolicy(db);
    const r = await db.query(`INSERT INTO quality_cases (partner_id, reason_code, order_ids, evidence, policy_version, idem_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
      [body.partner_id, body.reason_code, body.order_ids, JSON.stringify(body.evidence), policy?.version ?? null, body.idem_key ?? null]);
    const id = r.rows[0]?.id ?? (await one<{ id: string }>(db, `SELECT id FROM quality_cases WHERE idem_key=$1`, [body.idem_key])).id;
    if (r.rowCount) await audit(db, actor, 'quality.case_opened', { type: 'quality_case', id }, { after: body });
    return { id, created: !!r.rowCount };
  });

  route(app, deps, { method: 'POST', url: '/admin/quality/cases/:id/transition', tags: A, summary: 'Move a case through the workflow (old/new, reason and actor audited)', params: zIdParam,
    body: z.object({ to: z.string(), reason: z.string().trim().min(3).max(1000), fault: z.enum(['partner', 'operator', 'warehouse', 'courier', 'customer', 'none']).optional(), expected_version: z.number().int() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'partners.manage');
    return withTx(db, async (tx) => {
      const c = await maybeOne<any>(tx, `SELECT * FROM quality_cases WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CASE');
      if (c.version !== body.expected_version) throw conflict('CASE_VERSION_CONFLICT');
      if (!(TRANSITIONS[c.status] ?? []).includes(body.to)) throw conflict('CASE_TRANSITION_INVALID', { from: c.status, allowed: TRANSITIONS[c.status] ?? [] });
      if (body.to === 'confirmed_violation' && !body.fault) throw badRequest('FAULT_REQUIRED');
      const fault = body.to === 'resolved_no_fault' ? 'none' : body.to === 'inconclusive' ? null : body.fault ?? c.fault;
      await tx.query(`UPDATE quality_cases SET status=$2, fault=$3, decision=$4, reviewer_id=$5, version=version+1, updated_at=now() WHERE id=$1`, [params.id, body.to, fault, body.reason, actor.userId]);
      await audit(tx, actor, 'quality.case_transition', { type: 'quality_case', id: params.id }, { before: { status: c.status, fault: c.fault }, after: { status: body.to, fault }, reason: body.reason });
      return { ok: true, status: body.to, fault };
    });
  });

  // First confirmed partner-fault violation => neutral warning with guidance; repeats escalate the level. One per case.
  route(app, deps, { method: 'POST', url: '/admin/quality/cases/:id/warning', tags: A, summary: 'Warning for a confirmed partner-fault violation (one per case)', params: zIdParam, body: z.object({ message: z.string().trim().min(10).max(1000) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      return withTx(db, async (tx) => {
        const c = await maybeOne<any>(tx, `SELECT * FROM quality_cases WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!c) throw notFound('CASE');
        if (!['confirmed_violation', 'final'].includes(c.status) || c.fault !== 'partner') throw conflict('WARNING_NEEDS_CONFIRMED_PARTNER_FAULT');
        const existing = await maybeOne<any>(tx, `SELECT id, level FROM quality_warnings WHERE case_id=$1`, [params.id]);
        if (existing) return { id: existing.id, level: existing.level, replayed: true }; // Q19
        const level = (await one<{ n: number }>(tx, `SELECT COUNT(*)::int + 1 AS n FROM quality_warnings WHERE partner_id=$1`, [c.partner_id])).n;
        const w = await one<{ id: string }>(tx, `INSERT INTO quality_warnings (partner_id, case_id, level, message, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [c.partner_id, params.id, level, body.message, actor.userId]);
        await audit(tx, actor, 'quality.warning', { type: 'quality_case', id: params.id }, { after: { level } });
        return { id: w.id, level };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/quality/cases/:id/restrictions', tags: A, summary: 'Time-limited restriction after a repeated, proven violation (needs an earlier warning)', params: zIdParam,
    body: z.object({ kind: z.enum(['extra_verification', 'assisted_orders_paused', 'contest_review']), days: z.number().int().min(1).max(90), reason: z.string().trim().min(5).max(500) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'partners.manage');
    return withTx(db, async (tx) => {
      const c = await maybeOne<any>(tx, `SELECT * FROM quality_cases WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CASE');
      if (!['confirmed_violation', 'final'].includes(c.status) || c.fault !== 'partner') throw conflict('RESTRICTION_NEEDS_CONFIRMED_PARTNER_FAULT');
      const earlier = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM quality_warnings WHERE partner_id=$1 AND case_id <> $2`, [c.partner_id, params.id]);
      if (!earlier.n) throw conflict('FIRST_TIME_IS_A_WARNING');
      const r = await tx.query(`INSERT INTO quality_restrictions (partner_id, case_id, kind, reason, ends_at, created_by) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6) ON CONFLICT (case_id, kind) DO NOTHING RETURNING id`,
        [c.partner_id, params.id, body.kind, body.reason, body.days, actor.userId]);
      if (r.rowCount) await audit(tx, actor, 'quality.restriction', { type: 'quality_case', id: params.id }, { after: body });
      return { id: r.rows[0]?.id ?? null, created: !!r.rowCount };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/quality/appeals/:id/resolve', tags: A, summary: 'Resolve a partner appeal', params: zIdParam, body: z.object({ status: z.enum(['upheld', 'overturned']), resolution: z.string().trim().min(3).max(1000) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      return withTx(db, async (tx) => {
        const a = await maybeOne<any>(tx, `UPDATE quality_appeals SET status=$2, resolution=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 AND status='open' RETURNING case_id`, [params.id, body.status, body.resolution, actor.userId]);
        if (!a) throw conflict('APPEAL_NOT_OPEN');
        const to = body.status === 'overturned' ? 'resolved_no_fault' : 'confirmed_violation';
        await tx.query(`UPDATE quality_cases SET status=$2, fault=CASE WHEN $2='resolved_no_fault' THEN 'none' ELSE fault END, version=version+1, updated_at=now() WHERE id=$1`, [a.case_id, to]);
        if (body.status === 'overturned') await tx.query(`UPDATE quality_restrictions SET lifted_at=now(), lifted_by=$2 WHERE case_id=$1 AND lifted_at IS NULL`, [a.case_id, actor.userId]);
        await audit(tx, actor, 'quality.appeal_resolved', { type: 'quality_appeal', id: params.id }, { after: { status: body.status, case_status: to }, reason: body.resolution });
        return { ok: true, case_status: to };
      });
    });

  // ---------------- Partner ----------------
  route(app, deps, { method: 'GET', url: '/partner/quality', tags: P, summary: 'My quality metrics (explained), warnings, restrictions and cases' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const policy = await activePolicy(db);
    const rs = await partnerRates(db, p.id, policy?.period_days ?? 30);
    return { rates: rs, policy: policy ? { metric: policy.metric, threshold_pct: policy.threshold_pct, min_sample: policy.min_sample, period_days: policy.period_days } : null,
      note: 'Past ko‘rsatkich avtomatik ayb yoki jarima emas — faqat tekshiruv uchun signal.',
      warnings: await many(db, `SELECT id, level, message, acknowledged_at, partner_response, created_at, case_id FROM quality_warnings WHERE partner_id=$1 ORDER BY created_at DESC`, [p.id]),
      restrictions: await many(db, `SELECT kind, reason, ends_at, lifted_at FROM quality_restrictions WHERE partner_id=$1 AND lifted_at IS NULL AND ends_at > now()`, [p.id]),
      cases: await many(db, `SELECT id, status, reason_code, created_at, decision, partner_response, cardinality(order_ids) AS orders FROM quality_cases WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 50`, [p.id]) };
  });

  route(app, deps, { method: 'POST', url: '/partner/quality/cases/:id/response', tags: P, summary: 'My explanation for a case', params: zIdParam, body: z.object({ text: z.string().trim().min(5).max(2000) }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor, false);
      await caseFor(db, params.id, p.id);
      await db.query(`UPDATE quality_cases SET partner_response=$2, updated_at=now() WHERE id=$1`, [params.id, body.text]);
      await db.query(`UPDATE quality_warnings SET partner_response=$2, acknowledged_at=COALESCE(acknowledged_at, now()) WHERE case_id=$1`, [params.id, body.text]);
      await audit(db, actor, 'quality.partner_response', { type: 'quality_case', id: params.id }, {});
      return { ok: true };
    });

  route(app, deps, { method: 'POST', url: '/partner/quality/cases/:id/appeal', tags: P, summary: 'Appeal a confirmed violation', params: zIdParam, body: z.object({ body: z.string().trim().min(5).max(2000) }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor, false);
      return withTx(db, async (tx) => {
        const c = await caseFor(tx, params.id, p.id);
        if (c.status !== 'confirmed_violation') throw conflict('APPEAL_NOT_ALLOWED', { status: c.status });
        const open = await maybeOne(tx, `SELECT 1 FROM quality_appeals WHERE case_id=$1 AND status='open'`, [params.id]);
        if (open) throw conflict('APPEAL_ALREADY_OPEN');
        const a = await one<{ id: string }>(tx, `INSERT INTO quality_appeals (case_id, partner_id, body) VALUES ($1,$2,$3) RETURNING id`, [params.id, p.id, body.body]);
        await tx.query(`UPDATE quality_cases SET status='appealed', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
        await audit(tx, actor, 'quality.appeal', { type: 'quality_case', id: params.id }, {});
        return { id: a.id, status: 'open' };
      });
    });
}
