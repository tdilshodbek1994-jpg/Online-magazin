import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, mkUser, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** Final release: owner decisions center (derived problems) + daily finance close. Own database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_decisions');
  s = await staff(t);
});

describe('owner decisions & problems center (M24)', () => {
  it('shows real problems with severity/owner/link; a problem disappears only when fixed; operator has no access', async () => {
    const prod = await mkProduct(t, { prices: [50_000], stock: [5] });
    const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await t.db.query(`UPDATE orders SET created_at = now() - interval '2 hours', assigned_operator_id=NULL WHERE id=$1`, [o.json.order_id]);
    const out = await mkProduct(t, { prices: [10_000], stock: [0] });
    void out;
    const cust = await mkUser(t);
    await api(t, 'POST', '/me/data-requests', { token: cust.token, body: { kind: 'export' } });
    expect((await api(t, 'GET', '/admin/decisions', { token: s.operator.token })).status).toBe(403);
    const r = await api(t, 'GET', '/admin/decisions', { token: s.owner.token });
    expect(r.status).toBe(200);
    const kinds = r.json.items.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['unassigned_orders', 'out_of_stock', 'data_requests']));
    const un = r.json.items.find((i: any) => i.kind === 'unassigned_orders');
    expect(un).toMatchObject({ severity: 2, owner_role: 'Operator boshlig‘i', href: '/ops' });
    expect(r.json.items.map((i: any) => i.severity)).toEqual([...r.json.items.map((i: any) => i.severity)].sort());
    // fixing the record (an operator takes the order) removes the problem — nothing is hidden by a click
    await t.db.query(`UPDATE orders SET assigned_operator_id=$2 WHERE id=$1`, [o.json.order_id, s.operator.id]);
    const r2 = await api(t, 'GET', '/admin/decisions', { token: s.owner.token });
    expect(r2.json.items.map((i: any) => i.kind)).not.toContain('unassigned_orders');
  });
});

describe('daily finance close (M25)', () => {
  const yesterday = () => new Date(Date.now() + 5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  it('day figures keep states separate; close = snapshot; correction needs a note and makes a new version', async () => {
    const day = yesterday();
    const v = await api(t, 'GET', `/admin/finance/day?day=${day}`, { token: s.owner.token });
    expect(v.status).toBe(200);
    expect(Object.keys(v.json.figures)).toEqual(expect.arrayContaining(['cod_collected', 'cod_remitted', 'online_captured', 'refunds_succeeded', 'payouts_paid', 'delivered_amount']));
    expect((await api(t, 'GET', `/admin/finance/day?day=${day}`, { token: s.operator.token })).status).toBe(403);
    const c1 = await api(t, 'POST', '/admin/finance/day/close', { token: s.owner.token, body: { day } });
    expect(c1.json).toMatchObject({ day, version: 1 });
    expect((await api(t, 'POST', '/admin/finance/day/close', { token: s.owner.token, body: { day } })).json.code).toBe('CORRECTION_NOTE_REQUIRED');
    const c2 = await api(t, 'POST', '/admin/finance/day/close', { token: s.owner.token, body: { day, note: 'Kuryer kechikib topshirdi' } });
    expect(c2.json.version).toBe(2);
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    expect((await api(t, 'POST', '/admin/finance/day/close', { token: s.owner.token, body: { day: today } })).json.code).toBe('DAY_NOT_FINISHED');
    const fin = await mkUser(t, ['finance'], nextPhone(), false);
    expect((await api(t, 'POST', '/admin/finance/day/close', { token: fin.token, body: { day: '2026-01-01' } })).json.code).toBe('STEP_UP_REQUIRED');
    const hist = await api(t, 'GET', `/admin/finance/day?day=${day}`, { token: s.owner.token });
    expect(hist.json.closes.map((x: any) => x.version)).toEqual([2, 1]);
  });
});

describe('integration health (M35)', () => {
  it('real signals per service; unconfigured providers are said so, never shown as healthy zero', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect((await api(t, 'GET', '/admin/integrations/health', { token: s.operator.token })).status).toBe(403);
    const h = await api(t, 'GET', '/admin/integrations/health', { token: s.owner.token });
    expect(h.status).toBe(200);
    const by = Object.fromEntries(h.json.checks.map((c: any) => [c.key, c]));
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['database', 'worker', 'outbox', 'telegram', 'sms', 'payme', 'click', 'money_unknown', 'ai', 'ads', 'fiscal']));
    expect(by.database.state).toBe('ok');
    expect(by.telegram.state).toBe('not_configured');
    expect(by.sms.state).toBe('not_configured');
    expect(by.fiscal.detail).toContain('PDF fiskal chek emas');
    expect(['ok', 'degraded', 'down']).toContain(h.json.overall);
  });
});

