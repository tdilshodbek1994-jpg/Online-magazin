import type { Actor } from '../../platform/auth.js';
import type { Tx } from '../../platform/db.js';
import { emit } from '../../platform/outbox.js';
import { getPolicy, POLICY } from '../../platform/policies.js';
import { promoteToPending } from '../commissions/service.js';
import { postJournal } from '../finance/journal.js';
import { reserveForOrder } from '../inventory/service.js';
import { statusEvent } from '../orders/service.js';
import { maybeRecognizeSale } from '../tracking/service.js';

/**
 * Apply an authenticated provider capture (never a browser redirect — T061, INV06).
 * Idempotent per attempt; a second real payment for an already-paid order becomes an excess payment
 * in reconciliation, never silently dropped (T067, INV22). Late payment after reservation expiry
 * re-checks stock; if gone → "paid, fulfilment problem" exception, no negative stock (T055).
 */
export async function capturePayment(tx: Tx, env: string, attemptId: string, actor: Actor | null): Promise<'captured' | 'excess' | 'already'> {
  const a = (await tx.query(`SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE`, [attemptId])).rows[0];
  if (a.status === 'succeeded') return 'already';
  const pi = (await tx.query(`SELECT * FROM payment_intents WHERE id=$1 FOR UPDATE`, [a.intent_id])).rows[0];
  await tx.query(`UPDATE payment_attempts SET status='succeeded', updated_at=now() WHERE id=$1`, [attemptId]);
  if (BigInt(pi.captured_minor) >= BigInt(pi.amount_minor)) {
    await tx.query(`INSERT INTO excess_payments (order_id, attempt_id, amount_minor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [pi.order_id, attemptId, a.amount_minor]);
    await tx.query(`INSERT INTO finance_exceptions (kind, ref_type, ref_id, amount_minor, details) VALUES ('extra_payment','payment_attempt',$1,$2,$3) ON CONFLICT DO NOTHING`, [attemptId, a.amount_minor, JSON.stringify({ order_id: pi.order_id, provider: a.provider })]);
    await postJournal(tx, `capture:${attemptId}`, 'excess_payment', [{ account: 'psp_receivable', debit: BigInt(a.amount_minor) }, { account: 'suspense', credit: BigInt(a.amount_minor) }]);
    await emit(tx, { type: 'ExcessPaymentDetected', aggregateType: 'order', aggregateId: pi.order_id, payload: { attempt_id: attemptId } });
    return 'excess';
  }
  await tx.query(`UPDATE payment_intents SET captured_minor=$2, status='succeeded', version=version+1, updated_at=now() WHERE id=$1`, [pi.id, a.amount_minor]);
  await postJournal(tx, `capture:${attemptId}`, 'payment_captured', [{ account: 'psp_receivable', debit: BigInt(a.amount_minor) }, { account: 'sales_clearing', credit: BigInt(a.amount_minor) }]);
  const o = (await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [pi.order_id])).rows[0];
  await tx.query(`UPDATE orders SET payment_status='paid', paid_at=now(), version=version+1 WHERE id=$1`, [o.id]);
  await statusEvent(tx, o.id, 'payment', o.payment_status, 'paid', actor, a.provider);
  await maybeRecognizeSale(tx, o.id); // prepaid: captured payment is the recognition moment (never authorization)
  const live = await tx.query(`UPDATE reservations SET status='allocated_for_fulfillment', expires_at=NULL, version=version+1 WHERE order_id=$1 AND status='active_unpaid' RETURNING id`, [o.id]);
  if (!live.rowCount) {
    const allocated = await tx.query(`SELECT 1 FROM reservations WHERE order_id=$1 AND status IN ('allocated_for_fulfillment','consumed_on_dispatch')`, [o.id]);
    if (!allocated.rowCount && o.commercial_status !== 'cancelled') {
      const lines = await tx.query(`SELECT id, sku_id, merchant_org_id, qty FROM order_lines WHERE order_id=$1`, [o.id]);
      await tx.query('SAVEPOINT late');
      try {
        await reserveForOrder(tx, o.id, lines.rows.map((l) => ({ orderLineId: l.id, skuId: l.sku_id, merchantOrgId: l.merchant_org_id, qty: l.qty })), 'allocated_for_fulfillment', null);
        await tx.query('RELEASE SAVEPOINT late');
        await tx.query(`UPDATE orders SET fulfillment_status='reserved' WHERE id=$1`, [o.id]);
      } catch (e) {
        if ((e as { code?: string }).code !== 'OUT_OF_STOCK') throw e;
        await tx.query('ROLLBACK TO SAVEPOINT late');
        await tx.query(`UPDATE orders SET problem_reason='paid_no_stock' WHERE id=$1`, [o.id]);
        await tx.query(`INSERT INTO finance_exceptions (kind, ref_type, ref_id, amount_minor) VALUES ('late_payment_no_stock','order',$1,$2) ON CONFLICT DO NOTHING`, [o.id, a.amount_minor]);
      }
    }
  }
  if (o.fulfillment_status === 'delivered') {
    await tx.query(`UPDATE orders SET commercial_status='completed' WHERE id=$1`, [o.id]);
    const hold = await getPolicy<{ days: number }>(tx, POLICY.commissionHoldDays, env);
    await promoteToPending(tx, o.id, hold?.value.days ?? null);
  }
  await emit(tx, { type: 'PaymentSucceeded', aggregateType: 'order', aggregateId: o.id, payload: { attempt_id: attemptId, provider: a.provider, amount_minor: a.amount_minor } });
  return 'captured';
}
