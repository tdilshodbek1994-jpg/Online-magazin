import { normalizeUzPhone } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashToken } from '../../platform/auth.js';
import { many, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { badRequest, conflict, notFound, unauthorized } from '../../platform/errors.js';
import { idempotent } from '../../platform/idempotency.js';
import { type Deps, requireIdempotencyKey, route, zIdParam } from '../../platform/http.js';
import type { Actor } from '../../platform/auth.js';
import { resolveAttribution } from '../partners/attribution.js';
import { createOrder, m, priceLines, pricedToJson, storeQuote } from '../orders/service.js';

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
    SELECT cl.id, cl.qty, s.id AS sku_id, s.sku_code, s.variant, p.slug, p.name, p.status AS product_status, s.status AS sku_status, o.price_minor::text, o.status AS offer_status,
           GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0)) AS available
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
      if (body.qty === 0) await tx.query(`DELETE FROM cart_lines WHERE cart_id=$1 AND offer_id=$2`, [c.id, offer.id]);
      else await tx.query(`INSERT INTO cart_lines (cart_id, offer_id, qty) VALUES ($1,$2,$3) ON CONFLICT (cart_id, offer_id) DO UPDATE SET qty=EXCLUDED.qty`, [c.id, offer.id, body.qty]);
      await tx.query(`UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1`, [c.id]);
      return cartView(tx, c.id);
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
      const priced = await priceLines(tx, { lines, delivery_zone_id: body.delivery_zone_id, promo_code: body.promo_code });
      const q = await storeQuote(tx, priced, { cartId: c.id, userId: actor.userId, createdBy: actor.userId, address: body.address, contact: { ...body.contact, phone }, ttlMinutes: cfg.quoteTtlMinutes });
      return { quote_id: q.id, expires_at: q.expires_at, ...pricedToJson(priced) };
    }));

  route(app, deps, {
    method: 'POST', url: '/checkout/confirmations', tags: T, summary: 'Place order from quote (Idempotency-Key required)',
    body: z.object({ quote_id: z.string().uuid(), quote_hash: z.string().length(64), payment_method: z.enum(['cod', 'online']), accept_terms: z.literal(true), referral_code: z.string().max(20).optional(), marketing_opt_in: z.boolean().default(false) }),
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
        const attribution = await resolveAttribution(tx, cfg.env, { explicitCode: body.referral_code ?? null, guestToken: actor.guestToken, customerUserId: actor.userId });
        const order = await createOrder(tx, cfg, actor, {
          quoteId: body.quote_id, quoteHash: body.quote_hash, paymentMethod: body.payment_method, channel: 'web', customerUserId: actor.userId, customerPhone: phone,
          createdBy: actor.userId, confirmation: verified ? 'checkout_verified_session' : 'pending', attribution, acceptedTerms: body.accept_terms,
        });
        if (own) await tx.query(`UPDATE carts SET status='converted', updated_at=now() WHERE id=$1`, [own.id]);
        if (actor.userId && body.marketing_opt_in) await tx.query(`INSERT INTO consents (user_id, purpose, channel, granted, source) VALUES ($1,'marketing','any',true,'checkout_optional')`, [actor.userId]);
        return { status: 201, body: { order_id: order.id, number: order.number, confirmation: verified ? 'verified' : 'pending_operator_call' } };
      }),
    );
    reply.status(res.replayed ? 200 : res.status);
    return { ...res.body, replayed: res.replayed };
  });

  // Order status lookup for guests requires an OTP-verified session — phone number alone opens nothing (§07, T014).
  route(app, deps, { method: 'GET', url: '/me/orders', tags: T, summary: 'My orders (verified phone)' }, async ({ actor, db }) => {
    if (!actor.userId) throw unauthorized();
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    return { items: await many(db, `SELECT id, number, commercial_status, payment_status, fulfillment_status, confirmation_status, payable_minor::text, created_at FROM orders WHERE user_id=$1 OR (user_id IS NULL AND customer_phone=$2) ORDER BY created_at DESC LIMIT 100`, [actor.userId, u.phone_e164]) };
  });

  route(app, deps, { method: 'GET', url: '/me/orders/:id', tags: T, summary: 'My order detail', params: zIdParam }, async ({ actor, db, params }) => {
    if (!actor.userId) throw unauthorized();
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    const o = await maybeOne(db, `SELECT id, number, commercial_status, payment_status, fulfillment_status, confirmation_status, payment_method, subtotal_minor::text, discount_minor::text, delivery_minor::text, payable_minor::text, address_snapshot, contact_snapshot, created_at, delivered_at
        FROM orders WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND customer_phone=$3))`, [params.id, actor.userId, u.phone_e164]);
    if (!o) throw notFound('ORDER'); // never reveals existence of foreign orders (T005)
    const lines = await many(db, `SELECT id, product_snapshot, qty, canceled_qty, returned_qty, unit_price_minor::text, line_net_minor::text FROM order_lines WHERE order_id=$1`, [params.id]);
    const timeline = await many(db, `SELECT dimension, to_status, created_at FROM order_status_events WHERE order_id=$1 ORDER BY id`, [params.id]);
    return { ...o, lines, timeline };
  });

  void conflict;
}
