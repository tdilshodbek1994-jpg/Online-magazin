import { many, maybeOne, one, type Queryable } from '../../platform/db.js';
import { BUCKET_SQL } from '../partners/cabinet.js';
import { currentRate } from '../uzcoin/service.js';
import { localStartUtc, type Period } from './dates.js';
import type { Tool } from './intent.js';

/**
 * Read-only report tools. Every query is scoped by the SERVER-derived partner id BEFORE aggregation (never "compute for
 * everyone, hide names later"). Results are facts only — numbers come from SQL, text is rendered deterministically.
 *
 * Status: ok (data, possibly 0 with coverage) · zero (authorised scope has no matching rows) · unknown (no data source /
 * not recorded) · partial · forbidden · unsupported · unavailable. These are never collapsed into a plain 0.
 */
export type Status = 'ok' | 'zero' | 'unknown' | 'partial' | 'forbidden' | 'unsupported' | 'unavailable';
export interface Fact { id: string; label: string; value: string | number | null; unit: 'som' | 'orders' | 'units' | 'coins' | 'percent' | 'count' | 'text' | 'date'; kind?: 'observed' | 'computed'; primary?: boolean }
export interface Evidence { type: 'order' | 'flow' | 'product' | 'page'; label: string; href: string; value?: string }
export interface Row { cells: (string | number)[] }
export interface ToolResult {
  status: Status;
  tool: Tool;
  metric: string;
  metric_version: number;
  title: string;                 // states the interpretation, e.g. «Tan olingan sof komissiya»
  period?: { from: string; to_exclusive: string; label: string; timezone: string; partial_today: boolean };
  filters?: Record<string, string>;
  facts: Fact[];
  table?: { columns: string[]; rows: Row[] };
  evidence: Evidence[];
  method: string;                // «Hisoblash usuli» — the practical calculation path, not model reasoning
  partial_reasons: string[];
  open?: { label: string; href: string };
}

export interface Scope { partnerId: string }
const TZ = 'Asia/Tashkent';
const range = (p: Period) => [p.startUtc ?? localStartUtc(p.from).toISOString(), p.endUtc ?? localStartUtc(p.to).toISOString()];
const per = (p: Period) => ({ from: p.from, to_exclusive: p.to, label: p.label, timezone: TZ, partial_today: p.partial_today });
const mask = (n: string) => `OM-***${n.slice(-3)}`;
const pname = (j: Record<string, string> | null) => (j?.['uz-Latn'] ?? j?.['uz-Cyrl'] ?? Object.values(j ?? {})[0] ?? '—');

/** Join filter for an optional channel (referral link channel) on an orders alias `o`. */
function channelJoin(channel: string | undefined, params: unknown[]): string {
  if (!channel) return '';
  params.push(channel);
  return ` AND EXISTS (SELECT 1 FROM referral_links rl WHERE rl.id::text = o.attribution->>'link_id' AND rl.channel = $${params.length})`;
}

