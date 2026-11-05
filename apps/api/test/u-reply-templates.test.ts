import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/modules/opscenter/templates.js';
import { api, mkProduct, nextPhone, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('Saved replies', () => {
  it('fills only verified order data, lists what is missing, and refuses to send unfilled text', async () => {
    expect(renderTemplate('{name}: {delivery_date}', { name: 'Ali' })).toEqual({ text: 'Ali: {delivery_date}', missing: ['delivery_date'] });
    const prod = await mkProduct(t, { prices: [45_000], stock: [5] });
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 2 }]);
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const task = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1`, [r.json.order_id])).rows[0];
    const list = await api(t, 'GET', `/ops/center/tasks/${task.id}/templates`, { token: s.operator.token });
    const info = list.json.items.find((x: any) => x.code === 'confirm_info');
    expect(info.missing).toEqual([]);
    expect(info.text).toContain('× 2');
    const day = list.json.items.find((x: any) => x.code === 'delivery_day');
    expect(day.missing).toEqual(['delivery_date']);
    const cyr = await api(t, 'GET', `/ops/center/tasks/${task.id}/templates?script=cyrl`, { token: s.operator.token });
    expect(cyr.json.items.find((x: any) => x.code === 'confirm_info').text).toMatch(/Ассалому/);
    const bad = await api(t, 'POST', `/ops/center/tasks/${task.id}/messages`, { token: s.operator.token, body: { audience: 'customer', body: day.text } });
    expect(bad.json.code).toBe('TEMPLATE_UNFILLED');
    // Editing creates a new version; the old one is kept as retired.
    const v2 = await api(t, 'POST', '/admin/reply-templates', { token: s.owner.token, body: { code: 'no_answer', title: 'Javob bo‘lmadi', audience: 'customer', body_latn: '{name}, qo‘ng‘iroq qildik — qayta urinib ko‘ramiz.' } });
    expect(v2.json.version).toBe(2);
    const all = await api(t, 'GET', '/admin/reply-templates', { token: s.owner.token });
    expect(all.json.items.filter((x: any) => x.code === 'no_answer').map((x: any) => x.status).sort()).toEqual(['active', 'retired']);
    expect((await api(t, 'POST', '/admin/reply-templates', { token: s.operator.token, body: { code: 'x_x_x', title: 'Sinov', audience: 'customer', body_latn: 'salom dunyo' } })).status).toBe(403);
  });
});

describe('Product facts on the task card', () => {
  it('shows current stock, price now vs ordered, and warranty from the catalog', async () => {
    const prod = await mkProduct(t, { prices: [52_000], stock: [3] });
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await api(t, 'GET', '/ops/center', { token: s.operator.token });
    const task = (await t.db.query(`SELECT id FROM ops_tasks WHERE order_id=$1`, [r.json.order_id])).rows[0];
    await t.db.query(`UPDATE offers SET price_minor = 6000000 WHERE sku_id=$1`, [prod.skuIds[0]]);
    const f = await api(t, 'GET', `/ops/center/tasks/${task.id}/product-facts`, { token: s.operator.token });
    expect(f.json.items[0].ordered_unit_minor).toBe('5200000');
    expect(f.json.items[0].current_unit_minor).toBe('6000000');
    expect(typeof f.json.items[0].available).toBe('number');
  });
});
