import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateCookieValid, verifyInitData } from '../src/modules/tgapp/routes.js';
import { api, mkPartner, mkUser, setupIsolatedApp, type T } from './helpers.js';

/** Telegram Mini App (partner bot) — own database. Uses a fake bot token; no network. */
const BOT = '123456789:TEST_partner_bot_token_aaaaaaaaaaaaaaaaa';
const OTHER_BOT = '987654321:TEST_other_bot_token_bbbbbbbbbbbbbbbbbbbbb';
const GATE = 'g'.repeat(40);

function initData(user: Record<string, unknown>, o: { token?: string; authDate?: number; startParam?: string; tamper?: boolean } = {}): string {
  const p = new URLSearchParams();
  p.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc');
  p.set('user', JSON.stringify(user));
  p.set('auth_date', String(o.authDate ?? Math.floor(Date.now() / 1000)));
  if (o.startParam) p.set('start_param', o.startParam);
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(o.token ?? BOT).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  if (o.tamper) p.set('user', JSON.stringify({ ...user, id: 777 }));
  return p.toString();
}

let t: T;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ['TELEGRAM_PARTNER_BOT_TOKEN', 'TELEGRAM_PARTNER_BOT_USERNAME', 'TELEGRAM_PARTNER_BOT_WEBHOOK_SECRET', 'OM_STAGE_GATE_SECRET']) saved[k] = process.env[k];
  process.env.TELEGRAM_PARTNER_BOT_TOKEN = BOT;
  process.env.TELEGRAM_PARTNER_BOT_USERNAME = 'Uzshop_admin_test_bot';
  process.env.OM_STAGE_GATE_SECRET = GATE;
  t = await setupIsolatedApp('om_test_tgapp');
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe('initData validation (unit)', () => {
  const u = { id: 5001, first_name: 'Ali' };
  it('accepts a correctly signed, fresh payload', () => {
    const r = verifyInitData(initData(u, { startParam: 'orders' }), BOT, 86400);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.user.id).toBe(5001); expect(r.startParam).toBe('orders'); }
  });
  it('rejects tampered data, another bot\'s signature, stale and future dates, missing hash', () => {
    expect(verifyInitData(initData(u, { tamper: true }), BOT, 86400)).toMatchObject({ ok: false, reason: 'bad_hash' });
    expect(verifyInitData(initData(u, { token: OTHER_BOT }), BOT, 86400)).toMatchObject({ ok: false, reason: 'bad_hash' });
    expect(verifyInitData(initData(u, { authDate: Math.floor(Date.now() / 1000) - 90_000 }), BOT, 86400)).toMatchObject({ ok: false, reason: 'expired' });
    expect(verifyInitData(initData(u, { authDate: Math.floor(Date.now() / 1000) + 3600 }), BOT, 86400)).toMatchObject({ ok: false, reason: 'future' });
    expect(verifyInitData('user=%7B%22id%22%3A1%7D&auth_date=1', BOT, 86400)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('mini app login and linking', () => {
  it('unlinked Telegram user gets no session and no gate cookie', async () => {
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 6001, first_name: 'Vali' }) } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ linked: false, first_name: 'Vali' });
    expect(r.json.token).toBeUndefined();
    expect(r.raw.headers['set-cookie']).toBeUndefined();
  });

  it('forged or other-bot initData is refused with 401; operator bot not configured → 503', async () => {
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 6002 }, { tamper: true }) } })).status).toBe(401);
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 6002 }, { token: OTHER_BOT }) } })).status).toBe(401);
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'operator', init_data: initData({ id: 6002 }) } })).status).toBe(503);
    // Identity can never be passed as a field.
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 6002 }), user_id: 'x' } })).status).toBe(400);
  });

  it('logged-in partner links inside the mini app; next open logs straight in with a session for the same account', async () => {
    const p = await mkPartner(t);
    const tg = { id: 7001, first_name: 'Hamkor', username: 'hamkor_tg' };
    const l = await api(t, 'POST', '/me/telegram/apps/link', { token: p.token, body: { app: 'partner', init_data: initData(tg) } });
    expect(l.status).toBe(200);
    expect(String(l.raw.headers['set-cookie'])).toMatch(/^om_stage=\d+\.[\w-]{43}; Path=\/;.*HttpOnly; SameSite=None/);
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData(tg) } });
    expect(r.json).toMatchObject({ linked: true, user_id: p.id, home: '/partner' });
    const me = await api(t, 'GET', '/partner/me', { token: r.json.token });
    expect(me.status).toBe(200);
    expect(me.json.id ?? me.json.partner?.id).toBeTruthy();
    const s = await t.db.query(`SELECT phone_at_issue, user_agent FROM sessions WHERE id=$1`, [r.json.session_id]);
    expect(s.rows[0].phone_at_issue).toBe(p.phone);
    expect(s.rows[0].user_agent).toMatch(/^telegram-partner-app/);
    const list = await api(t, 'GET', '/me/telegram/apps', { token: p.token });
    expect(list.json.items.find((i: any) => i.app === 'partner')).toMatchObject({ linked: true, tg_username: 'hamkor_tg', configured: true });
    const audits = await t.db.query(`SELECT action FROM audit_events WHERE target_id=$1 AND action IN ('telegram_app.linked','user.login')`, [p.id]);
    expect(audits.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['telegram_app.linked', 'user.login']));
  });

  it('a Telegram already tied to account A cannot be taken by account B', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const tg = { id: 7002, first_name: 'A' };
    expect((await api(t, 'POST', '/me/telegram/apps/link', { token: a.token, body: { app: 'partner', init_data: initData(tg) } })).status).toBe(200);
    const steal = await api(t, 'POST', '/me/telegram/apps/link', { token: b.token, body: { app: 'partner', init_data: initData(tg) } });
    expect(steal.status).toBe(409);
    expect(steal.json.code).toBe('TG_LINKED_TO_OTHER_ACCOUNT');
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData(tg) } });
    expect(r.json.user_id).toBe(a.id);
  });

  it('one-time link token from the website: opens linked once; reuse and expiry do nothing', async () => {
    const p = await mkPartner(t);
    const lt = await api(t, 'POST', '/me/telegram/apps/link-token', { token: p.token, body: { app: 'partner' } });
    expect(lt.json).toMatchObject({ configured: true, expires_in_seconds: 600 });
    const m = /^https:\/\/t\.me\/Uzshop_admin_test_bot\?startapp=(l_[\w-]+)$/.exec(lt.json.url);
    expect(m).toBeTruthy();
    const tg = { id: 7003, first_name: 'Link' };
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData(tg, { startParam: m![1] }) } });
    expect(r.json).toMatchObject({ linked: true, linked_now: true, user_id: p.id });
    // Same token from another Telegram account: already consumed → not linked.
    const again = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 7004 }, { startParam: m![1] }) } });
    expect(again.json).toMatchObject({ linked: false, link_token_rejected: true });
    // Expired token.
    const lt2 = await api(t, 'POST', '/me/telegram/apps/link-token', { token: p.token, body: { app: 'partner' } });
    await t.db.query(`UPDATE tg_app_link_tokens SET expires_at=now() - interval '1 second' WHERE consumed_at IS NULL AND user_id=$1`, [p.id]);
    const exp = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData({ id: 7005 }, { startParam: /startapp=(l_[\w-]+)/.exec(lt2.json.url)![1] }) } });
    expect(exp.json.linked).toBe(false);
  });

  it('unlink: the next open asks to link again; locked account gets no session', async () => {
    const p = await mkPartner(t);
    const tg = { id: 7006 };
    await api(t, 'POST', '/me/telegram/apps/link', { token: p.token, body: { app: 'partner', init_data: initData(tg) } });
    expect((await api(t, 'DELETE', '/me/telegram/apps/partner', { token: p.token })).json.removed).toBe(1);
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData(tg) } })).json.linked).toBe(false);
    await api(t, 'POST', '/me/telegram/apps/link', { token: p.token, body: { app: 'partner', init_data: initData(tg) } });
    await t.db.query(`UPDATE users SET status='locked' WHERE id=$1`, [p.id]);
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'partner', init_data: initData(tg) } })).status).toBe(403);
  });

  it('link requires a logged-in user; link-token reports not configured when the bot env is missing', async () => {
    expect((await api(t, 'POST', '/me/telegram/apps/link', { body: { app: 'partner', init_data: initData({ id: 7007 }) } })).status).toBe(401);
    const op = await mkUser(t, ['operator']);
    const r = await api(t, 'POST', '/me/telegram/apps/link-token', { token: op.token, body: { app: 'operator' } });
    expect(r.json).toMatchObject({ configured: false, url: null });
  });
});

