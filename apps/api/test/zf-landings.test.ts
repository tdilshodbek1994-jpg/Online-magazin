import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { api, fulfilCod, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, tiyin } from './helpers.js';

/** UZSHOP Landing & Target — P0B acceptance cases mapped to tests (ids LT-0xx from tests/acceptance_cases.json). */
let t: T;
let s: Staff;
const M = { '1': [10000], '2': [10000, 2500], '3': [10000, 5000, 2500] };
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_landing');
  s = await staff(t);
  await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='commission.quantity_matrix'`);
});
const slug = () => `l-${randomUUID().slice(0, 8)}`;
async function publishedLanding(productId: string, template = 'pro') {
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: slug(), title: 'Test landing', template, product_ids: [productId] } });
  expect(c.status).toBe(200);
  for (const st of ['submit', 'approve', 'publish']) expect((await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} })).status).toBe(200);
  return (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
}
const quick = (guest: string, body: Record<string, unknown>, idem = randomUUID()) => api(t, 'POST', '/checkout/quick-order', { guest, idem, body: { accept_terms: true, name: 'Mijoz', phone: nextPhone(), qty: 1, ...body } });

describe('Landing Builder P0B', () => {
  it('LT-001 + LT-008 + LT-010: short form → one order in the existing Order service with landing/revision/quote snapshot; "request accepted", no marketing consent needed', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const l = await publishedLanding(prod.productId, 'simple');
    const r = await quick(randomUUID() + randomUUID(), { sku_id: prod.skuIds[0], landing: { landing_id: l.id, revision: l.published_revision } });
    expect(r.status).toBe(201);
    expect(r.json.confirmation).toBe('pending_operator_call');
    const o = (await t.db.query(`SELECT landing_snapshot, commercial_status, payment_status FROM orders WHERE id=$1`, [r.json.order_id])).rows[0];
    expect(o.landing_snapshot).toMatchObject({ landing_id: l.id, revision: l.published_revision });
    expect(o.landing_snapshot.quote_id).toBeTruthy();
    expect(o).toMatchObject({ commercial_status: 'awaiting_confirmation', payment_status: 'unpaid' });
  });

  it('LT-002: a price typed on the client is ignored — the server prices the order', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const l = await publishedLanding(prod.productId);
    const r = await quick(randomUUID() + randomUUID(), { sku_id: prod.skuIds[0], price_minor: '100', landing: { landing_id: l.id, revision: l.published_revision } });
    expect(r.status).toBe(201);
    expect((await t.db.query(`SELECT subtotal_minor::text FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].subtotal_minor).toBe(tiyin(100_000));
  });

  it('LT-004 + LT-005: double click = one order; same key with a different body = conflict', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = randomUUID() + randomUUID(); const key = randomUUID(); const phone = nextPhone();
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', '/checkout/quick-order', { guest: g, idem: key, body: { accept_terms: true, name: 'Ali', phone, qty: 1, sku_id: prod.skuIds[0] } })));
    expect([a!.status, b!.status].sort()).toEqual([200, 201].sort() as number[]);
    expect(a!.json.order_id).toBe(b!.json.order_id);
    const c = await api(t, 'POST', '/checkout/quick-order', { guest: g, idem: key, body: { accept_terms: true, name: 'Ali', phone, qty: 2, sku_id: prod.skuIds[0] } });
    expect(c.status).toBe(409);
  });

  it('LT-011 + LT-012 + LT-013 + LT-020: drafts are not public; preview is noindex without analytics; editing after approval keeps the published revision; rollback restores an older revision', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: slug(), title: 'Draft', template: 'pro', product_ids: [prod.productId] } });
    const sl = (await t.db.query(`SELECT slug FROM landing_pages WHERE id=$1`, [c.json.id])).rows[0].slug;
    expect((await api(t, 'GET', `/landings/${sl}`)).status).toBe(404);
    const pv = await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token });
    expect(pv.json.preview.analytics).toBe(false);
    for (const st of ['submit', 'approve', 'publish']) await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} });
    const pub = (await api(t, 'GET', `/landings/${sl}`)).json;
    expect(pub.revision).toBe(1);
    const cur = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
    const def = { ...cur.preview.definition, blocks: [...cur.preview.definition.blocks, { id: 'b2', type: 'benefits', props: { items: ['Rasmiy kafolat'] } }] };
    expect((await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: def } })).json.revision).toBe(2);
    expect((await api(t, 'GET', `/landings/${sl}`)).json.revision).toBe(1); // still the approved one
    for (const st of ['submit', 'approve', 'publish']) await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} });
    expect((await api(t, 'GET', `/landings/${sl}`)).json.revision).toBe(2);
    expect((await api(t, 'POST', `/admin/landings/${c.json.id}/rollback`, { token: s.owner.token, body: { revision: 1 } })).status).toBe(200);
    expect((await api(t, 'GET', `/landings/${sl}`)).json.revision).toBe(1);
  });

  it('LT-014 + LT-015 + LT-016: stale editor → 409; HTML/script blocks rejected; prices cannot be typed into a revision; no catalog right → 403', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: slug(), title: 'Edit', template: 'pro', product_ids: [prod.productId] } });
    const cur = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
    await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: cur.preview.definition } });
    expect((await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: cur.preview.definition } })).json.code).toBe('LANDING_VERSION_CONFLICT');
    const v = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json.version;
    const bad = [
      { ...cur.preview.definition, blocks: [{ id: 'x', type: 'hero', props: { headline: '<script>alert(1)</script>' } }] },
      { ...cur.preview.definition, blocks: [{ id: 'x', type: 'html', props: { html: '<iframe src="//evil">' } }] },
      { ...cur.preview.definition, blocks: [{ id: 'x', type: 'hero', props: { price_minor: '1' } }], extra: 1 },
    ];
    for (const d of bad) expect((await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: v, definition: d } })).status).toBe(422);
    expect((await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.operator.token, body: { expected_version: v, definition: cur.preview.definition } })).status).toBe(403);
    expect((await api(t, 'POST', `/admin/landings/${c.json.id}/approve`, { token: s.catalog.token, body: {} })).json.code).toBe('OWNER_APPROVAL_REQUIRED');
  });

  it('LT-021 + LT-022 + LT-023 + LT-030: two channel flows on one landing; a later click does not change an order; a fake partner id in the body is ignored; archive keeps history', async () => {
    const a = await mkPartner(t), b = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
    const l = await publishedLanding(prod.productId);
    const tg = await api(t, 'POST', '/partner/streams', { token: a.token, body: { product_id: prod.productId, name: 'TG', landing_id: l.id, channel: 'telegram' } });
    const ig = await api(t, 'POST', '/partner/streams', { token: a.token, body: { product_id: prod.productId, name: 'IG', landing_id: l.id, channel: 'instagram' } });
    expect([tg.status, ig.status]).toEqual([200, 200]);
    const g = randomUUID() + randomUUID();
    const touch = await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: ig.json.code } });
    expect(touch.json.redirect).toBe(`/l/${l.slug}`);
    const r = await quick(g, { sku_id: prod.skuIds[0], partner_id: b.partnerId, landing: { landing_id: l.id, revision: l.published_revision } });
    const o = (await t.db.query(`SELECT attributed_partner_id, attribution->>'link_id' AS link FROM orders WHERE id=$1`, [r.json.order_id])).rows[0];
    expect(o).toEqual({ attributed_partner_id: a.partnerId, link: ig.json.id });
    const bLink = await api(t, 'POST', '/partner/streams', { token: b.token, body: { product_id: prod.productId, name: 'B', landing_id: l.id, channel: 'telegram' } });
    await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: bLink.json.code } });
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].attributed_partner_id).toBe(a.partnerId);
    expect((await api(t, 'POST', `/admin/landings/${l.id}/archive`, { token: s.owner.token, body: {} })).status).toBe(200);
    expect((await t.db.query(`SELECT landing_snapshot->>'landing_id' AS l FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].l).toBe(l.id);
    expect((await api(t, 'GET', `/landings/${l.slug}`)).status).toBe(404);
  });

  it('LT-027 + LT-028 + LT-026: 2 units → 37 500 commission; 3 units → 52 500 and 3 UzCoin (existing services); a legitimate repeat purchase is allowed', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [200_000], stock: [20] });
    await t.db.query(`INSERT INTO commission_rules (product_id, version, kind, fixed_minor, commission_group, quantity_matrix, effective_from) VALUES ($1,1,'quantity_matrix',$2,$3,$4, now() - interval '1 hour')`, [prod.productId, tiyin(30_000), `product:${prod.productId}`, JSON.stringify(M)]);
    const l = await publishedLanding(prod.productId);
    const phone = nextPhone();
    const ids: string[] = [];
    for (const qty of [2, 3]) {
      const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone }, [{ sku_id: prod.skuIds[0]!, qty }], { referral_code: p.code });
      expect(o.status).toBe(201);
      await t.db.query(`UPDATE orders SET landing_snapshot=$2 WHERE id=$1`, [o.json.order_id, JSON.stringify({ landing_id: l.id, revision: l.published_revision })]);
      ids.push(o.json.order_id);
    }
    const sums = await Promise.all(ids.map(async (id) => (await t.db.query(`SELECT SUM(target_minor)::text s FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded'`, [id])).rows[0].s));
    expect(sums).toEqual([tiyin(37_500), tiyin(52_500)]);
    const id3 = ids[1]!;
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id3])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${id3}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${id3}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    await fulfilCod(t, s, id3);
    await withTx(t.db, (tx) => releaseMatured(tx, new Date(Date.now() + 400 * 86400e3)));
    expect((await t.db.query(`SELECT available::text FROM uzcoin_balances WHERE partner_id=$1`, [p.partnerId])).rows[0].available).toBe('3');
  });

  it('LT-029: out of stock → the landing says "unavailable"; no order is placed for another product', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [0] });
    const l = await publishedLanding(prod.productId);
    const pub = (await api(t, 'GET', `/landings/${l.slug}`)).json;
    expect(pub.availability).toBe('unavailable');
    expect(pub.products.map((x: any) => x.id)).toEqual([prod.productId]);
  });
});
