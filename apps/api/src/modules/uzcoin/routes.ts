import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { transfer } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { myPartner } from '../partners/routes.js';
import { currentRate, post } from './service.js';
import { discounted, giftDiscountBps } from '../levels/service.js';

/**
 * UZSHOP PRO — UzCoin API. Partner: wallet (earned / available / pending / reserved / exchanged / spent / adjusted /
 * history), exchange preview + request (coins reserved; money goes to the wallet on approval → existing payout flow),
 * gift shop orders (stock-safe, price snapshot). Admin: report (liability), rates (versioned), gifts, exchanges,
 * gift orders. AI never creates coins or changes balances — no AI endpoint exists here.
 */
const P = ['partner', 'uzcoin'];
const A = ['admin', 'uzcoin'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
const GIFT_FLOW = ['created', 'confirmed', 'preparing', 'shipped', 'delivered'];
const zGift = z.object({ title: z.string().trim().min(2).max(160), description: z.string().max(4000).optional(), category: z.string().max(80).optional(), brand: z.string().max(80).optional(),
  images: z.array(z.string().max(500)).max(10).default([]), videos: z.array(z.string().max(500)).max(5).default([]), variant: z.string().max(200).optional(), kit: z.string().max(500).optional(),
  delivery_terms: z.string().max(1000).optional(), conditions: z.string().max(1000).optional(), price_coins: z.coerce.number().int().min(1), cost_minor: z.coerce.number().int().min(0).optional(),
  stock: z.number().int().min(0).default(0), per_partner_limit: z.number().int().min(1).optional(), status: z.enum(['draft', 'published', 'hidden']).default('draft') });

export function registerUzcoin(app: FastifyInstance, deps: Deps): void {
  // ---------------- Partner ----------------
  route(app, deps, { method: 'GET', url: '/partner/uzcoin', tags: P, summary: 'My UzCoin wallet and history (own only)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const b = await maybeOne<any>(db, `SELECT * FROM uzcoin_balances WHERE partner_id=$1`, [p.id]);
    const pending = await one<{ n: number }>(db, `SELECT COALESCE(SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty)),0)::int AS n FROM commission_accruals a JOIN order_lines ol ON ol.id=a.order_line_id
      WHERE a.partner_id=$1 AND a.state IN ('estimated','pending')`, [p.id]);
    const rate = await currentRate(db);
    const contest = await one<{ s: string }>(db, `SELECT COALESCE(SUM(coins),0)::text AS s FROM uzcoin_ledger WHERE partner_id=$1 AND kind='contest_prize'`, [p.id]);
    return {
      balance: { earned_total: String(b?.earned_total ?? 0), contest_total: contest.s, available: String(b?.available ?? 0), pending_projection: String(pending.n), reserved: String(b?.reserved ?? 0),
        exchanged_total: String(b?.exchanged_total ?? 0), spent_total: String(b?.spent_total ?? 0), adjusted_total: String(b?.adjusted_total ?? 0), debt: String(b?.debt ?? 0) },
      rate: { version: rate.version, som_per_coin_minor: rate.som_per_coin_minor },
      history: await many(db, `SELECT l.id, l.kind, l.coins::text, l.qty, l.product_name, l.reason, l.created_at, 'OM-***' || right(o.number, 3) AS order_number
        FROM uzcoin_ledger l LEFT JOIN orders o ON o.id=l.order_id WHERE l.partner_id=$1 ORDER BY l.id DESC LIMIT 200`, [p.id]),
      exchanges: await many(db, `SELECT id, coins::text, amount_minor::text, som_per_coin_minor::text, status, created_at FROM uzcoin_exchanges WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 50`, [p.id]),
      gift_orders: await many(db, `SELECT id, gift_title, price_coins::text, status, created_at FROM uzcoin_gift_orders WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 50`, [p.id]),
    };
  });

  route(app, deps, { method: 'GET', url: '/partner/uzcoin/preview', tags: P, summary: 'Exchange preview at the current rate (100 × 3 000 = 300 000 so‘m)', query: z.object({ coins: z.coerce.number().int().min(1).max(10_000_000) }) },
    async ({ actor, db, query }) => {
      await myPartner(db, actor, false);
      const r = await currentRate(db);
      return { coins: String(query.coins), rate_version: r.version, som_per_coin_minor: r.som_per_coin_minor, amount_minor: (BigInt(query.coins) * BigInt(r.som_per_coin_minor)).toString() };
    });

  route(app, deps, { method: 'POST', url: '/partner/uzcoin/exchanges', tags: P, summary: 'Request exchange to money: coins reserved at the rate snapshot (Idempotency-Key)', body: z.object({ coins: z.coerce.number().int().min(1) }) },
    async ({ actor, db, body, idempotencyKey }) => {
      const p = await myPartner(db, actor);
      if (!idempotencyKey) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
      return withTx(db, async (tx) => {
        await tx.query(`INSERT INTO uzcoin_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [p.id]);
        const bal = await one<{ available: string }>(tx, `SELECT available::text FROM uzcoin_balances WHERE partner_id=$1 FOR UPDATE`, [p.id]);
        const dup = await maybeOne<any>(tx, `SELECT id, status FROM uzcoin_exchanges WHERE partner_id=$1 AND idem_key=$2`, [p.id, idempotencyKey]);
        if (dup) return { id: dup.id, status: dup.status, replayed: true };
        if (BigInt(bal.available) < BigInt(body.coins)) throw new AppError(422, 'UZCOIN_INSUFFICIENT', { available: bal.available });
        const r = await currentRate(tx);
        const amount = BigInt(body.coins) * BigInt(r.som_per_coin_minor);
        const e = await one<{ id: string }>(tx, `INSERT INTO uzcoin_exchanges (partner_id, coins, rate_version, som_per_coin_minor, amount_minor, idem_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [p.id, body.coins, r.version, r.som_per_coin_minor, amount.toString(), idempotencyKey]);
        await post(tx, { partnerId: p.id, kind: 'exchange_reserve', available: -BigInt(body.coins), reserved: BigInt(body.coins), sourceType: 'exchange', sourceId: e.id, effectKey: 'reserve', reason: 'pulga almashtirish so‘rovi', actorId: actor.userId });
        await audit(tx, actor, 'uzcoin.exchange_requested', { type: 'uzcoin_exchange', id: e.id }, { after: { coins: body.coins, amount_minor: amount.toString(), rate_version: r.version } });
        return { id: e.id, status: 'requested', amount_minor: amount.toString(), rate_version: r.version };
      });
    });

  route(app, deps, { method: 'GET', url: '/partner/uzcoin/gifts', tags: P, summary: 'Gift shop (published gifts only)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    // Level discount shown on every card: original price, level, %, final price, saved coins.
    const lv = await maybeOne<{ level: number }>(db, `SELECT level FROM partner_level_state WHERE partner_id=$1`, [p.id]);
    const level = lv?.level ?? 0;
    const def = await maybeOne<{ name: string; badge: string }>(db, `SELECT name, badge FROM partner_level_defs WHERE level=$1`, [level]);
    const bps = await giftDiscountBps(db, level);
    const items = await many<any>(db, `SELECT id, title, description, category, brand, images, videos, variant, kit, delivery_terms, conditions, price_coins::text, stock, per_partner_limit FROM uzcoin_gifts WHERE status='published' ORDER BY price_coins`);
    return { level: { level, name: def?.name ?? null, badge: def?.badge ?? null, discount_bps: bps },
      items: items.map((g) => { const d = discounted(BigInt(g.price_coins), bps); return { ...g, base_price_coins: g.price_coins, discount_bps: bps, final_price_coins: d.final.toString(), saved_coins: d.saved.toString() }; }) };
  });

  route(app, deps, { method: 'POST', url: '/partner/uzcoin/gifts/:id/order', tags: P, summary: 'Get a gift for UzCoin: balance + stock checked, price snapshot, coins reserved (Idempotency-Key)', params: zIdParam, body: z.object({ address: z.string().trim().min(5).max(500) }) },
    async ({ actor, db, params, body, idempotencyKey }) => {
      const p = await myPartner(db, actor);
      if (!idempotencyKey) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
      return withTx(db, async (tx) => {
        const g = await maybeOne<any>(tx, `SELECT * FROM uzcoin_gifts WHERE id=$1 FOR UPDATE`, [params.id]); // one buyer at a time per gift
        if (!g || g.status !== 'published') throw notFound('GIFT');
        const dup = await maybeOne<any>(tx, `SELECT id, status FROM uzcoin_gift_orders WHERE partner_id=$1 AND idem_key=$2`, [p.id, idempotencyKey]);
        if (dup) return { id: dup.id, status: dup.status, replayed: true };
        if (g.stock < 1) throw conflict('GIFT_OUT_OF_STOCK');
        if (g.per_partner_limit) {
          const n = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM uzcoin_gift_orders WHERE gift_id=$1 AND partner_id=$2 AND status <> 'canceled'`, [g.id, p.id]);
          if (n.n >= g.per_partner_limit) throw conflict('GIFT_LIMIT_REACHED');
        }
        await tx.query(`INSERT INTO uzcoin_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [p.id]);
        const bal = await one<{ available: string }>(tx, `SELECT available::text FROM uzcoin_balances WHERE partner_id=$1 FOR UPDATE`, [p.id]);
        const lv = await maybeOne<{ level: number }>(tx, `SELECT level FROM partner_level_state WHERE partner_id=$1`, [p.id]);
        const bps = await giftDiscountBps(tx, lv?.level ?? 0);
        const { final: price, saved } = discounted(BigInt(g.price_coins), bps);
        if (BigInt(bal.available) < price) throw new AppError(422, 'UZCOIN_INSUFFICIENT', { available: bal.available, price_coins: price.toString() });
        const o = await one<{ id: string }>(tx, `INSERT INTO uzcoin_gift_orders (gift_id, partner_id, price_coins, gift_title, address, idem_key, base_price_coins, discount_bps, level_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [g.id, p.id, price.toString(), g.title, body.address, idempotencyKey, g.price_coins, bps, lv?.level ?? 0]);
        await tx.query(`UPDATE uzcoin_gifts SET stock=stock-1, updated_at=now() WHERE id=$1`, [g.id]);
        await post(tx, { partnerId: p.id, kind: 'gift_reserve', available: -price, reserved: price, sourceType: 'gift_order', sourceId: o.id, effectKey: 'reserve', reason: `sovg‘a: ${g.title}${bps ? ` (−${bps / 100}%)` : ''}`, actorId: actor.userId });
        await audit(tx, actor, 'uzcoin.gift_ordered', { type: 'uzcoin_gift_order', id: o.id }, { after: { gift_id: g.id, base_price_coins: String(g.price_coins), discount_bps: bps, price_coins: price.toString() } });
        return { id: o.id, status: 'created', price_coins: price.toString(), base_price_coins: String(g.price_coins), discount_bps: bps, saved_coins: saved.toString() };
      });
    });

  route(app, deps, { method: 'POST', url: '/partner/uzcoin/gift-orders/:id/cancel', tags: P, summary: 'Cancel my gift order before it is prepared (coins and stock come back)', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    return withTx(db, (tx) => cancelGiftOrder(tx, actor, params.id, p.id, ['created', 'confirmed']));
  });

  // ---------------- Admin ----------------
  route(app, deps, { method: 'GET', url: '/admin/uzcoin/report', tags: A, summary: 'Programme economics from the ledger: issued, balances, pending, exchanged, gifts, liability at the current rate' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    const l = await one<any>(db, `SELECT COALESCE(SUM(coins) FILTER (WHERE kind='earned_sale'),0)::text AS sales, COALESCE(SUM(coins) FILTER (WHERE kind='contest_prize'),0)::text AS contest,
        COALESCE(SUM(-coins) FILTER (WHERE kind='return_adjustment'),0)::text AS adjusted FROM uzcoin_ledger`);
    const b = await one<any>(db, `SELECT COALESCE(SUM(available),0)::text AS available, COALESCE(SUM(reserved),0)::text AS reserved, COALESCE(SUM(exchanged_total),0)::text AS exchanged, COALESCE(SUM(spent_total),0)::text AS spent, COALESCE(SUM(debt),0)::text AS debt, COALESCE(SUM(earned_total),0)::text AS earned FROM uzcoin_balances`);
    const ex = await one<any>(db, `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status='approved'),0)::text AS paid_minor, COALESCE(SUM(amount_minor) FILTER (WHERE status='requested'),0)::text AS requested_minor FROM uzcoin_exchanges`);
    const gc = await one<any>(db, `SELECT COALESCE(SUM(g.cost_minor) FILTER (WHERE o.status='delivered'),0)::text AS cost_minor, COUNT(*) FILTER (WHERE o.status='delivered')::int AS delivered FROM uzcoin_gift_orders o JOIN uzcoin_gifts g ON g.id=o.gift_id`);
    const pend = await one<{ n: number }>(db, `SELECT COALESCE(SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty)),0)::int AS n FROM commission_accruals a JOIN order_lines ol ON ol.id=a.order_line_id JOIN orders o ON o.id=a.order_id WHERE a.state IN ('estimated','pending')`);
    const rate = await currentRate(db);
    const outstanding = BigInt(b.available) + BigInt(b.reserved);
    return { rate, issued: { sales: l.sales, contest: l.contest }, returns_adjusted: l.adjusted, balances: b, pending_projection: String(pend.n), exchanges: ex, gifts: gc,
      liability: { coins: outstanding.toString(), minor: (outstanding * BigInt(rate.som_per_coin_minor)).toString(), note: 'Mavjud + band UzCoin × joriy kurs. Do‘kon foydasidan alohida.' },
      total_programme_cost_minor: (BigInt(ex.paid_minor) + BigInt(gc.cost_minor)).toString() };
  });

  route(app, deps, { method: 'POST', url: '/admin/uzcoin/rates', tags: A, summary: 'New rate version (owner). Old exchanges keep their snapshot.', body: z.object({ som_per_coin_minor: z.coerce.number().int().min(1), effective_from: z.string().datetime({ offset: true }).optional(), reason: z.string().trim().min(5).max(300) }) },
    async ({ actor, db, body }) => {
      if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
      const v = (await one<{ v: number }>(db, `SELECT COALESCE(MAX(version),0)+1 AS v FROM uzcoin_rates`)).v;
      await db.query(`INSERT INTO uzcoin_rates (version, som_per_coin_minor, effective_from, reason, created_by) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5)`, [v, body.som_per_coin_minor, body.effective_from ?? null, body.reason, actor.userId]);
      await audit(db, actor, 'uzcoin.rate_set', { type: 'uzcoin_rate', id: String(v) }, { after: body });
      return { version: v };
    });

  route(app, deps, { method: 'GET', url: '/admin/uzcoin/gifts', tags: A, summary: 'All gifts' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    return { items: await many(db, `SELECT * FROM uzcoin_gifts ORDER BY created_at DESC`) };
  });
  route(app, deps, { method: 'POST', url: '/admin/uzcoin/gifts', tags: A, summary: 'Add a gift (sample prices are the admin’s decision)', body: zGift }, async ({ actor, db, body }) => {
    requirePerm(actor, 'partners.manage');
    const g = await one<{ id: string }>(db, `INSERT INTO uzcoin_gifts (title, description, category, brand, images, videos, variant, kit, delivery_terms, conditions, price_coins, cost_minor, stock, per_partner_limit, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [body.title, body.description ?? null, body.category ?? null, body.brand ?? null, JSON.stringify(body.images), JSON.stringify(body.videos), body.variant ?? null, body.kit ?? null, body.delivery_terms ?? null, body.conditions ?? null, body.price_coins, body.cost_minor ?? null, body.stock, body.per_partner_limit ?? null, body.status, actor.userId]);
    await audit(db, actor, 'uzcoin.gift_created', { type: 'uzcoin_gift', id: g.id }, { after: { title: body.title, price_coins: body.price_coins } });
    return { id: g.id };
  });
  route(app, deps, { method: 'PUT', url: '/admin/uzcoin/gifts/:id', tags: A, summary: 'Edit a gift (existing orders keep their price snapshot)', params: zIdParam, body: zGift.extend({ expected_version: z.number().int() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      const r = await db.query(`UPDATE uzcoin_gifts SET title=$2, description=$3, category=$4, brand=$5, images=$6, videos=$7, variant=$8, kit=$9, delivery_terms=$10, conditions=$11, price_coins=$12, cost_minor=$13, stock=$14, per_partner_limit=$15, status=$16, version=version+1, updated_at=now()
        WHERE id=$1 AND version=$17 RETURNING version`,
        [params.id, body.title, body.description ?? null, body.category ?? null, body.brand ?? null, JSON.stringify(body.images), JSON.stringify(body.videos), body.variant ?? null, body.kit ?? null, body.delivery_terms ?? null, body.conditions ?? null, body.price_coins, body.cost_minor ?? null, body.stock, body.per_partner_limit ?? null, body.status, body.expected_version]);
      if (!r.rowCount) throw conflict('GIFT_VERSION_CONFLICT');
      await audit(db, actor, 'uzcoin.gift_updated', { type: 'uzcoin_gift', id: params.id }, { after: { price_coins: body.price_coins, stock: body.stock, status: body.status } });
      return { version: r.rows[0].version };
    });

  route(app, deps, { method: 'GET', url: '/admin/uzcoin/queues', tags: A, summary: 'Exchange requests and gift orders' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    return {
      exchanges: await many(db, `SELECT e.*, p.display_name, p.code FROM uzcoin_exchanges e JOIN partners p ON p.id=e.partner_id ORDER BY (e.status='requested') DESC, e.created_at DESC LIMIT 100`),
      gift_orders: await many(db, `SELECT o.*, p.display_name, p.code FROM uzcoin_gift_orders o JOIN partners p ON p.id=o.partner_id ORDER BY (o.status IN ('created','confirmed','preparing','shipped')) DESC, o.created_at DESC LIMIT 100`),
    };
  });

  route(app, deps, { method: 'POST', url: '/admin/uzcoin/exchanges/:id/:decision', tags: A, summary: 'Approve (money to wallet → payout) or reject (coins back)', params: z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'reject']) }), body: z.object({ reason: z.string().max(300).optional() }).default({}) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const e = await maybeOne<any>(tx, `SELECT * FROM uzcoin_exchanges WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!e) throw notFound('EXCHANGE');
        if (e.status !== 'requested') return { id: e.id, status: e.status, replayed: true };
        const coins = BigInt(e.coins);
        if (params.decision === 'approve') {
          await post(tx, { partnerId: e.partner_id, kind: 'exchange_paid', available: 0n, reserved: -coins, exchanged: coins, sourceType: 'exchange', sourceId: e.id, effectKey: 'paid', reason: `pulga almashtirildi (${e.som_per_coin_minor / 100} so‘m/coin)`, actorId: actor.userId });
          await transfer(tx, { partnerId: e.partner_id, from: 'external', to: 'available', amount: BigInt(e.amount_minor), sourceType: 'uzcoin_exchange', sourceId: e.id, effectKey: 'v1', reason: `UzCoin almashtirish: ${e.coins} coin`, actorId: actor.userId });
          await postJournal(tx, `uzcoin:${e.id}`, 'uzcoin_exchange', [{ account: 'reward_expense', debit: BigInt(e.amount_minor) }, { account: 'partner_payable', credit: BigInt(e.amount_minor) }]);
        } else {
          await post(tx, { partnerId: e.partner_id, kind: 'exchange_release', available: coins, reserved: -coins, sourceType: 'exchange', sourceId: e.id, effectKey: 'release', reason: body.reason ?? 'so‘rov rad etildi', actorId: actor.userId });
        }
        await tx.query(`UPDATE uzcoin_exchanges SET status=$2, decided_by=$3, decided_at=now(), reason=$4 WHERE id=$1`, [e.id, params.decision === 'approve' ? 'approved' : 'rejected', actor.userId, body.reason ?? null]);
        await audit(tx, actor, `uzcoin.exchange_${params.decision}`, { type: 'uzcoin_exchange', id: e.id }, { after: { coins: e.coins, amount_minor: e.amount_minor }, reason: body.reason });
        return { id: e.id, status: params.decision === 'approve' ? 'approved' : 'rejected' };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/uzcoin/gift-orders/:id/status', tags: A, summary: 'Gift order: confirmed → preparing → shipped → delivered, or canceled (coins + stock back)', params: zIdParam, body: z.object({ status: z.enum(['confirmed', 'preparing', 'shipped', 'delivered', 'canceled']) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage');
      return withTx(db, async (tx) => {
        if (body.status === 'canceled') return cancelGiftOrder(tx, actor, params.id, null, ['created', 'confirmed', 'preparing']);
        const o = await maybeOne<any>(tx, `SELECT * FROM uzcoin_gift_orders WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!o) throw notFound('GIFT_ORDER');
        if (GIFT_FLOW.indexOf(body.status) !== GIFT_FLOW.indexOf(o.status) + 1) throw conflict('GIFT_ORDER_STATUS_INVALID', { status: o.status });
        if (body.status === 'delivered') await post(tx, { partnerId: o.partner_id, kind: 'gift_spent', available: 0n, reserved: -BigInt(o.price_coins), spent: BigInt(o.price_coins), sourceType: 'gift_order', sourceId: o.id, effectKey: 'spent', reason: `sovg‘a topshirildi: ${o.gift_title}`, actorId: actor.userId });
        await tx.query(`UPDATE uzcoin_gift_orders SET status=$2, updated_at=now() WHERE id=$1`, [o.id, body.status]);
        await audit(tx, actor, 'uzcoin.gift_order_status', { type: 'uzcoin_gift_order', id: o.id }, { before: { status: o.status }, after: { status: body.status } });
        return { ok: true, status: body.status };
      });
    });
}

