import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, type Tx, withTx } from '../../platform/db.js';
import { badRequest, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { decToScaled, fxFor, toUzsMinor } from '../analytics/money.js';
import { BUCKET_SQL } from '../partners/cabinet.js';

/**
 * Landing & Target P1A — landing analytics read-model + shop-paid ad spend.
 *
 *  - Three separate worlds are never mixed: (A) UzShop orders/ledger, (B) ad spend, (C) tracking diagnostics.
 *  - Spend is recorded, not paid: no wallet, ledger or journal entry is ever written here.
 *  - Unknown spend ≠ 0 (missing-data marker); an explicit zero is a "zero_confirmed" row.
 *  - One normalized grain: only ad-level or manual rows; campaign/adset totals are refused (no 100 + 300 sums).
 *  - Replay of the same external row updates it (new version) instead of adding; a manual row for the same spend
 *    goes to reconciliation instead of being summed.
 *  - FX is frozen at entry (old UZS value kept when rates change). Meta "mixed" stays mixed — no invented FB/IG split.
 *  - Click conversion counts only link orders against measured link visits; on-behalf/manual orders are separate.
 */

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Funnel ratios over distinct orders: approval = confirmed/reviewed, delivery = delivered/confirmed, overall = delivered/reviewed. */
export function funnel(reviewed: number, confirmed: number, delivered: number) {
  return { approval: pct(confirmed, reviewed), delivery_from_confirmed: pct(delivered, confirmed), overall: pct(delivered, reviewed) };
}

/** Click conversion: link orders / measured link visits. On-behalf (manual) orders are never added to the numerator. */
export const clickConversion = (linkOrders: number, visits: number) => pct(linkOrders, visits);

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zSpend = z.object({
  channel: z.enum(['telegram_channel', 'telegram_ads', 'instagram_target', 'meta_mixed', 'organic', 'other']),
  amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/).default('UZS'),
  service_from: zDate, service_to: zDate, paid_at: zDate.optional(),
  kind: z.enum(['actual', 'adjustment', 'zero_confirmed']).default('actual'),
  report_level: z.enum(['ad', 'adset', 'campaign', 'account', 'manual']).default('manual'),
  external_key: z.string().trim().min(3).max(200).optional(), note: z.string().trim().max(300).optional(),
  allocations: z.array(z.object({ root_link_id: z.string().uuid(), share_bps: z.number().int().min(1).max(10000) })).max(20).optional(),
}).strict();

