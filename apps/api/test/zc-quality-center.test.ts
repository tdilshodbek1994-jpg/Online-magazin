import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { rates, signalFor } from '../src/modules/quality/routes.js';
import { address, api, fulfilCod, mkPartner, mkProduct, mkUser, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T, zoneId } from './helpers.js';

/** UZSHOP PRO — Quality Center P0 acceptance tests (Q01–Q20 where P0 covers them). Separate database. */
let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_quality');
  s = await staff(t);
});
const base = { confirmed: 0, resolved: 0, pending: 0, delivered: 0, resolvedConfirmed: 0, notPartnerFault: 0, denied: 0, checked: 0, invalid: 0, investigated: 0 };
const policy = { metric: 'confirmation_rate', threshold_pct: 30, min_sample: 20 };

async function partnerOrder(p: { token: string }, skuId: string, phone = nextPhone()) {
  const q = await api(t, 'POST', '/partner/orders/quote', { token: p.token, body: { lines: [{ sku_id: skuId, qty: 1 }], delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone } } });
  expect(q.status).toBe(200);
  const o = await api(t, 'POST', '/partner/orders', { token: p.token, idem: randomUUID(), body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: 'cod', customer_agreement_note: 'Telefonda kelishildi' } });
  expect(o.status).toBe(201);
  return o.json;
}
async function openCase(partnerId: string, reason = 'other', idem?: string) {
  const r = await api(t, 'POST', '/admin/quality/cases', { token: s.owner.token, body: { partner_id: partnerId, reason_code: reason, ...(idem ? { idem_key: idem } : {}) } });
  expect(r.status).toBe(200);
  return r.json.id as string;
}
async function move(id: string, to: string, fault?: string) {
  const v = (await t.db.query(`SELECT version FROM quality_cases WHERE id=$1`, [id])).rows[0].version;
  return api(t, 'POST', `/admin/quality/cases/${id}/transition`, { token: s.owner.token, body: { to, reason: `test → ${to}`, expected_version: v, ...(fault ? { fault } : {}) } });
}
async function toViolation(id: string) {
  for (const st of ['triage', 'investigating', 'reviewed']) expect((await move(id, st)).status).toBe(200);
  expect((await move(id, 'confirmed_violation', 'partner')).status).toBe(200);
}

