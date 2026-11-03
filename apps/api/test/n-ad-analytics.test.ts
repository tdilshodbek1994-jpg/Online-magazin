import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { csvCell, toUzsMinor, uzsToUsdCents } from '../src/modules/analytics/money.js';
import { ingestMetaRows } from '../src/modules/analytics/providers.js';
import { resolvePeriod } from '../src/modules/analytics/report.js';
import { computeOrderTargets, matrixPreview, type OrderLineFacts, recalcOrder, releaseMatured, type RuleSnapshot } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { address, api, balances, fulfilCod, mkPartner, mkProduct, mkUser, nextPhone, placeOrder, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
const M = { '1': [10000], '2': [10000, 2500], '3': [10000, 5000, 2500] };
const BASE = '3000000'; // 30 000 so'm in tiyin
const rule = (id = 'r1', group = 'g1'): RuleSnapshot => ({ rule_id: id, version: 1, kind: 'quantity_matrix', rate_bps: null, fixed_minor: BASE, basis: 'x', commission_group: group, quantity_matrix: M });
const line = (id: string, qty: number, r: RuleSnapshot | null = rule(), returned = 0): OrderLineFacts => ({ id, qty, canceledQty: 0, returnedQty: returned, lineNet: 10_000_000n, refundedProduct: 0n, rule: r });
const sum = (m: Map<string, { target: bigint }>) => [...m.values()].reduce((a, b) => a + b.target, 0n);

beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
  await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key IN ('commission.quantity_matrix','ads.provider_sync')`);
});

async function matrixProduct(o: { prices?: number[]; stock?: number[]; group?: string } = {}) {
  const prod = await mkProduct(t, { prices: o.prices ?? [200_000], stock: o.stock ?? [20] });
  await t.db.query(`INSERT INTO commission_rules (product_id, version, kind, fixed_minor, commission_group, quantity_matrix, effective_from) VALUES ($1,1,'quantity_matrix',$2,$3,$4, now() - interval '1 hour')`,
    [prod.productId, BASE, o.group ?? `product:${prod.productId}`, JSON.stringify(M)]);
  return prod;
}
async function referralOrder(p: { token: string }, productId: string, lines: { sku_id: string; qty: number }[], placementCode?: string, asGuest = false) {
  const code = placementCode ?? (await api(t, 'POST', '/partner/streams', { token: p.token, body: { product_id: productId, name: 'Telegram kanal' } })).json.code;
  const guest = randomUUID() + randomUUID();
  await api(t, 'POST', '/referrals/touch', { guest, body: { code } });
  const c = await mkUser(t);
  const o = await placeOrder(t, asGuest ? { guest, phone: nextPhone() } : { token: c.token, guest, phone: c.phone }, lines);
  expect(o.status).toBe(201);
  return { orderId: o.json.order_id as string, code };
}
const future = () => new Date(Date.now() + 40 * 86400_000);
const dash = (p: { token: string }, qs = '') => api(t, 'GET', `/partner/analytics/dashboard?period=this_month${qs}`, { token: p.token });

describe('Quantity matrix — the one commission function (T01–T07, T09–T11, T14)', () => {
  it('T01–T03: 1 → 30 000, 2 → 37 500 (not 45 000/60 000), 3 → 52 500', () => {
    expect(sum(computeOrderTargets([line('a', 1)]))).toBe(3_000_000n);
    expect(sum(computeOrderTargets([line('a', 2)]))).toBe(3_750_000n);
    expect(sum(computeOrderTargets([line('a', 3)]))).toBe(5_250_000n);
    expect(matrixPreview({ fixed_minor: BASE, quantity_matrix: M }).map((x) => x.total_minor)).toEqual(['3000000', '3750000', '5250000', null]);
  });
  it('T04/T05: one group split over two lines never pays 100% twice; different groups are independent', () => {
    const m = computeOrderTargets([line('a', 1), line('b', 1)]);
    expect([m.get('a')!.target, m.get('b')!.target]).toEqual([3_000_000n, 750_000n]);
    const m2 = computeOrderTargets([line('a', 1), line('b', 1, rule('r2', 'g2'))]);
    expect(sum(m2)).toBe(6_000_000n);
  });
  it('T06: 4+ units without an approved row → no invented rate, review flag', () => {
    const m = computeOrderTargets([line('a', 4)]);
    expect(m.get('a')).toMatchObject({ target: 0n, review: 'qty_4_no_rule', groupQty: 4 });
  });
  it('T07: 36 singles + 20 doubles → 56 orders, 76 units, 1 830 000 (not 56×30 000 or 76×30 000)', () => {
    let total = 0n, units = 0;
    for (let i = 0; i < 36; i++) { total += sum(computeOrderTargets([line(`s${i}`, 1)])); units += 1; }
    for (let i = 0; i < 20; i++) { total += sum(computeOrderTargets([line(`d${i}`, 2)])); units += 2; }
    expect(units).toBe(76);
    expect(total).toBe(183_000_000n);
  });
  it('T09–T11: returns recompute on retained units: 3→2 = 37 500, 2→1 = 30 000, all returned = 0', () => {
    expect(sum(computeOrderTargets([line('a', 3, rule(), 1)]))).toBe(3_750_000n);
    expect(sum(computeOrderTargets([line('a', 2, rule(), 1)]))).toBe(3_000_000n);
    expect(sum(computeOrderTargets([line('a', 2, rule(), 2)]))).toBe(0n);
  });
  it('T14: a money-only (goodwill) refund does not change matrix commission', () => {
    const l = { ...line('a', 2), refundedProduct: 5_000_000n };
    expect(sum(computeOrderTargets([l]))).toBe(3_750_000n);
  });
});

describe('Vertical acceptance: link → 2 units → 37 500 → expense → same on link & dashboard → return → −7 500', () => {
  it('end to end with the ledger', async () => {
    const p = await mkPartner(t);
    const prod = await matrixProduct();
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    const acc = (await t.db.query(`SELECT target_minor::text, group_qty, review_required FROM commission_accruals WHERE order_id=$1`, [orderId])).rows;
    expect(acc).toEqual([{ target_minor: '3750000', group_qty: 2, review_required: false }]);
    await fulfilCod(t, s, orderId);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    expect((await balances(t, p.partnerId)).a).toBe('3750000');
    const link = (await t.db.query(`SELECT attribution->>'link_id' AS l FROM orders WHERE id=$1`, [orderId])).rows[0].l;
    const today = new Date().toISOString().slice(0, 10);
    const ex = await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '10000', currency: 'UZS', service_from: today, service_to: today, allocations: [{ root_link_id: link, share_bps: 10000 }] } });
    expect(ex.status).toBe(200);
    expect(await balances(t, p.partnerId)).toMatchObject({ a: '3750000' }); // T18: entering an expense never touches the wallet
    const d = await dash(p);
    expect(d.json.totals).toMatchObject({ commission: '3750000', ad: '1000000', result: '2750000' });
    const la = await api(t, 'GET', `/partner/links/${link}/analytics?period=this_month`, { token: p.token });
    expect(la.json.totals).toMatchObject({ commission: '3750000', ad: '1000000', result: '2750000' });
    expect(la.json.counts.qty_distribution['2']).toBe(1);
    expect(la.json.formulas.find((x: any) => x.qty === 2).formula).toContain('37500');
    // return 1 of 2 → 30 000; the ledger gets exactly −7 500
    const ol = (await t.db.query(`SELECT id FROM order_lines WHERE order_id=$1`, [orderId])).rows[0];
    const ret = await api(t, 'POST', '/returns', { token: s.operator.token, body: { order_id: orderId, lines: [{ order_line_id: ol.id, qty: 1 }], reason: 'Yoqmadi', desired_resolution: 'refund' } });
    await api(t, 'POST', `/ops/returns/${ret.json.id}/decision`, { token: s.operator.token, body: { decision: 'approved', note: 'policy ok' } });
    const rl = (await t.db.query(`SELECT id FROM return_lines WHERE return_id=$1`, [ret.json.id])).rows[0];
    const rec = await api(t, 'POST', `/ops/returns/${ret.json.id}/receive`, { token: s.warehouse.token, body: { lines: [{ return_line_id: rl.id, received_qty: 1 }] } });
    expect(rec.status).toBe(200);
    expect((await balances(t, p.partnerId)).a).toBe('3000000');
    await withTx(t.db, (tx) => recalcOrder(tx, orderId, 'retry')); // T12: a repeated event changes nothing
    expect((await balances(t, p.partnerId)).a).toBe('3000000');
    const d2 = await dash(p);
    expect(d2.json.totals).toMatchObject({ commission: '3000000', result: '2000000' });
    const la2 = await api(t, 'GET', `/partner/links/${link}/analytics?period=this_month`, { token: p.token });
    expect(la2.json.totals.commission).toBe(d2.json.totals.commission);
  });

  it('T04 integration: two variants of one product in one order → 30 000 + 7 500', async () => {
    const p = await mkPartner(t);
    const prod = await matrixProduct({ prices: [150_000, 150_000], stock: [5, 5] });
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }, { sku_id: prod.skuIds[1]!, qty: 1 }]);
    const r = await t.db.query(`SELECT COALESCE(SUM(target_minor),0)::text AS s FROM commission_accruals WHERE order_id=$1`, [orderId]);
    expect(r.rows[0].s).toBe('3750000');
  });

  it('T06 integration: 4 units → order kept, review_required, studio refuses to offer the bundle', async () => {
    const p = await mkPartner(t);
    const prod = await matrixProduct();
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 4 }]);
    const a = (await t.db.query(`SELECT target_minor::text, review_required, review_reason FROM commission_accruals WHERE order_id=$1`, [orderId])).rows[0];
    expect(a).toEqual({ target_minor: '0', review_required: true, review_reason: 'qty_4_no_rule' });
    expect((await api(t, 'GET', '/admin/commission-review', { token: s.owner.token })).json.items.some((x: any) => x.order_id === orderId)).toBe(true);
    const d = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 4 }], customer_name: 'Mijoz', customer_phone: nextPhone(), delivery_zone_id: await zoneId(t), address: { district: 'Y', street: 'S', house: '1' } } });
    expect(d.json.quote.commission_review).toBe(true);
    expect((await api(t, 'POST', `/partner/drafts/${d.json.id}/submit`, { token: p.token })).json.code).toBe('QTY_RULE_MISSING');
  });

  it('T15: a new rule version never rewrites an existing order snapshot; preview = same function', async () => {
    const p = await mkPartner(t);
    const prod = await matrixProduct();
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    const pv = await api(t, 'POST', '/admin/commission-rules/preview', { token: s.owner.token, body: { base_minor: '4000000', matrix: M } });
    expect(pv.json.preview.map((x: any) => x.total_minor)).toEqual(['4000000', '5000000', '7000000', null]);
    const pub = await api(t, 'POST', '/admin/commission-rules/matrix', { token: s.owner.token, body: { product_ids: [prod.productId], base_minor: '4000000', matrix: M, note: 'yangi narx' } });
    expect(pub.status).toBe(200);
    expect((await api(t, 'POST', '/admin/commission-rules/matrix', { token: s.owner.token, body: { product_ids: [prod.productId], base_minor: '4000000', matrix: M, note: 'orqaga', effective_from: '2020-01-01T00:00:00Z' } })).json.code).toBe('NO_RETROACTIVE_RULES');
    expect((await t.db.query(`SELECT target_minor::text, rule_snapshot->>'fixed_minor' AS b FROM commission_accruals WHERE order_id=$1`, [orderId])).rows[0]).toEqual({ target_minor: '3750000', b: BASE });
    const prev = await api(t, 'GET', `/partner/products/${prod.productId}/commission-preview`, { token: p.token });
    expect(prev.json.items.map((x: any) => x.total_minor)).toEqual(['4000000', '5000000', '7000000', null]);
    expect((await api(t, 'POST', '/admin/commission-rules/matrix', { token: p.token, body: { product_ids: [prod.productId], base_minor: '1', matrix: M, note: 'hack' } })).status).toBe(403);
  });
});

describe('Expenses, allocation, FX (T17–T24, T29, T30)', () => {
  it('T17/T29: $250 commission − $100 ad = $150 (USD view at each item’s own rate; Rate/Nominal exact)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await t.db.query(`INSERT INTO fx_snapshots (currency, effective_date, rate, nominal, source) VALUES ('USD', $1, '12000.00', 1, 'manual') ON CONFLICT DO NOTHING`, [today]);
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [5_000_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: 3_000_000 } });
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await fulfilCod(t, s, orderId);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'instagram_target', amount: '100', currency: 'USD', service_from: today, service_to: today } });
    const d = await dash(p, '&currency=USD');
    const rate = (await t.db.query(`SELECT rate::text FROM fx_snapshots WHERE currency='USD' AND effective_date <= $1 ORDER BY effective_date DESC, CASE source WHEN 'bank_actual' THEN 0 WHEN 'cbu' THEN 1 ELSE 2 END LIMIT 1`, [today])).rows[0].rate;
    const commissionUsd = uzsToUsdCents(300_000_000n, rate, 1);
    expect(d.json.totals.commission).toBe(commissionUsd.toString());
    expect(d.json.totals.ad).toBe('10000');
    expect(d.json.totals.result).toBe((commissionUsd - 10000n).toString());
    if (rate === '12000.000000') expect(d.json.totals.result).toBe('15000'); // $150
    expect(toUzsMinor(10000n, '12000.00', 1)).toBe(120_000_000n);
    expect(toUzsMinor(10000n, '150.25', 100)).toBe(15_025n); // nominal respected
  });

  it('T19/T20: unknown spend is not 0; explicit zero is; shop-paid ads are shown but not subtracted', async () => {
    const p = await mkPartner(t);
    const d0 = await dash(p);
    expect(d0.json.totals.ad).toBeNull();
    expect(d0.json.completeness.notes).toContain('Xarajat kiritilmagan');
    const today = new Date().toISOString().slice(0, 10);
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'organic', amount: '0', kind: 'zero_confirmed', service_from: today, service_to: today } });
    expect((await dash(p)).json.totals).toMatchObject({ ad: '0', result: '0' });
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_ads', amount: '50000', payer: 'shop', service_from: today, service_to: today } });
    const d2 = await dash(p);
    expect(d2.json.totals).toMatchObject({ ad: '0', ad_shop_paid: '5000000' });
  });

  it('T21/T22: $100 split $60/$40 stays $100; an unallocated part is shown, never lost', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000] });
    const l1 = (await api(t, 'POST', '/partner/streams', { token: p.token, body: { product_id: prod.productId, name: 'A' } })).json.id;
    const l2 = (await api(t, 'POST', '/partner/streams', { token: p.token, body: { product_id: prod.productId, name: 'B' } })).json.id;
    const today = new Date().toISOString().slice(0, 10);
    const r = await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '100000', service_from: today, service_to: today, allocations: [{ root_link_id: l1, amount: '60000' }, { root_link_id: l2, amount: '40000' }] } });
    expect(r.status).toBe(200);
    expect((await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '100', service_from: today, service_to: today, allocations: [{ root_link_id: l1, amount: '150' }] } })).json.code).toBe('ALLOCATION_EXCEEDS_EXPENSE');
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '33333.33', service_from: today, service_to: today, allocations: [{ root_link_id: l1, share_bps: 5000 }] } });
    const d = await dash(p);
    const rows = d.json.links.reduce((a: bigint, x: any) => a + BigInt(x.ad ?? 0), 0n);
    expect(rows + BigInt(d.json.unallocated.ad)).toBe(BigInt(d.json.totals.ad));
    expect(d.json.totals.ad).toBe('13333333');
    expect(d.json.links.find((x: any) => x.link_id === l2).ad).toBe('4000000');
    expect(BigInt(d.json.unallocated.ad)).toBeGreaterThan(0n);
  });

  it('multi-day expense prorates by service days (analytic split) and sums back exactly', async () => {
    const p = await mkPartner(t);
    const per = await resolvePeriod(t.db, 'this_month');
    const first = new Date(Date.parse(per.from) + 5 * 3600_000).toISOString().slice(0, 10);
    const prevDay = new Date(Date.parse(first) - 86400_000).toISOString().slice(0, 10);
    // 3 days: 1 before this month + 2 inside → exactly 2/3 of 100.00 counts in this month
    const r = await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '100', service_from: prevDay, service_to: new Date(Date.parse(first) + 86400_000).toISOString().slice(0, 10) } });
    expect(r.status).toBe(200);
    const d = await dash(p);
    const lastMonth = await dash(p, '').then(() => api(t, 'GET', '/partner/analytics/dashboard?period=last_month', { token: p.token }));
    expect(BigInt(d.json.totals.ad) + BigInt(lastMonth.json.totals.ad)).toBe(10000n);
  });

  it('T23/T24/T25: manual + provider same spend → reconcile queue (no double); re-import is versioned; ad grain only', async () => {
    const p = await mkPartner(t);
    const day = new Date().toISOString().slice(0, 10);
    await t.db.query(`INSERT INTO fx_snapshots (currency, effective_date, rate, nominal, source) VALUES ('USD', $1, '12000.00', 1, 'manual') ON CONFLICT DO NOTHING`, [day]);
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'instagram_target', amount: '1200000', service_from: day, service_to: day } });
    const before = (await dash(p)).json.totals.ad;
    // MOCK provider rows (no live Meta call in tests)
    const rows = [{ ad_id: '111', date_start: day, spend: '100.00', account_currency: 'USD', publisher_platform: 'instagram' }, { ad_id: '111', date_start: day, spend: '20.00', account_currency: 'USD', publisher_platform: 'facebook' }, { ad_id: '222', date_start: day, spend: '5.00', account_currency: 'USD', publisher_platform: null }];
    const r1 = await ingestMetaRows(t.db, p.partnerId, 'act_1', rows, 'America/Los_Angeles');
    expect(r1.changed).toBe(3);
    const ins = (await t.db.query(`SELECT channel, status FROM ad_expenses WHERE partner_id=$1 AND source='meta' ORDER BY channel`, [p.partnerId])).rows;
    expect(ins).toEqual([{ channel: 'instagram_target', status: 'needs_reconcile' }, { channel: 'meta_mixed', status: 'needs_reconcile' }, { channel: 'other', status: 'needs_reconcile' }]);
    expect((await dash(p)).json.totals.ad).toBe(before); // nothing added blindly
    expect((await ingestMetaRows(t.db, p.partnerId, 'act_1', rows, null)).changed).toBe(0); // same day re-read → no new sum
    const r3 = await ingestMetaRows(t.db, p.partnerId, 'act_1', [{ ...rows[0]!, spend: '110.00' }], null);
    expect(r3.changed).toBe(1);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM ad_expense_versions v JOIN ad_expenses e ON e.id=v.expense_id WHERE e.partner_id=$1 AND e.source='meta' AND e.channel='instagram_target'`, [p.partnerId])).rows[0].n).toBe(2);
    const ig = (await t.db.query(`SELECT id FROM ad_expenses WHERE partner_id=$1 AND source='meta' AND channel='instagram_target'`, [p.partnerId])).rows[0];
    expect((await api(t, 'POST', `/partner/ad-expenses/${ig.id}/reconcile`, { token: p.token, body: { keep: 'provider' } })).status).toBe(200);
    expect((await dash(p)).json.totals.ad).toBe(String(110n * 100n * 12000n)); // provider row replaces the manual one
  });

  it('T29/T30: missing rate → FX_PENDING (never 1), excluded and flagged; arrival prices only pending rows', async () => {
    const p = await mkPartner(t);
    const day = '2026-02-03';
    const e = await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_ads', amount: '10', currency: 'EUR', service_from: day, service_to: day } });
    expect(e.json.fx_status).toBe('pending');
    expect(e.json.amount_uzs_minor).toBeNull();
    const fx = await api(t, 'POST', '/admin/fx', { token: s.owner.token, body: { currency: 'EUR', date: '2026-02-01', rate: '13500.50', nominal: 1 } });
    expect(fx.json.repriced).toBeGreaterThanOrEqual(1);
    const row = (await t.db.query(`SELECT fx_status, amount_uzs_minor::text, fx_date::text FROM ad_expenses WHERE id=$1`, [e.json.id])).rows[0];
    expect(row).toEqual({ fx_status: 'ok', amount_uzs_minor: '13500500', fx_date: '2026-02-01' }); // last official rate, its real date shown
    await api(t, 'POST', '/admin/fx', { token: s.owner.token, body: { currency: 'EUR', date: '2026-02-03', rate: '99999', nominal: 1 } });
    expect((await t.db.query(`SELECT amount_uzs_minor::text FROM ad_expenses WHERE id=$1`, [e.json.id])).rows[0].amount_uzs_minor).toBe('13500500');
  });

  it('expense edits are versioned with a reason; void keeps history; operator/other partner cannot touch them (T28)', async () => {
    const p = await mkPartner(t), other = await mkPartner(t);
    const day = new Date().toISOString().slice(0, 10);
    const e = await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '1000', service_from: day, service_to: day } });
    expect((await api(t, 'PATCH', `/partner/ad-expenses/${e.json.id}`, { token: p.token, body: { amount: '1500', reason: 'chek bo‘yicha', expected_version: 1 } })).status).toBe(200);
    expect((await api(t, 'PATCH', `/partner/ad-expenses/${e.json.id}`, { token: p.token, body: { amount: '9', reason: 'eski oyna', expected_version: 1 } })).json.code).toBe('VERSION_CONFLICT');
    expect((await api(t, 'PATCH', `/partner/ad-expenses/${e.json.id}`, { token: other.token, body: { amount: '1', reason: 'hack', expected_version: 2 } })).status).toBe(404);
    expect((await api(t, 'GET', '/partner/ad-expenses', { token: s.operator.token })).status).toBe(404);
    const v = await api(t, 'GET', `/partner/ad-expenses/${e.json.id}/versions`, { token: p.token });
    expect(v.json.items.map((x: any) => x.reason)).toEqual(['created', 'chek bo‘yicha']);
    await api(t, 'POST', `/partner/ad-expenses/${e.json.id}/void`, { token: p.token, body: { reason: 'xato' } });
    expect((await api(t, 'GET', '/partner/ad-expenses?status=all', { token: p.token })).json.items[0].status).toBe('void');
  });

  it('CSV import is idempotent by external_id and formula-safe on export', async () => {
    const p = await mkPartner(t);
    const csv = 'date,amount,currency,channel,placement,note,external_id\n2026-11-01,250000,UZS,telegram_channel,Kanal A,=HYPERLINK("x"),tg-1\n2026-11-02,abc,UZS,telegram_channel,,,tg-2';
    const r1 = await api(t, 'POST', '/partner/ad-expenses/import', { token: p.token, body: { csv } });
    expect(r1.json).toMatchObject({ created: 1, errors: [{ line: 3 }] });
    expect((await api(t, 'POST', '/partner/ad-expenses/import', { token: p.token, body: { csv } })).json).toMatchObject({ created: 0, unchanged: 1 });
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    const ex = await api(t, 'GET', '/partner/analytics/export.csv?period=this_month', { token: p.token });
    expect(ex.status).toBe(200);
    expect(ex.raw.body).toContain('report_basis');
    expect(ex.raw.body).toContain('Asia/Tashkent');
  });
});