// ---------------------------------------------------------------------------------------------------------- earnings
export async function earnings(q: Queryable, s: Scope, p: Period, metric: 'commission_recognized_net' | 'payout_paid', channel?: string): Promise<ToolResult> {
  const [a, b] = range(p);
  if (metric === 'payout_paid') {
    const r = await one<{ paid: string; n: number }>(q, `SELECT COALESCE(SUM(amount_minor),0)::text AS paid, COUNT(*)::int AS n FROM partner_ledger WHERE partner_id=$1 AND source_type='payout' AND to_bucket='paid' AND created_at >= $2 AND created_at < $3`, [s.partnerId, a, b]);
    return {
      status: r.n ? 'ok' : 'zero', tool: 'partner_earnings_summary', metric, metric_version: 1, title: 'Kartangizga to‘langan pul (payout)', period: per(p),
      facts: [{ id: 'payout_paid', label: 'To‘langan', value: r.paid, unit: 'som', kind: 'observed', primary: true }, { id: 'payout_count', label: 'To‘lovlar soni', value: r.n, unit: 'count', kind: 'observed' }],
      evidence: [{ type: 'page', label: 'To‘lovlar tarixi', href: '/partner/payouts' }],
      method: 'Hisob daftaridagi «to‘landi» yozuvlari shu davrda (Toshkent vaqti) jamlandi. Bu topilgan komissiya emas — kartaga o‘tgan pul.',
      partial_reasons: [], open: { label: 'To‘lovlarni ochish', href: '/partner/payouts' },
    };
  }
  const params: unknown[] = [s.partnerId, a, b];
  const ch = channel ? channelJoin(channel, params) : '';
  // Accrual lines whose commission moved INTO «yechish mumkin» in the period, minus reversals of already-available
  // commission in the same period. Joined per accrual (no order×line×payment fan-out).
  const lines = await many<{ order_id: string; number: string; product: Record<string, string> | null; qty: number; inflow: string; outflow: string }>(q, `
    WITH m AS (
      SELECT a.id AS accrual_id, a.order_id, a.order_line_id,
             SUM(l.amount_minor) FILTER (WHERE l.to_bucket='available' AND l.from_bucket <> 'available') AS inflow,
             SUM(l.amount_minor) FILTER (WHERE l.from_bucket IN ('available','debt') AND l.to_bucket='external') AS outflow
        FROM partner_ledger l JOIN commission_accruals a ON a.id::text = l.source_id
       WHERE l.partner_id=$1 AND l.source_type='accrual' AND l.created_at >= $2 AND l.created_at < $3
       GROUP BY a.id, a.order_id, a.order_line_id
      HAVING SUM(l.amount_minor) FILTER (WHERE (l.to_bucket='available' AND l.from_bucket <> 'available') OR (l.from_bucket IN ('available','debt') AND l.to_bucket='external')) > 0)
    SELECT m.order_id, o.number, ol.product_snapshot->'name' AS product, ol.qty, COALESCE(m.inflow,0)::text AS inflow, COALESCE(m.outflow,0)::text AS outflow
      FROM m JOIN orders o ON o.id=m.order_id JOIN order_lines ol ON ol.id=m.order_line_id
     WHERE true${ch} ORDER BY o.number`, params);
  let inflow = 0n, outflow = 0n;
  for (const l of lines) { inflow += BigInt(l.inflow); outflow += BigInt(l.outflow); }
  const adj = await one<{ bonus: string; penalty: string }>(q, `SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE source_type IN ('bonus','cc_award') AND to_bucket='available'),0)::text AS bonus,
      COALESCE(SUM(amount_minor) FILTER (WHERE source_type='penalty' AND from_bucket='available'),0)::text AS penalty
    FROM partner_ledger WHERE partner_id=$1 AND created_at >= $2 AND created_at < $3`, [s.partnerId, a, b]);
  const bal = await maybeOne<{ estimated_minor: string; pending_minor: string; available_minor: string }>(q, `SELECT estimated_minor::text, pending_minor::text, available_minor::text FROM partner_balances WHERE partner_id=$1`, [s.partnerId]);
  const payout = await one<{ paid: string }>(q, `SELECT COALESCE(SUM(amount_minor),0)::text AS paid FROM partner_ledger WHERE partner_id=$1 AND source_type='payout' AND to_bucket='paid' AND created_at >= $2 AND created_at < $3`, [s.partnerId, a, b]);
  const net = inflow - outflow;
  const facts: Fact[] = [
    { id: 'commission_recognized_net', label: 'Topgan pulingiz', value: net.toString(), unit: 'som', kind: 'computed', primary: true },
    { id: 'commission_inflow', label: 'Hisobingizga o‘tgan komissiya', value: inflow.toString(), unit: 'som', kind: 'observed' },
    { id: 'commission_reversed', label: 'Qaytarish sababli ayirildi', value: outflow.toString(), unit: 'som', kind: 'observed' },
  ];
  if (!channel) facts.push(
    { id: 'bonus', label: 'Bonus/sovrin (alohida)', value: adj.bonus, unit: 'som', kind: 'observed' },
    { id: 'penalty', label: 'Jarima (alohida)', value: adj.penalty, unit: 'som', kind: 'observed' },
    { id: 'payout_paid', label: 'Shu davrda kartaga to‘langan', value: payout.paid, unit: 'som', kind: 'observed' },
    { id: 'pending_now', label: 'Hozir kutilmoqda (yetkazish/kutish muddati)', value: (BigInt(bal?.estimated_minor ?? 0) + BigInt(bal?.pending_minor ?? 0)).toString(), unit: 'som', kind: 'observed' },
  );
  return {
    status: lines.length ? 'ok' : 'zero', tool: 'partner_earnings_summary', metric: 'commission_recognized_net', metric_version: 1,
    title: 'Topgan pulingiz = shu davrda yechish mumkin bo‘lgan sof komissiya', period: per(p), filters: channel ? { channel } : undefined, facts,
    table: { columns: ['Buyurtma', 'Mahsulot', 'Komissiya'], rows: lines.slice(0, 50).map((l) => ({ cells: [mask(l.number), `${pname(l.product)} × ${l.qty}`, (BigInt(l.inflow) - BigInt(l.outflow)).toString()] })) },
    evidence: lines.slice(0, 20).map((l) => ({ type: 'order', label: `${mask(l.number)} · ${pname(l.product)}`, href: `/partner/orders/${l.order_id}`, value: (BigInt(l.inflow) - BigInt(l.outflow)).toString() })),
    method: 'Komissiya hisob daftaridan (ledger) olinadi: shu davrda (Toshkent vaqti, [boshi, oxiri)) «yechish mumkin»ga o‘tgan komissiya minus shu davrda qaytarish sababli ayirilgani. Bonus, jarima, kutilayotgan pul va to‘lovlar alohida ko‘rsatiladi — bitta summaga qo‘shilmaydi.',
    partial_reasons: [...(p.partial_today ? ['Davr hali tugamagan: natija hozirgacha.'] : []), ...(lines.length > 50 ? ['Jadvalda birinchi 50 qator; jami summa hamma qatordan.'] : [])],
    open: { label: 'Hamyonni ochish', href: '/partner/wallet' },
  };
}

