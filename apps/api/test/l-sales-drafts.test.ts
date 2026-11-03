import { beforeAll, describe, expect, it } from 'vitest';
import { parseMessage } from '../src/modules/partners/parse.js';
import { address, api, balances, fulfilCod, mkPartner, mkProduct, nextPhone, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

const tokenOf = (url: string) => url.split('/f/')[1]!;

describe('Partner cabinet 2.0 — sales drafts (Order Studio)', () => {
  it('T03/T04: partial draft autosaves; missing fields listed; stale tab cannot overwrite (version)', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [200_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const c = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 2 }] } });
    expect(c.status).toBe(200);
    expect(c.json.missing).toEqual(expect.arrayContaining(['customer_name', 'customer_phone', 'address']));
    const id = c.json.id;
    const u1 = await api(t, 'PATCH', `/partner/drafts/${id}`, { token: p.token, body: { expected_version: c.json.version, customer_name: 'Mijoz', customer_phone: '90 123 45 67' } });
    expect(u1.status).toBe(200);
    const stale = await api(t, 'PATCH', `/partner/drafts/${id}`, { token: p.token, body: { expected_version: c.json.version, customer_name: 'Eski' } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    const g = await api(t, 'GET', `/partner/drafts/${id}`, { token: p.token });
    expect(g.json.customer_name).toBe('Mijoz');
    expect(g.json.quote.subtotal.amount_minor).toBe('40000000');
    expect(BigInt(g.json.quote.commission_estimate_minor)).toBe(4000000n);
    const list = await api(t, 'GET', '/partner/drafts', { token: p.token });
    expect(list.json.items.some((d: any) => d.id === id)).toBe(true);
  });

  it('T05/T06/T08: incomplete submit refused; complete submit creates one order (idempotent) awaiting customer SMS', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [150_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const c = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }], customer_name: 'Mijoz', customer_phone: nextPhone(), address_later: true } });
    const bad = await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: p.token });
    expect(bad.status).toBe(422);
    expect(bad.json.details.missing).toContain('address');
    const u = await api(t, 'PATCH', `/partner/drafts/${c.json.id}`, { token: p.token, body: { expected_version: c.json.version, address_later: false, delivery_zone_id: await zoneId(t), address: { district: address.district, street: address.street, house: address.house }, contact_time: 'kechqurun 18:00 dan keyin' } });
    expect(u.status).toBe(200);
    const s1 = await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: p.token });
    expect(s1.status).toBe(200);
    expect(s1.json.status).toBe('awaiting_customer_confirmation');
    const s2 = await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: p.token });
    expect(s2.json.order_id).toBe(s1.json.order_id);
    const n = await t.db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE id=$1`, [s1.json.order_id]);
    expect(n.rows[0].n).toBe(1);
    const o = (await t.db.query(`SELECT channel, contact_time_note, attribution->>'reason' AS r, attributed_partner_id FROM orders WHERE id=$1`, [s1.json.order_id])).rows[0];
    expect(o).toMatchObject({ channel: 'partner_assisted', contact_time_note: 'kechqurun 18:00 dan keyin', r: 'partner_assisted', attributed_partner_id: p.partnerId });
    // T19: operator card shows the contact time
    const card = await api(t, 'GET', `/ops/orders/${s1.json.order_id}`, { token: s.operator.token });
    expect(card.json.contact_time_note ?? card.json.order?.contact_time_note).toBe('kechqurun 18:00 dan keyin');
    // passport + attention see it waiting for the customer's SMS
    const pass = await api(t, 'GET', `/partner/orders/${s1.json.order_id}/passport`, { token: p.token });
    expect(pass.status).toBe(200);
    expect(pass.json).toMatchObject({ source: 'Siz kiritgan buyurtma', attribution: { reason: 'partner_assisted' } });
    expect(pass.json.customer).toMatch(/\*\*\*/);
    expect(JSON.stringify(pass.json)).not.toContain(o.customer_phone ?? '+99891');
    const att = await api(t, 'GET', '/partner/attention', { token: p.token });
    expect(att.json.waiting.some((x: any) => x.kind === 'awaiting_customer_sms' && x.ref_id === s1.json.order_id)).toBe(true);
  });

  it('T28: another partner cannot see, edit, submit or share my draft; cannot open my passport', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [3] });
    const c = await api(t, 'POST', '/partner/drafts', { token: a.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    expect((await api(t, 'GET', `/partner/drafts/${c.json.id}`, { token: b.token })).status).toBe(404);
    expect((await api(t, 'PATCH', `/partner/drafts/${c.json.id}`, { token: b.token, body: { expected_version: 1, note: 'x' } })).status).toBe(404);
    expect((await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: b.token })).status).toBe(404);
    expect((await api(t, 'POST', `/partner/drafts/${c.json.id}/share`, { token: b.token, body: {} })).status).toBe(404);
    expect((await api(t, 'GET', '/partner/drafts', { token: b.token })).json.items.some((d: any) => d.id === c.json.id)).toBe(false);
  });

  it('T09/T10/T11/T12: customer fill link — preview GET changes nothing and leaks no personal data; fill creates order once; revoke/expiry', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [120_000], stock: [4], rule: { kind: 'percent', bps: 1000 } });
    const c = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }], note: 'ichki izoh' } });
    const sh = await api(t, 'POST', `/partner/drafts/${c.json.id}/share`, { token: p.token, body: { hours: 24 } });
    expect(sh.status).toBe(200);
    const tok = tokenOf(sh.json.url);
    for (let i = 0; i < 3; i++) {
      const g = await api(t, 'GET', `/fill/${tok}`);
      expect(g.status).toBe(200);
      expect(g.json.lines.length).toBe(1);
      expect(JSON.stringify(g.json)).not.toMatch(/ichki izoh|partner|display_name/);
    }
    const d0 = (await t.db.query(`SELECT status, order_id FROM sales_drafts WHERE id=$1`, [c.json.id])).rows[0];
    expect(d0).toMatchObject({ status: 'awaiting_customer', order_id: null });
    const att = await api(t, 'GET', '/partner/attention', { token: p.token });
    expect(att.json.waiting.some((x: any) => x.kind === 'fill_link_shared' && x.ref_id === c.json.id)).toBe(true);

    const phone = nextPhone();
    const body = { name: 'Aziza', phone, delivery_zone_id: await zoneId(t), address: { district: 'Chilonzor', street: 'Bunyodkor', house: '7' }, contact_time: 'ertalab', accept_terms: true };
    const f = await api(t, 'POST', `/fill/${tok}`, { body });
    expect(f.status).toBe(200);
    expect(f.json).toMatchObject({ ok: true, next: 'confirm_by_sms' });
    expect((await api(t, 'POST', `/fill/${tok}`, { body })).status).toBe(404); // single use
    const d1 = (await t.db.query(`SELECT status, order_id, source FROM sales_drafts WHERE id=$1`, [c.json.id])).rows[0];
    expect(d1.status).toBe('converted');
    expect(d1.source).toBe('customer_link');
    // the customer confirms with the SMS code → order verified, partner attributed
    const ok = await api(t, 'POST', `/confirm/${f.json.dev_customer_link_token}`, { body: { decision: 'confirm', code: f.json.dev_customer_code } });
    expect(ok.status).toBe(200);
    const o = (await t.db.query(`SELECT attributed_partner_id, confirmation_status FROM orders WHERE id=$1`, [d1.order_id])).rows[0];
    expect(o).toMatchObject({ attributed_partner_id: p.partnerId, confirmation_status: 'verified' });

    // revoke → link dead
    const c2 = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    const sh2 = await api(t, 'POST', `/partner/drafts/${c2.json.id}/share`, { token: p.token, body: {} });
    expect((await api(t, 'POST', `/partner/drafts/${c2.json.id}/revoke-link`, { token: p.token })).status).toBe(200);
    expect((await api(t, 'GET', `/fill/${tokenOf(sh2.json.url)}`)).status).toBe(404);
    // expiry → 410
    const c3 = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    const sh3 = await api(t, 'POST', `/partner/drafts/${c3.json.id}/share`, { token: p.token, body: {} });
    await t.db.query(`UPDATE sales_drafts SET fill_expires_at=now() - interval '1 minute' WHERE id=$1`, [c3.json.id]);
    const ex = await api(t, 'GET', `/fill/${tokenOf(sh3.json.url)}`);
    expect(ex.status).toBe(410);
    expect(ex.json.code).toBe('FILL_LINK_EXPIRED');
    expect((await api(t, 'GET', '/partner/attention', { token: p.token })).json.action.some((x: any) => x.kind === 'fill_link_expired' && x.ref_id === c3.json.id)).toBe(true);
  });

  it('cancel keeps history and closes the draft', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [90_000], stock: [3] });
    const c = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    expect((await api(t, 'DELETE', `/partner/drafts/${c.json.id}`, { token: p.token })).status).toBe(200);
    expect((await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: p.token })).status).toBe(409);
    expect((await t.db.query(`SELECT status FROM sales_drafts WHERE id=$1`, [c.json.id])).rows[0].status).toBe('cancelled');
  });
});

describe('Message → draft parser (T13/T14)', () => {
  const catalog = [
    { product_id: 'p1', slug: 'smart-soat', name: { 'uz-Latn': 'Smart soat X8' }, search_doc: 'smart soat x8 aqlli soat', skus: [{ sku_id: 's1', variant: { rang: 'Qora' }, available: 5 }, { sku_id: 's2', variant: { rang: 'Oq' }, available: 0 }] },
    { product_id: 'p2', slug: 'naushnik', name: { 'uz-Latn': 'Simsiz naushnik' }, search_doc: 'simsiz naushnik bluetooth', skus: [{ sku_id: 's3', variant: {}, available: 9 }] },
  ];
  it('extracts phone, qty, product, colour, postponed address; flags ambiguous time', () => {
    const r = parseMessage('Salom, smart soat qora rangidan 2 ta kerak. Tel 90 123 45 67. Manzilni keyin yuboraman, soat 6 da qo‘ng‘iroq qiling', catalog);
    expect(r.phone?.value).toBe('+998901234567');
    expect(r.qty?.value).toBe(2);
    expect(r.product?.value.product_id).toBe('p1');
    expect(r.sku?.value.sku_id).toBe('s1');
    expect(r.address_later?.value).toBe(true);
    expect(r.contact_time?.confidence).toBe('check');
  });
  it('never invents: no phone / unknown product are warnings, not guesses', () => {
    const r = parseMessage('Assalomu alaykum, narxi qancha?', catalog);
    expect(r.phone).toBeUndefined();
    expect(r.product).toBeUndefined();
    expect(r.warnings).toEqual(expect.arrayContaining(['Telefon raqami topilmadi', 'Mahsulot topilmadi — katalogdan tanlang']));
  });
  it('API parse endpoint works for an active partner', async () => {
    const p = await mkPartner(t);
    const r = await api(t, 'POST', '/partner/drafts/parse', { token: p.token, body: { text: 'Telefon: +998 90 765 43 21, 1 dona' } });
    expect(r.status).toBe(200);
    expect(r.json.phone.value).toBe('+998907654321');
  });
});

describe('Hamyon — commission reasons (T20–T23)', () => {
  it('each line says why it is not yet withdrawable; delivered+settled moves to hold', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [300_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const c = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }], customer_name: 'Mijoz', customer_phone: nextPhone(), delivery_zone_id: await zoneId(t), address: { district: 'Yunusobod', street: 'Amir Temur', house: '1' } } });
    const sub = await api(t, 'POST', `/partner/drafts/${c.json.id}/submit`, { token: p.token });
    expect(sub.status).toBe(200);
    await api(t, 'POST', `/confirm/${sub.json.dev_customer_link_token}`, { body: { decision: 'confirm', code: sub.json.dev_customer_code } });
    const w1 = await api(t, 'GET', '/partner/wallet', { token: p.token });
    expect(w1.status).toBe(200);
    const l1 = w1.json.lines.find((l: any) => l.order_id === sub.json.order_id);
    expect(l1).toMatchObject({ reason: 'not_delivered', reason_label: 'Hali yetkazilmagan', target_minor: '3000000' });
    await fulfilCod(t, s, sub.json.order_id);
    const w2 = await api(t, 'GET', '/partner/wallet', { token: p.token });
    const l2 = w2.json.lines.find((l: any) => l.order_id === sub.json.order_id);
    expect(['hold', 'awaiting_cash']).toContain(l2.reason);
    expect(w2.json.groups.find((g: any) => g.reason === l2.reason).amount_minor).toBe('3000000');
    expect(BigInt(w2.json.balances.pending_minor)).toBe(BigInt((await balances(t, p.partnerId)).p));
    const pass = await api(t, 'GET', `/partner/orders/${sub.json.order_id}/passport`, { token: p.token });
    expect(pass.json.commission.total_minor).toBe('3000000');
    expect(pass.json.commission.lines[0].rule_snapshot).toBeTruthy();
    expect(pass.json.timeline.length).toBeGreaterThan(0);
    // dispute overrides the money reason
    await api(t, 'POST', '/partner/disputes', { token: p.token, body: { order_id: sub.json.order_id, subject: 'Komissiya', body: 'Tekshirib bering' } });
    const w3 = await api(t, 'GET', '/partner/wallet', { token: p.token });
    expect(w3.json.lines.find((l: any) => l.order_id === sub.json.order_id).reason).toBe('dispute');
  });
});
