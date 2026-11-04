import { normalizeUzPhone } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashToken } from '../../platform/auth.js';
import { many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../platform/errors.js';
import { idempotent } from '../../platform/idempotency.js';
import { customerMessages } from '../opscenter/messages.js';
import { type Deps, requireIdempotencyKey, route, zIdParam } from '../../platform/http.js';
import type { Actor } from '../../platform/auth.js';
import { resolveAttribution } from '../partners/attribution.js';
import { type Attribution, createOrder, m, partnerDiscountForLink, priceLines, pricedToJson, storeQuote } from '../orders/service.js';
import { currentAssignment } from '../landings/experiments.js';
import { captureOrderContext, currentConsent, recordEvent, recordLead, subjectKey, uzs } from '../tracking/service.js';

/** Browser identifiers the real customer's own page supplies (only kept when ad-measurement consent is granted). */
const zTrackingInput = z.object({ fbp: z.string().max(600).optional(), fbc: z.string().max(600).optional(), source_url: z.string().max(2000).optional() }).strict().optional();

/** Discount stream the visitor came through (last eligible click): the shown price is price − the partner's discount. */
async function visitorDiscount(tx: Tx, env: string, actor: Actor) {
  const a = await resolveAttribution(tx, env, { explicitCode: null, guestToken: actor.guestToken, customerUserId: actor.userId }).catch(() => null);
  if (!a?.eligible || !a.link_id) return null;
  return partnerDiscountForLink(tx, a.link_id);
}

/** An order priced with a partner's discount always belongs to that discount link — the discount is that partner's money. */
async function attributionForQuote(tx: Tx, quoteId: string, a: Attribution | null): Promise<Attribution | null> {
  const q = await maybeOne<{ link_id: string | null; partner_id: string | null }>(tx,
    `SELECT q.partner_discount_link_id AS link_id, l.partner_id FROM checkout_quotes q LEFT JOIN referral_links l ON l.id=q.partner_discount_link_id WHERE q.id=$1`, [quoteId]);
  if (!q?.link_id || !q.partner_id || (a?.eligible && a.link_id === q.link_id)) return a;
  return { partner_id: q.partner_id, campaign_id: null, touch_id: null, link_id: q.link_id, rule_version: a?.rule_version ?? 0, reason: 'last_eligible_click', attributed_at: new Date().toISOString(), eligible: true, placement_id: null, source_channel: 'unknown' };
}

export const zDeliveryAddress = z.object({
  region_code: z.string().min(2).max(10),
  district: z.string().min(1).max(120),
  street: z.string().min(1).max(200),
  house: z.string().min(1).max(30),
  apartment: z.string().max(30).optional(),
  landmark: z.string().max(300).optional(),
  note: z.string().max(500).optional(),
});
export const zContact = z.object({ name: z.string().min(1).max(120), phone: z.string().min(5).max(32) });

async function findCart(tx: Tx, actor: Actor, create: boolean): Promise<{ id: string } | null> {
  if (actor.userId) {
    const c = await maybeOne<{ id: string }>(tx, `SELECT id FROM carts WHERE user_id=$1 AND status='active'`, [actor.userId]);
    if (c || !create) return c;
    return one(tx, `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) WHERE status='active' AND user_id IS NOT NULL DO UPDATE SET updated_at=now() RETURNING id`, [actor.userId]);
  }
  if (!actor.guestToken) throw badRequest('GUEST_TOKEN_REQUIRED');
  const h = hashToken(actor.guestToken);
  const c = await maybeOne<{ id: string }>(tx, `SELECT id FROM carts WHERE guest_token_hash=$1 AND status='active'`, [h]);
  if (c || !create) return c;
  return one(tx, `INSERT INTO carts (guest_token_hash) VALUES ($1) ON CONFLICT (guest_token_hash) DO UPDATE SET updated_at=now() RETURNING id`, [h]);
}

async function cartView(tx: Tx, cartId: string) {
  const lines = await many(tx, `
    SELECT cl.id, cl.qty, s.id AS sku_id, s.sku_code, s.variant, p.id AS product_id, p.slug, p.name, p.status AS product_status, s.status AS sku_status, o.price_minor::text, o.compare_at_minor::text, o.status AS offer_status,
           GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0)) AS available,
           (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image
      FROM cart_lines cl JOIN offers o ON o.id=cl.offer_id JOIN skus s ON s.id=o.sku_id JOIN products p ON p.id=s.product_id LEFT JOIN stock_balances sb ON sb.sku_id=s.id
     WHERE cl.cart_id=$1 ORDER BY cl.added_at`, [cartId]);
  return {
    id: cartId,
    lines: lines.map((l) => ({
      ...l, price: m(l.price_minor as string), available: Number(l.available),
      purchasable: l.product_status === 'published' && l.sku_status === 'active' && l.offer_status === 'active',
      exceeds_stock: Number(l.qty) > Number(l.available),
    })),
    note: 'cart_prices_are_not_guaranteed_quote_required',
  };
}

export function registerCheckout(app: FastifyInstance, deps: Deps): void {
  const T = ['checkout'];

  route(app, deps, { method: 'GET', url: '/cart', tags: T, summary: 'Current cart (guest via X-Guest-Token or user)' }, async ({ actor, db }) =>
    withTx(db, async (tx) => {
      const c = await findCart(tx, actor, false);
      return c ? cartView(tx, c.id) : { id: null, lines: [] };
    }));

  route(app, deps, { method: 'PUT', url: '/cart/lines', tags: T, summary: 'Set qty for SKU (0 removes)', body: z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(0).max(999) }) }, async ({ actor, db, body }) =>
    withTx(db, async (tx) => {
      const offer = await maybeOne<{ id: string }>(tx, `SELECT o.id FROM offers o JOIN skus s ON s.id=o.sku_id JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND o.merchant_org_id=p.owner_org_id`, [body.sku_id]);
      if (!offer) throw notFound('SKU');
      const c = (await findCart(tx, actor, true))!;
      const prev = (await maybeOne<{ qty: number }>(tx, `SELECT qty FROM cart_lines WHERE cart_id=$1 AND offer_id=$2`, [c.id, offer.id]))?.qty ?? 0;
      if (body.qty === 0) await tx.query(`DELETE FROM cart_lines WHERE cart_id=$1 AND offer_id=$2`, [c.id, offer.id]);
      else await tx.query(`INSERT INTO cart_lines (cart_id, offer_id, qty) VALUES ($1,$2,$3) ON CONFLICT (cart_id, offer_id) DO UPDATE SET qty=EXCLUDED.qty`, [c.id, offer.id, body.qty]);
      const v = await tx.query(`UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, [c.id]);
      // AddToCart only after the cart service accepted the item (same transaction; a failed add records nothing).
      let tracking: { event_id: string; event_name: string | null } | null = null;
      if (body.qty > prev) {
        const subject = subjectKey(actor);
        const consent = await currentConsent(tx, subject);
        if (consent?.status === 'granted') {
          const f = await one<{ product_id: string; price_minor: string }>(tx, `SELECT s.product_id, o.price_minor::text FROM offers o JOIN skus s ON s.id=o.sku_id WHERE o.id=$1`, [offer.id]);
          const e = await recordEvent(tx, { businessKey: `cart.item_added:${c.id}:${v.rows[0].version}`, internalEvent: 'cart.item_added', eventTime: new Date(), actionSource: 'website', subject, consent,
            customData: { content_ids: [f.product_id], content_type: 'product', currency: 'UZS', value: uzs(BigInt(f.price_minor) * BigInt(body.qty - prev)), num_items: body.qty - prev } });
          tracking = { event_id: e.event_id, event_name: e.meta_event };
        }
      }
      return { ...(await cartView(tx, c.id)), tracking };
    }));

  route(app, deps, { method: 'GET', url: '/referral/discount', tags: T, summary: 'Partner discount this visitor gets on a product (from the stream they came through)',
    query: z.object({ product_id: z.string().uuid() }) }, async ({ actor, db, cfg, query }) =>
    withTx(db, async (tx) => {
      const d = await visitorDiscount(tx, cfg.env, actor);
      return d && d.productId === query.product_id ? { unit: m(d.unitMinor), partner_code: d.partnerCode } : { unit: null };
    }));

  route(app, deps, { method: 'GET', url: '/delivery-zones', tags: T, summary: 'Active delivery zones and tariffs' }, async ({ db }) => ({
    items: (await many(db, `SELECT id, region_code, district, name, tariff_minor::text, free_from_minor::text, eta_min_days, eta_max_days, cod_allowed FROM delivery_zones WHERE active ORDER BY region_code, district NULLS FIRST`)),
  }));

  route(app, deps, {
    method: 'POST', url: '/checkout/quotes', tags: T, summary: 'Server quote from current cart (price, delivery, total, expiry)',
    body: z.object({ delivery_zone_id: z.string().uuid(), address: zDeliveryAddress, contact: zContact, promo_code: z.string().max(40).optional() }),
  }, async ({ actor, db, cfg, body }) =>
    withTx(db, async (tx) => {
      const c = await findCart(tx, actor, false);
      if (!c) throw badRequest('CART_EMPTY');
      const phone = normalizeUzPhone(body.contact.phone);
      if (!phone) throw badRequest('PHONE_INVALID', { 'body.contact.phone': 'validation.phone' });
      const lines = await many<{ sku_id: string; qty: number }>(tx, `SELECT o.sku_id, cl.qty FROM cart_lines cl JOIN offers o ON o.id=cl.offer_id WHERE cl.cart_id=$1`, [c.id]);
      const priced = await priceLines(tx, { lines, delivery_zone_id: body.delivery_zone_id, promo_code: body.promo_code, partnerDiscount: await visitorDiscount(tx, cfg.env, actor) });
      const q = await storeQuote(tx, priced, { cartId: c.id, userId: actor.userId, createdBy: actor.userId, address: body.address, contact: { ...body.contact, phone }, ttlMinutes: cfg.quoteTtlMinutes });
      return { quote_id: q.id, expires_at: q.expires_at, ...pricedToJson(priced) };
    }));

  route(app, deps, {
    method: 'POST', url: '/checkout/confirmations', tags: T, summary: 'Place order from quote (Idempotency-Key required)',
    body: z.object({ quote_id: z.string().uuid(), quote_hash: z.string().length(64), payment_method: z.enum(['cod', 'online']), accept_terms: z.literal(true), referral_code: z.string().max(20).optional(), marketing_opt_in: z.boolean().default(false), tracking: zTrackingInput }),
  }, async ({ actor, db, cfg, body, idempotencyKey, reply }) => {
    const key = requireIdempotencyKey(idempotencyKey);
    const scope = `checkout:${actor.userId ?? 'guest:' + (actor.guestToken ?? '')}`;
    const res = await withTx(db, (tx) =>
      idempotent(tx, scope, key, body, async () => {
        const quote = await maybeOne<{ cart_id: string | null; user_id: string | null; contact_snapshot: { phone: string } }>(tx, `SELECT cart_id, user_id, contact_snapshot FROM checkout_quotes WHERE id=$1`, [body.quote_id]);
        if (!quote) throw notFound('QUOTE');
        const own = await findCart(tx, actor, false);
        if (!own || own.id !== quote.cart_id) throw notFound('QUOTE');
        const phone = quote.contact_snapshot.phone;
        // Verified only when the logged-in OTP session phone matches the contact phone (§07).
        let verified = false;
        if (actor.userId) {
          const u = await one<{ phone_e164: string | null }>(tx, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
          verified = u.phone_e164 === phone;
        }
        const attribution = await attributionForQuote(tx, body.quote_id, await resolveAttribution(tx, cfg.env, { explicitCode: body.referral_code ?? null, guestToken: actor.guestToken, customerUserId: actor.userId }));
        const order = await createOrder(tx, cfg, actor, {
          quoteId: body.quote_id, quoteHash: body.quote_hash, paymentMethod: body.payment_method, channel: 'web', customerUserId: actor.userId, customerPhone: phone,
          createdBy: actor.userId, confirmation: verified ? 'checkout_verified_session' : 'pending', attribution, acceptedTerms: body.accept_terms,
        });
        if (own) await tx.query(`UPDATE carts SET status='converted', updated_at=now() WHERE id=$1`, [own.id]);
        if (actor.userId && body.marketing_opt_in) await tx.query(`INSERT INTO consents (user_id, purpose, channel, granted, source) VALUES ($1,'marketing','any',true,'checkout_optional')`, [actor.userId]);
        // Ad measurement (P0C): consent snapshot + Lead in the same transaction; a missing consent/provider never blocks the order.
        await captureOrderContext(tx, actor, order.id, body.tracking, { onBehalf: false });
        const lead = await recordLead(tx, order.id);
        return { status: 201, body: { order_id: order.id, number: order.number, confirmation: verified ? 'verified' : 'pending_operator_call', tracking: lead?.status === 'pending' ? { event_id: lead.event_id, event_name: lead.meta_event } : null } };
      }),
    );
    reply.status(res.replayed ? 200 : res.status);
    return { ...res.body, replayed: res.replayed };
  });

  /**
   * One-step "quick order": name + phone (+ optional region) from the product page. The operator calls the customer,
   * collects the exact address (PATCH /ops/orders/:id/address) and confirms. Same pricing, reservation, attribution
   * and commission paths as the normal checkout; the order always waits for the operator call.
   */
  route(app, deps, {
    method: 'POST', url: '/checkout/quick-order', tags: T, summary: 'One-step order: SKU + name + phone; operator collects address by phone (Idempotency-Key required)',
    body: z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(20).default(1), name: z.string().trim().min(2).max(120), phone: z.string().min(5).max(32),
      delivery_zone_id: z.string().uuid().optional(), accept_terms: z.literal(true), referral_code: z.string().max(20).optional(),
      landing: z.object({ landing_id: z.string().uuid(), revision: z.number().int().min(1) }).optional(), tracking: zTrackingInput }),
  }, async ({ actor, db, cfg, body, idempotencyKey, reply }) => {
    const key = requireIdempotencyKey(idempotencyKey);
    if (!actor.userId && !actor.guestToken) throw badRequest('GUEST_TOKEN_REQUIRED');
    const phone = normalizeUzPhone(body.phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
    const scope = `quick:${actor.userId ?? 'guest:' + (actor.guestToken ?? '')}`;
    const res = await withTx(db, (tx) =>
      idempotent(tx, scope, key, body, async () => {
        // Abuse guard: at most 5 quick orders per phone per hour (operators call every one).
        const recent = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM orders WHERE customer_phone=$1 AND created_at > now() - interval '1 hour' AND address_snapshot->>'quick'='true'`, [phone]);
        if (recent.n >= 5) throw new AppError(429, 'QUICK_ORDER_RATE_LIMIT');
        const zone = body.delivery_zone_id
          ? await maybeOne<{ id: string; region_code: string; district: string | null }>(tx, `SELECT id, region_code, district FROM delivery_zones WHERE id=$1 AND active`, [body.delivery_zone_id])
          : await maybeOne<{ id: string; region_code: string; district: string | null }>(tx, `SELECT id, region_code, district FROM delivery_zones WHERE active ORDER BY region_code='TAS' DESC, district NULLS FIRST LIMIT 1`);
        if (!zone) throw badRequest('DELIVERY_ZONE_INVALID');
        const priced = await priceLines(tx, { lines: [{ sku_id: body.sku_id, qty: body.qty }], delivery_zone_id: zone.id, partnerDiscount: body.referral_code ? null : await visitorDiscount(tx, cfg.env, actor) });
        const address = { region_code: zone.region_code, district: zone.district ?? 'Aniqlanadi', street: 'Operator qo‘ng‘iroqda aniqlaydi', house: '-', quick: true };
        const q = await storeQuote(tx, priced, { cartId: null, userId: actor.userId, createdBy: actor.userId, address, contact: { name: body.name, phone }, ttlMinutes: cfg.quoteTtlMinutes });
        const attribution = await attributionForQuote(tx, q.id, await resolveAttribution(tx, cfg.env, { explicitCode: body.referral_code ?? null, guestToken: actor.guestToken, customerUserId: actor.userId }));
        const order = await createOrder(tx, cfg, actor, {
          quoteId: q.id, quoteHash: priced.hash, paymentMethod: 'cod', channel: 'web', customerUserId: actor.userId, customerPhone: phone,
          createdBy: actor.userId, confirmation: 'pending', attribution, acceptedTerms: body.accept_terms,
        });
        if (body.landing) {
          // the revision must be the published one, or the A/B variant this visitor was actually shown
          const asg = await currentAssignment(tx, body.landing.landing_id, actor);
          const lp = await maybeOne<{ digest: string }>(tx, `SELECT r.digest FROM landing_pages l JOIN landing_revisions r ON r.landing_id=l.id AND r.revision=$2
              WHERE l.id=$1 AND l.status='published' AND (l.published_revision=$2 OR $4::int = $2) AND (SELECT s.product_id FROM skus s WHERE s.id=$3) = ANY(l.product_ids)`, [body.landing.landing_id, body.landing.revision, body.sku_id, asg?.revision ?? null]);
          if (lp) await tx.query(`UPDATE orders SET landing_snapshot=$2, experiment_snapshot=$3 WHERE id=$1`, [order.id, JSON.stringify({ landing_id: body.landing.landing_id, revision: body.landing.revision, digest: lp.digest, quote_id: q.id }),
            asg && asg.revision === body.landing.revision ? JSON.stringify(asg) : null]);
        }
        const landingOk = body.landing ? (await maybeOne<{ ok: boolean }>(tx, `SELECT true AS ok FROM orders WHERE id=$1 AND landing_snapshot IS NOT NULL`, [order.id]))?.ok : false;
        await captureOrderContext(tx, actor, order.id, body.tracking, { onBehalf: false, landingId: landingOk ? body.landing!.landing_id : null });
        const lead = await recordLead(tx, order.id);
        return { status: 201, body: { order_id: order.id, number: order.number, confirmation: 'pending_operator_call', payable: pricedToJson(priced).payable, tracking: lead?.status === 'pending' ? { event_id: lead.event_id, event_name: lead.meta_event } : null } };
      }),
    );
    reply.status(res.replayed ? 200 : res.status);
    return { ...res.body, replayed: res.replayed };
  });

  // Order status lookup for guests requires an OTP-verified session — phone number alone opens nothing (§07, T014).
  route(app, deps, { method: 'GET', url: '/me/orders', tags: T, summary: 'My orders (verified phone)' }, async ({ actor, db }) => {
    if (!actor.userId) throw unauthorized();
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    return { items: await many(db, `SELECT o.id, o.number, o.commercial_status, o.payment_status, o.fulfillment_status, o.confirmation_status, o.payment_method, o.payable_minor::text, o.created_at,
        (SELECT COALESCE(SUM(ol.qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id) AS units,
        (SELECT ol.product_snapshot->'name' FROM order_lines ol WHERE ol.order_id=o.id ORDER BY ol.id LIMIT 1) AS first_name,
        (SELECT '/media/' || ma.storage_key FROM order_lines ol JOIN skus s ON s.id=ol.sku_id JOIN media_assets ma ON ma.product_id=s.product_id AND ma.status='approved'
          WHERE ol.order_id=o.id ORDER BY ol.id, ma.sort LIMIT 1) AS image
       FROM orders o WHERE o.user_id=$1 OR (o.user_id IS NULL AND o.customer_phone=$2) ORDER BY o.created_at DESC LIMIT 100`, [actor.userId, u.phone_e164]) };
  });

  route(app, deps, { method: 'GET', url: '/me/orders/:id', tags: T, summary: 'My order detail', params: zIdParam }, async ({ actor, db, params }) => {
    if (!actor.userId) throw unauthorized();
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    const o = await maybeOne(db, `SELECT id, number, commercial_status, payment_status, fulfillment_status, confirmation_status, payment_method, subtotal_minor::text, discount_minor::text, delivery_minor::text, payable_minor::text, address_snapshot, contact_snapshot, created_at, delivered_at
        FROM orders WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND customer_phone=$3))`, [params.id, actor.userId, u.phone_e164]);
    if (!o) throw notFound('ORDER'); // never reveals existence of foreign orders (T005)
    const lines = await many(db, `SELECT id, sku_id, product_snapshot, qty, canceled_qty, returned_qty, unit_price_minor::text, line_net_minor::text FROM order_lines WHERE order_id=$1`, [params.id]);
    const timeline = await many(db, `SELECT dimension, to_status, created_at FROM order_status_events WHERE order_id=$1 ORDER BY id`, [params.id]);
    return { ...o, lines, timeline, messages: await customerMessages(db, params.id) };
  });

  void conflict;
}
