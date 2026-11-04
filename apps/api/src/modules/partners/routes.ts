import { maskPhone, normalizeUzPhone } from '@om/shared';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, hashToken, requirePerm, requireStepUp, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { idempotent } from '../../platform/idempotency.js';
import { type Deps, requireIdempotencyKey, route, zIdParam } from '../../platform/http.js';
import { getPolicy, POLICY } from '../../platform/policies.js';
import { zContact, zDeliveryAddress } from '../checkout/routes.js';
import type { AppConfig } from '../../config.js';
import { accrueForOrder, rebuildBalances, recalcOrder, releaseMatured, transfer } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { queueNotification } from '../notifications/service.js';
import { notifyPartner } from '../notifications/telegram.js';
import { cancelOrder, confirmOrder, createOrder, m, priceLines, pricedToJson, storeQuote } from '../orders/service.js';
import { isBotUserAgent, visitorHash } from './attribution.js';
import { applyAmendment, rejectAmendment } from '../orders/amendments.js';

/** The partner is always derived from the authenticated user — never from payload (§12, T039). */
export async function myPartner(tx: { query: Tx['query'] }, actor: Actor, requireActive = true) {
  requireUser(actor);
  const p = await maybeOne<{ id: string; status: string; code: string; display_name: string; user_id: string; payout_destination: unknown; payout_destination_verified_at: string | null }>(tx as Tx, `SELECT * FROM partners WHERE user_id=$1`, [actor.userId]);
  if (!p) throw notFound('PARTNER');
  if (requireActive && p.status !== 'active') throw new AppError(403, 'PARTNER_NOT_ACTIVE');
  return p;
}


/**
 * Shared partner-assisted order creation (manual form, draft submit, customer fill link): order awaits the customer's own
 * confirmation; a one-time code + link goes to the customer's phone only (never to the partner, T043/T11).
 */
export async function createAssistedOrder(tx: Tx, cfg: AppConfig, actor: Actor, p: { id: string; user_id: string }, o: { quoteId: string; quoteHash: string; note: string; placementId?: string | null; rootLinkId?: string | null }) {
        const q = await maybeOne<{ created_by_user_id: string; contact_snapshot: { phone: string }; cart_id: string | null }>(tx, `SELECT created_by_user_id, contact_snapshot, cart_id FROM checkout_quotes WHERE id=$1`, [o.quoteId]);
  if (!q || q.created_by_user_id !== p.user_id || q.cart_id !== null) throw notFound('QUOTE');
  const phone = q.contact_snapshot.phone;
  const customer = await maybeOne<{ id: string }>(tx, `SELECT id FROM users WHERE phone_e164=$1 AND status <> 'closed'`, [phone]);
  if (customer?.id === p.user_id) throw unprocessable('SELF_ORDER_NOT_ALLOWED');
  // The partner may name the campaign the customer came from; only their own placements/links are accepted (never trusted from the client).
  const pl = o.placementId ? await maybeOne<{ id: string; root_link_id: string; channel: string }>(tx, `SELECT id, root_link_id, channel FROM campaign_placements WHERE id=$1 AND partner_id=$2`, [o.placementId, p.id]) : null;
  if (o.placementId && !pl) throw notFound('PLACEMENT');
  const rootLink = !pl && o.rootLinkId ? await maybeOne<{ id: string }>(tx, `SELECT id FROM referral_links WHERE id=$1 AND partner_id=$2`, [o.rootLinkId, p.id]) : null;
  const order = await createOrder(tx, cfg, actor, {
    quoteId: o.quoteId, quoteHash: o.quoteHash, paymentMethod: 'cod', channel: 'partner_assisted', customerUserId: customer?.id ?? null, customerPhone: phone,
    createdBy: p.user_id, confirmation: 'pending', acceptedTerms: true,
    attribution: { partner_id: p.id, campaign_id: null, touch_id: null, link_id: pl?.root_link_id ?? rootLink?.id ?? null, rule_version: 0, reason: 'partner_assisted', attributed_at: new Date().toISOString(), eligible: true,
      placement_id: pl?.id ?? null, source_channel: (pl?.channel as never) ?? 'unknown' },
  });
  // Duplicate signal (T046/T047): same phone + same SKU in last 48h. Operator decides; nothing is auto-cancelled and nothing is revealed to the partner.
  const dup = await maybeOne(tx, `SELECT 1 FROM orders o2 JOIN order_lines l2 ON l2.order_id=o2.id
      WHERE o2.customer_phone=$1 AND o2.id<>$2 AND o2.commercial_status<>'cancelled' AND o2.created_at > now() - interval '48 hours'
        AND l2.sku_id IN (SELECT sku_id FROM order_lines WHERE order_id=$2) LIMIT 1`, [phone, order.id]);
  if (dup) await tx.query(`UPDATE orders SET duplicate_signal=true WHERE id=$1`, [order.id]);
  await tx.query(`INSERT INTO order_notes (order_id, author_id, body, internal) VALUES ($1,$2,$3,true)`, [order.id, p.user_id, `Partner note: ${o.note}`]);
  // One-time, short-lived confirmation link + code to the customer's phone. Never shown to the partner (T043).
  const ttl = (await getPolicy<{ hours: number }>(tx, POLICY.partnerConfirmTtlHours, cfg.env))?.value.hours ?? 24;
  const conf = await one<{ id: string }>(tx, `INSERT INTO order_confirmations (order_id, method, status, expires_at, shown_total_minor, shown_quote_hash)
      SELECT $1,'customer_otp','pending', now() + make_interval(hours => $2), payable_minor, $3 FROM orders WHERE id=$1 RETURNING id`, [order.id, ttl, o.quoteHash]);
  const token = randomBytes(24).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx.query(`UPDATE order_confirmations SET token_hash=$2, code_hash=$3 WHERE id=$1`, [conf.id, hashToken(token), codeHash(conf.id, code)]);
  await queueNotification(tx, { phone, channel: 'sms', purpose: 'transactional', template: 'partner_order_confirm', locale: 'uz-Latn', params: { link: `${cfg.publicWebUrl}/confirm/${token}`, code_ref: conf.id, order_number: order.number }, dedupeKey: `confirm:${conf.id}` });
  const devEcho = cfg.env !== 'production' && cfg.otp.devEcho ? { dev_customer_link_token: token, dev_customer_code: code } : {};
  return { order_id: order.id, number: order.number, status: 'awaiting_customer_confirmation', customer_phone_masked: maskPhone(phone), ...devEcho };
}

