import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatchTracking, hashOnce, sanitizeSourceUrl, sha256, type TrackingTransport } from '../src/modules/tracking/service.js';
import { address, api, fulfilCod, mkPartner, mkProduct, mkUser, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, zoneId } from './helpers.js';

/** UZSHOP Landing & Target — P0C acceptance cases (LT-041…LT-060) on a separate database. */
let t: T;
let s: Staff;
let policy: string;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_tracking');
  s = await staff(t);
  policy = (await api(t, 'GET', '/tracking/config')).json.consent_policy_version;
});
const guest = () => randomUUID() + randomUUID();
const consent = (g: string, status = 'granted') => api(t, 'POST', '/tracking/consent', { guest: g, body: { status, policy_version: policy } });
const FBP = 'fb.1.1730000000000.1234567890';
const FBC = 'fb.1.1730000000000.IwAR0abcDEF';
const events = async (orderId: string) => (await t.db.query(`SELECT * FROM tracking_events WHERE order_id=$1 ORDER BY created_at`, [orderId])).rows;
async function confirm(orderId: string) {
  const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0].payable_minor;
  await api(t, 'POST', `/ops/orders/${orderId}/claim`, { token: s.operator.token });
  const o = (await t.db.query(`SELECT version, address_snapshot FROM orders WHERE id=$1`, [orderId])).rows[0];
  if (o.address_snapshot?.quick) expect((await api(t, 'PATCH', `/ops/orders/${orderId}/address`, { token: s.operator.token, body: { expected_version: o.version, address: { district: 'Chilonzor', street: 'Bunyodkor', house: '12' }, reason: 'mijoz qo‘ng‘iroqda aytdi' } })).status).toBe(200);
  const r = await api(t, 'POST', `/ops/orders/${orderId}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
  expect(r.status).toBe(200);
}
async function quickOrder(g: string, skuId: string, tracking?: Record<string, string>) {
  const r = await api(t, 'POST', '/checkout/quick-order', { guest: g, idem: randomUUID(), body: { sku_id: skuId, qty: 2, name: 'Mijoz', phone: nextPhone(), accept_terms: true, ...(tracking ? { tracking } : {}) } });
  expect(r.status).toBe(201);
  return r.json;
}
async function connect() {
  await t.db.query(`UPDATE tracking_settings SET enabled=true, dataset_id='123456789012', credentials_ref='vault://test/meta', api_version='v21.0' WHERE id=1`);
}
async function disconnect() {
  await t.db.query(`UPDATE tracking_settings SET enabled=false, dataset_id=NULL, credentials_ref=NULL, test_event_code=NULL WHERE id=1`);
}
function fakeTransport(outcome: 'sent' | 'rejected' | 'unknown' | 'throw' = 'sent') {
  const calls: any[] = [];
  const tr: TrackingTransport = { send: async (req) => { calls.push(req); if (outcome === 'throw') throw new Error('ETIMEDOUT'); return { outcome, http_status: outcome === 'sent' ? 200 : outcome === 'rejected' ? 400 : undefined, detail: outcome === 'rejected' ? 'invalid_parameter' : undefined }; } };
  return { tr, calls };
}

describe('Tracking P0C', () => {
  it('LT-041: ViewContent from a real product view carries the catalog product id and server value, no private fields', async () => {
    const prod = await mkProduct(t, { prices: [150_000], stock: [5] });
    const g = guest();
    await consent(g);
    const r = await api(t, 'POST', '/tracking/events', { guest: g, body: { event: 'product.viewed', event_id: randomUUID(), product_id: prod.productId, source_url: `https://uzshop.uz/p/x?phone=998901234567&utm_source=ig` } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accepted: true, event_name: 'ViewContent' });
    const e = (await t.db.query(`SELECT * FROM tracking_events WHERE event_id=$1`, [r.json.event_id])).rows[0];
    expect(e.custom_data).toMatchObject({ content_ids: [prod.productId], currency: 'UZS', value: '150000.00' });
    expect(JSON.stringify(e)).not.toMatch(/99890|Mijoz/);
    expect(e.source_url).toBe('https://uzshop.uz/p/x?utm_source=ig');
    // client cannot inject a value, a dataset or an order total
    expect((await api(t, 'POST', '/tracking/events', { guest: g, body: { event: 'product.viewed', event_id: randomUUID(), product_id: prod.productId, value: '1' } })).status).toBe(400);
  });

  it('LT-042: a failed AddToCart records no success event; an accepted one records exactly one', async () => {
    const prod = await mkProduct(t, { prices: [50_000], stock: [5] });
    const g = guest();
    await consent(g);
    const bad = await api(t, 'PUT', '/cart/lines', { guest: g, body: { sku_id: randomUUID(), qty: 1 } });
    expect(bad.status).toBe(404);
    const subj = `g:${sha256(g)}`;
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM tracking_events WHERE subject_key=$1 AND internal_event='cart.item_added'`, [subj])).rows[0].n).toBe(0);
    const ok = await api(t, 'PUT', '/cart/lines', { guest: g, body: { sku_id: prod.skuIds[0], qty: 2 } });
    expect(ok.json.tracking.event_name).toBe('AddToCart');
    const lowered = await api(t, 'PUT', '/cart/lines', { guest: g, body: { sku_id: prod.skuIds[0], qty: 1 } });
    expect(lowered.json.tracking).toBeNull();
    const rows = (await t.db.query(`SELECT custom_data FROM tracking_events WHERE subject_key=$1 AND internal_event='cart.item_added'`, [subj])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].custom_data).toMatchObject({ value: '100000.00', num_items: 2 });
  });

  it('LT-043 + LT-046: an order request = Lead, no Purchase; COD delivered but not remitted = still no Purchase (internal delivered kept)', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!, { fbp: FBP });
    expect(o.tracking.event_name).toBe('Lead');
    let ev = await events(o.order_id);
    expect(ev.map((e) => e.meta_event)).toEqual(['Lead']);
    expect(ev[0].user_data.fbp).toBe(FBP);
    await confirm(o.order_id);
    for (const step of ['pick', 'pack']) await api(t, 'POST', `/ops/orders/${o.order_id}/${step}`, { token: s.warehouse.token });
    await api(t, 'POST', `/ops/orders/${o.order_id}/ship`, { token: s.warehouse.token, body: { courier_user_id: s.courier.id, tracking_id: 'T' } });
    expect((await api(t, 'POST', `/courier/orders/${o.order_id}/deliver`, { token: s.courier.token, body: { proof: { method: 'otp', value: '1' } } })).status).toBe(200);
    ev = await events(o.order_id);
    expect(ev.map((e) => e.internal_event)).toEqual(['customer.request_accepted', 'order.delivered']);
    expect(ev.find((e) => e.internal_event === 'order.delivered').status).toBe('internal');
    expect(ev.some((e) => e.meta_event === 'Purchase')).toBe(false);
  });

  it('LT-047 + LT-049: COD delivered + remittance reconciled → exactly one Purchase with real value/time; reload/replay creates no new identity', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    await confirm(o.order_id);
    await fulfilCod(t, s, o.order_id);
    const p = (await events(o.order_id)).filter((e) => e.meta_event === 'Purchase');
    expect(p).toHaveLength(1);
    const ord = (await t.db.query(`SELECT payable_minor::text, paid_at, delivered_at FROM orders WHERE id=$1`, [o.order_id])).rows[0];
    expect(p[0].custom_data.value).toBe(`${BigInt(ord.payable_minor) / 100n}.00`);
    expect(new Date(p[0].event_time).getTime()).toBe(new Date(ord.paid_at).getTime());
    const lead = (await events(o.order_id)).find((e) => e.meta_event === 'Lead');
    expect(lead.event_id).not.toBe(p[0].event_id); // Lead ≠ Purchase
    const { maybeRecognizeSale } = await import('../src/modules/tracking/service.js');
    const again = await maybeRecognizeSale(t.db, o.order_id);
    expect(again).toMatchObject({ event_id: p[0].event_id, created: false });
    expect((await events(o.order_id)).filter((e) => e.meta_event === 'Purchase')).toHaveLength(1);
  });

  it('LT-044 + LT-045: payment authorization creates no Purchase; captured prepaid → one Purchase (replays still one)', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await mkUser(t);
    await api(t, 'POST', '/tracking/consent', { token: c.token, body: { status: 'granted', policy_version: policy } });
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { payment: 'online' });
    expect(r.status).toBe(201);
    const orderId = r.json.order_id as string;
    const amount = Number((await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0].payable_minor);
    const auth = { authorization: 'Basic ' + Buffer.from('Paycom:test-payme-key').toString('base64') };
    const pm = (method: string, params: Record<string, unknown>) => api(t, 'POST', '/api/v1/webhooks/payments/payme', { headers: auth, body: { jsonrpc: '2.0', id: 1, method, params } });
    const pid = `pm-${randomUUID()}`;
    expect((await pm('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } })).json.result.state).toBe(1);
    expect((await events(orderId)).some((e) => e.meta_event === 'Purchase')).toBe(false);
    await Promise.all([1, 2, 3].map(() => pm('PerformTransaction', { id: pid })));
    const p = (await events(orderId)).filter((e) => e.meta_event === 'Purchase');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: 'pending', action_source: 'website' });
    expect(p[0].custom_data).toMatchObject({ currency: 'UZS', value: `${amount / 100}.00`, num_items: 1 });
  });

  it('LT-048: browser and server share one event id and name; the local ledger holds one business event', async () => {
    const prod = await mkProduct(t, { prices: [80_000], stock: [5] });
    const g = guest();
    await consent(g);
    const id = randomUUID();
    const body = { event: 'product.viewed', event_id: id, product_id: prod.productId };
    const [a, b] = await Promise.all([api(t, 'POST', '/tracking/events', { guest: g, body }), api(t, 'POST', '/tracking/events', { guest: g, body })]);
    expect(a.json.event_id).toBe(id);
    expect(b.json.event_id).toBe(id);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM tracking_events WHERE event_id=$1`, [id])).rows[0].n).toBe(1);
    // the same id from a different visitor is refused, never merged
    const g2 = guest();
    await consent(g2);
    expect((await api(t, 'POST', '/tracking/events', { guest: g2, body })).status).toBe(409);
  });

  it('LT-050: refund is an internal correction only — no negative Purchase', async () => {
    const { recordRefund } = await import('../src/modules/tracking/service.js');
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    await confirm(o.order_id);
    await fulfilCod(t, s, o.order_id);
    await recordRefund(t.db, o.order_id, `refund:${randomUUID()}`, '5000000');
    const ev = await events(o.order_id);
    const refund = ev.find((e) => e.internal_event === 'order.refunded');
    expect(refund).toMatchObject({ status: 'internal', meta_event: null });
    expect(refund.custom_data.refund_value).toBe('50000.00');
    const purchases = ev.filter((e) => e.meta_event === 'Purchase');
    expect(purchases).toHaveLength(1);
    expect(Number(purchases[0].custom_data.value)).toBeGreaterThan(0);
  });

  it('LT-051: no consent → no pixel config, browser events refused, order works, server events never exported', async () => {
    await connect();
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    expect((await api(t, 'GET', '/tracking/config', { guest: g })).json).toMatchObject({ consent_required: true, pixel: null });
    const r = await api(t, 'POST', '/tracking/events', { guest: g, body: { event: 'product.viewed', event_id: randomUUID(), product_id: prod.productId } });
    expect(r.status).toBe(202);
    expect(r.json.reason).toBe('NO_CONSENT');
    await consent(g, 'denied');
    const o = await quickOrder(g, prod.skuIds[0]!, { fbp: FBP, fbc: FBC });
    expect(o.tracking).toBeNull();
    const ev = await events(o.order_id);
    expect(ev[0]).toMatchObject({ status: 'suppressed', blocked_reason: 'no_consent', user_data: {} });
    const { tr, calls } = fakeTransport();
    await dispatchTracking(t.db, 'test', tr);
    expect(calls.flatMap((c) => c.events).some((e: any) => e.event_id === ev[0].event_id)).toBe(false);
    const ctx = (await t.db.query(`SELECT tracking_context FROM orders WHERE id=$1`, [o.order_id])).rows[0].tracking_context;
    expect(ctx).toMatchObject({ fbp: null, fbc: null });
    await disconnect();
  });

  it('LT-052: withdrawn consent stops a pending export — checked again right before sending', async () => {
    await connect();
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    expect((await events(o.order_id))[0].status).toBe('pending');
    await consent(g, 'withdrawn');
    const { tr, calls } = fakeTransport();
    await dispatchTracking(t.db, 'test', tr);
    expect(calls.flatMap((c) => c.events).some((e: any) => e.event_id === o.tracking.event_id)).toBe(false);
    expect((await events(o.order_id))[0]).toMatchObject({ status: 'suppressed', blocked_reason: 'consent_withdrawn' });
    await disconnect();
  });

  it('LT-053 + LT-054 + LT-055: phone/email removed from source URL; no click id invented; hashes are not re-hashed', async () => {
    expect(sanitizeSourceUrl('https://uzshop.uz/l/blender?phone=%2B998901234567&email=a%40b.uz&utm_campaign=x#addr')).toBe('https://uzshop.uz/l/blender?utm_campaign=x');
    expect(sanitizeSourceUrl('https://uzshop.uz/l/+998901234567/blender')).toBe('https://uzshop.uz/l/blender');
    expect(sanitizeSourceUrl('javascript:alert(1)')).toBeNull();
    const h = hashOnce('998901234567');
    expect(hashOnce(h)).toBe(h);
    expect(hashOnce(' 998901234567 ')).toBe(h);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!, { fbp: 'not-a-cookie' });
    const lead = (await events(o.order_id))[0];
    expect(lead.user_data.fbc).toBeUndefined();
    expect(lead.user_data.fbp).toBeUndefined();
    expect(lead.user_data.ph).toHaveLength(1);
    expect(lead.user_data.ph[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('LT-056: one owner dataset only — partners cannot set a dataset; on-behalf orders carry no partner browser identity and no Lead', async () => {
    const p = await mkPartner(t);
    expect((await api(t, 'PUT', '/admin/tracking/settings', { token: p.token, body: { dataset_id: '999999999' } })).status).toBe(403);
    expect((await api(t, 'PUT', '/admin/tracking/settings', { token: s.catalog.token, body: { dataset_id: '999999999' } })).status).toBe(403);
    expect((await api(t, 'POST', '/tracking/events', { guest: guest(), body: { event: 'landing.rendered', event_id: randomUUID(), dataset_id: '999999999' } })).status).toBe(400);
    await api(t, 'POST', '/tracking/consent', { token: p.token, body: { status: 'granted', policy_version: policy } });
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const q = await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: nextPhone() } } });
    const o = await api(t, 'POST', '/partner/orders', { token: p.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda kelishildi' } });
    expect(o.status).toBe(201);
    const ctx = (await t.db.query(`SELECT tracking_context FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].tracking_context;
    expect(ctx).toMatchObject({ on_behalf: true, subject: null, consent: null, fbp: null, fbc: null });
    expect(await events(o.json.order_id)).toHaveLength(0);
  });

  it('LT-057 + LT-058: restart/double run keeps one identity; timeout → unknown, replayed with the same id and time; no double commission', async () => {
    await connect();
    await t.db.query(`UPDATE tracking_events SET status='suppressed', blocked_reason='test_cleanup' WHERE status IN ('pending','blocked','unknown')`);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    const before = (await events(o.order_id))[0];
    const slow = fakeTransport('throw');
    await dispatchTracking(t.db, 'test', slow.tr);
    let e = (await events(o.order_id))[0];
    expect(e).toMatchObject({ status: 'unknown', event_id: before.event_id, attempts: 1 });
    expect(new Date(e.event_time).getTime()).toBe(new Date(before.event_time).getTime());
    const ok = fakeTransport('sent');
    await Promise.all([dispatchTracking(t.db, 'test', ok.tr), dispatchTracking(t.db, 'test', ok.tr)]);
    e = (await events(o.order_id))[0];
    expect(e.status).toBe('sent');
    const sentIds = ok.calls.flatMap((c) => c.events).map((x: any) => x.event_id);
    expect(sentIds.filter((x: string) => x === before.event_id)).toHaveLength(1);
    expect(slow.calls[0].events[0]).toMatchObject({ event_id: before.event_id, event_name: 'Lead', event_time: Math.floor(new Date(before.event_time).getTime() / 1000) });
    expect(slow.calls[0].dataset_id).toBe('123456789012');
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM commission_accruals WHERE order_id=$1`, [o.order_id])).rows[0].n).toBe(0);
    await disconnect();
  });

  it('LT-059: a late event keeps its real time and becomes expired', async () => {
    await connect();
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    const old = new Date(Date.now() - 30 * 86_400_000);
    await t.db.query(`UPDATE tracking_events SET event_time=$2 WHERE order_id=$1`, [o.order_id, old]);
    const { tr, calls } = fakeTransport();
    await dispatchTracking(t.db, 'test', tr);
    const e = (await events(o.order_id))[0];
    expect(e).toMatchObject({ status: 'expired', blocked_reason: 'outside_provider_window' });
    expect(new Date(e.event_time).getTime()).toBe(old.getTime());
    expect(calls.flatMap((c) => c.events).some((x: any) => x.event_id === e.event_id)).toBe(false);
    await disconnect();
  });

  it('LT-060: synthetic/test events are blocked from the live dataset in production; test code refused in production settings', async () => {
    await connect();
    const { recordEvent } = await import('../src/modules/tracking/service.js');
    const g = guest();
    await consent(g);
    const subj = `g:${sha256(g)}`;
    const c = (await t.db.query(`SELECT id::text, status FROM tracking_consents WHERE subject_key=$1 ORDER BY id DESC LIMIT 1`, [subj])).rows[0];
    const e = await recordEvent(t.db, { businessKey: `synthetic:${randomUUID()}`, internalEvent: 'sale.recognized', eventTime: new Date(), actionSource: 'website', subject: subj, consent: c, isTest: true, customData: { value: '1.00', currency: 'UZS' } });
    const { tr, calls } = fakeTransport();
    await dispatchTracking(t.db, 'production', tr);
    expect((await t.db.query(`SELECT status, blocked_reason FROM tracking_events WHERE event_id=$1`, [e.event_id])).rows[0]).toEqual({ status: 'rejected', blocked_reason: 'test_event_in_production' });
    expect(calls.flatMap((x) => x.events).some((x: any) => x.event_id === e.event_id)).toBe(false);
    await disconnect();
  });

  it('P0C readiness: without dataset/credentials events stay blocked with a reason, checkout keeps working; health shows it', async () => {
    await disconnect();
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const g = guest();
    await consent(g);
    const o = await quickOrder(g, prod.skuIds[0]!);
    await dispatchTracking(t.db, 'test');
    expect((await events(o.order_id))[0]).toMatchObject({ status: 'blocked', blocked_reason: 'tracking_disabled' });
    await t.db.query(`UPDATE tracking_settings SET enabled=true WHERE id=1`);
    await dispatchTracking(t.db, 'test');
    expect((await events(o.order_id))[0].blocked_reason).toBe('no_dataset');
    const set = await api(t, 'PUT', '/admin/tracking/settings', { token: s.owner.token, body: { dataset_id: '123456789012' } });
    expect(set.status).toBe(200);
    expect(set.json.connection).toMatchObject({ state: 'blocked', blocked_reason: 'no_credentials', has_credentials: false });
    await dispatchTracking(t.db, 'test');
    expect((await events(o.order_id))[0].blocked_reason).toBe('no_credentials');
    const h = await api(t, 'GET', '/admin/tracking/health', { token: s.catalog.token });
    expect(h.status).toBe(200);
    expect(h.json.by_status.blocked).toBeGreaterThan(0);
    expect(h.json.dictionary.find((d: any) => d.internal_event === 'sale.recognized').meta_event).toBe('Purchase');
    expect(JSON.stringify(h.json)).not.toMatch(/vault:|\+998/);
    expect((await api(t, 'PUT', '/admin/tracking/settings', { token: s.owner.token, body: { credentials_ref: 'x' } })).status).toBe(400);
    await disconnect();
  });
});
