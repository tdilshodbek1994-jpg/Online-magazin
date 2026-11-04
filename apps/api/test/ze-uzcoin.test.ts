import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { recalcOrder, releaseMatured } from '../src/modules/commissions/service.js';
import { post, syncOrderCoins } from '../src/modules/uzcoin/service.js';
import { withTx } from '../src/platform/db.js';
import { api, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, tiyin } from './helpers.js';

/** UZSHOP PRO — UzCoin acceptance tests (task §15). Separate database; real order flow. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_uzcoin');
  s = await staff(t);
});
const later = () => new Date(Date.now() + 400 * 86400e3);
async function sale(p: { code: string }, qty: number, commissionSom = 30_000) {
  const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: commissionSom } });
  const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty }], { referral_code: p.code });
  const id = o.json.order_id as string;
  const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
  await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
  await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
  await fulfilCod(t, s, id);
  await withTx(t.db, (tx) => releaseMatured(tx, later()));
  return id;
}
const wallet = async (p: { token: string }) => { const r = await api(t, 'GET', '/partner/uzcoin', { token: p.token }); if (r.status !== 200) console.log('WALLET', r.status, JSON.stringify(r.json)); return r.json; };
async function give(partnerId: string, coins: number) {
  await withTx(t.db, (tx) => post(tx, { partnerId, kind: 'correction', available: BigInt(coins), sourceType: 'test', sourceId: randomUUID(), effectKey: 'seed', reason: 'test balans' }));
}

describe('UzCoin', () => {
  it('#1 + #2 + #3: 1 unit = 1 coin, 3 units = 3 coins (commission size does not matter); replays add nothing', async () => {
    const p = await mkPartner(t);
    await sale(p, 1, 30_000);
    expect((await wallet(p)).balance.available).toBe('1');
    const id = await sale(p, 3, 5_000);
    expect((await wallet(p)).balance.available).toBe('4');
    await withTx(t.db, (tx) => syncOrderCoins(tx, id));
    await withTx(t.db, (tx) => releaseMatured(tx, later()));
    const w = await wallet(p);
    expect(w.balance.available).toBe('4');
    expect(w.balance.earned_total).toBe('4');
    expect(w.history.find((h: any) => h.kind === 'earned_sale' && h.qty === 3).order_number).toMatch(/^OM-\*\*\*/);
  });

  it('#4 + #13: a cancelled order and an unconfirmed proxy order earn no coins', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 30_000 } });
    const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 2 }], { referral_code: p.code });
    await api(t, 'POST', `/ops/orders/${o.json.order_id}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${o.json.order_id}/calls`, { token: s.operator.token, body: { outcome: 'rejected' } });
    await withTx(t.db, (tx) => syncOrderCoins(tx, o.json.order_id));
    await withTx(t.db, (tx) => releaseMatured(tx, later()));
    expect((await wallet(p)).balance.available).toBe('0');
  });

  it('#5: partial return after coins were issued => visible −1 adjustment', async () => {
    const p = await mkPartner(t);
    const id = await sale(p, 3);
    await t.db.query(`UPDATE order_lines SET returned_qty=1 WHERE order_id=$1`, [id]);
    await withTx(t.db, (tx) => recalcOrder(tx, id, 'return'));
    const w = await wallet(p);
    expect(w.balance.available).toBe('2');
    expect(w.balance.adjusted_total).toBe('1');
    expect(w.history.some((h: any) => h.kind === 'return_adjustment' && h.coins === '-1')).toBe(true);
  });

  it('#6 + #7 + #8 + #9 + #16: preview 100 × 3 000 = 300 000; insufficient rejected; double click = one request; rejection restores; a new rate never changes the old request', async () => {
    const p = await mkPartner(t);
    expect((await api(t, 'GET', '/partner/uzcoin/preview?coins=100', { token: p.token })).json.amount_minor).toBe(tiyin(300_000));
    await give(p.partnerId, 100);
    expect((await api(t, 'POST', '/partner/uzcoin/exchanges', { token: p.token, idem: randomUUID(), body: { coins: 101 } })).json.code).toBe('UZCOIN_INSUFFICIENT');
    const key = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', '/partner/uzcoin/exchanges', { token: p.token, idem: key, body: { coins: 100 } })));
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM uzcoin_exchanges WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(1);
    let w = await wallet(p);
    expect([w.balance.available, w.balance.reserved]).toEqual(['0', '100']);
    expect((await api(t, 'POST', '/admin/uzcoin/rates', { token: s.owner.token, body: { som_per_coin_minor: Number(tiyin(3_500)), reason: 'yangi kurs testi' } })).status).toBe(200);
    expect((await t.db.query(`SELECT amount_minor::text FROM uzcoin_exchanges WHERE partner_id=$1`, [p.partnerId])).rows[0].amount_minor).toBe(tiyin(300_000));
    const ex = (a!.json.id ?? b!.json.id) as string;
    expect((await api(t, 'POST', `/admin/uzcoin/exchanges/${ex}/reject`, { token: s.owner.token, body: { reason: 'test' } })).json.status).toBe('rejected');
    w = await wallet(p);
    expect([w.balance.available, w.balance.reserved]).toEqual(['100', '0']);
    await t.db.query(`DELETE FROM uzcoin_rates WHERE version > 1`).catch(() => {});
  });

  it('#19 + approve: two parallel exchanges cannot spend the same coins; approval credits the wallet once', async () => {
    const p = await mkPartner(t);
    await give(p.partnerId, 3);
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', '/partner/uzcoin/exchanges', { token: p.token, idem: randomUUID(), body: { coins: 2 } })));
    expect([a!.status, b!.status].sort()).toEqual([200, 422]);
    const ok = a!.status === 200 ? a! : b!;
    const before = (await t.db.query(`SELECT available_minor::text a FROM partner_balances WHERE partner_id=$1`, [p.partnerId])).rows[0]?.a ?? '0';
    await api(t, 'POST', `/admin/uzcoin/exchanges/${ok.json.id}/approve`, { token: s.owner.token, body: {} });
    await api(t, 'POST', `/admin/uzcoin/exchanges/${ok.json.id}/approve`, { token: s.owner.token, body: {} });
    const after = (await t.db.query(`SELECT available_minor::text a FROM partner_balances WHERE partner_id=$1`, [p.partnerId])).rows[0].a;
    expect(BigInt(after) - BigInt(before)).toBe(BigInt(ok.json.amount_minor));
    expect((await wallet(p)).balance.exchanged_total).toBe('2');
  });

  it('#10 + #11 + #17: last gift cannot go to two buyers; price change keeps the order snapshot; cancel restores coins and stock', async () => {
    const p1 = await mkPartner(t), p2 = await mkPartner(t);
    await give(p1.partnerId, 50_000); await give(p2.partnerId, 50_000);
    const g = await api(t, 'POST', '/admin/uzcoin/gifts', { token: s.owner.token, body: { title: 'iPhone (namuna)', price_coins: 40_000, stock: 1, status: 'published' } });
    const [x, y] = await Promise.all([p1, p2].map((p) => api(t, 'POST', `/partner/uzcoin/gifts/${g.json.id}/order`, { token: p.token, idem: randomUUID(), body: { address: 'Toshkent, Chilonzor 1' } })));
    expect([x!.status, y!.status].sort()).toEqual([200, 409]);
    const won = x!.status === 200 ? x! : y!;
    const gift = (await api(t, 'GET', '/admin/uzcoin/gifts', { token: s.owner.token })).json.items.find((i: any) => i.id === g.json.id);
    await api(t, 'PUT', `/admin/uzcoin/gifts/${g.json.id}`, { token: s.owner.token, body: { title: gift.title, price_coins: 45_000, stock: 0, status: 'published', expected_version: gift.version } });
    expect((await t.db.query(`SELECT price_coins::text FROM uzcoin_gift_orders WHERE id=$1`, [won.json.id])).rows[0].price_coins).toBe('40000');
    expect((await api(t, 'POST', `/admin/uzcoin/gift-orders/${won.json.id}/status`, { token: s.owner.token, body: { status: 'canceled' } })).json.status).toBe('canceled');
    const winner = x!.status === 200 ? p1 : p2;
    expect((await wallet(winner)).balance.available).toBe('50000');
    expect((await t.db.query(`SELECT stock FROM uzcoin_gifts WHERE id=$1`, [g.json.id])).rows[0].stock).toBe(1);
  });

  it('#12 + #14 + #15 + #18: contest coin prize once; partners see only their own wallet; works with AI off; report equals the ledger', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='ai.enabled'`);
    const a = await mkPartner(t), b = await mkPartner(t);
    const award = randomUUID();
    for (let i = 0; i < 2; i++) await withTx(t.db, (tx) => post(tx, { partnerId: a.partnerId, kind: 'contest_prize', available: 1000n, sourceType: 'cc_award', sourceId: award, effectKey: 'prize', reason: '1-o‘rin' }));
    expect((await wallet(a)).balance.contest_total).toBe('1000');
    expect((await wallet(b)).history).toEqual([]);
    const r = (await api(t, 'GET', '/admin/uzcoin/report', { token: s.owner.token })).json;
    const sums = (await t.db.query(`SELECT COALESCE(SUM(available),0)::text av, COALESCE(SUM(reserved),0)::text rs FROM uzcoin_balances`)).rows[0];
    const fromLedger = (await t.db.query(`SELECT COALESCE(SUM(coins),0)::text s FROM uzcoin_ledger`)).rows[0].s;
    expect(r.balances.available).toBe(sums.av);
    expect(BigInt(fromLedger)).toBe(BigInt(sums.av)); // reserve/release only move between available and reserved; ledger sum = available
    expect(r.liability.coins).toBe((BigInt(sums.av) + BigInt(sums.rs)).toString());
  });
});