// ---------------------------------------------------------------------------------------------------------- orders
export async function ordersCount(q: Queryable, s: Scope, p: Period, status?: string, channel?: string): Promise<ToolResult> {
  const [a, b] = range(p);
  const params: unknown[] = [s.partnerId, a, b];
  const ch = channelJoin(channel, params);
  const rows = await many<{ bucket: string; n: number }>(q, `SELECT ${BUCKET_SQL} AS bucket, COUNT(DISTINCT o.id)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at >= $2 AND o.created_at < $3${ch} GROUP BY 1`, params);
  const by = Object.fromEntries(rows.map((r) => [r.bucket, r.n])) as Record<string, number>;
  const total = rows.reduce((t, r) => t + r.n, 0);
  const origin = await many<{ channel: string; n: number }>(q, `SELECT o.channel, COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at >= $2 AND o.created_at < $3${ch} GROUP BY 1`, params);
  const L: Record<string, string> = { new: 'Yangi', accepted: 'Tasdiqlandi', shipping: 'Yo‘lda', delivered: 'Yetkazildi', returned: 'Qaytarildi', cancelled: 'Bekor qilindi' };
  const ORIG: Record<string, string> = { web: 'Havola orqali (mijoz o‘zi)', partner_assisted: 'Siz kiritgan', operator: 'Operator kiritgan' };
  const facts: Fact[] = [{ id: 'orders_created', label: status ? `Jami (shu kunlarda kelgan)` : 'Kelgan buyurtmalar', value: total, unit: 'orders', kind: 'observed', primary: !status }];
  if (status) facts.unshift({ id: `orders_${status}`, label: `${L[status]} (hozirgi holati)`, value: by[status] ?? 0, unit: 'orders', kind: 'observed', primary: true });
  for (const k of Object.keys(L)) if (k !== status && by[k]) facts.push({ id: `bucket_${k}`, label: L[k]!, value: by[k]!, unit: 'orders', kind: 'observed' });
  for (const o of origin) facts.push({ id: `origin_${o.channel}`, label: ORIG[o.channel] ?? o.channel, value: o.n, unit: 'orders', kind: 'observed' });
  const qs = status ? `status=${status}` : 'status=all';
  return {
    status: total ? 'ok' : 'zero', tool: 'partner_orders_count', metric: status ? `orders_by_current_status` : 'orders_created', metric_version: 1,
    title: 'Shu davrda KELGAN buyurtmalar (yaratilgan sana bo‘yicha) va ularning hozirgi holati', period: per(p), filters: channel ? { channel } : undefined, facts,
    evidence: [{ type: 'page', label: 'Buyurtmalar ro‘yxati', href: `/partner/orders?${qs}&period=all` }],
    method: 'Buyurtma yaratilgan vaqti shu davrga (Toshkent vaqti) tushganlar sanaldi; har buyurtma bitta hozirgi holatga kiradi, shuning uchun holatlar yig‘indisi jamiga teng. «Siz kiritgan» va «havola orqali» alohida.',
    partial_reasons: p.partial_today ? ['Davr hali tugamagan: natija hozirgacha.'] : [], open: { label: 'Buyurtmalarni ochish', href: `/partner/orders?${qs}&period=all` },
  };
}

/** «25-oktabrda nechta otkaz bo‘ldi?» = distinct orders whose rejection/cancel EVENT happened that day (not created that day). */
export async function rejections(q: Queryable, s: Scope, p: Period, channel?: string): Promise<ToolResult> {
  const [a, b] = range(p);
  const params: unknown[] = [s.partnerId, a, b];
  const ch = channelJoin(channel, params);
  const rows = await many<{ id: string; number: string; reason: string | null; created_at: string }>(q, `
    SELECT DISTINCT ON (o.id) o.id, o.number, COALESCE(e.reason, o.cancel_reason) AS reason, o.created_at
      FROM order_status_events e JOIN orders o ON o.id=e.order_id
     WHERE o.attributed_partner_id=$1 AND e.created_at >= $2 AND e.created_at < $3
       AND ((e.dimension='commercial' AND e.to_status='cancelled') OR (e.dimension='confirmation' AND e.to_status IN ('rejected','expired')))${ch}
     ORDER BY o.id, e.created_at`, params);
  const returned = await one<{ n: number }>(q, `SELECT COUNT(DISTINCT o.id)::int AS n FROM order_status_events e JOIN orders o ON o.id=e.order_id WHERE o.attributed_partner_id=$1 AND e.created_at >= $2 AND e.created_at < $3 AND e.dimension='fulfillment' AND e.to_status IN ('returned','failed')${ch}`, params);
  const byReason = new Map<string, number>();
  for (const r of rows) byReason.set(r.reason ?? 'sabab ko‘rsatilmagan', (byReason.get(r.reason ?? 'sabab ko‘rsatilmagan') ?? 0) + 1);
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'partner_rejections', metric: 'rejections_by_event_date', metric_version: 1,
    title: 'Shu davrda RAD/BEKOR qilingan buyurtmalar (rad etilgan vaqti bo‘yicha)', period: per(p), filters: channel ? { channel } : undefined,
    facts: [{ id: 'rejections', label: 'Rad/bekor qilingan buyurtmalar', value: rows.length, unit: 'orders', kind: 'observed', primary: true },
      { id: 'returns', label: 'Qaytarilgan (alohida)', value: returned.n, unit: 'orders', kind: 'observed' },
      ...[...byReason].slice(0, 6).map(([k, v], i) => ({ id: `reason_${i}`, label: `Sabab: ${k}`, value: v, unit: 'orders' as const, kind: 'observed' as const }))],
    evidence: rows.slice(0, 20).map((r) => ({ type: 'order', label: `${mask(r.number)}${r.reason ? ` · ${r.reason}` : ''}`, href: `/partner/orders/${r.id}` })),
    method: 'Buyurtma holati tarixidan shu davrda «bekor qilindi» yoki «rad etildi» bo‘lgan har buyurtma bir marta sanaldi. Bu «shu kuni kelib keyin rad bo‘lganlar» emas — u boshqa savol. Qaytarish alohida ko‘rsatiladi.',
    partial_reasons: p.partial_today ? ['Davr hali tugamagan: natija hozirgacha.'] : [], open: { label: 'Bekor qilinganlarni ochish', href: '/partner/orders?status=cancelled&period=all' },
  };
}

