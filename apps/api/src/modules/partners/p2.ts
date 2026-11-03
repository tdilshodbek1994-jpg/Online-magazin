import { normalizeUzPhone } from '@om/shared';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { hashToken } from '../../platform/auth.js';
import { type Db, many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { getPolicy } from '../../platform/policies.js';
import { reserveForDraft, releaseDraftHold } from '../inventory/service.js';
import { queueNotification } from '../notifications/service.js';
import { maskedNumber, notifyPartner } from '../notifications/telegram.js';
import { visitorHash } from './attribution.js';
import { BUCKET_SQL, maskName, maskTail } from './cabinet.js';
import { convertDraft, type DraftRow, liveHold, loadDraft, missingFields, view } from './drafts.js';
import { myPartner } from './routes.js';

/**
 * Partner cabinet 2.0 — P2 (V2 spec §08 offer sets, §09 short hold + waitlist, §14 contact notebook,
 * §17 decision analytics + ad spend, §18 plain-language helpers). Everything reuses the existing order,
 * draft, reservation and ledger objects — no parallel source of truth.
 */
const POL = { holdMinutes: 'partner_hold.minutes', holdMax: 'partner_hold.max_active', offerTtl: 'partner_offer.ttl_hours' } as const;
async function policyNumber(q: Tx | Db, key: string, field: string, env: string): Promise<number> {
  const p = await getPolicy<Record<string, number>>(q, key, env);
  const v = p?.value?.[field];
  // No approved value in production → the feature is off rather than running on an invented default (§02).
  if (typeof v !== 'number' || v <= 0) throw new AppError(409, 'POLICY_NOT_SET', { key });
  return v;
}
const PUBLIC_PRODUCT = `
  SELECT p.id, p.slug, p.name, p.warranty_months, b.name AS brand, left(p.description->>'uz-Latn', 220) AS about,
         (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
         (SELECT json_agg(json_build_object('sku_id', s.id, 'variant', s.variant, 'price_minor', o.price_minor::text, 'compare_at_minor', o.compare_at_minor::text,
                 'available', GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0))) ORDER BY s.sku_code)
            FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' LEFT JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') AS variants
    FROM products p LEFT JOIN brands b ON b.id=p.brand_id`;
const zAddr = z.object({ district: z.string().trim().min(1).max(120), street: z.string().trim().min(1).max(200), house: z.string().trim().min(1).max(30), apartment: z.string().max(30).optional(), landmark: z.string().max(300).optional() });

export function registerPartnerP2(app: FastifyInstance, deps: Deps): void {
  const T = ['partner-p2'];

  // ---------------- §09 Short hold for a ready customer ----------------
  route(app, deps, { method: 'POST', url: '/partner/drafts/:id/hold', tags: T, summary: 'Hold stock for a complete draft for a short time (real reservation, partner limit, expiry)', params: zIdParam },
    async ({ actor, db, cfg, params }) => {
      const p = await myPartner(db, actor);
      return withTx(db, async (tx) => {
        const d = await loadDraft(tx, params.id, p.id, true);
        if (d.status !== 'draft') throw conflict('DRAFT_CLOSED');
        // Only an eligible (complete) draft may take stock — unfinished drafts never block the warehouse.
        const miss = missingFields(d);
        if (miss.length) throw unprocessable('DRAFT_INCOMPLETE', { missing: miss });
        const live = await liveHold(tx, d.id);
        if (live) return { ...live, replayed: true };
        await releaseDraftHold(tx, { draftId: d.id }, 'expired'); // a stale hold past expiry is returned first
        const minutes = await policyNumber(tx, POL.holdMinutes, 'minutes', cfg.env);
        const max = await policyNumber(tx, POL.holdMax, 'count', cfg.env);
        await tx.query(`SELECT id FROM partners WHERE id=$1 FOR UPDATE`, [p.id]); // serialise the limit check per partner
        const n = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM reservations WHERE partner_id=$1 AND status='active_unpaid' AND expires_at > now()`, [p.id]);
        if (n.n >= max) throw conflict('HOLD_LIMIT', { max });
        const h = await reserveForDraft(tx, d.id, p.id, d.lines.map((l) => ({ skuId: l.sku_id, qty: l.qty })), minutes);
        await audit(tx, actor, 'draft.hold_created', { type: 'sales_draft', id: d.id }, { after: { minutes } });
        return { ...h, minutes };
      });
    });
  route(app, deps, { method: 'DELETE', url: '/partner/drafts/:id/hold', tags: T, summary: 'Release the hold now', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    return withTx(db, async (tx) => {
      await loadDraft(tx, params.id, p.id, true);
      return { released: await releaseDraftHold(tx, { draftId: params.id }, 'released') };
    });
  });

  // ---------------- §08 Offer set ("Mijoz hali tanlamadi") ----------------
  route(app, deps, { method: 'POST', url: '/partner/offers', tags: T, summary: 'Create a 2–3 product choice link (catalog data only + a short partner note)',
    body: z.object({ product_ids: z.array(z.string().uuid()).min(2).max(3), note: z.string().trim().max(300).optional() }) },
  async ({ actor, db, cfg, body }) => {
    const p = await myPartner(db, actor);
    const ids = [...new Set(body.product_ids)];
    if (ids.length < 2) throw badRequest('OFFER_NEEDS_2_PRODUCTS');
    const ok = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM products WHERE id = ANY($1::uuid[]) AND status='published'`, [ids]);
    if (ok.n !== ids.length) throw notFound('PRODUCT');
    const hours = await policyNumber(db, POL.offerTtl, 'hours', cfg.env);
    const token = randomBytes(24).toString('base64url');
    const o = await one<{ id: string; expires_at: string }>(db, `INSERT INTO partner_offers (partner_id, token_hash, product_ids, note, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
      [p.id, hashToken(token), ids, body.note || null, hours]);
    await audit(db, actor, 'offer.created', { type: 'partner_offer', id: o.id }, { after: { products: ids.length } });
    return { id: o.id, url: `${cfg.publicWebUrl}/t/${token}`, expires_at: o.expires_at };
  });

  route(app, deps, { method: 'GET', url: '/partner/offers', tags: T, summary: 'My offer sets with what the customer did' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const rows = await many<Record<string, unknown> & { expires_at: string; status: string }>(db, `
      SELECT f.id, f.status, f.note, f.seen_at, f.expires_at, f.created_at, f.remind_at, (f.remind_phone IS NOT NULL) AS wants_reminder,
             (SELECT json_agg(json_build_object('id', pr.id, 'name', pr.name, 'slug', pr.slug)) FROM products pr WHERE pr.id = ANY(f.product_ids)) AS products,
             (SELECT pr.name FROM skus s JOIN products pr ON pr.id=s.product_id WHERE s.id=f.chosen_sku_id) AS chosen,
             f.order_id, CASE WHEN o.id IS NULL THEN NULL ELSE 'OM-***' || right(o.number, 3) END AS order_masked
        FROM partner_offers f LEFT JOIN orders o ON o.id=f.order_id WHERE f.partner_id=$1 ORDER BY f.created_at DESC LIMIT 100`, [p.id]);
    return { items: rows.map((r) => ({ ...r, status: ['open', 'thinking'].includes(r.status) && new Date(r.expires_at) < new Date() ? 'expired' : r.status })) };
  });

  route(app, deps, { method: 'POST', url: '/partner/offers/:id/close', tags: T, summary: 'Close an offer link', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await db.query(`UPDATE partner_offers SET status='closed', updated_at=now() WHERE id=$1 AND partner_id=$2 AND status IN ('open','thinking') RETURNING id`, [params.id, p.id]);
    if (!r.rowCount) throw notFound('OFFER');
    return { ok: true };
  });

  const zTok = z.object({ token: z.string().min(20).max(80) });
  async function offerByToken(q: Tx | Db, token: string, lock = false) {
    const f = await maybeOne<{ id: string; partner_id: string; product_ids: string[]; note: string | null; status: string; expires_at: string; order_id: string | null }>(q,
      `SELECT id, partner_id, product_ids, note, status, expires_at, order_id FROM partner_offers WHERE token_hash=$1 ${lock ? 'FOR UPDATE' : ''}`, [hashToken(token)]);
    if (!f || f.status === 'closed') throw notFound('OFFER');
    if (f.status === 'chosen') throw new AppError(409, 'OFFER_ALREADY_CHOSEN');
    if (new Date(f.expires_at) < new Date()) throw new AppError(410, 'OFFER_EXPIRED');
    return f;
  }
  // GET never changes state (link previews); no commission, no partner identity beyond a display note.
  route(app, deps, { method: 'GET', url: '/offer/:token', tags: ['customer-offer'], summary: 'Offer set as the customer sees it (catalog data; no commission)', params: zTok }, async ({ db, params }) => {
    const f = await offerByToken(db, params.token);
    const products = await many(db, `${PUBLIC_PRODUCT} WHERE p.id = ANY($1::uuid[]) AND p.status='published'`, [f.product_ids]);
    const zones = await many(db, `SELECT id, name, tariff_minor::text, eta_min_days, eta_max_days FROM delivery_zones WHERE active ORDER BY region_code, district NULLS FIRST`);
    return { note: f.note, status: f.status, expires_at: f.expires_at, products, zones };
  });
  route(app, deps, { method: 'POST', url: '/offer/:token/seen', tags: ['customer-offer'], summary: 'Marks the offer as opened by a person (called by the page script, not by GET)', params: zTok }, async ({ db, params }) => {
    await db.query(`UPDATE partner_offers SET seen_at=COALESCE(seen_at, now()) WHERE token_hash=$1`, [hashToken(params.token)]);
    return { ok: true };
  });
  route(app, deps, { method: 'POST', url: '/offer/:token/later', tags: ['customer-offer'], summary: '"Keyin qaror qilaman" — optional single reminder only with consent',
    params: zTok, body: z.object({ remind: z.boolean(), when: z.enum(['tomorrow', 'in_3_days']).default('tomorrow'), phone: z.string().min(5).max(32).optional(), consent: z.boolean().optional() }) },
  async ({ db, params, body }) => {
    let phone: string | null = null;
    if (body.remind) {
      phone = normalizeUzPhone(body.phone ?? '');
      if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
      if (body.consent !== true) throw badRequest('CONSENT_REQUIRED');
    }
    return withTx(db, async (tx) => {
      const f = await offerByToken(tx, params.token, true);
      await tx.query(`UPDATE partner_offers SET status='thinking', remind_phone=$2, remind_consent_at=CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
          remind_at=CASE WHEN $2::text IS NULL THEN NULL WHEN $3='tomorrow' THEN now() + interval '1 day' ELSE now() + interval '3 days' END, updated_at=now() WHERE id=$1`, [f.id, phone, body.when]);
      return { ok: true, reminder: !!phone };
    });
  });
  route(app, deps, {
    method: 'POST', url: '/offer/:token/choose', tags: ['customer-offer'], summary: '"Hozir olaman": the customer picks one variant; an order is created and confirmed by SMS',
    params: zTok, body: z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(10).default(1), name: z.string().trim().min(2).max(120), phone: z.string().min(5).max(32), delivery_zone_id: z.string().uuid(), address: zAddr, contact_time: z.string().max(120).optional(), accept_terms: z.literal(true) }),
  }, async ({ actor, db, cfg, params, body }) => {
    const phone = normalizeUzPhone(body.phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
    return withTx(db, async (tx) => {
      const f = await offerByToken(tx, params.token, true);
      const sku = await maybeOne<{ product_id: string }>(tx, `SELECT product_id FROM skus WHERE id=$1 AND status='active'`, [body.sku_id]);
      // Only a product that is part of this offer can be ordered; nothing else becomes an order.
      if (!sku || !f.product_ids.includes(sku.product_id)) throw badRequest('SKU_NOT_IN_OFFER');
      const partner = await one<{ user_id: string }>(tx, `SELECT user_id FROM partners WHERE id=$1`, [f.partner_id]);
      const d = await one<DraftRow>(tx, `INSERT INTO sales_drafts (partner_id, created_by, source, lines, customer_name, customer_phone, delivery_zone_id, address, address_later, contact_time, note)
          VALUES ($1,$2,'customer_link',$3,$4,$5,$6,$7,false,$8,'Taklif to‘plamidan mijoz tanladi') RETURNING *`,
        [f.partner_id, partner.user_id, JSON.stringify([{ sku_id: body.sku_id, qty: body.qty }]), body.name, phone, body.delivery_zone_id, JSON.stringify(body.address), body.contact_time ?? null]);
      const r = await convertDraft(tx, cfg, { ...actor, kind: 'anonymous' }, d);
      await tx.query(`UPDATE partner_offers SET status='chosen', chosen_sku_id=$2, draft_id=$3, order_id=$4, remind_at=NULL, updated_at=now() WHERE id=$1`, [f.id, body.sku_id, d.id, r.order_id]);
      await notifyPartner(tx, f.partner_id, 'partner.customer_filled', { number: maskedNumber(r.number), source: 'taklif to‘plami' }, `offer-chosen:${f.id}`);
      await audit(tx, null, 'offer.chosen', { type: 'partner_offer', id: f.id }, { after: { order_id: r.order_id } });
      const dev = r as { dev_customer_link_token?: string; dev_customer_code?: string };
      return { ok: true, order_number: r.number, next: 'confirm_by_sms', ...(dev.dev_customer_link_token ? { dev_customer_link_token: dev.dev_customer_link_token, dev_customer_code: dev.dev_customer_code } : {}) };
    });
  });

  // ---------------- §09 Waitlist for sold-out products ----------------
  route(app, deps, { method: 'POST', url: '/waitlist', tags: ['catalog'], summary: 'Join the waitlist of a sold-out product (explicit consent; one SMS when back)',
    body: z.object({ product_id: z.string().uuid(), sku_id: z.string().uuid().optional(), phone: z.string().min(5).max(32), consent: z.literal(true) }) },
  async ({ actor, db, body }) => {
    const phone = normalizeUzPhone(body.phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
    const pr = await maybeOne(db, `SELECT id FROM products WHERE id=$1 AND status='published'`, [body.product_id]);
    if (!pr) throw notFound('PRODUCT');
    const touch = actor.guestToken ? await maybeOne<{ partner_id: string }>(db, `SELECT partner_id FROM referral_touches WHERE visitor_hash=$1 AND eligible ORDER BY touched_at DESC LIMIT 1`, [visitorHash(actor.guestToken)]) : null;
    await db.query(`INSERT INTO stock_waitlist (product_id, sku_id, phone, consent_at, partner_id) VALUES ($1,$2,$3, now(), $4)
        ON CONFLICT (product_id, phone) DO UPDATE SET status='waiting', consent_at=now(), notified_at=NULL, sku_id=EXCLUDED.sku_id`, [body.product_id, body.sku_id ?? null, phone, touch?.partner_id ?? null]);
    return { ok: true };
  });
  route(app, deps, { method: 'GET', url: '/products/:id/alternatives', tags: ['catalog'], summary: 'In-stock alternatives from the same category', params: zIdParam }, async ({ db, params }) => {
    return { items: await many(db, `
      SELECT p.id, p.slug, p.name, (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
             (SELECT MIN(o.price_minor)::text FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id) AS price_minor
        FROM products p WHERE p.status='published' AND p.id <> $1 AND p.category_id = (SELECT category_id FROM products WHERE id=$1)
         AND EXISTS (SELECT 1 FROM skus s JOIN stock_atp a ON a.sku_id=s.id WHERE s.product_id=p.id AND a.atp > 0)
       ORDER BY p.published_at DESC LIMIT 6`, [params.id]) };
  });

  // ---------------- §14 Contact notebook ----------------
  route(app, deps, { method: 'GET', url: '/partner/contacts', tags: T, summary: 'My own customer contacts (only those from my drafts/orders)', query: z.object({ q: z.string().max(60).optional() }) }, async ({ actor, db, query }) => {
    const p = await myPartner(db, actor, false);
    const params: unknown[] = [p.id];
    let where = '';
    if (query.q) { params.push(`%${query.q}%`); where = `AND (c.name ILIKE $2 OR (c.entered_by_partner AND c.phone LIKE $2))`; }
    const rows = await many<Record<string, unknown> & { phone: string; entered_by_partner: boolean }>(db, `
      SELECT c.id, c.phone, c.name, c.contact_time, c.note, c.do_not_contact, c.entered_by_partner, c.last_activity_at,
             (SELECT json_agg(pr.name) FROM products pr WHERE pr.id::text IN (SELECT jsonb_array_elements_text(c.interested))) AS interested,
             CASE WHEN o.id IS NULL THEN NULL ELSE 'OM-***' || right(o.number, 3) END AS last_order_masked, o.id AS last_order_id,
             CASE WHEN o.id IS NULL THEN NULL ELSE ${BUCKET_SQL} END AS last_bucket
        FROM partner_contacts c LEFT JOIN orders o ON o.id=c.last_order_id AND o.attributed_partner_id=c.partner_id
       WHERE c.partner_id=$1 ${where} ORDER BY c.last_activity_at DESC LIMIT 200`, params);
    // A phone the customer typed into the partner's link is shown masked; one the partner entered is shown in full.
    return { items: rows.map((r) => ({ ...r, phone: r.entered_by_partner ? r.phone : maskTail(r.phone), name: r.entered_by_partner ? r.name : maskName(r.name) })) };
  });
  route(app, deps, { method: 'PATCH', url: '/partner/contacts/:id', tags: T, summary: 'Note / do-not-contact / preferred time', params: zIdParam,
    body: z.object({ note: z.string().max(500).nullable().optional(), do_not_contact: z.boolean().optional(), contact_time: z.string().max(120).nullable().optional() }) },
  async ({ actor, db, params, body }) => {
    const p = await myPartner(db, actor, false);
    const r = await maybeOne(db, `UPDATE partner_contacts SET note=CASE WHEN $3 THEN $4 ELSE note END, do_not_contact=COALESCE($5, do_not_contact), contact_time=CASE WHEN $6 THEN $7 ELSE contact_time END
        WHERE id=$1 AND partner_id=$2 RETURNING id`, [params.id, p.id, body.note !== undefined, body.note ?? null, body.do_not_contact ?? null, body.contact_time !== undefined, body.contact_time ?? null]);
    if (!r) throw notFound('CONTACT');
    return { ok: true };
  });
  route(app, deps, { method: 'POST', url: '/partner/contacts/:id/reorder', tags: T, summary: 'New draft from the previous order (prices/stock/commission recomputed; customer confirms again)', params: zIdParam,
    body: z.object({ reuse_address: z.boolean().default(false) }) },
  async ({ actor, db, params, body }) => {
    const p = await myPartner(db, actor);
    const c = await maybeOne<{ phone: string; name: string | null; contact_time: string | null; last_order_id: string | null; do_not_contact: boolean; entered_by_partner: boolean }>(db,
      `SELECT phone, name, contact_time, last_order_id, do_not_contact, entered_by_partner FROM partner_contacts WHERE id=$1 AND partner_id=$2`, [params.id, p.id]);
    if (!c) throw notFound('CONTACT');
    if (c.do_not_contact) throw conflict('DO_NOT_CONTACT');
    if (!c.last_order_id) throw unprocessable('NO_PREVIOUS_ORDER');
    const lines = await many<{ sku_id: string; qty: number }>(db, `SELECT ol.sku_id, (ol.qty - ol.returned_qty)::int AS qty FROM order_lines ol WHERE ol.order_id=$1 AND ol.qty > ol.returned_qty`, [c.last_order_id]);
    const o = await one<{ address_snapshot: Record<string, string>; delivery_zone_id: string | null }>(db, `SELECT address_snapshot, (SELECT id FROM delivery_zones z WHERE z.region_code=o.address_snapshot->>'region_code' AND z.active ORDER BY district NULLS FIRST LIMIT 1) AS delivery_zone_id FROM orders o WHERE id=$1`, [c.last_order_id]);
    const a = o.address_snapshot ?? {};
    // The address is reused only when the partner confirms the customer allowed it and it has not changed.
    const address = body.reuse_address ? { district: a.district, street: a.street, house: a.house, apartment: a.apartment, landmark: a.landmark } : {};
    const d = await one<DraftRow>(db, `INSERT INTO sales_drafts (partner_id, created_by, source, lines, customer_name, customer_phone, delivery_zone_id, address, address_later, contact_time, note)
        VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,false,$8,'Avvalgi buyurtma asosida') RETURNING *`,
      [p.id, actor.userId, JSON.stringify(lines), c.entered_by_partner ? c.name : null, c.entered_by_partner ? c.phone : null, o.delivery_zone_id, JSON.stringify(address), c.contact_time]);
    return view(d);
  });

  // ---------------- §17 Ad spend (partner-entered) + decision analytics ----------------
  route(app, deps, { method: 'POST', url: '/partner/ad-spend', tags: T, summary: 'Record my ad spend (shown as "hamkor kiritgan")',
    body: z.object({ spent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount_minor: z.string().regex(/^[1-9]\d{0,13}$/), channel: z.string().trim().max(60).optional(), note: z.string().trim().max(200).optional() }) },
  async ({ actor, db, body }) => {
    const p = await myPartner(db, actor, false);
    // Single expense source (ad_expenses): the quick form is a one-day, partner-paid, actual UZS expense.
    const ch = /insta/i.test(body.channel ?? '') ? 'instagram_target' : /telegram/i.test(body.channel ?? '') ? 'telegram_channel' : 'other';
    return one(db, `INSERT INTO ad_expenses (partner_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, service_from, service_to, paid_at, payer, kind, source, note, created_by)
        VALUES ($1,$2,$3,$4::bigint / 100.0,'UZS',1,1,$5,'identity',$4,$5,$5,$5,'partner','actual','manual',$6,$7) RETURNING id`, [p.id, ch, body.channel || null, body.amount_minor, body.spent_on, body.note || null, actor.userId]);
  });
  route(app, deps, { method: 'GET', url: '/partner/ad-spend', tags: T, summary: 'My ad spend entries' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `SELECT id, service_from::text AS spent_on, amount_uzs_minor::text AS amount_minor, COALESCE(placement_name, channel) AS channel, note FROM ad_expenses WHERE partner_id=$1 AND status='active' AND kind IN ('actual','adjustment') ORDER BY service_from DESC, created_at DESC LIMIT 200`, [p.id]) };
  });
  route(app, deps, { method: 'DELETE', url: '/partner/ad-spend/:id', tags: T, summary: 'Delete my ad spend entry', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const r = await db.query(`UPDATE ad_expenses SET status='void', version=version+1, updated_at=now() WHERE id=$1 AND partner_id=$2 AND status <> 'void'`, [params.id, p.id]);
    if (!r.rowCount) throw notFound('AD_SPEND');
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/partner/insights', tags: T, summary: 'Decision analytics: separated channels, honest rates (formula, period, n), net after ad spend, where sales stop',
    query: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }) },
  async ({ actor, db, query }) => {
    const p = await myPartner(db, actor, false);
    const since = `now() - make_interval(days => ${query.days})`;
    const c = await one<Record<string, number>>(db, `
      SELECT
        (SELECT COUNT(*) FROM referral_touches t WHERE t.partner_id=$1 AND t.eligible AND t.touched_at >= ${since})::int AS clicks,
        (SELECT COUNT(DISTINCT t.visitor_hash) FROM referral_touches t WHERE t.partner_id=$1 AND t.eligible AND t.touched_at >= ${since})::int AS visitors,
        COUNT(*) FILTER (WHERE o.channel='web')::int AS web_orders,
        COUNT(*) FILTER (WHERE o.channel='partner_assisted')::int AS manual_orders,
        COUNT(*) FILTER (WHERE ${BUCKET_SQL} IN ('accepted','shipping','delivered','returned'))::int AS accepted,
        COUNT(*) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE ${BUCKET_SQL}='returned')::int AS returned,
        COUNT(*) FILTER (WHERE ${BUCKET_SQL}='cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE ${BUCKET_SQL} IN ('new','accepted','shipping'))::int AS open,
        COUNT(*) FILTER (WHERE o.confirmation_status IN ('rejected','expired'))::int AS customer_not_confirmed,
        COUNT(*)::int AS total
      FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at >= ${since}`, [p.id]);
    const deliveredInPeriod = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM orders o WHERE o.attributed_partner_id=$1 AND o.delivered_at >= ${since}`, [p.id]);
    // Web conversion: distinct eligible visitors in the period who placed at least one attributed web order / distinct eligible visitors. Manual orders are excluded (T29).
    const conv = await one<{ num: number }>(db, `
      SELECT COUNT(DISTINCT t.visitor_hash)::int AS num FROM referral_touches t
       WHERE t.partner_id=$1 AND t.eligible AND t.touched_at >= ${since}
         AND EXISTS (SELECT 1 FROM orders o WHERE o.channel='web' AND o.attributed_partner_id=$1 AND o.attribution->>'touch_id' = t.id::text)`, [p.id]);
    const money = await one<{ confirmed: string; expected: string }>(db, `
      SELECT COALESCE(SUM(a.target_minor) FILTER (WHERE a.state='available'),0)::text AS confirmed,
             COALESCE(SUM(a.target_minor) FILTER (WHERE a.state IN ('estimated','pending')),0)::text AS expected
        FROM commission_accruals a JOIN orders o ON o.id=a.order_id WHERE a.partner_id=$1 AND o.created_at >= ${since}`, [p.id]);
    const spend = await one<{ s: string; n: number }>(db, `SELECT COALESCE(SUM(amount_uzs_minor),0)::text AS s, COUNT(*)::int AS n FROM ad_expenses WHERE partner_id=$1 AND status='active' AND payer='partner' AND kind IN ('actual','adjustment','zero_confirmed') AND fx_status='ok' AND service_to >= (${since})::date`, [p.id]);
    const rate = (num: number, den: number, formula: string) => ({ value: den > 0 ? Math.round((num / den) * 1000) / 10 : null, num, den, formula, small_sample: den > 0 && den < 30 });
    const finished = c.delivered! + c.returned! + c.cancelled!;
    const byStream = await many(db, `
      SELECT COALESCE(l.name, CASE WHEN o.channel='partner_assisted' THEN 'Siz kiritgan buyurtmalar' ELSE 'Boshqa havola' END) AS name,
             COUNT(*)::int AS orders, COUNT(*) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered,
             COALESCE(SUM((SELECT SUM(a.target_minor) FROM commission_accruals a WHERE a.order_id=o.id AND a.state <> 'reversed')),0)::text AS commission_minor
        FROM orders o LEFT JOIN referral_links l ON l.id::text = o.attribution->>'link_id'
       WHERE o.attributed_partner_id=$1 AND o.created_at >= ${since} GROUP BY 1 ORDER BY orders DESC LIMIT 10`, [p.id]);
    const byProduct = await many(db, `
      SELECT ol.product_snapshot->'name' AS name, SUM(ol.qty)::int AS units, COUNT(DISTINCT o.id) FILTER (WHERE ${BUCKET_SQL}='delivered')::int AS delivered
        FROM orders o JOIN order_lines ol ON ol.order_id=o.id WHERE o.attributed_partner_id=$1 AND o.created_at >= ${since}
       GROUP BY ol.product_snapshot->'name' ORDER BY units DESC LIMIT 10`, [p.id]);
    // Regions with fewer than 5 orders are folded together so no single customer can be identified.
    const byDistrictRaw = await many<{ district: string | null; orders: number }>(db, `
      SELECT o.address_snapshot->>'district' AS district, COUNT(*)::int AS orders FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC`, [p.id]);
    const byDistrict = byDistrictRaw.filter((d) => d.orders >= 5 && d.district);
    const other = byDistrictRaw.filter((d) => d.orders < 5 || !d.district).reduce((a, d) => a + d.orders, 0);
    if (other) byDistrict.push({ district: 'Boshqa hududlar (kam sonli)', orders: other });

    const spendMinor = BigInt(spend.s);
    const r = {
      days: query.days, updated_at: new Date().toISOString(),
      counts: { ...c, delivered_in_period: deliveredInPeriod.n },
      rates: {
        web_conversion: rate(conv.num, c.visitors!, 'Havoladan kirib, kamida bitta veb-buyurtma bergan noyob tashrifchilar ÷ havoladan kirgan noyob tashrifchilar (o‘zingiz kiritgan buyurtmalar kirmaydi)'),
        acceptance: rate(c.accepted!, c.accepted! + c.cancelled!, 'Qabul qilingan ÷ (qabul qilingan + bekor qilingan) — shu davrda yaratilgan buyurtmalar'),
        delivery_cohort: rate(c.delivered!, finished, 'Shu davrda yaratilib yetkazilgan ÷ shu davrda yaratilib yakunlangan (yetkazilgan + qaytgan + bekor). Yakunlanmaganlar alohida ko‘rsatiladi'),
      },
      money: {
        confirmed_minor: money.confirmed, expected_minor: money.expected,
        ad_spend_minor: spend.s, ad_spend_entries: spend.n, ad_spend_source: 'hamkor kiritgan',
        net_minor: spend.n > 0 ? (BigInt(money.confirmed) - spendMinor).toString() : null,
        net_label: spend.n > 0 ? 'Sof natija = tasdiqlangan komissiya − siz kiritgan reklama xarajati' : 'Reklama xarajati kiritilmagan — bu «foyda» emas, «komissiya»',
      },
      by_stream: byStream, by_product: byProduct, by_district: byDistrict,
      stuck: [] as { title: string; detail: string; n: number }[],
    };
    // "Qayerda to'xtab qolyapti?" — deterministic rules over the partner's own numbers, each with its sample size (§18-C).
    const acc = r.rates.acceptance, del = r.rates.delivery_cohort, wc = r.rates.web_conversion;
    if (c.visitors! >= 30 && wc.value !== null && wc.value < 2) r.stuck.push({ title: 'Ko‘p kishi kiryapti, lekin kam buyurtma berilyapti', detail: 'Postdagi narx va mahsulot sahifasidagi narx bir xilmi, rasm va tavsif tushunarlimi — tekshiring. Yoki mijozga o‘zingiz qo‘ng‘iroq qilib, buyurtmani studiyada kiriting.', n: c.visitors! });
    if (acc.den >= 10 && acc.value !== null && acc.value < 60) r.stuck.push({ title: 'Buyurtmalarning ko‘pi tasdiqlanmayapti', detail: `Mijozlar operatorga yoki SMS kodga javob bermayapti (${c.customer_not_confirmed} ta). Buyurtmadan keyin mijozga «operator qo‘ng‘iroq qiladi» deb aytib qo‘ying va qulay vaqtni yozing.`, n: acc.den });
    if (del.den >= 10 && del.value !== null && del.value < 70) r.stuck.push({ title: 'Yetkazilganlar ulushi past', detail: 'Ko‘p buyurtma qaytmoqda yoki bekor bo‘lmoqda. Mijozga mahsulot, narx va yetkazish muddatini aniq ayting; manzilni to‘liq yozing.', n: del.den });
    if (c.open! > 0 && c.open! >= Math.max(5, c.total! / 2)) r.stuck.push({ title: 'Ko‘p buyurtma hali yakunlanmagan', detail: `${c.open} ta buyurtma jarayonda — foizlar hali o‘zgaradi.`, n: c.open! });
    if (!r.stuck.length) r.stuck.push({ title: c.total! < 10 ? 'Xulosa uchun ma’lumot hali kam' : 'Jiddiy to‘siq ko‘rinmayapti', detail: c.total! < 10 ? `Shu davrda ${c.total} ta buyurtma — kamida 10 ta bo‘lganda tahlil ishonchliroq.` : 'Shu tempni saqlang. Eng ko‘p sotilgan mahsulotlaringizga ko‘proq e’tibor bering.', n: c.total! });
    return r;
  });

  // ---------------- §18-B Ready ad texts from approved catalog data (no invented claims) ----------------
  route(app, deps, { method: 'GET', url: '/partner/products/:id/ad-texts', tags: T, summary: 'Ad texts built only from catalog facts (price, discount, warranty, delivery)', params: zIdParam }, async ({ actor, db, params }) => {
    await myPartner(db, actor, false);
    const pr = await maybeOne<{ name: Record<string, string>; warranty_months: number | null; brand: string | null; about: string | null; price: string | null; was: string | null; eta_min: number | null; eta_max: number | null }>(db, `
      SELECT p.name, p.warranty_months, b.name AS brand, split_part(p.description->>'uz-Latn', E'\\n', 1) AS about,
             (SELECT MIN(o.price_minor)::text FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id) AS price,
             (SELECT MAX(o.compare_at_minor)::text FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id) AS was,
             (SELECT MIN(eta_min_days) FROM delivery_zones WHERE active) AS eta_min, (SELECT MAX(eta_max_days) FROM delivery_zones WHERE active) AS eta_max
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.id=$1 AND p.status='published'`, [params.id]);
    if (!pr) throw notFound('PRODUCT');
    const som = (m: string | null) => (m ? `${String(BigInt(m) / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m` : '');
    const name = pr.name['uz-Latn'] ?? Object.values(pr.name)[0] ?? '';
    const off = pr.was && pr.price && BigInt(pr.was) > BigInt(pr.price) ? Math.round((1 - Number(pr.price) / Number(pr.was)) * 100) : 0;
    const facts = [pr.warranty_months ? `✅ ${pr.warranty_months} oy kafolat` : null, pr.eta_min ? `🚚 Yetkazish ${pr.eta_min}–${pr.eta_max} kun` : null, '💵 To‘lov mahsulotni olganda'].filter(Boolean).join('\n');
    return {
      note: 'Matnlar faqat katalogdagi tasdiqlangan ma’lumotdan tuzildi. Narx o‘zgarsa, matnni qayta oling.',
      items: [
        { style: 'Qisqa', text: `🔥 ${name}${pr.brand ? ` (${pr.brand})` : ''}\n💰 ${som(pr.price)}${off ? ` (−${off}%)` : ''}\n${facts}\n👉 Buyurtma uchun yozing yoki havolani bosing` },
        { style: 'Tavsif bilan', text: `${name}\n\n${pr.about ?? ''}\n\nNarxi: ${som(pr.price)}${off ? `, avvalgi narx ${som(pr.was)}` : ''}\n${facts}\n\nSavollar bo‘lsa — yozing, javob beraman.` },
        { style: 'Story uchun', text: `${name} — ${som(pr.price)}${off ? ` 🔻${off}%` : ''}\n${pr.warranty_months ? `${pr.warranty_months} oy kafolat · ` : ''}to‘lov olganda` },
      ],
    };
  });
}

/** Worker tick for P2: waitlist "back in stock" SMS (once) and offer reminders the customer asked for (once). */
export async function runP2Scheduled(db: Db): Promise<void> {
  const back = await db.query(`
    SELECT w.id, w.phone, p.slug, p.name->>'uz-Latn' AS name FROM stock_waitlist w JOIN products p ON p.id=w.product_id
     WHERE w.status='waiting' AND p.status='published'
       AND EXISTS (SELECT 1 FROM skus s JOIN stock_atp a ON a.sku_id=s.id WHERE s.product_id=w.product_id AND (w.sku_id IS NULL OR s.id=w.sku_id) AND a.atp > 0)
     LIMIT 200`);
  for (const w of back.rows) {
    await withTx(db, async (tx) => {
      const u = await tx.query(`UPDATE stock_waitlist SET status='notified', notified_at=now() WHERE id=$1 AND status='waiting' RETURNING id`, [w.id]);
      if (u.rowCount) await queueNotification(tx, { phone: w.phone, channel: 'sms', purpose: 'transactional', template: 'waitlist.back_in_stock', locale: 'uz-Latn', params: { product: w.name, path: `/p/${w.slug}` }, dedupeKey: `waitlist:${w.id}` });
    });
  }
  const due = await db.query(`SELECT id, remind_phone FROM partner_offers WHERE status='thinking' AND remind_phone IS NOT NULL AND remind_at <= now() AND expires_at > now() LIMIT 200`);
  for (const f of due.rows) {
    await withTx(db, async (tx) => {
      const u = await tx.query(`UPDATE partner_offers SET remind_at=NULL WHERE id=$1 AND remind_at IS NOT NULL RETURNING id`, [f.id]);
      if (u.rowCount) await queueNotification(tx, { phone: f.remind_phone, channel: 'sms', purpose: 'transactional', template: 'offer.reminder', locale: 'uz-Latn', params: {}, dedupeKey: `offer-remind:${f.id}` });
    });
  }
}
