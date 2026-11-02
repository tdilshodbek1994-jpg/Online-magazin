import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { address, api, fulfilCod, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

describe('Stage B — first full sale: product → order → operator → warehouse → delivery → COD settlement', () => {
  it('B-E2E: owner creates product, guest orders, operator confirms by call, warehouse ships, courier delivers, finance reconciles COD', async () => {
    const cats = await api(t, 'POST', '/admin/categories', { token: s.owner.token, body: { slug: `cat-${randomUUID().slice(0, 6)}`, name: { 'uz-Latn': 'Kategoriya' } } });
    expect(cats.status).toBe(200);
    const created = await api(t, 'POST', '/admin/products', { token: s.catalog.token, body: { name: { 'uz-Latn': 'Termos 1L', 'uz-Cyrl': 'Термос 1Л' }, category_id: cats.json.id, brand: 'DemoBrand', skus: [{ sku_code: `TRM-${randomUUID().slice(0, 6)}`, price_minor: '15000000', cost_minor: '9000000' }] } });
    expect(created.status).toBe(200);
    const list = await api(t, 'GET', '/admin/products', { token: s.catalog.token });
    const prod = list.json.items.find((p: any) => p.id === created.json.id);
    const skuId = prod.skus[0].sku_id;
    expect((await api(t, 'POST', `/admin/skus/${skuId}/stock`, { token: s.warehouse.token, body: { kind: 'receipt', qty: 5, reason: 'supplier delivery', ref: `rcpt-${randomUUID()}` } })).status).toBe(200);
    expect((await api(t, 'POST', `/admin/products/${created.json.id}/status`, { token: s.catalog.token, body: { status: 'published', expected_version: prod.version } })).status).toBe(200);
    // Customer sees it publicly (no cost in public API).
    const pub = await api(t, 'GET', `/products/${created.json.slug}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.json)).not.toContain('cost');
    // Guest checkout → awaiting operator confirmation, no stock held yet.
    const guest = randomUUID() + randomUUID();
    const order = await placeOrder(t, { guest, phone: '+998901112233' }, [{ sku_id: skuId, qty: 2 }]);
    expect(order.status).toBe(201);
    expect(order.json.confirmation).toBe('pending_operator_call');
    const id = order.json.order_id;
    let sb = (await t.db.query(`SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [skuId])).rows[0];
    expect(sb).toEqual({ on_hand_sellable: 5, reserved: 0 });
    // Operator claims, calls, reads back exact total → confirmed + reserved.
    expect((await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token })).status).toBe(200);
    const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [id])).rows[0].payable_minor;
    expect(payable).toBe(String(2 * 15000000 + 2000000));
    const call = await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable, note: 'Mijoz tasdiqladi' } });
    expect(call.status).toBe(200);
    sb = (await t.db.query(`SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [skuId])).rows[0];
    expect(sb).toEqual({ on_hand_sellable: 5, reserved: 2 });
    await fulfilCod(t, s, id);
    const o = (await t.db.query(`SELECT commercial_status, payment_status, fulfillment_status, confirmation_status FROM orders WHERE id=$1`, [id])).rows[0];
    expect(o).toEqual({ commercial_status: 'completed', payment_status: 'paid', fulfillment_status: 'delivered', confirmation_status: 'verified' });
    sb = (await t.db.query(`SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [skuId])).rows[0];
    expect(sb).toEqual({ on_hand_sellable: 3, reserved: 0 });
    // Ledger: COD collected then remitted; courier cash back to zero for this order.
    const j = await t.db.query(`SELECT kind FROM journal_transactions WHERE business_event_key IN ($1,$2) ORDER BY kind`, [`cod_collected:${id}`, `cod_remitted:${(await t.db.query(`SELECT remittance_id FROM cod_collections WHERE order_id=$1`, [id])).rows[0].remittance_id}`]);
    expect(j.rows.map((r) => r.kind)).toEqual(['cod_collected', 'cod_remitted']);
    // Timeline has actor/reason entries for each dimension.
    const tl = await api(t, 'GET', `/ops/orders/${id}`, { token: s.operator.token });
    expect(tl.json.timeline.map((e: any) => `${e.dimension}:${e.to_status}`)).toEqual(expect.arrayContaining(['commercial:confirmed', 'fulfillment:picking', 'fulfillment:packed', 'fulfillment:shipped', 'fulfillment:delivered', 'payment:paid']));
  });

  it('B-verified: logged-in customer whose session phone matches is confirmed and reserved at once', async () => {
    const p = await mkProduct(t, { prices: [50_000], stock: [3] });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: p.skuIds[0]!, qty: 1 }]);
    expect(r.status).toBe(201);
    expect(r.json.confirmation).toBe('verified');
    const sb = (await t.db.query(`SELECT reserved FROM stock_balances WHERE sku_id=$1`, [p.skuIds[0]])).rows[0];
    expect(sb.reserved).toBe(1);
  });

  it('B-quote: quote shows delivery tariff and payable computed on server', async () => {
    const p = await mkProduct(t, { prices: [100_000] });
    const guest = randomUUID() + 'x'.repeat(10);
    await api(t, 'PUT', '/cart/lines', { guest, body: { sku_id: p.skuIds[0], qty: 3 } });
    const q = await api(t, 'POST', '/checkout/quotes', { guest, body: { delivery_zone_id: await zoneId(t), address, contact: { name: 'A', phone: '901234567' } } });
    expect(q.status).toBe(200);
    expect(q.json.subtotal.amount_minor).toBe('30000000');
    expect(q.json.delivery.amount_minor).toBe('2000000');
    expect(q.json.payable.amount_minor).toBe('32000000');
  });
});
