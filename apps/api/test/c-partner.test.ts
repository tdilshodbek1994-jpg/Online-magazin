import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { withTx } from '../src/platform/db.js';
import { address, api, balances, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T, zoneId } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  // These tests cover the optional SMS-confirmation flow (owner turned it off by default on 2026-11-05).
  await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='partner.customer_sms_confirm'`);
  s = await staff(t);
});

const future = () => new Date(Date.now() + 15 * 86400_000);
const guestTok = () => randomUUID() + randomUUID();

async function referralLink(p: { token: string }, productId?: string) {
  const r = await api(t, 'POST', '/partner/links', { token: p.token, body: productId ? { product_id: productId } : {} });
  expect(r.status).toBe(200);
  return r.json.code as string;
}

async function partnerOrder(p: { token: string }, skuId: string, qty: number, phone: string) {
  const q = await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: skuId, qty }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone } } });
  expect(q.status).toBe(200);
  const o = await api(t, 'POST', '/partner/orders', { token: p.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda kelishildi' } });
  return o;
}

async function verifyDestination(p: { token: string; partnerId: string }) {
  expect((await api(t, 'PUT', '/partner/payout-destination', { token: p.token, body: { type: 'card', holder: 'TEST HOLDER', number: '8600123412341234' } })).status).toBe(200);
  expect((await api(t, 'POST', `/admin/partners/${p.partnerId}/verify-destination`, { token: s.finance.token })).status).toBe(200);
}

describe('Stage C — referral channel', () => {
  it('T098: referral → customer checkout → delivery → COD settlement → hold → available → payout → history', async () => {
    const partner = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [500_000], stock: [5], rule: { kind: 'percent', bps: 3000 } });
    const code = await referralLink(partner, prod.productId);
    const guest = guestTok();
    const touch = await api(t, 'POST', '/referrals/touch', { guest, body: { code } });
    expect(touch.json).toMatchObject({ attributed: true, redirect: `/p/${prod.slug}` });
    const c = await mkUser(t);
    const ord = await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(ord.status).toBe(201);
    const id = ord.json.order_id;
    const o = (await t.db.query(`SELECT attributed_partner_id, attribution FROM orders WHERE id=$1`, [id])).rows[0];
    expect(o.attributed_partner_id).toBe(partner.partnerId);
    expect(o.attribution.reason).toBe('last_eligible_click');
    expect(await balances(t, partner.partnerId)).toMatchObject({ e: '15000000', p: '0', a: '0' }); // T071: estimate only
    await fulfilCod(t, s, id);
    expect(await balances(t, partner.partnerId)).toMatchObject({ e: '0', p: '15000000', a: '0' });
    expect(await withTx(t.db, (tx) => releaseMatured(tx, new Date()))).toBe(0); // T072: hold not elapsed
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    expect(await balances(t, partner.partnerId)).toMatchObject({ p: '0', a: '15000000' });
    await verifyDestination(partner);
    const pr = await api(t, 'POST', '/partner/payouts', { token: partner.token, idem: randomUUID(), body: { amount_minor: '15000000' } });
    expect(pr.status).toBe(201);
    expect(await balances(t, partner.partnerId)).toMatchObject({ a: '0', r: '15000000' });
    expect((await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/prepare`, { token: s.finance.token })).status).toBe(200);
    expect((await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/approve`, { token: s.finance.token })).json.code).toBe('MAKER_CANNOT_APPROVE');
    expect((await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/approve`, { token: s.finance2.token })).status).toBe(200);
    expect((await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/result`, { token: s.finance2.token, body: { outcome: 'paid', reference: 'BANK-REF-001', evidence: 'statement line 17' } })).status).toBe(200);
    expect(await balances(t, partner.partnerId)).toMatchObject({ r: '0', pd: '15000000' });
    const hist = await api(t, 'GET', '/partner/ledger', { token: partner.token });
    expect(hist.json.items.length).toBeGreaterThanOrEqual(5);
    const check = await api(t, 'GET', `/admin/partners/${partner.partnerId}/ledger-check`, { token: s.owner.token });
    expect(check.json.match).toBe(true);
  });

  it('T032/T033: direct visit does not erase referral; last eligible click wins', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'percent', bps: 1000 } });
    const guest = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: await referralLink(a) } });
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: await referralLink(b) } });
    await api(t, 'GET', '/products', { guest }); // direct browsing
    const r = await placeOrder(t, { guest, phone: '+998901000001' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    const o = (await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [r.json.order_id])).rows[0];
    expect(o.attributed_partner_id).toBe(b.partnerId);
  });

  it('T034/AC-M29-1: explicit valid code beats clicks; random code is rejected', async () => {
    const a = await mkPartner(t);
    const c = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'percent', bps: 1000 } });
    const guest = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: await referralLink(a) } });
    const bad = await placeOrder(t, { guest, phone: '+998901000002' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: 'NOPE999' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('PARTNER_CODE_INVALID');
    const ok = await placeOrder(t, { guest, phone: '+998901000002' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: c.code });
    expect(ok.status).toBe(201);
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [ok.json.order_id])).rows[0].attributed_partner_id).toBe(c.partnerId);
  });

  it('T035/T008: suspended partner gets no commission and cannot create links/orders; buyer still buys; history kept', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'percent', bps: 1000 } });
    const code = await referralLink(p);
    const guest = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code } });
    const before = await placeOrder(t, { guest, phone: '+998901000003' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(before.status).toBe(201);
    expect((await api(t, 'POST', `/admin/partners/${p.partnerId}/status`, { token: s.owner.token, body: { status: 'suspended', reason: 'policy check' } })).status).toBe(200);
    const g2 = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest: g2, body: { code } });
    const after = await placeOrder(t, { guest: g2, phone: '+998901000004' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    expect(after.status).toBe(201);
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [after.json.order_id])).rows[0].attributed_partner_id).toBeNull();
    expect((await api(t, 'POST', '/partner/links', { token: p.token, body: {} })).json.code).toBe('PARTNER_NOT_ACTIVE');
    expect((await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'x', phone: '901234567' } } })).json.code).toBe('PARTNER_NOT_ACTIVE');
    const mine = await api(t, 'GET', '/partner/orders', { token: p.token });
    expect(mine.json.items.map((o: any) => o.id)).toContain(before.json.order_id);
    expect((await api(t, 'POST', '/partner/disputes', { token: p.token, body: { order_id: before.json.order_id, subject: 'Savol', body: 'Komissiya haqida' } })).status).toBe(200);
  });

  it('T036: attribution snapshot does not change after a later click', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'percent', bps: 1000 } });
    const guest = guestTok();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: await referralLink(a) } });
    const r = await placeOrder(t, { guest, phone: '+998901000005' }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: await referralLink(b) } });
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].attributed_partner_id).toBe(a.partnerId);
  });

  it('T037: link preview bots are recorded as ineligible touches', async () => {
    const p = await mkPartner(t);
    const code = await referralLink(p);
    const r = await api(t, 'POST', '/referrals/touch', { guest: guestTok(), body: { code }, ua: 'TelegramBot (like TwitterBot)' });
    expect(r.json.attributed).toBe(false);
    const row = (await t.db.query(`SELECT is_bot, eligible, ineligible_reason FROM referral_touches t JOIN referral_links l ON l.id=t.link_id WHERE l.code=$1`, [code])).rows[0];
    expect(row).toEqual({ is_bot: true, eligible: false, ineligible_reason: 'bot_or_preview' });
  });

  it('T038: without cookie/visitor token the explicit code still attributes (no 100% tracking promise)', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'percent', bps: 1000 } });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code.toLowerCase() });
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [r.json.order_id])).rows[0].attributed_partner_id).toBe(p.partnerId);
  });
});

describe('Stage C — partner-assisted order with independent customer confirmation', () => {
  it('T099: partner order → customer OTP confirm → operator → COD delivery/remittance → commission → partial return → corrected', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 30_000 } });
    const phone = '+998935550001';
    const o = await partnerOrder(p, prod.skuIds[0]!, 2, phone);
    expect(o.status).toBe(201);
    expect(o.json.customer_phone_masked).toBe('+99893***01');
    const id = o.json.order_id;
    const row = (await t.db.query(`SELECT created_by_user_id, attributed_partner_id, customer_phone, channel, confirmation_status FROM orders WHERE id=$1`, [id])).rows[0];
    expect(row).toEqual({ created_by_user_id: p.id, attributed_partner_id: p.partnerId, customer_phone: phone, channel: 'partner_assisted', confirmation_status: 'pending' }); // T041
    expect((await t.db.query(`SELECT reserved FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0].reserved).toBe(0); // T056
    expect((await api(t, 'POST', `/ops/orders/${id}/pick`, { token: s.warehouse.token })).json.code).toBe('INVALID_FULFILLMENT_TRANSITION'); // T042
    // Customer sees order in confirmation page and confirms with SMS code.
    const view = await api(t, 'GET', `/confirm/${o.json.dev_customer_link_token}`);
    expect(view.json.lines[0].qty).toBe(2);
    expect(view.json.shop_name).toBeTruthy();
    const wrong = await api(t, 'POST', `/confirm/${o.json.dev_customer_link_token}`, { body: { decision: 'confirm', code: o.json.dev_customer_code === '000000' ? '111111' : '000000' } });
    expect(wrong.status).toBe(400);
    const ok = await api(t, 'POST', `/confirm/${o.json.dev_customer_link_token}`, { body: { decision: 'confirm', code: o.json.dev_customer_code } });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toBeUndefined(); // T043: no session issued
    const replay = await api(t, 'POST', `/confirm/${o.json.dev_customer_link_token}`, { body: { decision: 'confirm', code: o.json.dev_customer_code } });
    expect(replay.status).toBe(400); // T010: one-time link
    await fulfilCod(t, s, id);
    expect(await balances(t, p.partnerId)).toMatchObject({ p: '6000000' });
    // Return 1 of 2: target 30 000.
    const lines = (await t.db.query(`SELECT id, line_net_minor FROM order_lines WHERE order_id=$1`, [id])).rows;
    const cust = await mkUser(t, ['customer'], phone).catch(async () => null);
    void cust;
    const ret = await api(t, 'POST', '/returns', { token: s.operator.token, body: { order_id: id, lines: [{ order_line_id: lines[0].id, qty: 1 }], reason: 'Yoqmadi', desired_resolution: 'refund' } });
    expect(ret.status).toBe(200);
    expect((await api(t, 'POST', `/ops/returns/${ret.json.id}/decision`, { token: s.operator.token, body: { decision: 'approved', note: 'policy ok' } })).status).toBe(200);
    const rl = (await t.db.query(`SELECT id FROM return_lines WHERE return_id=$1`, [ret.json.id])).rows[0];
    expect((await api(t, 'POST', `/ops/returns/${ret.json.id}/receive`, { token: s.warehouse.token, body: { lines: [{ return_line_id: rl.id, received_qty: 1 }] } })).status).toBe(200);
    expect(await balances(t, p.partnerId)).toMatchObject({ p: '3000000' });
    const sbQ = (await t.db.query(`SELECT on_hand_sellable, quarantine FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0];
    expect(sbQ).toEqual({ on_hand_sellable: 8, quarantine: 1 }); // T059
    const rf = await api(t, 'POST', '/refunds', { token: s.operator.token, idem: randomUUID(), body: { order_id: id, return_id: ret.json.id, lines: [{ order_line_id: lines[0].id, qty: 1, amount_minor: '10000000' }], reason: 'return', method: 'manual_cash' } });
    expect(rf.status).toBe(201);
    expect((await api(t, 'POST', `/refunds/${rf.json.refund_id}/approve`, { token: s.finance.token })).status).toBe(200);
    expect((await api(t, 'POST', `/refunds/${rf.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'succeeded', reference: 'CASH-RCPT-9' } })).status).toBe(200);
    expect(await balances(t, p.partnerId)).toMatchObject({ p: '3000000' }); // no double reversal (T077)
    expect((await t.db.query(`SELECT payment_status FROM orders WHERE id=$1`, [id])).rows[0].payment_status).toBe('partially_refunded');
    expect((await api(t, 'POST', `/ops/returns/${ret.json.id}/inspect`, { token: s.warehouse.token, body: { lines: [{ return_line_id: rl.id, sellable_qty: 1, damaged_qty: 0 }] } })).status).toBe(200);
    expect((await t.db.query(`SELECT on_hand_sellable, quarantine FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0]).toEqual({ on_hand_sellable: 9, quarantine: 0 });
  });

  it('T044: customer rejects → cancelled, no reservation, commission zero', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'fixed_per_unit', fixed: 10_000 } });
    const o = await partnerOrder(p, prod.skuIds[0]!, 1, '+998935550002');
    const r = await api(t, 'POST', `/confirm/${o.json.dev_customer_link_token}`, { body: { decision: 'reject', code: o.json.dev_customer_code } });
    expect(r.status).toBe(200);
    const row = (await t.db.query(`SELECT commercial_status, confirmation_status FROM orders WHERE id=$1`, [o.json.order_id])).rows[0];
    expect(row).toEqual({ commercial_status: 'cancelled', confirmation_status: 'rejected' });
    expect(await balances(t, p.partnerId)).toMatchObject({ e: '0', p: '0', a: '0' });
    expect((await t.db.query(`SELECT reserved FROM stock_balances WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0].reserved).toBe(0);
  });

  it('T045: operator independent call confirmation is stored with actor and outcome (not partner checkbox)', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, {});
    const o = await partnerOrder(p, prod.skuIds[0]!, 1, '+998935550003');
    const id = o.json.order_id;
    await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
    const payable = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [id])).rows[0].payable_minor;
    const mism = await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: '1' } });
    expect(mism.json.code).toBe('CONFIRMED_TOTAL_MISMATCH');
    expect((await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
    const c = (await t.db.query(`SELECT method, status, actor_user_id, call_outcome FROM order_confirmations WHERE order_id=$1 AND method='operator_call'`, [id])).rows[0];
    expect(c).toEqual({ method: 'operator_call', status: 'verified', actor_user_id: s.operator.id, call_outcome: 'confirmed' });
  });

  it('T046/T047: duplicate signal for same phone+SKU goes to operator; no PII revealed; real second purchase not auto-cancelled', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, {});
    const phone = '+998935550004';
    const first = await partnerOrder(a, prod.skuIds[0]!, 1, phone);
    const second = await partnerOrder(b, prod.skuIds[0]!, 1, phone);
    expect(second.status).toBe(201);
    expect(JSON.stringify(second.json)).not.toContain(first.json.order_id);
    const rows = (await t.db.query(`SELECT id, duplicate_signal, commercial_status FROM orders WHERE id IN ($1,$2)`, [first.json.order_id, second.json.order_id])).rows;
    expect(rows.find((r) => r.id === second.json.order_id)).toMatchObject({ duplicate_signal: true, commercial_status: 'awaiting_confirmation' });
    const q = await api(t, 'GET', '/ops/orders?queue=problem', { token: s.operator.token });
    expect(q.json.items.map((o: any) => o.id)).toContain(second.json.order_id);
  });

  it('T039: partner cannot act as another partner (partner_id never taken from payload)', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, {});
    const q = await api(t, 'POST', '/partner/orders/quote', { token: a.token, body: { partner_id: b.partnerId, lines: [{ sku_id: prod.skuIds[0], qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'x', phone: '+998935550005' } } });
    const o = await api(t, 'POST', '/partner/orders', { token: a.token, idem: randomUUID(), body: { partner_id: b.partnerId, quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'x y z' } });
    expect((await t.db.query(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].attributed_partner_id).toBe(a.partnerId);
    // B cannot use A's quote
    const steal = await api(t, 'POST', '/partner/orders', { token: b.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'x y z' } });
    expect(steal.status).toBe(404);
  });

  it('T004: partner cannot open another partner order or commission', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, {});
    const o = await partnerOrder(a, prod.skuIds[0]!, 1, '+998935550006');
    const r = await api(t, 'GET', `/partner/orders/${o.json.order_id}`, { token: b.token });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.json)).not.toContain('+99893');
  });

  it('T040: attribution correction keeps old record and leaves exactly one partner with commission', async () => {
    const a = await mkPartner(t);
    const b = await mkPartner(t);
    const prod = await mkProduct(t, { rule: { kind: 'fixed_per_unit', fixed: 20_000 } });
    const o = await partnerOrder(a, prod.skuIds[0]!, 1, '+998935550007');
    const r = await api(t, 'POST', `/admin/orders/${o.json.order_id}/attribution`, { token: s.owner.token, body: { new_partner_id: b.partnerId, reason: 'Referral dispute upheld', evidence: 'chat screenshot #12' } });
    expect(r.status).toBe(200);
    expect(await balances(t, a.partnerId)).toMatchObject({ e: '0' });
    expect(await balances(t, b.partnerId)).toMatchObject({ e: '2000000' });
    const hist = (await t.db.query(`SELECT COUNT(*)::int n FROM commission_accruals WHERE order_id=$1`, [o.json.order_id])).rows[0].n;
    expect(hist).toBe(2);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM attribution_corrections WHERE order_id=$1`, [o.json.order_id])).rows[0].n).toBe(1);
  });
});

describe('Commission math & payouts', () => {
  it('T073: fixed 30 000 × 2 = 60 000; one returned → 30 000', async () => {
    const { computeTarget } = await import('../src/modules/commissions/service.js');
    const rule = { rule_id: 'x', version: 1, kind: 'fixed_per_unit' as const, rate_bps: null, fixed_minor: '3000000', basis: 'b' };
    expect(computeTarget(rule, { qty: 2, canceledQty: 0, returnedQty: 0, lineNet: 20000000n, refundedProduct: 0n })).toBe(6000000n);
    expect(computeTarget(rule, { qty: 2, canceledQty: 0, returnedQty: 1, lineNet: 20000000n, refundedProduct: 10000000n })).toBe(3000000n);
    expect(computeTarget(rule, { qty: 2, canceledQty: 0, returnedQty: 2, lineNet: 20000000n, refundedProduct: 20000000n })).toBe(0n);
  });

  it('T074: 30% on 90 000 discounted goods base = 27 000; delivery excluded', async () => {
    const { computeTarget } = await import('../src/modules/commissions/service.js');
    const rule = { rule_id: 'x', version: 1, kind: 'percent' as const, rate_bps: 3000, fixed_minor: null, basis: 'b' };
    expect(computeTarget(rule, { qty: 1, canceledQty: 0, returnedQty: 0, lineNet: 9000000n, refundedProduct: 0n })).toBe(2700000n);
    // MASTER 9.3: 40 000 refund of 100 000 → 18 000 remains
    expect(computeTarget(rule, { qty: 1, canceledQty: 0, returnedQty: 0, lineNet: 10000000n, refundedProduct: 4000000n })).toBe(1800000n);
  });

  it('T074-e2e: 10 000 promo discount gives 90 000 base and 27 000 commission; delivery not in base', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], rule: { kind: 'percent', bps: 3000 } });
    const code = `PROMO${randomUUID().slice(0, 5).toUpperCase()}`;
    await t.db.query(`INSERT INTO promotions (code, name, kind, value_minor, funding_owner, starts_at, ends_at, max_redemptions) VALUES ($1,'{"uz-Latn":"10k"}','cart_fixed',1000000,'platform', now() - interval '1 hour', now() + interval '1 day', 100)`, [code]);
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code, promo: code });
    expect(r.status).toBe(201);
    expect(await balances(t, p.partnerId)).toMatchObject({ e: '2700000' });
  });

  it('T075: changing the rate later does not change existing order snapshot', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], rule: { kind: 'percent', bps: 3000 } });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    expect((await api(t, 'POST', `/admin/products/${prod.productId}/commission-rules`, { token: s.owner.token, body: { kind: 'percent', rate_bps: 2000 } })).status).toBe(200);
    const a = (await t.db.query(`SELECT target_minor, rule_snapshot FROM commission_accruals WHERE order_id=$1`, [r.json.order_id])).rows[0];
    expect(a.target_minor).toBe('3000000');
    expect(a.rule_snapshot.rate_bps).toBe(3000);
    const c2 = await mkUser(t);
    const r2 = await placeOrder(t, { token: c2.token, phone: c2.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    expect((await t.db.query(`SELECT target_minor FROM commission_accruals WHERE order_id=$1`, [r2.json.order_id])).rows[0].target_minor).toBe('2000000');
  });

  it('T076: duplicate delivery/remittance/release events do not duplicate commission', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], rule: { kind: 'fixed_per_unit', fixed: 30_000 } });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    const { remittanceId } = await fulfilCod(t, s, r.json.order_id);
    expect((await api(t, 'POST', `/courier/orders/${r.json.order_id}/deliver`, { token: s.courier.token, body: { proof: { method: 'otp', value: '1' } } })).json.noop).toBe(true);
    expect((await api(t, 'POST', `/finance/remittances/${remittanceId}/confirm`, { token: s.finance.token, body: { received_minor: '1' } })).json.noop).toBe(true);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    expect(await balances(t, p.partnerId)).toMatchObject({ e: '0', p: '0', a: '3000000' });
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM commission_accruals WHERE order_id=$1`, [r.json.order_id])).rows[0].n).toBe(1);
  });

  async function partnerWithAvailable(amountSom: number) {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [amountSom], rule: { kind: 'percent', bps: 10000 } });
    const c = await mkUser(t);
    const r = await placeOrder(t, { token: c.token, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    await fulfilCod(t, s, r.json.order_id);
    await withTx(t.db, (tx) => releaseMatured(tx, future()));
    await verifyDestination(p);
    return { p, orderId: r.json.order_id as string, prod };
  }

  it('T078/AC-M31-1: 500 000 available, parallel 400 000 and 300 000 → only one reserves', async () => {
    const { p } = await partnerWithAvailable(500_000);
    const [x, y] = await Promise.all([
      api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '40000000' } }),
      api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '30000000' } }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const b = await balances(t, p.partnerId);
    expect(BigInt(b.a) + BigInt(b.r)).toBe(50000000n);
    expect(BigInt(b.a)).toBeGreaterThanOrEqual(0n);
  });

  it('T079: rejected payout releases once; processing_unknown keeps the reserve', async () => {
    const { p } = await partnerWithAvailable(300_000);
    const a = await api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '15000000' } });
    const b = await api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '15000000' } });
    for (const id of [a.json.payout_id, b.json.payout_id]) {
      await api(t, 'POST', `/admin/payouts/${id}/prepare`, { token: s.finance.token });
      await api(t, 'POST', `/admin/payouts/${id}/approve`, { token: s.finance2.token });
    }
    await api(t, 'POST', `/admin/payouts/${a.json.payout_id}/result`, { token: s.finance2.token, body: { outcome: 'rejected', reason: 'wrong account' } });
    await api(t, 'POST', `/admin/payouts/${a.json.payout_id}/result`, { token: s.finance2.token, body: { outcome: 'rejected', reason: 'again' } });
    await api(t, 'POST', `/admin/payouts/${b.json.payout_id}/result`, { token: s.finance2.token, body: { outcome: 'processing_unknown' } });
    expect(await balances(t, p.partnerId)).toMatchObject({ a: '15000000', r: '15000000' });
    const again = await api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '30000000' } });
    expect(again.json.code).toBe('INSUFFICIENT_AVAILABLE');
  });

  it('T080: refund after commission paid keeps original payout and records visible debt', async () => {
    const { p, orderId } = await partnerWithAvailable(200_000);
    const pr = await api(t, 'POST', '/partner/payouts', { token: p.token, idem: randomUUID(), body: { amount_minor: '20000000' } });
    await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/prepare`, { token: s.finance.token });
    await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/approve`, { token: s.finance2.token });
    await api(t, 'POST', `/admin/payouts/${pr.json.payout_id}/result`, { token: s.finance2.token, body: { outcome: 'paid', reference: 'BANK-77' } });
    const line = (await t.db.query(`SELECT id FROM order_lines WHERE order_id=$1`, [orderId])).rows[0];
    const rf = await api(t, 'POST', '/refunds', { token: s.operator.token, idem: randomUUID(), body: { order_id: orderId, lines: [{ order_line_id: line.id, qty: 0, amount_minor: '5000000' }], reason: 'goodwill', method: 'manual_bank' } });
    await api(t, 'POST', `/refunds/${rf.json.refund_id}/approve`, { token: s.finance.token });
    await api(t, 'POST', `/refunds/${rf.json.refund_id}/result`, { token: s.finance.token, body: { outcome: 'succeeded', reference: 'BANK-RF-1' } });
    expect(await balances(t, p.partnerId)).toMatchObject({ pd: '20000000', a: '0', d: '-5000000' });
    expect((await t.db.query(`SELECT status FROM payout_requests WHERE id=$1`, [pr.json.payout_id])).rows[0].status).toBe('paid');
  });

  it('T003: partner cannot change price, stock or commission rule', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, {});
    for (const [m, u, b] of [
      ['POST', `/admin/skus/${prod.skuIds[0]}/price`, { price_minor: '1', expected_version: 1 }],
      ['POST', `/admin/skus/${prod.skuIds[0]}/stock`, { kind: 'receipt', qty: 100, reason: 'hack', ref: 'hack-1' }],
      ['POST', `/admin/products/${prod.productId}/commission-rules`, { kind: 'percent', rate_bps: 9000 }],
      ['POST', '/admin/products', { name: { 'uz-Latn': 'x' }, category_id: randomUUID(), skus: [{ sku_code: 'HACK1', price_minor: '1' }] }],
    ] as const) {
      expect((await api(t, m, u, { token: p.token, body: b })).status).toBe(403);
    }
    expect((await t.db.query(`SELECT price_minor FROM offers WHERE sku_id=$1`, [prod.skuIds[0]])).rows[0].price_minor).toBe('10000000');
  });
});

