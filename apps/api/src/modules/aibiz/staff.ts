import { many, one, type Queryable } from '../../platform/db.js';
import { BUCKET_SQL } from '../partners/cabinet.js';
import { localStartUtc, type Period } from './dates.js';
import { matchForm } from './text.js';
import type { Fact, ToolResult } from './tools.js';

/**
 * Staff workspaces (operator, admin, superadmin). Scope rules:
 *  - operator: only tasks/calls/decisions of THIS operator (assignee/actor = me); customer phones are never returned.
 *  - admin: only areas granted by permissions (reports.read → sales/operators, payments.read|cod.confirm → COD,
 *    inventory.write → stock). The word «admin» grants nothing by itself.
 *  - superadmin (owner): all of the above + partner ranking (names, no contacts).
 * Every query aggregates inside the authorised scope; nothing is computed for everyone and hidden afterwards.
 */
export type StaffTool = 'operator_work_queue' | 'operator_activity_summary' | 'admin_sales_summary' | 'admin_cod_summary' | 'admin_inventory_summary' | 'admin_operators_summary' | 'admin_partners_top';
export interface StaffScope { userId: string; workspace: 'operator' | 'admin' | 'superadmin'; perms: Set<string> }

const TZ = 'Asia/Tashkent';
const range = (p: Period) => [p.startUtc ?? localStartUtc(p.from).toISOString(), p.endUtc ?? localStartUtc(p.to).toISOString()];
const per = (p: Period) => ({ from: p.from, to_exclusive: p.to, label: p.label, timezone: TZ, partial_today: p.partial_today });
const mask = (n: string) => `OM-***${n.slice(-3)}`;
const pname = (j: Record<string, string> | null) => (j?.['uz-Latn'] ?? j?.['uz-Cyrl'] ?? Object.values(j ?? {})[0] ?? '—');
const partial = (p: Period) => (p.partial_today ? ['Davr hali tugamagan: natija hozirgacha.'] : []);

/** Tools a staff principal may call — derived from server permissions only. */
export function staffTools(s: StaffScope): StaffTool[] {
  if (s.workspace === 'operator') return ['operator_work_queue', 'operator_activity_summary'];
  const t: StaffTool[] = [];
  const p = (x: string) => s.perms.has(x);
  if (p('reports.read')) t.push('admin_sales_summary', 'admin_operators_summary');
  if (p('payments.read') || p('cod.confirm')) t.push('admin_cod_summary');
  if (p('inventory.write')) t.push('admin_inventory_summary');
  if (s.workspace === 'superadmin') t.push('admin_partners_top');
  return t;
}

export const STAFF_QUICK: Record<StaffTool, string> = {
  operator_work_queue: 'Hozir navbatimda nechta ish bor?',
  operator_activity_summary: 'Bugun nechta buyurtmani tasdiqladim?',
  admin_sales_summary: 'Bugungi savdo qancha?',
  admin_cod_summary: 'Kuryerlardagi naqd pul (COD) holati',
  admin_inventory_summary: 'Qaysi mahsulotlar tugayapti?',
  admin_operators_summary: 'Operatorlar natijasi (oxirgi 7 kun)',
  admin_partners_top: 'Shu oy eng yaxshi hamkorlar',
};

/** Deterministic staff intent; returns null when no staff tool matches. */
export function classifyStaff(text: string): StaffTool | null {
  const t = matchForm(text);
  if (/navbat|ishlarim|vazifa|queue|qayta qongiroq\w* (kerak|vaqti)|callback|kechik/.test(t)) return 'operator_work_queue';
  if (/tasdiqladim|qongiroq\w* qildim|statistikam|natijam|ishlagan|rad etdim/.test(t)) return 'operator_activity_summary';
  if (/hamkor\w*\s*(top|reyting|eng yaxshi)|eng yaxshi hamkor|top hamkor/.test(t)) return 'admin_partners_top';
  if (/operator\w*/.test(t)) return 'admin_operators_summary';
  if (/\bcod\b|naqd|kuryer|inkassa|topshir\w* pul/.test(t)) return 'admin_cod_summary';
  if (/ombor|zaxira|qoldiq|tugayapti|tugagan|stock|sklad/.test(t)) return 'admin_inventory_summary';
  if (/savdo|sotuv|tushum|buyurtma|zakaz|daromad|oborot/.test(t)) return 'admin_sales_summary';
  return null;
}