async function versionRow(tx: Tx, id: string, reason: string, actorId: string | null) {
  const e = await one<Record<string, unknown> & { version: number }>(tx, `SELECT * FROM ad_expenses WHERE id=$1`, [id]);
  await tx.query(`INSERT INTO ad_expense_versions (expense_id, version, snapshot, reason, actor_user_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, e.version, JSON.stringify(e), reason, actorId]);
}

/** Record (or replay-update) one shop-paid spend row for a landing. Returns what happened. */
export async function recordShopSpend(tx: Tx, landingId: string, b: z.infer<typeof zSpend>, actorId: string | null) {
  if (b.service_to < b.service_from) throw badRequest('SERVICE_PERIOD_INVALID');
  if ((b.kind === 'zero_confirmed') !== (decToScaled(b.amount, 2) === 0n)) throw badRequest(b.kind === 'zero_confirmed' ? 'ZERO_CONFIRMATION_MUST_BE_0' : 'AMOUNT_REQUIRED');
  if (!['ad', 'manual'].includes(b.report_level)) throw unprocessable('SPEND_GRAIN_NOT_AD'); // campaign/adset totals would double count ad rows
  const flows = new Set((await many<{ id: string }>(tx, `SELECT id FROM referral_links WHERE landing_id=$1`, [landingId])).map((r) => r.id));
  let bps = 0;
  for (const a of b.allocations ?? []) { if (!flows.has(a.root_link_id)) throw notFound('FLOW'); bps += a.share_bps; }
  if (bps > 10000) throw unprocessable('ALLOCATION_EXCEEDS_EXPENSE');
  const fx = await fxFor(tx, b.currency, b.paid_at ?? b.service_from);
  const uzs = fx ? toUzsMinor(decToScaled(b.amount, 2), fx.rate, fx.nominal).toString() : null;
  const source = b.report_level === 'ad' ? 'meta' : 'manual';
  const key = b.external_key ? `landing:${landingId}:${b.external_key}` : null;
  if (key) {
    const ex = await maybeOne<{ id: string; amt: string; currency: string }>(tx, `SELECT id, amount_original::text AS amt, currency FROM ad_expenses WHERE partner_id IS NULL AND source=$1 AND external_key=$2 FOR UPDATE`, [source, key]);
    if (ex) {
      if (decToScaled(ex.amt, 2) === decToScaled(b.amount, 2) && ex.currency === b.currency) return { id: ex.id, outcome: 'replayed' as const };
      await tx.query(`UPDATE ad_expenses SET amount_original=$2, currency=$3, amount_uzs_minor=$4, fx_rate=$5, fx_nominal=$6, fx_date=$7, fx_source=$8, fx_status=$9, version=version+1, updated_at=now() WHERE id=$1`,
        [ex.id, b.amount, b.currency, uzs, fx?.rate ?? null, fx?.nominal ?? null, fx?.date ?? null, fx?.source ?? null, fx ? 'ok' : 'pending']);
      await versionRow(tx, ex.id, 'provider correction', actorId);
      return { id: ex.id, outcome: 'updated' as const };
    }
  }
  // Ad-level import for days already covered by a manual row of the same landing → reconciliation, never a sum.
  const overlap = source === 'meta' && b.kind === 'actual'
    ? await maybeOne<{ id: string }>(tx, `SELECT id FROM ad_expenses WHERE partner_id IS NULL AND landing_id=$1 AND source='manual' AND status='active' AND kind='actual'
        AND channel IN ('instagram_target','meta_mixed') AND service_to >= $2::date AND service_from <= $3::date LIMIT 1`, [landingId, b.service_from, b.service_to])
    : null;
  const e = await one<{ id: string }>(tx, `INSERT INTO ad_expenses (partner_id, landing_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, fx_status,
        service_from, service_to, paid_at, payer, kind, status, source, external_key, note, reconciles_id, report_level, created_by)
      VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'shop',$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [landingId, b.channel, b.channel === 'meta_mixed' ? 'Meta (aralash joylashuvlar)' : null, b.amount, b.currency, fx?.rate ?? null, fx?.nominal ?? null, fx?.date ?? null, fx?.source ?? null, uzs, fx ? 'ok' : 'pending',
      b.service_from, b.service_to, b.paid_at ?? null, b.kind, overlap ? 'needs_reconcile' : 'active', source, key, b.note ?? null, overlap?.id ?? null, b.report_level, actorId]);
  for (const a of b.allocations ?? []) await tx.query(`INSERT INTO expense_allocations (expense_id, root_link_id, share_bps) VALUES ($1,$2,$3)`, [e.id, a.root_link_id, a.share_bps]);
  await versionRow(tx, e.id, 'created', actorId);
  return { id: e.id, outcome: overlap ? ('needs_reconcile' as const) : ('created' as const) };
}