// ---------------------------------------------------------------------------------------------------------- wallet
export async function wallet(q: Queryable, s: Scope): Promise<ToolResult> {
  const b = await maybeOne<Record<string, string>>(q, `SELECT estimated_minor::text AS estimated, pending_minor::text AS pending, available_minor::text AS available, reserved_minor::text AS reserved, paid_minor::text AS paid, debt_minor::text AS debt, updated_at FROM partner_balances WHERE partner_id=$1`, [s.partnerId]);
  if (!b) return { status: 'zero', tool: 'partner_wallet_snapshot', metric: 'wallet_snapshot', metric_version: 1, title: 'Hamyon holati (hozir)', facts: [], evidence: [{ type: 'page', label: 'Hamyon', href: '/partner/wallet' }], method: 'Hamyonda hali hech qanday yozuv yo‘q.', partial_reasons: [], open: { label: 'Hamyonni ochish', href: '/partner/wallet' } };
  return {
    status: 'ok', tool: 'partner_wallet_snapshot', metric: 'wallet_snapshot', metric_version: 1, title: 'Hamyon holati — hozirgi lahza (kunlar bo‘yicha qo‘shilmaydi)',
    facts: [
      { id: 'available', label: 'Yechish mumkin', value: b.available!, unit: 'som', kind: 'observed', primary: true },
      { id: 'reserved', label: 'To‘lov so‘rovida band', value: b.reserved!, unit: 'som', kind: 'observed' },
      { id: 'pending', label: 'Kutish muddatida', value: b.pending!, unit: 'som', kind: 'observed' },
      { id: 'estimated', label: 'Yetkazilishi kutilmoqda', value: b.estimated!, unit: 'som', kind: 'observed' },
      { id: 'paid_total', label: 'Jami to‘langan (hamma vaqt)', value: b.paid!, unit: 'som', kind: 'observed' },
      ...(BigInt(b.debt ?? 0) !== 0n ? [{ id: 'debt', label: 'Qarzdorlik', value: (-BigInt(b.debt!)).toString(), unit: 'som' as const, kind: 'observed' as const }] : []),
    ],
    evidence: [{ type: 'page', label: 'Hamyon tarixi', href: '/partner/wallet' }],
    method: 'Hisob daftaridan yig‘ilgan joriy qoldiqlar. «Yechish mumkin» faqat yetkazilgan, to‘lovi tasdiqlangan va kutish muddati o‘tgan komissiya.',
    partial_reasons: [], open: { label: 'Hamyonni ochish', href: '/partner/wallet' },
  };
}

// ---------------------------------------------------------------------------------------------------------- best day
export async function bestDay(q: Queryable, s: Scope, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const rows = await many<{ day: string; net: string }>(q, `
    SELECT to_char((l.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day,
           (COALESCE(SUM(l.amount_minor) FILTER (WHERE l.to_bucket='available' AND l.from_bucket <> 'available'),0)
          - COALESCE(SUM(l.amount_minor) FILTER (WHERE l.from_bucket IN ('available','debt') AND l.to_bucket='external'),0))::text AS net
      FROM partner_ledger l WHERE l.partner_id=$1 AND l.source_type='accrual' AND l.created_at >= $2 AND l.created_at < $3
     GROUP BY 1 ORDER BY 2::bigint DESC, 1 LIMIT 10`, [s.partnerId, a, b]);
  const top = rows.filter((r) => BigInt(r.net) > 0n);
  const best = top[0];
  const ties = best ? top.filter((r) => r.net === best.net) : [];
  return {
    status: best ? 'ok' : 'zero', tool: 'partner_best_day', metric: 'best_day_commission_net', metric_version: 1, title: 'Eng daromadli kun (tan olingan sof komissiya bo‘yicha)', period: per(p),
    facts: best ? [{ id: 'best_day', label: ties.length > 1 ? `Eng yaxshi kunlar (teng: ${ties.length} ta)` : 'Eng yaxshi kun', value: ties.map((t) => t.day).join(', '), unit: 'date', kind: 'computed', primary: true },
      { id: 'best_day_amount', label: 'O‘sha kungi sof komissiya', value: best.net, unit: 'som', kind: 'computed' }] : [],
    table: { columns: ['Kun', 'Sof komissiya'], rows: top.slice(0, 10).map((r) => ({ cells: [r.day, r.net] })) },
    evidence: [{ type: 'page', label: 'Kunlar bo‘yicha statistika', href: '/partner/stats' }],
    method: 'Har Toshkent kuni uchun «yechish mumkin»ga o‘tgan komissiya minus qaytarishlar hisoblandi va eng kattasi tanlandi. Teng natijalar yashirilmaydi.',
    partial_reasons: p.partial_today ? ['Davr hali tugamagan: faqat hozirgacha bo‘lgan kunlar.'] : [], open: { label: 'Statistikani ochish', href: '/partner/stats' },
  };
}

