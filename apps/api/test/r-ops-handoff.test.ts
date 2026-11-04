import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { fitContactHours, inContactHours } from '../src/modules/opscenter/routes.js';
import { api, mkProduct, mkUser, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

async function claimedTask(tok: string) {
  const prod = await mkProduct(t, { prices: [40_000], stock: [10] });
  const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
  await api(t, 'GET', '/ops/center', { token: tok });
  const task = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1`, [r.json.order_id])).rows[0];
  await api(t, 'PUT', '/ops/center/shift', { token: tok, body: { state: 'working' } });
  const c = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: tok, body: {} });
  return { id: task.id as string, version: c.json.task.version as number, orderId: r.json.order_id as string };
}
const pkg = { done: 'Qo‘ng‘iroq qildim, mijoz o‘ylab ko‘radi', customer_said: 'Kechqurun aniq aytaman', promised: 'Soat 18 da qayta qo‘ng‘iroq', missing: 'Uy raqami', next: 'Qayta qo‘ng‘iroq qilib tasdiqlash' };

describe('Operator Centre P1: handoff, supervisor transfer, contact hours', () => {
  it('T14: until the receiver accepts, the sender stays responsible; accepting moves owner and keeps the package', async () => {
    const task = await claimedTask(s.operator.token);
    const h = await api(t, 'POST', `/ops/center/tasks/${task.id}/handoff`, { token: s.operator.token, body: { expected_version: task.version, to_user_id: s.operator2.id, package: pkg } });
    expect(h.status).toBe(200);
    let row = (await t.db.query(`SELECT assignee_id FROM ops_tasks WHERE id=$1`, [task.id])).rows[0];
    expect(row.assignee_id).toBe(s.operator.id);
    const dup = await api(t, 'POST', `/ops/center/tasks/${task.id}/handoff`, { token: s.operator.token, body: { expected_version: task.version, to_user_id: s.operator2.id, package: pkg } });
    expect(dup.json.code).toBe('HANDOFF_ALREADY_PENDING');
    const inbox = await api(t, 'GET', '/ops/center/handoffs', { token: s.operator2.token });
    expect(inbox.json.incoming.map((x: any) => x.id)).toContain(h.json.handoff_id);
    // A third person cannot accept someone else's handoff.
    const other = await mkUser(t, ['operator']);
    expect((await api(t, 'POST', `/ops/center/handoffs/${h.json.handoff_id}/accept`, { token: other.token, body: {} })).status).toBe(403);
    const acc = await api(t, 'POST', `/ops/center/handoffs/${h.json.handoff_id}/accept`, { token: s.operator2.token, body: {} });
    expect(acc.status).toBe(200);
    row = (await t.db.query(`SELECT assignee_id FROM ops_tasks WHERE id=$1`, [task.id])).rows[0];
    expect(row.assignee_id).toBe(s.operator2.id);
    const card = await api(t, 'GET', `/ops/center/tasks/${task.id}`, { token: s.operator2.token });
    const ev = card.json.events.find((e: any) => e.kind === 'handoff_accepted');
    expect(ev.data.package.promised).toBe(pkg.promised);
  });

  it('an expired handoff returns to the sender — the task is never ownerless', async () => {
    const task = await claimedTask(s.operator.token);
    const h = await api(t, 'POST', `/ops/center/tasks/${task.id}/handoff`, { token: s.operator.token, body: { expected_version: task.version, to_user_id: s.operator2.id, package: pkg } });
    await t.db.query(`UPDATE ops_handoffs SET expires_at = now() - interval '1 minute' WHERE id=$1`, [h.json.handoff_id]);
    const late = await api(t, 'POST', `/ops/center/handoffs/${h.json.handoff_id}/accept`, { token: s.operator2.token, body: {} });
    expect(late.json.code).toBe('HANDOFF_NOT_PENDING');
    expect((await t.db.query(`SELECT assignee_id FROM ops_tasks WHERE id=$1`, [task.id])).rows[0].assignee_id).toBe(s.operator.id);
  });

  it('supervisor transfer needs the permission and a reason, and is recorded', async () => {
    const task = await claimedTask(s.operator.token);
    expect((await api(t, 'POST', `/ops/center/tasks/${task.id}/assign`, { token: s.operator.token, body: { to_user_id: s.operator2.id, reason: 'yuklama' } })).status).toBe(403);
    const r = await api(t, 'POST', `/ops/center/tasks/${task.id}/assign`, { token: s.owner.token, body: { to_user_id: s.operator2.id, reason: 'Operator kasal' } });
    expect(r.status).toBe(200);
    const card = await api(t, 'GET', `/ops/center/tasks/${task.id}`, { token: s.operator2.token });
    expect(card.json.events.some((e: any) => e.kind === 'supervisor_transfer' && e.data.reason === 'Operator kasal')).toBe(true);
    expect(card.json.events[0].kind).toBe('claimed'); // history is not reset
  });

  it('T16: callbacks cannot be scheduled at night (Tashkent); automatic retries move to 09:00', async () => {
    const task = await claimedTask(s.operator.token);
    const night = new Date(); night.setUTCDate(night.getUTCDate() + 1); night.setUTCHours(20, 0, 0, 0); // 01:00 Tashkent
    const r = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: task.version, outcome: 'callback_requested', next_contact_at: night.toISOString() } });
    expect(r.json.code).toBe('OUTSIDE_CONTACT_HOURS');
    expect(inContactHours(night)).toBe(false);
    const moved = fitContactHours(night);
    expect((moved.getUTCHours() + 5) % 24).toBe(9);
    expect(moved.getTime()).toBeGreaterThan(night.getTime());
    const day = new Date(night); day.setUTCHours(7, 0, 0, 0); // 12:00 Tashkent
    expect(fitContactHours(day).getTime()).toBe(day.getTime());
  });
});