/** Landing report for [from, to] (inclusive dates, Asia/Tashkent), cohort basis: orders created in the period. */
export async function landingAnalytics(q: Queryable, landingId: string, from: string, to: string) {
  const fromTs = `${from}T00:00:00+05:00`, toTs = `${to}T23:59:59.999+05:00`;
  const flows = await many<{ id: string; code: string; name: string | null; channel: string | null; partner: string }>(q,
    `SELECT l.id, l.code, l.name, l.channel, p.display_name AS partner FROM referral_links l JOIN partners p ON p.id=l.partner_id WHERE l.landing_id=$1 ORDER BY l.created_at`, [landingId]);
  const flowIds = flows.map((f) => f.id);
  const visits = await many<{ link_id: string; n: number }>(q, `SELECT link_id, COUNT(*)::int AS n FROM referral_touches WHERE link_id = ANY($1::uuid[]) AND NOT is_bot AND touched_at BETWEEN $2 AND $3 GROUP BY link_id`, [flowIds, fromTs, toTs]);
  const orders = await many<{ id: string; channel: string; bucket: string; reviewed: boolean; confirmed: boolean; units: number; payable: string; link_id: string | null }>(q, `
    SELECT o.id, o.channel, ${BUCKET_SQL} AS bucket, (o.confirmation_status <> 'pending') AS reviewed, (o.confirmation_status='verified') AS confirmed, o.payable_minor::text AS payable,
           o.attribution->>'link_id' AS link_id,
           (SELECT COALESCE(SUM(ol.qty - ol.canceled_qty - ol.returned_qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id) AS units
      FROM orders o
     WHERE o.created_at BETWEEN $2 AND $3 AND (o.landing_snapshot->>'landing_id' = $1::text OR (o.attribution->>'link_id') = ANY($4::text[]))`, [landingId, fromTs, toTs, flowIds]);
  const accr = await many<{ order_id: string; state: string; t: string }>(q, `SELECT order_id, state, target_minor::text AS t FROM commission_accruals WHERE order_id = ANY($1::uuid[]) AND state <> 'superseded'`, [orders.map((o) => o.id)]);
  const spend = await many<{ id: string; channel: string; amount_original: string; currency: string; amount_uzs_minor: string | null; fx_status: string; fx_rate: string | null; fx_date: string | null; kind: string; status: string; payer: string; service_from: string; service_to: string; source: string; allocs: { link: string; bps: number }[] }>(q, `
    SELECT e.id, e.channel, e.amount_original::text, e.currency, e.amount_uzs_minor::text, e.fx_status, e.fx_rate::text, e.fx_date::text, e.kind, e.status, e.payer, e.service_from::text, e.service_to::text, e.source,
           COALESCE((SELECT json_agg(json_build_object('link', a.root_link_id, 'bps', a.share_bps)) FROM expense_allocations a WHERE a.expense_id=e.id), '[]') AS allocs
      FROM ad_expenses e WHERE e.landing_id=$1 AND e.partner_id IS NULL AND e.status IN ('active','needs_reconcile') AND e.service_to >= $2::date AND e.service_from <= $3::date ORDER BY e.service_from`, [landingId, from, to]);

  const linkOrders = orders.filter((o) => o.channel !== 'partner_assisted');
  const onBehalf = orders.filter((o) => o.channel === 'partner_assisted');
  const delivered = orders.filter((o) => o.bucket === 'delivered');
  const dist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4+': 0 };
  for (const o of delivered) dist[o.units >= 4 ? '4+' : String(Math.max(1, o.units))]!++;
  const totalVisits = visits.reduce((a, v) => a + v.n, 0);
  const linkOrdersFromFlows = linkOrders.filter((o) => o.link_id && flowIds.includes(o.link_id)).length;
  const commission = { available: 0n, waiting: 0n };
  for (const a of accr) { if (a.state === 'available') commission.available += BigInt(a.t); else if (a.state === 'estimated' || a.state === 'pending') commission.waiting += BigInt(a.t); }

  const active = spend.filter((s) => s.status === 'active');
  const spendKnown = active.length > 0;
  let shopSpend = 0n, fxPending = 0;
  const perFlow = new Map<string, bigint>();
  let unallocated = 0n;
  for (const s of active) {
    if (s.amount_uzs_minor === null) { fxPending++; continue; }
    const v = BigInt(s.amount_uzs_minor);
    shopSpend += v;
    let given = 0n;
    for (const a of s.allocs) { const part = (v * BigInt(a.bps)) / 10000n; given += part; perFlow.set(a.link, (perFlow.get(a.link) ?? 0n) + part); }
    unallocated += v - given; // remainders (incl. rounding) stay visible, never lost
  }
  const f = funnel(orders.filter((o) => o.reviewed).length, orders.filter((o) => o.confirmed).length, delivered.length);
  const units = delivered.reduce((a, o) => a + o.units, 0);
  return {
    landing_id: landingId, period: { from, to, timezone: 'Asia/Tashkent', basis: 'cohort (orders created in the period)' },
    counts: { visits: totalVisits, orders: orders.length, link_orders: linkOrders.length, on_behalf_orders: onBehalf.length, reviewed: orders.filter((o) => o.reviewed).length, confirmed: orders.filter((o) => o.confirmed).length, delivered: delivered.length, delivered_units: units, qty_distribution: dist },
    ratios: { ...f, click_conversion: clickConversion(linkOrdersFromFlows, totalVisits), click_conversion_formula: 'havola orqali buyurtmalar / o‘lchangan havola tashriflari (hamkor kiritgan buyurtmalar kirmaydi)' },
    money: {
      delivered_gross: delivered.reduce((a, o) => a + BigInt(o.payable), 0n).toString(),
      commission_available: commission.available.toString(), commission_waiting: commission.waiting.toString(),
      shop_ad_spend: spendKnown ? shopSpend.toString() : null,
      cost_per_delivered_order: spendKnown && delivered.length ? (shopSpend / BigInt(delivered.length)).toString() : null,
      cost_per_delivered_unit: spendKnown && units ? (shopSpend / BigInt(units)).toString() : null,
    },
    flows: flows.map((fl) => ({ ...fl, visits: visits.find((v) => v.link_id === fl.id)?.n ?? 0, orders: orders.filter((o) => o.link_id === fl.id).length, shop_spend_allocated: spendKnown ? (perFlow.get(fl.id) ?? 0n).toString() : null })),
    spend_rows: spend.map(({ allocs, ...s }) => ({ ...s, allocations: allocs, channel_label: s.channel === 'meta_mixed' ? 'Meta (aralash — Facebook/Instagram bo‘linmagan)' : s.channel })),
    completeness: {
      spend_entered: spendKnown, fx_pending: fxPending, unallocated_shop_spend: unallocated.toString(), reconcile_queue: spend.filter((s) => s.status === 'needs_reconcile').length,
      notes: [!spendKnown && 'Xarajat kiritilmagan — natija hisoblanmaydi (0 emas)', fxPending > 0 && 'Valyuta kursi kutilmoqda — bu yozuvlar jamiga kirmadi', spend.some((s) => s.status === 'needs_reconcile') && 'Bir xil xarajat ikki manbadan keldi — solishtirish kerak (jamiga ikki marta qo‘shilmaydi)'].filter(Boolean),
    },
    notes: ['Bu xarajat do‘kon hisobidan; hamkor hamyonidan pul yechilmaydi va hamkorning shaxsiy xarajatiga yozilmaydi.', 'Meta Insights raqamlari va ichki buyurtmalar alohida — bir-biriga tenglashtirilmaydi.'],
  };
}

