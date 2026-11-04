import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupApp, staff, type Staff, type T, tiyin } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});
const guestTok = () => randomUUID() + randomUUID();

describe('Partner-funded customer discount stream', () => {
  it('caps the discount by the commission; old link keeps the normal price', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [70_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 15_000 } });
    const lim = await api(t, 'GET', `/partner/streams/discount-limit?product_id=${prod.productId}`, { token: partner.token });
    expect(lim.json).toMatchObject({ price_minor: tiyin(70_000), commission_minor: tiyin(15_000), max_discount_minor: tiyin(15_000) });
    const tooBig = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'Chegirma', customer_discount_minor: tiyin(20_000) } });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.code).toBe('DISCOUNT_TOO_BIG');

    const plain = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'Oddiy' } });
    const g = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: plain.json.code } });
    expect((await api(t, 'GET', `/referral/discount?product_id=${prod.productId}`, { guest: g })).json.unit).toBeNull();
    const o = await placeOrder(t, { guest: g, phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(o.status).toBe(201);
    expect((await t.db.query(`SELECT subtotal_minor::text, payable_minor::text FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].subtotal_minor).toBe(tiyin(70_000));
  });

  it('discount link: customer pays price − discount, order is attributed to that link, commission is reduced by the discount, operator sees it on the line', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [70_000], stock: [20], rule: { kind: 'fixed_per_unit', fixed: 15_000 } });
    const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'Chegirma 10k', customer_discount_minor: tiyin(10_000) } });
    expect(st.status).toBe(200);
    expect(st.json.customer_discount_minor).toBe(tiyin(10_000));

    const g = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: st.json.code } });
    const d = await api(t, 'GET', `/referral/discount?product_id=${prod.productId}`, { guest: g });
    expect(d.json.unit.amount_minor).toBe(tiyin(10_000));
    expect(d.json.partner_code).toBe(partner.code);

    const o = await placeOrder(t, { guest: g, phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    expect(o.status).toBe(201);
    expect(o.quote.lines[0].seller_discount_unit.amount_minor).toBe(tiyin(10_000));
    const ord = (await t.db.query(`SELECT attributed_partner_id, attribution->>'link_id' AS link, subtotal_minor::text, discount_minor::text, payable_minor::text, delivery_minor::text FROM orders WHERE id=$1`, [o.json.order_id])).rows[0];
    expect(ord.attributed_partner_id).toBe(partner.partnerId);
    expect(ord.link).toBe(st.json.id);
    expect(ord.subtotal_minor).toBe(tiyin(140_000));
    // 2 × (70 000 − 10 000) + delivery
    expect(BigInt(ord.payable_minor) - BigInt(ord.delivery_minor) + (BigInt(ord.discount_minor) - BigInt(tiyin(20_000)))).toBe(BigInt(tiyin(120_000)));
    const line = (await t.db.query(`SELECT partner_discount_minor::text, line_discount_minor::text, product_snapshot FROM order_lines WHERE order_id=$1`, [o.json.order_id])).rows[0];
    expect(line.partner_discount_minor).toBe(tiyin(10_000));
    expect(line.line_discount_minor).toBe(tiyin(20_000));
    expect(line.product_snapshot.partner_discount.partner_code).toBe(partner.code);
    // Commission: 2 × 15 000 − 2 × 10 000 = 10 000
    const acc = (await t.db.query(`SELECT COALESCE(SUM(target_minor),0)::text AS s FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded'`, [o.json.order_id])).rows[0].s;
    expect(acc).toBe(tiyin(10_000));

    // Delivered: the reduced commission is what the partner earns.
    const payable = (await t.db.query(`SELECT payable_minor::text AS p FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${o.json.order_id}/claim`, { token: s.operator.token });
    expect((await api(t, 'POST', `/ops/orders/${o.json.order_id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
    await fulfilCod(t, s, o.json.order_id);
    const after = (await t.db.query(`SELECT COALESCE(SUM(target_minor),0)::text AS s FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded'`, [o.json.order_id])).rows[0].s;
    expect(after).toBe(tiyin(10_000));
  });
});
