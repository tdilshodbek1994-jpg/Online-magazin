import type { Queryable } from '../../platform/db.js';
import { BUCKET_SQL } from '../partners/cabinet.js';
import { decToScaled, usdRates, uzsToUsdCents } from './money.js';

/**
 * Partner ad/commission analytics engine (spec §13–17). Read-only over the ledger, accruals, orders and expenses —
 * it never writes money and never re-derives commission (amounts come from accruals/ledger produced by the one
 * commission function). Every aggregate is built from distinct facts in JS after scoped queries, so joins can
 * never multiply revenue or spend (T37).
 *
 *  report_basis = financial: commission recognised in the period (ledger moves into "available", minus later
 *                 reversals) and ad costs whose service days fall in the period. Payouts never change income.
 *  report_basis = cohort:    orders acquired in the period (click time for click-based orders, created time for
 *                 manual/explicit ones) with their current (as_of) state, plus ad costs of the same period.
 */
export type Basis = 'financial' | 'cohort';
export type Currency = 'UZS' | 'USD';
export interface Filter { partnerId: string; from: string; to: string; basis: Basis; currency: Currency; channel?: string | null; productId?: string | null; linkId?: string | null }
const TZ = 'Asia/Tashkent';
export const CHANNELS = ['telegram_channel', 'telegram_ads', 'instagram_target', 'organic', 'unknown'] as const;

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_year', 'custom'] as const;
/** [from, to) in Asia/Tashkent; weeks Monday–Sunday; custom `to` is an inclusive date. */
export async function resolvePeriod(q: Queryable, key: string, from?: string, to?: string): Promise<{ from: string; to: string; label: string }> {
  const d = (x: string) => `(date_trunc('${x}', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;
  const map: Record<string, [string, string]> = {
    today: [d('day'), `${d('day')} + interval '1 day'`],
    yesterday: [`${d('day')} - interval '1 day'`, d('day')],
    this_week: [d('week'), `${d('week')} + interval '1 week'`],
    last_week: [`${d('week')} - interval '1 week'`, d('week')],
    this_month: [d('month'), `${d('month')} + interval '1 month'`],
    last_month: [`${d('month')} - interval '1 month'`, d('month')],
    this_year: [d('year'), `${d('year')} + interval '1 year'`],
    last_year: [`${d('year')} - interval '1 year'`, d('year')],
  };
  if (key === 'custom') {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw Object.assign(new Error('bad period'), { code: 'PERIOD_INVALID' });
    const r = await q.query(`SELECT ($1::date::timestamp AT TIME ZONE '${TZ}') AS f, (($2::date + 1)::timestamp AT TIME ZONE '${TZ}') AS t`, [from, to]);
    return { from: new Date(r.rows[0].f).toISOString(), to: new Date(r.rows[0].t).toISOString(), label: `${from} — ${to}` };
  }
  const [f, t] = map[key] ?? map.this_month!;
  const r = await q.query(`SELECT ${f} AS f, ${t} AS t`);
  return { from: new Date(r.rows[0].f).toISOString(), to: new Date(r.rows[0].t).toISOString(), label: key };
}

const tashDay = (iso: string | Date) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10); // Asia/Tashkent is UTC+5 (no DST)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

interface OrderRow { id: string; masked: string; created_at: string; delivered_at: string | null; acq_at: string; bucket: string; link_id: string | null; placement_id: string | null; source_channel: string; capture_mode: string; product_ids: string[]; units: number; confirmed: boolean }
interface MoneyItem { order_id: string | null; link: string; channel: string; product_ids: string[]; date: string; uzs: bigint; kind: 'recognized' | 'expected' }
interface ExpItem { id: string; link: string; channel: string; uzs: bigint | null; usdCentsExact: bigint | null; date: string; payer: string; kind: string; isOther: boolean; product: string | null; zero: boolean }

export async function buildReport(q: Queryable, f: Filter) {
  const asOf = new Date().toISOString();
  const links = await q.query(`SELECT l.id, l.name, l.code, l.status, l.created_at, l.archived_at, l.product_id, pr.name AS product FROM referral_links l LEFT JOIN products pr ON pr.id=l.product_id WHERE l.partner_id=$1`, [f.partnerId]);
  const linkProduct = new Map<string, string | null>(links.rows.map((l) => [l.id, l.product_id]));
  const placements = await q.query(`SELECT id, root_link_id, channel, name, code, status FROM campaign_placements WHERE partner_id=$1`, [f.partnerId]);
  const plLink = new Map<string, string>(placements.rows.map((p) => [p.id, p.root_link_id]));

  // ---- Orders of this partner (one row per distinct order) ----
  const orders = (await q.query(`
    SELECT o.id, 'OM-***' || right(o.number, 3) AS masked, o.created_at, o.delivered_at, ${BUCKET_SQL} AS bucket, o.channel AS capture_mode,
           o.attribution->>'link_id' AS link_id, o.attribution->>'placement_id' AS placement_id,
           COALESCE(o.attribution->>'source_channel', cp.channel, 'unknown') AS source_channel,
           COALESCE(t.touched_at, o.created_at) AS acq_at, (o.confirmation_status='verified' AND ${BUCKET_SQL} <> 'new') AS confirmed,
           (SELECT array_agg(DISTINCT s.product_id::text) FROM order_lines ol JOIN skus s ON s.id=ol.sku_id WHERE ol.order_id=o.id) AS product_ids,
           (SELECT COALESCE(SUM(ol.qty - ol.canceled_qty - ol.returned_qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id) AS units
      FROM orders o LEFT JOIN referral_touches t ON t.id::text = o.attribution->>'touch_id' LEFT JOIN campaign_placements cp ON cp.id::text = o.attribution->>'placement_id'
     WHERE o.attributed_partner_id=$1`, [f.partnerId])).rows as OrderRow[];
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const linkOf = (o: OrderRow | undefined) => (o?.link_id ?? (o?.placement_id ? plLink.get(o.placement_id) : null) ?? '__none');
  const passes = (o: OrderRow | undefined) => !!o && (!f.channel || o.source_channel === f.channel || (f.channel === 'telegram' && o.source_channel.startsWith('telegram')))
    && (!f.productId || (o.product_ids ?? []).includes(f.productId)) && (!f.linkId || linkOf(o) === f.linkId);
  const inP = (iso: string | null) => !!iso && iso >= f.from && iso < f.to;
  const isoOf = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  for (const o of orders) { o.created_at = isoOf(o.created_at)!; o.acq_at = isoOf(o.acq_at)!; o.delivered_at = isoOf(o.delivered_at); }

  // ---- Commission facts (amounts exactly as produced by the commission service) ----
  const items: MoneyItem[] = [];
  if (f.basis === 'financial') {
    const led = await q.query(`
      SELECT a.order_id, l.created_at, CASE WHEN l.to_bucket='available' THEN l.amount_minor ELSE -l.amount_minor END::text AS amt
        FROM partner_ledger l JOIN commission_accruals a ON a.id::text = l.source_id
       WHERE l.partner_id=$1 AND l.source_type='accrual' AND l.created_at >= $2 AND l.created_at < $3
         AND (l.to_bucket='available' OR (l.from_bucket IN ('available','debt') AND l.to_bucket='external'))`, [f.partnerId, f.from, f.to]);
    for (const r of led.rows) {
      const o = byOrder.get(r.order_id);
      if (!passes(o)) continue;
      items.push({ order_id: r.order_id, link: linkOf(o), channel: o!.source_channel, product_ids: o!.product_ids ?? [], date: isoOf(r.created_at)!, uzs: BigInt(r.amt), kind: 'recognized' });
    }
  }
  const acc = await q.query(`SELECT order_id, state, target_minor::text AS t, COALESCE(available_at, created_at) AS d, review_required FROM commission_accruals WHERE partner_id=$1 AND state <> 'superseded'`, [f.partnerId]);
  let reviewCount = 0;
  for (const a of acc.rows) {
    const o = byOrder.get(a.order_id);
    if (!passes(o)) continue;
    if (a.review_required) reviewCount++;
    const amt = BigInt(a.t);
    if (f.basis === 'cohort') {
      if (!inP(o!.acq_at)) continue;
      if (a.state === 'available') items.push({ order_id: a.order_id, link: linkOf(o), channel: o!.source_channel, product_ids: o!.product_ids ?? [], date: isoOf(a.d)!, uzs: amt, kind: 'recognized' });
    }
    // Expected = still waiting for conditions; for financial basis: pipeline of orders created before the period end.
    if ((a.state === 'estimated' || a.state === 'pending') && amt > 0n && (f.basis === 'cohort' ? inP(o!.acq_at) : o!.created_at < f.to)) {
      items.push({ order_id: a.order_id, link: linkOf(o), channel: o!.source_channel, product_ids: o!.product_ids ?? [], date: o!.created_at, uzs: amt, kind: 'expected' });
    }
  }

  // ---- Expenses (partner-attributable vs shop-paid), prorated by service days, allocated to links ----
  const pFromDay = tashDay(f.from), pToDay = tashDay(new Date(Date.parse(f.to) - 1)); // inclusive
  const exp = await q.query(`
    SELECT e.*, e.service_from::text AS sf, e.service_to::text AS st, e.fx_date::text AS fxd,
           COALESCE((SELECT json_agg(json_build_object('link', a.root_link_id, 'placement', a.placement_id, 'share_bps', a.share_bps, 'amount', a.amount_original::text)) FROM expense_allocations a WHERE a.expense_id=e.id), '[]') AS allocs
      FROM ad_expenses e WHERE e.partner_id=$1 AND e.status='active' AND e.kind IN ('actual','adjustment','zero_confirmed')
       AND e.service_to >= $2::date AND e.service_from <= $3::date`, [f.partnerId, pFromDay, pToDay]);
  const expItems: ExpItem[] = [];
  let fxPending = 0, zeroConfirmed = false, anyExpense = false;
  for (const e of exp.rows) {
    if (f.channel && !(e.channel === f.channel || (f.channel === 'telegram' && String(e.channel).startsWith('telegram')))) continue;
    anyExpense = true;
    if (e.kind === 'zero_confirmed') { zeroConfirmed = true; continue; }
    const total = e.amount_uzs_minor === null ? null : BigInt(e.amount_uzs_minor);
    if (e.fx_status === 'pending') fxPending++;
    const origExact = decToScaled(String(e.amount_original), 2);
    // allocation shares (in the expense's own currency) → exact integer parts; the rest is "Taqsimlanmagan" (T21/T22)
    const den = origExact === 0n ? 1n : origExact * 10000n;
    const parts: { link: string; num: bigint }[] = [];
    let allocatedNum = 0n;
    for (const a of e.allocs as { link: string | null; placement: string | null; share_bps: number | null; amount: string | null }[]) {
      const link = a.link ?? (a.placement ? plLink.get(a.placement) ?? null : null);
      if (!link) continue;
      const num = a.share_bps !== null ? BigInt(a.share_bps) * origExact : decToScaled(String(a.amount), 2) * 10000n;
      parts.push({ link, num });
      allocatedNum += num;
    }
    if (allocatedNum < den) parts.push({ link: '__unallocated', num: den - allocatedNum });
    // Daily proration over the inclusive service window (equal split = analytic allocation, not provider daily spend).
    // Cumulative floor differences make every split sum back to the exact total.
    const span = BigInt(daysBetween(e.sf, e.st) + 1);
    const ovFrom = e.sf > pFromDay ? e.sf : pFromDay, ovTo = e.st < pToDay ? e.st : pToDay;
    const ovDays = daysBetween(ovFrom, ovTo) + 1;
    if (ovDays <= 0) continue;
    const startIdx = BigInt(daysBetween(e.sf, ovFrom));
    const split = (x: bigint, cum0: bigint, num: bigint, dayIdx: bigint) => {
      const at = (c: bigint, d: bigint) => (x * (c * span + num * d)) / (den * span);
      return at(cum0, dayIdx + 1n) - at(cum0, dayIdx);
    };
    let cum = 0n;
    for (const p of parts) {
      const cum0 = cum; cum += p.num;
      const lp = p.link === '__unallocated' ? null : linkProduct.get(p.link) ?? null;
      if (f.productId && lp !== f.productId) continue;
      if (f.linkId && p.link !== f.linkId) continue;
      for (let i = 0; i < ovDays; i++) {
        const di = startIdx + BigInt(i);
        const day = new Date(Date.parse(ovFrom) + i * 86400_000).toISOString().slice(0, 10);
        expItems.push({ id: e.id, link: p.link, channel: e.channel, uzs: total === null ? null : split(total, cum0, p.num, di), usdCentsExact: e.currency === 'USD' ? split(origExact, cum0, p.num, di) : null,
          date: `${day}T07:00:00.000Z`, payer: e.payer, kind: e.kind, isOther: e.channel === 'other', product: lp, zero: false });
      }
    }
  }

  // ---- Currency view (each item at its own date; missing rate → excluded and flagged) ----
  const usd = f.currency === 'USD' ? await usdRates(q, pFromDay, pToDay) : null;
  let usdMissing = 0;
  const cv = (uzs: bigint | null, iso: string, exactUsd: bigint | null = null): bigint | null => {
    if (uzs === null) return null;
    if (!usd) return uzs;
    if (exactUsd !== null) return exactUsd;
    const r = usd(tashDay(iso));
    if (!r) { usdMissing++; return null; }
    return uzsToUsdCents(uzs, r.rate, r.nominal);
  };

  // ---- Aggregate (rows + unallocated = totals) ----
  type Agg = { commission: bigint; expected: bigint; ad: bigint; adShop: bigint; other: bigint; orders: Set<string>; confirmed: Set<string>; delivered: Set<string>; units: number; dist: Record<string, number>; open: Set<string> };
  const mk = (): Agg => ({ commission: 0n, expected: 0n, ad: 0n, adShop: 0n, other: 0n, orders: new Set(), confirmed: new Set(), delivered: new Set(), units: 0, dist: { '1': 0, '2': 0, '3': 0, '4+': 0 }, open: new Set() });
  const rows = new Map<string, Agg>();
  const row = (k: string) => { let a = rows.get(k); if (!a) { a = mk(); rows.set(k, a); } return a; };
  const tot = mk();
  const series = new Map<string, { commission: bigint; ad: bigint }>();
  const chan = new Map<string, { commission: bigint; orders: number; ad: bigint }>();
  const sKey = (iso: string) => { const d = tashDay(iso); return daysBetween(pFromDay, pToDay) > 62 ? d.slice(0, 7) : d; };
  const ser = (iso: string) => { const k = sKey(iso); let s = series.get(k); if (!s) { s = { commission: 0n, ad: 0n }; series.set(k, s); } return s; };
  const ch = (c: string) => { let s = chan.get(c); if (!s) { s = { commission: 0n, orders: 0, ad: 0n }; chan.set(c, s); } return s; };

  for (const it of items) {
    const v = cv(it.uzs, it.date);
    if (v === null) continue;
    if (it.kind === 'recognized') { row(it.link).commission += v; tot.commission += v; ser(it.date).commission += v; ch(it.channel).commission += v; }
    else { row(it.link).expected += v; tot.expected += v; }
  }
  // order counts: cohort → acquired in period; financial → orders with activity: created in period (funnel) and delivered in period
  for (const o of orders) {
    if (!passes(o)) continue;
    const inScope = f.basis === 'cohort' ? inP(o.acq_at) : inP(o.created_at);
    const r = row(linkOf(o));
    if (inScope) {
      r.orders.add(o.id); tot.orders.add(o.id); ch(o.source_channel).orders++;
      if (o.confirmed) { r.confirmed.add(o.id); tot.confirmed.add(o.id); }
      if (['new', 'accepted', 'shipping'].includes(o.bucket)) { r.open.add(o.id); tot.open.add(o.id); }
    }
    const deliveredScope = o.bucket === 'delivered' && (f.basis === 'cohort' ? inP(o.acq_at) : inP(o.delivered_at));
    if (deliveredScope) {
      r.delivered.add(o.id); tot.delivered.add(o.id);
      r.units += o.units; tot.units += o.units;
      const k = o.units >= 4 ? '4+' : String(Math.max(1, o.units));
      r.dist[k] = (r.dist[k] ?? 0) + 1; tot.dist[k] = (tot.dist[k] ?? 0) + 1;
    }
  }
  for (const e of expItems) {
    const v = cv(e.uzs, e.date, e.usdCentsExact);
    if (v === null) continue;
    const r = row(e.link);
    if (e.payer === 'shop') { r.adShop += v; tot.adShop += v; continue; } // shop-paid ads never reduce the partner's result (T20)
    if (e.isOther) { r.other += v; tot.other += v; } else { r.ad += v; tot.ad += v; ser(e.date).ad += v; ch(e.channel === 'meta_mixed' ? 'instagram_target' : e.channel).ad += v; }
  }

  const ratio = (num: number | bigint, den: number | bigint, label: string, formula: string) => ({
    label, formula, num: String(num), den: String(den),
    value: Number(den) > 0 ? Math.round((Number(num) / Number(den)) * 1000) / 10 : null, // null → "Hisoblanmaydi" (never 0%, 100% or ∞)
  });
  const per = (amount: bigint, den: number) => (den > 0 ? (amount / BigInt(den)).toString() : null);
  const result = tot.commission - tot.ad - tot.other;
  const spendKnown = anyExpense; // unknown spend ≠ 0
  const totalsOut = {
    commission: tot.commission.toString(), expected: tot.expected.toString(), ad: spendKnown ? tot.ad.toString() : null, ad_shop_paid: tot.adShop.toString(),
    other: spendKnown ? tot.other.toString() : null, result: spendKnown ? result.toString() : null,
  };
  const linkInfo = new Map(links.rows.map((l) => [l.id, l]));
  const linkRows = [...rows.entries()].filter(([k]) => k !== '__unallocated').map(([k, a]) => {
    const l = linkInfo.get(k);
    return {
      link_id: k === '__none' ? null : k, name: k === '__none' ? 'Havolasiz (o‘zingiz kiritgan / kod bilan)' : (l?.name ?? l?.code ?? '—'), code: l?.code ?? null, product: l?.product ?? null,
      archived: !!(l?.archived_at || l?.status === 'disabled'),
      orders: a.orders.size, confirmed: a.confirmed.size, delivered: a.delivered.size, units: a.units, qty_distribution: a.dist, open: a.open.size,
      commission: a.commission.toString(), expected: a.expected.toString(), ad: spendKnown ? a.ad.toString() : null, other: spendKnown ? a.other.toString() : null,
      result: spendKnown ? (a.commission - a.ad - a.other).toString() : null,
      completeness: !spendKnown ? 'expense_missing' : a.open.size ? 'not_final' : 'ok',
    };
  }).sort((x, y) => (BigInt(y.commission) > BigInt(x.commission) ? 1 : -1));
  const un = rows.get('__unallocated');

  const newLinks = links.rows.filter((l) => inP(isoOf(l.created_at))).length;
  const activeLinks = linkRows.filter((r) => r.link_id && (r.orders > 0 || BigInt(r.commission) !== 0n)).length;
  const revenueLinks = linkRows.filter((r) => r.link_id && BigInt(r.commission) > 0n);
  const fmt = (v: string | null) => (v === null ? 'kiritilmagan' : f.currency === 'USD' ? `$${(Number(v) / 100).toFixed(2)}` : `${(BigInt(v) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`);
  const summary = `Bu davrda ${newLinks} ta yangi havola yaratdingiz. ${activeLinks} ta havolada faollik bo‘ldi, ${revenueLinks.length} tasi komissiya keltirdi. `
    + `Komissiya daromadi ${fmt(totalsOut.commission)}, reklama xarajati ${fmt(totalsOut.ad)}, kiritilgan boshqa xarajat ${fmt(totalsOut.other)}, reklamadan keyingi natija ${fmt(totalsOut.result)}. `
    + `Komissiya hali kutilayotgan summa ${fmt(totalsOut.expected)}.`
    + (revenueLinks.length ? ` Daromad keltirgan havola boshiga o‘rtacha ${fmt((tot.commission / BigInt(revenueLinks.length)).toString())} (bu o‘rtacha — har biri shuncha degani emas).` : '')
    + (!spendKnown ? ' Xarajat kiritilmagan, shuning uchun natija to‘liq emas.' : '');

  return {
    report_basis: f.basis, as_of: asOf, timezone: TZ, period: { from: f.from, to: f.to }, currency: f.currency,
    fx_method: f.currency === 'USD' ? 'Har yozuv o‘z sanasidagi rasmiy USD kursi bilan (haqiqiy dollar tushumi emas)' : 'UZS; valyutadagi xarajat kiritilgan sanadagi kurs bilan qotirilgan',
    filters: { channel: f.channel ?? null, product_id: f.productId ?? null, link_id: f.linkId ?? null },
    totals: totalsOut,
    counts: { orders: tot.orders.size, confirmed: tot.confirmed.size, delivered: tot.delivered.size, units: tot.units, open: tot.open.size, qty_distribution: tot.dist },
    ratios: {
      confirmation: ratio(tot.confirmed.size, tot.orders.size, 'Tasdiqlash ulushi', 'tasdiqlangan distinct buyurtmalar / jami distinct buyurtmalar'),
      delivery: ratio(tot.delivered.size, tot.confirmed.size, 'Yetkazish ulushi', 'yetkazilgan distinct buyurtmalar / tasdiqlangan distinct buyurtmalar'),
      delivery_total: ratio(tot.delivered.size, tot.orders.size, 'Umumiy yetkazish', 'yetkazilgan / jami'),
      commission_per_ad: spendKnown && tot.ad > 0n ? { label: 'Komissiya / reklama', formula: 'komissiya / reklama', value: Math.round((Number(tot.commission) / Number(tot.ad)) * 100) / 100 } : { label: 'Komissiya / reklama', formula: 'komissiya / reklama', value: null },
      ad_result_pct: ratio(result, spendKnown ? tot.ad : 0n, 'Reklama natijasi foizi', '(komissiya − reklama − boshqa xarajat) / reklama × 100'),
      cost_per_delivered_order: spendKnown ? per(tot.ad, tot.delivered.size) : null,
      cost_per_delivered_unit: spendKnown ? per(tot.ad, tot.units) : null,
    },
    completeness: {
      expense_entered: spendKnown, expense_zero_confirmed: zeroConfirmed, fx_pending: fxPending + usdMissing, unallocated_ad: un ? (un.ad + un.other).toString() : '0',
      not_final: tot.open.size > 0, review_required: reviewCount,
      notes: [!spendKnown && 'Xarajat kiritilmagan', tot.open.size > 0 && 'Natija hali yakuniy emas', fxPending + usdMissing > 0 && 'Valyuta kursi kutilmoqda (FX_PENDING) — bu yozuvlar jamiga kirmadi', reviewCount > 0 && `${reviewCount} ta buyurtma komissiyasi admin ko‘rib chiqishini kutmoqda`].filter(Boolean),
    },
    links: linkRows,
    unallocated: un ? { ad: un.ad.toString(), other: un.other.toString(), shop_paid: un.adShop.toString() } : { ad: '0', other: '0', shop_paid: '0' },
    channels: [...chan.entries()].map(([k, v]) => ({ channel: k, commission: v.commission.toString(), orders: v.orders, ad: v.ad.toString() })),
    series: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ key: k, commission: v.commission.toString(), ad: v.ad.toString(), result: (v.commission - v.ad).toString() })),
    link_counts: { created_in_period: newLinks, active: activeLinks, with_revenue: revenueLinks.length },
    summary_text: summary,
  };
}