describe('operator bot (Uzshop_operator)', () => {
  const OP_BOT = '555666777:TEST_operator_bot_token_ccccccccccccccccc';
  beforeAll(() => { process.env.TELEGRAM_OPERATOR_BOT_TOKEN = OP_BOT; process.env.TELEGRAM_OPERATOR_BOT_USERNAME = 'Uzshop_operator_test_bot'; });
  afterAll(() => { delete process.env.TELEGRAM_OPERATOR_BOT_TOKEN; delete process.env.TELEGRAM_OPERATOR_BOT_USERNAME; });

  it('operator links and logs in; the session opens the operator queues', async () => {
    const op = await mkUser(t, ['operator']);
    const tg = { id: 9001, first_name: 'Operator' };
    expect((await api(t, 'POST', '/me/telegram/apps/link', { token: op.token, body: { app: 'operator', init_data: initData(tg, { token: OP_BOT }) } })).status).toBe(200);
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'operator', init_data: initData(tg, { token: OP_BOT }) } });
    expect(r.json).toMatchObject({ linked: true, user_id: op.id, home: '/ops' });
    expect((await api(t, 'GET', '/ops/queues', { token: r.json.token })).status).toBe(200);
  });

  it('a customer or partner cannot link the operator bot; partner-bot data is not accepted by the operator bot', async () => {
    const c = await mkUser(t);
    const p = await mkPartner(t);
    expect((await api(t, 'POST', '/me/telegram/apps/link', { token: c.token, body: { app: 'operator', init_data: initData({ id: 9002 }, { token: OP_BOT }) } })).json.code).toBe('TG_APP_ROLE_REQUIRED');
    expect((await api(t, 'POST', '/me/telegram/apps/link-token', { token: p.token, body: { app: 'operator' } })).status).toBe(403);
    expect((await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'operator', init_data: initData({ id: 9003 }) } })).status).toBe(401); // signed by the partner bot
  });

  it('operator removed from staff: the old link no longer opens the operator room', async () => {
    const op = await mkUser(t, ['operator']);
    const tg = { id: 9004 };
    await api(t, 'POST', '/me/telegram/apps/link', { token: op.token, body: { app: 'operator', init_data: initData(tg, { token: OP_BOT }) } });
    await t.db.query(`UPDATE memberships SET revoked_at=now() WHERE user_id=$1 AND role_code='operator'`, [op.id]);
    const r = await api(t, 'POST', '/auth/telegram/webapp', { body: { app: 'operator', init_data: initData(tg, { token: OP_BOT }) } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('TG_APP_ROLE_REQUIRED');
  });

  it('the same Telegram can be in both bots for one person (partner and operator are separate links)', async () => {
    const op = await mkUser(t, ['operator', 'partner']);
    const tg = { id: 9005 };
    expect((await api(t, 'POST', '/me/telegram/apps/link', { token: op.token, body: { app: 'operator', init_data: initData(tg, { token: OP_BOT }) } })).status).toBe(200);
    expect((await api(t, 'POST', '/me/telegram/apps/link', { token: op.token, body: { app: 'partner', init_data: initData(tg) } })).status).toBe(200);
    const list = await api(t, 'GET', '/me/telegram/apps', { token: op.token });
    expect(list.json.items.filter((i: any) => i.linked).map((i: any) => i.app).sort()).toEqual(['operator', 'partner']);
  });
});

