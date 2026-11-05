import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, mkUser, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('Low-stock alerts', () => {
  it('lists SKUs running out with days of cover from real sales; no forecast without sales', async () => {
    const fast = await mkProduct(t, { prices: [10_000], stock: [6] });
    const idle = await mkProduct(t, { prices: [10_000], stock: [2] });
    // 3 confirmed units sold in 30 days → 0.1/day; 6 - 3 reserved... use verified customer orders (auto-confirmed)
    for (let i = 0; i < 3; i++) { const c = await mkUser(t); await placeOrder(t, { token: c.token, guest: randomUUID() + randomUUID(), phone: c.phone }, [{ sku_id: fast.skuIds[0]!, qty: 1 }]); }
    const r = await api(t, 'GET', '/admin/stock/low?days=60', { token: s.owner.token });
    expect(r.status).toBe(200);
    const f = r.json.items.find((x: any) => x.sku_id === fast.skuIds[0]);
    expect(f.sold_30d).toBe(3);
    expect(f.days_left).toBeGreaterThan(0);
    const i = r.json.items.find((x: any) => x.sku_id === idle.skuIds[0]);
    expect(i.days_left).toBeNull(); // low stock, but no sales → no invented forecast
    expect((await api(t, 'GET', '/admin/stock/low', { token: s.operator.token })).status).toBe(403);
    void nextPhone;
  });
});
