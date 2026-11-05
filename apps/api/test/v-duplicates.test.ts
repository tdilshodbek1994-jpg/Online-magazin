import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

async function two() {
  const phone = nextPhone();
  const prod = await mkProduct(t, { prices: [25_000], stock: [20] });
  const a = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
  const b = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
  await api(t, 'GET', '/ops/center', { token: s.operator.token });
  const tb = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1`, [b.json.order_id])).rows[0];
  return { a: a.json.order_id as string, b: b.json.order_id as string, taskB: tb.id as string };
}

describe('Duplicate review (T03)', () => {
  it('same phone + same SKU is only a signal: both orders stay alive until a person decides', async () => {
    const x = await two();
    const rows = (await t.db.query(`SELECT id, commercial_status, duplicate_signal FROM orders WHERE id = ANY($1)`, [[x.a, x.b]])).rows;
    expect(rows.every((r: any) => r.commercial_status !== 'cancelled')).toBe(true);
    expect(rows.find((r: any) => r.id === x.b).duplicate_signal).toBe(true);
    const d = await api(t, 'GET', `/ops/center/tasks/${x.taskB}/duplicates`, { token: s.operator.token });
    expect(d.json.items.map((i: any) => i.id)).toContain(x.a);
    expect(d.json.items[0].shared_items).toBeTruthy();
    // "Not a duplicate" (e.g. two family members) clears the signal for good.
    const nd = await api(t, 'POST', `/ops/center/tasks/${x.taskB}/duplicate-decision`, { token: s.operator.token, body: { decision: 'not_duplicate', reason: 'Aka-uka, ikkita alohida buyurtma' } });
    expect(nd.status).toBe(200);
    const after = (await t.db.query(`SELECT duplicate_signal, duplicate_review, commercial_status FROM orders WHERE id=$1`, [x.b])).rows[0];
    expect(after).toMatchObject({ duplicate_signal: false, duplicate_review: 'not_duplicate' });
    expect(after.commercial_status).not.toBe('cancelled');
    expect((await api(t, 'POST', `/ops/center/tasks/${x.taskB}/duplicate-decision`, { token: s.operator.token, body: { decision: 'not_duplicate', reason: 'yana bir bor' } })).json.code).toBe('DUPLICATE_ALREADY_REVIEWED');
  });

  it('a confirmed duplicate is cancelled with a canonical link; both IDs and histories are kept', async () => {
    const x = await two();
    const bad = await api(t, 'POST', `/ops/center/tasks/${x.taskB}/duplicate-decision`, { token: s.operator.token, body: { decision: 'duplicate', keep_order_id: x.b, reason: 'ikki marta bosilgan' } });
    expect(bad.json.code).toBe('KEEP_ORDER_INVALID');
    const ok = await api(t, 'POST', `/ops/center/tasks/${x.taskB}/duplicate-decision`, { token: s.operator.token, body: { decision: 'duplicate', keep_order_id: x.a, reason: 'Mijoz ikki marta bosgan' } });
    expect(ok.status).toBe(200);
    const b = (await t.db.query(`SELECT commercial_status, duplicate_of, cancel_reason FROM orders WHERE id=$1`, [x.b])).rows[0];
    expect(b).toMatchObject({ commercial_status: 'cancelled', duplicate_of: x.a, cancel_reason: 'duplicate_order' });
    expect((await t.db.query(`SELECT commercial_status FROM orders WHERE id=$1`, [x.a])).rows[0].commercial_status).not.toBe('cancelled');
    expect((await t.db.query(`SELECT COUNT(*)::int AS n FROM order_status_events WHERE order_id=$1`, [x.b])).rows[0].n).toBeGreaterThan(1);
  });

  it('a paid order cannot be cancelled as a duplicate (refund flow instead)', async () => {
    const x = await two();
    await t.db.query(`UPDATE orders SET payment_status='paid' WHERE id=$1`, [x.b]);
    const r = await api(t, 'POST', `/ops/center/tasks/${x.taskB}/duplicate-decision`, { token: s.operator.token, body: { decision: 'duplicate', keep_order_id: x.a, reason: 'takror' } });
    expect(r.json.code).toBe('PAID_ORDER_REQUIRES_REFUND');
    expect((await t.db.query(`SELECT commercial_status FROM orders WHERE id=$1`, [x.b])).rows[0].commercial_status).not.toBe('cancelled');
  });
});
