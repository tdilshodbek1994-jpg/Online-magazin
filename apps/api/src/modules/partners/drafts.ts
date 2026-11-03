import { normalizeUzPhone } from '@om/shared';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { audit } from '../../platform/audit.js';
import { type Actor, hashToken } from '../../platform/auth.js';
import { many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { computeTarget, ruleForProduct } from '../commissions/service.js';
import { priceLines, pricedToJson, storeQuote } from '../orders/service.js';
import { parseMessage, type CatalogItem } from './parse.js';
import { createAssistedOrder, myPartner } from './routes.js';

/**
 * Sales drafts ("Mijoz uchun buyurtma studiyasi", V2 §05–07). A draft is autosaved on the server, is never an order,
 * reserves no stock and promises no commission. Submitting (by the partner, or by the customer through a fill link)
 * creates exactly one partner-assisted order that still needs the customer's own SMS confirmation.
 */
const zLine = z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(99) });
const zAddr = z.object({ district: z.string().max(120).optional(), street: z.string().max(200).optional(), house: z.string().max(30).optional(), apartment: z.string().max(30).optional(), landmark: z.string().max(300).optional() });
const zDraft = z.object({
  lines: z.array(zLine).max(30).optional(),
  customer_name: z.string().max(120).nullable().optional(),
  customer_phone: z.string().max(32).nullable().optional(),
  delivery_zone_id: z.string().uuid().nullable().optional(),
  address: zAddr.optional(),
  address_later: z.boolean().optional(),
  contact_time: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  source: z.enum(['manual', 'message']).optional(),
  raw_message: z.string().max(2000).nullable().optional(),
});
type DraftRow = { id: string; partner_id: string; created_by: string; status: string; source: string; lines: { sku_id: string; qty: number }[]; customer_name: string | null; customer_phone: string | null; delivery_zone_id: string | null;
  address: Record<string, string>; address_later: boolean; contact_time: string | null; note: string | null; fill_status: string; fill_expires_at: string | null; order_id: string | null; version: number; created_at: string; updated_at: string };

/** What is still missing before the draft can become an order (server is the source of truth, T05). */
export function missingFields(d: Pick<DraftRow, 'lines' | 'customer_name' | 'customer_phone' | 'delivery_zone_id' | 'address' | 'address_later'>): string[] {
  const m: string[] = [];
  if (!d.lines?.length) m.push('product');
  if (!d.customer_name || d.customer_name.trim().length < 2) m.push('customer_name');
  if (!d.customer_phone || !normalizeUzPhone(d.customer_phone)) m.push('customer_phone');
  if (!d.delivery_zone_id) m.push('delivery_zone');
  if (d.address_later || !d.address?.district || !d.address?.street || !d.address?.house) m.push('address');
  return m;
}

async function defaultZone(q: Tx | Deps['db']) {
  return maybeOne<{ id: string }>(q, `SELECT id FROM delivery_zones WHERE active ORDER BY region_code='TAS' DESC, district NULLS FIRST LIMIT 1`);
}

/** Server quote + commission estimate for the partner (estimate only — the order snapshot is authoritative, T16). */
async function quoteDraft(q: Tx | Deps['db'], d: Pick<DraftRow, 'lines' | 'delivery_zone_id'>) {
  if (!d.lines?.length) return null;
  const zone = d.delivery_zone_id ?? (await defaultZone(q))?.id;
  if (!zone) return null;
  const priced = await priceLines(q as Tx, { lines: d.lines, delivery_zone_id: zone });
  let commission = 0n;
  const rules: { sku_id: string; rule: unknown; amount_minor: string }[] = [];
  for (const l of priced.lines) {
    const rule = await ruleForProduct(q, String(l.snapshot.product_id));
    const amt = rule ? computeTarget(rule, { qty: l.qty, canceledQty: 0, returnedQty: 0, lineNet: l.net, refundedProduct: 0n }) : 0n;
    commission += amt;
    rules.push({ sku_id: l.skuId, rule, amount_minor: amt.toString() });
  }
  return { ...pricedToJson(priced), zone_assumed: !d.delivery_zone_id, commission_estimate_minor: commission.toString(), commission_lines: rules };
}

