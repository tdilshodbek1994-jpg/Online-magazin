import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';
import { myPartner } from '../partners/routes.js';
import { BENEFIT_BPS, COUPON_UNITS, giftDiscountBps, levelDefs, levelFor, syncPartnerLevel, VIP_UNITS } from './service.js';

const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
function ownerOnly(a: Actor) { requirePerm(a, 'catalog.write'); if (!isOwner(a)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED'); }
const A = ['admin', 'levels'];
const P = ['partner', 'levels'];

export function registerLevels(app: FastifyInstance, deps: Deps): void {
  // ---------------------------------------------------------------- partner
  route(app, deps, { method: 'GET', url: '/partner/level', tags: P, summary: 'My level, progress, perks, coins, gift discount, coupon, history, rank' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const st = await withTx(db, (tx) => syncPartnerLevel(tx, p.id, 'profile_view')); // cheap, idempotent self-heal
    const defs = await levelDefs(db);
    const cur = levelFor(defs, st.units);
    const next = defs.find((d) => d.threshold > st.units) ?? null;
    const prevT = cur.threshold;
    const coins = await maybeOne<{ available: string }>(db, `SELECT available::text FROM uzcoin_balances WHERE partner_id=$1`, [p.id]);
    const rank = await one<{ r: number; n: number }>(db, `SELECT (SELECT COUNT(*) FROM partner_level_state WHERE units > $1)::int + 1 AS r, (SELECT COUNT(*) FROM partner_level_state)::int AS n`, [st.units]);
    const vip = await maybeOne<{ vip_since: string | null }>(db, `SELECT vip_since FROM partner_level_state WHERE partner_id=$1`, [p.id]);
    return {
      units: st.units, level: cur, next: next ? { ...next, remaining: next.threshold - st.units, progress_pct: Math.min(100, Math.round(((st.units - prevT) / (next.threshold - prevT)) * 1000) / 10) } : null,
      gift_discount_bps: await giftDiscountBps(db, cur.level), coins_available: coins?.available ?? '0',
      coupon: await maybeOne(db, `SELECT id, rate_bps, status, issued_at, used_at FROM partner_commission_coupons WHERE partner_id=$1`, [p.id]),
      vip: { active: !!vip?.vip_since, since: vip?.vip_since ?? null, rate_bps: BENEFIT_BPS, unlocks_at: VIP_UNITS }, coupon_unlocks_at: COUPON_UNITS,
      perks: defs.filter((d) => d.perks || d.gift_discount_bps).map((d) => ({ level: d.level, name: d.name, threshold: d.threshold, gift_discount_bps: d.gift_discount_bps, perks: d.perks, unlocked: st.units >= d.threshold })),
      history: await many(db, `SELECT from_level, to_level, units, created_at FROM partner_level_history WHERE partner_id=$1 ORDER BY id DESC LIMIT 30`, [p.id]),
      rank: { position: rank.r, of: rank.n }, defs,
      benefit_products: await many(db, `SELECT b.product_id, p.name FROM level_benefit_products b JOIN products p ON p.id=b.product_id WHERE b.enabled ORDER BY p.name->>'uz-Latn' LIMIT 100`),
    };
  });

  route(app, deps, { method: 'POST', url: '/partner/level/coupon/arm', tags: P, summary: 'Use my one-time 50% coupon on my next eligible order' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor);
    const r = await db.query(`UPDATE partner_commission_coupons SET status='armed', updated_at=now() WHERE partner_id=$1 AND status='available' RETURNING id`, [p.id]);
    if (!r.rowCount) throw new AppError(409, 'COUPON_NOT_AVAILABLE');
    await audit(db, actor, 'partner.coupon_armed', { type: 'partner', id: p.id }, {});
    return { ok: true, status: 'armed' };
  });

  route(app, deps, { method: 'GET', url: '/partner/level/advice', tags: P, summary: 'Advice to reach the next level (analysis only — never changes money or benefits)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const st = await withTx(db, (tx) => syncPartnerLevel(tx, p.id, 'advice'));
    const defs = await levelDefs(db);
    const next = defs.find((d) => d.threshold > st.units) ?? null;
    const win = await one<{ last30: number; prev30: number }>(db, `SELECT
        COALESCE(SUM(qty) FILTER (WHERE created_at > now() - interval '30 days'),0)::int AS last30,
        COALESCE(SUM(qty) FILTER (WHERE created_at <= now() - interval '30 days' AND created_at > now() - interval '60 days'),0)::int AS prev30
      FROM uzcoin_ledger WHERE partner_id=$1 AND kind IN ('earned_sale','return_adjustment')`, [p.id]);
    const top = await many<{ name: string; units: number }>(db, `SELECT COALESCE(product_name,'—') AS name, SUM(qty)::int AS units FROM uzcoin_ledger WHERE partner_id=$1 AND kind='earned_sale' AND created_at > now() - interval '90 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [p.id]);
    const ord = await one<{ total: number; cancelled: number; active_days: number }>(db, `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE commercial_status='cancelled' OR confirmation_status IN ('rejected','expired'))::int AS cancelled,
        COUNT(DISTINCT date_trunc('day', created_at))::int AS active_days FROM orders WHERE attributed_partner_id=$1 AND created_at > now() - interval '30 days'`, [p.id]);
    const cancelPct = ord.total ? Math.round((ord.cancelled / ord.total) * 1000) / 10 : null;
    const remaining = next ? next.threshold - st.units : 0;
    const perDay = win.last30 / 30;
    const tips: string[] = [];
    if (next) tips.push(`«${next.name}» darajasigacha ${remaining} ta tasdiqlangan sotuv qoldi.`);
    if (next && perDay > 0) tips.push(`Hozirgi sur’atda (kuniga ~${perDay.toFixed(1)} dona) taxminan ${Math.ceil(remaining / perDay)} kunda yetasiz — bu taxmin, kafolat emas.`);
    if (win.last30 < win.prev30) tips.push('Oxirgi 30 kunda sotuv oldingi 30 kunga nisbatan kamaygan — eng yaxshi sotilgan mahsulotlaringizga qayta e’tibor bering.');
    if (top[0]) tips.push(`Eng yaxshi natija: ${top.map((x) => `${x.name} (${x.units})`).join(', ')}.`);
    if (cancelPct !== null && cancelPct > 20) tips.push(`Bekor bo‘lgan buyurtmalar ulushi ${cancelPct}% — mijoz bilan narx va yetkazishni oldindan aniq kelishing.`);
    if (ord.active_days < 10) tips.push(`Oxirgi 30 kunda ${ord.active_days} kun faol bo‘ldingiz — muntazam joylash natijani oshiradi.`);
    return { units: st.units, next, remaining, trend: win, top_products: top, cancel_rate_pct: cancelPct, active_days_30: ord.active_days, tips,
      note: 'Tahlil ma’lumotlar asosida tuzilgan. Komissiya, kupon va chegirmalarni faqat admin/egasi o‘zgartiradi.' };
  });

  // ---------------------------------------------------------------- admin
  route(app, deps, { method: 'GET', url: '/admin/levels', tags: A, summary: 'Level definitions, benefit products, coupons, promos, recent adjustments and changes' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return {
      defs: await levelDefs(db),
      benefit_products: await many(db, `SELECT b.product_id, p.name, b.enabled, (SELECT MIN(s.cost_minor)::text FROM skus s WHERE s.product_id=p.id) AS cost_minor FROM level_benefit_products b JOIN products p ON p.id=b.product_id ORDER BY b.approved_at DESC`),
      coupons: await many(db, `SELECT c.id, c.status, c.issued_at, c.used_at, c.order_id, pa.display_name FROM partner_commission_coupons c JOIN partners pa ON pa.id=c.partner_id ORDER BY c.issued_at DESC LIMIT 100`),
      promos: await many(db, `SELECT id, name, min_level, extra_discount_bps, starts_at, ends_at FROM level_promos ORDER BY starts_at DESC LIMIT 50`),
      adjustments: await many(db, `SELECT a.id, a.units, a.reason, a.created_at, pa.display_name FROM partner_level_adjustments a JOIN partners pa ON pa.id=a.partner_id ORDER BY a.id DESC LIMIT 50`),
      top: await many(db, `SELECT s.partner_id, pa.display_name, s.units, s.level, s.vip_since FROM partner_level_state s JOIN partners pa ON pa.id=s.partner_id ORDER BY s.units DESC LIMIT 20`),
      constants: { coupon_units: COUPON_UNITS, vip_units: VIP_UNITS, benefit_bps: BENEFIT_BPS },
    };
  });

  route(app, deps, { method: 'PUT', url: '/admin/levels', tags: A, summary: 'Owner: replace level names/thresholds/badges/colours/gift discounts (versioned + audited; partners recomputed)',
    body: z.object({
      reason: z.string().trim().min(5).max(300),
      defs: z.array(z.object({ level: z.number().int().min(0).max(99), name: z.string().trim().min(2).max(60), threshold: z.number().int().min(0).max(10_000_000), badge: z.string().max(8).default('⭐'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/), gift_discount_bps: z.number().int().min(0).max(5000), perks: z.string().max(200).nullable().optional() }).strict()).min(2).max(60),
    }).strict() }, async ({ actor, db, body }) => {
    ownerOnly(actor);
    const d = [...body.defs].sort((a, b) => a.level - b.level);
    if (d[0]!.threshold !== 0 || d[0]!.level !== 0) throw new AppError(422, 'LEVEL_ZERO_REQUIRED');
    for (let i = 1; i < d.length; i++) if (d[i]!.threshold <= d[i - 1]!.threshold || d[i]!.level !== d[i - 1]!.level + 1) throw new AppError(422, 'THRESHOLDS_MUST_INCREASE');
    return withTx(db, async (tx) => {
      const before = await levelDefs(tx);
      await tx.query(`INSERT INTO partner_level_def_versions (snapshot, reason, actor_user_id) VALUES ($1,$2,$3)`, [JSON.stringify(before), body.reason, actor.userId]);
      await tx.query(`DELETE FROM partner_level_defs`);
      for (const x of d) await tx.query(`INSERT INTO partner_level_defs (level, name, threshold, badge, color, gift_discount_bps, perks) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [x.level, x.name, x.threshold, x.badge, x.color, x.gift_discount_bps, x.perks ?? null]);
      await audit(tx, actor, 'levels.defs_changed', { type: 'partner_level_defs', id: '-' }, { before, after: d, reason: body.reason });
      const ps = await many<{ partner_id: string }>(tx, `SELECT partner_id FROM partner_level_state`);
      for (const p of ps) await syncPartnerLevel(tx, p.partner_id, 'levels_config_changed');
      return { ok: true, recomputed: ps.length };
    });
  });

  route(app, deps, { method: 'PUT', url: '/admin/levels/benefit-products/:product_id', tags: A, summary: 'Owner: allow/stop the 50% level benefit for a product (margin is checked per order line)',
    params: z.object({ product_id: z.string().uuid() }), body: z.object({ enabled: z.boolean() }).strict() }, async ({ actor, db, params, body }) => {
    ownerOnly(actor);
    if (!(await maybeOne(db, `SELECT 1 FROM products WHERE id=$1`, [params.product_id]))) throw notFound('PRODUCT');
    await db.query(`INSERT INTO level_benefit_products (product_id, enabled, approved_by) VALUES ($1,$2,$3) ON CONFLICT (product_id) DO UPDATE SET enabled=$2, approved_by=$3, approved_at=now()`, [params.product_id, body.enabled, actor.userId]);
    await audit(db, actor, 'levels.benefit_product', { type: 'product', id: params.product_id }, { after: body });
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/levels/adjustments', tags: A, summary: 'Owner: dispute correction of qualified units (± with reason, audited, recomputed now)',
    body: z.object({ partner_id: z.string().uuid(), units: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0), reason: z.string().trim().min(5).max(300) }).strict() }, async ({ actor, db, body }) => {
    ownerOnly(actor);
    return withTx(db, async (tx) => {
      if (!(await maybeOne(tx, `SELECT 1 FROM partners WHERE id=$1`, [body.partner_id]))) throw notFound('PARTNER');
      const a = await one<{ id: string }>(tx, `INSERT INTO partner_level_adjustments (partner_id, units, reason, actor_user_id) VALUES ($1,$2,$3,$4) RETURNING id::text`, [body.partner_id, body.units, body.reason, actor.userId]);
      await audit(tx, actor, 'levels.adjustment', { type: 'partner', id: body.partner_id }, { after: { units: body.units }, reason: body.reason });
      const st = await syncPartnerLevel(tx, body.partner_id, `adjustment:${a.id}`);
      return { id: a.id, ...st };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/levels/promos', tags: A, summary: 'Owner: time-boxed extra gift discount from a minimum level (total capped at 50%)',
    body: z.object({ name: z.string().trim().min(2).max(120), min_level: z.number().int().min(0).max(99), extra_discount_bps: z.number().int().min(1).max(5000), starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }) }).strict() },
    async ({ actor, db, body }) => {
      ownerOnly(actor);
      if (body.ends_at <= body.starts_at) throw new AppError(422, 'PERIOD_INVALID');
      const r = await one<{ id: string }>(db, `INSERT INTO level_promos (name, min_level, extra_discount_bps, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [body.name, body.min_level, body.extra_discount_bps, body.starts_at, body.ends_at, actor.userId]);
      await audit(db, actor, 'levels.promo', { type: 'level_promo', id: r.id }, { after: body });
      return r;
    });
}
