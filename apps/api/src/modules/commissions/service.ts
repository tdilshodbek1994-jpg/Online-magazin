import { divRoundHalfUp } from '@om/shared';
import type { Queryable, Tx } from '../../platform/db.js';
import { postJournal } from '../finance/journal.js';
import { maskedNumber, notifyPartner } from '../notifications/telegram.js';

export type Bucket = 'external' | 'estimated' | 'pending' | 'available' | 'reserved' | 'paid' | 'debt';
const COL: Record<Exclude<Bucket, 'external'>, string> = {
  estimated: 'estimated_minor', pending: 'pending_minor', available: 'available_minor', reserved: 'reserved_minor', paid: 'paid_minor', debt: 'debt_minor',
};

/**
 * Append-only transfer between partner buckets; unique (source_type, source_id, effect_key) makes every
 * business effect idempotent (Appendix C §3). Projection updated in the same transaction; CHECK
 * constraints refuse negative available/reserved, so concurrent payouts cannot double-reserve (T078).
 */
export async function transfer(
  tx: Tx,
  t: { partnerId: string; from: Bucket; to: Bucket; amount: bigint; sourceType: string; sourceId: string; effectKey: string; reason?: string; actorId?: string | null },
): Promise<boolean> {
  if (t.amount <= 0n) return false;
  const ins = await tx.query(
    `INSERT INTO partner_ledger (partner_id, from_bucket, to_bucket, amount_minor, source_type, source_id, effect_key, reason, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_type, source_id, effect_key) DO NOTHING RETURNING id`,
    [t.partnerId, t.from, t.to, t.amount.toString(), t.sourceType, t.sourceId, t.effectKey, t.reason ?? null, t.actorId ?? null],
  );
  if (!ins.rowCount) return false;
  await tx.query(`INSERT INTO partner_balances (partner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [t.partnerId]);
  const sets: string[] = [];
  if (t.from !== 'external') sets.push(`${COL[t.from]} = ${COL[t.from]} - $2`);
  if (t.to !== 'external') sets.push(`${COL[t.to]} = ${COL[t.to]} + $2`);
  await tx.query(`UPDATE partner_balances SET ${sets.join(', ')}, updated_at=now() WHERE partner_id=$1`, [t.partnerId, t.amount.toString()]);
  return true;
}

/** Rebuild balances from the immutable journal (Appendix C §9). */
export async function rebuildBalances(q: Queryable, partnerId: string): Promise<Record<string, string>> {
  const r = await q.query(
    `SELECT b, SUM(delta)::bigint AS v FROM (
        SELECT to_bucket AS b, amount_minor AS delta FROM partner_ledger WHERE partner_id=$1
        UNION ALL SELECT from_bucket, -amount_minor FROM partner_ledger WHERE partner_id=$1) x
      WHERE b <> 'external' GROUP BY b`,
    [partnerId],
  );
  const out: Record<string, string> = { estimated: '0', pending: '0', available: '0', reserved: '0', paid: '0', debt: '0' };
  for (const row of r.rows) out[row.b] = String(row.v);
  return out;
}

export interface RuleSnapshot {
  rule_id: string;
  version: number;
  kind: 'percent' | 'fixed_per_unit';
  rate_bps: number | null;
  fixed_minor: string | null;
  basis: string;
}

export async function ruleForProduct(q: Queryable, productId: string, at: Date = new Date()): Promise<RuleSnapshot | null> {
  const r = await q.query(
    `SELECT id, version, kind, rate_bps, fixed_minor, basis FROM commission_rules
      WHERE product_id=$1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
      ORDER BY version DESC LIMIT 1`,
    [productId, at],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return { rule_id: x.id, version: x.version, kind: x.kind, rate_bps: x.rate_bps, fixed_minor: x.fixed_minor, basis: x.basis };
}

export interface LineFacts {
  qty: number;
  canceledQty: number;
  returnedQty: number;
  lineNet: bigint;
  refundedProduct: bigint;
}

/**
 * Commission target (§19, MASTER 9.3). One formula over retained facts, so a refund is never applied
 * twice as both a quantity and a value reversal (T077).
 *  percent: round(bps × (line_net − refunded_product − canceled share) / 10000)
 *  fixed:   fixed × retained_qty × (retained_base − value_refund) / retained_base
 */
export function computeTarget(rule: RuleSnapshot, f: LineFacts): bigint {
  if (f.qty <= 0) return 0n;
  const qty = BigInt(f.qty);
  const removedQty = BigInt(f.canceledQty + f.returnedQty);
  const retainedQty = qty - removedQty;
  if (retainedQty <= 0n) return 0n;
  const canceledShare = (f.lineNet * BigInt(f.canceledQty)) / qty;
  const returnedShare = (f.lineNet * BigInt(f.returnedQty)) / qty;
  const retainedBase = f.lineNet - canceledShare - returnedShare;
  const valueRefund = f.refundedProduct > returnedShare ? f.refundedProduct - returnedShare : 0n;
  const netRetained = retainedBase - valueRefund > 0n ? retainedBase - valueRefund : 0n;
  if (rule.kind === 'percent') return divRoundHalfUp(netRetained * BigInt(rule.rate_bps!), 10_000n);
  const fixed = BigInt(rule.fixed_minor!);
  if (retainedBase === 0n) return 0n;
  return divRoundHalfUp(fixed * retainedQty * netRetained, retainedBase);
}

/** Create the accrual at order creation (state estimated). No rule => no commission promised. */
export async function accrueForOrder(tx: Tx, orderId: string, partnerId: string): Promise<void> {
  const lines = await tx.query(`SELECT id, qty, line_net_minor, commission_rule_snapshot FROM order_lines WHERE order_id=$1`, [orderId]);
  for (const l of lines.rows) {
    const rule = l.commission_rule_snapshot as RuleSnapshot | null;
    if (!rule) continue;
    const target = computeTarget(rule, { qty: l.qty, canceledQty: 0, returnedQty: 0, lineNet: BigInt(l.line_net_minor), refundedProduct: 0n });
    const ins = await tx.query(
      `INSERT INTO commission_accruals (order_line_id, order_id, partner_id, rule_snapshot, target_minor, state)
       VALUES ($1,$2,$3,$4,$5,'estimated') ON CONFLICT (order_line_id) WHERE state <> 'superseded' DO NOTHING RETURNING id`,
      [l.id, orderId, partnerId, JSON.stringify(rule), target.toString()],
    );
    if (ins.rowCount) {
      await transfer(tx, { partnerId, from: 'external', to: 'estimated', amount: target, sourceType: 'accrual', sourceId: ins.rows[0].id, effectKey: 'v1:estimated', reason: 'order_created' });
    }
  }
  const info = await tx.query(
    `SELECT o.number, l.name AS stream,
            (SELECT string_agg((ol.product_snapshot->'name'->>'uz-Latn') || ' × ' || ol.qty, ', ') FROM order_lines ol WHERE ol.order_id=o.id) AS products,
            (SELECT COALESCE(SUM(target_minor),0)::text FROM commission_accruals WHERE order_id=o.id AND state <> 'superseded') AS amount
       FROM orders o LEFT JOIN referral_links l ON l.id::text = o.attribution->>'link_id' WHERE o.id=$1`, [orderId]);
  const i = info.rows[0];
  if (i) await notifyPartner(tx, partnerId, 'partner.order_new', { number: maskedNumber(i.number), products: i.products, stream: i.stream, amount_minor: i.amount }, `p:new:${orderId}`);
}

/**
 * Recompute targets for an order from current line facts and journal only the difference against the
 * bucket where the money currently sits. Under a row lock, so retries/parallel events are no-ops.
 */
export async function recalcOrder(tx: Tx, orderId: string, reason: string, actorId: string | null = null): Promise<void> {
  const rows = await tx.query(
    `SELECT a.*, ol.qty, ol.canceled_qty, ol.returned_qty, ol.line_net_minor, ol.refunded_product_minor
       FROM commission_accruals a JOIN order_lines ol ON ol.id = a.order_line_id
      WHERE a.order_id=$1 AND a.state <> 'superseded' ORDER BY a.id FOR UPDATE OF a`,
    [orderId],
  );
  const order = await tx.query(`SELECT commercial_status FROM orders WHERE id=$1`, [orderId]);
  const cancelled = order.rows[0]?.commercial_status === 'cancelled';
  for (const a of rows.rows) {
    const rule = a.rule_snapshot as RuleSnapshot;
    const newTarget = cancelled ? 0n : computeTarget(rule, { qty: a.qty, canceledQty: a.canceled_qty, returnedQty: a.returned_qty, lineNet: BigInt(a.line_net_minor), refundedProduct: BigInt(a.refunded_product_minor) });
    const old = BigInt(a.target_minor);
    if (newTarget === old) continue;
    const v = a.version + 1;
    const delta = newTarget - old;
    const state = a.state as 'estimated' | 'pending' | 'available' | 'reversed';
    const bucket: Bucket = state === 'reversed' ? 'estimated' : state;
    const base = { partnerId: a.partner_id, sourceType: 'accrual', sourceId: a.id, reason, actorId };
    if (delta > 0n) {
      await transfer(tx, { ...base, from: 'external', to: bucket, amount: delta, effectKey: `v${v}:${bucket}` });
      if (bucket === 'available') await postJournal(tx, `commission:${a.id}:v${v}`, 'commission_available', [{ account: 'commission_expense', debit: delta }, { account: 'partner_payable', credit: delta }]);
    } else {
      const dec = -delta;
      if (bucket === 'available') {
        const bal = await tx.query(`SELECT available_minor FROM partner_balances WHERE partner_id=$1 FOR UPDATE`, [a.partner_id]);
        const avail = BigInt(bal.rows[0]?.available_minor ?? 0);
        const fromAvail = avail >= dec ? dec : avail;
        await transfer(tx, { ...base, from: 'available', to: 'external', amount: fromAvail, effectKey: `v${v}:available` });
        // Already reserved/paid: record a visible debt instead of hiding a negative balance (§20, T080).
        await transfer(tx, { ...base, from: 'debt', to: 'external', amount: dec - fromAvail, effectKey: `v${v}:debt` });
        await postJournal(tx, `commission:${a.id}:v${v}`, 'commission_reversal', [{ account: 'partner_payable', debit: dec }, { account: 'commission_expense', credit: dec }]);
      } else {
        await transfer(tx, { ...base, from: bucket, to: 'external', amount: dec, effectKey: `v${v}:${bucket}` });
      }
    }
    await tx.query(
      `UPDATE commission_accruals SET target_minor=$2, state=CASE WHEN $2::bigint = 0 THEN 'reversed' ELSE state END, version=$3 WHERE id=$1`,
      [a.id, newTarget.toString(), v],
    );
  }
  // Tell the partner once when the whole order no longer earns anything (cancel / full return).
  const left = await tx.query(`SELECT partner_id, COUNT(*) FILTER (WHERE state <> 'reversed')::int AS live, COUNT(*)::int AS n FROM commission_accruals WHERE order_id=$1 AND state <> 'superseded' GROUP BY partner_id`, [orderId]);
  for (const r of left.rows) {
    if (r.n > 0 && r.live === 0) {
      const num = await tx.query(`SELECT number FROM orders WHERE id=$1`, [orderId]);
      await notifyPartner(tx, r.partner_id, 'partner.order_cancelled', { number: maskedNumber(num.rows[0].number) }, `p:rev:${orderId}`);
    }
  }
}

/**
 * estimated -> pending once all facts hold: customer confirmed, delivered, and payment settled
 * (online paid or COD remitted & reconciled). Hold deadline from approved/demo policy; without a
 * policy, no automatic release date is set (§19).
 */
export async function promoteToPending(tx: Tx, orderId: string, holdDays: number | null): Promise<void> {
  const o = await tx.query(`SELECT confirmation_status, fulfillment_status, payment_status, delivered_at FROM orders WHERE id=$1`, [orderId]);
  const x = o.rows[0];
  if (!x || x.confirmation_status !== 'verified' || x.fulfillment_status !== 'delivered' || !['paid', 'partially_refunded'].includes(x.payment_status)) return;
  const acc = await tx.query(`SELECT * FROM commission_accruals WHERE order_id=$1 AND state='estimated' AND target_minor > 0 FOR UPDATE`, [orderId]);
  for (const a of acc.rows) {
    const v = a.version + 1;
    await transfer(tx, { partnerId: a.partner_id, from: 'estimated', to: 'pending', amount: BigInt(a.target_minor), sourceType: 'accrual', sourceId: a.id, effectKey: `v${v}:pending`, reason: 'delivered_and_settled' });
    await tx.query(
      `UPDATE commission_accruals SET state='pending', pending_at=now(), version=$2,
         available_after = CASE WHEN $3::int IS NULL THEN NULL ELSE $4::timestamptz + make_interval(days => $3::int) END WHERE id=$1`,
      [a.id, v, holdDays, x.delivered_at],
    );
  }
  if (acc.rows.length) {
    const num = await tx.query(`SELECT number FROM orders WHERE id=$1`, [orderId]);
    const byPartner = new Map<string, bigint>();
    for (const a of acc.rows) byPartner.set(a.partner_id, (byPartner.get(a.partner_id) ?? 0n) + BigInt(a.target_minor));
    for (const [pid, amt] of byPartner) await notifyPartner(tx, pid, 'partner.order_delivered', { number: maskedNumber(num.rows[0].number), amount_minor: amt.toString() }, `p:deliv:${orderId}:${pid}`);
  }
}

/** pending -> available after hold, when no open return/dispute exists for the order. */
export async function releaseMatured(tx: Tx, now: Date = new Date()): Promise<number> {
  const acc = await tx.query(
    `SELECT a.* FROM commission_accruals a
      WHERE a.state='pending' AND a.available_after IS NOT NULL AND a.available_after <= $1
        AND NOT EXISTS (SELECT 1 FROM return_requests r WHERE r.order_id=a.order_id AND r.status NOT IN ('resolved','rejected'))
        AND NOT EXISTS (SELECT 1 FROM partner_disputes d WHERE d.order_id=a.order_id AND d.status='open')
      ORDER BY a.id FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const a of acc.rows) {
    const v = a.version + 1;
    const amt = BigInt(a.target_minor);
    await transfer(tx, { partnerId: a.partner_id, from: 'pending', to: 'available', amount: amt, sourceType: 'accrual', sourceId: a.id, effectKey: `v${v}:available`, reason: 'hold_elapsed' });
    await postJournal(tx, `commission:${a.id}:v${v}`, 'commission_available', [{ account: 'commission_expense', debit: amt }, { account: 'partner_payable', credit: amt }]);
    await tx.query(`UPDATE commission_accruals SET state='available', available_at=now(), version=$2 WHERE id=$1`, [a.id, v]);
    await notifyPartner(tx, a.partner_id, 'partner.commission_available', { amount_minor: amt.toString() }, `p:avail:${a.id}`);
  }
  return acc.rowCount ?? 0;
}