export const STAFF_DEFAULT_DAYS: Partial<Record<StaffTool, number>> = { admin_operators_summary: 7, admin_partners_top: 30 };

// ---------------------------------------------------------------------------------------------------------- operator
export async function operatorQueue(q: Queryable, s: StaffScope): Promise<ToolResult> {
  const r = await one<{ open: number; overdue: number; callbacks_due: number; attempts_high: number }>(q, `SELECT
      COUNT(*) FILTER (WHERE t.state NOT IN ('resolved','closed'))::int AS open,
      COUNT(*) FILTER (WHERE t.state NOT IN ('resolved','closed') AND t.due_at < now())::int AS overdue,
      (SELECT COUNT(*)::int FROM orders o WHERE o.assigned_operator_id=$1 AND o.callback_at IS NOT NULL AND o.callback_at <= now() AND o.commercial_status NOT IN ('cancelled','completed')) AS callbacks_due,
      COUNT(*) FILTER (WHERE t.state NOT IN ('resolved','closed') AND t.attempts >= 3)::int AS attempts_high
    FROM ops_tasks t WHERE t.assignee_id=$1`, [s.userId]);
  // Priority is the backend rule: overdue callback first, then SLA due time, then intake time. No hidden scores.
  const rows = await many<{ order_id: string | null; number: string | null; type: string; due_at: string | null; attempts: number; callback_at: string | null }>(q, `
    SELECT t.order_id, o.number, t.type, t.due_at, t.attempts, o.callback_at FROM ops_tasks t LEFT JOIN orders o ON o.id=t.order_id
     WHERE t.assignee_id=$1 AND t.state NOT IN ('resolved','closed')
     ORDER BY (o.callback_at IS NOT NULL AND o.callback_at <= now()) DESC, t.due_at NULLS LAST, t.created_at LIMIT 10`, [s.userId]);
  return {
    status: r.open ? 'ok' : 'zero', tool: 'operator_work_queue' as never, metric: 'operator_queue_now', metric_version: 1, title: 'Navbatingiz — hozirgi holat (sizga biriktirilgan ishlar)',
    facts: [{ id: 'open', label: 'Ochiq ishlar', value: r.open, unit: 'count', kind: 'observed', primary: true },
      { id: 'overdue', label: 'Muddati o‘tgan', value: r.overdue, unit: 'count', kind: 'observed' },
      { id: 'callbacks_due', label: 'Qayta qo‘ng‘iroq vaqti kelgan', value: r.callbacks_due, unit: 'count', kind: 'observed' },
      { id: 'attempts_high', label: '3+ urinish bo‘lgan', value: r.attempts_high, unit: 'count', kind: 'observed' }],
    table: { columns: ['Buyurtma', 'Ish turi', 'Urinish'], rows: rows.map((x) => ({ cells: [x.number ? mask(x.number) : '—', x.type, x.attempts] })) },
    evidence: [{ type: 'page', label: 'Operator xonasi', href: '/ops' }],
    method: 'Faqat sizga biriktirilgan ochiq ishlar. Tartib: avval vaqti o‘tgan qayta qo‘ng‘iroq, keyin muddat (SLA), keyin kelgan vaqti. «Urinish» faqat qayd etilgan qo‘ng‘iroq natijalaridan; telefoniya ulanmagani uchun qayd etilmagan qo‘ng‘iroqlar haqida xulosa qilinmaydi.',
    partial_reasons: [], open: { label: 'Operator xonasini ochish', href: '/ops' },
  };
}

