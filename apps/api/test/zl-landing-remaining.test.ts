import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { maybeRecognizeSale } from '../src/modules/tracking/service.js';
import { address, api, mkPartner, mkProduct, nextPhone, setupIsolatedApp, staff, type Staff, type T, tiyin, zoneId } from './helpers.js';

/** UZSHOP Landing & Target — the remaining P0B cases (LT-003, 006, 007, 009, 017, 019, 024, 025) on a separate DB. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_landing_rest');
  s = await staff(t);
});
const guest = () => randomUUID() + randomUUID();
async function publish(productIds: string[], template = 'pro', extraBlocks: any[] = []) {
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: `r-${randomUUID().slice(0, 8)}`, title: 'Rest', template, product_ids: productIds } });
  expect(c.status).toBe(200);
  if (extraBlocks.length) {
    const cur = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
    const r = await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: { ...cur.preview.definition, blocks: [...cur.preview.definition.blocks, ...extraBlocks] } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  for (const st of ['submit', 'approve', 'publish']) expect((await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} })).status).toBe(200);
  return (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
}
const quick = (g: string, body: Record<string, unknown>) => api(t, 'POST', '/checkout/quick-order', { guest: g, idem: randomUUID(), body: { name: 'Mijoz', phone: nextPhone(), accept_terms: true, ...body } });
async function prepareConfirm(orderId: string) {
  await api(t, 'POST', `/ops/orders/${orderId}/claim`, { token: s.operator.token });
  const o = (await t.db.query(`SELECT version FROM orders WHERE id=$1`, [orderId])).rows[0];
  expect((await api(t, 'PATCH', `/ops/orders/${orderId}/address`, { token: s.operator.token, body: { expected_version: o.version, address: { district: 'Chilonzor', street: 'Bunyodkor', house: '1' }, reason: 'mijoz aytdi' } })).status).toBe(200);
  return (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0].payable_minor as string;
}

describe('Landing — remaining P0B cases', () => {
  it('LT-003: stock 1, two landing orders confirmed at the same time → one reservation, the other goes to the out-of-stock queue', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [1] });
    const l = await publish([prod.productId]);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await quick(guest(), { sku_id: prod.skuIds[0], landing: { landing_id: l.id, revision: l.published_revision } })).json.order_id);
    const payable = await Promise.all(ids.map(prepareConfirm));
    await Promise.all(ids.map((id, i) => api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable[i] } })));
    const reserved = (await t.db.query(`SELECT COUNT(*)::int n FROM reservations WHERE order_id = ANY($1::uuid[]) AND status IN ('allocated_for_fulfillment','active_unpaid')`, [ids])).rows[0].n;
    const problems = (await t.db.query(`SELECT COUNT(*)::int n FROM orders WHERE id = ANY($1::uuid[]) AND problem_reason='out_of_stock'`, [ids])).rows[0].n;
    expect(reserved).toBe(1);
    expect(problems).toBe(1);
  });

  it('LT-006: an expired quote cannot create an order at the old amount', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await api(t, 'PUT', '/cart/lines', { guest: g, body: { sku_id: prod.skuIds[0], qty: 1 } });
    const q = await api(t, 'POST', '/checkout/quotes', { guest: g, body: { delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: nextPhone() } } });
    await t.db.query(`UPDATE checkout_quotes SET expires_at = now() - interval '1 minute' WHERE id=$1`, [q.json.quote_id]);
    const before = (await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n;
    const c = await api(t, 'POST', '/checkout/confirmations', { guest: g, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', accept_terms: true } });
    expect(c.json.code).toBe('QUOTE_EXPIRED');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n).toBe(before);
  });

  it('LT-007: multi-product landing → one order with two lines priced by the catalog engine', async () => {
    const a = await mkProduct(t, { prices: [100_000], stock: [5] });
    const b = await mkProduct(t, { prices: [50_000], stock: [5] });
    const l = await publish([a.productId, b.productId], 'multi');
    const r = await quick(guest(), { lines: [{ sku_id: a.skuIds[0], qty: 1 }, { sku_id: b.skuIds[0], qty: 2 }], landing: { landing_id: l.id, revision: l.published_revision } });
    expect(r.status).toBe(201);
    const lines = (await t.db.query(`SELECT sku_id, qty, unit_price_minor::text FROM order_lines WHERE order_id=$1 ORDER BY order_lines.unit_price_minor DESC`, [r.json.order_id])).rows;
    expect(lines).toEqual([{ sku_id: a.skuIds[0], qty: 1, unit_price_minor: tiyin(100_000) }, { sku_id: b.skuIds[0], qty: 2, unit_price_minor: tiyin(50_000) }]);
    expect((await t.db.query(`SELECT landing_snapshot FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].landing_snapshot.landing_id).toBe(l.id);
    // a product that is not on this landing is not recorded as a landing order
    const c = await mkProduct(t, { prices: [10_000], stock: [5] });
    const r2 = await quick(guest(), { lines: [{ sku_id: a.skuIds[0], qty: 1 }, { sku_id: c.skuIds[0], qty: 1 }], landing: { landing_id: l.id, revision: l.published_revision } });
    expect((await t.db.query(`SELECT landing_snapshot FROM orders WHERE id=$1`, [r2.json.order_id])).rows[0].landing_snapshot).toBeNull();
    expect((await quick(guest(), { lines: [{ sku_id: a.skuIds[0], qty: 1 }, { sku_id: a.skuIds[0], qty: 1 }] })).json.code).toBe('DUPLICATE_SKU');
  });

  it('LT-009: a resubmitted form (after being offline) is priced at the current catalog price; nothing was queued', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const l = await publish([prod.productId]);
    const before = (await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n;
    await t.db.query(`UPDATE offers SET price_minor=$2 WHERE sku_id=$1`, [prod.skuIds[0], tiyin(120_000)]);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n).toBe(before); // no automatic order while offline
    const r = await quick(guest(), { sku_id: prod.skuIds[0], price_minor: tiyin(100_000), landing: { landing_id: l.id, revision: l.published_revision } });
    expect((await t.db.query(`SELECT subtotal_minor::text FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].subtotal_minor).toBe(tiyin(120_000));
  });

  it('LT-017: a claim the catalog does not back (certificate / warranty) is flagged in preflight', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const l = await publish([prod.productId]);
    const c = await api(t, 'POST', '/admin/ad-campaigns', { token: s.owner.token, body: { landing_id: l.id } });
    const d = (await api(t, 'GET', `/admin/ad-campaigns/${c.json.id}`, { token: s.owner.token })).json;
    await api(t, 'PUT', `/admin/ad-campaigns/${d.id}`, { token: s.owner.token, body: { expected_version: d.version, creative: { headline: 'Sertifikatlangan quloqchin', primary_text: '2 yil kafolat bilan', cta: 'ORDER_NOW' } } });
    const pf = await api(t, 'POST', `/admin/ad-campaigns/${d.id}/preflight`, { token: s.owner.token });
    expect(pf.json.checks.find((x: any) => x.check === 'creative_claims_supported')).toMatchObject({ ok: false, reason: 'creative_unsupported_claim:certificate|warranty' });
    expect(pf.json.digest).toBeNull(); // cannot be approved until reviewed/fixed
  });

  it('LT-019: promotion timer comes from the server; refresh does not restart it; after expiry the code is refused', async () => {
    const code = `AKS${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    await t.db.query(`INSERT INTO promotions (code, name, kind, value_bps, funding_owner, starts_at, ends_at) VALUES ($1, '{"uz-Latn":"Aksiya"}', 'cart_percent', 1000, 'platform', now() - interval '1 hour', now() + interval '2 hours')`, [code]);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const l = await publish([prod.productId], 'pro', [{ id: 'promo', type: 'promo_timer', props: { code } }]);
    const a = (await api(t, 'GET', `/landings/promo/${code}`)).json;
    const b = (await api(t, 'GET', `/landings/promo/${code}`)).json;
    expect(a.active).toBe(true);
    expect(a.ends_at).toBe(b.ends_at); // a refresh shows the same server deadline
    const ok = await quick(guest(), { sku_id: prod.skuIds[0], promo_code: code, landing: { landing_id: l.id, revision: l.published_revision } });
    expect(BigInt((await t.db.query(`SELECT discount_minor::text d FROM orders WHERE id=$1`, [ok.json.order_id])).rows[0].d)).toBeGreaterThan(0n);
    await t.db.query(`UPDATE promotions SET ends_at = now() - interval '1 second', starts_at = now() - interval '3 hours' WHERE code=$1`, [code]);
    expect((await api(t, 'GET', `/landings/promo/${code}`)).json.active).toBe(false);
    expect((await quick(guest(), { sku_id: prod.skuIds[0], promo_code: code })).json.code).toBe('PROMO_NOT_APPLICABLE');
  });

  it('LT-024 + LT-025: an unconfirmed on-behalf order earns nothing; its sale event never carries the partner’s browser identity', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
    await api(t, 'POST', '/tracking/consent', { token: p.token, body: { status: 'granted', policy_version: (await api(t, 'GET', '/tracking/config')).json.consent_policy_version } });
    const q = await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: nextPhone() } } });
    const o = await api(t, 'POST', '/partner/orders', { token: p.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda kelishildi' } });
    expect(o.status).toBe(201);
    const id = o.json.order_id;
    const ord = (await t.db.query(`SELECT confirmation_status, payment_status, fulfillment_status FROM orders WHERE id=$1`, [id])).rows[0];
    expect(ord).toMatchObject({ confirmation_status: 'pending', payment_status: 'unpaid' });
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM commission_accruals WHERE order_id=$1 AND state IN ('pending','available')`, [id])).rows[0].n).toBe(0);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM uzcoin_ledger WHERE order_id=$1`, [id])).rows[0].n).toBe(0);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM tracking_events WHERE order_id=$1`, [id])).rows[0].n).toBe(0); // no Lead from the partner session
    // even if this order is later paid + delivered, the Purchase has no partner cookie/fbp/fbc and is a phone-process event
    await t.db.query(`UPDATE orders SET payment_status='paid', paid_at=now(), fulfillment_status='delivered', delivered_at=now() WHERE id=$1`, [id]);
    const e = await maybeRecognizeSale(t.db, id);
    const row = (await t.db.query(`SELECT action_source, user_data, status FROM tracking_events WHERE event_id=$1`, [e!.event_id])).rows[0];
    expect(row.action_source).toBe('phone_call');
    expect(row.user_data.fbp).toBeUndefined();
    expect(row.user_data.fbc).toBeUndefined();
    expect(row.status).toBe('suppressed'); // no customer consent → not exported
  });
});
