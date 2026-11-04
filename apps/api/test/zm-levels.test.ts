import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { api, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, tiyin } from './helpers.js';

/** UZSHOP Partner Level & Loyalty PRO — acceptance cases 1–12 of the task, on a separate database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_levels');
  s = await staff(t);
});
const later = () => new Date(Date.now() + 400 * 86400e3);
type P = Awaited<ReturnType<typeof mkPartner>>;
async function order(p: P, skuId: string, qty: number) {
  const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: skuId, qty }], { referral_code: p.code });
  expect(o.status).toBe(201);
  return o.json.order_id as string;
}
async function complete(id: string) {
  const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
  await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
  expect((await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
  await fulfilCod(t, s, id);
  await withTx(t.db, (tx) => releaseMatured(tx, later()));
}
const level = async (p: P) => (await api(t, 'GET', '/partner/level', { token: p.token })).json;
const adjust = async (p: P, units: number, token = s.owner.token) => { const r = await api(t, 'POST', '/admin/levels/adjustments', { token, body: { partner_id: p.partnerId, units, reason: 'test: tarixiy sotuvlar' } }); expect(r.status, JSON.stringify(r.json)).toBe(200); return r; };

describe('Partner levels', () => {
  it('cases 1–4: 49 → Boshlovchi, 50 → Do‘st, 100 → Qadrdon, 500 → Ishonchli hamkor; next-level remainder shown', async () => {
    const p = await mkPartner(t);
    await adjust(p, 49);
    let l = await level(p);
    expect(l.level.name).toBe('Boshlovchi');
    expect(l.next).toMatchObject({ name: 'Do‘st', remaining: 1 });
    await adjust(p, 1);
    expect((await level(p)).level.name).toBe('Do‘st');
    await adjust(p, 50);
    expect((await level(p)).level.name).toBe('Qadrdon');
    await adjust(p, 400);
    l = await level(p);
    expect(l.level).toMatchObject({ level: 3, name: 'Ishonchli hamkor' });
    expect(l.next).toMatchObject({ name: 'Faol hamkor', remaining: 500 });
    expect(l.history.map((h: any) => h.to_level)).toEqual([3, 2, 1]);
  });

  it('cases 7 + 8 + 9: cancelled orders do not count, returned units are removed, a sale is counted once', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
    const kept = await order(p, prod.skuIds[0]!, 3);
    await complete(kept);
    expect((await level(p)).units).toBe(3);
    const cancelled = await order(p, prod.skuIds[0]!, 2);
    await api(t, 'POST', `/ops/orders/${cancelled}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${cancelled}/calls`, { token: s.operator.token, body: { outcome: 'rejected' } });
    await withTx(t.db, (tx) => releaseMatured(tx, later()));
    expect((await level(p)).units).toBe(3);
    // replays of the release/recalc never add units again
    await withTx(t.db, (tx) => releaseMatured(tx, later()));
    const { recalcOrder } = await import('../src/modules/commissions/service.js');
    await withTx(t.db, (tx) => recalcOrder(tx, kept, 'replay'));
    expect((await level(p)).units).toBe(3);
    // return of 1 unit → recomputed
    const line = (await t.db.query(`SELECT id FROM order_lines WHERE order_id=$1`, [kept])).rows[0].id;
    await t.db.query(`UPDATE order_lines SET returned_qty=1 WHERE id=$1`, [line]);
    await withTx(t.db, (tx) => recalcOrder(tx, kept, 'return'));
    expect((await level(p)).units).toBe(2);
  });

  it('case 5 + 11: 10 000 units → one-time 50% coupon; used on exactly one completed eligible order, never again', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [50], rule: { kind: 'percent', bps: 3000 } });
    await t.db.query(`UPDATE skus SET cost_minor=$2 WHERE product_id=$1`, [prod.productId, tiyin(30_000)]);
    expect((await api(t, 'PUT', `/admin/levels/benefit-products/${prod.productId}`, { token: s.catalog.token, body: { enabled: true } })).status).toBe(403);
    expect((await api(t, 'PUT', `/admin/levels/benefit-products/${prod.productId}`, { token: s.owner.token, body: { enabled: true } })).status).toBe(200);
    await adjust(p, 9_999);
    expect((await level(p)).coupon).toBeNull();
    await complete(await order(p, prod.skuIds[0]!, 1)); // the 10 000th qualified unit
    let l = await level(p);
    expect(l.units).toBe(10_000);
    expect(l.level.name).toBe('Elita hamkor');
    expect(l.coupon.status).toBe('available');
    // not armed → normal 30%
    const normal = await order(p, prod.skuIds[0]!, 1);
    expect((await t.db.query(`SELECT target_minor::text t FROM commission_accruals WHERE order_id=$1`, [normal])).rows[0].t).toBe(tiyin(30_000));
    expect((await api(t, 'POST', '/partner/level/coupon/arm', { token: p.token })).json.status).toBe('armed');
    const withCoupon = await order(p, prod.skuIds[0]!, 1);
    expect((await t.db.query(`SELECT target_minor::text t, rule_snapshot->'benefit'->>'kind' k FROM commission_accruals WHERE order_id=$1`, [withCoupon])).rows[0]).toEqual({ t: tiyin(50_000), k: 'coupon' });
    expect((await level(p)).coupon.status).toBe('reserved');
    const after = await order(p, prod.skuIds[0]!, 1); // coupon already reserved by another order → normal rate
    expect((await t.db.query(`SELECT target_minor::text t FROM commission_accruals WHERE order_id=$1`, [after])).rows[0].t).toBe(tiyin(30_000));
    await complete(withCoupon);
    l = await level(p);
    expect(l.coupon.status).toBe('used');
    expect((await api(t, 'POST', '/partner/level/coupon/arm', { token: p.token })).json.code).toBe('COUPON_NOT_AVAILABLE');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM partner_commission_coupons WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(1);
  });

  it('coupon comes back if its order is cancelled; insufficient margin keeps the normal rate', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [50], rule: { kind: 'percent', bps: 3000 } });
    await t.db.query(`UPDATE skus SET cost_minor=$2 WHERE product_id=$1`, [prod.productId, tiyin(30_000)]);
    await api(t, 'PUT', `/admin/levels/benefit-products/${prod.productId}`, { token: s.owner.token, body: { enabled: true } });
    await adjust(p, 10_000);
    await api(t, 'POST', '/partner/level/coupon/arm', { token: p.token });
    const o = await order(p, prod.skuIds[0]!, 1);
    expect((await level(p)).coupon.status).toBe('reserved');
    await api(t, 'POST', `/ops/orders/${o}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${o}/calls`, { token: s.operator.token, body: { outcome: 'rejected' } });
    expect((await level(p)).coupon.status).toBe('armed');
    // expensive product: 100 000 − cost 70 000 − 50 000 < 0 → benefit refused, 30% stays
    const thin = await mkProduct(t, { prices: [100_000], stock: [5], rule: { kind: 'percent', bps: 3000 } });
    await t.db.query(`UPDATE skus SET cost_minor=$2 WHERE product_id=$1`, [thin.productId, tiyin(70_000)]);
    await api(t, 'PUT', `/admin/levels/benefit-products/${thin.productId}`, { token: s.owner.token, body: { enabled: true } });
    const o2 = await order(p, thin.skuIds[0]!, 1);
    const a = (await t.db.query(`SELECT target_minor::text t, rule_snapshot->'benefit_check'->>'result' r FROM commission_accruals WHERE order_id=$1`, [o2])).rows[0];
    expect(a).toEqual({ t: tiyin(30_000), r: 'margin_insufficient' });
    expect((await level(p)).coupon.status).toBe('armed');
  });

  it('case 6: 100 000 units → VIP 50% on eligible products; quantity matrix 100/25 coefficients kept; old orders unchanged', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='commission.quantity_matrix'`);
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [50] });
    await t.db.query(`UPDATE skus SET cost_minor=$2 WHERE product_id=$1`, [prod.productId, tiyin(20_000)]);
    expect((await api(t, 'POST', '/admin/commission-rules/matrix', { token: s.owner.token, body: { product_ids: [prod.productId], base_minor: tiyin(30_000), matrix: { '1': [10000], '2': [10000, 2500], '3': [10000, 5000, 2500] }, note: 'test matrix' } })).status).toBe(200);
    await api(t, 'PUT', `/admin/levels/benefit-products/${prod.productId}`, { token: s.owner.token, body: { enabled: true } });
    const before = await order(p, prod.skuIds[0]!, 2);
    const sum = async (id: string) => (await t.db.query(`SELECT SUM(target_minor)::text s FROM commission_accruals WHERE order_id=$1 AND state<>'superseded'`, [id])).rows[0].s;
    expect(await sum(before)).toBe(tiyin(37_500));
    await adjust(p, 100_000);
    const l = await level(p);
    expect(l.level.name).toBe('UzShop Legend');
    expect(l.vip.active).toBe(true);
    const vip = await order(p, prod.skuIds[0]!, 2);
    expect(await sum(vip)).toBe(tiyin(62_500)); // 50 000 + 25% × 50 000
    expect(await sum(before)).toBe(tiyin(37_500)); // versioned snapshot: old order untouched
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='commission.quantity_matrix'`);
  });

  it('case 10: gift price after level discount (Elita 10%: 1 000 → 900, saved 100); atomic, no negative balance, no double purchase', async () => {
    const p = await mkPartner(t);
    await adjust(p, 10_000);
    const g = await api(t, 'POST', '/admin/uzcoin/gifts', { token: s.owner.token, body: { title: 'Powerbank', price_coins: 1000, stock: 5, status: 'published', images: [], videos: [] } });
    expect(g.status).toBe(200);
    const list = await api(t, 'GET', '/partner/uzcoin/gifts', { token: p.token });
    const card = list.json.items.find((x: any) => x.id === g.json.id);
    expect(list.json.level).toMatchObject({ name: 'Elita hamkor', discount_bps: 1000 });
    expect(card).toMatchObject({ base_price_coins: '1000', discount_bps: 1000, final_price_coins: '900', saved_coins: '100' });
    // 950 coins: enough for the discounted price, not for two
    await t.db.query(`INSERT INTO uzcoin_balances (partner_id, available) VALUES ($1, 950) ON CONFLICT (partner_id) DO UPDATE SET available=950`, [p.partnerId]);
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', `/partner/uzcoin/gifts/${g.json.id}/order`, { token: p.token, idem: randomUUID(), body: { address: 'Toshkent, Chilonzor 1' } })));
    const ok = [a!, b!].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.json).toMatchObject({ price_coins: '900', base_price_coins: '1000', saved_coins: '100' });
    expect([a!, b!].find((r) => r.status !== 200)!.json.code).toBe('UZCOIN_INSUFFICIENT');
    expect((await t.db.query(`SELECT available::text, reserved::text FROM uzcoin_balances WHERE partner_id=$1`, [p.partnerId])).rows[0]).toEqual({ available: '50', reserved: '900' });
    expect((await t.db.query(`SELECT base_price_coins::text, discount_bps, level_snapshot FROM uzcoin_gift_orders WHERE id=$1`, [ok[0]!.json.id])).rows[0]).toEqual({ base_price_coins: '1000', discount_bps: 1000, level_snapshot: 10 });
  });

  it('case 12: admin changes (levels, benefit products, adjustments) are audited; thresholds must increase', async () => {
    const cur = (await api(t, 'GET', '/admin/levels', { token: s.owner.token })).json.defs;
    const defs = cur.map((d: any) => ({ level: d.level, name: d.name, threshold: d.threshold, badge: d.badge, color: d.color, gift_discount_bps: d.gift_discount_bps, perks: d.perks }));
    defs[1].name = 'Do‘st (yangi)';
    expect((await api(t, 'PUT', '/admin/levels', { token: s.catalog.token, body: { reason: 'nom o‘zgardi', defs } })).status).toBe(403);
    expect((await api(t, 'PUT', '/admin/levels', { token: s.owner.token, body: { reason: 'nom o‘zgardi', defs } })).status).toBe(200);
    const bad = defs.map((d: any) => ({ ...d })); bad[2].threshold = 10;
    expect((await api(t, 'PUT', '/admin/levels', { token: s.owner.token, body: { reason: 'xato chegaralar', defs: bad } })).json.code).toBe('THRESHOLDS_MUST_INCREASE');
    const actions = (await t.db.query(`SELECT DISTINCT action FROM audit_events WHERE action LIKE 'levels.%' OR action LIKE 'partner.level%' OR action LIKE 'partner.coupon%'`)).rows.map((r: any) => r.action);
    for (const a of ['levels.defs_changed', 'levels.benefit_product', 'levels.adjustment', 'partner.level_changed', 'partner.coupon_issued']) expect(actions).toContain(a);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM partner_level_def_versions`)).rows[0].n).toBeGreaterThan(0);
    defs[1].name = 'Do‘st';
    await api(t, 'PUT', '/admin/levels', { token: s.owner.token, body: { reason: 'qaytarildi', defs } });
  });

  it('AI advice is analysis only and never changes benefits', async () => {
    const p = await mkPartner(t);
    await adjust(p, 40);
    const a = await api(t, 'GET', '/partner/level/advice', { token: p.token });
    expect(a.status).toBe(200);
    expect(a.json.remaining).toBe(10);
    expect(a.json.tips.join(' ')).toMatch(/10 ta tasdiqlangan sotuv qoldi/);
    expect((await api(t, 'POST', '/admin/levels/adjustments', { token: p.token, body: { partner_id: p.partnerId, units: 100, reason: 'o‘zimga qo‘shaman' } })).status).toBe(403);
  });
});
