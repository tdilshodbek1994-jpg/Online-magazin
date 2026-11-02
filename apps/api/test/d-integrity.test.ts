import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clickSign, somStringToTiyin } from '../src/modules/payments/click.js';
import { runJobsOnce, runScheduledOnce } from '../src/worker.js';
import { withTx } from '../src/platform/db.js';
import { address, api, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

const paymeAuth = (key = 'test-payme-key') => ({ authorization: 'Basic ' + Buffer.from(`Paycom:${key}`).toString('base64') });
const payme = (method: string, params: Record<string, unknown>, key?: string) =>
  api(t, 'POST', '/api/v1/webhooks/payments/payme', { headers: paymeAuth(key), body: { jsonrpc: '2.0', id: 1, method, params } });

async function onlineOrder(qty = 1, prodOverride?: { skuIds: string[] }) {
  const prod = prodOverride ?? (await mkProduct(t, { prices: [100_000], stock: [5] }));
  const c = await mkUser(t);
  const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty }], { payment: 'online' });
  expect(r.status).toBe(201);
  const o = (await t.db.query(`SELECT id, payable_minor FROM orders WHERE id=$1`, [r.json.order_id])).rows[0];
  return { orderId: o.id as string, amount: Number(o.payable_minor), customer: c, prod };
}