export async function operatorActivity(q: Queryable, s: StaffScope, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const calls = await many<{ outcome: string; n: number }>(q, `SELECT outcome, COUNT(*)::int AS n FROM call_logs WHERE operator_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 2 DESC`, [s.userId, a, b]);
  const dec = await one<{ confirmed: number; cancelled: number }>(q, `SELECT
      COUNT(DISTINCT order_id) FILTER (WHERE dimension='commercial' AND to_status='confirmed')::int AS confirmed,
      COUNT(DISTINCT order_id) FILTER (WHERE dimension='commercial' AND to_status='cancelled')::int AS cancelled
    FROM order_status_events WHERE actor_user_id=$1 AND created_at >= $2 AND created_at < $3`, [s.userId, a, b]);
  const total = calls.reduce((t, c) => t + c.n, 0);
  const OUT: Record<string, string> = { confirmed: 'Tasdiqlandi', no_answer: 'Javob bermadi', call_later: 'Keyinroq qo‘ng‘iroq', rejected: 'Rad etdi', wrong_data: 'Ma’lumot noto‘g‘ri' };
  return {
    status: total || dec.confirmed || dec.cancelled ? 'ok' : 'zero', tool: 'operator_activity_summary' as never, metric: 'operator_own_activity', metric_version: 1, title: 'Sizning ishingiz (faqat o‘zingiz qilgan amallar)', period: per(p),
    facts: [{ id: 'confirmed', label: 'Siz tasdiqlagan buyurtmalar', value: dec.confirmed, unit: 'orders', kind: 'observed', primary: true },
      { id: 'cancelled', label: 'Siz bekor qilgan', value: dec.cancelled, unit: 'orders', kind: 'observed' },
      { id: 'calls', label: 'Qayd etilgan qo‘ng‘iroqlar', value: total, unit: 'count', kind: 'observed' },
      ...calls.slice(0, 6).map((c) => ({ id: `call_${c.outcome}`, label: OUT[c.outcome] ?? c.outcome, value: c.n, unit: 'count' as const, kind: 'observed' as const }))],
    evidence: [{ type: 'page', label: 'Operator xonasi', href: '/ops' }],
    method: 'Buyurtma holati tarixidagi siz bajargan tasdiqlash/bekor qilish amallari (har buyurtma bir marta) va siz qayd etgan qo‘ng‘iroq natijalari. Bu baho yoki jarima emas.',
    partial_reasons: partial(p), open: { label: 'Operator xonasini ochish', href: '/ops' },
  };
}

