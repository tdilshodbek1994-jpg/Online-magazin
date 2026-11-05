import { divRoundHalfUp } from '@om/shared';
import type { Tx } from '../../platform/db.js';
import { postJournal } from '../finance/journal.js';

/** Share of an amount in basis points, half-up to the tiyin (one rounding policy everywhere). 300 000 × 1% = 3 000. */
export const share = (amountMinor: bigint, bps: number): bigint => divRoundHalfUp(amountMinor * BigInt(bps), 10_000n);

/**
 * Automatic charity share, applied when a commission becomes AVAILABLE (never on pending money).
 * Idempotent per accrual (unique index + ledger effect key). Skips: no rule / not active / before start / unverified
 * proxy order / monthly cap reached. The available-balance CHECK (>= 0) makes payout vs charity double-spend impossible.
 */
export async function applyCharityAuto(tx: Tx, a: { id: string; partner_id: string; order_id: string; target_minor: string | number }): Promise<bigint> {
  const rule = (await tx.query(`SELECT * FROM charity_rules WHERE partner_id=$1 AND status='active' AND starts_at <= now()`, [a.partner_id])).rows[0];
  if (!rule) return 0n;
  // A proxy order the customer never confirmed independently gives no charity share (task §4, #13).
  const o = (await tx.query(`SELECT channel, confirmation_status FROM orders WHERE id=$1`, [a.order_id])).rows[0];
  if (!o || (o.channel === 'partner_assisted' && o.confirmation_status !== 'verified')) return 0n;
  const commission = BigInt(a.target_minor);
  let amt = share(commission, rule.percent_bps);
  if (rule.monthly_cap_minor) {
    const used = BigInt((await tx.query(`SELECT COALESCE(SUM(amount_minor),0)::text AS s FROM charity_donations WHERE partner_id=$1 AND source='auto' AND status='transferred_to_fund'
        AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'`, [a.partner_id])).rows[0].s);
    const left = BigInt(rule.monthly_cap_minor) - used;
    if (left <= 0n) return 0n;
    if (amt > left) amt = left;
  }
  if (amt <= 0n) return 0n;
  const d = await tx.query(
    `INSERT INTO charity_donations (partner_id, amount_minor, fund_id, source, status, commission_accrual_id, commission_amount_minor, percent_bps, rule_version)
     VALUES ($1,$2,$3,'auto','transferred_to_fund',$4,$5,$6,$7) ON CONFLICT (commission_accrual_id) WHERE commission_accrual_id IS NOT NULL DO NOTHING RETURNING id`,
    [a.partner_id, amt.toString(), rule.fund_id, a.id, commission.toString(), rule.percent_bps, rule.version]);
  if (!d.rowCount) return 0n; // already applied for this commission
  const id = d.rows[0].id as string;
  const { transfer } = await import('../commissions/service.js');
  await transfer(tx, { partnerId: a.partner_id, from: 'available', to: 'external', amount: amt, sourceType: 'charity', sourceId: id, effectKey: 'auto', reason: 'avtomatik hayriya ulushi' });
  await postJournal(tx, `charity:${id}`, 'charity_donation', [{ account: 'partner_payable', debit: amt }, { account: 'charity_fund', credit: amt }]);
  return amt;
}
