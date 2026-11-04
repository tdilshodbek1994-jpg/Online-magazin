import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPartnerWeekly } from '../src/modules/partners/p2.js';
import { mkPartner, mkProduct, nextPhone, placeOrder, setupApp, type T } from './helpers.js';

let t: T;
beforeAll(async () => { t = await setupApp(); });

describe('Partner weekly Telegram digest', () => {
  it('Monday after 09:00 Tashkent only, real numbers, once per week, nothing for a quiet week', async () => {
    const busy = await mkPartner(t);
    const quiet = await mkPartner(t);
    await t.db.query(`INSERT INTO telegram_links (user_id, chat_id) VALUES ($1,$2), ($3,$4)`, [busy.id, Math.floor(Math.random() * 1e9), quiet.id, Math.floor(Math.random() * 1e9) + 1]);
    const prod = await mkProduct(t, { prices: [30_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: busy.code });
    const monday10 = new Date('2026-11-09T05:00:00Z'); // Monday 10:00 Tashkent
    const sunday = new Date('2026-11-08T05:00:00Z');
    const monday8 = new Date('2026-11-09T03:00:00Z'); // 08:00 Tashkent
    expect(await runPartnerWeekly(t.db as any, sunday)).toBe(0);
    expect(await runPartnerWeekly(t.db as any, monday8)).toBe(0);
    await runPartnerWeekly(t.db as any, monday10);
    await runPartnerWeekly(t.db as any, monday10);
    const n = async (uid: string) => (await t.db.query(`SELECT COUNT(*)::int AS n, MAX(params->>'orders') AS orders FROM notifications WHERE template='partner.weekly' AND user_id=$1`, [uid])).rows[0];
    expect(await n(busy.id)).toEqual({ n: 1, orders: '1' });
    expect((await n(quiet.id)).n).toBe(0);
  });
});
