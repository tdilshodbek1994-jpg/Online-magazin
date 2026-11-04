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
  kind: 'percent' | 'fixed_per_unit' | 'quantity_matrix';
  rate_bps: number | null;
  fixed_minor: string | null;   // fixed_per_unit: per unit; quantity_matrix: base commission
  basis: string;
  commission_group?: string | null;
  quantity_matrix?: Record<string, number[]> | null;   // {"2":[10000,2500]} = bps of base per unit position
  rounding_policy?: string;
  return_policy?: string;
}

export async function ruleForProduct(q: Queryable, productId: string, at: Date = new Date()): Promise<RuleSnapshot | null> {
  const r = await q.query(
    `SELECT id, version, kind, rate_bps, fixed_minor, basis, commission_group, quantity_matrix, rounding_policy, return_policy, product_id FROM commission_rules
      WHERE product_id=$1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
        -- Quantity-matrix rules only take effect while their feature flag is on (independent activation, §23).
        AND (kind <> 'quantity_matrix' OR COALESCE((SELECT enabled FROM feature_flags WHERE key='commission.quantity_matrix'), false))
      ORDER BY version DESC LIMIT 1`,
    [productId, at],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  const snap: RuleSnapshot = { rule_id: x.id, version: x.version, kind: x.kind, rate_bps: x.rate_bps, fixed_minor: x.fixed_minor, basis: x.basis };
  if (x.kind === 'quantity_matrix') Object.assign(snap, { commission_group: x.commission_group ?? `product:${x.product_id}`, quantity_matrix: x.quantity_matrix, rounding_policy: x.rounding_policy, return_policy: x.return_policy });
  return snap;
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

/** Amount for `n` retained units of a quantity-matrix group; null = no approved rule for n (review, never invented). */
export function matrixUnitAmounts(rule: Pick<RuleSnapshot, 'fixed_minor' | 'quantity_matrix'>, n: number): bigint[] | null {
  if (n <= 0) return [];
  const w = rule.quantity_matrix?.[String(n)];
  if (!w || w.length !== n) return null;
  const base = BigInt(rule.fixed_minor!);
  // Rounding policy per_unit_half_up: each unit amount is rounded, the group total is their sum.
  return w.map((bps) => divRoundHalfUp(base * BigInt(bps), 10_000n));
}

/** 1/2/3/4 preview for admins and partners — the same function the orders use. */
export function matrixPreview(rule: Pick<RuleSnapshot, 'fixed_minor' | 'quantity_matrix'>, upTo = 4): { qty: number; total_minor: string | null; units_minor: string[] | null }[] {
  return Array.from({ length: upTo }, (_, i) => {
    const u = matrixUnitAmounts(rule, i + 1);
    return { qty: i + 1, total_minor: u ? u.reduce((a, b) => a + b, 0n).toString() : null, units_minor: u ? u.map(String) : null };
  });
}

export interface OrderLineFacts extends LineFacts { id: string; rule: RuleSnapshot | null; /** per-unit discount the partner gave the customer (paid from their commission) */ partnerDiscountUnit?: bigint }
export interface LineTarget { target: bigint; group: string | null; groupQty: number | null; review: string | null }

/**
 * THE commission calculation for an order (spec §2: one versioned server function for orders, wallet,
 * previews and analytics). percent/fixed lines use computeTarget; quantity-matrix lines are grouped by
 * (rule version, commission group) inside the order, so splitting a group over several lines never grants
 * the 100% unit twice (T04). Retained units (qty − canceled − returned) decide the matrix row (return policy
 * recompute_retained_qty: 3→2 units = 52 500 → 37 500). Unit amounts are assigned to lines by position in line order.
 * A money-only refund does not change matrix commission (goodwill ≠ quantity return, T14).
 */
export function computeOrderTargets(input: OrderLineFacts[]): Map<string, LineTarget> {
  const raw = computeOrderTargetsRaw(input.map((l) => (l.partnerDiscountUnit ? { ...l, lineNet: l.lineNet + l.partnerDiscountUnit * BigInt(l.qty) } : l)));
  // Partner-funded customer discount comes out of the partner's commission, never below zero.
  for (const l of input) {
    const d = l.partnerDiscountUnit ?? 0n;
    if (d <= 0n) continue;
    const t = raw.get(l.id)!;
    const retained = BigInt(Math.max(0, l.qty - l.canceledQty - l.returnedQty));
    const left = t.target - d * retained;
    raw.set(l.id, { ...t, target: left > 0n ? left : 0n });
  }
  return raw;
}

function computeOrderTargetsRaw(lines: OrderLineFacts[]): Map<string, LineTarget> {
  const out = new Map<string, LineTarget>();
  const groups = new Map<string, OrderLineFacts[]>();
  for (const l of lines) {
    if (!l.rule) { out.set(l.id, { target: 0n, group: null, groupQty: null, review: null }); continue; }
    if (l.rule.kind !== 'quantity_matrix') { out.set(l.id, { target: computeTarget(l.rule, l), group: null, groupQty: null, review: null }); continue; }
    const key = `${l.rule.rule_id}|${l.rule.commission_group ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const g of groups.values()) {
    const retained = g.map((l) => Math.max(0, l.qty - l.canceledQty - l.returnedQty));
    const n = retained.reduce((a, b) => a + b, 0);
    const units = matrixUnitAmounts(g[0]!.rule!, n);
    const group = g[0]!.rule!.commission_group ?? null;
    let pos = 0;
    g.forEach((l, i) => {
      let t = 0n;
      if (units) for (let k = 0; k < retained[i]!; k++) t += units[pos++] ?? 0n;
      out.set(l.id, { target: units ? t : 0n, group, groupQty: n, review: units ? null : `qty_${n}_no_rule` });
    });
  }
  return out;
}

/** Estimate for quotes/drafts/simulation (same function as real orders). */
export async function estimateCommission(q: Queryable, lines: { key: string; productId: string; qty: number; lineNet: bigint; partnerDiscountUnit?: bigint }[]): Promise<{ total: bigint; lines: { key: string; rule: RuleSnapshot | null; amount_minor: string; review: string | null }[]; review: boolean }> {
  const facts: OrderLineFacts[] = [];
  for (const l of lines) facts.push({ id: l.key, rule: await ruleForProduct(q, l.productId), partnerDiscountUnit: l.partnerDiscountUnit, qty: l.qty, canceledQty: 0, returnedQty: 0, lineNet: l.lineNet, refundedProduct: 0n });
  const m = computeOrderTargets(facts);
  let total = 0n, review = false;
  const res = facts.map((f) => { const t = m.get(f.id)!; total += t.target; if (t.review) review = true; return { key: f.id, rule: f.rule, amount_minor: t.target.toString(), review: t.review }; });
  return { total, lines: res, review };
}

/** Create the accrual at order creation (state estimated). No rule => no commission promised. */
export async function accrueForOrder(tx: Tx, orderId: string, partnerId: string): Promise<void> {
  const lines = await tx.query(`SELECT id, qty, line_net_minor, commission_rule_snapshot, partner_discount_minor FROM order_lines WHERE order_id=$1 ORDER BY id`, [orderId]);
  const targets = computeOrderTargets(lines.rows.map((l) => ({ id: l.id, rule: l.commission_rule_snapshot as RuleSnapshot | null, partnerDiscountUnit: BigInt(l.partner_discount_minor ?? 0), qty: l.qty, canceledQty: 0, returnedQty: 0, lineNet: BigInt(l.line_net_minor), refundedProduct: 0n })));
  for (const l of lines.rows) {
    const rule = l.commission_rule_snapshot as RuleSnapshot | null;
    if (!rule) continue;
    const tg = targets.get(l.id)!;
    const target = tg.target;
    const ins = await tx.query(
      `INSERT INTO commission_accruals (order_line_id, order_id, partner_id, rule_snapshot, target_minor, state, commission_group, group_qty, review_required, review_reason)
       VALUES ($1,$2,$3,$4,$5,'estimated',$6,$7,$8,$9) ON CONFLICT (order_line_id) WHERE state <> 'superseded' DO NOTHING RETURNING id`,
      [l.id, orderId, partnerId, JSON.stringify(rule), target.toString(), tg.group, tg.groupQty, !!tg.review, tg.review],
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
    `SELECT a.*, ol.qty, ol.canceled_qty, ol.returned_qty, ol.line_net_minor, ol.refunded_product_minor, ol.partner_discount_minor
       FROM commission_accruals a JOIN order_lines ol ON ol.id = a.order_line_id
      WHERE a.order_id=$1 AND a.state <> 'superseded' ORDER BY ol.id FOR UPDATE OF a`,
    [orderId],
  );
  const order = await tx.query(`SELECT commercial_status FROM orders WHERE id=$1`, [orderId]);
  const cancelled = order.rows[0]?.commercial_status === 'cancelled';
  const targets = computeOrderTargets(rows.rows.map((a) => ({ id: a.id, rule: a.rule_snapshot as RuleSnapshot, partnerDiscountUnit: BigInt(a.partner_discount_minor ?? 0), qty: a.qty, canceledQty: a.canceled_qty, returnedQty: a.returned_qty, lineNet: BigInt(a.line_net_minor), refundedProduct: BigInt(a.refunded_product_minor) })));
  for (const a of rows.rows) {
    const tg = targets.get(a.id)!;
    const newTarget = cancelled ? 0n : tg.target;
    const old = BigInt(a.target_minor);
    if (tg.groupQty !== null && (tg.groupQty !== a.group_qty || !!tg.review !== a.review_required)) {
      await tx.query(`UPDATE commission_accruals SET group_qty=$2, review_required=$3, review_reason=$4 WHERE id=$1`, [a.id, tg.groupQty, !!tg.review, tg.review]);
    }
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
