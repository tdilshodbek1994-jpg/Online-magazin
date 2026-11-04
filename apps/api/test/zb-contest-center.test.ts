import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { recalcOrder } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { funnel, rankRows } from '../src/modules/contests/engine.js';
import { api, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, tiyin } from './helpers.js';

/** UZSHOP PRO — Contest Center P0 acceptance tests (spec §26, C01–C19 where P0 covers them). */
let t: T;
let s: Staff;
const M = { '1': [10000], '2': [10000, 2500], '3': [10000, 5000, 2500] };
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_contest');
  s = await staff(t);
  await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='commission.quantity_matrix'`);
});

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
async function liveContest(metric: string, o: { prizes?: any[]; appeal_days?: number; min_score?: number } = {}) {
  const c = await api(t, 'POST', '/admin/cc/contests', { token: s.owner.token, body: { title_latn: `Test ${metric} ${randomUUID().slice(0, 4)}`, starts_at: iso(-3600e3), ends_at: iso(86400e3), metric, appeal_days: o.appeal_days ?? 3, min_score: o.min_score ?? 1, prizes: o.prizes ?? [] } });
  expect(c.status).toBe(200);
  for (const step of ['submit', 'approve', 'publish']) expect((await api(t, 'POST', `/admin/cc/contests/${c.json.id}/${step}`, { token: s.owner.token, body: {} })).status).toBe(200);
  const d = await api(t, 'GET', `/admin/cc/contests/${c.json.id}`, { token: s.owner.token });
  expect(d.json.status).toBe('active');
  return c.json.id as string;
}
async function join(p: { token: string }, id: string) {
  const r = await api(t, 'POST', `/partner/cc/contests/${id}/join`, { token: p.token, body: { accept_terms: true } });
  expect(r.status).toBe(200);
}
async function referralOrder(p: { code: string }, skuId: string, qty: number) {
  const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: skuId, qty }], { referral_code: p.code });
  expect(o.status).toBe(201);
  return o.json.order_id as string;
}
async function confirm(orderId: string) {
  const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [orderId])).rows[0].p;
  await api(t, 'POST', `/ops/orders/${orderId}/claim`, { token: s.operator.token });
  expect((await api(t, 'POST', `/ops/orders/${orderId}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
}
async function deliverOnly(orderId: string) {
  for (const step of ['pick', 'pack']) await api(t, 'POST', `/ops/orders/${orderId}/${step}`, { token: s.warehouse.token });
  await api(t, 'POST', `/ops/orders/${orderId}/ship`, { token: s.warehouse.token, body: { courier_user_id: s.courier.id, tracking_id: 'T' } });
  expect((await api(t, 'POST', `/courier/orders/${orderId}/deliver`, { token: s.courier.token, body: { proof: { method: 'otp', value: '1234' } } })).status).toBe(200);
}
const settle = async (orderId: string) => { await confirm(orderId); await fulfilCod(t, s, orderId); };
const recompute = (id: string) => api(t, 'POST', `/admin/cc/contests/${id}/recompute`, { token: s.owner.token });
const me = (p: { token: string }, id: string) => api(t, 'GET', `/partner/cc/contests/${id}/me`, { token: p.token });
async function closeAndOpenAppeals(id: string) {
  await t.db.query(`UPDATE cc_versions SET ends_at=now() - interval '1 minute', starts_at=LEAST(starts_at, now() - interval '2 hours') WHERE contest_id=$1`, [id]);
  const r = await api(t, 'POST', `/admin/cc/contests/${id}/close`, { token: s.owner.token });
  expect(r.status).toBe(200);
}

