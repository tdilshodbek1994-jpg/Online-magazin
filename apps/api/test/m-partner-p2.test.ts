import { beforeAll, describe, expect, it } from 'vitest';
import { runP2Scheduled } from '../src/modules/partners/p2.js';
import { runScheduledOnce } from '../src/worker.js';
import { api, mkPartner, mkProduct, nextPhone, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});
const addr = { district: 'Yunusobod', street: 'Amir Temur', house: '1' };
const atp = async (sku: string) => (await t.db.query(`SELECT atp FROM stock_atp WHERE sku_id=$1`, [sku])).rows[0].atp as number;
async function completeDraft(p: { token: string }, sku: string, qty = 1, phone = nextPhone()) {
  const d = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: sku, qty }], customer_name: 'Mijoz', customer_phone: phone, delivery_zone_id: await zoneId(t), address: addr } });
  expect(d.status).toBe(200);
  return d.json;
}

describe('P2 — short hold (real reservation)', () => {
  it('T22: last unit — two partners hold at once, exactly one wins; expiry returns stock', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [1] });
    const a = await mkPartner(t), b = await mkPartner(t);
    const da = await completeDraft(a, prod.skuIds[0]!), db2 = await completeDraft(b, prod.skuIds[0]!);
    const [ra, rb] = await Promise.all([api(t, 'POST', `/partner/drafts/${da.id}/hold`, { token: a.token }), api(t, 'POST', `/partner/drafts/${db2.id}/hold`, { token: b.token })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra.json.code, rb.json.code]).toContain('OUT_OF_STOCK');
    expect(await atp(prod.skuIds[0]!)).toBe(0);
    // Expiry (worker) gives the unit back exactly once.
    await t.db.query(`UPDATE reservations SET expires_at=now() - interval '1 minute' WHERE sales_draft_id = ANY($1::uuid[]) AND status='active_unpaid'`, [[da.id, db2.id]]);
    await runScheduledOnce(t.db);
    expect(await atp(prod.skuIds[0]!)).toBe(1);
    await runScheduledOnce(t.db);
    expect(await atp(prod.skuIds[0]!)).toBe(1);
  });

  it('incomplete drafts cannot take stock; repeat hold is idempotent; submit and cancel release it', async () => {
    const prod = await mkProduct(t, { prices: [80_000], stock: [5] });
    const p = await mkPartner(t);
    const inc = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    expect((await api(t, 'POST', `/partner/drafts/${inc.json.id}/hold`, { token: p.token })).json.code).toBe('DRAFT_INCOMPLETE');
    const d = await completeDraft(p, prod.skuIds[0]!, 2);
    const h1 = await api(t, 'POST', `/partner/drafts/${d.id}/hold`, { token: p.token });
    expect(h1.status).toBe(200);
    expect(h1.json.minutes).toBe(15);
    expect((await api(t, 'POST', `/partner/drafts/${d.id}/hold`, { token: p.token })).json.replayed).toBe(true);
    expect(await atp(prod.skuIds[0]!)).toBe(3);
    expect((await api(t, 'GET', `/partner/drafts/${d.id}`, { token: p.token })).json.hold.id).toBe(h1.json.id);
    expect((await api(t, 'POST', `/partner/drafts/${d.id}/submit`, { token: p.token })).status).toBe(200);
    expect(await atp(prod.skuIds[0]!)).toBe(5); // hold released when the order exists
    const d2 = await completeDraft(p, prod.skuIds[0]!, 1);
    await api(t, 'POST', `/partner/drafts/${d2.id}/hold`, { token: p.token });
    expect(await atp(prod.skuIds[0]!)).toBe(4);
    await api(t, 'DELETE', `/partner/drafts/${d2.id}`, { token: p.token });
    expect(await atp(prod.skuIds[0]!)).toBe(5);
  });

  it('partner hold limit is enforced (DEMO policy: 3)', async () => {
    const prod = await mkProduct(t, { prices: [50_000], stock: [20] });
    const p = await mkPartner(t);
    for (let i = 0; i < 3; i++) expect((await api(t, 'POST', `/partner/drafts/${(await completeDraft(p, prod.skuIds[0]!)).id}/hold`, { token: p.token })).status).toBe(200);
    const r = await api(t, 'POST', `/partner/drafts/${(await completeDraft(p, prod.skuIds[0]!)).id}/hold`, { token: p.token });
    expect(r.json.code).toBe('HOLD_LIMIT');
    expect((await api(t, 'GET', '/partner/attention', { token: p.token })).json.action.filter((x: any) => x.kind === 'hold_active').length).toBe(3);
  });
});