const codeHash = (id: string, code: string) => createHash('sha256').update(`confirm:${id}:${code}`).digest();

export function registerPartners(app: FastifyInstance, deps: Deps): void {
  const T = ['partner'];

  route(app, deps, { method: 'POST', url: '/partner/apply', tags: T, summary: 'Apply as partner (accept agreement)', body: z.object({ display_name: z.string().min(2).max(80), channels: z.string().max(500).optional(), accept_agreement: z.literal(true) }) },
    async ({ actor, db, cfg, body }) => {
      requireUser(actor);
      return withTx(db, async (tx) => {
        const doc = await maybeOne<{ id: string }>(tx, `SELECT id FROM legal_document_versions WHERE doc_type='partner' ORDER BY version DESC LIMIT 1`);
        if (!doc) throw unprocessable('PARTNER_AGREEMENT_NOT_PUBLISHED');
        const acc = await one<{ id: string }>(tx, `INSERT INTO acceptances (user_id, legal_document_version_id, context) VALUES ($1,$2,'partner_signup') RETURNING id`, [actor.userId, doc.id]);
        const code = Array.from({ length: 7 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(0, 32)]).join('');
        const p = await one(tx, `INSERT INTO partners (user_id, code, display_name, status, agreement_acceptance_id, channels) VALUES ($1,$2,$3,'pending',$4,$5) RETURNING id, code, status`,
          [actor.userId, code, body.display_name, acc.id, body.channels ?? null]).catch((e) => { if (e.code === '23505') throw conflict('ALREADY_APPLIED'); throw e; });
        await audit(tx, actor, 'partner.applied', { type: 'partner', id: (p as { id: string }).id });
        void cfg;
        return p;
      });
    });

  route(app, deps, { method: 'GET', url: '/partner/me', tags: T, summary: 'Partner profile + balances' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const bal = await maybeOne(db, `SELECT estimated_minor::text, pending_minor::text, available_minor::text, reserved_minor::text, paid_minor::text, debt_minor::text FROM partner_balances WHERE partner_id=$1`, [p.id]);
    const dest = p.payout_destination as { type?: string; masked?: string } | null;
    return { id: p.id, code: p.code, display_name: p.display_name, status: p.status, balances: bal ?? { estimated_minor: '0', pending_minor: '0', available_minor: '0', reserved_minor: '0', paid_minor: '0', debt_minor: '0' },
      payout_destination: dest ? { type: dest.type, masked: dest.masked, verified: !!p.payout_destination_verified_at } : null };
  });

  route(app, deps, { method: 'GET', url: '/partner/products', tags: T, summary: 'Products available for promotion with own commission terms' }, async ({ actor, db }) => {
    await myPartner(db, actor);
    return { items: await many(db, `
      SELECT p.id, p.slug, p.name, (SELECT MIN(o.price_minor)::text FROM skus s JOIN offers o ON o.sku_id=s.id WHERE s.product_id=p.id AND s.status='active' AND o.status='active') AS min_price_minor,
             (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
             (SELECT json_build_object('kind', kind, 'rate_bps', rate_bps, 'fixed_minor', fixed_minor::text) FROM commission_rules cr WHERE cr.product_id=p.id AND cr.effective_from <= now() AND (cr.effective_to IS NULL OR cr.effective_to > now()) ORDER BY version DESC LIMIT 1) AS commission
        FROM products p WHERE p.status='published' ORDER BY p.published_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/partner/campaigns', tags: T, summary: 'Create campaign (name + UTM)', body: z.object({ name: z.string().min(1).max(80), utm_source: z.string().max(60).optional(), utm_medium: z.string().max(60).optional(), utm_campaign: z.string().max(60).optional() }) },
    async ({ actor, db, body }) => {
      const p = await myPartner(db, actor);
      return one(db, `INSERT INTO partner_campaigns (partner_id, name, utm_source, utm_medium, utm_campaign) VALUES ($1,$2,$3,$4,$5) RETURNING id, name`, [p.id, body.name, body.utm_source ?? null, body.utm_medium ?? null, body.utm_campaign ?? null]);
    });

  route(app, deps, { method: 'POST', url: '/partner/links', tags: T, summary: 'Create referral link (no PII/secret in URL)', body: z.object({ product_id: z.string().uuid().optional(), campaign_id: z.string().uuid().optional() }) },
    async ({ actor, db, cfg, body }) => {
      const p = await myPartner(db, actor);
      if (body.campaign_id && !(await maybeOne(db, `SELECT 1 FROM partner_campaigns WHERE id=$1 AND partner_id=$2`, [body.campaign_id, p.id]))) throw notFound('CAMPAIGN');
      let slug: string | null = null;
      if (body.product_id) {
        const pr = await maybeOne<{ slug: string }>(db, `SELECT slug FROM products WHERE id=$1 AND status='published'`, [body.product_id]);
        if (!pr) throw notFound('PRODUCT');
        slug = pr.slug;
      }
      const code = randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12);
      const l = await one<{ id: string }>(db, `INSERT INTO referral_links (partner_id, campaign_id, product_id, code) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, body.campaign_id ?? null, body.product_id ?? null, code]);
      return { id: l.id, code, url: `${cfg.publicWebUrl}/r/${code}${slug ? `?to=${encodeURIComponent('/p/' + slug)}` : ''}` };
    });

  route(app, deps, { method: 'GET', url: '/partner/links', tags: T, summary: 'My links with click/order stats' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `
      SELECT l.id, l.code, l.status, l.created_at, pr.slug, pr.name AS product_name, c.name AS campaign,
             (SELECT COUNT(*)::int FROM referral_touches t WHERE t.link_id=l.id AND t.eligible) AS clicks,
             (SELECT COUNT(*)::int FROM orders o WHERE o.attribution->>'link_id' = l.id::text AND o.attributed_partner_id=$1) AS orders
        FROM referral_links l LEFT JOIN products pr ON pr.id=l.product_id LEFT JOIN partner_campaigns c ON c.id=l.campaign_id WHERE l.partner_id=$1 ORDER BY l.created_at DESC`, [p.id]) };
  });

  // Public: record a referral touch. Bots/link previews are stored as ineligible (T037).
  route(app, deps, { method: 'POST', url: '/referrals/touch', tags: ['referral'], summary: 'Record referral click (needs X-Guest-Token)', body: z.object({ code: z.string().min(8).max(16) }) },
    async ({ actor, db, req, body }) => {
      if (!actor.guestToken) throw badRequest('GUEST_TOKEN_REQUIRED');
      // A placement code (one per Telegram post / Instagram campaign) resolves to its root link and is recorded on the touch.
      const plc = await maybeOne<{ id: string; root_link_id: string; status: string }>(db, `SELECT id, root_link_id, status FROM campaign_placements WHERE code=$1`, [body.code]);
      const l = await maybeOne<{ id: string; partner_id: string; status: string; pstatus: string; cstatus: string | null; slug: string | null }>(db,
        `SELECT l.id, l.partner_id, l.status, p.status AS pstatus, c.status AS cstatus, pr.slug FROM referral_links l JOIN partners p ON p.id=l.partner_id LEFT JOIN partner_campaigns c ON c.id=l.campaign_id LEFT JOIN products pr ON pr.id=l.product_id WHERE ${plc ? 'l.id=$1' : 'l.code=$1'}`, [plc ? plc.root_link_id : body.code]);
      // Invalid codes do not break browsing (T035): just no attribution.
      if (!l) return { ok: true, attributed: false, redirect: '/' };
      const bot = isBotUserAgent(req.headers['user-agent']);
      const reason = bot ? 'bot_or_preview' : l.status !== 'active' ? 'link_disabled' : l.pstatus !== 'active' ? `partner_${l.pstatus}` : l.cstatus && l.cstatus !== 'active' ? 'campaign_disabled' : plc && plc.status !== 'active' ? 'placement_archived' : null;
      await db.query(`INSERT INTO referral_touches (link_id, partner_id, visitor_hash, user_id, is_bot, eligible, ineligible_reason, placement_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [l.id, l.partner_id, visitorHash(actor.guestToken), actor.userId, bot, reason === null, reason, plc?.id ?? null]);
      return { ok: true, attributed: reason === null, redirect: l.slug ? `/p/${l.slug}` : '/' };
    });

  // ---------- Partner-assisted order (§12) ----------
  route(app, deps, {
    method: 'POST', url: '/partner/orders/quote', tags: T, summary: 'Quote for an order on behalf of a customer',
    body: z.object({ lines: z.array(z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(99) })).min(1).max(30), delivery_zone_id: z.string().uuid(), address: zDeliveryAddress, contact: zContact }),
  }, async ({ actor, db, cfg, body }) => {
    const p = await myPartner(db, actor);
    const phone = normalizeUzPhone(body.contact.phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.contact.phone': 'validation.phone' });
    return withTx(db, async (tx) => {
      const priced = await priceLines(tx, { lines: body.lines, delivery_zone_id: body.delivery_zone_id });
      const q = await storeQuote(tx, priced, { cartId: null, userId: null, createdBy: actor.userId, address: body.address, contact: { ...body.contact, phone }, ttlMinutes: cfg.quoteTtlMinutes });
      void p;
      return { quote_id: q.id, expires_at: q.expires_at, ...pricedToJson(priced) };
    });
  });

  route(app, deps, {
    method: 'POST', url: '/partner/orders', tags: T, summary: 'Create order for customer → awaits customer confirmation (Idempotency-Key)',
    body: z.object({ quote_id: z.string().uuid(), quote_hash: z.string().length(64), payment_method: z.literal('cod'), customer_agreement_note: z.string().min(3).max(500) }),
  }, async ({ actor, db, cfg, body, idempotencyKey, reply }) => {
    const key = requireIdempotencyKey(idempotencyKey);
    const res = await withTx(db, async (tx) => {
      const p = await myPartner(tx, actor);
      return idempotent(tx, `partner_order:${p.id}`, key, body, async () => {
        const r = await createAssistedOrder(tx, cfg, actor, p, { quoteId: body.quote_id, quoteHash: body.quote_hash, note: body.customer_agreement_note });
        return { status: 201, body: r };
      });
    });
    reply.status(res.replayed ? 200 : res.status);
    return res.body;
  });

  // Customer-facing confirmation page data (link token only; shows items, qty, prices, delivery, shop name).
  route(app, deps, { method: 'GET', url: '/confirm/:token', tags: ['customer-confirmation'], summary: 'Order shown to the customer for confirmation', params: z.object({ token: z.string().min(20).max(80) }) },
    async ({ db, params }) => {
      const c = await maybeOne<{ order_id: string; status: string; expires_at: string }>(db, `SELECT order_id, status, expires_at FROM order_confirmations WHERE token_hash=$1 AND method='customer_otp'`, [hashToken(params.token)]);
      if (!c || c.status !== 'pending' || new Date(c.expires_at) < new Date()) throw notFound('CONFIRMATION');
      const am = await maybeOne<{ new_quote_id: string }>(db, `SELECT a.new_quote_id FROM order_amendments a JOIN order_confirmations oc ON oc.id=a.confirmation_id WHERE oc.token_hash=$1 AND a.status='awaiting_customer'`, [hashToken(params.token)]);
      const o = am
        ? await one(db, `SELECT o.number, q.payable_minor::text, q.subtotal_minor::text, q.delivery_minor::text, (q.cart_discount_minor + q.delivery_discount_minor)::text AS discount_minor, o.address_snapshot, o.payment_method, true AS is_amendment FROM orders o JOIN checkout_quotes q ON q.id=$2 WHERE o.id=$1`, [c.order_id, am.new_quote_id])
        : await one(db, `SELECT number, payable_minor::text, subtotal_minor::text, delivery_minor::text, discount_minor::text, address_snapshot, payment_method FROM orders WHERE id=$1`, [c.order_id]);
      const lines = am
        ? await many(db, `SELECT product_snapshot, qty, unit_price_minor::text, line_net_minor::text FROM quote_lines WHERE quote_id=$1`, [am.new_quote_id])
        : await many(db, `SELECT product_snapshot, qty, unit_price_minor::text, line_net_minor::text FROM order_lines WHERE order_id=$1 AND canceled_qty < qty`, [c.order_id]);
      const shop = await maybeOne<{ name: string }>(db, `SELECT name FROM organizations WHERE kind='platform_owner'`);
      return { shop_name: shop?.name, order: o, lines };
    });

  route(app, deps, { method: 'POST', url: '/confirm/:token', tags: ['customer-confirmation'], summary: 'Customer confirms or rejects with the SMS code', params: z.object({ token: z.string().min(20).max(80) }), body: z.object({ decision: z.enum(['confirm', 'reject']), code: z.string().regex(/^\d{6}$/) }) },
    async ({ db, cfg, actor, params, body }) => {
      const c = await withTx(db, (tx) => maybeOne<{ id: string; order_id: string; code_hash: Buffer }>(tx,
        `UPDATE order_confirmations SET attempts=attempts+1 WHERE token_hash=$1 AND method='customer_otp' AND status='pending' AND consumed_at IS NULL AND expires_at > now() AND attempts < max_attempts RETURNING id, order_id, code_hash`, [hashToken(params.token)]));
      if (!c || !timingSafeEqual(c.code_hash, codeHash(c.id, body.code))) throw new AppError(400, 'CONFIRMATION_INVALID_OR_EXPIRED');
      return withTx(db, async (tx) => {
        const used = await tx.query(`UPDATE order_confirmations SET consumed_at=now(), status=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING id`, [c.id, body.decision === 'confirm' ? 'verified' : 'rejected']);
        if (!used.rowCount) throw new AppError(400, 'CONFIRMATION_INVALID_OR_EXPIRED');
        const sys: Actor = { ...actor, kind: 'anonymous' };
        const am = await maybeOne<{ id: string }>(tx, `SELECT id FROM order_amendments WHERE confirmation_id=$1 AND status='awaiting_customer'`, [c.id]);
        if (am) {
          if (body.decision === 'confirm') await applyAmendment(tx, cfg, sys, am.id);
          else await rejectAmendment(tx, sys, am.id);
        } else if (body.decision === 'confirm') await confirmOrder(tx, cfg, sys, c.order_id, 'customer_otp', { confirmation_id: c.id });
        else await cancelOrder(tx, sys, c.order_id, 'customer_rejected_confirmation', true);
        // Confirming an order grants no account access: no session is issued here (T043).
        return { ok: true, decision: body.decision };
      });
    });

  // ---------- Partner's own orders & commissions (masked customer data, §11/§20) ----------
  route(app, deps, { method: 'GET', url: '/partner/orders', tags: T, summary: 'My attributed orders (masked)' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `
      SELECT o.id, 'OM-***' || right(o.number, 3) AS masked_number, o.channel, o.commercial_status, o.confirmation_status, o.fulfillment_status, o.created_at,
             (SELECT json_agg(json_build_object('product', ol.product_snapshot->'name', 'qty', ol.qty, 'returned', ol.returned_qty)) FROM order_lines ol WHERE ol.order_id=o.id) AS items,
             (SELECT COALESCE(SUM(a.target_minor),0)::text FROM commission_accruals a WHERE a.order_id=o.id) AS commission_minor,
             (SELECT string_agg(DISTINCT a.state, ',') FROM commission_accruals a WHERE a.order_id=o.id) AS commission_state
        FROM orders o WHERE o.attributed_partner_id=$1 ORDER BY o.created_at DESC LIMIT 200`, [p.id]) };
  });

  route(app, deps, { method: 'GET', url: '/partner/orders/:id', tags: T, summary: 'My order detail (own only)', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const o = await maybeOne(db, `SELECT o.id, 'OM-***' || right(o.number, 3) AS masked_number, o.commercial_status, o.confirmation_status, o.fulfillment_status, o.payment_status, o.created_at, o.attribution->>'reason' AS attribution_reason
        FROM orders o WHERE o.id=$1 AND o.attributed_partner_id=$2`, [params.id, p.id]);
    if (!o) throw notFound('ORDER'); // T004
    const accruals = await many(db, `SELECT a.id, a.state, a.target_minor::text, a.rule_snapshot, a.available_after, ol.product_snapshot->'name' AS product, ol.qty, ol.returned_qty FROM commission_accruals a JOIN order_lines ol ON ol.id=a.order_line_id WHERE a.order_id=$1`, [params.id]);
    const entries = await many(db, `SELECT from_bucket, to_bucket, amount_minor::text, reason, created_at FROM partner_ledger WHERE partner_id=$1 AND source_type='accrual' AND source_id IN (SELECT id::text FROM commission_accruals WHERE order_id=$2) ORDER BY id`, [p.id, params.id]);
    return { ...o, accruals, entries };
  });

  route(app, deps, { method: 'GET', url: '/partner/ledger', tags: T, summary: 'My commission & payout history' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `SELECT id, from_bucket, to_bucket, amount_minor::text, source_type, reason, created_at FROM partner_ledger WHERE partner_id=$1 ORDER BY id DESC LIMIT 500`, [p.id]) };
  });

  route(app, deps, { method: 'PUT', url: '/partner/payout-destination', tags: T, summary: 'Set payout destination (requires re-verification)', body: z.object({ type: z.enum(['card', 'bank_account']), holder: z.string().min(3).max(120), number: z.string().regex(/^\d{12,24}$/), bank: z.string().max(80).optional() }) },
    async ({ actor, db, body }) => {
      const p = await myPartner(db, actor, false);
      const masked = body.number.slice(0, 4) + ' **** ' + body.number.slice(-4);
      await db.query(`UPDATE partners SET payout_destination=$2, payout_destination_verified_at=NULL, payout_destination_verified_by=NULL, version=version+1, updated_at=now() WHERE id=$1`,
        [p.id, JSON.stringify({ type: body.type, holder: body.holder, number: body.number, bank: body.bank ?? null, masked })]);
      await audit(db, actor, 'partner.payout_destination_changed', { type: 'partner', id: p.id }, { after: { type: body.type, masked } });
      await queueNotification(db, { userId: actor.userId, channel: 'sms', purpose: 'security', template: 'payout_destination_changed', locale: 'uz-Latn', params: { masked }, dedupeKey: `dest:${p.id}:${Date.now()}` });
      return { ok: true, verified: false };
    });

  route(app, deps, { method: 'POST', url: '/partner/payouts', tags: T, summary: 'Request payout from available (atomic reserve, Idempotency-Key)', body: z.object({ amount_minor: z.string().regex(/^[1-9]\d{0,15}$/) }) },
    async ({ actor, db, cfg, body, idempotencyKey, reply }) => {
      const key = requireIdempotencyKey(idempotencyKey);
      const res = await withTx(db, async (tx) => {
        const p = await myPartner(tx, actor, false);
        if (p.status === 'rejected') throw forbidden();
        return idempotent(tx, `payout:${p.id}`, key, body, async () => {
          if (!p.payout_destination || !p.payout_destination_verified_at) throw unprocessable('PAYOUT_DESTINATION_NOT_VERIFIED');
          const min = await getPolicy<{ amount_minor: string }>(tx, POLICY.payoutMinMinor, cfg.env);
          if (!min) throw unprocessable('PAYOUT_POLICY_NOT_APPROVED');
          const amount = BigInt(body.amount_minor);
          if (amount < BigInt(min.value.amount_minor)) throw unprocessable('PAYOUT_BELOW_MINIMUM', { min_minor: min.value.amount_minor });
          const pr = await one<{ id: string }>(tx, `INSERT INTO payout_requests (partner_id, amount_minor, status, destination_snapshot, idempotency_key) VALUES ($1,$2,'requested',$3,$4) RETURNING id`,
            [p.id, body.amount_minor, JSON.stringify(p.payout_destination), key]);
          // available -> reserved; the CHECK (available >= 0) makes parallel requests unable to double-reserve (T078).
          await tx.query(`INSERT INTO partner_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [p.id]);
          const lock = await one<{ available_minor: string }>(tx, `SELECT available_minor FROM partner_balances WHERE partner_id=$1 FOR UPDATE`, [p.id]);
          if (BigInt(lock.available_minor) < amount) throw conflict('INSUFFICIENT_AVAILABLE', { available_minor: lock.available_minor });
          await transfer(tx, { partnerId: p.id, from: 'available', to: 'reserved', amount, sourceType: 'payout', sourceId: pr.id, effectKey: 'reserve', actorId: actor.userId });
          await audit(tx, actor, 'payout.requested', { type: 'payout', id: pr.id }, { after: { amount_minor: body.amount_minor } });
          return { status: 201, body: { payout_id: pr.id, status: 'requested' } };
        });
      });
      reply.status(res.replayed ? 200 : res.status);
      return res.body;
    });

  route(app, deps, { method: 'GET', url: '/partner/payouts', tags: T, summary: 'My payouts' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    return { items: await many(db, `SELECT id, amount_minor::text, status, destination_snapshot->>'masked' AS destination, paid_reference, reject_reason, created_at, updated_at FROM payout_requests WHERE partner_id=$1 ORDER BY created_at DESC`, [p.id]) };
  });

  route(app, deps, { method: 'POST', url: '/partner/disputes', tags: T, summary: 'Open commission dispute', body: z.object({ order_id: z.string().uuid().optional(), subject: z.string().min(3).max(120), body: z.string().min(3).max(4000) }) },
    async ({ actor, db, body }) => {
      const p = await myPartner(db, actor, false);
      if (body.order_id && !(await maybeOne(db, `SELECT 1 FROM orders WHERE id=$1 AND attributed_partner_id=$2`, [body.order_id, p.id]))) throw notFound('ORDER');
      return one(db, `INSERT INTO partner_disputes (partner_id, order_id, subject, body) VALUES ($1,$2,$3,$4) RETURNING id, status`, [p.id, body.order_id ?? null, body.subject, body.body]);
    });

  // ---------- Admin: partners, payouts, attribution corrections ----------
  route(app, deps, { method: 'GET', url: '/admin/partners', tags: ['admin'], summary: 'Partners' }, async ({ actor, db }) => {
    requirePerm(actor, 'partners.manage');
    return { items: await many(db, `SELECT p.id, p.code, p.display_name, p.status, p.status_reason, p.created_at, p.payout_destination->>'masked' AS destination, p.payout_destination_verified_at, b.available_minor::text, b.pending_minor::text, b.debt_minor::text
        FROM partners p LEFT JOIN partner_balances b ON b.partner_id=p.id ORDER BY p.created_at DESC`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/partners/:id/status', tags: ['admin'], summary: 'Approve / suspend / reject (history kept)', params: zIdParam, body: z.object({ status: z.enum(['active', 'suspended', 'rejected']), reason: z.string().min(3).max(300) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'partners.manage'); requireStepUp(actor);
      return withTx(db, async (tx) => {
        const p = await maybeOne<{ status: string; user_id: string }>(tx, `SELECT status, user_id FROM partners WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!p) throw notFound('PARTNER');
        await tx.query(`UPDATE partners SET status=$2, status_reason=$3, version=version+1, updated_at=now() WHERE id=$1`, [params.id, body.status, body.reason]);
        if (body.status === 'active') await tx.query(`INSERT INTO memberships (user_id, role_code, granted_by) VALUES ($1,'partner',$2) ON CONFLICT DO NOTHING`, [p.user_id, actor.userId]);
        // Suspension stops new referrals/orders but never deletes earned history (T008).
        await audit(tx, actor, 'partner.status', { type: 'partner', id: params.id }, { before: { status: p.status }, after: { status: body.status }, reason: body.reason });
        return { ok: true };
      });
    });

  route(app, deps, { method: 'POST', url: '/admin/partners/:id/verify-destination', tags: ['admin'], summary: 'Verify payout destination', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'payouts.approve'); requireStepUp(actor);
    const r = await db.query(`UPDATE partners SET payout_destination_verified_at=now(), payout_destination_verified_by=$2 WHERE id=$1 AND payout_destination IS NOT NULL RETURNING id`, [params.id, actor.userId]);
    if (!r.rowCount) throw notFound('PARTNER');
    await audit(db, actor, 'partner.destination_verified', { type: 'partner', id: params.id });
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/admin/payouts', tags: ['admin'], summary: 'Payout queue' }, async ({ actor, db }) => {
    requirePerm(actor, 'payouts.prepare');
    return { items: await many(db, `SELECT r.*, r.amount_minor::text AS amount_minor, p.display_name, p.code FROM payout_requests r JOIN partners p ON p.id=r.partner_id ORDER BY r.created_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/payouts/:id/prepare', tags: ['admin'], summary: 'Finance prepares payout', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'payouts.prepare');
    const r = await db.query(`UPDATE payout_requests SET prepared_by=$2, version=version+1, updated_at=now() WHERE id=$1 AND status='requested' AND prepared_by IS NULL RETURNING id`, [params.id, actor.userId]);
    if (!r.rowCount) throw conflict('PAYOUT_NOT_PREPARABLE');
    await audit(db, actor, 'payout.prepared', { type: 'payout', id: params.id });
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/admin/payouts/:id/approve', tags: ['admin'], summary: 'Approve (maker != checker unless approved owner_only mode)', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    requirePerm(actor, 'payouts.approve'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const r = await maybeOne<{ status: string; prepared_by: string | null }>(tx, `SELECT status, prepared_by FROM payout_requests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('PAYOUT');
      if (r.status !== 'requested' || !r.prepared_by) throw conflict('PAYOUT_NOT_APPROVABLE');
      let mode: 'two_person' | 'owner_only' = 'two_person';
      if (r.prepared_by === actor.userId) {
        const pol = await getPolicy<{ mode: string }>(tx, POLICY.payoutApprovalMode, cfg.env);
        const isOwner = actor.grants.some((g) => g.role === 'owner');
        // No fake second person: self-approval only in an explicit, audited owner_only mode (§20, T006/AC-M41-2).
        if (pol?.value.mode !== 'owner_only' || !isOwner) throw new AppError(403, 'MAKER_CANNOT_APPROVE');
        mode = 'owner_only';
      }
      await tx.query(`UPDATE payout_requests SET status='approved', approved_by=$2, approval_mode=$3, version=version+1, updated_at=now() WHERE id=$1`, [params.id, actor.userId, mode]);
      await audit(tx, actor, 'payout.approved', { type: 'payout', id: params.id }, { after: { approval_mode: mode } });
      return { ok: true, approval_mode: mode };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/payouts/:id/result', tags: ['admin'], summary: 'Record manual bank transfer result (paid with reference | rejected | unknown)', params: zIdParam,
    body: z.object({ outcome: z.enum(['paid', 'rejected', 'processing_unknown']), reference: z.string().min(3).max(120).optional(), evidence: z.string().max(500).optional(), reason: z.string().max(300).optional() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'payouts.approve'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const r = await maybeOne<{ status: string; partner_id: string; amount_minor: string; approved_by: string | null }>(tx, `SELECT status, partner_id, amount_minor, approved_by FROM payout_requests WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!r) throw notFound('PAYOUT');
      if (r.status === body.outcome) return { ok: true, noop: true };
      if (!['approved', 'processing_unknown'].includes(r.status)) throw conflict('PAYOUT_INVALID_TRANSITION');
      const amount = BigInt(r.amount_minor);
      if (body.outcome === 'paid') {
        if (!body.reference) throw badRequest('PAYOUT_REFERENCE_REQUIRED');
        await transfer(tx, { partnerId: r.partner_id, from: 'reserved', to: 'paid', amount, sourceType: 'payout', sourceId: params.id, effectKey: 'paid', actorId: actor.userId });
        await postJournal(tx, `payout_paid:${params.id}`, 'payout_paid', [{ account: 'partner_payable', debit: amount }, { account: 'cash_bank', credit: amount }]);
        await tx.query(`UPDATE payout_requests SET status='paid', paid_reference=$2, paid_evidence=$3, version=version+1, updated_at=now() WHERE id=$1`, [params.id, body.reference, body.evidence ?? null]);
        const dest = await maybeOne<{ masked: string | null }>(tx, `SELECT payout_destination->>'masked' AS masked FROM partners WHERE id=$1`, [r.partner_id]);
        await notifyPartner(tx, r.partner_id, 'partner.payout_paid', { amount_minor: r.amount_minor, destination: dest?.masked ?? null }, `p:paid:${params.id}`);
      } else if (body.outcome === 'rejected') {
        await transfer(tx, { partnerId: r.partner_id, from: 'reserved', to: 'available', amount, sourceType: 'payout', sourceId: params.id, effectKey: 'release', actorId: actor.userId, reason: body.reason });
        await tx.query(`UPDATE payout_requests SET status='rejected', reject_reason=$2, version=version+1, updated_at=now() WHERE id=$1`, [params.id, body.reason ?? null]);
      } else {
        // Unknown bank outcome: reserve stays, no second transfer allowed (T079).
        await tx.query(`UPDATE payout_requests SET status='processing_unknown', version=version+1, updated_at=now() WHERE id=$1`, [params.id]);
        await tx.query(`INSERT INTO finance_exceptions (kind, ref_type, ref_id, amount_minor) VALUES ('payout_unknown','payout',$1,$2) ON CONFLICT DO NOTHING`, [params.id, r.amount_minor]);
      }
      await audit(tx, actor, `payout.${body.outcome}`, { type: 'payout', id: params.id }, { after: { reference: body.reference }, reason: body.reason });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/orders/:id/attribution', tags: ['admin'], summary: 'Attribution correction with reason+evidence (old record kept)', params: zIdParam,
    body: z.object({ new_partner_id: z.string().uuid().nullable(), reason: z.string().min(5).max(500), evidence: z.string().min(5).max(2000) }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'partners.manage'); requireStepUp(actor);
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ attributed_partner_id: string | null }>(tx, `SELECT attributed_partner_id FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      await tx.query(`INSERT INTO attribution_corrections (order_id, old_partner_id, new_partner_id, reason, evidence, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [params.id, o.attributed_partner_id, body.new_partner_id, body.reason, body.evidence, actor.userId]);
      // Old accruals go to zero (journaled reversal); new partner gets fresh accruals — never two partners for one sale (T040).
      const accs = await many<{ id: string; partner_id: string; state: string; target_minor: string; version: number }>(tx, `SELECT * FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded' FOR UPDATE`, [params.id]);
      if (accs.some((a) => a.state === 'available')) throw conflict('ATTRIBUTION_CORRECTION_AFTER_AVAILABLE_REQUIRES_DISPUTE_FLOW');
      for (const a of accs) {
        const bucket = a.state === 'pending' ? 'pending' : 'estimated';
        await transfer(tx, { partnerId: a.partner_id, from: bucket, to: 'external', amount: BigInt(a.target_minor), sourceType: 'accrual', sourceId: a.id, effectKey: `v${a.version + 1}:correction`, reason: 'attribution_correction', actorId: actor.userId });
        await tx.query(`UPDATE commission_accruals SET target_minor=0, state='superseded', version=version+1 WHERE id=$1`, [a.id]);
      }
      await tx.query(`UPDATE orders SET attributed_partner_id=$2::uuid, attribution = COALESCE(attribution,'{}'::jsonb) || jsonb_build_object('corrected', true, 'corrected_partner_id', $2::uuid), version=version+1 WHERE id=$1`, [params.id, body.new_partner_id]);
      if (body.new_partner_id) {
        const np = await maybeOne<{ status: string }>(tx, `SELECT status FROM partners WHERE id=$1`, [body.new_partner_id]);
        if (!np) throw notFound('PARTNER');
        await accrueForOrder(tx, params.id, body.new_partner_id);
      }
      await audit(tx, actor, 'attribution.corrected', { type: 'order', id: params.id }, { before: { partner_id: o.attributed_partner_id }, after: { partner_id: body.new_partner_id }, reason: body.reason });
      return { ok: true };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/commissions/release', tags: ['admin'], summary: 'Run hold-maturity release (also run by scheduler)', body: z.object({ as_of: z.string().datetime().optional() }) },
    async ({ actor, db, cfg, body }) => {
      requirePerm(actor, 'payouts.prepare');
      const asOf = body.as_of && cfg.env !== 'production' ? new Date(body.as_of) : new Date();
      const n = await withTx(db, (tx) => releaseMatured(tx, asOf));
      return { released: n };
    });

  route(app, deps, { method: 'GET', url: '/admin/partners/:id/ledger-check', tags: ['admin'], summary: 'Projection vs journal rebuild', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'payments.read');
    const rebuilt = await rebuildBalances(db, params.id);
    const proj = await maybeOne<Record<string, string>>(db, `SELECT estimated_minor::text AS estimated, pending_minor::text AS pending, available_minor::text AS available, reserved_minor::text AS reserved, paid_minor::text AS paid, debt_minor::text AS debt FROM partner_balances WHERE partner_id=$1`, [params.id]);
    return { rebuilt, projection: proj, match: JSON.stringify(rebuilt) === JSON.stringify(proj ?? rebuilt) };
  });

  void recalcOrder; void m;
}
