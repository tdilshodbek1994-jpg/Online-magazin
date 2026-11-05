import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSmsToken } from '../src/modules/notifications/sms.js';
import { runJobsOnce } from '../src/worker.js';
import { api, nextPhone, setupIsolatedApp, type T } from './helpers.js';

/** Eskiz SMS for login codes — own database, Eskiz is a fake (no network). */
let t: T;
type Call = { url: string; body: any; auth?: string };
let calls: Call[] = [];
let script: ((c: Call) => { status: number; json: unknown }) | null = null;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await setupIsolatedApp('om_test_sms');
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const c: Call = { url: String(url), body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.authorization };
    calls.push(c);
    const r = script ? script(c) : { status: 500, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
});
afterAll(() => { vi.stubGlobal('fetch', realFetch); delete process.env.ESKIZ_EMAIL; delete process.env.ESKIZ_PASSWORD; delete process.env.SMS_OTP_TEXT; });
beforeEach(() => {
  calls = []; resetSmsToken();
  process.env.ESKIZ_EMAIL = 'owner@example.uz'; process.env.ESKIZ_PASSWORD = 'secret-pass';
  process.env.SMS_OTP_TEXT = 'UzShop kodi: {code}';
});
const okEskiz = (c: Call) => c.url.endsWith('/auth/login') ? { status: 200, json: { data: { token: 'tok1' } } } : { status: 200, json: { id: 'm-1', status: 'waiting' } };

async function requestOtp() {
  const phone = nextPhone();
  const r = await api(t, 'POST', '/auth/otp/request', { body: { phone } });
  expect(r.status).toBe(200);
  return { phone, challenge: r.json.challenge_id as string, code: r.json.dev_code as string };
}
const notif = async (challenge: string) => (await t.db.query(`SELECT status, provider_ref, params FROM notifications WHERE dedupe_key=$1`, [`otp:${challenge}`])).rows[0];

describe('Eskiz SMS for OTP', () => {
  it('sends the approved text with the code, then wipes the encrypted code from the row', async () => {
    script = okEskiz;
    const o = await requestOtp();
    const before = await notif(o.challenge);
    expect(before.params.code_enc).toBeTruthy();
    expect(JSON.stringify(before.params)).not.toContain(o.code); // only encrypted in the DB
    await runJobsOnce(t.db, 'w1');
    const send = calls.find((c) => c.url.endsWith('/message/sms/send'))!;
    expect(send.body).toMatchObject({ mobile_phone: o.phone.replace('+', ''), message: `UzShop kodi: ${o.code}`, from: '4546' });
    expect(send.auth).toBe('Bearer tok1');
    const after = await notif(o.challenge);
    expect(after).toMatchObject({ status: 'sent', provider_ref: 'eskiz:m-1' });
    expect(after.params.code_enc).toBeUndefined();
  });

  it('expired Eskiz token: logs in again once and sends', async () => {
    let sends = 0;
    script = (c) => {
      if (c.url.endsWith('/auth/login')) return { status: 200, json: { data: { token: `tok${calls.filter((x) => x.url.endsWith('/auth/login')).length}` } } };
      sends++;
      return sends === 1 ? { status: 401, json: { message: 'Expired' } } : { status: 200, json: { id: 'm-2' } };
    };
    const o = await requestOtp();
    await runJobsOnce(t.db, 'w1');
    expect(calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(2);
    expect((await notif(o.challenge)).status).toBe('sent');
  });

  it('rejected text (4xx) → failed, code wiped, no endless retries; 5xx → job retries later', async () => {
    script = (c) => c.url.endsWith('/auth/login') ? { status: 200, json: { data: { token: 't' } } } : { status: 400, json: { message: 'Bu SMS matni moderatsiyadan o‘tmagan' } };
    const a = await requestOtp();
    await runJobsOnce(t.db, 'w1');
    const na = await notif(a.challenge);
    expect(na.status).toBe('failed');
    expect(na.provider_ref).toMatch(/eskiz 400/);
    expect(na.params.code_enc).toBeUndefined();

    script = (c) => c.url.endsWith('/auth/login') ? { status: 200, json: { data: { token: 't' } } } : { status: 503, json: {} };
    const b = await requestOtp();
    await runJobsOnce(t.db, 'w1');
    expect((await notif(b.challenge)).status).toBe('queued');
    const job = (await t.db.query(`SELECT status, last_error FROM jobs WHERE dedupe_key = (SELECT 'notif:' || id FROM notifications WHERE dedupe_key=$1)`, [`otp:${b.challenge}`])).rows[0];
    expect(job.status).toBe('pending');
    expect(job.last_error).toMatch(/503/);
  });

  it('not configured: nothing is sent, row says dev_log_only and holds no code', async () => {
    delete process.env.ESKIZ_EMAIL;
    script = okEskiz;
    const o = await requestOtp();
    await runJobsOnce(t.db, 'w1');
    expect(calls).toHaveLength(0);
    const n = await notif(o.challenge);
    expect(n).toMatchObject({ status: 'suppressed', provider_ref: 'dev_log_only' });
    expect(n.params.code_enc).toBeUndefined();
  });

  it('a code older than 10 minutes is never sent', async () => {
    script = okEskiz;
    const o = await requestOtp();
    await t.db.query(`UPDATE notifications SET created_at = now() - interval '11 minutes' WHERE dedupe_key=$1`, [`otp:${o.challenge}`]);
    await runJobsOnce(t.db, 'w1');
    expect(calls.filter((c) => c.url.endsWith('/message/sms/send'))).toHaveLength(0);
    expect(await notif(o.challenge)).toMatchObject({ status: 'suppressed', provider_ref: 'otp_expired_before_send' });
  });
});