// ---------------------------------------------------------------------------------------------------------- products
export async function topProducts(q: Queryable, s: Scope, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const rows = await many<{ product_id: string; name: Record<string, string>; units: number; orders: number }>(q, `
    SELECT sk.product_id, (array_agg(ol.product_snapshot->'name'))[1] AS name,
           SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty))::int AS units, COUNT(DISTINCT o.id)::int AS orders
      FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus sk ON sk.id=ol.sku_id
     WHERE o.attributed_partner_id=$1 AND o.delivered_at >= $2 AND o.delivered_at < $3 AND o.fulfillment_status='delivered'
     GROUP BY sk.product_id ORDER BY 3 DESC, 4 DESC LIMIT 10`, [s.partnerId, a, b]);
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'partner_top_products', metric: 'delivered_units_by_product', metric_version: 1, title: 'Eng ko‘p sotilgan mahsulotlaringiz (yetkazilgan dona bo‘yicha)', period: per(p),
    facts: rows[0] ? [{ id: 'top_product', label: 'Birinchi o‘rin', value: pname(rows[0].name), unit: 'text', kind: 'computed', primary: true }, { id: 'top_units', label: 'Yetkazilgan dona', value: rows[0].units, unit: 'units', kind: 'observed' }] : [],
    table: { columns: ['Mahsulot', 'Dona', 'Buyurtma'], rows: rows.map((r) => ({ cells: [pname(r.name), r.units, r.orders] })) },
    evidence: rows.slice(0, 10).map((r) => ({ type: 'product', label: pname(r.name), href: `/partner/market?q=${encodeURIComponent(pname(r.name)).slice(0, 80)}` })),
    method: 'Shu davrda yetkazilgan buyurtmalardagi donalar (bekor/qaytgan dona ayirilgan) mahsulot bo‘yicha jamlandi; buyurtmalar soni alohida ustunda.',
    partial_reasons: p.partial_today ? ['Davr hali tugamagan: natija hozirgacha.'] : [], open: { label: 'Marketni ochish', href: '/partner/market' },
  };
}

/** Shop-wide ranking open to partners: rank + product only — counts, sellers and partners are never published (D10). */
export async function bestsellers(q: Queryable, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const rows = await many<{ product_id: string; slug: string; name: Record<string, string> }>(q, `
    SELECT pr.id AS product_id, pr.slug, pr.name FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus sk ON sk.id=ol.sku_id JOIN products pr ON pr.id=sk.product_id AND pr.status='published'
     WHERE o.fulfillment_status='delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2
     GROUP BY pr.id, pr.slug, pr.name
     ORDER BY SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty)) DESC, pr.id LIMIT 10`, [a, b]);
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'public_bestsellers', metric: 'shop_bestseller_rank', metric_version: 1, title: 'Do‘kondagi eng ko‘p sotilayotgan mahsulotlar (faqat o‘rin)', period: per(p),
    facts: rows[0] ? [{ id: 'rank1', label: '1-o‘rin', value: pname(rows[0].name), unit: 'text', kind: 'computed', primary: true }] : [],
    table: { columns: ['O‘rin', 'Mahsulot'], rows: rows.map((r, i) => ({ cells: [i + 1, pname(r.name)] })) },
    evidence: rows.map((r) => ({ type: 'product', label: pname(r.name), href: `/p/${r.slug}` })),
    method: 'Butun do‘kon bo‘yicha yetkazilgan donalar tartibi. Faqat o‘rin ko‘rsatiladi: aniq sonlar, kim sotgani va boshqa hamkorlar ma’lumoti ochilmaydi.',
    partial_reasons: [], open: { label: 'Marketni ochish', href: '/partner/market' },
  };
}

// ---------------------------------------------------------------------------------------------------------- flows
export async function flows(q: Queryable, s: Scope, p: Period, channel?: string): Promise<ToolResult> {
  const [a, b] = range(p);
  const params: unknown[] = [s.partnerId, a, b];
  let chf = '';
  if (channel) { params.push(channel); chf = ` AND l.channel = $${params.length}`; }
  const rows = await many<{ id: string; name: string | null; code: string; channel: string | null; clicks: number; orders: number; delivered: number; commission: string }>(q, `
    SELECT l.id, l.name, l.code, l.channel,
      (SELECT COUNT(*)::int FROM referral_touches t WHERE t.link_id=l.id AND t.eligible AND t.touched_at >= $2 AND t.touched_at < $3) AS clicks,
      (SELECT COUNT(*)::int FROM orders o WHERE o.attributed_partner_id=$1 AND o.attribution->>'link_id'=l.id::text AND o.created_at >= $2 AND o.created_at < $3) AS orders,
      (SELECT COUNT(*)::int FROM orders o WHERE o.attributed_partner_id=$1 AND o.attribution->>'link_id'=l.id::text AND o.created_at >= $2 AND o.created_at < $3 AND ${BUCKET_SQL}='delivered') AS delivered,
      (SELECT COALESCE(SUM(a.target_minor),0)::text FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE a.partner_id=$1 AND a.state='available' AND o.attribution->>'link_id'=l.id::text AND o.created_at >= $2 AND o.created_at < $3) AS commission
      FROM referral_links l WHERE l.partner_id=$1${chf} ORDER BY l.created_at DESC LIMIT 30`, params);
  const active = rows.filter((r) => r.clicks || r.orders);
  return {
    status: active.length ? 'ok' : 'zero', tool: 'partner_flows_performance', metric: 'flow_performance', metric_version: 1, title: 'Oqimlaringiz natijasi', period: per(p), filters: channel ? { channel } : undefined,
    facts: [{ id: 'flows_active', label: 'Faol oqimlar', value: active.length, unit: 'count', kind: 'observed', primary: true },
      { id: 'clicks', label: 'Bosishlar (yaroqli)', value: active.reduce((t, r) => t + r.clicks, 0), unit: 'count', kind: 'observed' },
      { id: 'orders', label: 'Buyurtmalar', value: active.reduce((t, r) => t + r.orders, 0), unit: 'orders', kind: 'observed' },
      { id: 'delivered', label: 'Yetkazilgan', value: active.reduce((t, r) => t + r.delivered, 0), unit: 'orders', kind: 'observed' }],
    table: { columns: ['Oqim', 'Bosish', 'Buyurtma', 'Yetkazildi', 'Komissiya'], rows: active.map((r) => ({ cells: [r.name ?? r.code, r.clicks, r.orders, r.delivered, r.commission] })) },
    evidence: active.slice(0, 10).map((r) => ({ type: 'flow', label: r.name ?? r.code, href: '/partner/streams' })),
    method: 'Har oqim uchun: yaroqli bosishlar, shu davrda kelgan buyurtmalar, ulardan yetkazilganlari va «yechish mumkin» bo‘lgan komissiya. Siz kiritgan buyurtmalar bosish konversiyasiga qo‘shilmaydi.',
    partial_reasons: ['Reklama xarajati bu jadvalga hali qo‘shilmagan (keyingi bosqich).'], open: { label: 'Oqimlarni ochish', href: '/partner/streams' },
  };
}