/** A quote failure (e.g. variant sold out) must not block autosave: the draft is saved and the reason is shown. */
async function safeQuote(q: Tx | Deps['db'], d: Pick<DraftRow, 'lines' | 'delivery_zone_id'>) {
  try { return await quoteDraft(q, d); } catch (e) { return { error: (e as { code?: string }).code ?? 'QUOTE_FAILED' }; }
}

async function loadDraft(q: Tx | Deps['db'], id: string, partnerId: string, lock = false): Promise<DraftRow> {
  const d = await maybeOne<DraftRow>(q, `SELECT * FROM sales_drafts WHERE id=$1 AND partner_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, partnerId]);
  if (!d) throw notFound('DRAFT'); // other partners' drafts look non-existent (T28)
  return d;
}

const view = (d: DraftRow, extra: Record<string, unknown> = {}) => ({
  id: d.id, status: d.status, source: d.source, lines: d.lines, customer_name: d.customer_name, customer_phone: d.customer_phone, delivery_zone_id: d.delivery_zone_id,
  address: d.address, address_later: d.address_later, contact_time: d.contact_time, note: d.note, fill_status: d.fill_status, fill_expires_at: d.fill_expires_at, order_id: d.order_id,
  version: d.version, created_at: d.created_at, updated_at: d.updated_at, missing: missingFields(d), ...extra,
});

/** Convert a complete draft into one partner-assisted order (row lock + unique order_id ⇒ idempotent, T06). */
async function convertDraft(tx: Tx, cfg: AppConfig, actor: Actor, d: DraftRow) {
  if (d.order_id) {
    const o = await one<{ number: string }>(tx, `SELECT number FROM orders WHERE id=$1`, [d.order_id]);
    return { order_id: d.order_id, number: o.number, status: 'awaiting_customer_confirmation', replayed: true };
  }
  const miss = missingFields(d);
  if (miss.length) throw unprocessable('DRAFT_INCOMPLETE', { missing: miss });
  const phone = normalizeUzPhone(d.customer_phone!)!;
  const partner = await one<{ id: string; user_id: string; status: string }>(tx, `SELECT id, user_id, status FROM partners WHERE id=$1`, [d.partner_id]);
  if (partner.status !== 'active') throw new AppError(403, 'PARTNER_NOT_ACTIVE');
  const priced = await priceLines(tx, { lines: d.lines, delivery_zone_id: d.delivery_zone_id! });
  const zone = await one<{ region_code: string }>(tx, `SELECT region_code FROM delivery_zones WHERE id=$1`, [d.delivery_zone_id]);
  const address = { region_code: zone.region_code, ...d.address };
  const q = await storeQuote(tx, priced, { cartId: null, userId: null, createdBy: partner.user_id, address, contact: { name: d.customer_name!.trim(), phone }, ttlMinutes: cfg.quoteTtlMinutes });
  const note = [d.note, d.contact_time ? `Aloqa vaqti: ${d.contact_time}` : null].filter(Boolean).join(' · ') || 'Hamkor kabineti orqali';
  const r = await createAssistedOrder(tx, cfg, actor, partner, { quoteId: q.id, quoteHash: priced.hash, note });
  await tx.query(`UPDATE orders SET contact_time_note=$2 WHERE id=$1`, [r.order_id, d.contact_time]);
  await tx.query(`UPDATE sales_drafts SET status='converted', order_id=$2, raw_message=NULL, version=version+1, updated_at=now() WHERE id=$1`, [d.id, r.order_id]);
  return r;
}

export function registerSalesDrafts(app: FastifyInstance, deps: Deps): void {
  const T = ['partner-drafts'];

  route(app, deps, { method: 'GET', url: '/partner/drafts', tags: T, summary: 'My open drafts (and recently converted)', query: z.object({ status: z.enum(['open', 'all']).default('open') }) }, async ({ actor, db, query }) => {
    const p = await myPartner(db, actor, false);
    const rows = await many<DraftRow & { product_names: string | null }>(db, `
      SELECT d.*, (SELECT string_agg(p.name->>'uz-Latn', ', ') FROM jsonb_array_elements(d.lines) l JOIN skus s ON s.id=(l->>'sku_id')::uuid JOIN products p ON p.id=s.product_id) AS product_names
        FROM sales_drafts d WHERE d.partner_id=$1 ${query.status === 'open' ? `AND d.status IN ('draft','awaiting_customer')` : ''} ORDER BY d.updated_at DESC LIMIT 100`, [p.id]);
    return { items: rows.map((d) => view(d, { product_names: d.product_names })) };
  });

  route(app, deps, { method: 'POST', url: '/partner/drafts', tags: T, summary: 'Create draft (any subset of fields; autosave continues via PATCH)', body: zDraft }, async ({ actor, db, body }) => {
    const p = await myPartner(db, actor);
    const d = await one<DraftRow>(db, `INSERT INTO sales_drafts (partner_id, created_by, source, lines, customer_name, customer_phone, delivery_zone_id, address, address_later, contact_time, note, raw_message)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [p.id, actor.userId, body.source ?? 'manual', JSON.stringify(body.lines ?? []), body.customer_name ?? null, body.customer_phone ?? null, body.delivery_zone_id ?? null, JSON.stringify(body.address ?? {}), body.address_later ?? false, body.contact_time ?? null, body.note ?? null, body.raw_message ?? null]);
    return view(d, { quote: await safeQuote(db, d) });
  });

  route(app, deps, { method: 'GET', url: '/partner/drafts/:id', tags: T, summary: 'Draft with missing fields and a live server quote', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const d = await loadDraft(db, params.id, p.id);
    return view(d, { quote: await safeQuote(db, d) });
  });

  route(app, deps, { method: 'PATCH', url: '/partner/drafts/:id', tags: T, summary: 'Autosave (expected_version; stale tabs cannot overwrite newer data)', params: zIdParam, body: zDraft.extend({ expected_version: z.number().int() }) },
    async ({ actor, db, params, body }) => {
      const p = await myPartner(db, actor);
      const saved = await withTx(db, async (tx) => {
        const d = await loadDraft(tx, params.id, p.id, true);
        if (!['draft', 'awaiting_customer'].includes(d.status)) throw conflict('DRAFT_CLOSED');
        if (d.version !== body.expected_version) throw conflict('VERSION_CONFLICT', { current_version: d.version });
        const n = await one<DraftRow>(tx, `UPDATE sales_drafts SET
            lines=COALESCE($2, lines), customer_name=CASE WHEN $3 THEN $4 ELSE customer_name END, customer_phone=CASE WHEN $5 THEN $6 ELSE customer_phone END,
            delivery_zone_id=CASE WHEN $7 THEN $8::uuid ELSE delivery_zone_id END, address=COALESCE($9, address), address_later=COALESCE($10, address_later),
            contact_time=CASE WHEN $11 THEN $12 ELSE contact_time END, note=CASE WHEN $13 THEN $14 ELSE note END, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
          [d.id, body.lines ? JSON.stringify(body.lines) : null, body.customer_name !== undefined, body.customer_name ?? null, body.customer_phone !== undefined, body.customer_phone ?? null,
           body.delivery_zone_id !== undefined, body.delivery_zone_id ?? null, body.address ? JSON.stringify(body.address) : null, body.address_later ?? null,
           body.contact_time !== undefined, body.contact_time ?? null, body.note !== undefined, body.note ?? null]);
        return n;
      });
      // Quote after commit: a pricing failure (e.g. sold out) never undoes the autosave.
      return view(saved, { quote: await safeQuote(db, saved) });
    });

  route(app, deps, { method: 'POST', url: '/partner/drafts/:id/submit', tags: T, summary: 'Create the order from a complete draft (idempotent; customer must confirm by SMS)', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    const p = await myPartner(db, actor);
    return withTx(db, async (tx) => {
      const d = await loadDraft(tx, params.id, p.id, true);
      if (['cancelled', 'expired'].includes(d.status)) throw conflict('DRAFT_CLOSED');
      const r = await convertDraft(tx, cfg, actor, d);
      await audit(tx, actor, 'draft.submitted', { type: 'sales_draft', id: d.id }, { after: { order_id: r.order_id } });
      return r;
    });
  });

  route(app, deps, { method: 'POST', url: '/partner/drafts/:id/share', tags: T, summary: 'Create a customer fill link (time-limited, revocable; no personal data in the URL)', params: zIdParam, body: z.object({ hours: z.number().int().min(1).max(168).default(72) }) },
    async ({ actor, db, cfg, params, body }) => {
      const p = await myPartner(db, actor);
      return withTx(db, async (tx) => {
        const d = await loadDraft(tx, params.id, p.id, true);
        if (!['draft', 'awaiting_customer'].includes(d.status)) throw conflict('DRAFT_CLOSED');
        if (!d.lines.length) throw unprocessable('DRAFT_INCOMPLETE', { missing: ['product'] });
        const token = randomBytes(24).toString('base64url');
        await tx.query(`UPDATE sales_drafts SET fill_token_hash=$2, fill_expires_at=now() + make_interval(hours => $3), fill_status='shared', status='awaiting_customer', version=version+1, updated_at=now() WHERE id=$1`, [d.id, hashToken(token), body.hours]);
        await audit(tx, actor, 'draft.link_shared', { type: 'sales_draft', id: d.id }, { after: { hours: body.hours } });
        const e = await one<{ fill_expires_at: string }>(tx, `SELECT fill_expires_at FROM sales_drafts WHERE id=$1`, [d.id]);
        return { url: `${cfg.publicWebUrl}/f/${token}`, expires_at: e.fill_expires_at };
      });
    });

  route(app, deps, { method: 'POST', url: '/partner/drafts/:id/revoke-link', tags: T, summary: 'Revoke the customer fill link', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor);
    const r = await db.query(`UPDATE sales_drafts SET fill_token_hash=NULL, fill_status='revoked', status=CASE WHEN status='awaiting_customer' THEN 'draft' ELSE status END, version=version+1, updated_at=now() WHERE id=$1 AND partner_id=$2 AND status IN ('draft','awaiting_customer') RETURNING id`, [params.id, p.id]);
    if (!r.rowCount) throw notFound('DRAFT');
    return { ok: true };
  });

  route(app, deps, { method: 'DELETE', url: '/partner/drafts/:id', tags: T, summary: 'Cancel a draft (kept for history)', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await db.query(`UPDATE sales_drafts SET status='cancelled', fill_token_hash=NULL, raw_message=NULL, version=version+1, updated_at=now() WHERE id=$1 AND partner_id=$2 AND status IN ('draft','awaiting_customer') RETURNING id`, [params.id, p.id]);
    if (!r.rowCount) throw notFound('DRAFT');
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/partner/drafts/parse', tags: T, summary: 'Extract draft fields from a pasted customer message (rule-based; review required)', body: z.object({ text: z.string().min(2).max(2000) }) },
    async ({ actor, db, body }) => {
      await myPartner(db, actor);
      const catalog = await many<CatalogItem>(db, `
        SELECT p.id AS product_id, p.slug, p.name, p.search_doc,
               (SELECT json_agg(json_build_object('sku_id', s.id, 'variant', s.variant, 'available', GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0)))) FROM skus s LEFT JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') AS skus
          FROM products p WHERE p.status='published' LIMIT 1000`);
      return parseMessage(body.text, catalog.map((c) => ({ ...c, skus: c.skus ?? [] })));
    });

  // ---------------- Customer fill link (public) ----------------
  const zTok = z.object({ token: z.string().min(20).max(80) });
  async function byToken(q: Tx | Deps['db'], token: string, lock = false) {
    const d = await maybeOne<DraftRow>(q, `SELECT * FROM sales_drafts WHERE fill_token_hash=$1 ${lock ? 'FOR UPDATE' : ''}`, [hashToken(token)]);
    if (!d || d.fill_status !== 'shared' || d.status !== 'awaiting_customer') throw notFound('FILL_LINK');
    if (d.fill_expires_at && new Date(d.fill_expires_at) < new Date()) throw new AppError(410, 'FILL_LINK_EXPIRED');
    return d;
  }

  // GET never changes state: a messenger preview bot opening the link confirms nothing (T09). No personal data is returned (T10).
  route(app, deps, { method: 'GET', url: '/fill/:token', tags: ['customer-fill'], summary: 'What the customer sees: products, prices, delivery zones (no personal data)', params: zTok }, async ({ db, params }) => {
    const d = await byToken(db, params.token);
    const quote = await quoteDraft(db, d);
    const shop = await maybeOne<{ name: string }>(db, `SELECT name FROM organizations WHERE kind='platform_owner'`);
    const zones = await many(db, `SELECT id, name, tariff_minor::text, eta_min_days, eta_max_days FROM delivery_zones WHERE active ORDER BY region_code, district NULLS FIRST`);
    return { shop_name: shop?.name ?? 'UzShop', expires_at: d.fill_expires_at, lines: quote?.lines ?? [], subtotal: quote?.subtotal, delivery_zone_id: d.delivery_zone_id, zones };
  });

  route(app, deps, {
    method: 'POST', url: '/fill/:token', tags: ['customer-fill'], summary: 'Customer fills contact/address; an order is created and the customer confirms it by SMS code',
    params: zTok, body: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().min(5).max(32), delivery_zone_id: z.string().uuid(), address: zAddr.extend({ district: z.string().trim().min(1).max(120), street: z.string().trim().min(1).max(200), house: z.string().trim().min(1).max(30) }), contact_time: z.string().max(120).optional(), accept_terms: z.literal(true) }),
  }, async ({ actor, db, cfg, params, body }) => {
    const phone = normalizeUzPhone(body.phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
    return withTx(db, async (tx) => {
      const d = await byToken(tx, params.token, true);
      await tx.query(`UPDATE sales_drafts SET customer_name=$2, customer_phone=$3, delivery_zone_id=$4, address=$5, address_later=false, contact_time=COALESCE($6, contact_time), fill_status='filled', fill_token_hash=NULL, source=CASE WHEN source='manual' THEN 'customer_link' ELSE source END, updated_at=now() WHERE id=$1`,
        [d.id, body.name, phone, body.delivery_zone_id, JSON.stringify(body.address), body.contact_time ?? null]);
      const fresh = await one<DraftRow>(tx, `SELECT * FROM sales_drafts WHERE id=$1`, [d.id]);
      const r = await convertDraft(tx, cfg, { ...actor, kind: 'anonymous' }, fresh);
      await audit(tx, null, 'draft.customer_filled', { type: 'sales_draft', id: d.id }, { after: { order_id: r.order_id } });
      // The customer receives the SMS code on their own phone; the response carries no code (dev echo only outside production).
      const dev = r as { dev_customer_link_token?: string; dev_customer_code?: string };
      return { ok: true, order_number: r.number, next: 'confirm_by_sms', ...(dev.dev_customer_link_token ? { dev_customer_link_token: dev.dev_customer_link_token, dev_customer_code: dev.dev_customer_code } : {}) };
    });
  });
}
