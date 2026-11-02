import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});
const guestTok = () => randomUUID() + randomUUID();

describe('Partner cabinet v2', () => {
  it('market shows payout per unit, stock and my stream; streams/stats/requests/dashboard reflect a delivered referral order', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [200_000], stock: [10], rule: { kind: 'percent', bps: 1500 } });

    const market = await api(t, 'GET', '/partner/market?sort=payout', { token: partner.token });
    expect(market.status).toBe(200);
    const item = market.json.items.find((i: any) => i.id === prod.productId);
    expect(item).toMatchObject({ price_minor: '20000000', payout_minor: '3000000', stock: 10, my_stream: null });

    const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'Telegram kanal' } });
    expect(st.status).toBe(200);
    expect(st.json.url).toMatch(/\/r\/[A-Za-z0-9]{8,16}$/);

    const guest = guestTok();
    expect((await api(t, 'POST', '/referrals/touch', { guest, body: { code: st.json.code } })).json.attributed).toBe(true);
    const c = await mkUser(t);
    const ord = await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    expect(ord.status).toBe(201);

    let streams = await api(t, 'GET', '/partner/streams', { token: partner.token });
    let s1 = streams.json.items.find((x: any) => x.id === st.json.id);
    expect(s1).toMatchObject({ name: 'Telegram kanal', clicks: 1, pending_minor: '6000000', earned_minor: '0' });
    expect(s1.orders).toMatchObject({ total: 1, accepted: 1, delivered: 0 }); // verified-phone customer → auto-confirmed

    await fulfilCod(t, s, ord.json.order_id);
    streams = await api(t, 'GET', '/partner/streams', { token: partner.token });
    s1 = streams.json.items.find((x: any) => x.id === st.json.id);
    expect(s1.orders).toMatchObject({ total: 1, delivered: 1 });

    const req = await api(t, 'GET', '/partner/requests?status=delivered', { token: partner.token });
    expect(req.status).toBe(200);
    expect(req.json.counts).toMatchObject({ delivered: 1, total: 1 });
    expect(req.json.items).toHaveLength(1);
    const r0 = req.json.items[0];
    expect(r0.stream_name).toBe('Telegram kanal');
    expect(r0.customer).toMatch(/^.\*\*\*$/); // masked name only (T004)
    expect(r0.customer_phone).toMatch(/^\+998 \*\* \*\*\* \*\* \d{2}$/);
    expect(JSON.stringify(req.json)).not.toContain(c.phone);

    const stats = await api(t, 'GET', '/partner/stats?group=stream&period=all', { token: partner.token });
    expect(stats.json.items.find((x: any) => x.key === st.json.id)).toMatchObject({ label: 'Telegram kanal', clicks: 1, delivery_rate_pct: 100 });
    const byDay = await api(t, 'GET', '/partner/stats?group=day&period=all', { token: partner.token });
    expect(byDay.json.items[0].orders.total).toBeGreaterThanOrEqual(1);

    const dash = await api(t, 'GET', '/partner/dashboard?period=all', { token: partner.token });
    expect(dash.status).toBe(200);
    expect(dash.json).toMatchObject({ clicks: 1, delivery_rate_30d: 100 });
    expect(dash.json.orders).toMatchObject({ delivered: 1, total: 1 });
    expect(dash.json.month_rank.rank).toBeGreaterThanOrEqual(1);

    const top = await api(t, 'GET', '/partner/leaderboard', { token: partner.token });
    expect(top.json.items.some((x: any) => x.me)).toBe(true);

    const market2 = await api(t, 'GET', '/partner/market', { token: partner.token });
    expect(market2.json.items.find((i: any) => i.id === prod.productId).my_stream.id).toBe(st.json.id);
  });

  it('another partner cannot see or archive my streams/requests; archived stream disappears', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [3], rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
    const st = await api(t, 'POST', '/partner/streams', { token: a.token, body: { product_id: prod.productId, name: 'Instagram' } });
    expect((await api(t, 'DELETE', `/partner/streams/${st.json.id}`, { token: b.token })).status).toBe(404);
    expect((await api(t, 'GET', '/partner/streams', { token: b.token })).json.items.some((x: any) => x.id === st.json.id)).toBe(false);
    expect((await api(t, 'GET', '/partner/market', { token: a.token })).json.items.find((i: any) => i.id === prod.productId).payout_minor).toBe('1000000');
    expect((await api(t, 'DELETE', `/partner/streams/${st.json.id}`, { token: a.token })).status).toBe(200);
    expect((await api(t, 'GET', '/partner/streams', { token: a.token })).json.items.some((x: any) => x.id === st.json.id)).toBe(false);
  });

  it('customers (non-partners) get PARTNER_NOT_FOUND', async () => {
    const c = await mkUser(t);
    const r = await api(t, 'GET', '/partner/dashboard', { token: c.token });
    expect(r.status).toBe(404);
  });
});
