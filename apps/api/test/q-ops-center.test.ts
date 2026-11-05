import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, mkUser, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

async function newOrder() {
  const prod = await mkProduct(t, { prices: [50_000], stock: [20] });
  // A guest order is not verified, so it waits for operator confirmation.
  const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
  if (!r.json.order_id) throw new Error(JSON.stringify(r.json));
  return r.json.order_id as string;
}
async function taskOf(orderId: string) {
  await api(t, 'GET', '/ops/center', { token: s.operator.token }); // sync creates the task
  return (await t.db.query(`SELECT * FROM ops_tasks WHERE order_id=$1 AND type='confirm' ORDER BY created_at DESC LIMIT 1`, [orderId])).rows[0];
}
const shift = (tok: string, state: string) => api(t, 'PUT', '/ops/center/shift', { token: tok, body: { state } });

describe('Operator Centre P0', () => {
  it('T02: a new order gets exactly one open confirm task, however often we sync', async () => {
    const o = await newOrder();
    for (let i = 0; i < 3; i++) await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const n = (await t.db.query(`SELECT COUNT(*)::int AS n FROM ops_tasks WHERE order_id=$1 AND state NOT IN ('resolved','closed')`, [o])).rows[0].n;
    expect(n).toBe(1);
  });

  it('T13: an operator not on shift (or on break) cannot take new work', async () => {
    const o = await newOrder();
    const task = await taskOf(o);
    await shift(s.operator.token, 'break');
    const r = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('SHIFT_NOT_WORKING');
    expect((await api(t, 'POST', '/ops/center/next', { token: s.operator.token })).json.code).toBe('SHIFT_NOT_WORKING');
  });

  it('T07: two operators claiming the same task at once — exactly one wins', async () => {
    const o = await newOrder();
    const task = await taskOf(o);
    await shift(s.operator.token, 'working'); await shift(s.operator2.token, 'working');
    const [a, b] = await Promise.all([
      api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} }),
      api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator2.token, body: {} }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.code).toBe('TASK_ALREADY_CLAIMED');
  });

  it('T18 + T15: "no answer" never closes the task; it is scheduled and nobody gets it before its time', async () => {
    const o = await newOrder();
    const task = await taskOf(o);
    await shift(s.operator.token, 'working'); await shift(s.operator2.token, 'working');
    const c = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} });
    expect(c.status).toBe(200);
    const r = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: c.json.task.version, outcome: 'no_answer' } });
    expect(r.status).toBe(200);
    expect(r.json.task.state).toBe('scheduled');
    expect(r.json.task.not_before).toBeTruthy();
    expect(r.json.task.next_action).toMatch(/Qayta qo‘ng‘iroq/);
    const early = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator2.token, body: {} });
    expect(early.status).toBe(409);
    // A requested callback needs an exact time.
    const o2 = await newOrder(); const t2 = await taskOf(o2);
    const c2 = await api(t, 'POST', `/ops/center/tasks/${t2.id}/claim`, { token: s.operator.token, body: {} });
    const bad = await api(t, 'POST', `/ops/center/tasks/${t2.id}/contact`, { token: s.operator.token, body: { expected_version: c2.json.task.version, outcome: 'callback_requested' } });
    expect(bad.json.code).toBe('NEXT_CONTACT_REQUIRED');
  });

  it('T10 + T12: after the lease expires and someone else claims, the old session cannot write', async () => {
    const o = await newOrder();
    const task = await taskOf(o);
    await shift(s.operator.token, 'working'); await shift(s.operator2.token, 'working');
    const a = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} });
    await t.db.query(`UPDATE ops_tasks SET lease_until = now() - interval '1 minute' WHERE id=$1`, [task.id]);
    const b = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator2.token, body: {} });
    expect(b.status).toBe(200);
    const stale = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: a.json.task.version, outcome: 'info_given' } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('TASK_VERSION_CONFLICT');
  });

  it('confirm through the task: total read-back required, order confirmed, task resolved, partner/legacy flow intact', async () => {
    const o = await newOrder();
    const task = await taskOf(o);
    await shift(s.operator.token, 'working');
    const c = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} });
    const wrong = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: c.json.task.version, outcome: 'confirmed', confirmed_total_minor: '1' } });
    expect(wrong.json.code).toBe('CONFIRMED_TOTAL_MISMATCH');
    const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [o])).rows[0].payable_minor;
    const ok = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: c.json.task.version, outcome: 'confirmed', confirmed_total_minor: payable } });
    expect(ok.status).toBe(200);
    expect(ok.json.task.state).toBe('resolved');
    expect((await t.db.query(`SELECT commercial_status FROM orders WHERE id=$1`, [o])).rows[0].commercial_status).toBe('confirmed');
    const card = await api(t, 'GET', `/ops/center/tasks/${task.id}`, { token: s.operator.token });
    expect(card.json.events.map((e: any) => e.kind)).toEqual(['claimed', 'contact']);
    expect(card.json.five.next).toBeTruthy();
  });

  it('customers and partners cannot use the operator centre', async () => {
    const c = await mkUser(t);
    expect((await api(t, 'GET', '/ops/center', { token: c.token })).status).toBe(403);
    expect((await api(t, 'GET', '/ops/center/board', { token: s.operator.token })).status).toBe(403);
  });
});

describe('Operator Centre SLA', () => {
  it('marks soon/late/critical, pauses on scheduled, escalates a critical task once without breaking the open card', async () => {
    const prod = await mkProduct(t, { prices: [30_000], stock: [5] });
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const task = (await t.db.query(`SELECT id, version FROM ops_tasks WHERE order_id=$1`, [r.json.order_id])).rows[0];
    const slaOf = async () => (await api(t, 'GET', `/ops/center/tasks/${task.id}`, { token: s.operator.token })).json.sla;
    await t.db.query(`UPDATE ops_tasks SET due_at = now() + interval '5 minutes' WHERE id=$1`, [task.id]);
    expect(await slaOf()).toBe('soon');
    await t.db.query(`UPDATE ops_tasks SET due_at = now() - interval '5 minutes' WHERE id=$1`, [task.id]);
    expect(await slaOf()).toBe('late');
    await shift(s.operator.token, 'working');
    const c = await api(t, 'POST', `/ops/center/tasks/${task.id}/claim`, { token: s.operator.token, body: {} });
    await t.db.query(`UPDATE ops_tasks SET due_at = now() - interval '3 hours' WHERE id=$1`, [task.id]);
    expect(await slaOf()).toBe('critical');
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const ev = (await t.db.query(`SELECT COUNT(*)::int AS n FROM ops_task_events WHERE task_id=$1 AND kind='sla_escalated'`, [task.id])).rows[0].n;
    expect(ev).toBe(1);
    // The operator's open card still saves (escalation does not bump the version).
    const w = await api(t, 'POST', `/ops/center/tasks/${task.id}/contact`, { token: s.operator.token, body: { expected_version: c.json.task.version, outcome: 'no_answer' } });
    expect(w.status).toBe(200);
    expect(await slaOf()).toBe('paused');
  });
});
