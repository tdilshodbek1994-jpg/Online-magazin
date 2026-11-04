import type { Queryable, Tx } from '../../platform/db.js';

/**
 * UzCoin ledger. Every change is one immutable row (unique source/effect key) plus a balance update in the same
 * transaction; replays are no-ops. `available` can never go below zero (DB CHECK): a return that cannot be taken back
 * yet is recorded as visible `debt` and repaid from the next earned coins.
 */
export interface CoinMove {
  partnerId: string; kind: string; available: bigint; reserved?: bigint;
  earned?: bigint; exchanged?: bigint; spent?: bigint; adjusted?: bigint; debt?: bigint;
  sourceType: string; sourceId: string; effectKey: string;
  orderId?: string | null; orderLineId?: string | null; productName?: string | null; qty?: number | null; reason?: string | null; actorId?: string | null;
}

export async function post(tx: Tx, m: CoinMove): Promise<boolean> {
  const ins = await tx.query(
    `INSERT INTO uzcoin_ledger (partner_id, kind, coins, source_type, source_id, effect_key, order_id, order_line_id, product_name, qty, reason, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (source_type, source_id, effect_key) DO NOTHING RETURNING id`,
    [m.partnerId, m.kind, m.available.toString(), m.sourceType, m.sourceId, m.effectKey, m.orderId ?? null, m.orderLineId ?? null, m.productName ?? null, m.qty ?? null, m.reason ?? null, m.actorId ?? null]);
  if (!ins.rowCount) return false;
  await tx.query(`INSERT INTO uzcoin_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [m.partnerId]);
  await tx.query(
    `UPDATE uzcoin_balances SET available=available+$2, reserved=reserved+$3, earned_total=earned_total+$4, exchanged_total=exchanged_total+$5,
       spent_total=spent_total+$6, adjusted_total=adjusted_total+$7, debt=debt+$8, updated_at=now() WHERE partner_id=$1`,
    [m.partnerId, m.available.toString(), (m.reserved ?? 0n).toString(), (m.earned ?? 0n).toString(), (m.exchanged ?? 0n).toString(), (m.spent ?? 0n).toString(), (m.adjusted ?? 0n).toString(), (m.debt ?? 0n).toString()]);
  return true;
}

export async function currentRate(q: Queryable): Promise<{ version: number; som_per_coin_minor: string }> {
  return (await q.query(`SELECT version, som_per_coin_minor::text FROM uzcoin_rates WHERE effective_from <= now() ORDER BY version DESC LIMIT 1`)).rows[0];
}

/**
 * Coins for one order = kept units of lines whose commission is AVAILABLE (confirmed, delivered, payment verified,
 * hold/return window passed). Unconfirmed proxy orders earn nothing. Commission amount never changes the coin count.
 * Called when a commission becomes available and after any return/recalculation; deltas only, idempotent per state.
 */
export async function syncOrderCoins(tx: Tx, orderId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('uzc:' || $1::text))`, [orderId]);
  const o = (await tx.query(`SELECT attributed_partner_id AS pid, channel, confirmation_status, payment_status FROM orders WHERE id=$1`, [orderId])).rows[0];
  if (!o?.pid) return;
  const unverifiedProxy = o.channel === 'partner_assisted' && o.confirmation_status !== 'verified';
  const lines = (await tx.query(
    `SELECT ol.id, ol.qty, ol.canceled_qty, ol.returned_qty, ol.product_snapshot->'name'->>'uz-Latn' AS name,
            (SELECT a.state FROM commission_accruals a WHERE a.order_line_id=ol.id AND a.state <> 'superseded' ORDER BY a.id DESC LIMIT 1) AS state,
            (SELECT COALESCE(SUM(l.qty),0)::int FROM uzcoin_ledger l WHERE l.order_line_id=ol.id AND l.kind IN ('earned_sale','return_adjustment')) AS issued,
            (SELECT COUNT(*)::int FROM uzcoin_ledger l WHERE l.order_line_id=ol.id AND l.kind IN ('earned_sale','return_adjustment')) AS n
       FROM order_lines ol WHERE ol.order_id=$1 ORDER BY ol.id`, [orderId])).rows;
  for (const l of lines) {
    const kept = Math.max(0, l.qty - l.canceled_qty - l.returned_qty);
    // Once coins were issued for a line they follow the kept units (returns), even if the accrual later changes state.
    const eligible = !unverifiedProxy && (l.state === 'available' || (l.issued > 0 && l.state !== null));
    const desired = eligible ? kept : (l.issued > 0 ? kept : 0);
    const delta = desired - l.issued;
    if (!delta) continue;
    const key = `v${l.n + 1}`;
    if (delta > 0) {
      const bal = (await tx.query(`SELECT debt FROM uzcoin_balances WHERE partner_id=$1 FOR UPDATE`, [o.pid])).rows[0];
      const repay = BigInt(Math.min(Number(bal?.debt ?? 0), delta));
      await post(tx, { partnerId: o.pid, kind: 'earned_sale', available: BigInt(delta) - repay, earned: BigInt(delta), debt: -repay, sourceType: 'order_line', sourceId: l.id, effectKey: key,
        orderId, orderLineId: l.id, productName: l.name, qty: delta, reason: repay ? `sotuv (${repay} qarz qoplandi)` : 'sotilgan mahsulot' });
    } else {
      const need = BigInt(-delta);
      const bal = (await tx.query(`SELECT available FROM uzcoin_balances WHERE partner_id=$1 FOR UPDATE`, [o.pid])).rows[0];
      const take = need < BigInt(bal?.available ?? 0) ? need : BigInt(bal?.available ?? 0);
      await post(tx, { partnerId: o.pid, kind: 'return_adjustment', available: -take, adjusted: need, debt: need - take, sourceType: 'order_line', sourceId: l.id, effectKey: key,
        orderId, orderLineId: l.id, productName: l.name, qty: delta, reason: 'qaytarilgan mahsulot uchun tuzatish' });
    }
  }
  // Level progress and coupon state follow the same qualified units (same transaction).
  const { syncPartnerLevel, syncCouponForOrder } = await import('../levels/service.js');
  await syncCouponForOrder(tx, orderId);
  await syncPartnerLevel(tx, o.pid, `order:${orderId}`);
}