describe('Quality Center P0', () => {
  it('Q01 + Q03: 100 resolved, 28 confirmed => 28% and a signal only; 20 pending never enter the denominator', () => {
    const r = rates({ ...base, confirmed: 28, resolved: 100, pending: 20 }, 30)[0]!;
    expect(r).toMatchObject({ metric: 'confirmation_rate', numerator: 28, denominator: 100, value_pct: 28, sample_size: 100, complete: false });
    expect(signalFor(r, policy)).toEqual({ signal: true, reason: 'threshold' });
  });

  it('Q02: 70 confirmed, 56 delivered => 80% delivery', () => {
    expect(rates({ ...base, delivered: 56, resolvedConfirmed: 70 }, 30)[1]!.value_pct).toBe(80);
  });

  it('Q04: 2 of 10 => 20% but below the minimum sample => no signal', () => {
    const r = rates({ ...base, confirmed: 2, resolved: 10 }, 30)[0]!;
    expect(r.value_pct).toBe(20);
    expect(signalFor(r, policy)).toEqual({ signal: false, reason: 'insufficient_sample' });
  });

  it('Q05 + Q20: customer says "I did not order" => order cancelled (never shipped) and a case opens for a human; works with AI off', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='ai.enabled'`);
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const o = await partnerOrder(p, prod.skuIds[0]!);
    const r = await api(t, 'POST', `/confirm/${o.dev_customer_link_token}`, { body: { decision: 'reject', code: o.dev_customer_code } });
    expect(r.status).toBe(200);
    const ord = (await t.db.query(`SELECT commercial_status, fulfillment_status FROM orders WHERE id=$1`, [o.order_id])).rows[0];
    expect(ord.commercial_status).toBe('cancelled');
    expect((await api(t, 'POST', `/ops/orders/${o.order_id}/pick`, { token: s.warehouse.token })).status).toBeGreaterThanOrEqual(400);
    const c = (await t.db.query(`SELECT reason_code, status FROM quality_cases WHERE partner_id=$1`, [p.partnerId])).rows;
    expect(c).toEqual([{ reason_code: 'customer_denied', status: 'detected' }]);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM quality_warnings WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(0);
  });

  it('Q06: the partner cannot confirm their own order as an operator', async () => {
    const p = await mkPartner(t);
    await t.db.query(`INSERT INTO memberships (user_id, role_code) VALUES ($1,'operator')`, [p.id]);
    const login = await mkUser(t, ['operator'], (await t.db.query(`SELECT phone_e164 FROM users WHERE id=$1`, [p.id])).rows[0].phone_e164).catch(() => null);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const o = await partnerOrder(p, prod.skuIds[0]!);
    const tok = login?.token ?? p.token;
    await t.db.query(`UPDATE orders SET assigned_operator_id=$2 WHERE id=$1`, [o.order_id, p.id]);
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [o.order_id])).rows[0].p;
    const r = await api(t, 'POST', `/ops/orders/${o.order_id}/calls`, { token: tok, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('SELF_CONFIRMATION_FORBIDDEN');
    expect((await t.db.query(`SELECT commercial_status FROM orders WHERE id=$1`, [o.order_id])).rows[0].commercial_status).toBe('awaiting_confirmation');
  });

  it('Q07: a repeated customer callback gives one confirmation', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const o = await partnerOrder(p, prod.skuIds[0]!);
    const a = await api(t, 'POST', `/confirm/${o.dev_customer_link_token}`, { body: { decision: 'confirm', code: o.dev_customer_code } });
    const b = await api(t, 'POST', `/confirm/${o.dev_customer_link_token}`, { body: { decision: 'confirm', code: o.dev_customer_code } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(400);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM order_confirmations WHERE order_id=$1 AND status='verified'`, [o.order_id])).rows[0].n).toBe(1);
  });

  it('Q08: one phone, two orders => a signal in the inbox, not an automatic fraud case', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const phone = nextPhone();
    await partnerOrder(p, prod.skuIds[0]!, phone);
    await partnerOrder(p, prod.skuIds[0]!, phone);
    const inbox = (await api(t, 'GET', '/admin/quality/inbox', { token: s.owner.token })).json;
    expect(inbox.same_phone.some((x: any) => x.partner_id === p.partnerId)).toBe(true);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM quality_cases WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(0);
  });

  it('Q09: a courier failure is not counted against the partner’s delivery rate', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    const id = o.json.order_id;
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    for (const st of ['pick', 'pack']) await api(t, 'POST', `/ops/orders/${id}/${st}`, { token: s.warehouse.token });
    await api(t, 'POST', `/ops/orders/${id}/ship`, { token: s.warehouse.token, body: { courier_user_id: s.courier.id, tracking_id: 'T' } });
    expect((await api(t, 'POST', `/courier/orders/${id}/fail`, { token: s.courier.token, body: { reason: 'Kuryer kechikdi', fault: 'courier', return_to_warehouse: true } })).status).toBe(200);
    const q = (await api(t, 'GET', `/admin/quality/partners/${p.partnerId}`, { token: s.owner.token })).json;
    const d = q.rates.find((x: any) => x.metric === 'delivery_rate');
    expect(d.denominator).toBe(0);
    expect(d.excluded.not_partner_fault).toBe(1);
  });

  it('Q10 + Q12: operator-fault or inconclusive cases do not add to the partner’s violations', async () => {
    const p = await mkPartner(t);
    const a = await openCase(p.partnerId);
    for (const st of ['triage', 'investigating', 'reviewed']) await move(a, st);
    expect((await move(a, 'confirmed_violation', 'operator')).status).toBe(200);
    const b = await openCase(p.partnerId);
    for (const st of ['triage', 'investigating', 'reviewed']) await move(b, st);
    expect((await move(b, 'inconclusive')).status).toBe(200);
    const r = (await api(t, 'GET', `/admin/quality/partners/${p.partnerId}`, { token: s.owner.token })).json.rates.find((x: any) => x.metric === 'verified_invalid_rate');
    expect(r).toMatchObject({ numerator: 0, denominator: 2 });
    expect((await api(t, 'POST', `/admin/quality/cases/${a}/warning`, { token: s.owner.token, body: { message: 'Bu operator xatosi edi, ogohlantirish emas' } })).status).toBe(409);
  });

  it('Q11 + Q17 + Q18 + Q19: warning once per case; partner answers and appeals; other partner cannot open it; decisions audited', async () => {
    const p = await mkPartner(t), other = await mkPartner(t);
    const id = await openCase(p.partnerId, 'customer_denied', `q19:${randomUUID()}`);
    await toViolation(id);
    const w1 = await api(t, 'POST', `/admin/quality/cases/${id}/warning`, { token: s.owner.token, body: { message: 'Mijoz roziligini aniq yozib oling' } });
    const w2 = await api(t, 'POST', `/admin/quality/cases/${id}/warning`, { token: s.owner.token, body: { message: 'Mijoz roziligini aniq yozib oling' } });
    expect(w1.json.level).toBe(1);
    expect(w2.json.replayed).toBe(true);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM quality_warnings WHERE case_id=$1`, [id])).rows[0].n).toBe(1);
    expect((await api(t, 'POST', `/admin/quality/cases/${id}/restrictions`, { token: s.owner.token, body: { kind: 'extra_verification', days: 7, reason: 'birinchi marta' } })).json.code).toBe('FIRST_TIME_IS_A_WARNING');
    expect((await api(t, 'POST', `/partner/quality/cases/${id}/response`, { token: other.token, body: { text: 'begona holat' } })).status).toBe(404);
    expect((await api(t, 'POST', `/partner/quality/cases/${id}/response`, { token: p.token, body: { text: 'Mijoz keyin fikrini o‘zgartirdi' } })).status).toBe(200);
    const ap = await api(t, 'POST', `/partner/quality/cases/${id}/appeal`, { token: p.token, body: { body: 'Qo‘ng‘iroq yozuvi bor, qayta ko‘ring' } });
    expect(ap.status).toBe(200);
    const res = await api(t, 'POST', `/admin/quality/appeals/${ap.json.id}/resolve`, { token: s.owner.token, body: { status: 'overturned', resolution: 'Dalil yetarli emas edi' } });
    expect(res.json.case_status).toBe('resolved_no_fault');
    const aud = (await t.db.query(`SELECT action, before, after, reason, actor_user_id FROM audit_events WHERE target_id=$1 AND action='quality.case_transition' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    expect(aud.before.status).toBe('reviewed');
    expect(aud.after).toMatchObject({ status: 'confirmed_violation', fault: 'partner' });
    expect(aud.actor_user_id).toBe(s.owner.id);
    expect(aud.reason).toMatch(/confirmed_violation/);
    // Q19: repeated case creation with the same key does not duplicate.
    const again = await api(t, 'POST', '/admin/quality/cases', { token: s.owner.token, body: { partner_id: p.partnerId, reason_code: 'customer_denied', idem_key: (await t.db.query(`SELECT idem_key FROM quality_cases WHERE id=$1`, [id])).rows[0].idem_key } });
    expect(again.json).toEqual({ id, created: false });
  });

  it('Q13: money penalty without a legally approved policy => 403', async () => {
    const p = await mkPartner(t);
    const r = await api(t, 'POST', '/admin/penalties', { token: s.owner.token, body: { partner_id: p.partnerId, reason_text: 'Konversiya past', amount_minor: '1000000' } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('MONETARY_PENALTY_NOT_APPROVED');
    const pol = await api(t, 'POST', '/admin/quality/policies', { token: s.owner.token, body: { metric: 'confirmation_rate', threshold_pct: 30, monetary_enabled: true } });
    expect(pol.status).toBe(200);
    expect((await api(t, 'POST', '/admin/penalties', { token: s.owner.token, body: { partner_id: p.partnerId, reason_text: 'Konversiya past', amount_minor: '1000000' } })).status).toBe(403); // still no legal approval / flag
  });

  it('Q14: a returned order’s commission reversal is not written as a penalty', async () => {
    const p = await mkPartner(t);
    const prod = await mkProduct(t, { prices: [50_000], stock: [10], rule: { kind: 'fixed_per_unit', fixed: 5_000 } });
    const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: prod.skuIds[0]!, qty: 1 }], { referral_code: p.code });
    const id = o.json.order_id;
    const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
    await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
    await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } });
    await fulfilCod(t, s, id);
    await t.db.query(`UPDATE order_lines SET returned_qty=1 WHERE order_id=$1`, [id]);
    const { recalcOrder } = await import('../src/modules/commissions/service.js');
    const { withTx } = await import('../src/platform/db.js');
    await withTx(t.db, (tx) => recalcOrder(tx, id, 'return'));
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM penalties WHERE partner_id=$1`, [p.partnerId])).rows[0].n).toBe(0);
    const kinds = (await t.db.query(`SELECT DISTINCT source_type FROM partner_ledger WHERE partner_id=$1`, [p.partnerId])).rows.map((x) => x.source_type);
    expect(kinds).not.toContain('penalty');
  });
});
