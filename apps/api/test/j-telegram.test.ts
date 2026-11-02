import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { runJobsOnce } from '../src/worker.js';
import { api, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

async function referralOrder(partner: { token: string }, productId: string, skuId: string) {
  const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: productId, name: 'Kanal' } });
  const guest = randomUUID() + randomUUID();
  await api(t, 'POST', '/referrals/touch', { guest, body: { code: st.json.code } });
  const c = await mkUser(t);
  const o = await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: skuId, qty: 1 }]);
  return { orderId: o.json.order_id as string, customerPhone: c.phone };
}
const notes = async (userId: string) => (await t.db.query(`SELECT template, channel, status, provider_ref, params FROM notifications WHERE user_id=$1 ORDER BY created_at, id`, [userId])).rows;

describe('Partner notifications (Telegram + cabinet list)', () => {
  it('new order → delivered → commission available; cabinet list shows texts without customer data', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [200_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const { orderId, customerPhone } = await referralOrder(partner, prod.productId, prod.skuIds[0]!);
    expect((await notes(partner.id)).map((n) => n.template)).toEqual(['partner.order_new']);
    await fulfilCod(t, s, orderId);
    await withTx(t.db, (tx) => releaseMatured(tx, new Date(Date.now() + 40 * 86400_000)));
    const all = await notes(partner.id);
    expect(all.map((n) => n.template)).toEqual(['partner.order_new', 'partner.order_delivered', 'partner.commission_available']);
    expect(all.every((n) => n.channel === 'telegram')).toBe(true);
    expect(all[1]!.params.amount_minor).toBe('2000000');

    const list = await api(t, 'GET', '/me/notifications', { token: partner.token });
    expect(list.status).toBe(200);
    expect(list.json.items[0].text).toContain('Hisobingizga 20 000 so‘m o‘tdi');
    expect(list.json.items[2].text).toMatch(/Yangi buyurtma OM-\*\*\*\d{3}/);
    expect(JSON.stringify(list.json)).not.toContain(customerPhone);
  });

  it('cancelled order notifies once', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [5], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const { orderId } = await referralOrder(partner, prod.productId, prod.skuIds[0]!);
    await api(t, 'POST', `/ops/orders/${orderId}/claim`, { token: s.operator.token });
    const r = await api(t, 'POST', `/ops/orders/${orderId}/cancel`, { token: s.operator.token, body: { reason: 'customer_request', note: 'mijoz rad etdi' } });
    expect(r.status).toBe(200);
    expect((await notes(partner.id)).filter((n) => n.template === 'partner.order_cancelled')).toHaveLength(1);
  });

  it('worker sends through the Bot API to the linked chat; no link → suppressed; blocked bot → failed (no endless retry)', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz';
    const calls: any[] = [];
    let mode: 'ok' | 'blocked' = 'ok';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(mode === 'ok' ? { ok: true, result: { message_id: 77 } } : { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: mode === 'ok' ? 200 : 403 });
    }));
    const chatId = 600000000 + Math.floor(Math.random() * 99_999_999);
    const linked = await mkPartner(t);
    const unlinked = await mkPartner(t);
    await t.db.query(`INSERT INTO telegram_links (user_id, chat_id) VALUES ($1, $2)`, [linked.id, chatId]);
    const prod = await mkProduct(t, { prices: [10_000], stock: [9], rule: { kind: 'percent', bps: 500 } });
    await referralOrder(linked, prod.productId, prod.skuIds[0]!);
    await referralOrder(unlinked, prod.productId, prod.skuIds[0]!);
    while ((await runJobsOnce(t.db, 'w-test', 200)) > 0) { /* drain */ }
    const sent = await notes(linked.id);
    expect(sent[0]).toMatchObject({ status: 'sent', provider_ref: 'tg:77' });
    const call = calls.find((c) => String(c.body.chat_id) === String(chatId));
    expect(call.url).toContain('/bot123456:TEST_TOKEN');
    expect(call.body.text).toContain('Yangi buyurtma');
    expect((await notes(unlinked.id))[0]).toMatchObject({ status: 'suppressed', provider_ref: 'no_telegram_link' });

    mode = 'blocked';
    await referralOrder(linked, prod.productId, prod.skuIds[0]!);
    while ((await runJobsOnce(t.db, 'w-test', 200)) > 0) { /* drain */ }
    const last = (await notes(linked.id)).at(-1)!;
    expect(last.status).toBe('failed');
  });

  it('linking: one-time token via webhook with secret header; status and unlink', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz';
    process.env.TELEGRAM_BOT_USERNAME = 'uzshop_test_bot';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'whsecret_1234567890';
    const p = await mkPartner(t);
    const chat = 700000000 + Math.floor(Math.random() * 99_999_999);
    expect((await api(t, 'GET', '/me/telegram', { token: p.token })).json).toMatchObject({ linked: false, bot_configured: true });
    const tok = await api(t, 'POST', '/me/telegram/link-token', { token: p.token });
    expect(tok.json.deep_link).toBe(`https://t.me/uzshop_test_bot?start=${tok.json.token}`);
    const bad = await api(t, 'POST', '/webhooks/telegram', { headers: { 'x-telegram-bot-api-secret-token': 'wrong_secret_value_x' }, body: { message: { text: `/start ${tok.json.token}`, chat: { id: chat } } } });
    expect(bad.status).toBe(403);
    const ok = await api(t, 'POST', '/webhooks/telegram', { headers: { 'x-telegram-bot-api-secret-token': 'whsecret_1234567890' }, body: { message: { text: `/start ${tok.json.token}`, chat: { id: chat } } } });
    expect(ok.json.linked).toBe(true);
    expect((await api(t, 'GET', '/me/telegram', { token: p.token })).json.linked).toBe(true);
    expect((await notes(p.id)).some((n) => n.template === 'telegram.linked')).toBe(true);
    const reuse = await api(t, 'POST', '/webhooks/telegram', { headers: { 'x-telegram-bot-api-secret-token': 'whsecret_1234567890' }, body: { message: { text: `/start ${tok.json.token}`, chat: { id: chat + 1 } } } });
    expect(reuse.json.linked).toBe(false);
    expect((await api(t, 'DELETE', '/me/telegram', { token: p.token })).status).toBe(200);
    expect((await api(t, 'GET', '/me/telegram', { token: p.token })).json.linked).toBe(false);
  });
});