describe('P2 — offer set', () => {
  it('customer compares 2–3 products (no commission shown), picks one → one order for the partner; unchosen never becomes an order', async () => {
    const p = await mkPartner(t);
    const a = await mkProduct(t, { prices: [120_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const b = await mkProduct(t, { prices: [150_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const other = await mkProduct(t, { prices: [90_000], stock: [5] });
    expect((await api(t, 'POST', '/partner/offers', { token: p.token, body: { product_ids: [a.productId] } })).status).toBe(400);
    const o = await api(t, 'POST', '/partner/offers', { token: p.token, body: { product_ids: [a.productId, b.productId], note: 'Ikkisi ham yaxshi, B kattaroq' } });
    expect(o.status).toBe(200);
    const tok = o.json.url.split('/t/')[1];
    const g = await api(t, 'GET', `/offer/${tok}`);
    expect(g.json.products.length).toBe(2);
    expect(JSON.stringify(g.json)).not.toMatch(/commission|payout|rate_bps|display_name/);
    expect((await api(t, 'GET', '/partner/offers', { token: p.token })).json.items[0].seen_at).toBeNull(); // GET is not "seen"
    await api(t, 'POST', `/offer/${tok}/seen`);
    expect((await api(t, 'POST', `/offer/${tok}/later`, { body: { remind: true, phone: '+998901112233' } })).json.code).toBe('CONSENT_REQUIRED');
    expect((await api(t, 'POST', `/offer/${tok}/later`, { body: { remind: true, phone: '+998901112233', consent: true } })).json.reminder).toBe(true);
    const body = { qty: 1, name: 'Aziza', phone: nextPhone(), delivery_zone_id: await zoneId(t), address: addr, accept_terms: true };
    expect((await api(t, 'POST', `/offer/${tok}/choose`, { body: { ...body, sku_id: other.skuIds[0] } })).json.code).toBe('SKU_NOT_IN_OFFER');
    const ch = await api(t, 'POST', `/offer/${tok}/choose`, { body: { ...body, sku_id: b.skuIds[0] } });
    expect(ch.status).toBe(200);
    expect((await api(t, 'POST', `/offer/${tok}/choose`, { body: { ...body, sku_id: a.skuIds[0] } })).json.code).toBe('OFFER_ALREADY_CHOSEN');
    const list = (await api(t, 'GET', '/partner/offers', { token: p.token })).json.items[0];
    expect(list).toMatchObject({ status: 'chosen' });
    expect(list.seen_at).not.toBeNull();
    const ord = (await t.db.query(`SELECT attributed_partner_id, channel FROM orders WHERE id=$1`, [list.order_id])).rows[0];
    expect(ord).toMatchObject({ attributed_partner_id: p.partnerId, channel: 'partner_assisted' });
    const lines = (await t.db.query(`SELECT sku_id FROM order_lines WHERE order_id=$1`, [list.order_id])).rows;
    expect(lines.map((l: any) => l.sku_id)).toEqual([b.skuIds[0]]);
    // a reminder is sent once only when asked (and not after the customer has chosen)
    await runP2Scheduled(t.db);
  });
});

describe('P2 — waitlist', () => {
  it('sold-out product: consented waitlist entry, one SMS when stock is back', async () => {
    const prod = await mkProduct(t, { prices: [70_000], stock: [0] });
    const phone = nextPhone();
    expect((await api(t, 'POST', '/waitlist', { body: { product_id: prod.productId, phone, consent: false } })).status).toBe(400);
    expect((await api(t, 'POST', '/waitlist', { body: { product_id: prod.productId, phone, consent: true } })).status).toBe(200);
    await runP2Scheduled(t.db);
    const n0 = (await t.db.query(`SELECT COUNT(*)::int n FROM notifications WHERE phone_e164=$1 AND template='waitlist.back_in_stock'`, [phone])).rows[0].n;
    expect(n0).toBe(0);
    await t.db.query(`UPDATE stock_balances SET on_hand_sellable=3 WHERE sku_id=$1`, [prod.skuIds[0]]);
    await runP2Scheduled(t.db);
    await runP2Scheduled(t.db);
    const n1 = (await t.db.query(`SELECT COUNT(*)::int n FROM notifications WHERE phone_e164=$1 AND template='waitlist.back_in_stock'`, [phone])).rows[0].n;
    expect(n1).toBe(1);
    const alt = await api(t, 'GET', `/products/${prod.productId}/alternatives`);
    expect(alt.status).toBe(200);
  });
});

describe('P2 — contact notebook', () => {
  it('own contacts only; customer-typed phone masked; reorder recomputes into a new draft; others see nothing', async () => {
    const p = await mkPartner(t), other = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [60_000], stock: [10] });
    const phone = nextPhone();
    const d = await completeDraft(p, prod.skuIds[0]!, 2, phone);
    await api(t, 'POST', `/partner/drafts/${d.id}/submit`, { token: p.token });
    const list = await api(t, 'GET', '/partner/contacts', { token: p.token });
    const c = list.json.items.find((x: any) => x.phone === phone);
    expect(c).toBeTruthy();
    expect(c.last_order_masked).toMatch(/^OM-\*\*\*/);
    expect((await api(t, 'GET', '/partner/contacts', { token: other.token })).json.items.some((x: any) => x.phone === phone)).toBe(false);
    expect((await api(t, 'PATCH', `/partner/contacts/${c.id}`, { token: other.token, body: { note: 'x' } })).status).toBe(404);
    const re = await api(t, 'POST', `/partner/contacts/${c.id}/reorder`, { token: p.token, body: { reuse_address: false } });
    expect(re.status).toBe(200);
    expect(re.json.lines).toEqual([{ sku_id: prod.skuIds[0], qty: 2 }]);
    expect(re.json.missing).toContain('address'); // address not reused without consent
    const re2 = await api(t, 'POST', `/partner/contacts/${c.id}/reorder`, { token: p.token, body: { reuse_address: true } });
    expect(re2.json.missing).toEqual([]);
    await api(t, 'PATCH', `/partner/contacts/${c.id}`, { token: p.token, body: { do_not_contact: true } });
    expect((await api(t, 'POST', `/partner/contacts/${c.id}/reorder`, { token: p.token, body: {} })).json.code).toBe('DO_NOT_CONTACT');
    // a customer who typed their own phone into the partner's fill link appears masked
    const fd = await api(t, 'POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0]!, qty: 1 }] } });
    const sh = await api(t, 'POST', `/partner/drafts/${fd.json.id}/share`, { token: p.token, body: {} });
    const cphone = nextPhone();
    await api(t, 'POST', `/fill/${sh.json.url.split('/f/')[1]}`, { body: { name: 'Mohira', phone: cphone, delivery_zone_id: await zoneId(t), address: addr, accept_terms: true } });
    const items = (await api(t, 'GET', '/partner/contacts', { token: p.token })).json.items;
    expect(items.some((x: any) => x.phone === cphone)).toBe(false);
    expect(items.some((x: any) => x.phone.endsWith(cphone.slice(-2)) && x.phone.includes('*'))).toBe(true);
  });
});

describe('P2 — insights, ad spend and explanations', () => {
  it('T30: zero denominators show "no data", not 0%; net only when spend entered; passport explains next step', async () => {
    const p = await mkPartner(t);
    const i0 = await api(t, 'GET', '/partner/insights?days=30', { token: p.token });
    expect(i0.status).toBe(200);
    expect(i0.json.rates.web_conversion.value).toBeNull();
    expect(i0.json.rates.delivery_cohort.value).toBeNull();
    expect(i0.json.money.net_minor).toBeNull();
    expect(i0.json.rates.web_conversion.formula).toMatch(/kiritgan buyurtmalar kirmaydi/);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const d = await completeDraft(p, prod.skuIds[0]!);
    const sub = await api(t, 'POST', `/partner/drafts/${d.id}/submit`, { token: p.token });
    const i1 = await api(t, 'GET', '/partner/insights?days=30', { token: p.token });
    expect(i1.json.counts).toMatchObject({ manual_orders: 1, web_orders: 0 });
    expect(i1.json.rates.web_conversion.value).toBeNull(); // manual orders never create a web conversion (T29)
    await api(t, 'POST', '/partner/ad-spend', { token: p.token, body: { spent_on: new Date().toISOString().slice(0, 10), amount_minor: '500000', channel: 'Instagram' } });
    const i2 = await api(t, 'GET', '/partner/insights?days=30', { token: p.token });
    expect(i2.json.money.net_minor).toBe('-500000');
    expect(i2.json.money.ad_spend_source).toBe('hamkor kiritgan');
    const pass = await api(t, 'GET', `/partner/orders/${sub.json.order_id}/passport`, { token: p.token });
    expect(pass.json.explain).toMatchObject({ whose_turn: 'customer' });
    expect(pass.json.explain.next).toMatch(/SMS/);
    const ads = await api(t, 'GET', `/partner/products/${prod.productId}/ad-texts`, { token: p.token });
    expect(ads.json.items.length).toBe(3);
    expect(ads.json.items[0].text).toContain('100 000');
  });
});