describe('role revocation takes effect immediately (G02)', () => {
  it('a revoked operator loses the ops queue and old AI reports on the next request', async () => {
    const op = await mkUser(t, ['operator']);
    expect((await api(t, 'GET', '/ops/center', { token: op.token })).status).toBe(200);
    const rep = await api(t, 'POST', '/ai/biz/ask', { token: op.token, body: { text: 'Hozir navbatimda nechta ish bor?' } });
    expect(rep.status).toBe(200);
    const rv = await api(t, 'POST', `/admin/staff/${op.id}/revoke`, { token: s.owner.token, body: { role: 'operator', reason: 'ishdan ketdi' } });
    expect(rv.status).toBe(200);
    expect((await api(t, 'GET', '/ops/center', { token: op.token })).status).toBe(403);
    expect((await api(t, 'GET', `/ai/biz/reports/${rep.json.report_id}`, { token: op.token })).status).toBe(404);
    expect((await api(t, 'POST', '/ai/biz/ask', { token: op.token, body: { text: 'navbatim' } })).status).toBe(403);
  });
});

describe('staff profile', () => {
  it('owner opens a staff profile (roles, security, own actions); operator cannot; sign-out everywhere ends sessions', async () => {
    const op = await mkUser(t, ['operator']);
    expect((await api(t, 'GET', `/admin/staff/${op.id}`, { token: s.operator.token })).status).toBe(403);
    const p = await api(t, 'GET', `/admin/staff/${op.id}`, { token: s.owner.token });
    expect(p.status).toBe(200);
    expect(p.json.roles.map((r: any) => r.role_code)).toContain('operator');
    expect(p.json.security.sessions).toBe(1);
    expect(p.json.links.operator).toBe(`/admin/operator/${op.id}`);
    expect(JSON.stringify(p.json)).not.toMatch(/token_hash|secret_enc|recovery/);
    const customer = await mkUser(t);
    expect((await api(t, 'GET', `/admin/staff/${customer.id}`, { token: s.owner.token })).status).toBe(404);
    const r = await api(t, 'POST', `/admin/staff/${op.id}/sessions/revoke`, { token: s.owner.token, body: { reason: 'telefon yo‘qoldi' } });
    expect(r.json.revoked).toBe(1);
    expect((await api(t, 'GET', '/ops/center', { token: op.token })).status).toBe(401);
  });
});

describe('warehouse pick check (M20)', () => {
  it('wrong item is refused and blocks packing; the full correct set unlocks it; no customer data in the pick list', async () => {
    const prod = await mkProduct(t, { prices: [70_000], stock: [5] });
    const c = await mkUser(t);
    const o = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    const id = o.json.order_id;
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    expect((await api(t, 'POST', `/ops/orders/${id}/pick/scan`, { token: s.warehouse.token, body: { code: 'X' } })).json.code).toBe('NOT_PICKING');
    expect((await api(t, 'POST', `/ops/orders/${id}/pick`, { token: s.warehouse.token })).status).toBe(200);
    const wrong = await api(t, 'POST', `/ops/orders/${id}/pick/scan`, { token: s.warehouse.token, body: { code: 'NOT-IN-ORDER' } });
    expect(wrong.json).toMatchObject({ ok: false, code: 'WRONG_ITEM', complete: false });
    expect((await api(t, 'POST', `/ops/orders/${id}/pack`, { token: s.warehouse.token })).json.code).toBe('PICK_INCOMPLETE');
    const sku = (await t.db.query(`SELECT sku_code FROM skus WHERE id=$1`, [prod.skuIds[0]])).rows[0].sku_code;
    expect((await api(t, 'POST', `/ops/orders/${id}/pick/scan`, { token: s.warehouse.token, body: { code: sku.toLowerCase() } })).json.complete).toBe(false);
    const done = await api(t, 'POST', `/ops/orders/${id}/pick/scan`, { token: s.warehouse.token, body: { code: sku } });
    expect(done.json).toMatchObject({ ok: true, complete: true });
    expect((await api(t, 'POST', `/ops/orders/${id}/pick/scan`, { token: s.warehouse.token, body: { code: sku } })).json).toMatchObject({ ok: false, code: 'EXTRA_UNIT', complete: true });
    const list = await api(t, 'GET', `/ops/orders/${id}/pick`, { token: s.warehouse.token });
    expect(JSON.stringify(list.json)).not.toContain(c.phone);
    expect((await api(t, 'POST', `/ops/orders/${id}/pack`, { token: s.warehouse.token })).status).toBe(200);
  });
});
