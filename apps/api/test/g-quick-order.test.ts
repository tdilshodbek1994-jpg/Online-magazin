import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkPartner, mkProduct, nextPhone, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});
const guestTok = () => randomUUID() + randomUUID();
const quick = (guest: string, body: Record<string, unknown>, idem = randomUUID()) => api(t, 'POST', '/checkout/quick-order', { guest, idem, body: { accept_terms: true, ...body } });

describe('Quick order (name + phone)', () => {
  it('creates a pending COD order with server price, attributes the referral, reserves nothing until the operator records the address and confirms', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [150_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'TG' } });
    const guest = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: st.json.code } });
    const phone = nextPhone();
    const idem = randomUUID();
    const r = await quick(guest, { sku_id: prod.skuIds[0], qty: 2, name: 'Aziza', phone }, idem);
    expect(r.status).toBe(201);
    expect(r.json.confirmation).toBe('pending_operator_call');
    // Replaying the same key returns the same order (double tap on a phone).
    const again = await quick(guest, { sku_id: prod.skuIds[0], qty: 2, name: 'Aziza', phone }, idem);
    expect(again.status).toBe(200);
    expect(again.json.order_id).toBe(r.json.order_id);

    const o = (await t.db.query(`SELECT commercial_status, payment_method, customer_phone, attributed_partner_id, address_snapshot, subtotal_minor::text, version FROM orders WHERE id=$1`, [r.json.order_id])).rows[0];
    expect(o).toMatchObject({ commercial_status: 'awaiting_confirmation', payment_method: 'cod', customer_phone: phone, attributed_partner_id: partner.partnerId, subtotal_minor: '30000000' });
    expect(o.address_snapshot.quick).toBe(true);

    const id = r.json.order_id;
    const payable = (await t.db.query(`SELECT payable_minor::text AS p FROM orders WHERE id=$1`, [id])).rows[0].p;
    expect((await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token })).status).toBe(200);
    const early = await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    expect(early.status).toBe(422);
    expect(early.json.code).toBe('ADDRESS_REQUIRED');
    const v = (await t.db.query(`SELECT version FROM orders WHERE id=$1`, [id])).rows[0].version;
    expect((await api(t, 'PATCH', `/ops/orders/${id}/address`, { token: s.operator.token, body: { expected_version: v, address: { district: 'Chilonzor', street: 'Bunyodkor', house: '12' }, reason: 'mijoz qo‘ng‘iroqda aytdi' } })).status).toBe(200);
    expect((await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
    expect((await t.db.query(`SELECT commercial_status FROM orders WHERE id=$1`, [id])).rows[0].commercial_status).toBe('confirmed');
  });

  it('validates phone, requires terms, rejects unknown SKU and rate-limits per phone', async () => {
    const prod = await mkProduct(t, { prices: [50_000], stock: [50] });
    const guest = guestTok();
    expect((await quick(guest, { sku_id: prod.skuIds[0], name: 'Ali', phone: '12345' })).json.code).toBe('PHONE_INVALID');
    expect((await api(t, 'POST', '/checkout/quick-order', { guest, idem: randomUUID(), body: { sku_id: prod.skuIds[0], name: 'Ali', phone: nextPhone() } })).status).toBe(400);
    expect((await quick(guest, { sku_id: randomUUID(), name: 'Ali', phone: nextPhone() })).status).toBeGreaterThanOrEqual(400);
    const phone = nextPhone();
    for (let i = 0; i < 5; i++) expect((await quick(guestTok(), { sku_id: prod.skuIds[0], name: 'Ali', phone })).status).toBe(201);
    const sixth = await quick(guestTok(), { sku_id: prod.skuIds[0], name: 'Ali', phone });
    expect(sixth.status).toBe(429);
    expect(sixth.json.code).toBe('QUICK_ORDER_RATE_LIMIT');
  });
});

describe('Duplicate signal', () => {
  it('second order of the same SKU from the same phone within 24h is flagged; partner sees it under Dublikat', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [20_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'TG' } });
    const phone = nextPhone();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const guest = guestTok();
      await api(t, 'POST', '/referrals/touch', { guest, body: { code: st.json.code } });
      ids.push((await quick(guest, { sku_id: prod.skuIds[0], name: 'Ali', phone })).json.order_id);
    }
    const flags = (await t.db.query(`SELECT id, duplicate_signal FROM orders WHERE id = ANY($1::uuid[])`, [ids])).rows;
    expect(flags.find((f) => f.id === ids[0]).duplicate_signal).toBe(false);
    expect(flags.find((f) => f.id === ids[1]).duplicate_signal).toBe(true);
    const req = await api(t, 'GET', '/partner/requests?status=duplicate', { token: partner.token });
    expect(req.json.counts.duplicate).toBe(1);
    expect(req.json.items.map((x: any) => x.id)).toEqual([ids[1]]);
  });
});

describe('Admin image management', () => {
  it('lists and removes a product image; storefront stops showing it; catalog managers only', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [1] });
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#0b7a55' } }).png().toBuffer();
    const up = await api(t, 'POST', `/admin/products/${prod.productId}/media`, { token: s.catalog.token, body: { filename: 'a.png', content_base64: png.toString('base64'), rights_source: 'own photo' } });
    expect(up.status).toBe(200);
    const list = await api(t, 'GET', `/admin/products/${prod.productId}/media`, { token: s.catalog.token });
    expect(list.json.items).toHaveLength(1);
    expect((await api(t, 'GET', `/products/${prod.slug}`)).json.media).toHaveLength(1);
    expect((await api(t, 'DELETE', `/admin/media/${up.json.id}`, { token: s.operator.token })).status).toBe(403);
    expect((await api(t, 'DELETE', `/admin/media/${up.json.id}`, { token: s.catalog.token })).status).toBe(200);
    expect((await api(t, 'GET', `/products/${prod.slug}`)).json.media).toBeNull();
    expect((await api(t, 'DELETE', `/admin/media/${up.json.id}`, { token: s.catalog.token })).status).toBe(404);
  });
});
