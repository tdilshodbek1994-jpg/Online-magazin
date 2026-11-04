import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clickConversion, funnel } from '../src/modules/landings/analytics.js';
import { address, api, fulfilCod, mkPartner, mkProduct, nextPhone, setupIsolatedApp, staff, type Staff, type T, tiyin, zoneId } from './helpers.js';

/** UZSHOP Landing & Target — P1A analytics (LT-081…LT-090) on a separate database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_landing_analytics');
  s = await staff(t);
});
const guest = () => randomUUID() + randomUUID();
async function setup() {
  const a = await mkPartner(t);
  const prod = await mkProduct(t, { prices: [100_000], stock: [100], rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: `a-${randomUUID().slice(0, 8)}`, title: 'Analytics', template: 'pro', product_ids: [prod.productId] } });
  for (const st of ['submit', 'approve', 'publish']) expect((await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} })).status).toBe(200);
  const l = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
  const tg = (await api(t, 'POST', '/partner/streams', { token: a.token, body: { product_id: prod.productId, name: 'TG', landing_id: l.id, channel: 'telegram' } })).json;
  const ig = (await api(t, 'POST', '/partner/streams', { token: a.token, body: { product_id: prod.productId, name: 'IG', landing_id: l.id, channel: 'instagram' } })).json;
  return { a, prod, l, tg, ig };
}
const report = async (id: string) => { const r = await api(t, 'GET', `/admin/landings/${id}/analytics`, { token: s.owner.token }); expect(r.status).toBe(200); return r.json; };
const spend = (id: string, body: Record<string, unknown>, token = s.finance.token) => api(t, 'POST', `/admin/landings/${id}/spend`, { token, body: { channel: 'meta_mixed', currency: 'UZS', service_from: today(), service_to: today(), ...body } });
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
async function confirmAndDeliver(orderId: string) {
  await api(t, 'POST', `/ops/orders/${orderId}/claim`, { token: s.operator.token });
  const o = (await t.db.query(`SELECT version, payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0];
  await api(t, 'PATCH', `/ops/orders/${orderId}/address`, { token: s.operator.token, body: { expected_version: o.version, address: { district: 'Chilonzor', street: 'Bunyodkor', house: '1' }, reason: 'mijoz aytdi' } });
  const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0].payable_minor;
  expect((await api(t, 'POST', `/ops/orders/${orderId}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
  await fulfilCod(t, s, orderId);
}

describe('Landing analytics P1A', () => {
  it('LT-082: approval / delivery-from-confirmed / overall are distinct-order ratios (100 → 70 → 56 = 70%, 80%, 56%)', () => {
    expect(funnel(100, 70, 56)).toEqual({ approval: 70, delivery_from_confirmed: 80, overall: 56 });
    expect(funnel(0, 0, 0)).toEqual({ approval: null, delivery_from_confirmed: null, overall: null }); // never 0% / ∞
    expect(clickConversion(10, 100)).toBe(10);
  });

  it('LT-081 + LT-083: orders vs units are counted separately; click conversion uses link orders only (on-behalf orders excluded)', async () => {
    const { a, prod, l, tg } = await setup();
    const guests = Array.from({ length: 20 }, guest);
    for (const g of guests) expect((await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: tg.code } })).status).toBe(200);
    const ids: string[] = [];
    for (const [i, qty] of [[0, 1], [1, 2]] as const) {
      const r = await api(t, 'POST', '/checkout/quick-order', { guest: guests[i], idem: randomUUID(), body: { sku_id: prod.skuIds[0], qty, name: 'Mijoz', phone: nextPhone(), accept_terms: true, landing: { landing_id: l.id, revision: l.published_revision } } });
      expect(r.status).toBe(201);
      ids.push(r.json.order_id);
    }
    // two partner-entered (on-behalf) orders on the same flow
    for (let i = 0; i < 2; i++) {
      const q = await api(t, 'POST', '/partner/orders/quote', { token: a.token, body: { lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: nextPhone() } } });
      const o = await api(t, 'POST', '/partner/orders', { token: a.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda kelishildi' } });
      expect(o.status).toBe(201);
      // a draft submitted from the flow carries its root link (same as createAssistedOrder with rootLinkId)
      await t.db.query(`UPDATE orders SET attribution = attribution || jsonb_build_object('link_id', $2::text) WHERE id=$1`, [o.json.order_id, tg.id]);
    }
    for (const id of ids) await confirmAndDeliver(id);
    const r = await report(l.id);
    expect(r.counts).toMatchObject({ visits: 20, orders: 4, link_orders: 2, on_behalf_orders: 2, delivered: 2, delivered_units: 3, qty_distribution: { '1': 1, '2': 1, '3': 0, '4+': 0 } });
    expect(r.ratios.click_conversion).toBe(10); // 2/20, not 4/20
    expect(r.ratios.approval).toBe(100); // reviewed = the 2 operator-confirmed ones; on-behalf still wait for the customer
    expect(r.money.commission_available).toBe('0'); // still in hold — never shown as available early
    expect(BigInt(r.money.commission_waiting)).toBeGreaterThan(0n);
  });

  it('LT-084: no spend entered → missing-data marker, no fake 0 spend or fake result; explicit zero is 0', async () => {
    const { l } = await setup();
    let r = await report(l.id);
    expect(r.money.shop_ad_spend).toBeNull();
    expect(r.money.cost_per_delivered_order).toBeNull();
    expect(r.completeness.spend_entered).toBe(false);
    expect(r.completeness.notes.join(' ')).toMatch(/kiritilmagan/);
    expect((await spend(l.id, { amount: '0', kind: 'zero_confirmed' })).status).toBe(200);
    r = await report(l.id);
    expect(r.money.shop_ad_spend).toBe('0');
  });

  it('LT-085 + LT-086 + LT-087: replay upserts; campaign/adset totals refused; manual + API same spend → reconciliation, never summed', async () => {
    const { l } = await setup();
    const row = { amount: '40000', report_level: 'ad', external_key: 'act1|ad1|mixed|' + today(), channel: 'meta_mixed' };
    expect((await spend(l.id, row)).json.outcome).toBe('created');
    expect((await spend(l.id, row)).json.outcome).toBe('replayed');
    expect((await spend(l.id, { ...row, amount: '45000' })).json.outcome).toBe('updated');
    expect((await spend(l.id, { amount: '100000', report_level: 'campaign', external_key: 'act1|camp1' })).status).toBe(422);
    expect((await spend(l.id, { amount: '100000', report_level: 'adset', external_key: 'act1|set1' })).status).toBe(422);
    let r = await report(l.id);
    expect(r.money.shop_ad_spend).toBe(tiyin(45_000));
    expect(r.spend_rows).toHaveLength(1);
    // second landing: manual first, then the API row for the same days
    const { l: l2 } = await setup();
    expect((await spend(l2.id, { amount: '60000', channel: 'instagram_target' })).json.outcome).toBe('created');
    const api1 = await spend(l2.id, { amount: '60000', report_level: 'ad', external_key: 'act1|ad9|instagram|' + today(), channel: 'instagram_target' });
    expect(api1.json.outcome).toBe('needs_reconcile');
    r = await report(l2.id);
    expect(r.money.shop_ad_spend).toBe(tiyin(60_000)); // not 120 000
    expect(r.completeness.reconcile_queue).toBe(1);
    expect((await api(t, 'POST', `/admin/landings/spend/${api1.json.id}/reconcile`, { token: s.finance.token, body: { keep: 'provider' } })).status).toBe(200);
    r = await report(l2.id);
    expect(r.money.shop_ad_spend).toBe(tiyin(60_000));
    expect(r.completeness.reconcile_queue).toBe(0);
  });

  it('LT-088: 100 000 UZS shop cost split 60/40 over two flows stays 100 000; no wallet/ledger movement; partner result untouched', async () => {
    const { a, l, tg, ig } = await setup();
    const ledgerBefore = (await t.db.query(`SELECT COUNT(*)::int n FROM partner_ledger WHERE partner_id=$1`, [a.partnerId])).rows[0].n;
    const journalBefore = (await t.db.query(`SELECT COUNT(*)::int n FROM journal_transactions`)).rows[0].n;
    expect((await spend(l.id, { amount: '100000', channel: 'instagram_target', allocations: [{ root_link_id: tg.id, share_bps: 6000 }, { root_link_id: ig.id, share_bps: 4000 }] }, s.operator.token)).status).toBe(403);
    const r0 = await spend(l.id, { amount: '100000', channel: 'instagram_target', note: 'sintetik test xarajati', allocations: [{ root_link_id: tg.id, share_bps: 6000 }, { root_link_id: ig.id, share_bps: 4000 }] });
    expect(r0.status).toBe(200);
    const r = await report(l.id);
    expect(r.money.shop_ad_spend).toBe(tiyin(100_000));
    expect(Object.fromEntries(r.flows.map((f: any) => [f.id, f.shop_spend_allocated]))).toEqual({ [tg.id]: tiyin(60_000), [ig.id]: tiyin(40_000) });
    expect(r.spend_rows[0]).toMatchObject({ payer: 'shop', amount_original: '100000.00', currency: 'UZS' });
    expect((await t.db.query(`SELECT partner_id, payer FROM ad_expenses WHERE id=$1`, [r0.json.id])).rows[0]).toEqual({ partner_id: null, payer: 'shop' });
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM partner_ledger WHERE partner_id=$1`, [a.partnerId])).rows[0].n).toBe(ledgerBefore);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM journal_transactions`)).rows[0].n).toBe(journalBefore);
    const dash = await api(t, 'GET', '/partner/analytics/dashboard', { token: a.token });
    expect(dash.json.totals.ad).toBeNull(); // the shop's cost is not the partner's personal expense
    // a flow of another landing cannot receive this landing's cost
    const other = await setup();
    expect((await spend(l.id, { amount: '1000', allocations: [{ root_link_id: other.tg.id, share_bps: 10000 }] })).status).toBe(404);
  });

  it('LT-090: FX frozen at entry (a later rate keeps the old UZS value); Meta mixed stays mixed — no invented Instagram split', async () => {
    const { a, l } = await setup();
    const d = '2026-10-01';
    expect((await api(t, 'POST', '/admin/fx', { token: s.finance.token, body: { currency: 'USD', date: d, rate: '12000', source: 'manual' } })).status).toBe(200);
    const e = await spend(l.id, { amount: '10', currency: 'USD', service_from: d, service_to: d });
    expect(e.status).toBe(200);
    await api(t, 'POST', '/admin/fx', { token: s.finance.token, body: { currency: 'USD', date: d, rate: '13000', source: 'bank_actual' } });
    expect((await t.db.query(`SELECT amount_uzs_minor::text, fx_rate::text FROM ad_expenses WHERE id=$1`, [e.json.id])).rows[0]).toEqual({ amount_uzs_minor: tiyin(120_000), fx_rate: '12000.000000' });
    const rows = (await api(t, 'GET', `/admin/landings/${l.id}/analytics?from=${d}&to=${d}`, { token: s.owner.token })).json.spend_rows;
    expect(rows[0].channel_label).toMatch(/aralash/);
    // partner analytics: meta_mixed spend stays its own channel
    await api(t, 'POST', '/partner/ad-expenses', { token: a.token, body: { channel: 'meta_mixed', amount: '50000', service_from: today(), service_to: today() } });
    const dash = await api(t, 'GET', '/partner/analytics/dashboard', { token: a.token });
    const ch = Object.fromEntries(dash.json.channels.map((c: any) => [c.channel, c.ad]));
    expect(ch.meta_mixed).toBe(tiyin(50_000));
    expect(ch.instagram_target ?? '0').toBe('0');
  });
});