// ---------------------------------------------------------------------------------------------------------- admin
export async function salesSummary(q: Queryable, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const buckets = await many<{ bucket: string; n: number }>(q, `SELECT ${BUCKET_SQL} AS bucket, COUNT(*)::int AS n FROM orders o WHERE o.created_at >= $1 AND o.created_at < $2 GROUP BY 1`, [a, b]);
  const created = buckets.reduce((t, x) => t + x.n, 0);
  const del = await one<{ orders: number; amount: string; units: number }>(q, `SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.payable_minor),0)::text AS amount,
      COALESCE((SELECT SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty)) FROM order_lines ol JOIN orders o2 ON o2.id=ol.order_id WHERE o2.fulfillment_status='delivered' AND o2.delivered_at >= $1 AND o2.delivered_at < $2),0)::int AS units
    FROM orders o WHERE o.fulfillment_status='delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2`, [a, b]);
  const top = await many<{ name: Record<string, string>; units: number }>(q, `SELECT (array_agg(ol.product_snapshot->'name'))[1] AS name, SUM(GREATEST(0, ol.qty - ol.canceled_qty - ol.returned_qty))::int AS units
      FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus sk ON sk.id=ol.sku_id WHERE o.fulfillment_status='delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2
     GROUP BY sk.product_id ORDER BY 2 DESC LIMIT 5`, [a, b]);
  const L: Record<string, string> = { new: 'Kutilmoqda', accepted: 'Qabul qilindi', shipping: 'Yo‘lda', delivered: 'Yetkazildi', returned: 'Qaytdi', cancelled: 'Bekor/rad' };
  const facts: Fact[] = [
    { id: 'delivered_amount', label: 'Yetkazilgan buyurtmalar summasi', value: del.amount, unit: 'som', kind: 'observed', primary: true },
    { id: 'delivered_orders', label: 'Yetkazilgan buyurtmalar', value: del.orders, unit: 'orders', kind: 'observed' },
    { id: 'delivered_units', label: 'Yetkazilgan dona', value: del.units, unit: 'units', kind: 'observed' },
    { id: 'orders_created', label: 'Shu davrda kelgan buyurtmalar', value: created, unit: 'orders', kind: 'observed' },
    ...buckets.filter((x) => x.n).map((x) => ({ id: `bucket_${x.bucket}`, label: `— ${L[x.bucket] ?? x.bucket}`, value: x.n, unit: 'orders' as const, kind: 'observed' as const })),
  ];
  return {
    status: created || del.orders ? 'ok' : 'zero', tool: 'admin_sales_summary' as never, metric: 'shop_sales', metric_version: 1, title: 'Do‘kon savdosi: yetkazilgan (yetkazilgan sana bo‘yicha) va kelgan buyurtmalar', period: per(p), facts,
    table: { columns: ['Mahsulot', 'Dona'], rows: top.map((x) => ({ cells: [pname(x.name), x.units] })) },
    evidence: [{ type: 'page', label: 'Admin · buyurtmalar', href: '/admin' }],
    method: 'Yetkazilgan summa — shu davrda yetkazilgan buyurtmalarning to‘lanadigan summasi. Bu hali kassaga tushgan pul emas (COD alohida: «naqd pul holati»). Kelgan buyurtmalar yaratilgan sana bo‘yicha va hozirgi holatlari bilan.',
    partial_reasons: partial(p), open: { label: 'Admin panelni ochish', href: '/admin' },
  };
}

export async function codSummary(q: Queryable, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const c = await one<{ collected: string; collected_n: number }>(q, `SELECT COALESCE(SUM(collected_minor),0)::text AS collected, COUNT(*)::int AS collected_n FROM cod_collections WHERE collected_at >= $1 AND collected_at < $2`, [a, b]);
  const r = await one<{ received: string; n: number }>(q, `SELECT COALESCE(SUM(received_minor),0)::text AS received, COUNT(*)::int AS n FROM cod_remittances WHERE status='confirmed' AND confirmed_at >= $1 AND confirmed_at < $2`, [a, b]);
  const open = await one<{ outstanding: string; n: number }>(q, `SELECT COALESCE(SUM(collected_minor),0)::text AS outstanding, COUNT(*)::int AS n FROM cod_collections WHERE collected_minor IS NOT NULL AND remittance_id IS NULL`);
  const pend = await one<{ amount: string; n: number }>(q, `SELECT COALESCE(SUM(payable_minor),0)::text AS amount, COUNT(*)::int AS n FROM orders WHERE payment_method='cod' AND fulfillment_status='shipped' AND commercial_status <> 'cancelled'`);
  return {
    status: c.collected_n || r.n || open.n || pend.n ? 'ok' : 'zero', tool: 'admin_cod_summary' as never, metric: 'cod_states', metric_version: 1, title: 'Naqd pul (COD): yig‘ilgan, topshirilgan va qo‘lda turgan — alohida', period: per(p),
    facts: [{ id: 'outstanding_now', label: 'Kuryerlarda turgan (hali topshirilmagan) — hozir', value: open.outstanding, unit: 'som', kind: 'observed', primary: true },
      { id: 'collected', label: 'Shu davrda mijozdan yig‘ilgan', value: c.collected, unit: 'som', kind: 'observed' },
      { id: 'remitted', label: 'Shu davrda kassaga topshirilgan (tasdiqlangan)', value: r.received, unit: 'som', kind: 'observed' },
      { id: 'in_transit', label: 'Yo‘ldagi COD buyurtmalar (hali yig‘ilmagan) — hozir', value: pend.amount, unit: 'som', kind: 'observed' }],
    evidence: [{ type: 'page', label: 'Moliya', href: '/admin' }],
    method: 'Uch holat aralashtirilmaydi: buyurtma summasi hali pul emas; yig‘ilgan — kuryer mijozdan olgan; topshirilgan — kassada tasdiqlangan. «Hozir» qatorlari — joriy lahza, davr emas.',
    partial_reasons: partial(p), open: { label: 'Moliyani ochish', href: '/admin' },
  };
}

