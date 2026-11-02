import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { transfer } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { notifyPartner } from '../notifications/telegram.js';
import { BUCKET_SQL } from './cabinet.js';
import { myPartner } from './routes.js';

/**
 * Partner programs (owner-defined rules, never hard-coded amounts):
 *  - contests: window + metric + prizes; live leaderboard; finish freezes results; prizes paid as bonus awards
 *  - bonus rules: "N delivered orders per week/month → X so'm"; owner previews and awards per period (idempotent)
 *  - penalties: owner-defined reasons; amount taken from available, remainder recorded as visible debt; cancellable
 *  - charity box: partners donate from available balance; owner records hand-overs; totals are public to partners
 * Every money effect = partner_ledger transfer (unique effect key) + balanced journal entry.
 */
const TZ = `'Asia/Tashkent'`;
const zMinor = z.string().regex(/^[1-9]\d{0,15}$/);
const zPeriodKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Delivered orders and sales per partner in [from, to). */
async function deliveredBetween(q: Tx | Deps['db'], from: string, to: string, partnerId?: string) {
  const params: unknown[] = [from, to];
  let f = '';
  if (partnerId) { params.push(partnerId); f = 'AND o.attributed_partner_id=$3'; }
  return many<{ pid: string; delivered: number; sales: string }>(q, `
    SELECT o.attributed_partner_id AS pid, COUNT(*)::int AS delivered, COALESCE(SUM(o.payable_minor),0)::text AS sales
      FROM orders o WHERE o.attributed_partner_id IS NOT NULL AND ${BUCKET_SQL}='delivered'
       AND COALESCE(o.delivered_at, o.created_at) >= $1::timestamptz AND COALESCE(o.delivered_at, o.created_at) < $2::timestamptz ${f}
     GROUP BY 1`, params);
}