// ---------------------------------------------------------------------------------------------------------- rewards
export async function uzcoin(q: Queryable, s: Scope): Promise<ToolResult> {
  const b = await maybeOne<{ available: string; reserved: string; earned_total: string; exchanged_total: string }>(q, `SELECT available::text, reserved::text, earned_total::text, exchanged_total::text FROM uzcoin_balances WHERE partner_id=$1`, [s.partnerId]);
  const rate = await currentRate(q);
  const facts: Fact[] = b ? [
    { id: 'coins_available', label: 'Ishlatish mumkin', value: b.available, unit: 'coins', kind: 'observed', primary: true },
    { id: 'coins_reserved', label: 'Band (almashtirish so‘rovida)', value: b.reserved, unit: 'coins', kind: 'observed' },
    { id: 'coins_earned', label: 'Jami topilgan', value: b.earned_total, unit: 'coins', kind: 'observed' },
    { id: 'coins_exchanged', label: 'Almashtirilgan', value: b.exchanged_total, unit: 'coins', kind: 'observed' },
    { id: 'coin_rate', label: '1 coin hozirgi qiymati', value: rate.som_per_coin_minor, unit: 'som', kind: 'observed' },
  ] : [];
  return {
    status: b ? 'ok' : 'zero', tool: 'partner_uzcoin_summary', metric: 'uzcoin_balance', metric_version: 1, title: 'UzCoin balansi', facts,
    evidence: [{ type: 'page', label: 'UzCoin', href: '/partner/uzcoin' }],
    method: 'UzCoin daftaridan. Shartlarni bajargan 1 dona = 1 coin. Coin qiymati — bu naqd pul to‘langani emas; almashtirish faqat UzCoin bo‘limidagi tasdiqlangan jarayon orqali.',
    partial_reasons: [], open: { label: 'UzCoin bo‘limini ochish', href: '/partner/uzcoin' },
  };
}

export async function level(q: Queryable, s: Scope): Promise<ToolResult> {
  const st = await maybeOne<{ units: number; level: number; vip_since: string | null }>(q, `SELECT units, level, vip_since FROM partner_level_state WHERE partner_id=$1`, [s.partnerId]);
  const defs = await many<{ level: number; name: string; threshold: number }>(q, `SELECT level, name, threshold FROM partner_level_defs ORDER BY threshold`);
  const units = st?.units ?? 0;
  const cur = [...defs].reverse().find((d) => units >= d.threshold) ?? defs[0];
  const next = defs.find((d) => d.threshold > units);
  const coupon = await maybeOne<{ status: string }>(q, `SELECT status FROM partner_commission_coupons WHERE partner_id=$1`, [s.partnerId]);
  const CS: Record<string, string> = { available: 'Bor (faollashtirish mumkin)', armed: 'Faollashtirilgan', reserved: 'Buyurtmaga band', used: 'Ishlatilgan', void: 'Bekor (chegaradan pastda)' };
  return {
    status: 'ok', tool: 'partner_level', metric: 'partner_level', metric_version: 1, title: 'Darajangiz',
    facts: [{ id: 'level', label: 'Daraja', value: cur ? `${cur.level}-daraja · ${cur.name}` : '—', unit: 'text', kind: 'observed', primary: true },
      { id: 'units', label: 'Hisobga olingan sotuvlar', value: units, unit: 'units', kind: 'observed' },
      ...(next ? [{ id: 'remaining', label: `Keyingi darajagacha (${next.name})`, value: next.threshold - units, unit: 'units' as const, kind: 'computed' as const }] : []),
      { id: 'coupon', label: '50% kupon', value: coupon ? CS[coupon.status] ?? coupon.status : 'Hali yo‘q', unit: 'text', kind: 'observed' },
      { id: 'vip', label: 'VIP', value: st?.vip_since ? 'Faol' : 'Yo‘q', unit: 'text', kind: 'observed' }],
    evidence: [{ type: 'page', label: 'Darajam', href: '/partner/level' }],
    method: 'Daraja faqat tasdiqlangan sotuvlardan (UzCoin daftari) hisoblanadi. AI kuponni faollashtirmaydi va imtiyozlarni o‘zgartirmaydi.',
    partial_reasons: [], open: { label: 'Darajam bo‘limini ochish', href: '/partner/level' },
  };
}

