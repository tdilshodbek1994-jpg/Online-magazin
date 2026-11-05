import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentPeriodKey } from '../src/modules/partners/programs.js';
import { api, balances, fulfilCod, mkPartner, mkProduct, mkUser, placeOrder, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

async function deliveredReferral(partner: { token: string }, n: number, price = 100_000) {
  const prod = await mkProduct(t, { prices: [price], stock: [n + 5], rule: { kind: 'percent', bps: 1000 } });
  const st = await api(t, 'POST', '/partner/streams', { token: partner.token, body: { product_id: prod.productId, name: 'S' } });
  for (let i = 0; i < n; i++) {
    const guest = randomUUID() + randomUUID();
    await api(t, 'POST', '/referrals/touch', { guest, body: { code: st.json.code } });
    const c = await mkUser(t);
    const o = await placeOrder(t, { token: c.token, guest, phone: c.phone }, [{ sku_id: prod.skuIds[0]!, qty: 1 }]);
    await fulfilCod(t, s, o.json.order_id);
  }
}
const journalBalanced = async () => (await t.db.query(`SELECT COALESCE(SUM(debit_minor) - SUM(credit_minor), 0)::text AS d FROM journal_entries`)).rows[0].d;

describe('Partner programs', () => {
  it('bonus rule: preview → award once per partner+period; partner sees progress', async () => {
    const p = await mkPartner(t);
    await deliveredReferral(p, 2);
    const rule = await api(t, 'POST', '/admin/bonus-rules', { token: s.owner.token, body: { name: 'Oyiga 2 ta', period: 'month', threshold_delivered: 2, amount_minor: '5000000' } });
    expect(rule.status).toBe(200);
    const key = currentPeriodKey('month');
    const prev = await api(t, 'GET', `/admin/bonus-rules/${rule.json.id}/preview`, { token: s.owner.token });
    expect(prev.json.period_key).toBe(key);
    expect(prev.json.items.find((x: any) => x.partner_id === p.partnerId)).toMatchObject({ delivered: 2, awarded: false });
    const before = await balances(t, p.partnerId);
    const a1 = await api(t, 'POST', `/admin/bonus-rules/${rule.json.id}/award`, { token: s.owner.token, body: { period_key: key } });
    expect(a1.json.awarded).toBeGreaterThanOrEqual(1);
    const after = await balances(t, p.partnerId);
    expect(BigInt(after.a) - BigInt(before.a)).toBe(5000000n);
    expect((await api(t, 'POST', `/admin/bonus-rules/${rule.json.id}/award`, { token: s.owner.token, body: { period_key: key } })).json.awarded).toBe(0);
    expect((await balances(t, p.partnerId)).a).toBe(after.a);
    const mine = await api(t, 'GET', '/partner/programs', { token: p.token });
    expect(mine.json.bonus_rules.find((r: any) => r.id === rule.json.id)).toMatchObject({ delivered: 2, awarded: true });
    expect(mine.json.bonuses[0]).toMatchObject({ source: 'rule', amount_minor: '5000000' });
    await api(t, 'POST', `/admin/bonus-rules/${rule.json.id}/active`, { token: s.owner.token, body: { active: false } });
  });

  it('contest: live board → finish freezes winners → prizes paid once', async () => {
    const winner = await mkPartner(t);
    const second = await mkPartner(t);
    const c = await api(t, 'POST', '/admin/contests', { token: s.owner.token, body: { title: 'Kuz konkursi', starts_at: new Date(Date.now() - 3600_000).toISOString(), ends_at: new Date(Date.now() + 86400_000).toISOString(), metric: 'delivered_orders', min_delivered: 1, prizes: [{ place: 1, text: 'Telefon', amount_minor: '10000000' }, { place: 2, amount_minor: '3000000' }] } });
    expect(c.status).toBe(200);
    await deliveredReferral(winner, 4); // other tests' partners (shared DB) have at most 2 in the window
    await deliveredReferral(second, 1);
    const live = await api(t, 'GET', '/partner/programs', { token: second.token });
    const lc = live.json.contests.find((x: any) => x.id === c.json.id);
    expect(lc.me.delivered).toBe(1);
    expect(lc.me.rank).toBeGreaterThan(1);
    expect(lc.top[0].name).not.toMatch(/\*/); // owner decision: real names on contest boards (photo or UzShop mark)
    const fin = await api(t, 'POST', `/admin/contests/${c.json.id}/finish`, { token: s.owner.token });
    expect(fin.json.winners[0]).toMatchObject({ pid: winner.partnerId, rank: 1 });
    const b1 = await balances(t, winner.partnerId);
    const pay = await api(t, 'POST', `/admin/contests/${c.json.id}/pay-prizes`, { token: s.owner.token });
    expect(pay.json.paid).toBe(2);
    expect(BigInt((await balances(t, winner.partnerId)).a) - BigInt(b1.a)).toBe(10000000n);
    expect((await api(t, 'POST', `/admin/contests/${c.json.id}/pay-prizes`, { token: s.owner.token })).json.paid).toBe(0);
    expect((await api(t, 'POST', `/admin/contests/${c.json.id}/finish`, { token: s.owner.token })).status).toBe(409);
  });

  it('penalty takes available first, rest becomes visible debt; cancel restores exactly', async () => {
    // Money penalties need an active, legally approved policy + flag (Quality Center Q13).
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='quality.monetary_penalties'`);
    await t.db.query(`INSERT INTO quality_policies (version, metric, threshold_pct, monetary_enabled, legal_approved_at, legal_reference) VALUES (9000,'confirmation_rate',30,true,now(),'test contract') ON CONFLICT (version) DO NOTHING`);
    const p = await mkPartner(t);
    await api(t, 'POST', '/admin/bonuses', { token: s.owner.token, body: { partner_id: p.partnerId, amount_minor: '5000000', reason: 'boshlang‘ich' } });
    const reason = await api(t, 'POST', '/admin/penalty-reasons', { token: s.owner.token, body: { name: 'Soxta buyurtma', default_amount_minor: '7000000' } });
    const pen = await api(t, 'POST', '/admin/penalties', { token: s.owner.token, body: { partner_id: p.partnerId, reason_id: reason.json.id, amount_minor: '7000000', note: 'test' } });
    expect(pen.json).toMatchObject({ from_available_minor: '5000000', to_debt_minor: '2000000' });
    expect(await balances(t, p.partnerId)).toMatchObject({ a: '0', d: '-2000000' });
    const mine = await api(t, 'GET', '/partner/programs', { token: p.token });
    expect(mine.json.penalties[0]).toMatchObject({ reason_text: 'Soxta buyurtma', amount_minor: '7000000', status: 'applied' });
    expect(mine.json.penalty_reasons.some((r: any) => r.name === 'Soxta buyurtma')).toBe(true);
    expect((await api(t, 'POST', `/admin/penalties/${pen.json.id}/cancel`, { token: s.owner.token, body: { reason: 'xato kiritildi' } })).status).toBe(200);
    expect(await balances(t, p.partnerId)).toMatchObject({ a: '5000000', d: '0' });
    expect((await api(t, 'POST', `/admin/penalties/${pen.json.id}/cancel`, { token: s.owner.token, body: { reason: 'yana' } })).status).toBe(409);
  });

  it('charity: donate from available (idempotent), cannot overdraw; owner hands over within the fund', async () => {
    const p = await mkPartner(t);
    await api(t, 'POST', '/admin/bonuses', { token: s.owner.token, body: { partner_id: p.partnerId, amount_minor: '1000000', reason: 'test' } });
    const key = randomUUID();
    const d1 = await api(t, 'POST', '/partner/charity', { token: p.token, idem: key, body: { amount_minor: '300000' } });
    expect(d1.status).toBe(200);
    const d2 = await api(t, 'POST', '/partner/charity', { token: p.token, idem: key, body: { amount_minor: '300000' } });
    expect(d2.json.replayed).toBe(true);
    expect((await balances(t, p.partnerId)).a).toBe('700000');
    expect((await api(t, 'POST', '/partner/charity', { token: p.token, idem: randomUUID(), body: { amount_minor: '900000' } })).json.code).toBe('INSUFFICIENT_AVAILABLE');
    const prog = await api(t, 'GET', '/partner/programs', { token: p.token });
    expect(prog.json.charity.mine).toBe('300000');
    const fund = await api(t, 'GET', '/admin/programs', { token: s.owner.token });
    const free = BigInt(fund.json.charity.total) - BigInt(fund.json.charity.handed);
    expect((await api(t, 'POST', '/admin/charity/handovers', { token: s.owner.token, body: { amount_minor: (free + 1n).toString(), recipient: 'Mehribonlik uyi' } })).json.code).toBe('CHARITY_FUND_INSUFFICIENT');
    expect((await api(t, 'POST', '/admin/charity/handovers', { token: s.owner.token, body: { amount_minor: '200000', recipient: 'Mehribonlik uyi', note: 'kvitansiya №1' } })).status).toBe(200);
  });

  it('partners cannot touch admin program endpoints; money endpoints need step-up', async () => {
    const p = await mkPartner(t);
    expect((await api(t, 'POST', '/admin/bonuses', { token: p.token, body: { partner_id: p.partnerId, amount_minor: '1', reason: 'hack' } })).status).toBe(403);
    expect((await api(t, 'GET', '/admin/programs', { token: p.token })).status).toBe(403);
    const ownerNoStepUp = await mkUser(t, ['owner'], undefined, false);
    const r = await api(t, 'POST', '/admin/bonuses', { token: ownerNoStepUp.token, body: { partner_id: p.partnerId, amount_minor: '1000', reason: 'test' } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('STEP_UP_REQUIRED');
    expect(await journalBalanced()).toBe('0');
  });
});