function periodRange(period: 'week' | 'month', key: string): { from: string; to: string } {
  const start = new Date(`${key}T00:00:00+05:00`);
  if (Number.isNaN(start.getTime())) throw badRequest('PERIOD_KEY_INVALID');
  const end = new Date(start);
  if (period === 'month') { if (start.getUTCDate() !== 1 && key.slice(8) !== '01') throw badRequest('PERIOD_KEY_MONTH_START'); end.setMonth(end.getMonth() + 1); } else end.setDate(end.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Current period key (Tashkent) for a rule: month → YYYY-MM-01, week → Monday YYYY-MM-DD. */
export function currentPeriodKey(period: 'week' | 'month', now = new Date()): string {
  const local = new Date(now.getTime() + 5 * 3600_000);
  if (period === 'month') return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const dow = (local.getUTCDay() + 6) % 7; // Monday=0
  const mon = new Date(local.getTime() - dow * 86400_000);
  return mon.toISOString().slice(0, 10);
}

async function contestBoard(q: Tx | Deps['db'], c: { starts_at: string; ends_at: string; metric: string; min_delivered: number }) {
  const rows = await many<{ pid: string; display_name: string; delivered: number; sales: string }>(q, `
    SELECT o.attributed_partner_id AS pid, pa.display_name, COUNT(*)::int AS delivered, COALESCE(SUM(o.payable_minor),0)::text AS sales
      FROM orders o JOIN partners pa ON pa.id=o.attributed_partner_id
     WHERE ${BUCKET_SQL}='delivered' AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1, 2`, [c.starts_at, c.ends_at]);
  return rows.filter((r) => r.delivered >= c.min_delivered)
    .map((r) => ({ ...r, score: c.metric === 'delivered_sales' ? r.sales : String(r.delivered) }))
    .sort((a, b) => (BigInt(b.score) > BigInt(a.score) ? 1 : BigInt(b.score) < BigInt(a.score) ? -1 : b.delivered - a.delivered))
    .map((r, i) => ({ rank: i + 1, ...r }));
}

const mask = (s: string) => { const a = Array.from(s.trim()); return a.length <= 2 ? `${a[0] ?? ''}*` : `${a.slice(0, 2).join('')}${'*'.repeat(Math.min(4, a.length - 2))}`; };

async function awardBonus(tx: Tx, a: { partnerId: string; source: 'rule' | 'manual' | 'contest'; ruleId?: string; contestId?: string; periodKey?: string; amount: bigint; reason: string; actorId: string | null }): Promise<string | null> {
  const r = await tx.query(
    `INSERT INTO bonus_awards (partner_id, source, rule_id, contest_id, period_key, amount_minor, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
    [a.partnerId, a.source, a.ruleId ?? null, a.contestId ?? null, a.periodKey ?? null, a.amount.toString(), a.reason, a.actorId]);
  const id = r.rows[0]?.id as string | undefined;
  if (!id) return null; // already awarded for this rule/period or contest
  await transfer(tx, { partnerId: a.partnerId, from: 'external', to: 'available', amount: a.amount, sourceType: 'bonus', sourceId: id, effectKey: 'v1', reason: a.reason, actorId: a.actorId });
  await postJournal(tx, `bonus:${id}`, 'partner_bonus', [{ account: 'bonus_expense', debit: a.amount }, { account: 'partner_payable', credit: a.amount }]);
  await notifyPartner(tx, a.partnerId, a.source === 'contest' ? 'partner.contest_prize' : 'partner.bonus', { amount_minor: a.amount.toString(), reason: a.reason }, `p:bonus:${id}`);
  return id;
}

export function registerPartnerPrograms(app: FastifyInstance, deps: Deps): void {
  const A = ['admin'];
  const P = ['partner'];

  // ---------------- Partner side ----------------
  route(app, deps, { method: 'GET', url: '/partner/programs', tags: P, summary: 'Contests (with my rank), bonus rules (my progress), my bonuses, penalties, charity' }, async ({ actor, db }) => {
    const me = await myPartner(db, actor, false);
    const contests = await many<any>(db, `SELECT id, title, description, starts_at, ends_at, metric, min_delivered, prizes, status, results FROM contests WHERE status IN ('active','finished') AND (status='active' OR finished_at > now() - interval '60 days') ORDER BY status, ends_at DESC LIMIT 20`);
    const outContests = [];
    for (const c of contests) {
      const board = c.status === 'finished' && c.results ? (c.results as any[]) : await contestBoard(db, c);
      const mine = board.find((r: any) => r.pid === me.id);
      outContests.push({ id: c.id, title: c.title, description: c.description, starts_at: c.starts_at, ends_at: c.ends_at, metric: c.metric, min_delivered: c.min_delivered, prizes: c.prizes, status: c.status,
        top: board.slice(0, 10).map((r: any) => ({ rank: r.rank, name: r.pid === me.id ? r.display_name : mask(r.display_name), score: r.score, delivered: r.delivered, me: r.pid === me.id })),
        me: mine ? { rank: mine.rank, score: mine.score, delivered: mine.delivered } : null });
    }
    const rules = await many<any>(db, `SELECT id, name, period, threshold_delivered, amount_minor::text FROM bonus_rules WHERE active ORDER BY period, threshold_delivered`);
    const outRules = [];
    for (const r of rules) {
      const key = currentPeriodKey(r.period);
      const range = periodRange(r.period, key);
      const d = (await deliveredBetween(db, range.from, range.to, me.id))[0];
      const got = await maybeOne(db, `SELECT 1 FROM bonus_awards WHERE rule_id=$1 AND partner_id=$2 AND period_key=$3`, [r.id, me.id, key]);
      outRules.push({ ...r, period_key: key, period_ends: range.to, delivered: d?.delivered ?? 0, awarded: !!got });
    }
    const bonuses = await many(db, `SELECT id, source, amount_minor::text, reason, created_at FROM bonus_awards WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 100`, [me.id]);
    const penalties = await many(db, `SELECT id, reason_text, amount_minor::text, note, status, created_at, cancel_reason FROM penalties WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 100`, [me.id]);
    const reasons = await many(db, `SELECT name, description, default_amount_minor::text FROM penalty_reasons WHERE active ORDER BY name`);
    const charity = await one<{ mine: string; total: string; handed: string }>(db, `
      SELECT (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations WHERE partner_id=$1)::text AS mine,
             (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations)::text AS total,
             (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers)::text AS handed`, [me.id]);
    const handovers = await many(db, `SELECT amount_minor::text, recipient, note, created_at FROM charity_handovers ORDER BY created_at DESC LIMIT 20`);
    return { contests: outContests, bonus_rules: outRules, bonuses, penalties, penalty_reasons: reasons, charity: { ...charity, handovers } };
  });

  route(app, deps, { method: 'POST', url: '/partner/charity', tags: P, summary: 'Donate from my available balance to the charity box', body: z.object({ amount_minor: zMinor }) }, async ({ actor, db, body, idempotencyKey }) => {
    const me = await myPartner(db, actor);
    if (!idempotencyKey) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
    return withTx(db, async (tx) => {
      const amt = BigInt(body.amount_minor);
      const exists = await maybeOne<{ id: string }>(tx, `SELECT source_id AS id FROM partner_ledger WHERE source_type='charity' AND effect_key=$1 AND partner_id=$2`, [`k:${idempotencyKey}`, me.id]);
      if (exists) return { id: exists.id, replayed: true };
      const bal = await one<{ available_minor: string }>(tx, `SELECT available_minor::text FROM partner_balances WHERE partner_id=$1 FOR UPDATE`, [me.id]).catch(() => ({ available_minor: '0' }));
      if (BigInt(bal.available_minor) < amt) throw new AppError(422, 'INSUFFICIENT_AVAILABLE');
      const d = await one<{ id: string }>(tx, `INSERT INTO charity_donations (partner_id, amount_minor) VALUES ($1,$2) RETURNING id`, [me.id, amt.toString()]);
      await transfer(tx, { partnerId: me.id, from: 'available', to: 'external', amount: amt, sourceType: 'charity', sourceId: d.id, effectKey: `k:${idempotencyKey}`, reason: 'hayriya qutisi', actorId: actor.userId });
      await postJournal(tx, `charity:${d.id}`, 'charity_donation', [{ account: 'partner_payable', debit: amt }, { account: 'charity_fund', credit: amt }]);
      await audit(tx, actor, 'charity.donated', { type: 'partner', id: me.id }, { after: { amount_minor: amt.toString() } });
      return { id: d.id };
    });
  });

  // ---------------- Owner side ----------------
  route(app, deps, { method: 'GET', url: '/admin/programs', tags: A, summary: 'All programs: contests (live boards), bonus rules, penalty reasons, recent penalties/bonuses, charity totals' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    const contests = await many<any>(db, `SELECT * FROM contests ORDER BY created_at DESC LIMIT 30`);
    for (const c of contests) c.board = (c.status === 'finished' && c.results ? c.results : await contestBoard(db, c)).slice(0, 20);
    return {
      contests,
      bonus_rules: await many(db, `SELECT id, name, period, threshold_delivered, amount_minor::text, active, created_at FROM bonus_rules ORDER BY active DESC, created_at DESC`),
      penalty_reasons: await many(db, `SELECT id, name, description, default_amount_minor::text, active FROM penalty_reasons ORDER BY active DESC, name`),
      penalties: await many(db, `SELECT pe.id, pe.reason_text, pe.amount_minor::text, pe.note, pe.status, pe.created_at, pa.display_name, pa.code FROM penalties pe JOIN partners pa ON pa.id=pe.partner_id ORDER BY pe.created_at DESC LIMIT 50`),
      bonuses: await many(db, `SELECT b.id, b.source, b.amount_minor::text, b.reason, b.created_at, pa.display_name, pa.code FROM bonus_awards b JOIN partners pa ON pa.id=b.partner_id ORDER BY b.created_at DESC LIMIT 50`),
      charity: await one(db, `SELECT (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations)::text AS total, (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers)::text AS handed, (SELECT COUNT(DISTINCT partner_id) FROM charity_donations)::int AS donors`),
      handovers: await many(db, `SELECT id, amount_minor::text, recipient, note, created_at FROM charity_handovers ORDER BY created_at DESC LIMIT 20`),
      partners: await many(db, `SELECT id, code, display_name FROM partners WHERE status IN ('active','suspended') ORDER BY display_name`),
    };
  });

  route(app, deps, {
    method: 'POST', url: '/admin/contests', tags: A, summary: 'Create contest (window, metric, prizes)',
    body: z.object({ title: z.string().trim().min(3).max(120), description: z.string().max(2000).optional(), starts_at: z.string().datetime(), ends_at: z.string().datetime(), metric: z.enum(['delivered_orders', 'delivered_sales']), min_delivered: z.number().int().min(0).max(100000).default(1),
      prizes: z.array(z.object({ place: z.number().int().min(1).max(100), text: z.string().max(200).optional(), amount_minor: zMinor.optional() })).max(20).default([]) }),
  }, async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage');
    if (new Date(body.ends_at) <= new Date(body.starts_at)) throw badRequest('CONTEST_WINDOW_INVALID');
    const r = await one<{ id: string }>(db, `INSERT INTO contests (title, description, starts_at, ends_at, metric, min_delivered, prizes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [body.title, body.description ?? null, body.starts_at, body.ends_at, body.metric, body.min_delivered, JSON.stringify(body.prizes), actor.userId]);
    await audit(db, actor, 'contest.created', { type: 'contest', id: r.id }, { after: body });
    return r;
  });

  route(app, deps, { method: 'POST', url: '/admin/contests/:id/finish', tags: A, summary: 'Finish contest: freeze results (winners)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    return withTx(db, async (tx) => {
      const c = await maybeOne<any>(tx, `SELECT * FROM contests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CONTEST');
      if (c.status !== 'active') throw conflict('CONTEST_NOT_ACTIVE');
      const board = await contestBoard(tx, c);
      await tx.query(`UPDATE contests SET status='finished', results=$2, finished_at=now() WHERE id=$1`, [params.id, JSON.stringify(board)]);
      await audit(tx, actor, 'contest.finished', { type: 'contest', id: params.id }, { after: { winners: board.slice(0, (c.prizes as any[]).length || 3).map((b) => ({ rank: b.rank, partner_id: b.pid, score: b.score })) } });
      return { ok: true, winners: board.slice(0, 10) };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/contests/:id/pay-prizes', tags: A, summary: 'Credit money prizes of a finished contest to winners (idempotent)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const c = await maybeOne<any>(tx, `SELECT * FROM contests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CONTEST');
      if (c.status !== 'finished' || !c.results) throw conflict('CONTEST_NOT_FINISHED');
      let paid = 0;
      for (const prize of c.prizes as { place: number; text?: string; amount_minor?: string }[]) {
        const w = (c.results as any[]).find((r) => r.rank === prize.place);
        if (!w || !prize.amount_minor) continue;
        if (await awardBonus(tx, { partnerId: w.pid, source: 'contest', contestId: c.id, amount: BigInt(prize.amount_minor), reason: `Konkurs «${c.title}» — ${prize.place}-o‘rin`, actorId: actor.userId })) paid++;
      }
      await tx.query(`UPDATE contests SET prizes_paid_at=COALESCE(prizes_paid_at, now()) WHERE id=$1`, [c.id]);
      return { ok: true, paid };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/contests/:id/cancel', tags: A, summary: 'Cancel an active contest', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    const r = await db.query(`UPDATE contests SET status='cancelled', finished_at=now() WHERE id=$1 AND status='active' RETURNING id`, [params.id]);
    if (!r.rowCount) throw conflict('CONTEST_NOT_ACTIVE');
    await audit(db, actor, 'contest.cancelled', { type: 'contest', id: params.id });
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/bonus-rules', tags: A, summary: 'Create bonus rule: N delivered per week/month → amount',
    body: z.object({ name: z.string().trim().min(3).max(120), period: z.enum(['week', 'month']), threshold_delivered: z.number().int().min(1).max(100000), amount_minor: zMinor }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage');
    const r = await one<{ id: string }>(db, `INSERT INTO bonus_rules (name, period, threshold_delivered, amount_minor, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [body.name, body.period, body.threshold_delivered, body.amount_minor, actor.userId]);
    await audit(db, actor, 'bonus_rule.created', { type: 'bonus_rule', id: r.id }, { after: body });
    return r;
  });

  route(app, deps, { method: 'POST', url: '/admin/bonus-rules/:id/active', tags: A, summary: 'Enable/disable bonus rule', params: zIdParam, body: z.object({ active: z.boolean() }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'partners.manage');
    const r = await db.query(`UPDATE bonus_rules SET active=$2 WHERE id=$1 RETURNING id`, [params.id, body.active]);
    if (!r.rowCount) throw notFound('BONUS_RULE');
    await audit(db, actor, 'bonus_rule.active', { type: 'bonus_rule', id: params.id }, { after: body });
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/admin/bonus-rules/:id/preview', tags: A, summary: 'Who qualifies for a period (YYYY-MM-DD period start)', params: zIdParam, query: z.object({ period_key: zPeriodKey.optional() }) },
    async ({ actor, db, params, query }) => {
      requirePerm(actor, 'partners.manage');
      const r = await maybeOne<any>(db, `SELECT * FROM bonus_rules WHERE id=$1`, [params.id]);
      if (!r) throw notFound('BONUS_RULE');
      const key = query.period_key ?? currentPeriodKey(r.period);
      const range = periodRange(r.period, key);
      const rows = await deliveredBetween(db, range.from, range.to);
      const awarded = new Set((await many<{ partner_id: string }>(db, `SELECT partner_id FROM bonus_awards WHERE rule_id=$1 AND period_key=$2`, [r.id, key])).map((x) => x.partner_id));
      const names = Object.fromEntries((await many<{ id: string; display_name: string; code: string }>(db, `SELECT id, display_name, code FROM partners`)).map((p) => [p.id, p]));
      return { period_key: key, period_ends: range.to, closed: new Date(range.to) <= new Date(), items: rows.filter((x) => x.delivered >= r.threshold_delivered).map((x) => ({ partner_id: x.pid, name: names[x.pid]?.display_name, code: names[x.pid]?.code, delivered: x.delivered, awarded: awarded.has(x.pid) })) };
    });

  route(app, deps, { method: 'POST', url: '/admin/bonus-rules/:id/award', tags: A, summary: 'Award the rule bonus to everyone who qualified in a period (idempotent per partner+period)', params: zIdParam, body: z.object({ period_key: zPeriodKey }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const r = await maybeOne<any>(tx, `SELECT * FROM bonus_rules WHERE id=$1`, [params.id]);
        if (!r) throw notFound('BONUS_RULE');
        const range = periodRange(r.period, body.period_key);
        let awarded = 0;
        for (const x of (await deliveredBetween(tx, range.from, range.to)).filter((y) => y.delivered >= r.threshold_delivered)) {
          if (await awardBonus(tx, { partnerId: x.pid, source: 'rule', ruleId: r.id, periodKey: body.period_key, amount: BigInt(r.amount_minor), reason: `${r.name} (${body.period_key}, ${x.delivered} ta yetkazilgan)`, actorId: actor.userId })) awarded++;
        }
        await audit(tx, actor, 'bonus_rule.awarded', { type: 'bonus_rule', id: r.id }, { after: { period_key: body.period_key, awarded } });
        return { ok: true, awarded };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/bonuses', tags: A, summary: 'Manual bonus to a partner', body: z.object({ partner_id: z.string().uuid(), amount_minor: zMinor, reason: z.string().trim().min(3).max(300) }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        if (!(await maybeOne(tx, `SELECT 1 FROM partners WHERE id=$1`, [body.partner_id]))) throw notFound('PARTNER');
        const id = await awardBonus(tx, { partnerId: body.partner_id, source: 'manual', amount: BigInt(body.amount_minor), reason: body.reason, actorId: actor.userId });
        await audit(tx, actor, 'bonus.manual', { type: 'partner', id: body.partner_id }, { after: { amount_minor: body.amount_minor }, reason: body.reason });
        return { id };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/penalty-reasons', tags: A, summary: 'Define a penalty reason (shown to partners as rules)', body: z.object({ name: z.string().trim().min(3).max(120), description: z.string().max(500).optional(), default_amount_minor: zMinor.optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage');
      const r = await one<{ id: string }>(db, `INSERT INTO penalty_reasons (name, description, default_amount_minor) VALUES ($1,$2,$3) RETURNING id`, [body.name, body.description ?? null, body.default_amount_minor ?? null]);
      await audit(db, actor, 'penalty_reason.created', { type: 'penalty_reason', id: r.id }, { after: body });
      return r;
    });

  route(app, deps, { method: 'POST', url: '/admin/penalty-reasons/:id/active', tags: A, summary: 'Enable/disable penalty reason', params: zIdParam, body: z.object({ active: z.boolean() }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'partners.manage');
    const r = await db.query(`UPDATE penalty_reasons SET active=$2 WHERE id=$1 RETURNING id`, [params.id, body.active]);
    if (!r.rowCount) throw notFound('PENALTY_REASON');
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/penalties', tags: A, summary: 'Apply a penalty: taken from available, remainder recorded as debt',
    body: z.object({ partner_id: z.string().uuid(), reason_id: z.string().uuid().optional(), reason_text: z.string().trim().min(3).max(300).optional(), amount_minor: zMinor, order_number: z.string().max(40).optional(), note: z.string().max(500).optional() }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      if (!(await maybeOne(tx, `SELECT 1 FROM partners WHERE id=$1`, [body.partner_id]))) throw notFound('PARTNER');
      const reason = body.reason_id ? await maybeOne<{ name: string }>(tx, `SELECT name FROM penalty_reasons WHERE id=$1`, [body.reason_id]) : null;
      if (body.reason_id && !reason) throw notFound('PENALTY_REASON');
      const text = reason?.name ?? body.reason_text;
      if (!text) throw badRequest('PENALTY_REASON_REQUIRED');
      const order = body.order_number ? await maybeOne<{ id: string }>(tx, `SELECT id FROM orders WHERE number=$1 AND attributed_partner_id=$2`, [body.order_number, body.partner_id]) : null;
      if (body.order_number && !order) throw notFound('ORDER');
      const amt = BigInt(body.amount_minor);
      await tx.query(`INSERT INTO partner_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [body.partner_id]);
      const bal = await one<{ available_minor: string }>(tx, `SELECT available_minor::text FROM partner_balances WHERE partner_id=$1 FOR UPDATE`, [body.partner_id]);
      const fromAvail = BigInt(bal.available_minor) >= amt ? amt : BigInt(bal.available_minor);
      const toDebt = amt - fromAvail;
      const pe = await one<{ id: string }>(tx, `INSERT INTO penalties (partner_id, reason_id, reason_text, amount_minor, from_available_minor, to_debt_minor, order_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [body.partner_id, body.reason_id ?? null, text, amt.toString(), fromAvail.toString(), toDebt.toString(), order?.id ?? null, body.note ?? null, actor.userId]);
      await transfer(tx, { partnerId: body.partner_id, from: 'available', to: 'external', amount: fromAvail, sourceType: 'penalty', sourceId: pe.id, effectKey: 'v1:available', reason: text, actorId: actor.userId });
      await transfer(tx, { partnerId: body.partner_id, from: 'debt', to: 'external', amount: toDebt, sourceType: 'penalty', sourceId: pe.id, effectKey: 'v1:debt', reason: text, actorId: actor.userId });
      await postJournal(tx, `penalty:${pe.id}`, 'partner_penalty', [{ account: 'partner_payable', debit: amt }, { account: 'penalty_income', credit: amt }]);
      await notifyPartner(tx, body.partner_id, 'partner.penalty', { amount_minor: amt.toString(), reason: text }, `p:pen:${pe.id}`);
      await audit(tx, actor, 'penalty.applied', { type: 'partner', id: body.partner_id }, { after: { amount_minor: amt.toString(), from_available: fromAvail.toString(), to_debt: toDebt.toString() }, reason: text });
      return { id: pe.id, from_available_minor: fromAvail.toString(), to_debt_minor: toDebt.toString() };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/penalties/:id/cancel', tags: A, summary: 'Cancel a penalty (money returned exactly where it was taken from)', params: zIdParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const pe = await maybeOne<any>(tx, `SELECT * FROM penalties WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!pe) throw notFound('PENALTY');
        if (pe.status !== 'applied') throw conflict('PENALTY_NOT_APPLIED');
        await tx.query(`UPDATE penalties SET status='cancelled', cancelled_by=$2, cancelled_at=now(), cancel_reason=$3 WHERE id=$1`, [params.id, actor.userId, body.reason]);
        await transfer(tx, { partnerId: pe.partner_id, from: 'external', to: 'available', amount: BigInt(pe.from_available_minor), sourceType: 'penalty', sourceId: pe.id, effectKey: 'cancel:available', reason: body.reason, actorId: actor.userId });
        await transfer(tx, { partnerId: pe.partner_id, from: 'external', to: 'debt', amount: BigInt(pe.to_debt_minor), sourceType: 'penalty', sourceId: pe.id, effectKey: 'cancel:debt', reason: body.reason, actorId: actor.userId });
        await postJournal(tx, `penalty:${pe.id}:cancel`, 'partner_penalty_cancel', [{ account: 'penalty_income', debit: BigInt(pe.amount_minor) }, { account: 'partner_payable', credit: BigInt(pe.amount_minor) }]);
        await audit(tx, actor, 'penalty.cancelled', { type: 'partner', id: pe.partner_id }, { reason: body.reason });
        return { ok: true };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/charity/handovers', tags: A, summary: 'Record handing the charity fund to a recipient', body: z.object({ amount_minor: zMinor, recipient: z.string().trim().min(3).max(200), note: z.string().max(500).optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('charity_fund'))`);
        const t = await one<{ total: string; handed: string }>(tx, `SELECT (SELECT COALESCE(SUM(amount_minor),0) FROM charity_donations)::text AS total, (SELECT COALESCE(SUM(amount_minor),0) FROM charity_handovers)::text AS handed`);
        const amt = BigInt(body.amount_minor);
        if (BigInt(t.total) - BigInt(t.handed) < amt) throw new AppError(422, 'CHARITY_FUND_INSUFFICIENT');
        const h = await one<{ id: string }>(tx, `INSERT INTO charity_handovers (amount_minor, recipient, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [amt.toString(), body.recipient, body.note ?? null, actor.userId]);
        await postJournal(tx, `charity_handover:${h.id}`, 'charity_handover', [{ account: 'charity_fund', debit: amt }, { account: 'cash_bank', credit: amt }]);
        await audit(tx, actor, 'charity.handover', { type: 'charity', id: h.id }, { after: body });
        return h;
      });
    });
}
