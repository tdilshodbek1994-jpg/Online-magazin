import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { newToken } from '../src/platform/auth.js';
import { api, fulfilCod, mkProduct, mkUser, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** Final release PR-02 — customer self-service (own database). */
let t: T;
let s: Staff;
let prod: Awaited<ReturnType<typeof mkProduct>>;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_selfservice');
  s = await staff(t);
  prod = await mkProduct(t, { prices: [100_000], stock: [10] });
});
async function myOrder() {
  const c = await mkUser(t);
  const o = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
  expect(o.status).toBe(201);
  return { c, orderId: o.json.order_id as string };
}

describe('minimal order-status link (M08)', () => {
  it('owner creates a link; public view shows stages only; other users get 404; revoke closes it', async () => {
    const { c, orderId } = await myOrder();
    const l = await api(t, 'POST', `/me/orders/${orderId}/status-link`, { token: c.token });
    expect(l.status).toBe(200);
    const token = l.json.path.split('/').pop();
    const pub = await api(t, 'GET', `/order-status/${token}`);
    expect(pub.status).toBe(200);
    expect(['received', 'confirmed']).toContain(pub.json.stage.key);
    expect(pub.json.number).toMatch(/^OM-\*\*\*\d{3}$/);
    const body = JSON.stringify(pub.json);
    expect(body).not.toContain(c.phone.slice(-7));
    expect(body).not.toMatch(/payable|address|amount/);
    expect(pub.raw.headers['cache-control']).toBe('no-store');
    const other = await mkUser(t);
    expect((await api(t, 'POST', `/me/orders/${orderId}/status-link`, { token: other.token })).status).toBe(404);
    expect((await api(t, 'GET', `/order-status/${'x'.repeat(32)}`)).status).toBe(404);
    expect((await api(t, 'DELETE', `/me/orders/${orderId}/status-links`, { token: c.token })).json.revoked).toBe(1);
    expect((await api(t, 'GET', `/order-status/${token}`)).status).toBe(404);
  });
});

describe('customer self-cancel (M09)', () => {
  it('before picking: cancelled and stock released; after shipping: refused; foreign order: 404', async () => {
    const { c, orderId } = await myOrder();
    expect((await api(t, 'POST', `/me/orders/${orderId}/cancel`, { token: (await mkUser(t)).token, body: { reason: 'boshqa odam' } })).status).toBe(404);
    const r = await api(t, 'POST', `/me/orders/${orderId}/cancel`, { token: c.token, body: { reason: 'fikrimdan qaytdim' } });
    expect(r.status).toBe(200);
    const o = (await t.db.query(`SELECT commercial_status, cancel_reason FROM orders WHERE id=$1`, [orderId])).rows[0];
    expect(o).toMatchObject({ commercial_status: 'cancelled', cancel_reason: 'customer: fikrimdan qaytdim' });
    expect((await t.db.query(`SELECT COUNT(*)::int AS n FROM reservations WHERE order_id=$1 AND status='active'`, [orderId])).rows[0].n).toBe(0);
    const second = await myOrder();
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [second.orderId])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${second.orderId}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${second.orderId}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    await fulfilCod(t, s, second.orderId);
    const late = await api(t, 'POST', `/me/orders/${second.orderId}/cancel`, { token: second.c.token, body: { reason: 'kech qoldi' } });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('ORDER_ALREADY_IN_FULFILMENT');
  });
});