export async function inventorySummary(q: Queryable): Promise<ToolResult> {
  const rows = await many<{ name: Record<string, string>; sku: string; available: number }>(q, `
    SELECT p.name, s.sku_code AS sku, GREATEST(0, SUM(sb.on_hand_sellable - sb.reserved - sb.safety_buffer))::int AS available
      FROM skus s JOIN products p ON p.id=s.product_id AND p.status='published' LEFT JOIN stock_balances sb ON sb.sku_id=s.id
     WHERE s.status='active' GROUP BY p.name, s.sku_code HAVING COALESCE(SUM(sb.on_hand_sellable - sb.reserved - sb.safety_buffer),0) <= 5
     ORDER BY 3, 2 LIMIT 30`);
  const out = rows.filter((r) => r.available === 0).length;
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'admin_inventory_summary' as never, metric: 'stock_low', metric_version: 1, title: 'Ombor: tugagan va tugayotgan mahsulotlar (hozir)',
    facts: [{ id: 'out_of_stock', label: 'Tugagan (sotuvdagi)', value: out, unit: 'count', kind: 'observed', primary: true }, { id: 'low_stock', label: '5 donadan kam qolgan', value: rows.length - out, unit: 'count', kind: 'observed' }],
    table: { columns: ['Mahsulot', 'SKU', 'Sotish mumkin'], rows: rows.map((r) => ({ cells: [pname(r.name), r.sku, r.available] })) },
    evidence: [{ type: 'page', label: 'Kam qolgan mahsulotlar', href: '/admin' }],
    method: 'Sotish mumkin = omborda sotishga yaroqli − band qilingan − xavfsizlik zaxirasi. Faqat sotuvdagi mahsulotlar.',
    partial_reasons: rows.length === 30 ? ['Ro‘yxatda birinchi 30 ta.'] : [], open: { label: 'Admin panelni ochish', href: '/admin' },
  };
}

