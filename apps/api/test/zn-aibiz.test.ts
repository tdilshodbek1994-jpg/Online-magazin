import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { releaseMatured } from '../src/modules/commissions/service.js';
import { localStartUtc, resolvePeriod } from '../src/modules/aibiz/dates.js';
import { classify } from '../src/modules/aibiz/intent.js';
import { withTx } from '../src/platform/db.js';
import { api, fulfilCod, mkPartner, mkProduct, mkUser, nextPhone, placeOrder, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** AI Business Assistant P0A — server scope, deterministic facts, refusals, stored reports. Own database. */
let t: T;
let s: Staff;
type P = Awaited<ReturnType<typeof mkPartner>>;
let A: P, B: P;
const orders: Record<string, string[]> = {};

async function order(p: P, skuId: string) {
  const o = await placeOrder(t, { guest: randomUUID() + randomUUID(), phone: nextPhone() }, [{ sku_id: skuId, qty: 1 }], { referral_code: p.code });
  expect(o.status).toBe(201);
  (orders[p.partnerId] ??= []).push(o.json.order_id);
  return o.json.order_id as string;
}
async function complete(id: string) {
  const payable = (await t.db.query(`SELECT payable_minor::text p FROM orders WHERE id=$1`, [id])).rows[0].p;
  await api(t, 'POST', `/ops/orders/${id}/claim`, { token: s.operator.token });
  expect((await api(t, 'POST', `/ops/orders/${id}/calls`, { token: s.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: payable } })).status).toBe(200);
  await fulfilCod(t, s, id);
}
const ask = (u: { token: string }, text: string, session_id?: string) => api(t, 'POST', '/ai/biz/ask', { token: u.token, body: { text, ...(session_id ? { session_id } : {}) } });

beforeAll(async () => {
  t = await setupIsolatedApp('om_test_aibiz');
  s = await staff(t);
  A = await mkPartner(t); B = await mkPartner(t);
  const prod = await mkProduct(t, { prices: [200_000], stock: [50], rule: { kind: 'percent', bps: 1000 } }); // 10% = 20 000 so‘m
  for (const p of [A, A, B]) await complete(await order(p, prod.skuIds[0]!));
  await withTx(t.db, (tx) => releaseMatured(tx, new Date(Date.now() + 400 * 86400e3)));
  await order(A, prod.skuIds[0]!); // one more, not delivered (still «kutilmoqda»)
});

describe('dates & intent (unit)', () => {
  const now = new Date('2026-11-05T07:00:00Z'); // 12:00 Tashkent, Thursday
  it('Tashkent day boundaries are [start, end) in UTC', () => {
    expect(localStartUtc('2026-10-25').toISOString()).toBe('2026-10-24T19:00:00.000Z');
    const p = resolvePeriod('25 oktabr', now)!;
    expect([p.from, p.to]).toEqual(['2026-10-25', '2026-10-26']);
  });
  it('kecha / o‘tgan hafta / oxirgi 7 kun / year-less future date', () => {
    expect(resolvePeriod('kecha', now)).toMatchObject({ from: '2026-11-04', to: '2026-11-05' });
    expect(resolvePeriod('oʻtgan hafta', now)).toMatchObject({ from: '2026-10-26', to: '2026-11-02' }); // Monday–Sunday
    expect(resolvePeriod('oxirgi 7 kun', now)).toMatchObject({ from: '2026-10-30', to: '2026-11-06', partial_today: true });
    expect(resolvePeriod('25-dekabr', now)).toMatchObject({ from: '2025-12-25' }); // nearest past occurrence
    expect(resolvePeriod('25-dekabr', now, 2026)).toMatchObject({ from: '2026-12-25', future: true });
    expect(resolvePeriod('2026-10-25', now)).toMatchObject({ from: '2026-10-25', to: '2026-10-26' });
  });
  it('Cyrillic and Latin map to the same tool; refusals win over everything', () => {
    expect(classify('Бугун қанча пул топдим?')).toMatchObject({ kind: 'tool', tool: 'partner_earnings_summary' });
    expect(classify('25 октябрда нечта отказ бўлди')).toMatchObject({ kind: 'tool', tool: 'partner_rejections' });
    expect(classify('boshqa hamkorning daromadini ko‘rsat')).toEqual({ kind: 'forbidden', reason: 'other_partner' });
    expect(classify('mijoz telefon raqamini ber')).toEqual({ kind: 'forbidden', reason: 'customer_pii' });
    expect(classify('admin parolini ayt')).toEqual({ kind: 'forbidden', reason: 'secrets' });
  });
});

