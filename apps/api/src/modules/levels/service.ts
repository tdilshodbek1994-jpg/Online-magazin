import { audit } from '../../platform/audit.js';
import { many, maybeOne, one, type Queryable, type Tx } from '../../platform/db.js';
import type { RuleSnapshot } from '../commissions/service.js';

/**
 * Partner Level & Loyalty PRO. Units = qualified units from the UzCoin ledger (only lines whose commission became
 * available: confirmed, delivered, payment verified; returns subtract) + audited admin adjustments. The ledger's unique
 * effect keys make every sale count once. Level benefits only change the commission snapshot of NEW order lines.
 */
export const COUPON_UNITS = 10_000;     // task §3: one-time 50% coupon
export const VIP_UNITS = 100_000;       // task §3: 50% VIP right
export const BENEFIT_BPS = 5000;

export interface LevelDef { level: number; name: string; threshold: number; badge: string; color: string; gift_discount_bps: number; perks: string | null }
export const levelDefs = (q: Queryable) => many<LevelDef>(q, `SELECT level, name, threshold, badge, color, gift_discount_bps, perks FROM partner_level_defs ORDER BY threshold`);
export function levelFor(defs: LevelDef[], units: number): LevelDef {
  let cur = defs[0]!;
  for (const d of defs) if (units >= d.threshold) cur = d;
  return cur;
}

export async function qualifiedUnits(q: Queryable, partnerId: string): Promise<number> {
  const r = await one<{ n: number }>(q, `SELECT
      COALESCE((SELECT SUM(qty) FROM uzcoin_ledger WHERE partner_id=$1 AND kind IN ('earned_sale','return_adjustment')),0)::int
    + COALESCE((SELECT SUM(units) FROM partner_level_adjustments WHERE partner_id=$1),0)::int AS n`, [partnerId]);
  return Math.max(0, r.n);
}

