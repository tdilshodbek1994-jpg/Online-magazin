import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { Db, Tx } from '../../platform/db.js';
import { withTx } from '../../platform/db.js';
import { releaseReservation } from '../inventory/service.js';
import { capturePayment } from './service.js';
import { recordRefund } from '../tracking/service.js';

/**
 * Payme Business Merchant API adapter (JSON-RPC 2.0, Basic auth "Paycom:<key>", amount in tiyin) [S3].
 * Status: contract-tested against the documented protocol with fixtures. NOT live-verified: needs a
 * merchant contract, cashbox id and key, and a run of Payme's sandbox test suite.
 */
export const PAYME_TIMEOUT_MS = 43_200_000; // 12h transaction timeout per Payme docs

export const PaymeErr = {
  AUTH: -32504, METHOD: -32601, PARSE: -32700, INVALID: -32600,
  AMOUNT: -31001, NOT_FOUND: -31003, CANNOT_CANCEL: -31007, CANNOT_PERFORM: -31008, ORDER_NOT_FOUND: -31050, ORDER_BUSY: -31051, ORDER_STATE: -31052,
} as const;

const msg = (uz: string, ru: string, en: string) => ({ uz, ru, en });

class RpcError extends Error {
  constructor(public code: number, public data?: string, public text = msg('Xatolik', 'Ошибка', 'Error')) {
    super(String(code));
  }
}