describe('staging gate cookie and bot webhook', () => {
  it('stage-gate accepts only a valid signed cookie', async () => {
    const p = await mkPartner(t);
    const l = await api(t, 'POST', '/me/telegram/apps/link', { token: p.token, body: { app: 'partner', init_data: initData({ id: 8001 }) } });
    const cookie = String(l.raw.headers['set-cookie']).split(';')[0]!;
    expect(gateCookieValid(cookie.split('=')[1])).toBe(true);
    expect((await api(t, 'GET', '/stage-gate', { headers: { cookie: `a=b; ${cookie}` } })).status).toBe(200);
    expect((await api(t, 'GET', '/stage-gate', { headers: { cookie: 'om_stage=' } })).status).toBe(401);
    expect((await api(t, 'GET', '/stage-gate', { headers: { cookie: `om_stage=9999999999.${'A'.repeat(43)}` } })).status).toBe(401);
    expect((await api(t, 'GET', '/stage-gate')).status).toBe(401);
  });

  it('webhook needs its own secret header', async () => {
    process.env.TELEGRAM_PARTNER_BOT_WEBHOOK_SECRET = 's'.repeat(32);
    expect((await api(t, 'POST', '/webhooks/telegram/app/partner', { body: { message: { text: '/start', chat: { id: 1, type: 'group' } } } })).status).toBe(403);
    expect((await api(t, 'POST', '/webhooks/telegram/app/partner', { headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(32) }, body: { message: { text: 'hi', chat: { id: 1, type: 'group' } } } })).status).toBe(200);
    expect((await api(t, 'POST', '/webhooks/telegram/app/nope', { body: {} })).status).toBe(404);
  });
});