export function registerLandingAnalytics(app: FastifyInstance, deps: Deps): void {
  const A = ['admin', 'landings'];
  const exists = async (q: Queryable, id: string) => { if (!(await maybeOne(q, `SELECT 1 FROM landing_pages WHERE id=$1`, [id]))) throw notFound('LANDING'); };

  route(app, deps, { method: 'GET', url: '/admin/landings/:id/analytics', tags: A, summary: 'Landing report: visits, orders vs units, funnel, click conversion, shop spend (missing ≠ 0), commission',
    params: zIdParam, query: z.object({ from: zDate.optional(), to: zDate.optional() }) }, async ({ actor, db, params, query }) => {
    requirePerm(actor, 'catalog.write');
    await exists(db, params.id);
    const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    const from = query.from ?? `${today.slice(0, 8)}01`, to = query.to ?? today;
    if (to < from) throw badRequest('PERIOD_INVALID');
    return landingAnalytics(db, params.id, from, to);
  });

  route(app, deps, { method: 'POST', url: '/admin/landings/:id/spend', tags: A, summary: 'Record shop-paid ad spend for a landing (report only — never a wallet debit); replay by external_key updates', params: zIdParam, body: zSpend },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'payments.read');
      await exists(db, params.id);
      return withTx(db, async (tx) => {
        const r = await recordShopSpend(tx, params.id, body, actor.userId);
        await audit(tx, actor, 'landing.spend', { type: 'ad_expense', id: r.id }, { after: { landing_id: params.id, amount: body.amount, currency: body.currency, outcome: r.outcome } });
        return r;
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/landings/spend/:id/reconcile', tags: A, summary: 'Resolve a manual/API duplicate: keep one row, the other is superseded (history kept)', params: zIdParam,
    body: z.object({ keep: z.enum(['provider', 'manual']) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'payments.read');
    return withTx(db, async (tx) => {
      const e = await maybeOne<{ id: string; reconciles_id: string | null; status: string }>(tx, `SELECT id, reconciles_id, status FROM ad_expenses WHERE id=$1 AND partner_id IS NULL FOR UPDATE`, [params.id]);
      if (!e || e.status !== 'needs_reconcile' || !e.reconciles_id) throw notFound('RECONCILE_ITEM');
      const [keep, drop] = body.keep === 'provider' ? [e.id, e.reconciles_id] : [e.reconciles_id, e.id];
      await tx.query(`UPDATE ad_expenses SET status='active', version=version+1, updated_at=now() WHERE id=$1`, [keep]);
      await tx.query(`UPDATE ad_expenses SET status='superseded', version=version+1, updated_at=now() WHERE id=$1`, [drop]);
      await versionRow(tx, keep, `reconciled: kept ${body.keep}`, actor.userId);
      await versionRow(tx, drop, `reconciled: superseded by ${keep}`, actor.userId);
      await audit(tx, actor, 'landing.spend_reconcile', { type: 'ad_expense', id: e.id }, { after: { keep, drop } });
      return { ok: true, kept: keep, superseded: drop };
    });
  });
}
