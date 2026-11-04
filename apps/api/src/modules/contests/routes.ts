import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { awardBonus } from '../partners/programs.js';
import { myPartner } from '../partners/routes.js';
import { alias, desiredFacts, funnel, liveRanking, loadRules, type RankRow, rankRows, recompute, tashkentWeek } from './engine.js';

/**
 * UZSHOP PRO — Contest Center API (P0). Admin: create → review → owner approve → publish → (active) → close
 * (provisional + appeal window) → owner finalize (one final snapshot) → award prizes (stock-safe) → fulfil.
 * Partner: list, rules, join/leave (voluntary), leaderboard (aliases unless consent), my score with counted orders, appeals.
 */
const A = ['admin', 'contests'];
const P = ['partner', 'contests'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
const requireOwner = (a: Actor) => { if (!isOwner(a)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED'); };
const PUBLIC = ['scheduled', 'active', 'calculating', 'provisional', 'appeal_window', 'finalized', 'awarded', 'paused', 'canceled'];
const EDITABLE_IN_PLACE = ['draft', 'review'];
const REVISABLE = ['approved', 'scheduled', 'active', 'paused'];

const zRules = z.object({
  title_latn: z.string().trim().min(3).max(120), title_cyrl: z.string().trim().max(120).optional(), description: z.string().max(4000).optional(),
  banner_url: z.string().max(500).optional(), timezone: z.string().max(60).default('Asia/Tashkent'),
  starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }),
  metric: z.enum(['settled_orders', 'settled_units', 'confirmed_commission', 'net_sales']),
  eligibility: z.object({ product_ids: z.array(z.string().uuid()).max(200).optional(), category_ids: z.array(z.string().uuid()).max(50).optional(), partners_joined_after: z.string().datetime({ offset: true }).optional() }).default({}),
  min_score: z.coerce.number().int().min(0).default(1), appeal_days: z.number().int().min(0).max(30).default(3),
  tie_break: z.array(z.enum(['score', 'net_sales', 'refund_ratio', 'reached_at'])).min(1).max(4).default(['score', 'net_sales', 'refund_ratio', 'reached_at']),
  name_privacy: z.enum(['public', 'alias', 'consent']).default('public'), terms: z.string().max(8000).optional(), budget_minor: z.coerce.number().int().min(0).default(0),
});
const zPrize = z.object({ place: z.number().int().min(1).max(100).nullable().default(null), nomination: z.string().max(80).optional(), title: z.string().trim().min(2).max(160), kind: z.enum(['money', 'item']), value_minor: z.coerce.number().int().min(0).default(0), qty: z.number().int().min(1).max(1000).default(1), claim_days: z.number().int().min(1).max(365).default(14), image_url: z.string().max(500).optional() });

async function contestRow(q: Queryable, id: string, lock = false) {
  const c = await maybeOne<any>(q, `SELECT * FROM cc_contests WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('CONTEST');
  return c;
}

/** Lazy clock: scheduled → active at start, active → calculating at end (nobody has to run a cron for correctness). */
async function tick(q: Queryable, id: string) {
  await q.query(`UPDATE cc_contests c SET status='active', updated_at=now() FROM cc_versions v WHERE c.id=$1 AND v.contest_id=c.id AND v.version=c.current_version AND c.status='scheduled' AND v.starts_at <= now()`, [id]);
  await q.query(`UPDATE cc_contests c SET status='calculating', updated_at=now() FROM cc_versions v WHERE c.id=$1 AND v.contest_id=c.id AND v.version=c.current_version AND c.status='active' AND v.ends_at <= now()`, [id]);
}

async function insertVersion(tx: Tx, contestId: string, version: number, b: z.infer<typeof zRules>, actorId: string | null, reason: string | null) {
  if (new Date(b.ends_at) <= new Date(b.starts_at)) throw badRequest('CONTEST_DATES_INVALID');
  await tx.query(
    `INSERT INTO cc_versions (contest_id, version, title_latn, title_cyrl, description, banner_url, timezone, starts_at, ends_at, metric, eligibility, min_score, appeal_days, tie_break, name_privacy, terms, budget_minor, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [contestId, version, b.title_latn, b.title_cyrl ?? null, b.description ?? null, b.banner_url ?? null, b.timezone, b.starts_at, b.ends_at, b.metric, JSON.stringify(b.eligibility ?? {}), b.min_score, b.appeal_days, b.tie_break, b.name_privacy, b.terms ?? null, b.budget_minor, reason, actorId]);
}

async function nameMap(q: Queryable, contestId: string, privacy: string, ids: string[]) {
  const rows = (await q.query(`SELECT p.id, p.display_name, p.avatar_key, en.display_consent FROM partners p LEFT JOIN cc_enrollments en ON en.partner_id=p.id AND en.contest_id=$1 WHERE p.id = ANY($2::uuid[])`, [contestId, ids])).rows;
  const show = (r: any) => privacy === 'public' || (privacy === 'consent' && r.display_consent);
  return new Map(rows.map((r) => [r.id as string, { name: show(r) ? (r.display_name as string) : alias(r.id), avatar: show(r) && r.avatar_key ? `/media/${r.avatar_key}` : null }]));
}

export function registerContestCenter(app: FastifyInstance, deps: Deps): void {
  // ======================= ADMIN =======================
  route(app, deps, { method: 'GET', url: '/admin/cc/contests', tags: A, summary: 'All contests (current version)' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    return { items: await many(db, `SELECT c.id, c.status, c.current_version, c.version, c.created_at, c.appeal_deadline, v.title_latn, v.starts_at, v.ends_at, v.metric,
      (SELECT COUNT(*)::int FROM cc_enrollments e WHERE e.contest_id=c.id AND e.left_at IS NULL) AS participants
      FROM cc_contests c JOIN cc_versions v ON v.contest_id=c.id AND v.version=c.current_version ORDER BY c.created_at DESC LIMIT 200`), week: tashkentWeek() };
  });

  route(app, deps, { method: 'POST', url: '/admin/cc/contests', tags: A, summary: 'Create a draft contest (rules v1 + prizes)', body: zRules.extend({ prizes: z.array(zPrize).max(50).default([]) }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'partners.manage');
      return withTx(db, async (tx) => {
        const c = await one<{ id: string }>(tx, `INSERT INTO cc_contests (created_by) VALUES ($1) RETURNING id`, [actor.userId]);
        await insertVersion(tx, c.id, 1, body, actor.userId, null);
        for (const p of body.prizes) await tx.query(`INSERT INTO cc_prizes (contest_id, place, nomination, title, kind, value_minor, qty, claim_days, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [c.id, p.place, p.nomination ?? null, p.title, p.kind, p.value_minor, p.qty, p.claim_days, p.image_url ?? null]);
        await audit(tx, actor, 'cc.created', { type: 'cc_contest', id: c.id }, { after: { title: body.title_latn, metric: body.metric } });
        return { id: c.id, status: 'draft' };
      });
    });

  route(app, deps, { method: 'GET', url: '/admin/cc/contests/:id', tags: A, summary: 'Contest detail: versions, prizes, awards, appeals, snapshots', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    await tick(db, params.id);
    const c = await contestRow(db, params.id);
    return { ...c,
      versions: await many(db, `SELECT * FROM cc_versions WHERE contest_id=$1 ORDER BY version`, [params.id]),
      prizes: await many(db, `SELECT * FROM cc_prizes WHERE contest_id=$1 ORDER BY place NULLS LAST, created_at`, [params.id]),
      awards: await many(db, `SELECT a.*, p.display_name, pr.title FROM cc_prize_awards a JOIN partners p ON p.id=a.partner_id JOIN cc_prizes pr ON pr.id=a.prize_id WHERE a.contest_id=$1 ORDER BY a.rank NULLS LAST`, [params.id]),
      appeals: await many(db, `SELECT a.*, p.display_name, p.code FROM cc_appeals a JOIN partners p ON p.id=a.partner_id WHERE a.contest_id=$1 ORDER BY a.created_at DESC`, [params.id]),
      snapshots: await many(db, `SELECT id, kind, contest_version, computed_at FROM cc_rankings WHERE contest_id=$1 ORDER BY computed_at DESC LIMIT 20`, [params.id]),
      participants: (await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM cc_enrollments WHERE contest_id=$1 AND left_at IS NULL`, [params.id])).n };
  });

  // Edit: drafts change in place; a contest that is approved/live gets a NEW version with a reason (never a silent edit).
  route(app, deps, { method: 'PUT', url: '/admin/cc/contests/:id', tags: A, summary: 'Edit rules (draft in place; live => new version with reason)', params: zIdParam, body: zRules.extend({ expected_version: z.number().int(), reason: z.string().trim().max(500).optional() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      return withTx(db, async (tx) => {
        await tick(tx, params.id);
        const c = await contestRow(tx, params.id, true);
        if (c.version !== body.expected_version) throw conflict('CONTEST_VERSION_CONFLICT');
        if (EDITABLE_IN_PLACE.includes(c.status)) {
          await tx.query(`DELETE FROM cc_versions WHERE contest_id=$1 AND version=$2`, [params.id, c.current_version]);
          await insertVersion(tx, params.id, c.current_version, body, actor.userId, null);
          await tx.query(`UPDATE cc_contests SET version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
          await audit(tx, actor, 'cc.draft_edited', { type: 'cc_contest', id: params.id }, {});
          return { ok: true, current_version: c.current_version };
        }
        if (!REVISABLE.includes(c.status)) throw conflict('CONTEST_NOT_EDITABLE');
        if (!body.reason || body.reason.length < 5) throw new AppError(409, 'REVISION_REASON_REQUIRED');
        const nv = c.current_version + 1;
        await insertVersion(tx, params.id, nv, body, actor.userId, body.reason);
        await tx.query(`UPDATE cc_contests SET current_version=$2, version=version+1, updated_at=now() WHERE id=$1`, [params.id, nv]);
        await audit(tx, actor, 'cc.revised', { type: 'cc_contest', id: params.id }, { before: { version: c.current_version }, after: { version: nv }, reason: body.reason });
        await recompute(tx, params.id); // the new rules apply to the whole journal from now on (deltas, history kept)
        return { ok: true, current_version: nv, recalculated: true };
      });
    });

  const transition = (name: string, from: string[], to: string, opts: { owner?: boolean; stepUp?: boolean } = {}) =>
    route(app, deps, { method: 'POST', url: `/admin/cc/contests/:id/${name}`, tags: A, summary: `Status: ${from.join('|')} → ${to}`, params: zIdParam, body: z.object({ reason: z.string().max(500).optional() }).default({}) },
      async ({ actor, db, params, body }) => {
        requirePerm(actor, 'partners.manage');
        if (opts.owner) requireOwner(actor);
        if (opts.stepUp) requireStepUp(actor);
        return withTx(db, async (tx) => {
          await tick(tx, params.id);
          const c = await contestRow(tx, params.id, true);
          if (!from.includes(c.status)) throw conflict('CONTEST_STATUS_INVALID', { status: c.status });
          if (name === 'cancel' && !body.reason) throw badRequest('REASON_REQUIRED');
          await tx.query(`UPDATE cc_contests SET status=$2, version=version+1, updated_at=now(),
              approved_by = CASE WHEN $2='approved' THEN $3::uuid ELSE approved_by END, approved_at = CASE WHEN $2='approved' THEN now() ELSE approved_at END,
              published_at = CASE WHEN $2='scheduled' THEN now() ELSE published_at END, canceled_reason = CASE WHEN $2='canceled' THEN $4 ELSE canceled_reason END
            WHERE id=$1`, [params.id, to, actor.userId, body.reason ?? null]);
          await audit(tx, actor, `cc.${name}`, { type: 'cc_contest', id: params.id }, { before: { status: c.status }, after: { status: to }, reason: body.reason });
          await tick(tx, params.id);
          return { ok: true, status: (await contestRow(tx, params.id)).status };
        });
      });
  transition('submit', ['draft'], 'review');
  transition('approve', ['review'], 'approved', { owner: true });
  transition('publish', ['approved'], 'scheduled', { owner: true });
  transition('pause', ['active', 'scheduled'], 'paused');
  transition('resume', ['paused'], 'active');
  transition('cancel', ['draft', 'review', 'approved', 'scheduled', 'active', 'paused', 'calculating', 'provisional', 'appeal_window'], 'canceled', { owner: true });

  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/recompute', tags: A, summary: 'Re-read orders/ledger and append score deltas (idempotent)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    return withTx(db, async (tx) => {
      const c = await contestRow(tx, params.id);
      if (['draft', 'review', 'approved', 'canceled', 'voided'].includes(c.status)) throw conflict('CONTEST_STATUS_INVALID');
      return recompute(tx, params.id);
    });
  });

  // Dry-run: what the ranking would be over real orders for these rules — nothing is written.
  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/simulate', tags: A, summary: 'Dry-run ranking over real orders (all partners, nothing written)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    const r = await loadRules(db, params.id);
    if (!r) throw notFound('CONTEST');
    const facts = await desiredFacts(db, r, null);
    const agg = new Map<string, { score: bigint; net: bigint; units: number; orders: number; ref: number }>();
    for (const f of facts.values()) {
      const a = agg.get(f.partnerId) ?? { score: 0n, net: 0n, units: 0, orders: 0, ref: 0 };
      a.score += f.final; a.net += f.net; a.units += f.units; a.ref += f.refundedUnits; if (f.final) a.orders++;
      agg.set(f.partnerId, a);
    }
    const rows = rankRows([...agg].map(([pid, a]) => ({ partner_id: pid, score: a.score.toString(), net_sales_minor: a.net.toString(), units: a.units, orders: a.orders, refund_ratio: a.units + a.ref >= 5 ? a.ref / (a.units + a.ref) : null, reached_at: null, qualified: a.score >= BigInt(r.min_score) && a.score > 0n })), r.tie_break);
    const names = new Map((await many<{ id: string; display_name: string; code: string }>(db, `SELECT id, display_name, code FROM partners WHERE id = ANY($1::uuid[])`, [rows.map((x) => x.partner_id)])).map((p) => [p.id, `${p.display_name} (${p.code})`]));
    return { dry_run: true, as_of: new Date().toISOString(), rows: rows.slice(0, 50).map((x) => ({ ...x, name: names.get(x.partner_id) })) };
  });

  // Close: provisional snapshot + appeal window. Winners are NOT announced here.
  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/close', tags: A, summary: 'After the end: recompute, provisional ranking, open the appeal window', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage');
    return withTx(db, async (tx) => {
      await tick(tx, params.id);
      const c = await contestRow(tx, params.id, true);
      if (c.status !== 'calculating') throw conflict('CONTEST_STATUS_INVALID', { status: c.status });
      const r = (await loadRules(tx, params.id))!;
      await recompute(tx, params.id);
      const rows = await liveRanking(tx, params.id, 'final', r);
      await tx.query(`INSERT INTO cc_rankings (contest_id, kind, contest_version, rows, computed_by) VALUES ($1,'provisional',$2,$3,$4)`, [params.id, r.version, JSON.stringify(rows), actor.userId]);
      await tx.query(`UPDATE cc_contests SET status='appeal_window', closed_at=now(), appeal_deadline=now() + make_interval(days => $2), version=version+1, updated_at=now() WHERE id=$1`, [params.id, r.appeal_days]);
      await audit(tx, actor, 'cc.closed', { type: 'cc_contest', id: params.id }, { after: { participants_ranked: rows.filter((x) => x.rank).length } });
      return { ok: true, status: 'appeal_window', provisional: rows.slice(0, 20) };
    });
  });

  // Finalize: owner, after the appeal deadline, no open appeals; exactly one final snapshot (unique index).
  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/finalize', tags: A, summary: 'Owner final approval: recompute and freeze the final ranking (once)', params: zIdParam, body: z.object({ force_before_deadline: z.boolean().default(false) }).default({ force_before_deadline: false }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireOwner(actor);
      return withTx(db, async (tx) => {
        const c = await contestRow(tx, params.id, true);
        if (c.status !== 'appeal_window') throw conflict('CONTEST_STATUS_INVALID', { status: c.status });
        if (!body.force_before_deadline && c.appeal_deadline && new Date(c.appeal_deadline) > new Date()) throw conflict('APPEAL_WINDOW_OPEN', { appeal_deadline: c.appeal_deadline });
        const open = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM cc_appeals WHERE contest_id=$1 AND status='open'`, [params.id]);
        if (open.n) throw conflict('APPEALS_OPEN', { open: open.n });
        const r = (await loadRules(tx, params.id))!;
        // Quality Q15: an order under an open quality case keeps the result non-final until a human closes the case.
        const disputes = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM quality_cases q JOIN cc_enrollments e ON e.partner_id=q.partner_id AND e.contest_id=$1
            WHERE q.status IN ('detected','triage','investigating','awaiting_partner_response','reviewed','appealed')
              AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ANY(q.order_ids) AND o.created_at >= $2 AND o.created_at < $3)`, [params.id, r.starts_at, r.ends_at]);
        if (disputes.n) throw conflict('QUALITY_DISPUTES_OPEN', { open: disputes.n });
        await recompute(tx, params.id);
        const rows = await liveRanking(tx, params.id, 'final', r);
        await tx.query(`INSERT INTO cc_rankings (contest_id, kind, contest_version, rows, computed_by) VALUES ($1,'final',$2,$3,$4)`, [params.id, r.version, JSON.stringify(rows), actor.userId])
          .catch((e) => { if (e.code === '23505') throw conflict('ALREADY_FINALIZED'); throw e; });
        await tx.query(`UPDATE cc_contests SET status='finalized', finalized_by=$2, finalized_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [params.id, actor.userId]);
        await audit(tx, actor, 'cc.finalized', { type: 'cc_contest', id: params.id }, { after: { winners: rows.filter((x) => x.rank && x.rank <= 3).map((x) => ({ rank: x.rank, partner_id: x.partner_id })) } });
        return { ok: true, status: 'finalized', final: rows.slice(0, 20) };
      });
    });

  // Award by the frozen final ranking. Ties beyond prize stock are left for an explicit owner decision.
  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/award', tags: A, summary: 'Assign place prizes from the final snapshot (stock-safe, money via wallet ledger)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'partners.manage'); requireOwner(actor); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const c = await contestRow(tx, params.id, true);
      if (!['finalized', 'awarded'].includes(c.status)) throw conflict('CONTEST_STATUS_INVALID', { status: c.status });
      const snap = await maybeOne<{ rows: RankRow[] }>(tx, `SELECT rows FROM cc_rankings WHERE contest_id=$1 AND kind='final'`, [params.id]);
      if (!snap) throw conflict('NOT_FINALIZED');
      const prizes = await many<any>(tx, `SELECT * FROM cc_prizes WHERE contest_id=$1 AND place IS NOT NULL ORDER BY place`, [params.id]);
      const awarded: any[] = [], needsDecision: any[] = [];
      for (const p of prizes) {
        for (const w of snap.rows.filter((x) => x.rank === p.place)) {
          const r = await awardOne(tx, actor, p, w.partner_id, w.rank, c);
          if (r === 'no_stock') needsDecision.push({ prize_id: p.id, place: p.place, partner_id: w.partner_id, why: 'tie_beyond_stock' }); else if (r) awarded.push(r);
        }
      }
      await tx.query(`UPDATE cc_contests SET status='awarded', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
      return { ok: true, awarded, needs_decision: needsDecision };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/cc/prizes/:id/award', tags: A, summary: 'Owner decision: give this prize to a partner (stock-safe)', params: zIdParam, body: z.object({ partner_id: z.string().uuid(), reason: z.string().min(3).max(300) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireOwner(actor);
      return withTx(db, async (tx) => {
        const p = await maybeOne<any>(tx, `SELECT * FROM cc_prizes WHERE id=$1`, [params.id]);
        if (!p) throw notFound('PRIZE');
        const c = await contestRow(tx, p.contest_id, true);
        if (!['finalized', 'awarded'].includes(c.status)) throw conflict('CONTEST_STATUS_INVALID', { status: c.status });
        const r = await awardOne(tx, actor, p, body.partner_id, null, c, body.reason);
        if (r === 'no_stock') throw conflict('PRIZE_OUT_OF_STOCK');
        if (!r) throw conflict('ALREADY_AWARDED');
        return r;
      });
    });

  route(app, deps, { method: 'PATCH', url: '/admin/cc/awards/:id', tags: A, summary: 'Prize fulfilment status (claimed/shipped/delivered) with proof', params: zIdParam, body: z.object({ status: z.enum(['claimed', 'shipped', 'delivered']), proof: z.string().max(500).optional() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      const order = ['assigned', 'claimed', 'shipped', 'delivered'];
      return withTx(db, async (tx) => {
        const a = await maybeOne<any>(tx, `SELECT * FROM cc_prize_awards WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!a) throw notFound('AWARD');
        await expireAwards(tx);
        const cur = (await one<{ status: string }>(tx, `SELECT status FROM cc_prize_awards WHERE id=$1`, [params.id])).status;
        if (order.indexOf(body.status) <= order.indexOf(cur)) throw conflict('AWARD_STATUS_INVALID', { status: cur });
        await tx.query(`UPDATE cc_prize_awards SET status=$2, proof=COALESCE($3, proof), updated_at=now() WHERE id=$1`, [params.id, body.status, body.proof ?? null]);
        await audit(tx, actor, 'cc.award_status', { type: 'cc_prize_award', id: params.id }, { before: { status: cur }, after: { status: body.status } });
        return { ok: true, status: body.status };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/cc/appeals/:id/resolve', tags: A, summary: 'Resolve an appeal (accepted => recompute/correction separately, with reason)', params: zIdParam, body: z.object({ status: z.enum(['accepted', 'rejected']), resolution: z.string().min(3).max(1000) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      const r = await db.query(`UPDATE cc_appeals SET status=$2, resolution=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 AND status='open' RETURNING contest_id`, [params.id, body.status, body.resolution, actor.userId]);
      if (!r.rowCount) throw conflict('APPEAL_NOT_OPEN');
      await audit(db, actor, 'cc.appeal_resolved', { type: 'cc_appeal', id: params.id }, { after: { status: body.status }, reason: body.resolution });
      return { ok: true };
    });

  // Corrections are visible journal rows with a reason — never a hidden score edit.
  route(app, deps, { method: 'POST', url: '/admin/cc/contests/:id/corrections', tags: A, summary: 'Score correction entry (reason required, audited)', params: zIdParam, body: z.object({ partner_id: z.string().uuid(), points: z.coerce.number().int(), reason: z.string().trim().min(5).max(500) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireOwner(actor);
      return withTx(db, async (tx) => {
        const c = await contestRow(tx, params.id, true);
        if (['finalized', 'awarded', 'archived', 'canceled', 'voided'].includes(c.status)) throw conflict('CONTEST_STATUS_INVALID');
        const n = (await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM cc_score_events WHERE contest_id=$1 AND kind='correction'`, [params.id])).n;
        await tx.query(`INSERT INTO cc_score_events (contest_id, partner_id, kind, prov_points, final_points, contest_version, idem_key, reason, actor_id) VALUES ($1,$2,'correction',$3,$3,$4,$5,$6,$7)`,
          [params.id, body.partner_id, body.points, c.current_version, `cc:${params.id}:corr:${n + 1}`, body.reason, actor.userId]);
        await audit(tx, actor, 'cc.correction', { type: 'cc_contest', id: params.id }, { after: { partner_id: body.partner_id, points: body.points }, reason: body.reason });
        return { ok: true };
      });
    });

  route(app, deps, { method: 'GET', url: '/admin/cc/contests/:id/export.csv', tags: A, summary: 'Final (or provisional) ranking as CSV', params: zIdParam }, async ({ actor, db, params, reply }) => {
    requirePerm(actor, 'partners.manage');
    const snap = await maybeOne<{ kind: string; rows: RankRow[]; computed_at: string }>(db, `SELECT kind, rows, computed_at FROM cc_rankings WHERE contest_id=$1 ORDER BY (kind='final') DESC, computed_at DESC LIMIT 1`, [params.id]);
    if (!snap) throw notFound('RANKING');
    const names = new Map((await many<{ id: string; display_name: string; code: string }>(db, `SELECT id, display_name, code FROM partners WHERE id = ANY($1::uuid[])`, [snap.rows.map((x) => x.partner_id)])).map((p) => [p.id, p]));
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]|^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
    const lines = [['rank', 'partner_code', 'partner', 'score', 'net_sales_minor', 'units', 'orders', 'refund_ratio', 'reached_at'].join(',')];
    for (const r of snap.rows) lines.push([r.rank ?? '', names.get(r.partner_id)?.code, names.get(r.partner_id)?.display_name, r.score, r.net_sales_minor, r.units, r.orders, r.refund_ratio ?? '', r.reached_at ?? ''].map(esc).join(','));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="contest-${params.id}-${snap.kind}.csv"`);
    return lines.join('\n');
  });

  // ======================= PARTNER =======================
  route(app, deps, { method: 'GET', url: '/partner/cc/contests', tags: P, summary: 'Active / upcoming / finished contests with my participation' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const ids = (await db.query(`SELECT id FROM cc_contests WHERE status = ANY($1::text[])`, [PUBLIC])).rows.map((x) => x.id as string);
    for (const id of ids) await tick(db, id);
    return { items: await many(db, `SELECT c.id, c.status, c.current_version, c.appeal_deadline, v.title_latn, v.title_cyrl, v.description, v.banner_url, v.starts_at, v.ends_at, v.metric, v.min_score,
        (en.partner_id IS NOT NULL AND en.left_at IS NULL) AS joined,
        (SELECT json_agg(json_build_object('place', pr.place, 'nomination', pr.nomination, 'title', pr.title, 'kind', pr.kind, 'value_minor', pr.value_minor::text, 'qty', pr.qty) ORDER BY pr.place NULLS LAST) FROM cc_prizes pr WHERE pr.contest_id=c.id) AS prizes
      FROM cc_contests c JOIN cc_versions v ON v.contest_id=c.id AND v.version=c.current_version LEFT JOIN cc_enrollments en ON en.contest_id=c.id AND en.partner_id=$1
     WHERE c.status = ANY($2::text[]) ORDER BY v.starts_at DESC LIMIT 100`, [p.id, PUBLIC]) };
  });

  route(app, deps, { method: 'GET', url: '/partner/cc/contests/:id', tags: P, summary: 'Rules (current version + revision reasons), prizes, my enrollment', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    await tick(db, params.id);
    const c = await contestRow(db, params.id);
    if (!PUBLIC.includes(c.status)) throw notFound('CONTEST');
    return { id: c.id, status: c.status, appeal_deadline: c.appeal_deadline, current_version: c.current_version,
      rules: await one(db, `SELECT version, title_latn, title_cyrl, description, banner_url, timezone, starts_at, ends_at, metric, eligibility, min_score, appeal_days, tie_break, name_privacy, terms FROM cc_versions WHERE contest_id=$1 AND version=$2`, [params.id, c.current_version]),
      revisions: await many(db, `SELECT version, reason, created_at FROM cc_versions WHERE contest_id=$1 AND version > 1 ORDER BY version`, [params.id]),
      prizes: await many(db, `SELECT place, nomination, title, kind, value_minor::text, qty, image_url FROM cc_prizes WHERE contest_id=$1 ORDER BY place NULLS LAST`, [params.id]),
      enrollment: await maybeOne(db, `SELECT terms_version, joined_at, left_at, display_consent, notify_opt_in FROM cc_enrollments WHERE contest_id=$1 AND partner_id=$2`, [params.id, p.id]) };
  });

  route(app, deps, { method: 'POST', url: '/partner/cc/contests/:id/join', tags: P, summary: 'Join voluntarily (accept the current rules version)', params: zIdParam, body: z.object({ accept_terms: z.literal(true), display_consent: z.boolean().default(false), notify_opt_in: z.boolean().default(true) }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor);
      return withTx(db, async (tx) => {
        await tick(tx, params.id);
        const c = await contestRow(tx, params.id);
        if (!['scheduled', 'active'].includes(c.status)) throw conflict('CONTEST_NOT_OPEN');
        const r = (await loadRules(tx, params.id))!;
        const pr = await one<{ status: string; created_at: string }>(tx, `SELECT status, created_at FROM partners WHERE id=$1`, [p.id]);
        if (pr.status !== 'active') throw forbidden();
        if (r.eligibility.partners_joined_after && new Date(pr.created_at) < new Date(r.eligibility.partners_joined_after)) throw new AppError(403, 'CONTEST_NOT_ELIGIBLE', { reason: 'new_partners_only' });
        await tx.query(`INSERT INTO cc_enrollments (contest_id, partner_id, terms_version, display_consent, notify_opt_in) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (contest_id, partner_id) DO UPDATE SET left_at=NULL, terms_version=EXCLUDED.terms_version, display_consent=EXCLUDED.display_consent, notify_opt_in=EXCLUDED.notify_opt_in, joined_at=now()`,
          [params.id, p.id, r.version, body.display_consent, body.notify_opt_in]);
        await audit(tx, actor, 'cc.joined', { type: 'cc_contest', id: params.id }, { after: { partner_id: p.id, terms_version: r.version } });
        await recompute(tx, params.id);
        return { ok: true, terms_version: r.version };
      });
    });

  route(app, deps, { method: 'POST', url: '/partner/cc/contests/:id/leave', tags: P, summary: 'Leave the contest (normal commission is not affected)', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await db.query(`UPDATE cc_enrollments SET left_at=now(), notify_opt_in=false WHERE contest_id=$1 AND partner_id=$2 AND left_at IS NULL`, [params.id, p.id]);
    if (!r.rowCount) throw conflict('NOT_JOINED');
    await audit(db, actor, 'cc.left', { type: 'cc_contest', id: params.id }, { after: { partner_id: p.id } });
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/partner/cc/contests/:id/leaderboard', tags: P, summary: 'Top N + my place; aliases unless the participant consented; frozen snapshot when available',
    params: zIdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }) },
  async ({ actor, db, params, query }) => {
    const p = await myPartner(db, actor, false);
    await tick(db, params.id);
    const c = await contestRow(db, params.id);
    if (!PUBLIC.includes(c.status)) throw notFound('CONTEST');
    const r = (await loadRules(db, params.id))!;
    const snap = await maybeOne<{ kind: string; rows: RankRow[]; computed_at: string }>(db, `SELECT kind, rows, computed_at FROM cc_rankings WHERE contest_id=$1 ORDER BY (kind='final') DESC, computed_at DESC LIMIT 1`, [params.id]);
    const kind = snap ? snap.kind : 'live';
    const rows = snap ? snap.rows : await liveRanking(db, params.id, 'provisional', r);
    const ranked = rows.filter((x) => x.rank !== null);
    const page = ranked.slice(query.offset, query.offset + query.limit);
    const names = await nameMap(db, params.id, r.name_privacy, page.map((x) => x.partner_id));
    const me = rows.find((x) => x.partner_id === p.id) ?? null;
    return { kind, as_of: snap?.computed_at ?? new Date().toISOString(), total: ranked.length, next_offset: query.offset + query.limit < ranked.length ? query.offset + query.limit : null,
      warning: kind === 'final' ? null : 'Reyting o‘zgaruvchan: yetkazilmagan yoki to‘lovi tasdiqlanmagan buyurtmalar yakuniy hisobga kirmasligi mumkin.',
      items: page.map((x) => ({ rank: x.rank, name: names.get(x.partner_id)?.name, avatar: names.get(x.partner_id)?.avatar ?? null, score: x.score, me: x.partner_id === p.id })),
      me: me ? { rank: me.rank, score: me.score, qualified: me.qualified } : null };
  });

  route(app, deps, { method: 'GET', url: '/partner/cc/contests/:id/me', tags: P, summary: 'My score: provisional vs final, counted orders (masked) and how each scored, funnel', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await loadRules(db, params.id);
    if (!r) throw notFound('CONTEST');
    const sums = await one<any>(db, `SELECT COALESCE(SUM(prov_points),0)::text AS prov, COALESCE(SUM(final_points),0)::text AS final, COALESCE(SUM(final_units),0)::int AS units, COALESCE(SUM(final_net_sales_minor),0)::text AS net, COALESCE(SUM(final_commission_minor),0)::text AS commission FROM cc_score_events WHERE contest_id=$1 AND partner_id=$2`, [params.id, p.id]);
    const orders = await many(db, `SELECT 'OM-***' || right(o.number, 3) AS number, o.id AS order_id, SUM(e.prov_points)::text AS prov, SUM(e.final_points)::text AS final, SUM(e.final_units)::int AS units,
        COUNT(*) FILTER (WHERE e.kind='adjustment')::int AS adjustments, MAX(e.created_at) AS updated_at
      FROM cc_score_events e JOIN orders o ON o.id=e.order_id WHERE e.contest_id=$1 AND e.partner_id=$2 GROUP BY o.id, o.number ORDER BY MAX(e.created_at) DESC LIMIT 200`, [params.id, p.id]);
    const corrections = await many(db, `SELECT final_points::text AS points, reason, created_at FROM cc_score_events WHERE contest_id=$1 AND partner_id=$2 AND kind='correction' ORDER BY id`, [params.id, p.id]);
    const f = await one<any>(db, `SELECT COUNT(*)::int AS created, COUNT(*) FILTER (WHERE commercial_status IN ('confirmed','completed'))::int AS accepted, COUNT(*) FILTER (WHERE fulfillment_status='delivered')::int AS delivered
      FROM orders WHERE attributed_partner_id=$1 AND created_at >= $2 AND created_at < $3`, [p.id, r.starts_at, r.ends_at]);
    return { metric: r.metric, provisional: sums.prov, final: sums.final, units: sums.units, net_sales_minor: sums.net, commission_minor: sums.commission, orders, corrections, funnel: funnel(f.created, f.accepted, f.delivered) };
  });

  route(app, deps, { method: 'POST', url: '/partner/cc/contests/:id/appeals', tags: P, summary: 'Appeal during the appeal window', params: zIdParam, body: z.object({ body: z.string().trim().min(5).max(2000), order_id: z.string().uuid().optional() }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor, false);
      const c = await contestRow(db, params.id);
      const en = await maybeOne(db, `SELECT 1 FROM cc_enrollments WHERE contest_id=$1 AND partner_id=$2`, [params.id, p.id]);
      if (!en) throw conflict('NOT_JOINED');
      if (c.status !== 'appeal_window' || !c.appeal_deadline || new Date(c.appeal_deadline) <= new Date()) throw conflict('APPEAL_WINDOW_CLOSED');
      if (body.order_id && !(await maybeOne(db, `SELECT 1 FROM orders WHERE id=$1 AND attributed_partner_id=$2`, [body.order_id, p.id]))) throw notFound('ORDER');
      const a = await one<{ id: string }>(db, `INSERT INTO cc_appeals (contest_id, partner_id, body, order_id) VALUES ($1,$2,$3,$4) RETURNING id`, [params.id, p.id, body.body, body.order_id ?? null]);
      await audit(db, actor, 'cc.appeal_created', { type: 'cc_appeal', id: a.id }, {});
      return { id: a.id, status: 'open' };
    });

  route(app, deps, { method: 'GET', url: '/partner/cc/prizes', tags: P, summary: 'My contest prizes and their status' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    await expireAwards(db);
    return { items: await many(db, `SELECT a.id, a.status, a.rank, a.claim_deadline, a.created_at, pr.title, pr.kind, pr.value_minor::text, v.title_latn AS contest
      FROM cc_prize_awards a JOIN cc_prizes pr ON pr.id=a.prize_id JOIN cc_contests c ON c.id=a.contest_id JOIN cc_versions v ON v.contest_id=c.id AND v.version=c.current_version
     WHERE a.partner_id=$1 ORDER BY a.created_at DESC`, [p.id]) };
  });
}

/** Item prizes not claimed in time expire; the award row (audit) stays. */
async function expireAwards(q: Queryable) {
  await q.query(`UPDATE cc_prize_awards SET status='expired', updated_at=now() WHERE status='assigned' AND claim_deadline < now()`);
}

/** One prize to one partner: stock is taken atomically (two parallel awards cannot both succeed). */
async function awardOne(tx: Tx, actor: Actor, p: any, partnerId: string, rank: number | null, c: any, reason?: string): Promise<any | 'no_stock' | null> {
  if (['canceled', 'voided'].includes(c.status)) throw conflict('CONTEST_STATUS_INVALID');
  const dup = await maybeOne(tx, `SELECT 1 FROM cc_prize_awards WHERE prize_id=$1 AND partner_id=$2`, [p.id, partnerId]);
  if (dup) return null;
  const took = await tx.query(`UPDATE cc_prizes SET awarded=awarded+1 WHERE id=$1 AND awarded < qty RETURNING awarded`, [p.id]);
  if (!took.rowCount) return 'no_stock';
  const a = await one<{ id: string }>(tx, `INSERT INTO cc_prize_awards (prize_id, contest_id, partner_id, rank, status, claim_deadline, awarded_by) VALUES ($1,$2,$3,$4,'assigned', now() + make_interval(days => $5), $6) RETURNING id`,
    [p.id, p.contest_id, partnerId, rank, p.claim_days, actor.userId]);
  if (p.kind === 'money' && BigInt(p.value_minor) > 0n) {
    const title = (await one<{ t: string }>(tx, `SELECT title_latn AS t FROM cc_versions WHERE contest_id=$1 AND version=$2`, [p.contest_id, c.current_version])).t;
    const bonusId = await awardBonus(tx, { partnerId, source: 'cc_prize', ccAwardId: a.id, amount: BigInt(p.value_minor), reason: `Konkurs «${title}» — ${p.title}`, actorId: actor.userId });
    await tx.query(`UPDATE cc_prize_awards SET status='paid', bonus_award_id=$2 WHERE id=$1`, [a.id, bonusId]);
  }
  await audit(tx, actor, 'cc.prize_awarded', { type: 'cc_prize_award', id: a.id }, { after: { prize_id: p.id, partner_id: partnerId, rank }, reason });
  return { award_id: a.id, prize_id: p.id, partner_id: partnerId, rank };
}
