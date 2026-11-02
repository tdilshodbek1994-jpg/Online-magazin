import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

describe('Admin overview', () => {
  it('owner sees every order by status and product flow (ordered vs stock)', async () => {
    const prod = await mkProduct(t, { prices: [70_000], stock: [10] });
    const c = await mkUser(t);
    const delivered = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    await fulfilCod(t, s, delivered.json.order_id);
    const c2 = await mkUser(t);
    const accepted = await placeOrder(t, { token: c2.token, phone: c2.phone }, [{ sku_id: prod.skuIds[0]!, qty: 3 }]);
    const guest = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: '+998901112233' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);

    const all = await api(t, 'GET', `/admin/orders?q=${encodeURIComponent(accepted.json.number)}`, { token: s.owner.token });
    expect(all.status).toBe(200);
    expect(all.json.items[0]).toMatchObject({ number: accepted.json.number, bucket: 'accepted', customer_phone: c2.phone });
    expect(all.json.items[0].items[0].qty).toBe(3);
    const news = await api(t, 'GET', '/admin/orders?status=new', { token: s.owner.token });
    expect(news.json.items.some((o: any) => o.id === guest.json.order_id)).toBe(true);
    expect(news.json.counts.new).toBeGreaterThanOrEqual(1);

    const flow = await api(t, 'GET', '/admin/products/flow', { token: s.owner.token });
    const f = flow.json.items.find((x: any) => x.id === prod.productId);
    expect(f).toMatchObject({ delivered: 2, accepted_to_ship: 3, total_orders: 3 });
    expect(f.ordered.new).toBe(1);
    expect(f.on_hand).toBe(8); // 10 − 2 shipped
    expect(f.reserved).toBe(3); // accepted order holds stock
    expect(f.available).toBe(5);
  });

  it('owner sees who sells which product: partner leaderboard and per-product sellers', async () => {
    const star = await mkPartner(t);
    const other = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [20], rule: { kind: 'percent', bps: 1000 } });
    const sStar = await api(t, 'POST', '/partner/streams', { token: star.token, body: { product_id: prod.productId, name: 'TG' } });
    await api(t, 'POST', '/partner/streams', { token: other.token, body: { product_id: prod.productId, name: 'IG' } });
    for (let i = 0; i < 2; i++) {
      const guest = randomUUID() + randomUUID();
      await api(t, 'POST', '/referrals/touch', { guest, body: { code: sStar.json.code } });
      const c = await mkUser(t);
      const o = await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
      if (i === 0) await fulfilCod(t, s, o.json.order_id);
    }
    const perf = await api(t, 'GET', '/admin/partners/performance', { token: s.owner.token });
    expect(perf.status).toBe(200);
    const st = perf.json.items.find((x: any) => x.id === star.partnerId);
    expect(st).toMatchObject({ clicks: 2, streams: 1, delivered_sales_minor: expect.any(String), delivery_rate_pct: 100 });
    expect(st.orders).toMatchObject({ total: 2, delivered: 1, accepted: 1 });
    expect(st.top_products[0].product_id).toBe(prod.productId);
    expect(st.rank).toBeLessThan(perf.json.items.find((x: any) => x.id === other.partnerId).rank);

    const sellers = await api(t, 'GET', `/admin/products/${prod.productId}/sellers`, { token: s.owner.token });
    expect(sellers.json.items[0]).toMatchObject({ id: star.partnerId, orders: 2, delivered_qty: 1, clicks: 2, streams: 1, commission_minor: '2000000' });
    expect(sellers.json.items.find((x: any) => x.id === other.partnerId)).toMatchObject({ orders: 0, streams: 1 });
    expect((await api(t, 'GET', '/admin/partners/performance', { token: star.token })).status).toBe(403);
  });

  it('product editor: create returns sku ids; PATCH edits name/description/brand with optimistic version', async () => {
    const cat = (await api(t, 'GET', '/categories')).json.items[0];
    const code = `ED-${randomUUID().slice(0, 6)}`;
    const c = await api(t, 'POST', '/admin/products', { token: s.catalog.token, body: { name: { 'uz-Latn': 'Eski nom' }, category_id: cat.id, skus: [{ sku_code: code, price_minor: '1000000', variant: { rang: 'qora' } }] } });
    expect(c.status).toBe(200);
    expect(c.json.skus[0]).toMatchObject({ sku_code: code, sku_id: expect.any(String) });
    const e = await api(t, 'PATCH', `/admin/products/${c.json.id}`, { token: s.catalog.token, body: { expected_version: 1, name: { 'uz-Latn': 'Yangi nom' }, description: { 'uz-Latn': 'Tavsif' }, brand: 'BrendX', warranty_months: 6 } });
    expect(e.status).toBe(200);
    expect((await api(t, 'PATCH', `/admin/products/${c.json.id}`, { token: s.catalog.token, body: { expected_version: 1, name: { 'uz-Latn': 'Eskirgan ekran' } } })).status).toBe(409);
    const list = await api(t, 'GET', `/admin/products?q=${encodeURIComponent('yangi nom')}`, { token: s.catalog.token });
    expect(list.json.items[0]).toMatchObject({ id: c.json.id, brand: 'BrendX', warranty_months: 6, description: { 'uz-Latn': 'Tavsif' } });
    expect((await api(t, 'PATCH', `/admin/products/${c.json.id}`, { token: s.operator.token, body: { expected_version: 2, name: { 'uz-Latn': 'x' } } })).status).toBe(403);
  });

  it('customers and couriers cannot read the overview', async () => {
    const c = await mkUser(t);
    expect((await api(t, 'GET', '/admin/orders', { token: c.token })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/products/flow', { token: c.token })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/orders', { token: s.courier.token })).status).toBe(403);
  });
});