describe('phone change with both phones (M05)', () => {
  it('needs codes from the current and the new phone; other sessions signed out; history kept', async () => {
    const u = await mkUser(t);
    const { token: t2, hash } = newToken();
    await t.db.query(`INSERT INTO sessions (user_id, token_hash, phone_at_issue, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [u.id, hash, u.phone]);
    const taken = await mkUser(t);
    expect((await api(t, 'POST', '/me/phone/change', { token: u.token, body: { new_phone: taken.phone } })).json.code).toBe('PHONE_IN_USE');
    const next = nextPhone();
    const start = await api(t, 'POST', '/me/phone/change', { token: u.token, body: { new_phone: next } });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const { current, new: nw } = start.json;
    const wrong = await api(t, 'POST', '/me/phone/change/confirm', { token: u.token, body: { current_challenge_id: current.challenge_id, current_code: '000000' === current.dev_code ? '111111' : '000000', new_challenge_id: nw.challenge_id, new_code: nw.dev_code } });
    expect(wrong.status).toBe(400);
    // knowing only the new phone code is not enough; a challenge of another user cannot be used
    const other = await mkUser(t);
    expect((await api(t, 'POST', '/me/phone/change/confirm', { token: other.token, body: { current_challenge_id: current.challenge_id, current_code: current.dev_code, new_challenge_id: nw.challenge_id, new_code: nw.dev_code } })).status).toBe(400);
    const ok = await api(t, 'POST', '/me/phone/change/confirm', { token: u.token, body: { current_challenge_id: current.challenge_id, current_code: current.dev_code, new_challenge_id: nw.challenge_id, new_code: nw.dev_code } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await t.db.query(`SELECT phone_e164 FROM users WHERE id=$1`, [u.id])).rows[0].phone_e164).toBe(next);
    expect((await t.db.query(`SELECT method, old_phone FROM phone_history WHERE user_id=$1 ORDER BY changed_at DESC LIMIT 1`, [u.id])).rows[0]).toEqual({ method: 'otp_both', old_phone: u.phone });
    expect(ok.json.relogin).toBe(true);
    expect((await api(t, 'GET', '/me/orders', { token: t2 })).status).toBe(401); // every old-phone session ends
    expect((await api(t, 'GET', '/me/orders', { token: u.token })).status).toBe(401);
    // codes are single use (and the old session is gone anyway)
    expect((await api(t, 'POST', '/me/phone/change/confirm', { token: u.token, body: { current_challenge_id: current.challenge_id, current_code: current.dev_code, new_challenge_id: nw.challenge_id, new_code: nw.dev_code } })).status).toBe(401);
  });
  it('owner/finance must be freshly re-authenticated', async () => {
    const own = await mkUser(t, ['owner'], nextPhone(), false);
    expect((await api(t, 'POST', '/me/phone/change', { token: own.token, body: { new_phone: nextPhone() } })).json.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('data requests (M34)', () => {
  it('customer files one open request per kind; only staff.manage + step-up records the decision', async () => {
    const u = await mkUser(t);
    const r = await api(t, 'POST', '/me/data-requests', { token: u.token, body: { kind: 'delete', note: 'hisobni yoping' } });
    expect(r.status).toBe(200);
    expect(r.json.note).toContain('Qonun bo‘yicha');
    expect((await api(t, 'POST', '/me/data-requests', { token: u.token, body: { kind: 'delete' } })).status).toBe(409);
    expect((await api(t, 'GET', '/admin/data-requests', { token: s.operator.token })).status).toBe(403);
    const list = await api(t, 'GET', '/admin/data-requests', { token: s.owner.token });
    expect(list.json.items.some((x: any) => x.id === r.json.id)).toBe(true);
    const done = await api(t, 'POST', `/admin/data-requests/${r.json.id}/resolve`, { token: s.owner.token, body: { status: 'done', resolution: 'Shaxsiy ma’lumotlar o‘chirildi; buyurtma yozuvlari qonun bo‘yicha saqlanadi.' } });
    expect(done.status).toBe(200);
    expect((await api(t, 'GET', '/me/data-requests', { token: u.token })).json.items[0].status).toBe('done');
    expect((await api(t, 'POST', `/admin/data-requests/${randomUUID()}/resolve`, { token: s.owner.token, body: { status: 'done', resolution: 'yo‘q narsa' } })).status).toBe(404);
  });
});