export async function quality(q: Queryable, s: Scope): Promise<ToolResult> {
  const cases = await many<{ id: string; status: string; created_at: string }>(q, `SELECT id, status, created_at FROM quality_cases WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 20`, [s.partnerId]);
  const warns = await one<{ n: number }>(q, `SELECT COUNT(*)::int AS n FROM quality_warnings WHERE partner_id=$1`, [s.partnerId]);
  const open = cases.filter((c) => !['final', 'resolved_no_fault', 'inconclusive'].includes(c.status)).length;
  return {
    status: 'ok', tool: 'partner_quality_cases', metric: 'quality_cases', metric_version: 1, title: 'Sifat: tekshiruvlar va ogohlantirishlar',
    facts: [{ id: 'open_cases', label: 'Ochiq tekshiruvlar', value: open, unit: 'count', kind: 'observed', primary: true }, { id: 'all_cases', label: 'Jami tekshiruvlar', value: cases.length, unit: 'count', kind: 'observed' }, { id: 'warnings', label: 'Ogohlantirishlar', value: warns.n, unit: 'count', kind: 'observed' }],
    evidence: [{ type: 'page', label: 'Sifat ko‘rsatkichlarim', href: '/partner/quality' }],
    method: 'Past ko‘rsatkich avtomatik ayb yoki jarima emas — faqat tekshiruv signali. Qaror va apellyatsiya Sifat bo‘limida; AI chora qo‘llamaydi.',
    partial_reasons: [], open: { label: 'Sifat bo‘limini ochish', href: '/partner/quality' },
  };
}

export async function charity(q: Queryable, s: Scope, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const r = await one<{ total: string; n: number; all_time: string }>(q, `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE created_at >= $2 AND created_at < $3),0)::text AS total, COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS n, COALESCE(SUM(amount_minor),0)::text AS all_time FROM charity_donations WHERE partner_id=$1 AND status <> 'cancelled'`, [s.partnerId, a, b]);
  return {
    status: r.n ? 'ok' : 'zero', tool: 'partner_charity_summary', metric: 'charity_donated', metric_version: 1, title: 'Xayriyangiz', period: per(p),
    facts: [{ id: 'donated', label: 'Shu davrda xayriya', value: r.total, unit: 'som', kind: 'observed', primary: true }, { id: 'donations', label: 'Xayriyalar soni', value: r.n, unit: 'count', kind: 'observed' }, { id: 'donated_all', label: 'Hamma vaqt', value: r.all_time, unit: 'som', kind: 'observed' }],
    evidence: [{ type: 'page', label: 'Xayriya markazi', href: '/partner/charity' }],
    method: 'Xayriya daftaridan (bekor qilinganlar kirmaydi). AI xayriyani yoqmaydi va balansdan pul yechmaydi.',
    partial_reasons: [], open: { label: 'Xayriya bo‘limini ochish', href: '/partner/charity' },
  };
}

export async function contests(q: Queryable, s: Scope): Promise<ToolResult> {
  // Rank comes from each contest's own official source: legacy board, or Contest Center snapshot (final > provisional) /
  // live provisional ranking. The shop bestseller list is a different thing and is never mixed in.
  const { contestBoard } = await import('../partners/programs.js');
  const { liveRanking, loadRules } = await import('../contests/engine.js');
  const legacy = await many<{ id: string; title: string; starts_at: string; ends_at: string; metric: string; min_delivered: number }>(q, `SELECT id, title, starts_at, ends_at, metric, min_delivered FROM contests WHERE status='active' AND ends_at > now() ORDER BY ends_at LIMIT 10`);
  const cc = await many<{ id: string; title: string; ends_at: string; joined: boolean }>(q, `SELECT c.id, v.title_latn AS title, v.ends_at, EXISTS (SELECT 1 FROM cc_enrollments e WHERE e.contest_id=c.id AND e.partner_id=$1 AND e.left_at IS NULL) AS joined
      FROM cc_contests c JOIN cc_versions v ON v.contest_id=c.id AND v.version=c.current_version WHERE c.status IN ('scheduled','active') ORDER BY v.ends_at LIMIT 10`, [s.partnerId]);
  const rows: { title: string; ends_at: string; joined: boolean; rank: number | null; total: number; kind: string }[] = [];
  for (const l of legacy) {
    const board = await contestBoard(q as never, l);
    const me = board.find((r) => r.pid === s.partnerId);
    rows.push({ title: l.title, ends_at: l.ends_at, joined: true, rank: me?.rank ?? null, total: board.length, kind: 'provisional' });
  }
  for (const c of cc) {
    let rank: number | null = null; let total = 0; let kind = 'provisional';
    if (c.joined) {
      const snap = await maybeOne<{ kind: string; rows: { partner_id: string; rank: number | null }[] }>(q, `SELECT kind, rows FROM cc_rankings WHERE contest_id=$1 ORDER BY (kind='final') DESC, computed_at DESC LIMIT 1`, [c.id]);
      const rules = snap ? null : await loadRules(q, c.id);
      const list = snap ? snap.rows : rules ? await liveRanking(q, c.id, 'provisional', rules) : [];
      kind = snap?.kind ?? 'provisional';
      rank = list.find((r) => r.partner_id === s.partnerId)?.rank ?? null;
      total = list.filter((r) => r.rank !== null).length;
    }
    rows.push({ title: c.title, ends_at: c.ends_at, joined: c.joined, rank, total, kind });
  }
  const mine = rows.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!)[0];
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'partner_contest_status', metric: 'contest_status', metric_version: 2, title: 'Davom etayotgan konkurslar va o‘rningiz',
    facts: [
      ...(mine ? [{ id: 'best_rank', label: `O‘rningiz (${mine.title.length > 24 ? mine.title.slice(0, 24) + '…' : mine.title})`, value: `${mine.rank}-o‘rin / ${mine.total}`, unit: 'text' as const, kind: 'observed' as const, primary: true }] : []),
      { id: 'active_contests', label: 'Faol konkurslar', value: rows.length, unit: 'count', kind: 'observed', primary: !mine },
    ],
    table: { columns: ['Konkurs', 'O‘rningiz', 'Tugaydi'], rows: rows.map((c) => ({ cells: [c.title, !c.joined ? 'qatnashmayapsiz' : c.rank ? `${c.rank}-o‘rin / ${c.total}` : 'hali reytingda yo‘q', new Date(c.ends_at).toISOString().slice(0, 10)] })) },
    evidence: [{ type: 'page', label: 'Konkurs markazi', href: '/partner/contests' }],
    method: 'O‘rin har bir konkursning o‘z rasmiy reytingidan olinadi (yakuniy bo‘lsa yakuniy, aks holda joriy). Joriy o‘rin o‘zgarishi mumkin: yetkazilmagan yoki to‘lovi tasdiqlanmagan buyurtmalar yakuniy hisobga kirmasligi mumkin. Sovrin faqat yakuniy natijadan keyin.',
    partial_reasons: rows.some((r) => r.kind !== 'final' && r.rank) ? ['O‘rin hali yakuniy emas.'] : [], open: { label: 'Konkurs markazini ochish', href: '/partner/contests' },
  };
}