describe('Contest Center P0', () => {
  it('C01: funnel — 100 created, 70 accepted, 56 delivered => 80% from accepted, 56% overall', () => {
    expect(funnel(100, 70, 56)).toMatchObject({ delivery_from_accepted_pct: 80, overall_pct: 56 });
  });

  it('C02 + C05: order contest counts orders, unit contest counts units; repeated recompute adds nothing', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [100], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const byOrders = await liveContest('settled_orders');
    const byUnits = await liveContest('settled_units');
    await join(p, byOrders); await join(p, byUnits);
    // scaled version of "36 single + 20 double": 3 single + 2 double = 5 orders, 7 units
    for (const q of [1, 1, 1, 2, 2]) await settle(await referralOrder(p, prod.skuIds[0]!, q));
    for (let i = 0; i < 3; i++) { await recompute(byOrders); await recompute(byUnits); }
    expect((await me(p, byOrders)).json.final).toBe('5');
    expect((await me(p, byUnits)).json.final).toBe('7');
    const n = (await t.db.query(`SELECT COUNT(*)::int n FROM cc_score_events WHERE contest_id=$1`, [byOrders])).rows[0].n;
    expect(n).toBe(5); // C05: one event per order even after 3 recomputes
  });

  it('C07: delivered but COD not remitted counts in provisional, not in final', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const id = await liveContest('settled_orders');
    await join(p, id);
    const o = await referralOrder(p, prod.skuIds[0]!, 1);
    await confirm(o); await deliverOnly(o);
    await recompute(id);
    const m = (await me(p, id)).json;
    expect(m.provisional).toBe('1');
    expect(m.final).toBe('0');
  });

  it('C03 + C04 + C19: multi-unit commission 3 units = 52 500; a late return of 1 unit => 37 500 via a −15 000 adjustment (history kept)', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [200_000], stock: [20] });
    await t.db.query(`INSERT INTO commission_rules (product_id, version, kind, fixed_minor, commission_group, quantity_matrix, effective_from) VALUES ($1,1,'quantity_matrix',$2,$3,$4, now() - interval '1 hour')`,
      [prod.productId, tiyin(30_000), `product:${prod.productId}`, JSON.stringify(M)]);
    const id = await liveContest('confirmed_commission');
    await join(p, id);
    const o = await referralOrder(p, prod.skuIds[0]!, 3);
    await settle(o);
    await recompute(id);
    expect((await me(p, id)).json.final).toBe(tiyin(52_500));
    // Return of one unit recorded on the line, commission recalculated by the existing ledger engine.
    await t.db.query(`UPDATE order_lines SET returned_qty=1 WHERE order_id=$1`, [o]);
    await withTx(t.db, (tx) => recalcOrder(tx, o, 'return_test'));
    await recompute(id);
    expect((await me(p, id)).json.final).toBe(tiyin(37_500));
    const ev = (await t.db.query(`SELECT kind, final_points::text FROM cc_score_events WHERE contest_id=$1 ORDER BY id`, [id])).rows;
    expect(ev).toEqual([{ kind: 'order', final_points: tiyin(52_500) }, { kind: 'adjustment', final_points: String(-1_500_000) }]);
  });

  it('C06 + C11: one final snapshot even with two parallel finalizations; appeal after the deadline is rejected, old appeal kept', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const id = await liveContest('settled_orders');
    await join(p, id);
    await settle(await referralOrder(p, prod.skuIds[0]!, 1));
    await closeAndOpenAppeals(id);
    const ap = await api(t, 'POST', `/partner/cc/contests/${id}/appeals`, { token: p.token, body: { body: 'Bitta buyurtmam hisobga kirmadi' } });
    expect(ap.status).toBe(200);
    await api(t, 'POST', `/admin/cc/appeals/${ap.json.id}/resolve`, { token: s.owner.token, body: { status: 'rejected', resolution: 'Buyurtma davrdan tashqarida' } });
    await t.db.query(`UPDATE cc_contests SET appeal_deadline=now() - interval '1 minute' WHERE id=$1`, [id]);
    const late = await api(t, 'POST', `/partner/cc/contests/${id}/appeals`, { token: p.token, body: { body: 'Yana bitta e’tiroz' } });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('APPEAL_WINDOW_CLOSED');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM cc_appeals WHERE contest_id=$1`, [id])).rows[0].n).toBe(1);
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', `/admin/cc/contests/${id}/finalize`, { token: s.owner.token, body: {} })));
    expect([a!.status, b!.status].sort()).toEqual([200, 409]);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM cc_rankings WHERE contest_id=$1 AND kind='final'`, [id])).rows[0].n).toBe(1);
  });

  it('C08: partner A cannot open partner B’s order; "me" lists only own orders', async () => {
    const a = await mkPartner(t), b = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const id = await liveContest('settled_orders');
    await t.db.query(`UPDATE cc_versions SET name_privacy='alias' WHERE contest_id=$1`, [id]); // contest-level privacy option
    await join(a, id); await join(b, id);
    const ob = await referralOrder(b, prod.skuIds[0]!, 1);
    await settle(ob); await recompute(id);
    expect((await api(t, 'GET', `/partner/orders/${ob}/passport`, { token: a.token })).status).toBe(404);
    expect((await me(a, id)).json.orders).toEqual([]);
    expect((await me(b, id)).json.orders.length).toBe(1);
    const lb = (await api(t, 'GET', `/partner/cc/contests/${id}/leaderboard`, { token: a.token })).json;
    expect(lb.items[0].name).toMatch(/^Ishtirokchi #/); // B's real name is not exposed without consent
  });

  it('C09: tie-break order is the announced one; full tie => same rank', () => {
    const base = { units: 1, orders: 1, refund_ratio: null, qualified: true };
    const r = rankRows([
      { ...base, partner_id: 'a', score: '10', net_sales_minor: '100', reached_at: '2026-11-02T10:00:00Z' },
      { ...base, partner_id: 'b', score: '10', net_sales_minor: '200', reached_at: '2026-11-03T10:00:00Z' },
      { ...base, partner_id: 'c', score: '10', net_sales_minor: '100', reached_at: '2026-11-01T10:00:00Z' },
      { ...base, partner_id: 'd', score: '10', net_sales_minor: '100', reached_at: '2026-11-01T10:00:00Z' },
      { ...base, partner_id: 'e', score: '3', net_sales_minor: '900', reached_at: null, qualified: false },
    ], ['score', 'net_sales', 'refund_ratio', 'reached_at']);
    expect(r.map((x) => [x.partner_id, x.rank])).toEqual([['b', 1], ['c', 2], ['d', 2], ['a', 4], ['e', null]]);
  });

  it('C10 + C16 + C17: prize stock 1 with two parallel awards => one wins; unclaimed item expires (audit row kept); canceled contest cannot award', async () => {
    const p1 = await mkPartner(t), p2 = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const id = await liveContest('settled_orders', { prizes: [{ place: 1, title: 'Smartfon', kind: 'item', qty: 1 }] });
    await join(p1, id); await join(p2, id);
    await settle(await referralOrder(p1, prod.skuIds[0]!, 1));
    await closeAndOpenAppeals(id);
    expect((await api(t, 'POST', `/admin/cc/contests/${id}/finalize`, { token: s.owner.token, body: { force_before_deadline: true } })).status).toBe(200);
    const prize = (await t.db.query(`SELECT id FROM cc_prizes WHERE contest_id=$1`, [id])).rows[0].id;
    const [x, y] = await Promise.all([p1, p2].map((p) => api(t, 'POST', `/admin/cc/prizes/${prize}/award`, { token: s.owner.token, body: { partner_id: p.partnerId, reason: 'owner qarori' } })));
    expect([x!.status, y!.status].sort()).toEqual([200, 409]);
    const winner = x!.status === 200 ? p1 : p2;
    await t.db.query(`UPDATE cc_prize_awards SET claim_deadline=now() - interval '1 day' WHERE prize_id=$1`, [prize]);
    const mine = (await api(t, 'GET', '/partner/cc/prizes', { token: winner.token })).json.items;
    expect(mine[0].status).toBe('expired');

    const id2 = await liveContest('settled_orders', { prizes: [{ place: 1, title: 'Pul', kind: 'money', value_minor: Number(tiyin(100_000)) }] });
    expect((await api(t, 'POST', `/admin/cc/contests/${id2}/cancel`, { token: s.owner.token, body: { reason: 'test' } })).status).toBe(200);
    const pz = (await t.db.query(`SELECT id FROM cc_prizes WHERE contest_id=$1`, [id2])).rows[0].id;
    expect((await api(t, 'POST', `/admin/cc/prizes/${pz}/award`, { token: s.owner.token, body: { partner_id: p1.partnerId, reason: 'test qaror' } })).status).toBe(409);
  });

  it('C12: active contest rules cannot change silently — reason required, new version, old kept', async () => {
    const id = await liveContest('settled_orders');
    const d = (await api(t, 'GET', `/admin/cc/contests/${id}`, { token: s.owner.token })).json;
    const v1 = d.versions[0];
    const body = { title_latn: v1.title_latn, starts_at: v1.starts_at, ends_at: v1.ends_at, metric: 'settled_units', expected_version: d.version };
    const silent = await api(t, 'PUT', `/admin/cc/contests/${id}`, { token: s.owner.token, body });
    expect(silent.status).toBe(409);
    expect(silent.json.code).toBe('REVISION_REASON_REQUIRED');
    const rev = await api(t, 'PUT', `/admin/cc/contests/${id}`, { token: s.owner.token, body: { ...body, reason: 'Dona bo‘yicha hisoblash e’lon qilindi' } });
    expect(rev.status).toBe(200);
    expect(rev.json.current_version).toBe(2);
    expect((await t.db.query(`SELECT version, metric FROM cc_versions WHERE contest_id=$1 ORDER BY version`, [id])).rows).toEqual([{ version: 1, metric: 'settled_orders' }, { version: 2, metric: 'settled_units' }]);
  });

  it('C18: leaving stops contest messages and keeps the normal commission; non-owner cannot approve', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const id = await liveContest('settled_orders');
    await join(p, id);
    const o = await referralOrder(p, prod.skuIds[0]!, 1);
    await settle(o);
    const before = (await t.db.query(`SELECT COALESCE(SUM(target_minor),0)::text s FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded'`, [o])).rows[0].s;
    expect((await api(t, 'POST', `/partner/cc/contests/${id}/leave`, { token: p.token })).status).toBe(200);
    const en = (await t.db.query(`SELECT left_at IS NOT NULL AS left, notify_opt_in FROM cc_enrollments WHERE contest_id=$1 AND partner_id=$2`, [id, p.partnerId])).rows[0];
    expect(en).toEqual({ left: true, notify_opt_in: false });
    const after = (await t.db.query(`SELECT COALESCE(SUM(target_minor),0)::text s FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded'`, [o])).rows[0].s;
    expect(after).toBe(before);
    expect(before).toBe(tiyin(5_000));
    const c = await api(t, 'POST', '/admin/cc/contests', { token: s.owner.token, body: { title_latn: 'Ruxsat test', starts_at: iso(-1000), ends_at: iso(86400e3), metric: 'settled_orders' } });
    await api(t, 'POST', `/admin/cc/contests/${c.json.id}/submit`, { token: s.owner.token, body: {} });
    const notOwner = await api(t, 'POST', `/admin/cc/contests/${c.json.id}/approve`, { token: s.catalog.token, body: {} });
    expect(notOwner.status).toBe(403);
  });
});
