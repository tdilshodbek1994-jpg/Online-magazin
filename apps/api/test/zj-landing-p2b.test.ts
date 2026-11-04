import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { pooledRate } from '../src/modules/landings/experiments.js';
import { setMetaAdapter } from '../src/modules/target/adapter.js';
import { api, mkPartner, mkProduct, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** UZSHOP Landing & Target — P2B quality regression (LT-091…LT-100) on a separate database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_landing_p2b');
  s = await staff(t);
});
const guest = () => randomUUID() + randomUUID();
async function landingWithTwoRevisions() {
  const prod = await mkProduct(t, { prices: [100_000], stock: [50] });
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: `ab-${randomUUID().slice(0, 8)}`, title: 'AB', template: 'pro', product_ids: [prod.productId] } });
  for (const st of ['submit', 'approve', 'publish']) await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} });
  const cur = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
  const def = { ...cur.preview.definition, blocks: [...cur.preview.definition.blocks, { id: 'b-ab', type: 'benefits', props: { items: ['Rasmiy kafolat'] } }] };
  expect((await api(t, 'PUT', `/admin/landings/${c.json.id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: def } })).json.revision).toBe(2);
  return { prod, id: c.json.id as string, slug: cur.slug as string };
}

describe('Landing P2B — A/B + regression', () => {
  it('LT-099: pooled ratio is Σconv/Σn (1/2 + 9/90 = 10/92 ≈ 10.869565%), not an average of percentages', () => {
    expect(pooledRate([{ conv: 1, n: 2 }, { conv: 9, n: 90 }])!.toFixed(6)).toBe('10.869565');
    expect(pooledRate([])).toBeNull();
  });

  it('LT-097 + LT-094: one sticky assignment per visitor; the order stores the experiment revision; personal responses are not shared-cacheable', async () => {
    const { prod, id, slug } = await landingWithTwoRevisions();
    expect((await api(t, 'POST', `/admin/landings/${id}/experiments`, { token: s.catalog.token, body: { variant_b_revision: 2 } })).status).toBe(403);
    const e = await api(t, 'POST', `/admin/landings/${id}/experiments`, { token: s.owner.token, body: { variant_b_revision: 2 } });
    expect(e.status).toBe(200);
    expect((await api(t, 'POST', `/admin/landings/${id}/experiments`, { token: s.owner.token, body: { variant_b_revision: 2 } })).status).toBe(409);
    const g = guest();
    const views = await Promise.all([1, 2, 3].map(() => api(t, 'GET', `/landings/${slug}`, { guest: g })));
    expect(new Set(views.map((v) => v.json.experiment.variant)).size).toBe(1);
    expect(views[0]!.raw.headers['cache-control']).toBe('private, no-store');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM experiment_assignments WHERE experiment_id=$1`, [e.json.id])).rows[0].n).toBe(1);
    const v = views[0]!.json;
    const o = await api(t, 'POST', '/checkout/quick-order', { guest: g, idem: randomUUID(), body: { sku_id: prod.skuIds[0], qty: 1, name: 'Mijoz', phone: nextPhone(), accept_terms: true, landing: { landing_id: id, revision: v.revision } } });
    expect(o.status).toBe(201);
    const snap = (await t.db.query(`SELECT landing_snapshot, experiment_snapshot FROM orders WHERE id=$1`, [o.json.order_id])).rows[0];
    expect(snap.landing_snapshot.revision).toBe(v.revision);
    expect(snap.experiment_snapshot).toMatchObject({ experiment_id: e.json.id, variant: v.experiment.variant, revision: v.revision });
    // a visitor cannot claim the other variant's revision
    const g2 = guest();
    const v2 = (await api(t, 'GET', `/landings/${slug}`, { guest: g2 })).json;
    const claimed = v2.revision === 1 ? 2 : 1;
    const forged = await api(t, 'POST', '/checkout/quick-order', { guest: g2, idem: randomUUID(), body: { sku_id: prod.skuIds[0], qty: 1, name: 'Mijoz', phone: nextPhone(), accept_terms: true, landing: { landing_id: id, revision: claimed } } });
    expect(forged.status).toBe(201); // the order itself is never blocked…
    const fs = (await t.db.query(`SELECT landing_snapshot, experiment_snapshot FROM orders WHERE id=$1`, [forged.json.order_id])).rows[0];
    if (claimed === 2) expect(fs.landing_snapshot).toBeNull(); // …but an unpublished revision the visitor never saw is not recorded as theirs
    expect(fs.experiment_snapshot).toBeNull();
    expect((await api(t, 'GET', '/tracking/config', { guest: g })).raw.headers['cache-control']).toBe('private, no-store');
  });

  it('LT-098: too little evidence → "insufficient data", no automatic winner or publish', async () => {
    const { id } = await landingWithTwoRevisions();
    await api(t, 'POST', `/admin/landings/${id}/experiments`, { token: s.owner.token, body: { variant_b_revision: 2 } });
    const r = await api(t, 'GET', `/admin/landings/${id}/experiments`, { token: s.owner.token });
    expect(r.json.items[0]).toMatchObject({ verdict: 'insufficient_data', auto_winner: null });
    expect((await t.db.query(`SELECT published_revision FROM landing_pages WHERE id=$1`, [id])).rows[0].published_revision).toBe(1);
    expect((await api(t, 'POST', `/admin/experiments/${r.json.items[0].id}/stop`, { token: s.owner.token })).status).toBe(200);
    expect((await t.db.query(`SELECT published_revision FROM landing_pages WHERE id=$1`, [id])).rows[0].published_revision).toBe(1);
  });

  it('LT-091: partner A cannot open partner B flow data', async () => {
    const a = await mkPartner(t), b = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const bl = await api(t, 'POST', '/partner/streams', { token: b.token, body: { product_id: prod.productId, name: 'B' } });
    expect(bl.status).toBe(200);
    const r = await api(t, 'GET', `/partner/links/${bl.json.id}/analytics`, { token: a.token });
    expect([403, 404]).toContain(r.status);
    expect(JSON.stringify(r.json)).not.toContain(bl.json.code);
  });

  it('LT-092: operator role has no budget/dataset/campaign rights', async () => {
    const { id } = await landingWithTwoRevisions();
    for (const [m, u, body] of [
      ['POST', `/admin/landings/${id}/spend`, { channel: 'meta_mixed', amount: '1000', service_from: '2026-11-01', service_to: '2026-11-01' }],
      ['GET', '/admin/ad-campaigns', undefined], ['POST', '/admin/ad-campaigns', { landing_id: id }], ['PUT', '/admin/tracking/settings', { dataset_id: '123456789' }],
      ['POST', '/admin/ad-safety/envelopes', { total_minor: '100' }], ['GET', '/admin/meta/connection', undefined],
    ] as const) expect((await api(t, m as any, u, { token: s.operator.token, body })).status, u).toBe(403);
  });

  it('LT-095: no server-side fetch of arbitrary media URLs — internal/private URLs are refused by the block schema', async () => {
    const { id } = await landingWithTwoRevisions();
    const cur = (await api(t, 'GET', `/admin/landings/${id}`, { token: s.owner.token })).json;
    for (const ref of ['http://169.254.169.254/latest/meta-data', 'http://localhost:5432', 'file:///etc/passwd', '//10.0.0.1/a.mp4']) {
      const def = { ...cur.preview.definition, blocks: [...cur.preview.definition.blocks, { id: 'v1', type: 'video', props: { provider: 'media', ref } }] };
      expect((await api(t, 'PUT', `/admin/landings/${id}/draft`, { token: s.owner.token, body: { expected_version: cur.version, definition: def } })).json.code).toBe('LANDING_SCHEMA_INVALID');
    }
  });

  it('LT-096: an old referral link (no landing) keeps working and attributing; one tracking mapping only', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const link = await api(t, 'POST', '/partner/links', { token: p.token, body: { product_id: prod.productId } });
    const g = guest();
    const touch = await api(t, 'POST', '/referrals/touch', { guest: g, body: { code: link.json.code } });
    expect(touch.json.redirect).toBe(`/p/${prod.slug}`);
    const o = await placeOrder(t, { guest: g, phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].attributed_partner_id).toBe(p.partnerId);
    expect((await t.db.query(`SELECT COUNT(DISTINCT mapping_version)::int n FROM tracking_event_dictionary`)).rows[0].n).toBe(1);
  });

  it('LT-100: with Meta/AI/tracking/live-spend all off the shop still sells', async () => {
    setMetaAdapter(null);
    await t.db.query(`UPDATE tracking_settings SET enabled=false, dataset_id=NULL WHERE id=1`);
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key IN ('ai.enabled','ads.live_spend','ads.provider_sync')`);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const q = await api(t, 'POST', '/checkout/quick-order', { guest: guest(), idem: randomUUID(), body: { sku_id: prod.skuIds[0], qty: 1, name: 'Mijoz', phone: nextPhone(), accept_terms: true } });
    expect(q.status).toBe(201);
    const c = await placeOrder(t, { guest: guest(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(c.status).toBe(201);
  });
});
