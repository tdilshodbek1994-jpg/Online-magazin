import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyCharityAuto, share } from '../src/modules/charity/service.js';
import { withTx } from '../src/platform/db.js';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { address, api, balances, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, tiyin, zoneId } from './helpers.js';

/** UZSHOP PRO — Charity Center acceptance tests (task §9: 1–15 where covered). Separate database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_charity');
  s = await staff(t);
});
async function credit(partnerId: string, som: number) {
  await api(t, 'POST', '/admin/bonuses', { token: s.owner.token, body: { partner_id: partnerId, amount_minor: tiyin(som), reason: 'test balans' } });
}
/** Real path: referral order → operator confirm → delivered + COD remitted → hold elapsed → commission AVAILABLE (charity hook runs there). */
async function settledAccrual(p: { code: string; partnerId: string }, commissionSom: number) {
  const prod = await mkProduct(t, { prices: [200_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: commissionSom } });
  const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
  const id = o.json.order_id;
  const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
  await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
  await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
  await fulfilCod(t, s, id);
  await withTx(t.db, (tx) => releaseMatured(tx, new Date(Date.now() + 400 * 86400e3)));
  return (await t.db.query(`SELECT id, partner_id, order_id, target_minor, state FROM commission_accruals WHERE order_id=$1`, [id])).rows[0];
}
const setRule = (p: { token: string }, bps: number, extra: Record<string, unknown> = {}) => api(t, 'PUT', '/partner/charity/rule', { token: p.token, body: { consent: true, percent_bps: bps, ...extra } });

