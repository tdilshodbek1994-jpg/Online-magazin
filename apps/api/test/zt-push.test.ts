import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueNotification } from '../src/modules/notifications/service.js';
import { resetFcm } from '../src/modules/notifications/push.js';
import { runJobsOnce } from '../src/worker.js';
import { api, mkPartner, mkUser, setupIsolatedApp, type T } from './helpers.js';

/** Android app push (FCM HTTP v1) — own database, Google is a fake (no network). */
let t: T;
type Call = { url: string; body: any };
let calls: Call[] = [];
let fcm: (c: Call) => { status: number; json: unknown } = () => ({ status: 200, json: { name: 'projects/p/messages/1' } });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FCM_SERVICE_ACCOUNT_B64 = Buffer.from(JSON.stringify({ project_id: 'uzshop-test', client_email: 'push@uzshop-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64');
  resetFcm();
  t = await setupIsolatedApp('om_test_push');
  vi.stubGlobal('fetch', async (url: string, init?: { body?: unknown }) => {
    const raw = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    const c: Call = { url: String(url), body: raw.startsWith('{') ? JSON.parse(raw) : raw };
    calls.push(c);
    const r = c.url.includes('oauth2') ? { status: 200, json: { access_token: 'ya29.test', expires_in: 3600 } } : fcm(c);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
});
afterAll(() => { vi.stubGlobal('fetch', realFetch); delete process.env.FCM_SERVICE_ACCOUNT_B64; resetFcm(); });
beforeEach(() => { calls = []; fcm = () => ({ status: 200, json: { name: 'projects/p/messages/1' } }); });

const sends = () => calls.filter((c) => c.url.includes('fcm.googleapis.com'));
async function notify(userId: string, orderId = '11111111-2222-3333-4444-555555555555') {
  await queueNotification(t.db, { userId, channel: 'telegram', purpose: 'transactional', template: 'partner.order_delivered', locale: 'uz-Latn', params: { order_id: orderId, number: 'OM-***123' }, dedupeKey: `test:${Math.random()}` });
}

describe('push devices and delivery', () => {
  it('partner registers the phone; an event becomes a push with a deep link to the order', async () => {
    const p = await mkPartner(t);
    expect((await api(t, 'POST', '/me/devices', { token: p.token, body: { token: 'fcm-token-aaaaaaaaaaaaaaaaaaaa:1', platform: 'android', app_version: '1.0' } })).status).toBe(200);
    await notify(p.id);
    await runJobsOnce(t.db, 'w');
    expect(calls.some((c) => c.url.includes('oauth2.googleapis.com'))).toBe(true);
    const s = sends();
    expect(s).toHaveLength(1);
    expect(s[0]!.url).toContain('/projects/uzshop-test/messages:send');
    expect(s[0]!.body.message).toMatchObject({ token: 'fcm-token-aaaaaaaaaaaaaaaaaaaa:1', data: { href: '/partner/orders/11111111-2222-3333-4444-555555555555' } });
    expect(s[0]!.body.message.notification.title).toBe('UzShop');
    expect((await t.db.query(`SELECT COUNT(*)::int AS n FROM push_deliveries d JOIN push_devices v ON v.id=d.device_id WHERE v.user_id=$1`, [p.id])).rows[0].n).toBe(1);
    expect((await api(t, 'GET', '/features')).json.push).toBe(true);
  });

  it('FCM says the token is gone → device revoked; later events skip it', async () => {
    const p = await mkPartner(t);
    await api(t, 'POST', '/me/devices', { token: p.token, body: { token: 'fcm-token-bbbbbbbbbbbbbbbbbbbb:1', platform: 'android' } });
    fcm = () => ({ status: 404, json: { error: { status: 'NOT_FOUND' } } });
    await notify(p.id);
    await runJobsOnce(t.db, 'w');
    expect((await t.db.query(`SELECT revoked_at FROM push_devices WHERE token='fcm-token-bbbbbbbbbbbbbbbbbbbb:1'`)).rows[0].revoked_at).not.toBeNull();
    calls = [];
    await notify(p.id);
    await runJobsOnce(t.db, 'w');
    expect(sends()).toHaveLength(0);
  });

  it('FCM 503 on one of two phones: job retries, the phone that already got it is not pushed again', async () => {
    const p = await mkPartner(t);
    await api(t, 'POST', '/me/devices', { token: p.token, body: { token: 'fcm-token-ok-cccccccccccccccc:1', platform: 'android' } });
    await api(t, 'POST', '/me/devices', { token: p.token, body: { token: 'fcm-token-busy-dddddddddddddd:1', platform: 'android' } });
    fcm = (c) => (c.body.message.token.includes('busy') ? { status: 503, json: {} } : { status: 200, json: { name: 'm' } });
    await notify(p.id);
    await runJobsOnce(t.db, 'w');
    const job = (await t.db.query(`SELECT id, status FROM jobs WHERE kind='push.send' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(job.status).toBe('pending');
    calls = [];
    fcm = () => ({ status: 200, json: { name: 'm2' } });
    await t.db.query(`UPDATE jobs SET run_at=now() WHERE id=$1`, [job.id]);
    await runJobsOnce(t.db, 'w');
    expect(sends().map((c) => c.body.message.token)).toEqual(['fcm-token-busy-dddddddddddddd:1']);
  });

  it('logout removes the phone; the same phone logged in by someone else moves to them', async () => {
    const a = await mkPartner(t);
    const b = await mkUser(t, ['operator']);
    const tok = 'fcm-token-shared-eeeeeeeeeeee:1';
    await api(t, 'POST', '/me/devices', { token: a.token, body: { token: tok, platform: 'android' } });
    await api(t, 'POST', '/me/devices', { token: b.token, body: { token: tok, platform: 'android' } });
    expect((await t.db.query(`SELECT user_id FROM push_devices WHERE token=$1`, [tok])).rows[0].user_id).toBe(b.id);
    expect((await api(t, 'POST', '/me/devices/remove', { token: a.token, body: { token: tok } })).json.removed).toBe(0); // not A's any more
    expect((await api(t, 'POST', '/me/devices/remove', { token: b.token, body: { token: tok } })).json.removed).toBe(1);
    await notify(b.id);
    calls = [];
    await runJobsOnce(t.db, 'w');
    expect(sends()).toHaveLength(0);
  });

  it('needs login and a sane token; marketing never goes as push', async () => {
    expect((await api(t, 'POST', '/me/devices', { body: { token: 'fcm-token-ffffffffffffffffffff:1', platform: 'android' } })).status).toBe(401);
    const u = await mkUser(t);
    expect((await api(t, 'POST', '/me/devices', { token: u.token, body: { token: 'bad token with spaces and <script>', platform: 'android' } })).status).toBe(400);
    await queueNotification(t.db, { userId: u.id, channel: 'telegram', purpose: 'marketing', template: 'partner.bonus', locale: 'uz-Latn', params: {}, dedupeKey: `mk:${Math.random()}` });
    expect((await t.db.query(`SELECT COUNT(*)::int AS n FROM jobs WHERE kind='push.send' AND payload->>'id' IN (SELECT id::text FROM notifications WHERE user_id=$1)`, [u.id])).rows[0].n).toBe(0);
  });
});
