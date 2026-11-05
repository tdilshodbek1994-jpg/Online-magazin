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
