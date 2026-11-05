import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('Three-audience messages (T25)', () => {
  it('internal notes never reach the customer or the partner; each audience sees only its own messages', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [70_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const cust = await mkUser(t);
    // Unverified path so the order waits for the operator: guest token, but the customer account phone is used later.
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: cust.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    const orderId = r.json.order_id as string;
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const task = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1`, [orderId])).rows[0];

    const note = await api(t, 'POST', `/ops/center/tasks/${task.id}/messages`, { token: s.operator.token, body: { audience: 'internal', body: 'MAXFIY: mijoz shubhali' } });
    expect(note.json.delivery_state).toBe('stored');
    const toP = await api(t, 'POST', `/ops/center/tasks/${task.id}/messages`, { token: s.operator.token, body: { audience: 'partner', body: 'Mijoz ertaga javob beradi' } });
    expect(['queued', 'stored']).toContain(toP.json.delivery_state);
    const toC = await api(t, 'POST', `/ops/center/tasks/${task.id}/messages`, { token: s.operator.token, body: { audience: 'customer', body: 'Buyurtmangiz ertaga yetkaziladi' } });
    expect(toC.status).toBe(200);

    const partnerView = await api(t, 'GET', `/partner/orders/${orderId}/requests`, { token: p.token });
    const pText = JSON.stringify(partnerView.json);
    expect(pText).toContain('Mijoz ertaga javob beradi');
    expect(pText).not.toContain('MAXFIY');
    expect(pText).not.toContain('yetkaziladi'); // customer message is not the partner's

    const custView = await api(t, 'GET', `/me/orders/${orderId}`, { token: cust.token });
    expect(custView.status).toBe(200);
    const cText = JSON.stringify(custView.json.messages);
    expect(cText).toContain('Buyurtmangiz ertaga yetkaziladi');
    expect(cText).not.toContain('MAXFIY');
    expect(cText).not.toContain('javob beradi');

    const staffView = await api(t, 'GET', `/ops/center/tasks/${task.id}/messages`, { token: s.operator.token });
    expect(staffView.json.items.map((x: any) => x.audience).sort()).toEqual(['customer', 'internal', 'partner']);
    expect((await api(t, 'GET', `/ops/center/tasks/${task.id}/messages`, { token: p.token })).status).toBe(403);
  });
});
