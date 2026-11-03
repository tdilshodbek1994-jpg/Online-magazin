import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireStepUp } from '../../platform/auth.js';
import { type Db, many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { encrypt } from '../../platform/mfa.js';
import { estimateCommission, matrixPreview, matrixUnitAmounts, ruleForProduct } from '../commissions/service.js';
import { myPartner } from '../partners/routes.js';
import { csvCell, decToScaled, fxFor, scaledToDec, toUzsMinor } from './money.js';
import { ingestMetaRows, type MetaRow, syncMeta } from './providers.js';
import { buildReport, CHANNELS, type Filter, PERIODS, resolvePeriod } from './report.js';

const zMatrix = z.record(z.string().regex(/^[1-9]\d?$/), z.array(z.number().int().min(0).max(10000)).min(1).max(20));
const zExpChannel = z.enum(['telegram_channel', 'telegram_ads', 'instagram_target', 'meta_mixed', 'organic', 'other']);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zAlloc = z.array(z.object({ root_link_id: z.string().uuid().optional(), placement_id: z.string().uuid().optional(), share_bps: z.number().int().min(1).max(10000).optional(), amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).optional() })
  .refine((a) => (a.root_link_id || a.placement_id) && (a.share_bps === undefined) !== (a.amount === undefined), 'link/placement + share or amount')).max(20);
const zExpense = z.object({
  channel: zExpChannel, placement_name: z.string().trim().max(120).optional(), amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/).default('UZS'),
  service_from: zDate, service_to: zDate, paid_at: zDate.optional(), payer: z.enum(['partner', 'shop']).default('partner'),
  kind: z.enum(['planned', 'actual', 'adjustment', 'zero_confirmed']).default('actual'), note: z.string().trim().max(300).optional(), receipt_url: z.string().url().max(500).optional(),
  allocations: zAlloc.optional(),
});
const zReportQuery = z.object({
  period: z.enum(PERIODS).default('this_month'), from: zDate.optional(), to: zDate.optional(), basis: z.enum(['financial', 'cohort']).default('financial'),
  currency: z.enum(['UZS', 'USD']).default('UZS'), channel: z.enum([...CHANNELS, 'telegram']).optional(), product_id: z.string().uuid().optional(),
});

