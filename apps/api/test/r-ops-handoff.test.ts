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

describe('Bulk-safe transfer (T53)', () => {
  it('previews first, then moves item by item with a per-item result and summary; closed tasks are skipped', async () => {
    const a = await claimedTask(s.operator.token);
    const b = await claimedTask(s.operator.token);
    await t.db.query(`UPDATE ops_tasks SET state='resolved' WHERE id=$1`, [b.id]);
    expect((await api(t, 'POST', '/ops/center/bulk/assign', { token: s.operator.token, body: { task_ids: [a.id], to_user_id: null, reason: 'smena tugadi', dry_run: true } })).status).toBe(403);
    const prev = await api(t, 'POST', '/ops/center/bulk/assign', { token: s.owner.token, body: { task_ids: [a.id, b.id], to_user_id: s.operator2.id, reason: 'Operator kasal', dry_run: true } });
    expect(prev.json.summary).toEqual({ would_move: 1, skipped: 1 });
    expect((await t.db.query(`SELECT assignee_id FROM ops_tasks WHERE id=$1`, [a.id])).rows[0].assignee_id).toBe(s.operator.id); // preview changes nothing
    const run = await api(t, 'POST', '/ops/center/bulk/assign', { token: s.owner.token, body: { task_ids: [a.id, b.id], to_user_id: s.operator2.id, reason: 'Operator kasal', dry_run: false } });
    expect(run.json.summary).toEqual({ moved: 1, skipped: 1 });
    expect(run.json.results.find((r: any) => r.task_id === b.id).reason).toBe('ish yopilgan');
    expect((await t.db.query(`SELECT assignee_id FROM ops_tasks WHERE id=$1`, [a.id])).rows[0].assignee_id).toBe(s.operator2.id);
  });
});

describe('Incident grouping', () => {
  it('links tasks to one root cause; resolving returns them to the queue and never changes the orders', async () => {
    const a = await claimedTask(s.operator.token);
    const b = await claimedTask(s.operator.token);
    const inc = await api(t, 'POST', '/ops/center/incidents', { token: s.owner.token, body: { title: 'Kuryer xizmati kechikmoqda', kind: 'delivery', task_ids: [a.id, b.id] } });
    expect(inc.json.linked).toBe(2);
    let rows = (await t.db.query(`SELECT state, blocked_by FROM ops_tasks WHERE id = ANY($1)`, [[a.id, b.id]])).rows;
    expect(rows.every((r: any) => r.state === 'waiting_internal' && /Kuryer/.test(r.blocked_by))).toBe(true);
    const before = (await t.db.query(`SELECT id, commercial_status, fulfillment_status FROM orders WHERE id = ANY($1) ORDER BY id`, [[a.orderId, b.orderId]])).rows;
    const res = await api(t, 'POST', `/ops/center/incidents/${inc.json.id}/resolve`, { token: s.owner.token, body: { resolution: 'Kuryer xizmati tiklandi' } });
    expect(res.json.returned_to_queue).toBe(2);
    rows = (await t.db.query(`SELECT state, next_action FROM ops_tasks WHERE id = ANY($1)`, [[a.id, b.id]])).rows;
    expect(rows.every((r: any) => r.state === 'queued' && /hal bo‘ldi/.test(r.next_action))).toBe(true);
    const after = (await t.db.query(`SELECT id, commercial_status, fulfillment_status FROM orders WHERE id = ANY($1) ORDER BY id`, [[a.orderId, b.orderId]])).rows;
    expect(after).toEqual(before);
    expect((await api(t, 'POST', `/ops/center/incidents/${inc.json.id}/resolve`, { token: s.owner.token, body: { resolution: 'yana' } })).json.code).toBe('INCIDENT_ALREADY_RESOLVED');
    expect((await api(t, 'POST', '/ops/center/incidents', { token: s.operator.token, body: { title: 'x y z', kind: 'other', task_ids: [a.id] } })).status).toBe(403);
  });
});

describe('Operator quality (fair, with denominators)', () => {
  it('reports several measures with sample size and flags small samples', async () => {
    const a = await claimedTask(s.operator.token);
    await api(t, 'POST', `/ops/center/tasks/${a.id}/contact`, { token: s.operator.token, body: { expected_version: a.version, outcome: 'no_answer' } });
    const q = await api(t, 'GET', '/ops/center/quality?days=30', { token: s.owner.token });
    expect(q.status).toBe(200);
    const me = q.json.items.find((x: any) => x.id === s.operator.id);
    expect(me.tasks_contacted).toBeGreaterThanOrEqual(1);
    expect(me.enough_data).toBe(false);
    expect(q.json.min_sample).toBe(20);
    expect((await api(t, 'GET', '/ops/center/quality', { token: s.operator.token })).status).toBe(403);
  });
});

describe('QA sampling', () => {
  it('a person reviews finished work (not their own); the operator sees it and can object once', async () => {
    const a = await claimedTask(s.operator.token);
    const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [a.orderId])).rows[0].payable_minor;
    await api(t, 'POST', `/ops/center/tasks/${a.id}/contact`, { token: s.operator.token, body: { expected_version: a.version, outcome: 'confirmed', confirmed_total_minor: payable } });
    const sample = await api(t, 'GET', '/ops/center/qa/sample?n=20', { token: s.owner.token });
    expect(sample.json.items.map((x: any) => x.id)).toContain(a.id);
    const low = await api(t, 'POST', `/ops/center/qa/${a.id}`, { token: s.owner.token, body: { checks: { correct_outcome: true, data_complete: false, clear_communication: true }, score: 2 } });
    expect(low.json.code).toBe('REASON_REQUIRED');
    const ok = await api(t, 'POST', `/ops/center/qa/${a.id}`, { token: s.owner.token, body: { checks: { correct_outcome: true, data_complete: false, clear_communication: true }, score: 3, note: 'Mo‘ljal yozilmagan' } });
    expect(ok.status).toBe(200);
    expect((await api(t, 'POST', `/ops/center/qa/${a.id}`, { token: s.owner.token, body: { checks: { correct_outcome: true, data_complete: true, clear_communication: true }, score: 5 } })).json.code).toBe('ALREADY_REVIEWED');
    const mine = await api(t, 'GET', '/ops/center/qa/mine', { token: s.operator.token });
    const rev = mine.json.items.find((x: any) => x.note === 'Mo‘ljal yozilmagan');
    expect(rev).toBeTruthy();
    expect((await api(t, 'POST', `/ops/center/qa/reviews/${rev.id}/reply`, { token: s.operator2.token, body: { text: 'bu meniki emas' } })).status).toBe(403);
    expect((await api(t, 'POST', `/ops/center/qa/reviews/${rev.id}/reply`, { token: s.operator.token, body: { text: 'Mijoz mo‘ljalni aytmadi, izohda bor' } })).status).toBe(200);
    expect((await t.db.query(`SELECT status FROM ops_qa_reviews WHERE id=$1`, [rev.id])).rows[0].status).toBe('disputed');
  });
});