export function checkPaymeAuth(header: string | undefined, key: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const expected = Buffer.from(`Paycom:${key}`);
  const got = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8'));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

async function loadOrderForAccount(tx: Tx, account: Record<string, unknown> | undefined, amount: number) {
  const orderId = typeof account?.order_id === 'string' ? account.order_id : null;
  if (!orderId || !/^[0-9a-f-]{36}$/.test(orderId)) throw new RpcError(PaymeErr.ORDER_NOT_FOUND, 'order_id', msg('Buyurtma topilmadi', 'Заказ не найден', 'Order not found'));
  const o = (await tx.query(`SELECT o.*, pi.id AS intent_id, pi.amount_minor AS intent_amount, pi.captured_minor FROM orders o JOIN payment_intents pi ON pi.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o`, [orderId])).rows[0];
  if (!o) throw new RpcError(PaymeErr.ORDER_NOT_FOUND, 'order_id', msg('Buyurtma topilmadi', 'Заказ не найден', 'Order not found'));
  if (o.payment_method !== 'online' || o.commercial_status !== 'confirmed') throw new RpcError(PaymeErr.ORDER_STATE, 'order_id', msg("Buyurtmani to'lab bo'lmaydi", 'Заказ нельзя оплатить', 'Order not payable'));
  // Amount is integer tiyin on both sides — no so'm/tiyin x100 confusion (T066).
  if (!Number.isSafeInteger(amount) || String(amount) !== String(o.intent_amount)) throw new RpcError(PaymeErr.AMOUNT, 'amount', msg("Noto'g'ri summa", 'Неверная сумма', 'Wrong amount'));
  return o;
}

function txView(a: { provider_ref: string; id: string; provider_state: Record<string, number> }) {
  const s = a.provider_state;
  return { create_time: s.create_time ?? 0, perform_time: s.perform_time ?? 0, cancel_time: s.cancel_time ?? 0, transaction: a.id, state: s.state, reason: s.reason ?? null };
}

export async function handlePayme(db: Db, cfg: AppConfig, authHeader: string | undefined, body: unknown): Promise<Record<string, unknown>> {
  const req = (body ?? {}) as { id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id ?? null;
  try {
    if (!checkPaymeAuth(authHeader, cfg.payments.payme.key)) throw new RpcError(PaymeErr.AUTH, undefined, msg("Ruxsat yo'q", 'Недостаточно привилегий', 'Insufficient privilege'));
    if (!req.method || typeof req.params !== 'object') throw new RpcError(PaymeErr.INVALID);
    const p = req.params as Record<string, unknown>;
    const result = await withTx(db, async (tx) => {
      await tx.query(`INSERT INTO provider_events (provider, event_key, signature_valid, payload) VALUES ('payme', $1, true, $2) ON CONFLICT DO NOTHING`, [`${req.method}:${String(p.id ?? '')}:${Date.now()}:${Math.random()}`, JSON.stringify(req)]);
      switch (req.method) {
        case 'CheckPerformTransaction': {
          await loadOrderForAccount(tx, p.account as Record<string, unknown>, Number(p.amount));
          return { allow: true };
        }
        case 'CreateTransaction': {
          const existing = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='payme' AND provider_ref=$1 FOR UPDATE`, [String(p.id)])).rows[0];
          if (existing) {
            if (existing.provider_state.state !== 1) throw new RpcError(PaymeErr.CANNOT_PERFORM);
            if (Date.now() - existing.provider_state.create_time > PAYME_TIMEOUT_MS) {
              await cancelAttempt(tx, existing, 4);
              throw new RpcError(PaymeErr.CANNOT_PERFORM);
            }
            return { create_time: existing.provider_state.create_time, transaction: existing.id, state: 1 };
          }
          const o = await loadOrderForAccount(tx, p.account as Record<string, unknown>, Number(p.amount));
          const busy = await tx.query(`SELECT 1 FROM payment_attempts WHERE intent_id=$1 AND provider='payme' AND status IN ('pending','succeeded')`, [o.intent_id]);
          if (busy.rowCount) throw new RpcError(PaymeErr.ORDER_BUSY, 'order_id', msg('Buyurtma band', 'Заказ занят', 'Order busy'));
          const createTime = Number(p.time) || Date.now();
          const a = (await tx.query(`INSERT INTO payment_attempts (intent_id, provider, amount_minor, status, provider_ref, provider_state) VALUES ($1,'payme',$2,'pending',$3,$4) RETURNING id`,
            [o.intent_id, String(p.amount), String(p.id), JSON.stringify({ state: 1, create_time: createTime })])).rows[0];
          // Provider transaction holds goods for its official timeout, not our generic short TTL (T054).
          await tx.query(`UPDATE reservations SET expires_at = to_timestamp($2::double precision / 1000) + interval '12 hours' WHERE order_id=$1 AND status='active_unpaid'`, [o.id, createTime]);
          await tx.query(`UPDATE orders SET payment_status='pending' WHERE id=$1 AND payment_status='unpaid'`, [o.id]);
          return { create_time: createTime, transaction: a.id, state: 1 };
        }
        case 'PerformTransaction': {
          const a = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='payme' AND provider_ref=$1 FOR UPDATE`, [String(p.id)])).rows[0];
          if (!a) throw new RpcError(PaymeErr.NOT_FOUND);
          const s = a.provider_state;
          if (s.state === 2) return { transaction: a.id, perform_time: s.perform_time, state: 2 }; // idempotent (T064)
          if (s.state !== 1) throw new RpcError(PaymeErr.CANNOT_PERFORM);
          if (Date.now() - s.create_time > PAYME_TIMEOUT_MS) {
            await cancelAttempt(tx, a, 4);
            throw new RpcError(PaymeErr.CANNOT_PERFORM);
          }
          const performTime = Date.now();
          await tx.query(`UPDATE payment_attempts SET provider_state = provider_state || $2::jsonb WHERE id=$1`, [a.id, JSON.stringify({ state: 2, perform_time: performTime })]);
          await capturePayment(tx, cfg.env, a.id, null);
          return { transaction: a.id, perform_time: performTime, state: 2 };
        }
        case 'CancelTransaction': {
          const a = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='payme' AND provider_ref=$1 FOR UPDATE`, [String(p.id)])).rows[0];
          if (!a) throw new RpcError(PaymeErr.NOT_FOUND);
          const s = a.provider_state;
          if (s.state === -1 || s.state === -2) return { transaction: a.id, cancel_time: s.cancel_time, state: s.state };
          if (s.state === 1) {
            await cancelAttempt(tx, a, Number(p.reason) || 0);
            const after = (await tx.query(`SELECT provider_state FROM payment_attempts WHERE id=$1`, [a.id])).rows[0].provider_state;
            return { transaction: a.id, cancel_time: after.cancel_time, state: -1 };
          }
          // Cancel after perform = refund; only possible before shipment, otherwise RMA flow.
          const o = (await tx.query(`SELECT o.id, o.fulfillment_status FROM orders o JOIN payment_intents pi ON pi.order_id=o.id WHERE pi.id=$1 FOR UPDATE OF o`, [a.intent_id])).rows[0];
          if (['shipped', 'delivered'].includes(o.fulfillment_status)) throw new RpcError(PaymeErr.CANNOT_CANCEL);
          const cancelTime = Date.now();
          await tx.query(`UPDATE payment_attempts SET provider_state = provider_state || $2::jsonb WHERE id=$1`, [a.id, JSON.stringify({ state: -2, cancel_time: cancelTime, reason: Number(p.reason) || 0 })]);
          await tx.query(`UPDATE payment_intents SET refunded_minor = LEAST(captured_minor, refunded_minor + $2) WHERE id=$1`, [a.intent_id, a.amount_minor]);
          await tx.query(`INSERT INTO refunds (intent_id, order_id, amount_minor, product_amount_minor, delivery_amount_minor, status, reason, idempotency_key, provider_ref, method)
                          SELECT $1, order_id, $2, 0, $2, 'succeeded', 'payme_cancel_after_perform', $3, $4, 'provider' FROM payment_intents WHERE id=$1 ON CONFLICT DO NOTHING`, [a.intent_id, a.amount_minor, `payme-cancel:${a.id}`, String(p.id)]);
          await tx.query(`UPDATE orders SET payment_status='refunded', refund_status='full', commercial_status='cancelled', cancel_reason='payme_cancelled_after_perform' WHERE id=$1`, [o.id]);
          await releaseReservation(tx, o.id, 'released');
          const { recalcOrder } = await import('../commissions/service.js');
          await recalcOrder(tx, o.id, 'payment_cancelled');
          await recordRefund(tx, o.id, `payme-cancel:${a.id}`, a.amount_minor);
          return { transaction: a.id, cancel_time: cancelTime, state: -2 };
        }
        case 'CheckTransaction': {
          const a = (await tx.query(`SELECT * FROM payment_attempts WHERE provider='payme' AND provider_ref=$1`, [String(p.id)])).rows[0];
          if (!a) throw new RpcError(PaymeErr.NOT_FOUND);
          return txView(a);
        }
        case 'GetStatement': {
          const rows = (await tx.query(`SELECT a.*, pi.order_id FROM payment_attempts a JOIN payment_intents pi ON pi.id=a.intent_id WHERE a.provider='payme' AND (a.provider_state->>'create_time')::bigint BETWEEN $1 AND $2 ORDER BY (a.provider_state->>'create_time')::bigint`, [Number(p.from), Number(p.to)])).rows;
          return { transactions: rows.map((a) => ({ id: a.provider_ref, time: a.provider_state.create_time, amount: Number(a.amount_minor), account: { order_id: a.order_id }, ...txView(a) })) };
        }
        default:
          throw new RpcError(PaymeErr.METHOD);
      }
    });
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (e instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: e.code, message: e.text, data: e.data } };
    throw e;
  }
}

async function cancelAttempt(tx: Tx, a: { id: string; intent_id: string }, reason: number) {
  await tx.query(`UPDATE payment_attempts SET status='canceled', provider_state = provider_state || $2::jsonb, updated_at=now() WHERE id=$1`, [a.id, JSON.stringify({ state: -1, cancel_time: Date.now(), reason })]);
  await tx.query(`UPDATE orders SET payment_status='unpaid' WHERE id=(SELECT order_id FROM payment_intents WHERE id=$1) AND payment_status='pending'`, [a.intent_id]);
}
