import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('Drill-down: stream card pill → orders of that stream', () => {
  it('filters /partner/requests by link (incl. its placements), counts match the stream', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    const a = await api(t, 'POST', '/partner/streams', { token: p.token, body: { product_id: prod.productId, name: 'A' } });
    const b = await api(t, 'POST', '/partner/streams', { token: p.token, body: { product_id: prod.productId, name: 'B' } });
    const pl = await api(t, 'POST', `/partner/links/${a.json.id}/placements`, { token: p.token, body: { channel: 'instagram_target', name: 'IG' } });
    const order = async (code: string) => {
      const guest = randomUUID() + randomUUID();
      await api(t, 'POST', '/referrals/touch', { guest, body: { code } });
      const c = await mkUser(t);
      return (await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }])).json.order_id as string;
    };
    const o1 = await order(a.json.code);
    await order(pl.json.code);
    await order(b.json.code);
    await fulfilCod(t, s, o1);
    const all = await api(t, 'GET', `/partner/requests?link=${a.json.id}`, { token: p.token });
    expect(all.status).toBe(200);
    expect(all.json.counts.total).toBe(2);
    const del = await api(t, 'GET', `/partner/requests?link=${a.json.id}&status=delivered`, { token: p.token });
    expect(del.json.items.map((x: any) => x.id)).toEqual([o1]);
    expect((await api(t, 'GET', `/partner/requests?link=${b.json.id}`, { token: p.token })).json.counts.total).toBe(1);
    const other = await mkPartner(t);
    expect((await api(t, 'GET', `/partner/requests?link=${a.json.id}`, { token: other.token })).json.counts.total).toBe(0);
  });
});