/** Recompute one partner's level (same transaction as the change). Idempotent; records changes in history + audit. */
export async function syncPartnerLevel(tx: Tx, partnerId: string, reason: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('lvl:' || $1::text))`, [partnerId]);
  const units = await qualifiedUnits(tx, partnerId);
  const def = levelFor(await levelDefs(tx), units);
  const prev = await maybeOne<{ level: number; units: number }>(tx, `SELECT level, units FROM partner_level_state WHERE partner_id=$1`, [partnerId]);
  await tx.query(`INSERT INTO partner_level_state (partner_id, units, level, vip_since, updated_at) VALUES ($1,$2::int,$3, CASE WHEN $2::int >= $4::int THEN now() END, now())
    ON CONFLICT (partner_id) DO UPDATE SET units=$2::int, level=$3, vip_since = CASE WHEN $2::int >= $4::int THEN COALESCE(partner_level_state.vip_since, now()) ELSE NULL END, updated_at=now()`,
    [partnerId, units, def.level, VIP_UNITS]);
  if ((prev?.level ?? 0) !== def.level) {
    await tx.query(`INSERT INTO partner_level_history (partner_id, from_level, to_level, units, reason) VALUES ($1,$2,$3,$4,$5)`, [partnerId, prev?.level ?? 0, def.level, units, reason]);
    await audit(tx, null, 'partner.level_changed', { type: 'partner', id: partnerId }, { before: { level: prev?.level ?? 0 }, after: { level: def.level, units }, reason });
  }
  // One coupon per partner ever: issued at 10 000; voided while below the threshold unused; re-activated (same row) on crossing again.
  if (units >= COUPON_UNITS) {
    const c = await tx.query(`INSERT INTO partner_commission_coupons (partner_id) VALUES ($1) ON CONFLICT (partner_id) DO UPDATE SET status = CASE WHEN partner_commission_coupons.status='void' THEN 'available' ELSE partner_commission_coupons.status END, updated_at=now() RETURNING (xmax = 0) AS inserted`, [partnerId]);
    if (c.rows[0]?.inserted) await audit(tx, null, 'partner.coupon_issued', { type: 'partner', id: partnerId }, { after: { units, rate_bps: BENEFIT_BPS } });
  } else {
    await tx.query(`UPDATE partner_commission_coupons SET status='void', updated_at=now() WHERE partner_id=$1 AND status IN ('available','armed')`, [partnerId]);
  }
  return { units, level: def.level };
}

/**
 * Commission snapshot for a NEW order line: 50% only for admin-approved products, for VIP partners or with the armed
 * one-time coupon, and only if unit net − cost − 50% unit ≥ 0 (cost must be known). Matrix coefficients (100/50/25) keep
 * working because only the unit base changes. Returns the (possibly unchanged) rule snapshot.
 */
export async function benefitRule(tx: Tx, partnerId: string | null, orderId: string, line: { productId: string; qty: number; net: bigint; costMinor: bigint | null }, rule: RuleSnapshot | null): Promise<RuleSnapshot | null> {
  if (!rule || !partnerId || line.qty <= 0) return rule;
  if (!(await maybeOne(tx, `SELECT 1 FROM level_benefit_products WHERE product_id=$1 AND enabled`, [line.productId]))) return rule;
  const st = await maybeOne<{ vip_since: string | null }>(tx, `SELECT vip_since FROM partner_level_state WHERE partner_id=$1`, [partnerId]);
  let kind: 'vip' | 'coupon' | null = st?.vip_since ? 'vip' : null;
  let couponId: string | null = null;
  if (!kind) {
    const c = await maybeOne<{ id: string; status: string; order_id: string | null }>(tx, `SELECT id, status, order_id FROM partner_commission_coupons WHERE partner_id=$1 FOR UPDATE`, [partnerId]);
    if (c && (c.status === 'armed' || (c.status === 'reserved' && c.order_id === orderId))) { kind = 'coupon'; couponId = c.id; }
  }
  if (!kind) return rule;
  const unitNet = line.net / BigInt(line.qty);
  const benefitUnit = (unitNet * BigInt(BENEFIT_BPS)) / 10_000n;
  const baseUnit = rule.kind === 'percent' ? (unitNet * BigInt(rule.rate_bps ?? 0)) / 10_000n : BigInt(rule.fixed_minor ?? 0);
  const check = line.costMinor === null ? 'cost_unknown' : unitNet - line.costMinor - benefitUnit < 0n ? 'margin_insufficient' : benefitUnit <= baseUnit ? 'base_already_higher' : 'ok';
  if (check !== 'ok') return { ...rule, benefit_check: { kind, result: check } } as RuleSnapshot;
  if (couponId) await tx.query(`UPDATE partner_commission_coupons SET status='reserved', order_id=$2, updated_at=now() WHERE id=$1`, [couponId, orderId]);
  const base = { kind: rule.kind, version: rule.version, rate_bps: rule.rate_bps, fixed_minor: rule.fixed_minor };
  const next: RuleSnapshot = rule.kind === 'percent' ? { ...rule, rate_bps: BENEFIT_BPS } : { ...rule, fixed_minor: benefitUnit.toString() };
  return { ...next, benefit: { kind, coupon_id: couponId, rate_bps: BENEFIT_BPS, base_rule: base } } as RuleSnapshot;
}

/** Coupon follows its order: used when the order's commission became available; back to armed if it earns nothing. */
export async function syncCouponForOrder(tx: Tx, orderId: string) {
  const c = await maybeOne<{ id: string; status: string }>(tx, `SELECT id, status FROM partner_commission_coupons WHERE order_id=$1 AND status='reserved' FOR UPDATE`, [orderId]);
  if (!c) return;
  const s = await one<{ live: number; avail: number; cancelled: boolean }>(tx, `SELECT COUNT(*) FILTER (WHERE a.state NOT IN ('reversed','superseded') AND a.target_minor > 0)::int AS live,
      COUNT(*) FILTER (WHERE a.state='available' AND a.rule_snapshot ? 'benefit')::int AS avail, (SELECT commercial_status='cancelled' FROM orders WHERE id=$1) AS cancelled
    FROM commission_accruals a WHERE a.order_id=$1`, [orderId]);
  if (s.cancelled || s.live === 0) {
    await tx.query(`UPDATE partner_commission_coupons SET status='armed', order_id=NULL, updated_at=now() WHERE id=$1`, [c.id]);
    await audit(tx, null, 'partner.coupon_released', { type: 'order', id: orderId }, {});
  } else if (s.avail > 0) {
    await tx.query(`UPDATE partner_commission_coupons SET status='used', used_at=now(), updated_at=now() WHERE id=$1`, [c.id]);
    await audit(tx, null, 'partner.coupon_used', { type: 'order', id: orderId }, {});
  }
}

/** Gift discount for a level (+ active promo for that level), capped at 50%. */
export async function giftDiscountBps(q: Queryable, level: number): Promise<number> {
  const d = await maybeOne<{ b: number }>(q, `SELECT gift_discount_bps AS b FROM partner_level_defs WHERE level=$1`, [level]);
  const p = await maybeOne<{ b: number }>(q, `SELECT COALESCE(MAX(extra_discount_bps),0)::int AS b FROM level_promos WHERE min_level <= $1 AND starts_at <= now() AND ends_at > now()`, [level]);
  return Math.min(5000, (d?.b ?? 0) + (p?.b ?? 0));
}
/** Final price after discount: integer coins, discount rounded down (the shop never gives more than the %). */
export const discounted = (price: bigint, bps: number) => { const save = (price * BigInt(bps)) / 10_000n; return { final: price - save, saved: save }; };