describe('Sources, periods, reports (T08, T26–T28, T31–T39)', () => {
  it('T26/T27: old link without placement stays "unknown"; placement link → instagram; manual order keeps capture mode separate', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    const { code } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    const link = (await t.db.query(`SELECT id FROM referral_links WHERE code=$1`, [code])).rows[0].id;
    const pl = await api(t, 'POST', `/partner/links/${link}/placements`, { token: p.token, body: { channel: 'instagram_target', name: 'Target noyabr' } });
    expect(pl.json.url).toContain('/r/');
    await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }], pl.json.code);
    const tg = await api(t, 'POST', `/partner/links/${link}/placements`, { token: p.token, body: { channel: 'telegram_channel', name: 'Kanal posti' } });
    const d = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }], customer_name: 'Mijoz', customer_phone: nextPhone(), delivery_zone_id: await zoneId(t), address: { district: 'Y', street: 'S', house: '1' } } });
    await api(t, 'PATCH', `/partner/drafts/${d.json.id}`, { token: p.token, body: { expected_version: d.json.version, placement_id: tg.json.id } });
    const sub = await api(t, 'POST', `/partner/drafts/${d.json.id}/submit`, { token: p.token });
    const o = (await t.db.query(`SELECT channel, attribution->>'source_channel' AS sc FROM orders WHERE id=$1`, [sub.json.order_id])).rows[0];
    expect(o).toEqual({ channel: 'partner_assisted', sc: 'telegram_channel' });
    const r = await dash(p);
    const ch = Object.fromEntries(r.json.channels.map((x: any) => [x.channel, x.orders]));
    expect(ch).toMatchObject({ unknown: 1, instagram_target: 1, telegram_channel: 1 });
    // T28: another partner cannot open this link's report or expenses
    const other = await mkPartner(t);
    expect((await api(t, 'GET', `/partner/links/${link}/analytics?period=this_month`, { token: other.token })).status).toBe(404);
    expect((await api(t, 'GET', `/partner/links/${link}/placements`, { token: other.token })).status).toBe(404);
  });

  it('T31: periods are Asia/Tashkent; weeks start Monday 00:00; [from, to)', async () => {
    const w = await resolvePeriod(t.db, 'this_week');
    const f = new Date(w.from);
    expect(f.getUTCHours()).toBe(19); // 00:00 Tashkent = 19:00 UTC previous day
    expect(new Date(f.getTime() + 5 * 3600_000).getUTCDay()).toBe(1);
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(7 * 86400_000);
    const c = await resolvePeriod(t.db, 'custom', '2026-03-01', '2026-03-31');
    expect([c.from, c.to]).toEqual(['2026-02-28T19:00:00.000Z', '2026-03-31T19:00:00.000Z']);
  });

  it('T32: acquired last month, delivered this month → cohort(last month) vs financial(this month)', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: 20_000 } });
    const { orderId } = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await t.db.query(`UPDATE referral_touches SET touched_at = (date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') - interval '3 days' WHERE id::text = (SELECT attribution->>'touch_id' FROM orders WHERE id=$1)`, [orderId]);
    await fulfilCod(t, s, orderId);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    const fin = await api(t, 'GET', '/partner/analytics/dashboard?period=this_month&basis=financial', { token: p.token });
    const cohNow = await api(t, 'GET', '/partner/analytics/dashboard?period=this_month&basis=cohort', { token: p.token });
    const cohPrev = await api(t, 'GET', '/partner/analytics/dashboard?period=last_month&basis=cohort', { token: p.token });
    expect(fin.json.totals.commission).toBe('2000000');
    expect(cohNow.json.totals.commission).toBe('0');
    expect(cohPrev.json.totals.commission).toBe('2000000');
    expect(fin.json.report_basis).toBe('financial');
    expect(cohPrev.json.as_of).toBeTruthy();
  });

  it('T08/T36: ratios are distinct-order sums; zero denominators → null ("Hisoblanmaydi"), never 0%/∞', async () => {
    const p = await mkPartner(t);
    const d = await dash(p);
    expect(d.json.ratios.confirmation.value).toBeNull();
    expect(d.json.ratios.delivery.value).toBeNull();
    expect(d.json.ratios.ad_result_pct.value).toBeNull();
    expect(d.json.ratios.commission_per_ad.value).toBeNull();
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    const a = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }], undefined, true); // guest → waits for the operator
    await fulfilCod(t, s, a.orderId);
    const d2 = await dash(p);
    expect(d2.json.counts).toMatchObject({ orders: 2, confirmed: 1, delivered: 1 });
    expect([d2.json.ratios.confirmation.value, d2.json.ratios.delivery.value, d2.json.ratios.delivery_total.value]).toEqual([50, 100, 50]);
  });

  it('T33: closing a month twice keeps v1 and adds a "qayta hisoblandi" v2', async () => {
    const p = await mkPartner(t);
    const day = new Date().toISOString().slice(0, 10);
    await api(t, 'POST', '/partner/ad-expenses', { token: p.token, body: { channel: 'telegram_channel', amount: '1000', service_from: day, service_to: day } });
    const month = day.slice(0, 7);
    await api(t, 'POST', '/admin/reports/close-month', { token: s.owner.token, body: { month } });
    await api(t, 'POST', '/admin/reports/close-month', { token: s.owner.token, body: { month, reason: 'qaytarish' } });
    const r = await api(t, 'GET', '/partner/reports/monthly', { token: p.token });
    const fin = r.json.items.filter((x: any) => x.report_basis === 'financial');
    expect(fin.map((x: any) => x.version)).toEqual([2, 1]);
    expect(fin[0].reason).toMatch(/qayta hisoblandi/);
  });

  it('T34/T35/T38: summary is deterministic, averages are labelled as averages, archived links stay in totals', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 30_000 } });
    const a = await referralOrder(p, prod.productId, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await fulfilCod(t, s, a.orderId);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    const link = (await t.db.query(`SELECT id FROM referral_links WHERE code=$1`, [a.code])).rows[0].id;
    await api(t, 'DELETE', `/partner/streams/${link}`, { token: p.token }); // "Arxivlash"
    const d = await dash(p);
    expect(d.json.totals.commission).toBe('3000000');
    expect(d.json.links.find((x: any) => x.link_id === link)).toMatchObject({ archived: true, commission: '3000000' });
    expect(d.json.summary_text).toContain('o‘rtacha');
    expect(d.json.summary_text).toContain('har biri shuncha degani emas');
    expect(d.json.link_counts).toMatchObject({ with_revenue: 1 });
  });

  it('T39: provider not connected / outage → explicit error and run record, totals untouched; tokens never returned', async () => {
    const p = await mkPartner(t);
    expect((await api(t, 'POST', '/partner/providers/meta/sync', { token: p.token, body: { from: '2026-11-01', to: '2026-11-02' } })).json.code).toBe('PROVIDER_NOT_CONNECTED');
    expect((await api(t, 'POST', '/partner/providers/meta/connect', { token: p.token, body: { account_id: 'act_123456', access_token: 'EAAB-test-token-not-real-0000000' } })).status).toBe(200);
    const st = await api(t, 'GET', '/partner/providers/status', { token: p.token });
    expect(JSON.stringify(st.json)).not.toContain('EAAB');
    const simulate = await api(t, 'POST', '/partner/analytics/simulate', { token: p.token, body: { product_id: (await matrixProduct()).productId, orders_by_qty: { '1': 36, '2': 20 }, ad_spend_minor: '0' } });
    expect(simulate.json).toMatchObject({ estimate: true, commission_minor: '183000000' });
    expect(simulate.json.label).toMatch(/TAXMIN/);
  });
});