async function cancelGiftOrder(tx: any, actor: Actor, id: string, partnerId: string | null, allowed: string[]) {
  const o = await maybeOne<any>(tx, `SELECT * FROM uzcoin_gift_orders WHERE id=$1 ${partnerId ? 'AND partner_id=$2' : ''} FOR UPDATE`, partnerId ? [id, partnerId] : [id]);
  if (!o) throw notFound('GIFT_ORDER');
  if (o.status === 'canceled') return { ok: true, status: 'canceled', replayed: true };
  if (!allowed.includes(o.status)) throw conflict('GIFT_ORDER_NOT_CANCELABLE', { status: o.status });
  await post(tx, { partnerId: o.partner_id, kind: 'gift_release', available: BigInt(o.price_coins), reserved: -BigInt(o.price_coins), sourceType: 'gift_order', sourceId: o.id, effectKey: 'release', reason: `sovg‘a bekor qilindi: ${o.gift_title}`, actorId: actor.userId });
  await tx.query(`UPDATE uzcoin_gifts SET stock=stock+1, updated_at=now() WHERE id=$1`, [o.gift_id]);
  await tx.query(`UPDATE uzcoin_gift_orders SET status='canceled', updated_at=now() WHERE id=$1`, [o.id]);
  await audit(tx, actor, 'uzcoin.gift_order_canceled', { type: 'uzcoin_gift_order', id: o.id }, { before: { status: o.status } });
  return { ok: true, status: 'canceled' };
}