// ---------------------------------------------------------------------------------------------------------- after-ad result
/**
 * «Reklamadan keyingi natija» = recognized net commission − ads the PARTNER paid, prorated to the days of the period that
 * the ad service covered. Store-paid ads are never subtracted. Not called «sof foyda»: taxes and other costs are unknown.
 */
export async function afterAd(q: Queryable, s: Scope, p: Period): Promise<ToolResult> {
  const base = await earnings(q, s, p, 'commission_recognized_net');
  const net = BigInt(String(base.facts.find((f) => f.id === 'commission_recognized_net')?.value ?? 0));
  const ads = await one<{ spend: string; n: number; no_fx: number }>(q, `
    SELECT COALESCE(SUM(CASE WHEN fx_status='ok' THEN amount_uzs_minor * (LEAST(service_to, ($3::date - 1)) - GREATEST(service_from, $2::date) + 1) / (service_to - service_from + 1) END),0)::bigint::text AS spend,
           COUNT(*) FILTER (WHERE fx_status='ok')::int AS n, COUNT(*) FILTER (WHERE fx_status <> 'ok')::int AS no_fx
      FROM ad_expenses WHERE partner_id=$1 AND status='active' AND payer='partner' AND kind IN ('actual','adjustment')
       AND service_from < $3::date AND service_to >= $2::date`, [s.partnerId, p.from, p.to]);
  const spend = BigInt(ads.spend);
  return {
    status: net || spend ? 'ok' : 'zero', tool: 'partner_earnings_summary', metric: 'partner_after_ad_result', metric_version: 1,
    title: 'Reklamadan keyingi natija = sof komissiya − o‘zingiz to‘lagan reklama', period: base.period,
    facts: [{ id: 'partner_after_ad_result', label: 'Reklamadan keyingi natija', value: (net - spend).toString(), unit: 'som', kind: 'computed', primary: true },
      { id: 'commission_recognized_net', label: 'Topgan pulingiz (komissiya)', value: net.toString(), unit: 'som', kind: 'observed' },
      { id: 'ad_spend_partner', label: 'Siz to‘lagan reklama (davrga taqsimlangan)', value: spend.toString(), unit: 'som', kind: 'computed' },
      { id: 'ad_records', label: 'Hisobga olingan xarajat yozuvlari', value: ads.n, unit: 'count', kind: 'observed' }],
    evidence: [{ type: 'page', label: 'Reklama xarajatlari', href: '/partner/expenses' }, ...base.evidence.slice(0, 10)],
    method: 'Komissiya — hisob daftaridan (yuqoridagi «pul topdim» bilan bir xil). Reklama — faqat siz to‘lagan va faol xarajatlar; bir necha kunlik xarajat kunlar bo‘yicha taqsimlanib, faqat shu davrga tushgan qismi olinadi. Do‘kon to‘lagan reklama ayirilmaydi. Soliq va boshqa xarajatlar kiritilmagani uchun bu «sof foyda» emas.',
    partial_reasons: [...base.partial_reasons, ...(ads.no_fx ? [`${ads.no_fx} ta xarajatda valyuta kursi yo‘q — hisobga olinmadi (0 deb olinmadi).`] : [])],
    open: { label: 'Reklama xarajatlarini ochish', href: '/partner/expenses' },
  };
}