export async function operatorsSummary(q: Queryable, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const rows = await many<{ name: string | null; calls: number; confirmed: number; cancelled: number; cohort: number }>(q, `
    WITH ev AS (SELECT actor_user_id AS uid, COUNT(DISTINCT order_id) FILTER (WHERE dimension='commercial' AND to_status='confirmed')::int AS confirmed,
                       COUNT(DISTINCT order_id) FILTER (WHERE dimension='commercial' AND to_status='cancelled')::int AS cancelled
                  FROM order_status_events WHERE actor_kind='user' AND created_at >= $1 AND created_at < $2 GROUP BY 1),
         cl AS (SELECT operator_id AS uid, COUNT(*)::int AS calls, COUNT(DISTINCT order_id)::int AS cohort FROM call_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY 1)
    SELECT u.display_name AS name, COALESCE(cl.calls,0) AS calls, COALESCE(ev.confirmed,0) AS confirmed, COALESCE(ev.cancelled,0) AS cancelled, COALESCE(cl.cohort,0) AS cohort
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN cl ON cl.uid=u.id LEFT JOIN ev ON ev.uid=u.id
     WHERE m.role_code='operator' AND m.revoked_at IS NULL GROUP BY u.id, u.display_name, cl.calls, ev.confirmed, ev.cancelled, cl.cohort ORDER BY 3 DESC, 2 DESC LIMIT 30`, [a, b]);
  return {
    status: rows.some((r) => r.calls || r.confirmed) ? 'ok' : 'zero', tool: 'admin_operators_summary' as never, metric: 'operators_activity', metric_version: 1, title: 'Operatorlar: kuzatilgan amallar (baho emas)', period: per(p),
    facts: [{ id: 'operators', label: 'Operatorlar', value: rows.length, unit: 'count', kind: 'observed', primary: true }, { id: 'confirmed_total', label: 'Jami tasdiqlangan', value: rows.reduce((t, r) => t + r.confirmed, 0), unit: 'orders', kind: 'observed' }],
    table: { columns: ['Operator', 'Qo‘ng‘iroq', 'Buyurtma (qo‘ng‘iroqli)', 'Tasdiqladi', 'Bekor qildi'], rows: rows.map((r) => ({ cells: [r.name ?? '—', r.calls, r.cohort, r.confirmed, r.cancelled] })) },
    evidence: [{ type: 'page', label: 'Operatorlar kuzatuvi', href: '/admin' }],
    method: 'Har operator uchun shu davrda qayd etilgan qo‘ng‘iroqlar, qo‘ng‘iroq qilingan buyurtmalar (maxraj) va holat tarixidagi o‘z amallari. Smena va ish turi farq qiladi — rad etish ko‘pligi avtomatik ayb yoki jarima sababi emas; sabablarni buyurtmalarda tekshiring.',
    partial_reasons: partial(p), open: { label: 'Admin panelni ochish', href: '/admin' },
  };
}

export async function partnersTop(q: Queryable, p: Period): Promise<ToolResult> {
  const [a, b] = range(p);
  const rows = await many<{ name: string; delivered: number; total: number; commission: string }>(q, `
    SELECT pa.display_name AS name,
           COUNT(*) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered, COUNT(*)::int AS total,
           COALESCE((SELECT SUM(ac.target_minor) FROM commission_accruals ac JOIN orders o2 ON o2.id=ac.order_id WHERE ac.partner_id=pa.id AND ac.state <> 'superseded' AND o2.created_at >= $1 AND o2.created_at < $2),0)::text AS commission
      FROM orders o JOIN partners pa ON pa.id=o.attributed_partner_id
     WHERE o.created_at >= $1 AND o.created_at < $2 GROUP BY pa.id, pa.display_name ORDER BY 2 DESC, 3 DESC LIMIT 15`, [a, b]);
  return {
    status: rows.length ? 'ok' : 'zero', tool: 'admin_partners_top' as never, metric: 'partners_top', metric_version: 1, title: 'Hamkorlar reytingi (yetkazilgan buyurtmalar bo‘yicha)', period: per(p),
    facts: rows[0] ? [{ id: 'top_partner', label: '1-o‘rin', value: rows[0].name, unit: 'text', kind: 'computed', primary: true }, { id: 'partners', label: 'Buyurtmasi bor hamkorlar', value: rows.length, unit: 'count', kind: 'observed' }] : [],
    table: { columns: ['Hamkor', 'Yetkazildi', 'Jami', 'Komissiya (hisoblangan)'], rows: rows.map((r) => ({ cells: [r.name, r.delivered, r.total, r.commission] })) },
    evidence: [{ type: 'page', label: 'Hamkorlar', href: '/admin' }],
    method: 'Shu davrda kelgan buyurtmalar hamkor bo‘yicha; «Komissiya (hisoblangan)» — shu buyurtmalar uchun hozirgi hisob (kutilayotgan ham kiradi, to‘langan pul emas). Hamkorlarning kontaktlari ko‘rsatilmaydi.',
    partial_reasons: partial(p), open: { label: 'Admin panelni ochish', href: '/admin' },
  };
}
