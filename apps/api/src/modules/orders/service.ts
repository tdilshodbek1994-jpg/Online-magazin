import { allocateLargestRemainder, divRoundHalfUp } from '@om/shared';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { Actor } from '../../platform/auth.js';
import { audit } from '../../platform/audit.js';
import type { Queryable, Tx } from '../../platform/db.js';
import { AppError, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { getPolicy, POLICY } from '../../platform/policies.js';
import { accrueForOrder, recalcOrder, ruleForProduct } from '../commissions/service.js';
import { releaseReservation, reserveForOrder } from '../inventory/service.js';
import { queueNotification } from '../notifications/service.js';

export interface QuoteInput {
  lines: { sku_id: string; qty: number }[];
  delivery_zone_id: string;
  promo_code?: string | null;
  /** Partner-funded customer discount from a discount stream (per unit, one product). */
  partnerDiscount?: PartnerDiscount | null;
}

export interface PartnerDiscount { linkId: string; productId: string; unitMinor: bigint; partnerId: string; partnerCode: string }

/** Active discount stream for this product, if the visitor came through one (link must be active, partner active). */
export async function partnerDiscountForLink(q: Queryable, linkId: string | null | undefined): Promise<PartnerDiscount | null> {
  if (!linkId) return null;
  const r = await q.query(
    `SELECT l.id, l.product_id, l.customer_discount_minor, p.id AS partner_id, p.code FROM referral_links l JOIN partners p ON p.id=l.partner_id
      WHERE l.id=$1 AND l.customer_discount_minor > 0 AND l.product_id IS NOT NULL AND l.status='active' AND l.archived_at IS NULL AND p.status='active'`, [linkId]);
  const x = r.rows[0];
  return x ? { linkId: x.id, productId: x.product_id, unitMinor: BigInt(x.customer_discount_minor), partnerId: x.partner_id, partnerCode: x.code } : null;
}

export interface PricedLine {
  offerId: string;
  offerVersion: number;
  skuId: string;
  productId: string;
  merchantOrgId: string;
  qty: number;
  unitPrice: bigint;
  gross: bigint;
  lineDiscount: bigint;
  allocated: bigint;
  net: bigint;
  taxPolicy: string;
  costMinor: bigint | null;
  partnerDiscountUnit: bigint;
  snapshot: Record<string, unknown>;
}

export interface Priced {
  lines: PricedLine[];
  subtotal: bigint;
  lineDiscount: bigint;
  cartDiscount: bigint;
  delivery: bigint;
  deliveryDiscount: bigint;
  payable: bigint;
  promotionId: string | null;
  partnerDiscountLinkId: string | null;
  zone: { id: string; region_code: string; tariff_minor: string; eta_min_days: number; eta_max_days: number; cod_allowed: boolean };
  hash: string;
}

/** Server-side pricing (§10). Client prices are never trusted (T024). */
export async function priceLines(q: Queryable, input: QuoteInput): Promise<Priced> {
  if (!input.lines.length) throw unprocessable('CART_EMPTY');
  const merged = new Map<string, number>();
  for (const l of input.lines) merged.set(l.sku_id, (merged.get(l.sku_id) ?? 0) + l.qty);
  const skuIds = [...merged.keys()].sort();
  const rows = await q.query(
    `SELECT s.id AS sku_id, s.sku_code, s.variant, s.cost_minor, s.status AS sku_status, p.id AS product_id, p.slug, p.name, p.status AS product_status,
            o.id AS offer_id, o.version AS offer_version, o.price_minor, o.merchant_org_id, o.tax_policy, o.status AS offer_status
       FROM skus s JOIN products p ON p.id = s.product_id
       JOIN offers o ON o.sku_id = s.id AND o.merchant_org_id = p.owner_org_id
      WHERE s.id = ANY($1::uuid[])`,
    [skuIds],
  );
  const bySku = new Map(rows.rows.map((r) => [r.sku_id as string, r]));
  const unavailable: string[] = [];
  const lines: PricedLine[] = [];
  for (const skuId of skuIds) {
    const r = bySku.get(skuId);
    if (!r || r.product_status !== 'published' || r.sku_status !== 'active' || r.offer_status !== 'active') {
      unavailable.push(skuId);
      continue;
    }
    const qty = merged.get(skuId)!;
    const unit = BigInt(r.price_minor);
    lines.push({
      offerId: r.offer_id, offerVersion: r.offer_version, skuId, productId: r.product_id, merchantOrgId: r.merchant_org_id, qty,
      unitPrice: unit, gross: unit * BigInt(qty), lineDiscount: 0n, allocated: 0n, net: unit * BigInt(qty), taxPolicy: r.tax_policy,
      costMinor: r.cost_minor === null ? null : BigInt(r.cost_minor), partnerDiscountUnit: 0n,
      snapshot: { product_id: r.product_id, slug: r.slug, name: r.name, sku_code: r.sku_code, variant: r.variant },
    });
  }
  // Archived/unpublished goods are closed for new purchase (T022, AC-X07).
  if (unavailable.length) throw unprocessable('ITEMS_UNAVAILABLE', { sku_ids: unavailable });
  // Partner-funded discount: price − discount per unit for the stream's product (never below 1 so'm).
  const pd = input.partnerDiscount ?? null;
  let partnerDiscountLinkId: string | null = null;
  if (pd && pd.unitMinor > 0n) {
    for (const l of lines) {
      if (l.productId !== pd.productId) continue;
      const unit = pd.unitMinor >= l.unitPrice ? l.unitPrice - 100n : pd.unitMinor;
      if (unit <= 0n) continue;
      l.partnerDiscountUnit = unit;
      l.lineDiscount = unit * BigInt(l.qty);
      l.net = l.gross - l.lineDiscount;
      l.snapshot = { ...l.snapshot, partner_discount: { unit_minor: unit.toString(), partner_code: pd.partnerCode, link_id: pd.linkId } };
      partnerDiscountLinkId = pd.linkId;
    }
  }
  const lineDiscount = lines.reduce((a, l) => a + l.lineDiscount, 0n);
  const zr = await q.query(`SELECT id, region_code, tariff_minor, free_from_minor, eta_min_days, eta_max_days, cod_allowed FROM delivery_zones WHERE id=$1 AND active`, [input.delivery_zone_id]);
  if (!zr.rowCount) throw unprocessable('DELIVERY_ZONE_UNAVAILABLE');
  const zone = zr.rows[0];
  const subtotal = lines.reduce((a, l) => a + l.gross, 0n);
  let cartDiscount = 0n;
  let promotionId: string | null = null;
  let freeDelivery = false;
  if (input.promo_code) {
    const p = await q.query(
      `SELECT * FROM promotions WHERE code=$1 AND status='active' AND starts_at <= now() AND ends_at > now()`,
      [input.promo_code.trim().toUpperCase()],
    );
    const promo = p.rows[0];
    if (!promo || BigInt(promo.min_subtotal_minor) > subtotal - lineDiscount || (promo.max_redemptions !== null && promo.redemptions_reserved >= promo.max_redemptions)) {
      throw unprocessable('PROMO_NOT_APPLICABLE');
    }
    promotionId = promo.id;
    const base = subtotal - lineDiscount;
    if (promo.kind === 'cart_percent') cartDiscount = divRoundHalfUp(base * BigInt(promo.value_bps), 10_000n);
    else if (promo.kind === 'cart_fixed') cartDiscount = BigInt(promo.value_minor) > base ? base : BigInt(promo.value_minor);
    else freeDelivery = true;
  }
  if (cartDiscount > 0n) {
    const alloc = allocateLargestRemainder(cartDiscount, lines.map((l) => ({ key: l.skuId, weight: l.gross - l.lineDiscount })));
    for (const l of lines) {
      l.allocated = alloc.get(l.skuId) ?? 0n;
      l.net = l.gross - l.lineDiscount - l.allocated;
    }
  }
  const tariff = BigInt(zone.tariff_minor);
  const delivery = tariff;
  const deliveryDiscount = freeDelivery || (zone.free_from_minor && subtotal - lineDiscount - cartDiscount >= BigInt(zone.free_from_minor)) ? tariff : 0n;
  const payable = subtotal - lineDiscount - cartDiscount + delivery - deliveryDiscount;
  const hash = createHash('sha256')
    .update(JSON.stringify({ l: lines.map((l) => [l.offerId, l.offerVersion, l.unitPrice.toString(), l.qty, l.net.toString()]), pd: partnerDiscountLinkId, d: [delivery.toString(), deliveryDiscount.toString()], c: cartDiscount.toString(), p: payable.toString(), z: zone.id }))
    .digest('hex');
  return { lines, subtotal, lineDiscount, cartDiscount, delivery, deliveryDiscount, payable, promotionId, partnerDiscountLinkId, zone, hash };
}

export function pricedToJson(p: Priced) {
  return {
    lines: p.lines.map((l) => ({ sku_id: l.skuId, offer_id: l.offerId, qty: l.qty, product: l.snapshot, unit_price: m(l.unitPrice), line_total: m(l.gross), discount: m(l.lineDiscount + l.allocated), net: m(l.net), seller_discount_unit: l.partnerDiscountUnit > 0n ? m(l.partnerDiscountUnit) : null })),
    subtotal: m(p.subtotal), discount: m(p.cartDiscount + p.lineDiscount), delivery: m(p.delivery), delivery_discount: m(p.deliveryDiscount), payable: m(p.payable),
    delivery_eta_days: { min: p.zone.eta_min_days, max: p.zone.eta_max_days }, cod_allowed: p.zone.cod_allowed, quote_hash: p.hash,
  };
}

export const m = (v: bigint | string) => ({ amount_minor: String(v), currency: 'UZS' });

export async function storeQuote(tx: Tx, p: Priced, ctx: { cartId: string | null; userId: string | null; createdBy: string | null; address: unknown; contact: unknown; ttlMinutes: number }): Promise<{ id: string; expires_at: string }> {
  const cfg = await tx.query(`SELECT COALESCE(MAX(version), 0) AS v FROM business_config_versions`);
  const q = await tx.query(
    `INSERT INTO checkout_quotes (cart_id, user_id, created_by_user_id, currency, address_snapshot, contact_snapshot, delivery_method, subtotal_minor, line_discount_minor, cart_discount_minor, delivery_minor, delivery_discount_minor, payable_minor, promotion_id, config_version, quote_hash, expires_at)
     VALUES ($1,$2,$3,'UZS',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + make_interval(mins => $16)) RETURNING id, expires_at`,
    [ctx.cartId, ctx.userId, ctx.createdBy, JSON.stringify(ctx.address), JSON.stringify(ctx.contact), `zone:${p.zone.id}`, p.subtotal.toString(), p.lineDiscount.toString(), p.cartDiscount.toString(), p.delivery.toString(), p.deliveryDiscount.toString(), p.payable.toString(), p.promotionId, cfg.rows[0].v, p.hash, ctx.ttlMinutes],
  );
  if (p.partnerDiscountLinkId) await tx.query(`UPDATE checkout_quotes SET partner_discount_link_id=$2 WHERE id=$1`, [q.rows[0].id, p.partnerDiscountLinkId]);
  for (const l of p.lines) {
    await tx.query(
      `INSERT INTO quote_lines (quote_id, offer_id, offer_version, sku_id, merchant_org_id, qty, unit_price_minor, line_gross_minor, line_discount_minor, allocated_cart_discount_minor, line_net_minor, tax_policy, product_snapshot, partner_discount_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [q.rows[0].id, l.offerId, l.offerVersion, l.skuId, l.merchantOrgId, l.qty, l.unitPrice.toString(), l.gross.toString(), l.lineDiscount.toString(), l.allocated.toString(), l.net.toString(), l.taxPolicy, JSON.stringify(l.snapshot), l.partnerDiscountUnit.toString()],
    );
  }
  return q.rows[0];
}

export interface Attribution {
  partner_id: string;
  campaign_id: string | null;
  touch_id: string | null;
  link_id: string | null;
  rule_version: number;
  reason: 'explicit_code' | 'last_eligible_click' | 'partner_assisted';
  attributed_at: string;
  eligible: boolean;
  ineligible_reason?: string;
  // Reporting attribution (spec §9): source placement/channel, separate from capture mode (orders.channel).
  placement_id?: string | null;
  source_channel?: 'telegram_channel' | 'telegram_ads' | 'instagram_target' | 'organic' | 'unknown' | null;
}

export interface CreateOrderInput {
  quoteId: string;
  quoteHash: string;
  paymentMethod: 'cod' | 'online';
  channel: 'web' | 'partner_assisted' | 'operator';
  customerUserId: string | null;
  customerPhone: string;
  createdBy: string | null;
  confirmation: 'checkout_verified_session' | 'pending';
  attribution: Attribution | null;
  acceptedTerms: boolean;
}

/**
 * Create an order from a stored, unexpired quote after re-pricing (T025). Everything — order, lines,
 * snapshots, reservation (when confirmed), promo reservation, commission accrual and outbox — commits
 * atomically in the caller's transaction (T052).
 */
export async function createOrder(tx: Tx, cfg: AppConfig, actor: Actor, input: CreateOrderInput): Promise<{ id: string; number: string }> {
  if (!input.acceptedTerms) throw unprocessable('TERMS_NOT_ACCEPTED');
  const qr = await tx.query(`SELECT * FROM checkout_quotes WHERE id=$1 FOR UPDATE`, [input.quoteId]);
  const quote = qr.rows[0];
  if (!quote) throw notFound('QUOTE');
  if (quote.status !== 'active') throw conflict('QUOTE_ALREADY_USED');
  if (quote.quote_hash !== input.quoteHash) throw conflict('QUOTE_HASH_MISMATCH');
  if (new Date(quote.expires_at) < new Date()) throw conflict('QUOTE_EXPIRED');
  const qlines = await tx.query(`SELECT sku_id, qty FROM quote_lines WHERE quote_id=$1`, [quote.id]);
  const zoneId = String(quote.delivery_method).replace('zone:', '');
  const partnerDiscount = await partnerDiscountForLink(tx, quote.partner_discount_link_id);
  const fresh = await priceLines(tx, { partnerDiscount, lines: qlines.rows.map((r) => ({ sku_id: r.sku_id, qty: r.qty })), delivery_zone_id: zoneId, promo_code: quote.promotion_id ? (await tx.query(`SELECT code FROM promotions WHERE id=$1`, [quote.promotion_id])).rows[0]?.code : null });
  // Price/stock-relevant change since the customer saw the quote => re-confirmation required (T025, AC-M11-1).
  if (fresh.hash !== quote.quote_hash) throw conflict('QUOTE_CHANGED', { new_quote: pricedToJson(fresh) });
  if (input.paymentMethod === 'cod' && !fresh.zone.cod_allowed) throw unprocessable('COD_NOT_ALLOWED');
  const terms = await getPolicy<{ version: string }>(tx, POLICY.termsVersion, cfg.env);
  const verified = input.confirmation === 'checkout_verified_session';
  const ord = await tx.query(
    `INSERT INTO orders (user_id, guest_ref, quote_id, currency, commercial_status, payment_status, payment_method, subtotal_minor, discount_minor, delivery_minor, payable_minor,
                         address_snapshot, contact_snapshot, config_version, confirmation_status, channel, created_by_user_id, customer_phone, attributed_partner_id, attribution, terms_version)
     VALUES ($1,$2,$3,'UZS',$4,'unpaid',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, number, version`,
    [input.customerUserId, input.customerUserId ? null : `phone:${input.customerPhone}`, quote.id, verified ? 'confirmed' : 'awaiting_confirmation', input.paymentMethod,
     fresh.subtotal.toString(), (fresh.lineDiscount + fresh.cartDiscount + fresh.deliveryDiscount).toString(), fresh.delivery.toString(), fresh.payable.toString(), quote.address_snapshot, quote.contact_snapshot, quote.config_version,
     verified ? 'verified' : 'pending', input.channel, input.createdBy, input.customerPhone, input.attribution?.eligible ? input.attribution.partner_id : null,
     input.attribution ? JSON.stringify(input.attribution) : null, terms?.value.version ?? 'draft'],
  );
  const order = ord.rows[0];
  await tx.query(`UPDATE checkout_quotes SET status='confirmed' WHERE id=$1`, [quote.id]);
  // Zero payable (fully covered by promo) is never sent to a PSP as a fake 0 charge (MASTER 9.5).
  await tx.query(`INSERT INTO payment_intents (order_id, amount_minor, currency, method, status) VALUES ($1,$2,'UZS',$3,$4)`,
    [order.id, fresh.payable.toString(), input.paymentMethod, fresh.payable === 0n ? 'not_required' : 'requires_payment']);
  const mo = await tx.query(`INSERT INTO merchant_orders (order_id, merchant_org_id, subtotal_net_minor) VALUES ($1,$2,$3) RETURNING id`, [order.id, fresh.lines[0]!.merchantOrgId, fresh.lines.reduce((a, l) => a + l.net, 0n).toString()]);
  const stockLines = [];
  for (const l of fresh.lines) {
    const rule = await ruleForProduct(tx, l.productId);
    const ol = await tx.query(
      `INSERT INTO order_lines (order_id, merchant_order_id, offer_id, sku_id, merchant_org_id, qty, unit_price_minor, line_gross_minor, line_discount_minor, allocated_cart_discount_minor, line_net_minor, tax_policy, product_snapshot, offer_snapshot, attribution_snapshot, cost_snapshot_minor, commission_rule_snapshot, partner_discount_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [order.id, mo.rows[0].id, l.offerId, l.skuId, l.merchantOrgId, l.qty, l.unitPrice.toString(), l.gross.toString(), l.lineDiscount.toString(), l.allocated.toString(), l.net.toString(), l.taxPolicy,
       JSON.stringify(l.snapshot), JSON.stringify({ offer_id: l.offerId, version: l.offerVersion, price_minor: l.unitPrice.toString() }), input.attribution ? JSON.stringify(input.attribution) : null,
       l.costMinor?.toString() ?? null, rule ? JSON.stringify(rule) : null, l.partnerDiscountUnit.toString()],
    );
    stockLines.push({ orderLineId: ol.rows[0].id, skuId: l.skuId, merchantOrgId: l.merchantOrgId, qty: l.qty });
  }
  if (fresh.promotionId) {
    // Transactional promo cap (T027): the CHECK constraint refuses a second use of a single-use code.
    const u = await tx.query(`UPDATE promotions SET redemptions_reserved = redemptions_reserved + 1 WHERE id=$1 AND (max_redemptions IS NULL OR redemptions_reserved < max_redemptions) RETURNING id`, [fresh.promotionId]);
    if (!u.rowCount) throw conflict('PROMO_EXHAUSTED');
    await tx.query(`INSERT INTO promotion_redemptions (promotion_id, order_id, amount_minor, status) VALUES ($1,$2,$3,'reserved')`, [fresh.promotionId, order.id, fresh.cartDiscount.toString()]);
  }
  if (verified) {
    await reserveForOrder(tx, order.id, stockLines, input.paymentMethod === 'online' ? 'active_unpaid' : 'allocated_for_fulfillment', cfg.reservationTtlMinutes);
    await tx.query(`UPDATE orders SET fulfillment_status='reserved' WHERE id=$1`, [order.id]);
    await tx.query(`INSERT INTO order_confirmations (order_id, method, status, actor_user_id, shown_total_minor, shown_quote_hash) VALUES ($1,'checkout_verified_session','verified',$2,$3,$4)`, [order.id, input.customerUserId, fresh.payable.toString(), fresh.hash]);
  }
  if (input.attribution?.eligible) await accrueForOrder(tx, order.id, input.attribution.partner_id);
  await statusEvent(tx, order.id, 'commercial', null, verified ? 'confirmed' : 'awaiting_confirmation', actor, 'order_created');
  await emit(tx, { type: 'OrderPlaced', aggregateType: 'order', aggregateId: order.id, aggregateVersion: order.version, payload: { number: order.number, channel: input.channel, payable_minor: fresh.payable.toString() } });
  await queueNotification(tx, { userId: input.customerUserId, phone: input.customerPhone, channel: 'sms', purpose: 'transactional', template: 'order_received', locale: 'uz-Latn', params: { number: order.number }, dedupeKey: `order_received:${order.id}` });
  // Duplicate signal (operator "Dublikat"): same phone ordered the same SKU in the last 24h and that order is still alive.
  await tx.query(
    `UPDATE orders SET duplicate_signal=true WHERE id=$1 AND EXISTS (
       SELECT 1 FROM orders o2 JOIN order_lines l2 ON l2.order_id=o2.id
        WHERE o2.id <> $1 AND o2.customer_phone=$2 AND o2.created_at > now() - interval '24 hours' AND o2.commercial_status <> 'cancelled'
          AND l2.sku_id IN (SELECT sku_id FROM order_lines WHERE order_id=$1))`, [order.id, input.customerPhone]);
  return { id: order.id, number: order.number };
}

export async function statusEvent(tx: Queryable, orderId: string, dimension: string, from: string | null, to: string, actor: Actor | null, reason: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO order_status_events (order_id, dimension, from_status, to_status, actor_kind, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orderId, dimension, from, to, actor?.kind ?? 'system', actor?.userId ?? null, reason],
  );
}

/**
 * Mark customer confirmation verified (customer OTP or independent operator call) and allocate stock.
 * Unconfirmed orders never hold stock (T056); if stock ran out meanwhile the order goes to the problem queue.
 */
export async function confirmOrder(tx: Tx, cfg: AppConfig, actor: Actor, orderId: string, method: 'customer_otp' | 'operator_call' | 'customer_link', evidence: Record<string, unknown>): Promise<void> {
  const o = (await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw notFound('ORDER');
  if (o.confirmation_status === 'verified') return; // idempotent no-op
  if (o.commercial_status !== 'awaiting_confirmation' || o.confirmation_status !== 'pending') throw conflict('ORDER_NOT_AWAITING_CONFIRMATION');
  const lines = await tx.query(`SELECT id, sku_id, merchant_org_id, qty FROM order_lines WHERE order_id=$1`, [orderId]);
  await tx.query('SAVEPOINT reserve');
  try {
    await reserveForOrder(tx, orderId, lines.rows.map((l) => ({ orderLineId: l.id, skuId: l.sku_id, merchantOrgId: l.merchant_org_id, qty: l.qty })), o.payment_method === 'online' ? 'active_unpaid' : 'allocated_for_fulfillment', cfg.reservationTtlMinutes);
    await tx.query('RELEASE SAVEPOINT reserve');
  } catch (e) {
    if ((e as AppError).code !== 'OUT_OF_STOCK') throw e;
    await tx.query('ROLLBACK TO SAVEPOINT reserve');
    await tx.query(`UPDATE orders SET confirmation_status='verified', problem_reason='out_of_stock', version=version+1, updated_at=now() WHERE id=$1`, [orderId]);
    await statusEvent(tx, orderId, 'commercial', o.commercial_status, o.commercial_status, actor, 'confirmed_but_out_of_stock');
    return;
  }
  await tx.query(`UPDATE orders SET confirmation_status='verified', commercial_status='confirmed', fulfillment_status='reserved', version=version+1, updated_at=now() WHERE id=$1`, [orderId]);
  await statusEvent(tx, orderId, 'commercial', 'awaiting_confirmation', 'confirmed', actor, method);
  await audit(tx, actor, 'order.confirmed', { type: 'order', id: orderId }, { after: { method, ...evidence } });
  await emit(tx, { type: 'OrderConfirmed', aggregateType: 'order', aggregateId: orderId, payload: { method } });
}

/** Cancel: releases stock, voids promo reservation, reverses commission target to zero (T044). */
export async function cancelOrder(tx: Tx, actor: Actor, orderId: string, reason: string, confirmationRejected = false): Promise<void> {
  const o = (await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw notFound('ORDER');
  if (o.commercial_status === 'cancelled') return;
  if (['shipped', 'delivered'].includes(o.fulfillment_status)) throw conflict('ORDER_ALREADY_SHIPPED');
  if (o.payment_status === 'paid') throw conflict('PAID_ORDER_REQUIRES_REFUND');
  await releaseReservation(tx, orderId, 'released');
  await tx.query(`UPDATE order_lines SET canceled_qty = qty - shipped_qty WHERE order_id=$1`, [orderId]);
  await tx.query(
    `UPDATE orders SET commercial_status='cancelled', cancel_reason=$2, fulfillment_status='unallocated',
       confirmation_status = CASE WHEN $3 THEN 'rejected' WHEN confirmation_status='pending' THEN 'expired' ELSE confirmation_status END,
       version=version+1, updated_at=now() WHERE id=$1`,
    [orderId, reason, confirmationRejected],
  );
  const pr = await tx.query(`UPDATE promotion_redemptions SET status='released' WHERE order_id=$1 AND status='reserved' RETURNING promotion_id`, [orderId]);
  for (const r of pr.rows) await tx.query(`UPDATE promotions SET redemptions_reserved = redemptions_reserved - 1 WHERE id=$1`, [r.promotion_id]);
  await recalcOrder(tx, orderId, 'order_cancelled', actor.userId);
  await statusEvent(tx, orderId, 'commercial', o.commercial_status, 'cancelled', actor, reason);
  await audit(tx, actor, 'order.cancelled', { type: 'order', id: orderId }, { reason });
  await emit(tx, { type: 'OrderCancelled', aggregateType: 'order', aggregateId: orderId, payload: { reason } });
}

export function requireVersion(row: { version: number }, expected: number | undefined): void {
  if (expected !== undefined && row.version !== expected) throw new AppError(409, 'VERSION_CONFLICT', {}, false, { current_version: row.version });
}
