import { randomBytes, randomInt } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { audit } from '../../platform/audit.js';
import { type Actor, hashToken, requirePerm } from '../../platform/auth.js';
import { maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { accrueForOrder, recalcOrder, ruleForProduct } from '../commissions/service.js';
import { releaseReservation, reserveForOrder } from '../inventory/service.js';
import { queueNotification } from '../notifications/service.js';
import { priceLines, pricedToJson, statusEvent, storeQuote } from './service.js';

export const confirmCodeHash = (id: string, code: string) => createHash('sha256').update(`confirm:${id}:${code}`).digest();

/**
 * Changing items/total of a confirmed order (T050, §10): a new server quote is created and the customer must
 * confirm it with a one-time code. The order keeps its old content until then; fulfilment is blocked meanwhile.
 */
export function registerAmendments(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ops/orders/:id/amendments', tags: ['operator'], summary: 'Propose new items/qty (requires customer re-confirmation)', params: zIdParam,
    body: z.object({ lines: z.array(z.object({ sku_id: z.string().uuid(), qty: z.number().int().min(1).max(99) })).min(1).max(30), reason: z.string().min(3).max(300) }) },
  async ({ actor, db, cfg, params, body }) => {
    requirePerm(actor, 'orders.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ commercial_status: string; fulfillment_status: string; payment_status: string; delivery_method: string; address_snapshot: unknown; contact_snapshot: { phone: string }; payable_minor: string; customer_phone: string }>(tx,
        `SELECT o.*, q.delivery_method FROM orders o JOIN checkout_quotes q ON q.id=o.quote_id WHERE o.id=$1 FOR UPDATE OF o`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.commercial_status !== 'confirmed' || !['reserved', 'unallocated'].includes(o.fulfillment_status)) throw conflict('ORDER_NOT_AMENDABLE');
      if (!['unpaid', 'pending'].includes(o.payment_status) || o.payment_status === 'pending') throw conflict('AMENDMENT_REQUIRES_REFUND_FLOW');
      const priced = await priceLines(tx, { lines: body.lines, delivery_zone_id: o.delivery_method.replace('zone:', '') });
      const q = await storeQuote(tx, priced, { cartId: null, userId: null, createdBy: actor.userId, address: o.address_snapshot, contact: o.contact_snapshot, ttlMinutes: 24 * 60 });
      const conf = await one<{ id: string }>(tx, `INSERT INTO order_confirmations (order_id, method, status, expires_at, shown_total_minor, shown_quote_hash) VALUES ($1,'customer_otp','pending', now() + interval '24 hours', $2, $3) RETURNING id`, [params.id, priced.payable.toString(), priced.hash]);
      const token = randomBytes(24).toString('base64url');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await tx.query(`UPDATE order_confirmations SET token_hash=$2, code_hash=$3 WHERE id=$1`, [conf.id, hashToken(token), confirmCodeHash(conf.id, code)]);
      const am = await one<{ id: string }>(tx, `INSERT INTO order_amendments (order_id, proposed_by, new_quote_id, old_payable_minor, new_payable_minor, confirmation_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [params.id, actor.userId, q.id, o.payable_minor, priced.payable.toString(), conf.id, body.reason]).catch((e) => { if (e.code === '23505') throw conflict('AMENDMENT_ALREADY_PENDING'); throw e; });
      await queueNotification(tx, { phone: o.customer_phone, channel: 'sms', purpose: 'transactional', template: 'order_amendment_confirm', locale: 'uz-Latn', params: { link: `${cfg.publicWebUrl}/confirm/${token}`, code_ref: conf.id }, dedupeKey: `amend:${am.id}` });
      await audit(tx, actor, 'order.amendment_proposed', { type: 'order', id: params.id }, { after: { old: o.payable_minor, new: priced.payable.toString() }, reason: body.reason });
      return { amendment_id: am.id, status: 'awaiting_customer', new_quote: pricedToJson(priced), ...(cfg.env !== 'production' && cfg.otp.devEcho ? { dev_customer_link_token: token, dev_customer_code: code } : {}) };
    });
  });
}

/** Apply an accepted amendment atomically: old lines cancelled (snapshots kept), new lines + reservation + commission. */
export async function applyAmendment(tx: Tx, cfg: AppConfig, actor: Actor, amendmentId: string): Promise<void> {
  const am = await one<{ order_id: string; new_quote_id: string; status: string }>(tx, `SELECT * FROM order_amendments WHERE id=$1 FOR UPDATE`, [amendmentId]);
  if (am.status !== 'awaiting_customer') return;
  const o = await one<{ id: string; attributed_partner_id: string | null; attribution: unknown; payment_method: string; merchant_order_id: string }>(tx,
    `SELECT o.*, (SELECT id FROM merchant_orders WHERE order_id=o.id LIMIT 1) AS merchant_order_id FROM orders o WHERE o.id=$1 FOR UPDATE`, [am.order_id]);
  const q = await one<{ subtotal_minor: string; cart_discount_minor: string; delivery_minor: string; delivery_discount_minor: string; payable_minor: string }>(tx, `SELECT * FROM checkout_quotes WHERE id=$1`, [am.new_quote_id]);
  await releaseReservation(tx, o.id, 'released');
  await tx.query(`UPDATE order_lines SET canceled_qty = qty WHERE order_id=$1 AND canceled_qty < qty`, [o.id]);
  await recalcOrder(tx, o.id, 'order_amended', actor.userId);
  const qlines = (await tx.query(`SELECT * FROM quote_lines WHERE quote_id=$1`, [am.new_quote_id])).rows;
  const stock = [];
  for (const l of qlines) {
    const offer = await one<{ product_id: string; cost_minor: string | null }>(tx, `SELECT s.product_id, s.cost_minor FROM skus s WHERE s.id=$1`, [l.sku_id]);
    const rule = await ruleForProduct(tx, offer.product_id);
    const ol = await one<{ id: string }>(tx, `INSERT INTO order_lines (order_id, merchant_order_id, offer_id, sku_id, merchant_org_id, qty, unit_price_minor, line_gross_minor, line_discount_minor, allocated_cart_discount_minor, line_net_minor, tax_policy, product_snapshot, offer_snapshot, attribution_snapshot, cost_snapshot_minor, commission_rule_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [o.id, o.merchant_order_id, l.offer_id, l.sku_id, l.merchant_org_id, l.qty, l.unit_price_minor, l.line_gross_minor, l.line_discount_minor, l.allocated_cart_discount_minor, l.line_net_minor, l.tax_policy, JSON.stringify(l.product_snapshot), JSON.stringify({ offer_id: l.offer_id, version: l.offer_version, price_minor: l.unit_price_minor }), o.attribution ? JSON.stringify(o.attribution) : null, offer.cost_minor, rule ? JSON.stringify(rule) : null]);
    stock.push({ orderLineId: ol.id, skuId: l.sku_id, merchantOrgId: l.merchant_org_id, qty: l.qty });
  }
  await reserveForOrder(tx, o.id, stock, o.payment_method === 'online' ? 'active_unpaid' : 'allocated_for_fulfillment', cfg.reservationTtlMinutes);
  await tx.query(`UPDATE orders SET subtotal_minor=$2, discount_minor=$3, delivery_minor=$4, payable_minor=$5, fulfillment_status='reserved', version=version+1, updated_at=now() WHERE id=$1`,
    [o.id, q.subtotal_minor, (BigInt(q.cart_discount_minor) + BigInt(q.delivery_discount_minor)).toString(), q.delivery_minor, q.payable_minor]);
  await tx.query(`UPDATE payment_intents SET amount_minor=$2, version=version+1 WHERE order_id=$1 AND captured_minor=0`, [o.id, q.payable_minor]);
  await tx.query(`UPDATE checkout_quotes SET status='confirmed' WHERE id=$1`, [am.new_quote_id]);
  if (o.attributed_partner_id) await accrueForOrder(tx, o.id, o.attributed_partner_id);
  await tx.query(`UPDATE order_amendments SET status='accepted', decided_at=now() WHERE id=$1`, [amendmentId]);
  await statusEvent(tx, o.id, 'commercial', 'confirmed', 'confirmed', actor, `amendment_accepted:${amendmentId}`);
}

export async function rejectAmendment(tx: Tx, actor: Actor, amendmentId: string): Promise<void> {
  const am = await one<{ order_id: string }>(tx, `UPDATE order_amendments SET status='rejected', decided_at=now() WHERE id=$1 AND status='awaiting_customer' RETURNING order_id`, [amendmentId]);
  await statusEvent(tx, am.order_id, 'commercial', 'confirmed', 'confirmed', actor, `amendment_rejected:${amendmentId}`);
}

export async function assertNoPendingAmendment(tx: Tx, orderId: string): Promise<void> {
  const r = await tx.query(`SELECT 1 FROM order_amendments WHERE order_id=$1 AND status='awaiting_customer'`, [orderId]);
  if (r.rowCount) throw conflict('AMENDMENT_PENDING');
  void unprocessable;
}
