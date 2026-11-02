import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../platform/db.js';
import { withTx } from '../../platform/db.js';
import { capturePayment } from './service.js';

/**
 * CLICK Shop API adapter: Prepare (action=0) / Complete (action=1), MD5 sign_string [S4].
 * Amount arrives in so'm with decimals ("1000.00") and is converted to integer tiyin without floats (T066).
 * Status: contract-tested with fixtures; NOT live-verified (needs service_id, merchant_id, secret key).
 */
export function somStringToTiyin(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'));
}

export function clickSign(f: Record<string, string>, secret: string, action: number): string {
  const parts = [f.click_trans_id, f.service_id, secret, f.merchant_trans_id, ...(action === 1 ? [f.merchant_prepare_id] : []), f.amount, f.action, f.sign_time];
  return createHash('md5').update(parts.map((x) => x ?? '').join('')).digest('hex');
}

export async function handleClick(db: Db, cfg: AppConfig, action: 0 | 1, f: Record<string, string>): Promise<Record<string, unknown>> {
  const base = { click_trans_id: f.click_trans_id, merchant_trans_id: f.merchant_trans_id };
  const fail = (error: number, error_note: string) => ({ ...base, error, error_note });
  const expected = clickSign(f, cfg.payments.click.secretKey, action);
  const got = Buffer.from(String(f.sign_string ?? ''));
  if (got.length !== expected.length || !timingSafeEqual(got, Buffer.from(expected)) || f.service_id !== cfg.payments.click.serviceId) return fail(-1, 'SIGN CHECK FAILED');
  if (String(action) !== f.action) return fail(-3, 'Action not found');
  const amount = somStringToTiyin(f.amount ?? '');
  if (amount === null) return fail(-2, 'Incorrect parameter amount');
  return withTx(db, async (tx) => {
    await tx.query(`INSERT INTO provider_events (provider, event_key, signature_valid, payload) VALUES ('click',$1,true,$2) ON CONFLICT DO NOTHING`, [`${f.click_trans_id}:${action}:${f.error ?? '0'}`, JSON.stringify(f)]);
    const o = (await tx.query(`SELECT o.id, o.payment_method, o.commercial_status, pi.id AS intent_id, pi.amount_minor, pi.captured_minor FROM orders o JOIN payment_intents pi ON pi.order_id=o.id WHERE o.id::text=$1 FOR UPDATE OF o`, [f.merchant_trans_id])).rows[0];
    if (!o) return fail(-5, 'Order does not exist');
    if (BigInt(o.amount_minor) !== amount) return fail(-2, 'Incorrect parameter amount');
    if (action === 0) {
      if (o.payment_method !== 'online' || o.commercial_status !== 'confirmed') return fail(-9, 'Transaction cancelled');
      const ex = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='click' AND provider_ref=$1`, [f.click_trans_id])).rows[0];
      if (ex) return { ...base, merchant_prepare_id: ex.id, error: ex.status === 'succeeded' ? -4 : 0, error_note: ex.status === 'succeeded' ? 'Already paid' : 'Success' };
      if (BigInt(o.captured_minor) >= BigInt(o.amount_minor)) return fail(-4, 'Already paid');
      const a = (await tx.query(`INSERT INTO payment_attempts (intent_id, provider, amount_minor, status, provider_ref, provider_state) VALUES ($1,'click',$2,'pending',$3,$4) RETURNING id`, [o.intent_id, amount.toString(), f.click_trans_id, JSON.stringify({ prepared: true })])).rows[0];
      await tx.query(`UPDATE orders SET payment_status='pending' WHERE id=$1 AND payment_status='unpaid'`, [o.id]);
      return { ...base, merchant_prepare_id: a.id, error: 0, error_note: 'Success' };
    }
    const a = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='click' AND provider_ref=$1 AND id::text=$2 FOR UPDATE`, [f.click_trans_id, f.merchant_prepare_id])).rows[0];
    if (!a) return fail(-6, 'Transaction does not exist');
    if (a.status === 'succeeded') return { ...base, merchant_confirm_id: a.id, error: -4, error_note: 'Already paid' };
    if (a.status === 'canceled') return fail(-9, 'Transaction cancelled');
    if (Number(f.error) < 0) {
      await tx.query(`UPDATE payment_attempts SET status='canceled', failure_code=$2, updated_at=now() WHERE id=$1`, [a.id, f.error]);
      await tx.query(`UPDATE orders SET payment_status='unpaid' WHERE id=$1 AND payment_status='pending'`, [o.id]);
      return fail(-9, 'Transaction cancelled');
    }
    await capturePayment(tx, cfg.env, a.id, null);
    return { ...base, merchant_confirm_id: a.id, error: 0, error_note: 'Success' };
  });
}
