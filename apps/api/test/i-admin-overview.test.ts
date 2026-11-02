import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, fulfilCod, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

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

  it('customers and couriers cannot read the overview', async () => {
    const c = await mkUser(t);
    expect((await api(t, 'GET', '/admin/orders', { token: c.token })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/products/flow', { token: c.token })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/orders', { token: s.courier.token })).status).toBe(403);
  });
});