describe('Charity Center', () => {
  it('#1 + #2: 300 000 × 1% = 3 000 (297 000 left); 37 500 × 1% = 375; 52 500 × 1% = 525', async () => {
    expect(share(BigInt(tiyin(300_000)), 100)).toBe(BigInt(tiyin(3_000)));
    expect(share(BigInt(tiyin(37_500)), 100)).toBe(BigInt(tiyin(375)));
    expect(share(BigInt(tiyin(52_500)), 100)).toBe(BigInt(tiyin(525)));
    const p = await mkPartner(t);
    const pv = await api(t, 'GET', `/partner/charity/preview?amount_minor=${tiyin(300_000)}&percent_bps=100`, { token: p.token });
    expect(pv.json).toMatchObject({ share_minor: tiyin(3_000), left_minor: tiyin(297_000) });
  });

  it('#3 + #4 + #5 + #15: default OFF; with consent one share per commission event (hook on availability); off stops new shares; old entries unchanged', async () => {
    const p = await mkPartner(t);
    const a1 = await settledAccrual(p, 30_000);
    expect(a1.state).toBe('available');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM charity_donations WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(0); // default OFF
    expect((await setRule(p, 100)).status).toBe(200);
    const a2 = await settledAccrual(p, 30_000);
    const d = (await t.db.query(`SELECT amount_minor::text, percent_bps, source, status FROM charity_donations WHERE commission_accrual_id=$1`, [a2.id])).rows;
    expect(d).toEqual([{ amount_minor: tiyin(300), percent_bps: 100, source: 'auto', status: 'transferred_to_fund' }]);
    expect(await withTx(t.db, (tx) => applyCharityAuto(tx, a2))).toBe(0n); // the same event again
    await setRule(p, 500); // 5% from now on — the old entry keeps 1%
    expect((await t.db.query(`SELECT percent_bps FROM charity_donations WHERE commission_accrual_id=$1`, [a2.id])).rows[0].percent_bps).toBe(100);
    expect((await api(t, 'POST', '/partner/charity/rule/cancel', { token: p.token })).status).toBe(200);
    await settledAccrual(p, 30_000);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM charity_donations WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(1);
  });

  it('#13: an unconfirmed proxy (partner-assisted) order gives no charity share', async () => {
    const p = await mkPartner(t);
    await setRule(p, 100);
    const prod = await mkProduct(t, { prices: [50_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const q = await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: nextPhone() } } });
    const o = await api(t, 'POST', '/partner/orders', { token: p.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda' } });
    expect(o.status).toBe(201);
    expect(await withTx(t.db, (tx) => applyCharityAuto(tx, { id: randomUUID(), partner_id: p.partnerId, order_id: o.json.order_id, target_minor: tiyin(5_000) }))).toBe(0n);
  });

  it('#6 + #7 + #14: one-time gift needs enough balance; double click = one operation; a payout reservation and a gift cannot spend the same money', async () => {
    const p = await mkPartner(t);
    await credit(p.partnerId, 100_000);
    const key = randomUUID();
    const [x, y] = await Promise.all([1, 2].map(() => api(t, 'POST', '/partner/charity', { token: p.token, idem: key, body: { amount_minor: tiyin(10_000) } })));
    expect([x!.status, y!.status]).toEqual([200, 200]);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM charity_donations WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(1);
    expect((await balances(t, p.partnerId)).a).toBe(tiyin(90_000));
    const tooMuch = await api(t, 'POST', '/partner/charity', { token: p.token, idem: randomUUID(), body: { amount_minor: tiyin(95_000) } });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.json.code).toBe('INSUFFICIENT_AVAILABLE');
    // Same money cannot be in two places: the balance CHECK (available >= 0) guards payout vs gift.
    await t.db.query(`UPDATE partner_balances SET available_minor = available_minor - $2, reserved_minor = reserved_minor + $2 WHERE partner_id=$1`, [p.partnerId, tiyin(90_000)]);
    expect((await api(t, 'POST', '/partner/charity', { token: p.token, idem: randomUUID(), body: { amount_minor: tiyin(1_000) } })).status).toBe(422);
  });

  it('#9 + #10: partners see only their own history; there is no admin endpoint to switch on a partner’s automatic giving', async () => {
    const a = await mkPartner(t), b = await mkPartner(t);
    await credit(a.partnerId, 10_000);
    await api(t, 'POST', '/partner/charity', { token: a.token, idem: randomUUID(), body: { amount_minor: tiyin(1_000) } });
    expect((await api(t, 'GET', '/partner/charity/center', { token: b.token })).json.history).toEqual([]);
    expect((await api(t, 'GET', '/partner/charity/center', { token: a.token })).json.history.length).toBe(1);
    const admin = await api(t, 'PUT', '/admin/charity/rules', { token: s.owner.token, body: { partner_id: b.partnerId, percent_bps: 100 } });
    expect(admin.status).toBe(404);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM charity_rules WHERE partner_id=$1`, [b.partnerId])).rows[0].n).toBe(0);
  });

  it('#11 + #12: collected (to fund) and handed to the recipient are separate; disbursement waits for proof; works without AI/Telegram', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key IN ('ai.enabled')`);
    const p = await mkPartner(t);
    await credit(p.partnerId, 50_000);
    const f = await api(t, 'POST', '/admin/charity/funds', { token: s.owner.token, body: { name: 'Bolalar uyi', recipient_org: 'Test tashkilot', requisites: 'H/r 0000' } });
    expect((await api(t, 'POST', `/admin/charity/funds/${f.json.id}/status`, { token: s.owner.token, body: { status: 'approved' } })).status).toBe(200);
    await api(t, 'POST', '/partner/charity', { token: p.token, idem: randomUUID(), body: { amount_minor: tiyin(20_000), fund_id: f.json.id } });
    const d = await api(t, 'POST', '/admin/charity/disbursements', { token: s.owner.token, body: { fund_id: f.json.id, amount_minor: Number(tiyin(15_000)), recipient: 'Bolalar uyi №1' } });
    expect(d.json.status).toBe('disbursement_pending');
    let c = (await api(t, 'GET', '/admin/charity/center', { token: s.owner.token })).json.totals;
    expect(BigInt(c.pending)).toBe(BigInt(tiyin(15_000)));
    const conf = await api(t, 'POST', `/admin/charity/disbursements/${d.json.id}/confirm`, { token: s.owner.token, body: { proof: 'Bank to‘lov topshirig‘i №123' } });
    expect(conf.json.status).toBe('disbursed');
    c = (await api(t, 'GET', '/admin/charity/center', { token: s.owner.token })).json.totals;
    expect(BigInt(c.disbursed)).toBeGreaterThanOrEqual(BigInt(tiyin(15_000)));
    expect(BigInt(c.collected)).toBeGreaterThanOrEqual(BigInt(tiyin(20_000)));
  });
});