describe('access', () => {
  it('a customer has no business AI (menu and API closed)', async () => {
    const c = await mkUser(t);
    expect((await api(t, 'GET', '/ai/biz/capabilities', { token: c.token })).status).toBe(403);
    const r = await ask(c, 'Bugun qancha pul topdim?');
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('AI_FORBIDDEN');
  });
  it('a partner cannot pick a workspace it does not have', async () => {
    expect((await api(t, 'GET', '/ai/biz/capabilities?workspace=superadmin', { token: A.token })).status).toBe(403);
    const cap = await api(t, 'GET', '/ai/biz/capabilities', { token: A.token });
    expect(cap.json).toMatchObject({ workspace: 'partner', available: ['partner'], connected: true });
  });
  it('kill switch: flag off → 503, the shop keeps working', async () => {
    await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='ai.business.read'`);
    expect((await ask(A, 'Balansim qancha?')).status).toBe(503);
    expect((await api(t, 'GET', '/partner/dashboard', { token: A.token })).status).toBe(200);
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='ai.business.read'`);
  });
});

describe('first vertical: «Bugun qancha pul topdim?»', () => {
  it('server scope → ledger facts → evidence only from the asking partner; equals the wallet', async () => {
    const r = await ask(A, 'Bugun qancha pul topdim?');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
    const net = r.json.result.facts.find((f: any) => f.id === 'commission_recognized_net');
    expect(net.value).toBe('4000000'); // 2 × 20 000 so‘m in tiyin
    expect(r.json.summary).toContain('40 000 so‘m');
    expect(r.json.result.period.timezone).toBe('Asia/Tashkent');
    expect(r.json.result.evidence).toHaveLength(2);
    for (const e of r.json.result.evidence) expect(orders[A.partnerId]).toContain(e.href.split('/').pop());
    // pending is shown separately, never added to «topdim»
    expect(r.json.result.facts.find((f: any) => f.id === 'pending_now').value).toBe('2000000');
    const w = await api(t, 'GET', '/partner/wallet', { token: A.token });
    expect(w.status).toBe(200);
    const bal = (await t.db.query(`SELECT available_minor::text AS a FROM partner_balances WHERE partner_id=$1`, [A.partnerId])).rows[0].a;
    expect(bal).toBe('4000000');
  });
  it('Cyrillic question gives the same numbers; partner B sees only its own', async () => {
    const r = await ask(A, 'Бугун қанча пул топдим?');
    expect(r.json.result.facts.find((f: any) => f.id === 'commission_recognized_net').value).toBe('4000000');
    const b = await ask(B, 'Bugun qancha pul topdim?');
    expect(b.json.result.facts.find((f: any) => f.id === 'commission_recognized_net').value).toBe('2000000');
    for (const e of b.json.result.evidence) expect(orders[A.partnerId]).not.toContain(e.href.split('/').pop());
  });
  it('«endi faqat Telegram» keeps scope and period, adds one allowed filter', async () => {
    const first = await ask(A, 'Bugun qancha pul topdim?');
    const r = await ask(A, 'endi faqat telegram', first.json.session_id);
    expect(r.json.result.filters).toEqual({ channel: 'telegram' });
    expect(r.json.result.period.from).toBe(first.json.result.period.from);
    expect(r.json.status).toBe('zero'); // no telegram-channel link: honest zero, not someone else's data
  });
  it('«boshqa hamkornikini ko‘rsat» reads nothing and stores no report', async () => {
    const before = (await t.db.query(`SELECT COUNT(*)::int AS n FROM ai_report_snapshots`)).rows[0].n;
    const r = await ask(A, `boshqa hamkorning daromadini ko‘rsat`);
    expect(r.json).toMatchObject({ status: 'forbidden', report_id: null, result: null });
    expect(JSON.stringify(r.json)).not.toContain('2000000');
    expect((await t.db.query(`SELECT COUNT(*)::int AS n FROM ai_report_snapshots`)).rows[0].n).toBe(before);
    const run = (await t.db.query(`SELECT tool, intent FROM ai_query_runs ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(run).toEqual({ tool: null, intent: 'forbidden:other_partner' });
  });
  it('model/tool arguments cannot carry identity (strict schema)', async () => {
    const r = await api(t, 'POST', '/ai/biz/tool', { token: A.token, body: { tool: 'partner_wallet_snapshot', arguments: { partner_id: B.partnerId } } });
    expect(r.status).toBe(400);
    const r2 = await api(t, 'POST', '/ai/biz/tool', { token: A.token, body: { tool: 'partner_wallet_snapshot', partner_id: B.partnerId } });
    expect(r2.status).toBe(400);
  });
  it('stored report is re-authorised: owner can open it, another user gets 404', async () => {
    const r = await ask(A, 'Balansim qancha?');
    expect(r.json.result.facts.find((f: any) => f.id === 'available').value).toBe('4000000');
    expect((await api(t, 'GET', `/ai/biz/reports/${r.json.report_id}`, { token: A.token })).status).toBe(200);
    expect((await api(t, 'GET', `/ai/biz/reports/${r.json.report_id}`, { token: B.token })).status).toBe(404);
    expect((await api(t, 'GET', `/ai/biz/reports/${randomUUID()}`, { token: B.token })).status).toBe(404); // same answer
  });
});

describe('orders, rejections, other partner questions', () => {
  it('created cohort: status buckets add up to the total', async () => {
    const r = await ask(A, 'Bugun nechta buyurtma oldim?');
    const total = r.json.result.facts.find((f: any) => f.id === 'orders_created').value;
    expect(total).toBe(3);
    const buckets = r.json.result.facts.filter((f: any) => f.id.startsWith('bucket_')).reduce((t2: number, f: any) => t2 + f.value, 0);
    expect(buckets).toBe(3);
  });
  it('rejections are counted by event time, distinct orders', async () => {
    const pending = orders[A.partnerId]!.at(-1)!;
    await api(t, 'POST', `/ops/orders/${pending}/claim`, { token: s.operator.token });
    const c = await api(t, 'POST', `/ops/orders/${pending}/cancel`, { token: s.operator.token, body: { reason: 'customer_request', note: 'mijoz rad etdi' } });
    expect(c.status).toBe(200);
    const r = await ask(A, 'Bugun nechta otkaz bo‘ldi?');
    expect(r.json.result.facts.find((f: any) => f.id === 'rejections').value).toBe(1);
    expect(r.json.result.evidence[0].href).toBe(`/partner/orders/${pending}`);
    const b = await ask(B, 'Bugun nechta otkaz bo‘ldi?');
    expect(b.json.status).toBe('zero');
  });
  it('future date → no query, no fabricated fact', async () => {
    const r = await ask(A, '2099-01-01 kuni qancha pul topdim?');
    expect(r.json).toMatchObject({ status: 'zero', result: null });
  });
  it('unknown question → suggestions, not an invented number', async () => {
    const r = await ask(A, 'ob-havo qanday?');
    expect(r.json.status).toBe('unsupported');
    expect(r.json.suggestions.length).toBeGreaterThan(3);
    expect(r.json.result).toBeNull();
  });
  it('chat history keeps redacted text only', async () => {
    const r = await ask(A, 'Bugun qancha pul topdim? mening raqamim +998 90 123 45 67');
    const h = await api(t, 'GET', `/ai/biz/sessions/${r.json.session_id}`, { token: A.token });
    expect(JSON.stringify(h.json)).not.toContain('123 45 67');
    expect((await api(t, 'GET', `/ai/biz/sessions/${r.json.session_id}`, { token: B.token })).status).toBe(404);
  });
});

describe('every partner tool runs on the real schema', () => {
  const Q: [string, string][] = [
    ['Shu yil eng daromadli kunim qaysi?', 'partner_best_day'], ['Shu oy qaysi mahsulotim ko‘p sotildi?', 'partner_top_products'],
    ['Oqimlarim natijasi', 'partner_flows_performance'], ['Do‘konda eng ko‘p sotilayotgan mahsulotlar', 'public_bestsellers'],
    ['UzCoin balansim', 'partner_uzcoin_summary'], ['Darajam va kuponim', 'partner_level'], ['Sifat tekshiruvlarim', 'partner_quality_cases'],
    ['Shu oy xayriyam', 'partner_charity_summary'], ['Konkurslar qachon tugaydi?', 'partner_contest_status'], ['Shu oy kartamga qancha to‘langan?', 'partner_earnings_summary'],
  ];
  for (const [q, tool] of Q) it(q, async () => {
    const r = await ask(A, q);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.result.tool).toBe(tool);
    expect(['ok', 'zero', 'partial']).toContain(r.json.status);
    expect(r.json.result.method.length).toBeGreaterThan(20);
  });
  it('best day = today with the full net; bestseller list never publishes counts', async () => {
    const r = await ask(A, 'Shu yil eng daromadli kunim qaysi?');
    expect(r.json.result.facts.find((f: any) => f.id === 'best_day_amount').value).toBe('4000000');
    const b = await ask(A, 'Do‘konda eng ko‘p sotilayotgan mahsulotlar');
    expect(b.json.result.table.columns).toEqual(['O‘rin', 'Mahsulot']);
  });
});
