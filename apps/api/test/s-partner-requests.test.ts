import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkPartner, mkProduct, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('Partner → operator requests', () => {
  it('requests join one task, stay scoped to the partner, and the partner sees only the answer meant for them', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [60_000], stock: [10], rule: { kind: 'percent', bps: 1000 } });
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    const orderId = r.json.order_id as string;
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [orderId])).rows[0].attributed_partner_id).toBe(p.partnerId);

    // Callback-time request needs the time; other partner cannot touch this order (T04).
    expect((await api(t, 'POST', `/partner/orders/${orderId}/requests`, { token: p.token, body: { kind: 'callback_time', body: 'Mijoz kechqurun' } })).json.code).toBe('PREFERRED_TIME_REQUIRED');
    const other = await mkPartner(t);
    expect((await api(t, 'POST', `/partner/orders/${orderId}/requests`, { token: other.token, body: { kind: 'message', body: 'salom' } })).status).toBe(404);
    expect((await api(t, 'GET', `/partner/orders/${orderId}/requests`, { token: other.token })).status).toBe(404);

    const a = await api(t, 'POST', `/partner/orders/${orderId}/requests`, { token: p.token, body: { kind: 'message', body: 'Mijoz rangni so‘radi' } });
    const b = await api(t, 'POST', `/partner/orders/${orderId}/requests`, { token: p.token, body: { kind: 'commission_question', body: 'Komissiya qachon tushadi?' } });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const tasks = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1 AND type='partner_request' AND state NOT IN ('resolved','closed')`, [orderId])).rows;
    expect(tasks.length).toBe(1);

    const list = await api(t, 'GET', `/ops/center/tasks/${tasks[0].id}/partner-requests`, { token: s.operator.token });
    expect(list.json.items.length).toBe(2);
    await api(t, 'POST', `/ops/center/partner-requests/${a.json.id}/answer`, { token: s.operator.token, body: { answer: 'Qora rang bor, mijozga aytdik' } });
    let task = (await t.db.query(`SELECT state FROM ops_tasks WHERE id=$1`, [tasks[0].id])).rows[0];
    expect(task.state).not.toBe('resolved'); // one request still open
    const last = await api(t, 'POST', `/ops/center/partner-requests/${b.json.id}/answer`, { token: s.operator.token, body: { answer: 'Yetkazilgach 3 kunda' } });
    expect(last.json.open_left).toBe(0);
    task = (await t.db.query(`SELECT state FROM ops_tasks WHERE id=$1`, [tasks[0].id])).rows[0];
    expect(task.state).toBe('resolved');
    expect((await api(t, 'POST', `/ops/center/partner-requests/${b.json.id}/answer`, { token: s.operator.token, body: { answer: 'yana' } })).json.code).toBe('REQUEST_ALREADY_ANSWERED');

    const mine = await api(t, 'GET', `/partner/orders/${orderId}/requests`, { token: p.token });
    expect(mine.json.items.map((x: any) => x.answer).sort()).toEqual(['Qora rang bor, mijozga aytdik', 'Yetkazilgach 3 kunda']);
    expect(Object.keys(mine.json.items[0])).not.toContain('answered_by'); // no staff identity leaks
    // A customer cannot answer partner requests.
    expect((await api(t, 'POST', `/ops/center/partner-requests/${a.json.id}/answer`, { token: p.token, body: { answer: 'x y' } })).status).toBe(403);
  });
});