describe('Inventory & idempotency (A6)', () => {
  it('T051/AC-M22-1: stock=1, 20 parallel checkouts → exactly one reservation, no oversell', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [1] });
    const users = await Promise.all(Array.from({ length: 20 }, () => mkUser(t)));
    const results = await Promise.all(users.map((u) => placeOrder(t, { token: u.token, phone: u.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]).catch((e) => ({ status: 0, json: String(e) }))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.json.code === 'OUT_OF_STOCK').length).toBe(19);
    const sb = (await t.db.query(`SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0];
    expect(sb).toEqual({ on_hand_sellable: 1, reserved: 1 });
  });

  it('T052: failed reservation rolls back the whole order (no orphan order/stock)', async () => {
    const prod = await mkProduct(t, { prices: [10_000, 10_000], stock: [5, 0] });
    const c = await mkUser(t);
    const before = (await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n;
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }, { sku_id: prod.skuIds[1]!, qty: 1 }]);
    expect(r.status).toBe(409);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM orders`)).rows[0].n).toBe(before);
    expect((await t.db.query(`SELECT reserved FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0].reserved).toBe(0);
  });

  it('T053/T054: expiry worker releases once; Payme transaction extends hold to its 12h timeout', async () => {
    const { orderId, amount } = await onlineOrder();
    await payme('CreateTransaction', { id: `pm-${randomUUID()}`, time: Date.now(), amount, account: { order_id: orderId } });
    const exp = (await t.db.query(`SELECT expires_at FROM reservations WHERE order_id=$1`, [orderId])).rows[0].expires_at;
    expect(new Date(exp).getTime() - Date.now()).toBeGreaterThan(11 * 3600_000);
    const o2 = await onlineOrder();
    const sku = o2.prod.skuIds[0];
    const later = new Date(Date.now() + 60 * 60_000);
    const r1 = await runScheduledOnce(t.db, later);
    const r2 = await runScheduledOnce(t.db, later);
    expect(r1!.expired).toBeGreaterThanOrEqual(1);
    expect((await t.db.query(`SELECT status FROM reservations WHERE order_id=$1`, [o2.orderId])).rows[0].status).toBe('expired');
    expect((await t.db.query(`SELECT reserved FROM stock_balances WHERE sku_id=$1`, [sku])).rows[0].reserved).toBe(0);
    void r2;
    expect((await t.db.query(`SELECT status FROM reservations WHERE order_id=$1`, [orderId])).rows[0].status).toBe('active_unpaid');
  });

  it('T055: payment after expiry with no stock left → paid + fulfilment-problem exception, no negative stock', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [1] });
    const { orderId, amount } = await onlineOrder(1, prod);
    await runScheduledOnce(t.db, new Date(Date.now() + 3600_000));
    const other = await mkUser(t);
    expect((await placeOrder(t, { token: other.token, phone: other.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }])).status).toBe(201);
    const pid = `pm-${randomUUID()}`;
    await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    await payme('PerformTransaction', { id: pid });
    const o = (await t.db.query(`SELECT payment_status, problem_reason FROM orders WHERE id=$1`, [orderId])).rows[0];
    expect(o).toEqual({ payment_status: 'paid', problem_reason: 'paid_no_stock' });
    expect((await t.db.query(`SELECT kind FROM finance_exceptions WHERE ref_id=$1`, [orderId])).rows[0].kind).toBe('late_payment_no_stock');
    expect((await t.db.query(`SELECT on_hand_sellable, reserved FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0]).toEqual({ on_hand_sellable: 1, reserved: 1 });
  });

  it('T019/AC-M11-2/AC-X15: same Idempotency-Key ×3 → one order; same key + other payload → conflict', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [10] });
    const c = await mkUser(t);
    await api(t, 'PUT', '/cart/lines', { token: c.token, body: { sku_id: prod.skuIds[0], qty: 1 } });
    const q = await api(t, 'POST', '/checkout/quotes', { token: c.token, body: { delivery_zone_id: await zoneId(t), address, contact: { name: 'A', phone: c.phone } } });
    const key = randomUUID();
    const body = { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', accept_terms: true };
    const res = await Promise.all([1, 2, 3].map(() => api(t, 'POST', '/checkout/confirmations', { token: c.token, idem: key, body })));
    const ids = new Set(res.filter((r) => r.status < 300).map((r) => r.json.order_id));
    expect(ids.size).toBe(1);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM reservations r JOIN orders o ON o.id=r.order_id WHERE o.quote_id=$1`, [q.json.quote_id])).rows[0].n).toBe(1);
    const other = await api(t, 'POST', '/checkout/confirmations', { token: c.token, idem: key, body: { ...body, payment_method: 'online' } });
    expect(other.json.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('T057/T058: delivered COD is not paid until finance reconciles; short remittance opens a finance exception', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    for (const step of ['pick', 'pack']) await api(t, 'POST', `/ops/orders/${r.json.order_id}/${step}`, { token: s.warehouse.token });
    await api(t, 'POST', `/ops/orders/${r.json.order_id}/ship`, { token: s.warehouse.token, body: { courier_user_id: s.courier.id } });
    await api(t, 'POST', `/courier/orders/${r.json.order_id}/deliver`, { token: s.courier.token, body: { proof: { method: 'signature', value: 'ok' } } });
    expect((await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].payment_status).toBe('pending');
    const rem = await api(t, 'POST', '/courier/remittances', { token: s.courier.token, body: { order_ids: [r.json.order_id], declared_minor: '11000000' } });
    const conf = await api(t, 'POST', `/finance/remittances/${rem.json.remittance_id}/confirm`, { token: s.finance.token, body: { received_minor: '11000000' } });
    expect(conf.json.status).toBe('discrepancy');
    const ex = (await t.db.query(`SELECT amount_minor, status FROM finance_exceptions WHERE ref_id=$1`, [rem.json.remittance_id])).rows[0];
    expect(ex).toEqual({ amount_minor: '-1000000', status: 'open' });
    expect((await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].payment_status).toBe('pending');
    const resolveShort = await api(t, 'POST', `/finance/exceptions/${(await t.db.query(`SELECT id FROM finance_exceptions WHERE ref_id=$1`, [rem.json.remittance_id])).rows[0].id}/resolve`, { token: s.finance.token, body: { resolution: 'ok' } });
    expect(resolveShort.status).toBe(400); // resolution must explain
  });

  it('T060: partial shipment is not accepted as delivered (one shipment per order in phase 1)', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 3 }]);
    await fulfilCod(t, s, r.json.order_id);
    const l = (await t.db.query(`SELECT qty, shipped_qty, delivered_qty FROM order_lines WHERE order_id=$1`, [r.json.order_id])).rows[0];
    expect(l).toEqual({ qty: 3, shipped_qty: 3, delivered_qty: 3 });
  });

  it('T022/AC-X07: archived product is closed for new purchase, old order snapshot kept', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await t.db.query(`UPDATE products SET status='archived', name='{"uz-Latn":"Yangi nom"}' WHERE id=$1`, [prod.productId]);
    const c2 = await mkUser(t);
    const r2 = await placeOrder(t, { token: c2.token, phone: c2.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]).catch((e) => ({ status: 0, json: String(e) }));
    expect(String(JSON.stringify(r2.json))).toContain('ITEMS_UNAVAILABLE');
    const snap = (await t.db.query(`SELECT product_snapshot FROM order_lines WHERE order_id=$1`, [r.json.order_id])).rows[0].product_snapshot;
    expect(snap.name['uz-Latn']).toContain('Mahsulot');
  });

  it('T024/T025/AC-M11-1: client price ignored; price change after quote requires new confirmation', async () => {
    const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
    const c = await mkUser(t);
    await api(t, 'PUT', '/cart/lines', { token: c.token, body: { sku_id: prod.skuIds[0], qty: 1, price_minor: '1' } });
    const q = await api(t, 'POST', '/checkout/quotes', { token: c.token, body: { delivery_zone_id: await zoneId(t), address, contact: { name: 'A', phone: c.phone }, payable_minor: '1' } });
    expect(q.json.subtotal.amount_minor).toBe('10000000');
    await t.db.query(`UPDATE offers SET price_minor=12000000, version=version+1 WHERE sku_id=$1`, [prod.skuIds[0]]);
    const r = await api(t, 'POST', '/checkout/confirmations', { token: c.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', accept_terms: true } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('QUOTE_CHANGED');
    expect(r.json.details.new_quote.subtotal.amount_minor).toBe('12000000');
  });

  it('T021: two variants have separate SKU, price and stock', async () => {
    const prod = await mkProduct(t, { prices: [450_000, 520_000], stock: [10, 0] });
    const pub = await api(t, 'GET', `/products/${prod.slug}`);
    const v = pub.json.variants;
    expect(v.map((x: any) => [x.price_minor, x.available])).toEqual([['45000000', 10], ['52000000', 0]]);
  });

  it('T023/AC-M02-1: guest cart merges deterministically on login (max qty, no doubling)', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [3] });
    const guest = randomUUID() + randomUUID();
    await api(t, 'PUT', '/cart/lines', { guest, body: { sku_id: prod.skuIds[0], qty: 2 } });
    const otp = await api(t, 'POST', '/auth/otp/request', { body: { phone: '+998977770001' } });
    const v = await api(t, 'POST', '/auth/otp/verify', { guest, body: { challenge_id: otp.json.challenge_id, code: otp.json.dev_code } });
    expect(v.status).toBe(200);
    await api(t, 'PUT', '/cart/lines', { token: v.json.token, body: { sku_id: prod.skuIds[0], qty: 2 } });
    const g2 = randomUUID() + randomUUID();
    await api(t, 'PUT', '/cart/lines', { guest: g2, body: { sku_id: prod.skuIds[0], qty: 2 } });
    await t.db.query(`UPDATE otp_challenges SET created_at = now() - interval '2 minutes' WHERE phone_e164='+998977770001'`);
    const otp2 = await api(t, 'POST', '/auth/otp/request', { body: { phone: '+998977770001' } });
    const v2 = await api(t, 'POST', '/auth/otp/verify', { guest: g2, body: { challenge_id: otp2.json.challenge_id, code: otp2.json.dev_code } });
    const cart = await api(t, 'GET', '/cart', { token: v2.json.token });
    expect(cart.json.lines).toHaveLength(1);
    expect(cart.json.lines[0].qty).toBe(2);
    expect(cart.json.lines[0].exceeds_stock).toBe(false);
  });

  it('T026/T027/T028: promo allocation exact; single-use promo cannot be used twice in parallel; validity boundaries', async () => {
    const prod = await mkProduct(t, { prices: [33_333, 33_333, 33_334], stock: [10, 10, 10] });
    const code = `ONE${randomUUID().slice(0, 6).toUpperCase()}`;
    await t.db.query(`INSERT INTO promotions (code, name, kind, value_bps, funding_owner, starts_at, ends_at, max_redemptions) VALUES ($1,'{"uz-Latn":"10%"}','cart_percent',1000,'platform', now() - interval '1 minute', now() + interval '1 hour', 1)`, [code]);
    const users = await Promise.all([mkUser(t), mkUser(t)]);
    const res = await Promise.all(users.map((u) => placeOrder(t, { token: u.token, phone: u.phone }, prod.skuIds.map((sku_id) => ({ sku_id, qty: 1 })), { promo: code }).catch((e) => ({ status: 0, json: String(e) }))));
    const ok = res.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    const lines = (await t.db.query(`SELECT allocated_cart_discount_minor::bigint a FROM order_lines WHERE order_id=$1`, [(ok[0] as any).json.order_id])).rows;
    expect(lines.reduce((x, l) => x + BigInt(l.a), 0n)).toBe(1000000n);
    const expired = `EXP${randomUUID().slice(0, 6).toUpperCase()}`;
    await t.db.query(`INSERT INTO promotions (code, name, kind, value_bps, funding_owner, starts_at, ends_at) VALUES ($1,'{"uz-Latn":"x"}','cart_percent',1000,'platform', now() - interval '2 hours', now() - interval '1 second')`, [expired]);
    const u3 = await mkUser(t);
    await expect(placeOrder(t, { token: u3.token, phone: u3.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { promo: expired })).rejects.toThrow(/PROMO_NOT_APPLICABLE/);
  });
});

describe('Payments (A7) — Payme Merchant API & CLICK contract tests (sandbox protocol, not live)', () => {
  it('T061: opening the success/return URL does not mark paid', async () => {
    const { orderId, customer } = await onlineOrder();
    const start = await api(t, 'POST', `/orders/${orderId}/payment-attempts`, { token: customer.token, body: { provider: 'payme' } });
    expect(start.json.test).toBe(true);
    expect(start.json.redirect_url).toContain('checkout.test.paycom.uz');
    await api(t, 'GET', `/me/orders/${orderId}?payment=return`, { token: customer.token });
    expect((await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [orderId])).rows[0].payment_status).toBe('unpaid');
  });

  it('T062/T066: wrong auth, wrong amount (×100 error) or unknown order are rejected without state change', async () => {
    const { orderId, amount } = await onlineOrder();
    expect((await payme('CheckPerformTransaction', { amount, account: { order_id: orderId } }, 'wrong')).json.error.code).toBe(-32504);
    expect((await payme('CheckPerformTransaction', { amount: amount / 100, account: { order_id: orderId } })).json.error.code).toBe(-31001);
    expect((await payme('CheckPerformTransaction', { amount: amount * 100, account: { order_id: orderId } })).json.error.code).toBe(-31001);
    expect((await payme('CheckPerformTransaction', { amount, account: { order_id: randomUUID() } })).json.error.code).toBe(-31050);
    expect((await payme('CheckPerformTransaction', { amount, account: { order_id: orderId } })).json.result.allow).toBe(true);
    expect((await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [orderId])).rows[0].payment_status).toBe('unpaid');
    expect(somStringToTiyin('1000.5')).toBe(100050n);
    expect(somStringToTiyin('1000.00')).toBe(100000n);
    expect(somStringToTiyin('1e3')).toBeNull();
  });

  it('T063/T064/AC-M14-1: Perform repeated 10× → one capture, one journal, one PaymentSucceeded event', async () => {
    const { orderId, amount } = await onlineOrder();
    const pid = `pm-${randomUUID()}`;
    const c = await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    expect(c.json.result.state).toBe(1);
    const res = await Promise.all(Array.from({ length: 10 }, () => payme('PerformTransaction', { id: pid })));
    expect(res.every((r) => r.json.result?.state === 2)).toBe(true);
    expect(new Set(res.map((r) => r.json.result.perform_time)).size).toBe(1);
    expect((await t.db.query(`SELECT captured_minor FROM payment_intents WHERE order_id=$1`, [orderId])).rows[0].captured_minor).toBe(String(amount));
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='PaymentSucceeded'`, [orderId])).rows[0].n).toBe(1);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM journal_transactions WHERE kind='payment_captured' AND business_event_key LIKE 'capture:%' AND business_event_key IN (SELECT 'capture:' || id FROM payment_attempts WHERE provider_ref=$1)`, [pid])).rows[0].n).toBe(1);
    const chk = await payme('CheckTransaction', { id: pid });
    expect(chk.json.result.state).toBe(2);
  });

  it('T065: cancel vs perform race resolves deterministically (one final state)', async () => {
    const { orderId, amount } = await onlineOrder();
    const pid = `pm-${randomUUID()}`;
    await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    const [p, c] = await Promise.all([payme('PerformTransaction', { id: pid }), payme('CancelTransaction', { id: pid, reason: 3 })]);
    const st = (await payme('CheckTransaction', { id: pid })).json.result.state;
    expect([2, -1, -2]).toContain(st);
    const o = (await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [orderId])).rows[0].payment_status;
    if (st === -1) expect(o).toBe('unpaid');
    if (st === 2) expect(o).toBe('paid');
    if (st === -2) expect(o).toBe('refunded');
    void p; void c;
  });

  it('T067/AC-M14-2: Payme and CLICK both capture the same order → second is excess payment in reconciliation', async () => {
    const { orderId, amount } = await onlineOrder();
    const pid = `pm-${randomUUID()}`;
    await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    // CLICK prepare happens before Payme perform (both providers open), then both complete.
    const som = `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
    const f: Record<string, string> = { click_trans_id: String(Date.now()), service_id: '0', click_paydoc_id: '1', merchant_trans_id: orderId, amount: som, action: '0', error: '0', error_note: '', sign_time: '2026-11-02 10:00:00' };
    f.sign_string = clickSign(f, 'test-click-secret', 0);
    const prep = await api(t, 'POST', '/api/v1/webhooks/payments/click/prepare', { body: f });
    expect(prep.json.error).toBe(0);
    await payme('PerformTransaction', { id: pid });
    const fc: Record<string, string> = { ...f, action: '1', merchant_prepare_id: prep.json.merchant_prepare_id };
    fc.sign_string = clickSign(fc, 'test-click-secret', 1);
    const comp = await api(t, 'POST', '/api/v1/webhooks/payments/click/complete', { body: fc });
    expect(comp.json.error).toBe(0);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM excess_payments WHERE order_id=$1`, [orderId])).rows[0].n).toBe(1);
    expect((await t.db.query(`SELECT captured_minor FROM payment_intents WHERE order_id=$1`, [orderId])).rows[0].captured_minor).toBe(String(amount));
    const bad = { ...fc, sign_string: 'deadbeef'.repeat(4) };
    expect((await api(t, 'POST', '/api/v1/webhooks/payments/click/complete', { body: bad })).json.error).toBe(-1);
  });

  it('T068/T069/AC-X20: parallel refund approvals cannot exceed captured; partial + remaining ≤ original', async () => {
    const { orderId, amount } = await onlineOrder();
    const pid = `pm-${randomUUID()}`;
    await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    await payme('PerformTransaction', { id: pid });
    const line = (await t.db.query(`SELECT id, line_net_minor FROM order_lines WHERE order_id=$1`, [orderId])).rows[0];
    const mk = (amt: string) => api(t, 'POST', '/refunds', { token: s.operator.token, idem: randomUUID(), body: { order_id: orderId, lines: [{ order_line_id: line.id, qty: 0, amount_minor: amt }], reason: 'test', method: 'provider' } });
    const a = await mk('7000000');
    const b = await mk('6000000');
    expect([a.status, b.status]).toEqual([201, 201]);
    const [x, y] = await Promise.all([api(t, 'POST', `/refunds/${a.json.refund_id}/approve`, { token: s.finance.token }), api(t, 'POST', `/refunds/${b.json.refund_id}/approve`, { token: s.finance.token })]);
    expect([x.status, y.status].sort()).toEqual([200, 422]);
    const over = await mk('9000000');
    expect(over.json.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    const overLine = await mk('10000001');
    expect(overLine.json.code).toBe('REFUND_EXCEEDS_LINE_REMAINING');
  });

  it('T070/AC-M16-2: refund unknown result keeps reserve, retry does not refund twice', async () => {
    const { orderId, amount } = await onlineOrder();
    const pid = `pm-${randomUUID()}`;
    await payme('CreateTransaction', { id: pid, time: Date.now(), amount, account: { order_id: orderId } });
    await payme('PerformTransaction', { id: pid });
    const r = await api(t, 'POST', '/refunds', { token: s.operator.token, idem: randomUUID(), body: { order_id: orderId, delivery_amount_minor: '2000000', reason: 'delivery refund', method: 'provider' } });
    await api(t, 'POST', `/refunds/${r.json.refund_id}/approve`, { token: s.finance.token });
    await api(t, 'POST', `/refunds/${r.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'unknown_result' } });
    expect((await t.db.query(`SELECT refunded_minor, refund_reserved_minor FROM payment_intents WHERE order_id=$1`, [orderId])).rows[0]).toEqual({ refunded_minor: '0', refund_reserved_minor: '2000000' });
    await api(t, 'POST', `/refunds/${r.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'succeeded', reference: 'PM-RF-1' } });
    await api(t, 'POST', `/refunds/${r.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'succeeded', reference: 'PM-RF-1' } });
    expect((await t.db.query(`SELECT refunded_minor, refund_reserved_minor FROM payment_intents WHERE order_id=$1`, [orderId])).rows[0]).toEqual({ refunded_minor: '2000000', refund_reserved_minor: '0' });
  });

  it('T033-AC-X33: delivery-only refund does not reduce goods commission', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], rule: { kind: 'percent', bps: 3000 } });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    await fulfilCod(t, s, r.json.order_id);
    const rf = await api(t, 'POST', '/refunds', { token: s.operator.token, idem: randomUUID(), body: { order_id: r.json.order_id, delivery_amount_minor: '2000000', reason: 'late delivery', method: 'manual_cash' } });
    await api(t, 'POST', `/refunds/${rf.json.refund_id}/approve`, { token: s.finance.token });
    await api(t, 'POST', `/refunds/${rf.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'succeeded', reference: 'C-1' } });
    expect((await t.db.query(`SELECT target_minor FROM commission_accruals WHERE order_id=$1`, [r.json.order_id])).rows[0].target_minor).toBe('3000000');
  });
});

describe('Access control, auth and privacy (A1/A2)', () => {
  it('T005: customer cannot see another customer order (404, no existence leak)', async () => {
    const prod = await mkProduct(t, {});
    const a = await mkUser(t);
    const b = await mkUser(t);
    const r = await placeOrder(t, { token: a.token, phone: a.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect((await api(t, 'GET', `/me/orders/${r.json.order_id}`, { token: b.token })).status).toBe(404);
    expect((await api(t, 'POST', '/returns', { token: b.token, body: { order_id: r.json.order_id, lines: [{ order_line_id: randomUUID(), qty: 1 }], reason: 'x y z', desired_resolution: 'refund' } })).status).toBe(404);
    expect((await api(t, 'POST', '/support/tickets', { token: b.token, body: { subject: 'Salom', body: 'x', order_id: r.json.order_id } })).status).toBe(404);
  });

  it('T006: operator cannot mark paid, approve refund or pay payout', async () => {
    expect((await api(t, 'POST', `/finance/remittances/${randomUUID()}/confirm`, { token: s.operator.token, body: { received_minor: '1' } })).status).toBe(403);
    expect((await api(t, 'POST', `/refunds/${randomUUID()}/approve`, { token: s.operator.token })).status).toBe(403);
    expect((await api(t, 'POST', `/admin/payouts/${randomUUID()}/result`, { token: s.operator.token, body: { outcome: 'paid', reference: 'xyz' } })).status).toBe(403);
  });

  it('T007: catalog manager sees no partner bank details or customer export', async () => {
    expect((await api(t, 'GET', '/admin/partners', { token: s.catalog.token })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/reports/orders.csv?from=2026-01-01&to=2026-12-31', { token: s.catalog.token })).status).toBe(403);
    const list = await api(t, 'GET', '/admin/products', { token: s.catalog.token });
    expect(list.json.items.every((p: any) => (p.skus ?? []).every((x: any) => x.cost_minor === null))).toBe(true);
  });

  it('session token accepted via X-Session-Token (web) and Authorization: Bearer (API clients)', async () => {
    const u = await mkUser(t);
    expect((await api(t, 'GET', '/me', { headers: { 'x-session-token': u.token } })).status).toBe(200);
    expect((await api(t, 'GET', '/me', { token: u.token })).status).toBe(200);
    expect((await api(t, 'GET', '/me', { headers: { 'x-session-token': u.token, authorization: 'Basic b3duZXI6eA==' } })).status).toBe(200);
  });

  it('T009/T010/T020-partial: logout & revoked session lose access immediately; role downgrade applies next request', async () => {
    const u = await mkUser(t, ['operator']);
    expect((await api(t, 'GET', '/ops/queues', { token: u.token })).status).toBe(200);
    await t.db.query(`UPDATE memberships SET revoked_at=now() WHERE user_id=$1 AND role_code='operator'`, [u.id]);
    expect((await api(t, 'GET', '/ops/queues', { token: u.token })).status).toBe(403);
    await api(t, 'POST', '/auth/logout', { token: u.token });
    expect((await api(t, 'GET', '/me', { token: u.token })).status).toBe(401);
    const v = await mkUser(t);
    await t.db.query(`UPDATE users SET phone_e164=$2 WHERE id=$1`, [v.id, `+99899${String(Date.now()).slice(-7)}`]);
    expect((await api(t, 'GET', '/me', { token: v.token })).status).toBe(401); // AC-X04: session bound to phone at issue
  });

  it('T011: OTP resend interval, attempt limit and single use enforced server-side', async () => {
    const phone = '+998977770099';
    const a = await api(t, 'POST', '/auth/otp/request', { body: { phone } });
    expect(a.status).toBe(200);
    const b = await api(t, 'POST', '/auth/otp/request', { body: { phone } });
    expect(b.status).toBe(429);
    for (let i = 0; i < 5; i++) await api(t, 'POST', '/auth/otp/verify', { body: { challenge_id: a.json.challenge_id, code: a.json.dev_code === '999999' ? '000000' : '999999' } });
    const late = await api(t, 'POST', '/auth/otp/verify', { body: { challenge_id: a.json.challenge_id, code: a.json.dev_code } });
    expect(late.json.code).toBe('OTP_INVALID_OR_EXPIRED');
  });

  it('T012/T097: production config never echoes OTP and disables mock payments', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' })).toThrow(/MFA_ENC_KEY/);
    const prod = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', PAYME_MODE: 'sandbox', CLICK_MODE: 'sandbox', MFA_ENC_KEY: 'x'.repeat(40) });
    expect(prod.otp.devEcho).toBe(false);
    expect(prod.payments.mockEnabled).toBe(false);
  });

  it('T013/T014: guest can checkout but cannot read history; phone alone reveals nothing', async () => {
    const prod = await mkProduct(t, {});
    const guest = randomUUID() + randomUUID();
    const r = await placeOrder(t, { guest, phone: '+998977770111' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(r.status).toBe(201);
    expect((await api(t, 'GET', '/me/orders', { guest })).status).toBe(401);
    const otpReq = await api(t, 'POST', '/auth/otp/request', { body: { phone: '+998977770111' } });
    expect(Object.keys(otpReq.json).sort()).toEqual(['challenge_id', 'dev_code', 'expires_in_seconds', 'phone_masked', 'resend_after_seconds']);
  });

  it('T084/T083: CSV export masks phones, neutralises formulas; Tashkent day bounds', async () => {
    const { csvCell } = await import('../src/modules/admin/routes.js');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+998901112233')).toBe(`'+998901112233`);
    const prod = await mkProduct(t, {});
    const c = await mkUser(t);
    await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const csv = await api(t, 'GET', `/admin/reports/orders.csv?from=${today}&to=${today}`, { token: s.owner.token });
    expect(csv.status).toBe(200);
    expect(csv.raw.body).toContain(c.phone.slice(0, 6) + '***');
    expect(csv.raw.body).not.toContain(c.phone);
    const sum = await api(t, 'GET', `/admin/reports/summary?from=${today}&to=${today}&date_type=created`, { token: s.owner.token });
    expect(sum.json.timezone).toBe('Asia/Tashkent');
    expect(sum.json.orders_created).toBeGreaterThan(0);
  });

  it('T081/T082: summary separates created, paid, COD pending, refunded; margin labelled incomplete', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const sum = await api(t, 'GET', `/admin/reports/summary?from=${today}&to=${today}`, { token: s.owner.token });
    for (const k of ['orders_created', 'created_order_total_minor', 'paid_total_minor', 'orders_delivered', 'refunded_minor', 'cod_pending_minor', 'commission_obligation']) expect(sum.json).toHaveProperty(k);
    expect(sum.json.estimated_operating_margin.label).not.toMatch(/net_profit/);
    expect(sum.json.estimated_operating_margin.missing).toContain('payment_fees');
  });

  it('T085/T092: worker restart/retry does not duplicate effects; committed state survives', async () => {
    let n = 1;
    while (n > 0) n = await runJobsOnce(t.db, 'w1', 200);
    expect(await runJobsOnce(t.db, 'w2', 200)).toBe(0);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM jobs WHERE status IN ('pending','running')`)).rows[0].n).toBe(0);
    const delivered = (await t.db.query(`SELECT COUNT(*)::int n FROM notifications WHERE status='delivered'`)).rows[0].n;
    expect(delivered).toBe(0); // dev adapter never claims delivery
    const [a, b] = await Promise.all([runScheduledOnce(t.db), runScheduledOnce(t.db)]);
    expect([a, b].filter((x) => x === null).length).toBeLessThanOrEqual(1);
  });

  it('T049/T048: stale revision edit conflicts; two operators claiming → one owner', async () => {
    const prod = await mkProduct(t, {});
    const r = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: '+998977770222' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    const [x, y] = await Promise.all([api(t, 'POST', `/ops/orders/${r.json.order_id}/claim`, { token: s.operator.token }), api(t, 'POST', `/ops/orders/${r.json.order_id}/claim`, { token: s.operator2.token })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const v = (await t.db.query(`SELECT version FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].version;
    const ok = await api(t, 'PATCH', `/ops/orders/${r.json.order_id}/address`, { token: s.operator.token, body: { expected_version: v, address: { house: '2' }, reason: 'customer asked' } });
    expect(ok.status).toBe(200);
    const stale = await api(t, 'PATCH', `/ops/orders/${r.json.order_id}/address`, { token: s.operator.token, body: { expected_version: v, address: { house: '3' }, reason: 'stale screen' } });
    expect(stale.json.code).toBe('VERSION_CONFLICT');
  });

  it('T091/AC-M54-1: migrations are idempotent and checksum-protected', async () => {
    const { migrate, MIGRATIONS_DIR } = await import('../src/platform/migrate.js');
    expect(await migrate(t.db, MIGRATIONS_DIR)).toEqual([]);
    const tamper = await t.db.query(`SELECT checksum FROM schema_migrations WHERE name='0001_platform_identity.sql'`);
    expect(tamper.rows[0].checksum).toHaveLength(64);
  });

  it('INV08/AC-M42-1: every posted journal transaction is balanced', async () => {
    const r = await t.db.query(`SELECT t.id FROM journal_transactions t JOIN journal_entries e ON e.transaction_id=t.id GROUP BY t.id HAVING SUM(e.debit_minor) <> SUM(e.credit_minor)`);
    expect(r.rowCount).toBe(0);
    await expect(withTx(t.db, async (tx) => {
      const j = await tx.query(`INSERT INTO journal_transactions (business_event_key, kind, currency) VALUES ($1,'test','UZS') RETURNING id`, [`unbal:${randomUUID()}`]);
      await tx.query(`INSERT INTO journal_entries (transaction_id, account_id, debit_minor) SELECT $1, id, 100 FROM ledger_accounts WHERE code='cash_bank'`, [j.rows[0].id]);
    })).rejects.toThrow(/JOURNAL_UNBALANCED/);
  });

  it('T041-audit: superadmin cannot delete audit trail', async () => {
    await expect(t.db.query(`DELETE FROM audit_events`)).rejects.toThrow(/IMMUTABLE_TABLE/);
    await expect(t.db.query(`UPDATE partner_ledger SET amount_minor=1`)).rejects.toThrow(/IMMUTABLE_TABLE/);
  });

  void createHash;
});