afterAll(async () => { await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='partner.customer_sms_confirm'`); });

describe('Owner decision: no SMS code for partner-entered orders (flag off)', () => {
  it('order goes straight to the operator queue; no SMS is queued; the operator call confirms it', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='partner.customer_sms_confirm'`);
    const s = await staff(t);
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [100_000], stock: [5], rule: { kind: 'percent', bps: 1000 } });
    const phone = `+99893${String(Math.floor(Math.random() * 9e6) + 1e6)}`;
    const o = await partnerOrder(p, prod.skuIds[0]!, 1, phone);
    expect(o.status).toBe(201);
    expect(o.json).toMatchObject({ status: 'awaiting_operator_call' });
    expect(o.json.dev_customer_code).toBeUndefined();
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM notifications WHERE phone_e164=$1 AND template='partner_order_confirm'`, [phone])).rows[0].n).toBe(0);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM order_confirmations WHERE order_id=$1`, [o.json.order_id])).rows[0].n).toBe(0);
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${o.json.order_id}/claim`, { token: s.operator.token });
    expect((await api(t, 'POST', `/ops/orders/${o.json.order_id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
    expect((await t.db.query(`SELECT confirmation_status FROM orders WHERE id=$1`, [o.json.order_id])).rows[0].confirmation_status).toBe('verified');
    // the partner still can never confirm their own order
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='partner.customer_sms_confirm'`);
  });
});
