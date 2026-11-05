import { beforeAll, describe, expect, it } from 'vitest';
import { runP2Scheduled } from '../src/modules/partners/p2.js';
import { api, mkProduct, nextPhone, setupApp, type T } from './helpers.js';

let t: T;
beforeAll(async () => { t = await setupApp(); });

describe('Price watch ("Narxi tushsa xabar bering")', () => {
  it('needs consent, sends exactly one SMS when the price really drops, nothing when it rises', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const phone = nextPhone();
    expect((await api(t, 'POST', '/price-watch', { body: { product_id: prod.productId, phone } })).status).toBe(400); // no consent
    const ok = await api(t, 'POST', '/price-watch', { body: { product_id: prod.productId, phone, consent: true } });
    expect(ok.json.price_minor_at).toBe('10000000');
    const sms = async () => (await t.db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE template='price_watch.dropped' AND phone_e164=$1`, [phone])).rows[0].n;
    await t.db.query(`UPDATE offers SET price_minor = 12000000 WHERE sku_id=$1`, [prod.skuIds[0]]);
    await runP2Scheduled(t.db as any);
    expect(await sms()).toBe(0);
    await t.db.query(`UPDATE offers SET price_minor = 8000000 WHERE sku_id=$1`, [prod.skuIds[0]]);
    await runP2Scheduled(t.db as any);
    await runP2Scheduled(t.db as any);
    expect(await sms()).toBe(1);
    expect((await t.db.query(`SELECT status, notified_price_minor::text FROM price_watch WHERE product_id=$1`, [prod.productId])).rows[0]).toEqual({ status: 'notified', notified_price_minor: '8000000' });
  });
});