/** Money in the expense's own currency + frozen FX (never re-priced with today's rate, T30). */
async function priceExpense(q: Tx | Db, amount: string, currency: string, date: string) {
  const origMinor = decToScaled(amount, 2);
  const fx = await fxFor(q, currency, date);
  if (!fx) return { fx_rate: null, fx_nominal: null, fx_date: null, fx_source: null, amount_uzs_minor: null, fx_status: 'pending' as const };
  return { fx_rate: fx.rate, fx_nominal: fx.nominal, fx_date: fx.date, fx_source: fx.source, amount_uzs_minor: toUzsMinor(origMinor, fx.rate, fx.nominal).toString(), fx_status: 'ok' as const };
}
async function checkAllocations(tx: Tx, partnerId: string, amount: string, allocs: z.infer<typeof zAlloc> | undefined) {
  if (!allocs?.length) return;
  let bps = 0, amt = 0n;
  for (const a of allocs) {
    if (a.root_link_id && !(await maybeOne(tx, `SELECT 1 FROM referral_links WHERE id=$1 AND partner_id=$2`, [a.root_link_id, partnerId]))) throw notFound('LINK');
    if (a.placement_id && !(await maybeOne(tx, `SELECT 1 FROM campaign_placements WHERE id=$1 AND partner_id=$2`, [a.placement_id, partnerId]))) throw notFound('PLACEMENT');
    if (a.share_bps) bps += a.share_bps; else amt += decToScaled(a.amount!, 2);
  }
  // Shares may not exceed the expense: $100 can be split $60 + $40, never become $200 (T21).
  if (bps > 10000 || amt > decToScaled(amount, 2) || (bps && amt)) throw unprocessable('ALLOCATION_EXCEEDS_EXPENSE');
}
async function writeAllocations(tx: Tx, expenseId: string, allocs: z.infer<typeof zAlloc> | undefined) {
  await tx.query(`DELETE FROM expense_allocations WHERE expense_id=$1`, [expenseId]);
  for (const a of allocs ?? []) await tx.query(`INSERT INTO expense_allocations (expense_id, root_link_id, placement_id, share_bps, amount_original) VALUES ($1,$2,$3,$4,$5)`, [expenseId, a.root_link_id ?? null, a.placement_id ?? null, a.share_bps ?? null, a.amount ?? null]);
}
async function snapshotVersion(tx: Tx, id: string, reason: string, actorId: string | null) {
  const e = await one<Record<string, unknown> & { version: number }>(tx, `SELECT * FROM ad_expenses WHERE id=$1`, [id]);
  const allocs = await many(tx, `SELECT root_link_id, placement_id, share_bps, amount_original::text FROM expense_allocations WHERE expense_id=$1`, [id]);
  await tx.query(`INSERT INTO ad_expense_versions (expense_id, version, snapshot, reason, actor_user_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, e.version, JSON.stringify({ ...e, allocations: allocs }), reason, actorId]);
}

export function registerAnalytics(app: FastifyInstance, deps: Deps): void {
  const T = ['partner-analytics'];
  const A = ['admin-commission'];

  // ================= §5 Admin: versioned quantity-matrix rules =================
  route(app, deps, { method: 'POST', url: '/admin/commission-rules/preview', tags: A, summary: 'Preview 1/2/3/4 amounts for a base + matrix (same function as orders)',
    body: z.object({ base_minor: z.string().regex(/^[1-9]\d{0,13}$/), matrix: zMatrix }) },
  async ({ actor, body }) => {
    requirePerm(actor, 'catalog.write');
    const problems = Object.entries(body.matrix).filter(([n, w]) => w.length !== Number(n)).map(([n]) => `qty ${n}: ${n} ta ulush kerak`);
    return { preview: matrixPreview({ fixed_minor: body.base_minor, quantity_matrix: body.matrix }, 4), problems, note: 'Belgilanmagan miqdor uchun komissiya hisoblanmaydi — buyurtma ko‘rib chiqishga tushadi' };
  });
  route(app, deps, { method: 'POST', url: '/admin/commission-rules/matrix', tags: A, summary: 'Publish a new matrix rule version for products (never retroactive)',
    body: z.object({ product_ids: z.array(z.string().uuid()).min(1).max(200), commission_group: z.string().trim().min(1).max(80).optional(), base_minor: z.string().regex(/^[1-9]\d{0,13}$/), matrix: zMatrix,
      effective_from: z.string().datetime().optional(), note: z.string().trim().min(3).max(300) }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'catalog.write');
    requireStepUp(actor);
    for (const [n, w] of Object.entries(body.matrix)) if (w.length !== Number(n)) throw badRequest('MATRIX_INVALID', { [`body.matrix.${n}`]: 'length' });
    return withTx(db, async (tx) => {
      const out: { product_id: string; version: number }[] = [];
      const eff = body.effective_from ?? new Date().toISOString();
      if (new Date(eff).getTime() < Date.now() - 60_000) throw badRequest('NO_RETROACTIVE_RULES');
      for (const pid of body.product_ids) {
        const v = await one<{ v: number }>(tx, `SELECT COALESCE(MAX(version),0)+1 AS v FROM commission_rules WHERE product_id=$1`, [pid]);
        await tx.query(`UPDATE commission_rules SET effective_to=$2 WHERE product_id=$1 AND effective_to IS NULL AND effective_from < $2`, [pid, eff]);
        await tx.query(`INSERT INTO commission_rules (product_id, version, kind, fixed_minor, commission_group, quantity_matrix, effective_from, created_by, note) VALUES ($1,$2,'quantity_matrix',$3,$4,$5,$6,$7,$8)`,
          [pid, v.v, body.base_minor, body.commission_group ?? `product:${pid}`, JSON.stringify(body.matrix), eff, actor.userId, body.note]);
        out.push({ product_id: pid, version: v.v });
      }
      await audit(tx, actor, 'commission.matrix_published', { type: 'commission_rules', id: body.product_ids[0]! }, { after: { products: out, base_minor: body.base_minor, matrix: body.matrix, effective_from: eff } });
      return { published: out, effective_from: eff, preview: matrixPreview({ fixed_minor: body.base_minor, quantity_matrix: body.matrix }, 4) };
    });
  });
  route(app, deps, { method: 'GET', url: '/admin/commission-review', tags: A, summary: 'Orders whose bundle size has no approved matrix row (kept, not deleted)' }, async ({ actor, db }) => {
    requirePerm(actor, 'reports.read');
    return { items: await many(db, `SELECT a.id, a.order_id, o.number, a.group_qty, a.review_reason, a.commission_group, a.created_at FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE a.review_required ORDER BY a.created_at DESC LIMIT 200`) };
  });

  // ================= §5 Partner: what will I earn for 1/2/3 units? =================
  route(app, deps, { method: 'GET', url: '/partner/products/:id/commission-preview', tags: T, summary: 'Commission for 1/2/3(/4) units of a product (same function as orders)', params: zIdParam }, async ({ actor, db, params }) => {
    await myPartner(db, actor, false);
    const rule = await ruleForProduct(db, params.id);
    if (!rule) return { rule: null, items: [] };
    if (rule.kind === 'quantity_matrix') return { rule: { kind: rule.kind, version: rule.version, base_minor: rule.fixed_minor, matrix: rule.quantity_matrix, group: rule.commission_group }, items: matrixPreview(rule, 4) };
    const price = await maybeOne<{ p: string }>(db, `SELECT MIN(o.price_minor)::text AS p FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=$1`, [params.id]);
    const items = [];
    for (let n = 1; n <= 3; n++) {
      const e = await estimateCommission(db, [{ key: 'x', productId: params.id, qty: n, lineNet: BigInt(price?.p ?? '0') * BigInt(n) }]);
      items.push({ qty: n, total_minor: e.total.toString(), units_minor: null });
    }
    return { rule: { kind: rule.kind, version: rule.version, rate_bps: rule.rate_bps, fixed_minor: rule.fixed_minor }, items };
  });

  // ================= §9 Placements: one tracking code per Telegram post / Instagram campaign =================
  route(app, deps, { method: 'GET', url: '/partner/links/:id/placements', tags: T, summary: 'Placements under a root link', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    const p = await myPartner(db, actor, false);
    if (!(await maybeOne(db, `SELECT 1 FROM referral_links WHERE id=$1 AND partner_id=$2`, [params.id, p.id]))) throw notFound('LINK');
    const rows = await many<{ code: string }>(db, `SELECT id, channel, name, code, status, created_at FROM campaign_placements WHERE root_link_id=$1 ORDER BY created_at`, [params.id]);
    return { items: rows.map((r) => ({ ...r, url: `${cfg.publicWebUrl}/r/${r.code}` })) };
  });
  route(app, deps, { method: 'POST', url: '/partner/links/:id/placements', tags: T, summary: 'Add a Telegram/Instagram placement with its own tracking link', params: zIdParam,
    body: z.object({ channel: z.enum(CHANNELS), name: z.string().trim().min(1).max(80) }) },
  async ({ actor, db, cfg, params, body }) => {
    const p = await myPartner(db, actor);
    if (!(await maybeOne(db, `SELECT 1 FROM referral_links WHERE id=$1 AND partner_id=$2`, [params.id, p.id]))) throw notFound('LINK');
    const code = randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10);
    const r = await one<{ id: string }>(db, `INSERT INTO campaign_placements (partner_id, root_link_id, channel, name, code) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [p.id, params.id, body.channel, body.name, code]);
    return { id: r.id, code, url: `${cfg.publicWebUrl}/r/${code}`, channel: body.channel, name: body.name };
  });
  route(app, deps, { method: 'POST', url: '/partner/placements/:id/archive', tags: T, summary: 'Archive a placement (history kept)', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await db.query(`UPDATE campaign_placements SET status='archived' WHERE id=$1 AND partner_id=$2 RETURNING id`, [params.id, p.id]);
    if (!r.rowCount) throw notFound('PLACEMENT');
    return { ok: true };
  });
  route(app, deps, { method: 'GET', url: '/partner/placements', tags: T, summary: 'All my placements (for choosing a campaign on manual orders)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `SELECT cp.id, cp.channel, cp.name, cp.code, cp.status, cp.root_link_id, l.name AS link_name FROM campaign_placements cp JOIN referral_links l ON l.id=cp.root_link_id WHERE cp.partner_id=$1 AND cp.status='active' ORDER BY cp.created_at DESC`, [p.id]) };
  });

  // ================= §10 Ad expenses (manual), versions, allocation, zero confirmation =================
  route(app, deps, { method: 'POST', url: '/partner/ad-expenses', tags: T, summary: 'Record an ad expense (planned/actual/adjustment/zero_confirmed) with optional link allocation', body: zExpense },
    async ({ actor, db, body, idempotencyKey }) => {
      const p = await myPartner(db, actor, false);
      if (body.service_to < body.service_from) throw badRequest('SERVICE_PERIOD_INVALID');
      if ((body.kind === 'zero_confirmed') !== (Number(body.amount) === 0)) throw badRequest(body.kind === 'zero_confirmed' ? 'ZERO_CONFIRMATION_MUST_BE_0' : 'AMOUNT_REQUIRED');
      return withTx(db, async (tx) => {
        await checkAllocations(tx, p.id, body.amount, body.allocations);
        const fx = await priceExpense(tx, body.amount, body.currency, body.paid_at ?? body.service_from);
        const ext = idempotencyKey ? `idem:${idempotencyKey}` : null;
        if (ext) { const ex = await maybeOne<{ id: string }>(tx, `SELECT id FROM ad_expenses WHERE partner_id=$1 AND source='manual' AND external_key=$2`, [p.id, ext]); if (ex) return { id: ex.id, replayed: true }; }
        const e = await one<{ id: string }>(tx, `INSERT INTO ad_expenses (partner_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, fx_status, service_from, service_to, paid_at, payer, kind, source, external_key, note, receipt_url, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual',$17,$18,$19,$20) RETURNING id`,
          [p.id, body.channel, body.placement_name ?? null, body.amount, body.currency, fx.fx_rate, fx.fx_nominal, fx.fx_date, fx.fx_source, fx.amount_uzs_minor, fx.fx_status, body.service_from, body.service_to, body.paid_at ?? null, body.payer, body.kind, ext, body.note ?? null, body.receipt_url ?? null, actor.userId]);
        await writeAllocations(tx, e.id, body.allocations);
        await snapshotVersion(tx, e.id, 'created', actor.userId);
        return { id: e.id, fx_status: fx.fx_status, amount_uzs_minor: fx.amount_uzs_minor, fx_date: fx.fx_date };
      });
    });
  route(app, deps, { method: 'PATCH', url: '/partner/ad-expenses/:id', tags: T, summary: 'Edit an expense (new version + reason; FX re-frozen only if amount/currency/date change)', params: zIdParam,
    body: zExpense.partial().extend({ reason: z.string().trim().min(3).max(200), expected_version: z.number().int() }) },
  async ({ actor, db, params, body }) => {
    const p = await myPartner(db, actor, false);
    return withTx(db, async (tx) => {
      const e = await maybeOne<Record<string, any>>(tx, `SELECT *, amount_original::text AS amt, service_from::text AS sf, service_to::text AS st, paid_at::text AS pa FROM ad_expenses WHERE id=$1 AND partner_id=$2 FOR UPDATE`, [params.id, p.id]);
      if (!e) throw notFound('EXPENSE');
      if (e.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: e.version });
      if (e.source !== 'manual' && e.source !== 'legacy_p2' && e.source !== 'csv') throw conflict('PROVIDER_ROW_READ_ONLY');
      const amount = body.amount ?? e.amt, currency = body.currency ?? e.currency, sf = body.service_from ?? e.sf, st = body.service_to ?? e.st, pa = body.paid_at ?? e.pa;
      const repriced = amount !== e.amt || currency !== e.currency || (pa ?? sf) !== (e.pa ?? e.sf);
      const fx = repriced ? await priceExpense(tx, amount, currency, pa ?? sf) : { fx_rate: e.fx_rate, fx_nominal: e.fx_nominal, fx_date: e.fx_date, fx_source: e.fx_source, amount_uzs_minor: e.amount_uzs_minor, fx_status: e.fx_status };
      await checkAllocations(tx, p.id, amount, body.allocations);
      await tx.query(`UPDATE ad_expenses SET channel=$2, placement_name=$3, amount_original=$4, currency=$5, fx_rate=$6, fx_nominal=$7, fx_date=$8, fx_source=$9, amount_uzs_minor=$10, fx_status=$11,
          service_from=$12, service_to=$13, paid_at=$14, payer=$15, kind=$16, note=$17, receipt_url=$18, version=version+1, updated_at=now() WHERE id=$1`,
        [e.id, body.channel ?? e.channel, body.placement_name ?? e.placement_name, amount, currency, fx.fx_rate, fx.fx_nominal, fx.fx_date, fx.fx_source, fx.amount_uzs_minor, fx.fx_status, sf, st, pa, body.payer ?? e.payer, body.kind ?? e.kind, body.note ?? e.note, body.receipt_url ?? e.receipt_url]);
      if (body.allocations) await writeAllocations(tx, e.id, body.allocations);
      await snapshotVersion(tx, e.id, body.reason, actor.userId);
      return { ok: true, version: e.version + 1 };
    });
  });
  route(app, deps, { method: 'POST', url: '/partner/ad-expenses/:id/void', tags: T, summary: 'Void an expense with a reason (kept in history)', params: zIdParam, body: z.object({ reason: z.string().trim().min(3).max(200) }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor, false);
      return withTx(db, async (tx) => {
        const r = await tx.query(`UPDATE ad_expenses SET status='void', version=version+1, updated_at=now() WHERE id=$1 AND partner_id=$2 AND status <> 'void' RETURNING id`, [params.id, p.id]);
        if (!r.rowCount) throw notFound('EXPENSE');
        await snapshotVersion(tx, params.id, `void: ${body.reason}`, actor.userId);
        return { ok: true };
      });
    });
  route(app, deps, { method: 'GET', url: '/partner/ad-expenses', tags: T, summary: 'My expenses with FX, allocation and status', query: z.object({ status: z.enum(['active', 'all', 'needs_reconcile']).default('active') }) },
    async ({ actor, db, query }) => {
      const p = await myPartner(db, actor, false);
      return { items: await many(db, `
        SELECT e.id, e.channel, e.placement_name, e.amount_original::text AS amount, e.currency, e.fx_rate::text, e.fx_nominal, e.fx_date::text, e.fx_source, e.fx_status, e.amount_uzs_minor::text,
               e.service_from::text, e.service_to::text, e.paid_at::text, e.payer, e.kind, e.status, e.source, e.note, e.version, e.reconciles_id, e.created_at,
               COALESCE((SELECT json_agg(json_build_object('root_link_id', a.root_link_id, 'placement_id', a.placement_id, 'share_bps', a.share_bps, 'amount', a.amount_original::text)) FROM expense_allocations a WHERE a.expense_id=e.id), '[]') AS allocations
          FROM ad_expenses e WHERE e.partner_id=$1 ${query.status === 'all' ? '' : `AND e.status=$2`} ORDER BY e.service_from DESC, e.created_at DESC LIMIT 500`,
        query.status === 'all' ? [p.id] : [p.id, query.status]) };
    });
  route(app, deps, { method: 'GET', url: '/partner/ad-expenses/:id/versions', tags: T, summary: 'Version history of an expense', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    if (!(await maybeOne(db, `SELECT 1 FROM ad_expenses WHERE id=$1 AND partner_id=$2`, [params.id, p.id]))) throw notFound('EXPENSE');
    return { items: await many(db, `SELECT version, reason, snapshot, created_at FROM ad_expense_versions WHERE expense_id=$1 ORDER BY version`, [params.id]) };
  });

  // CSV import: date,amount,currency,channel,placement,note,external_id (one external_id = one row; re-import updates, never adds).
  route(app, deps, { method: 'POST', url: '/partner/ad-expenses/import', tags: T, summary: 'CSV import of ad spend (idempotent by external_id)', body: z.object({ csv: z.string().min(5).max(200_000) }), bodyLimit: 300_000 },
    async ({ actor, db, body }) => {
      const p = await myPartner(db, actor, false);
      const lines = body.csv.replace(/\r/g, '').split('\n').filter((l) => l.trim());
      const head = lines.shift()!.split(',').map((h) => h.trim().toLowerCase());
      const idx = (k: string) => head.indexOf(k);
      if (idx('date') < 0 || idx('amount') < 0) throw badRequest('CSV_HEADER', { csv: 'date,amount,currency,channel,placement,note,external_id' });
      const res = { created: 0, updated: 0, unchanged: 0, errors: [] as { line: number; error: string }[] };
      await withTx(db, async (tx) => {
        for (const [i, raw] of lines.entries()) {
          const c = raw.split(',').map((x) => x.trim());
          const date = c[idx('date')] ?? '', amount = c[idx('amount')] ?? '', currency = (idx('currency') >= 0 ? c[idx('currency')] : '') || 'UZS';
          const channel = ((idx('channel') >= 0 ? c[idx('channel')] : '') || 'other') as string;
          const ext = (idx('external_id') >= 0 ? c[idx('external_id')] : '') || `${date}|${amount}|${channel}|${i}`;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,16}(\.\d{1,2})?$/.test(amount) || !zExpChannel.safeParse(channel).success || !/^[A-Z]{3}$/.test(currency)) { res.errors.push({ line: i + 2, error: 'invalid row' }); continue; }
          const fx = await priceExpense(tx, amount, currency, date);
          const ex = await maybeOne<{ id: string; amt: string; currency: string }>(tx, `SELECT id, amount_original::text AS amt, currency FROM ad_expenses WHERE partner_id=$1 AND source='csv' AND external_key=$2 FOR UPDATE`, [p.id, ext]);
          if (ex) {
            if (decToScaled(ex.amt, 2) === decToScaled(amount, 2) && ex.currency === currency) { res.unchanged++; continue; }
            await tx.query(`UPDATE ad_expenses SET amount_original=$2, currency=$3, fx_rate=$4, fx_nominal=$5, fx_date=$6, fx_source=$7, amount_uzs_minor=$8, fx_status=$9, version=version+1, updated_at=now() WHERE id=$1`,
              [ex.id, amount, currency, fx.fx_rate, fx.fx_nominal, fx.fx_date, fx.fx_source, fx.amount_uzs_minor, fx.fx_status]);
            await snapshotVersion(tx, ex.id, 'csv re-import correction', actor.userId);
            res.updated++;
          } else {
            const e = await one<{ id: string }>(tx, `INSERT INTO ad_expenses (partner_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, fx_status, service_from, service_to, paid_at, payer, kind, source, external_key, note, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12,'partner','actual','csv',$13,$14,$15) RETURNING id`,
              [p.id, channel, (idx('placement') >= 0 ? c[idx('placement')] : null) || null, amount, currency, fx.fx_rate, fx.fx_nominal, fx.fx_date, fx.fx_source, fx.amount_uzs_minor, fx.fx_status, date, ext, (idx('note') >= 0 ? c[idx('note')] : null) || null, actor.userId]);
            await snapshotVersion(tx, e.id, 'csv import', actor.userId);
            res.created++;
          }
        }
      });
      return res;
    });

  // Reconciliation queue: a provider row matching a manual expense waits here instead of being added on top (T23).
  route(app, deps, { method: 'POST', url: '/partner/ad-expenses/:id/reconcile', tags: T, summary: 'Resolve a duplicate: keep the provider row or the manual one', params: zIdParam,
    body: z.object({ keep: z.enum(['provider', 'manual']) }) },
  async ({ actor, db, params, body }) => {
    const p = await myPartner(db, actor, false);
    return withTx(db, async (tx) => {
      const e = await maybeOne<{ id: string; reconciles_id: string | null }>(tx, `SELECT id, reconciles_id FROM ad_expenses WHERE id=$1 AND partner_id=$2 AND status='needs_reconcile' FOR UPDATE`, [params.id, p.id]);
      if (!e || !e.reconciles_id) throw notFound('RECONCILE_ITEM');
      if (body.keep === 'provider') {
        await tx.query(`UPDATE ad_expenses SET status='active', version=version+1 WHERE id=$1`, [e.id]);
        await tx.query(`UPDATE ad_expenses SET status='superseded', version=version+1 WHERE id=$1`, [e.reconciles_id]);
      } else await tx.query(`UPDATE ad_expenses SET status='superseded', version=version+1 WHERE id=$1`, [e.id]);
      await snapshotVersion(tx, e.id, `reconciled: keep ${body.keep}`, actor.userId);
      await snapshotVersion(tx, e.reconciles_id, `reconciled: keep ${body.keep}`, actor.userId);
      return { ok: true };
    });
  });

  // ================= §11 Provider (Meta Insights) — read-only spend sync; tokens never leave the server =================
  route(app, deps, { method: 'POST', url: '/partner/providers/meta/connect', tags: T, summary: 'Connect a Meta ad account (token stored encrypted server-side)',
    body: z.object({ account_id: z.string().regex(/^(act_)?\d{3,20}$/), access_token: z.string().min(20).max(1000) }) },
  async ({ actor, db, cfg, body }) => {
    const p = await myPartner(db, actor, false);
    const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ads.provider_sync'`);
    if (!flag?.enabled) throw new AppError(409, 'PROVIDER_SYNC_DISABLED');
    const r = await one<{ id: string }>(db, `INSERT INTO provider_connections (partner_id, provider, account_id, token_ciphertext) VALUES ($1,'meta',$2,$3)
        ON CONFLICT (partner_id, provider, account_id) DO UPDATE SET token_ciphertext=EXCLUDED.token_ciphertext, status='active', last_error=NULL RETURNING id`, [p.id, body.account_id, encrypt(body.access_token, cfg.mfaKey)]);
    return { id: r.id, account_id: body.account_id, status: 'active' };
  });
  route(app, deps, { method: 'POST', url: '/partner/providers/meta/sync', tags: T, summary: 'Sync spend for a date range (versioned upsert; no budget changes ever)', body: z.object({ from: zDate, to: zDate }) },
    async ({ actor, db, cfg, body }) => {
      const p = await myPartner(db, actor, false);
      const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ads.provider_sync'`);
      if (!flag?.enabled) throw new AppError(409, 'PROVIDER_SYNC_DISABLED');
      return syncMeta(db, cfg, p.id, body.from, body.to);
    });
  route(app, deps, { method: 'GET', url: '/partner/providers/status', tags: T, summary: 'Provider connections and last sync runs (no secrets)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ads.provider_sync'`);
    return {
      sync_enabled: !!flag?.enabled,
      connections: await many(db, `SELECT id, provider, account_id, status, last_success_at, last_error FROM provider_connections WHERE partner_id=$1`, [p.id]),
      runs: await many(db, `SELECT provider, period_from::text, period_to::text, status, rows_seen, rows_changed, error, provider_timezone, started_at, finished_at FROM provider_sync_runs WHERE partner_id=$1 ORDER BY started_at DESC LIMIT 20`, [p.id]),
      telegram_note: 'Telegram kanal adminiga to‘langan reklama qo‘lda yoki CSV bilan kiritiladi; Telegram Ads alohida kanal sifatida hisoblanadi.',
    };
  });

  // ================= §12 FX (admin): CBU sync or manual rate =================
  route(app, deps, { method: 'POST', url: '/admin/fx', tags: A, summary: 'Record an FX rate (manual or actual bank rate)', body: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), date: zDate, rate: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/), nominal: z.number().int().min(1).default(1), source: z.enum(['manual', 'bank_actual', 'cbu']).default('manual') }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'reports.read');
      await db.query(`INSERT INTO fx_snapshots (currency, effective_date, rate, nominal, source, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (currency, effective_date, source) DO NOTHING`, [body.currency, body.date, body.rate, body.nominal, body.source, actor.userId]);
      return { ok: true, repriced: await repricePending(db) };
    });
  route(app, deps, { method: 'POST', url: '/admin/fx/sync-cbu', tags: A, summary: 'Fetch official CBU rates for a date (JSON: Ccy, Rate, Nominal)', body: z.object({ date: zDate.optional() }) }, async ({ actor, db, body }) => {
    requirePerm(actor, 'reports.read');
    const date = body.date ?? new Date().toISOString().slice(0, 10);
    let rows: { Ccy: string; Rate: string; Nominal: string; Date: string }[];
    try {
      const r = await fetch(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/${date}/`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      rows = await r.json() as typeof rows;
    } catch (e) { throw new AppError(502, 'FX_SOURCE_UNAVAILABLE', { error: String((e as Error).message) }); }
    let n = 0;
    for (const x of rows) {
      if (!/^[A-Z]{3}$/.test(x.Ccy) || !/^\d+(\.\d+)?$/.test(x.Rate)) continue;
      const [d, m, y] = x.Date.split('.');
      await db.query(`INSERT INTO fx_snapshots (currency, effective_date, rate, nominal, source, recorded_by) VALUES ($1,$2,$3,$4,'cbu',$5) ON CONFLICT DO NOTHING`, [x.Ccy, `${y}-${m}-${d}`, x.Rate, Number(x.Nominal) || 1, actor.userId]);
      n++;
    }
    return { ok: true, rates: n, repriced: await repricePending(db) };
  });

  // ================= §15 Dashboard, link detail, export, simulation, monthly snapshots =================
  const filterOf = async (db: Db, partnerId: string, q: z.infer<typeof zReportQuery>, linkId?: string): Promise<Filter> => {
    try {
      const per = await resolvePeriod(db, q.period, q.from, q.to);
      return { partnerId, from: per.from, to: per.to, basis: q.basis, currency: q.currency, channel: q.channel ?? null, productId: q.product_id ?? null, linkId: linkId ?? null };
    } catch { throw badRequest('PERIOD_INVALID'); }
  };
  route(app, deps, { method: 'GET', url: '/partner/analytics/dashboard', tags: T, summary: 'Partner dashboard: commission, ad spend, result, expected; links; channels; series (report_basis + as_of)', query: zReportQuery },
    async ({ actor, db, query }) => {
      const p = await myPartner(db, actor, false);
      const f = await filterOf(db, p.id, query);
      const r = await buildReport(db, f);
      // previous period of equal length, same basis — no growth % when the previous value is 0/unknown
      const len = Date.parse(f.to) - Date.parse(f.from);
      const prev = await buildReport(db, { ...f, from: new Date(Date.parse(f.from) - len).toISOString(), to: f.from });
      const growth = (a: string | null, b: string | null) => (a === null || b === null || BigInt(b) <= 0n ? null : Math.round(((Number(a) - Number(b)) / Number(b)) * 1000) / 10);
      const bal = await maybeOne(db, `SELECT available_minor::text, reserved_minor::text, paid_minor::text, pending_minor::text, estimated_minor::text, debt_minor::text FROM partner_balances WHERE partner_id=$1`, [p.id]);
      return { ...r, wallet: bal ?? null, compare: { previous: prev.totals, commission_growth_pct: growth(r.totals.commission, prev.totals.commission), result_growth_pct: growth(r.totals.result, prev.totals.result) } };
    });
  route(app, deps, { method: 'GET', url: '/partner/links/:id/analytics', tags: T, summary: 'One link: same engine filtered to the link + orders and expenses behind every number', params: zIdParam, query: zReportQuery },
    async ({ actor, db, params, query }) => {
      const p = await myPartner(db, actor, false);
      const l = await maybeOne<{ id: string; product_id: string | null }>(db, `SELECT id, product_id FROM referral_links WHERE id=$1 AND partner_id=$2`, [params.id, p.id]);
      if (!l) throw notFound('LINK'); // another partner's link id looks non-existent (T28)
      const f = await filterOf(db, p.id, query, l.id);
      const r = await buildReport(db, f);
      const orders = await many(db, `
        SELECT o.id, 'OM-***' || right(o.number, 3) AS masked, o.created_at, o.delivered_at, o.channel AS capture_mode, COALESCE(o.attribution->>'source_channel','unknown') AS source_channel,
               (SELECT COALESCE(SUM(ol.qty - ol.canceled_qty - ol.returned_qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id) AS units,
               (SELECT COALESCE(SUM(a.target_minor),0)::text FROM commission_accruals a WHERE a.order_id=o.id AND a.state <> 'superseded') AS commission,
               (SELECT string_agg(DISTINCT a.state, ',') FROM commission_accruals a WHERE a.order_id=o.id) AS states,
               (SELECT bool_or(a.review_required) FROM commission_accruals a WHERE a.order_id=o.id) AS review
          FROM orders o WHERE o.attributed_partner_id=$1 AND (o.attribution->>'link_id'=$2 OR o.attribution->>'placement_id' IN (SELECT id::text FROM campaign_placements WHERE root_link_id=$3))
           AND o.created_at < $4 ORDER BY o.created_at DESC LIMIT 200`, [p.id, l.id, l.id, f.to]);
      const expenses = await many(db, `SELECT e.id, e.channel, e.placement_name, e.amount_original::text AS amount, e.currency, e.fx_rate::text, e.fx_date::text, e.fx_status, e.amount_uzs_minor::text, e.service_from::text, e.service_to::text, e.payer, e.kind, a.share_bps, a.amount_original::text AS alloc_amount
          FROM expense_allocations a JOIN ad_expenses e ON e.id=a.expense_id WHERE e.partner_id=$1 AND e.status='active' AND (a.root_link_id=$2 OR a.placement_id IN (SELECT id FROM campaign_placements WHERE root_link_id=$2))`, [p.id, l.id]);
      const rule = l.product_id ? await ruleForProduct(db, l.product_id) : null;
      const formulas = rule?.kind === 'quantity_matrix' ? matrixPreview(rule, 4).map((x) => ({ qty: x.qty, total_minor: x.total_minor, formula: x.total_minor === null ? `${x.qty} dona: qoida yo‘q — ko‘rib chiqiladi` : `${x.qty} dona: ${(rule.quantity_matrix![String(x.qty)] ?? []).map((b) => `${b / 100}%`).join(' + ')} × ${BigInt(rule.fixed_minor!) / 100n} so‘m = ${BigInt(x.total_minor) / 100n} so‘m` })) : [];
      return { ...r, link_id: l.id, orders, expenses, rule: rule ? { kind: rule.kind, version: rule.version, base_minor: rule.fixed_minor, rate_bps: rule.rate_bps, matrix: rule.quantity_matrix ?? null } : null, formulas };
    });

  route(app, deps, { method: 'GET', url: '/partner/analytics/export.csv', tags: T, summary: 'CSV export (same engine; header carries period, timezone, basis, currency, FX method, as_of, completeness)', query: zReportQuery },
    async ({ actor, db, query, reply }) => {
      const p = await myPartner(db, actor, false);
      const r = await buildReport(db, await filterOf(db, p.id, query));
      const head = [
        ['UzShop hamkor hisoboti (tahliliy; buxgalteriya yakuniy sof foyda hisoboti emas)'], ['period', r.period.from, r.period.to], ['timezone', r.timezone], ['report_basis', r.report_basis],
        ['currency', r.currency], ['fx_method', r.fx_method], ['as_of', r.as_of], ['completeness', r.completeness.notes.join('; ') || 'ok'], ['version', '1'], [],
        ['link', 'product', 'orders', 'delivered', 'units', 'commission', 'expected', 'ad', 'other', 'result', 'completeness'],
      ];
      const body = r.links.map((x) => [x.name, x.product ? JSON.stringify(x.product) : '', x.orders, x.delivered, x.units, x.commission, x.expected, x.ad ?? 'kiritilmagan', x.other ?? 'kiritilmagan', x.result ?? 'hisoblanmaydi', x.completeness]);
      const tail = [['Taqsimlanmagan', '', '', '', '', '', '', r.unallocated.ad, r.unallocated.other, '', ''], ['JAMI', '', r.counts.orders, r.counts.delivered, r.counts.units, r.totals.commission, r.totals.expected, r.totals.ad ?? 'kiritilmagan', r.totals.other ?? 'kiritilmagan', r.totals.result ?? 'hisoblanmaydi', '']];
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="uzshop-hisobot-${r.period.from.slice(0, 10)}.csv"`);
      return [...head, ...body, ...tail].map((row) => row.map(csvCell).join(',')).join('\n');
    });

  route(app, deps, { method: 'POST', url: '/partner/analytics/simulate', tags: T, summary: 'TAXMIN: planning simulation (writes nothing; same commission function)',
    body: z.object({ product_id: z.string().uuid(), orders_by_qty: z.record(z.string().regex(/^[1-9]$/), z.number().int().min(0).max(100_000)), ad_spend_minor: z.string().regex(/^\d{1,15}$/).default('0'), delivery_rate_bps: z.number().int().min(0).max(10000).default(10000) }) },
  async ({ actor, db, body }) => {
    await myPartner(db, actor, false);
    const rule = await ruleForProduct(db, body.product_id);
    if (!rule) return { estimate: true, error: 'NO_RULE' };
    let total = 0n; const rows = [];
    for (const [qty, n] of Object.entries(body.orders_by_qty)) {
      const delivered = BigInt(n) * BigInt(body.delivery_rate_bps) / 10000n;
      const per = rule.kind === 'quantity_matrix' ? (() => { const u = matrixUnitAmounts(rule, Number(qty)); return u ? u.reduce((a, b) => a + b, 0n) : null; })()
        : (await estimateCommission(db, [{ key: 'x', productId: body.product_id, qty: Number(qty), lineNet: 0n }])).total;
      rows.push({ qty: Number(qty), orders: n, delivered: delivered.toString(), per_order_minor: per === null ? null : per.toString(), commission_minor: per === null ? null : (per * delivered).toString() });
      if (per !== null) total += per * delivered;
    }
    return { estimate: true, label: 'TAXMIN — kafolat emas; hamyon, buyurtma va to‘lovlarga ta’sir qilmaydi', rows, commission_minor: total.toString(), ad_spend_minor: body.ad_spend_minor, result_minor: (total - BigInt(body.ad_spend_minor)).toString() };
  });

  route(app, deps, { method: 'POST', url: '/admin/reports/close-month', tags: A, summary: 'Store versioned monthly snapshots for all partners (recompute = new version, never overwrite)',
    body: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), reason: z.string().trim().min(3).max(200).default('oy yopildi') }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'reports.read');
    const [y, m] = body.month.split('-').map(Number);
    const to = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.parse(to) - 86400_000).toISOString().slice(0, 10);
    const partners = await many<{ id: string }>(db, `SELECT DISTINCT partner_id AS id FROM commission_accruals UNION SELECT DISTINCT partner_id FROM ad_expenses`);
    let n = 0;
    for (const pt of partners) {
      for (const basis of ['financial', 'cohort'] as const) {
        const per = await resolvePeriod(db, 'custom', `${body.month}-01`, last);
        const r = await buildReport(db, { partnerId: pt.id, from: per.from, to: per.to, basis, currency: 'UZS' });
        const v = await one<{ v: number }>(db, `SELECT COALESCE(MAX(version),0)+1 AS v FROM monthly_report_snapshots WHERE partner_id=$1 AND month=$2 AND report_basis=$3`, [pt.id, `${body.month}-01`, basis]);
        await db.query(`INSERT INTO monthly_report_snapshots (partner_id, month, report_basis, version, data, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [pt.id, `${body.month}-01`, basis, v.v, JSON.stringify(r), v.v > 1 ? `qayta hisoblandi: ${body.reason}` : body.reason]);
        n++;
      }
    }
    await audit(db, actor, 'reports.month_closed', { type: 'monthly_report', id: body.month }, { after: { snapshots: n } });
    return { ok: true, snapshots: n };
  });
  route(app, deps, { method: 'GET', url: '/partner/reports/monthly', tags: T, summary: 'My closed-month snapshots (all versions kept)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `SELECT month::text, report_basis, version, reason, created_at, data->'totals' AS totals, data->'summary_text' AS summary_text FROM monthly_report_snapshots WHERE partner_id=$1 ORDER BY month DESC, report_basis, version DESC`, [p.id]) };
  });
}

/** When a missing FX rate arrives, only FX_PENDING rows are priced; already-frozen rows never change (T30). */
export async function repricePending(db: Db): Promise<number> {
  const rows = await many<{ id: string; amt: string; currency: string; d: string }>(db, `SELECT id, amount_original::text AS amt, currency, COALESCE(paid_at, service_from)::text AS d FROM ad_expenses WHERE fx_status='pending' LIMIT 1000`);
  let n = 0;
  for (const r of rows) {
    const fx = await priceExpense(db, r.amt, r.currency, r.d);
    if (fx.fx_status !== 'ok') continue;
    await db.query(`UPDATE ad_expenses SET fx_rate=$2, fx_nominal=$3, fx_date=$4, fx_source=$5, amount_uzs_minor=$6, fx_status='ok', updated_at=now() WHERE id=$1 AND fx_status='pending'`, [r.id, fx.fx_rate, fx.fx_nominal, fx.fx_date, fx.fx_source, fx.amount_uzs_minor]);
    n++;
  }
  return n;
}
export { ingestMetaRows, scaledToDec };
export type { MetaRow };
