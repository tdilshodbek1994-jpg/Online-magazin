import type { Tx } from '../../platform/db.js';
import { conflict } from '../../platform/errors.js';

export interface StockLine {
  orderLineId: string;
  skuId: string;
  merchantOrgId: string;
  qty: number;
}

export async function mainWarehouseId(tx: Tx): Promise<string> {
  const r = await tx.query(`SELECT id FROM warehouses WHERE code='MAIN'`);
  if (!r.rowCount) throw new Error('MAIN warehouse missing (run seed)');
  return r.rows[0].id;
}

/**
 * Atomic reservation (§15, MASTER 9.1): conditional UPDATE guarded by ATP inside the caller's
 * transaction. Rows are locked in deterministic sku order to avoid deadlocks; all lines reserve or none
 * (the caller's transaction rolls back on OUT_OF_STOCK). Never read-then-decrement in application code.
 */
export async function reserveForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLine[],
  status: 'active_unpaid' | 'allocated_for_fulfillment',
  ttlMinutes: number | null,
): Promise<string> {
  const wh = await mainWarehouseId(tx);
  const res = await tx.query(
    `INSERT INTO reservations (order_id, status, expires_at) VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END) RETURNING id`,
    [orderId, status, status === 'active_unpaid' ? ttlMinutes : null],
  );
  const reservationId = res.rows[0].id as string;
  const sorted = [...lines].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
  for (const l of sorted) {
    const u = await tx.query(
      `UPDATE stock_balances SET reserved = reserved + $4, version = version + 1, updated_at = now()
        WHERE sku_id=$1 AND merchant_org_id=$2 AND warehouse_id=$3 AND on_hand_sellable - reserved - safety_buffer >= $4
        RETURNING sku_id`,
      [l.skuId, l.merchantOrgId, wh, l.qty],
    );
    if (!u.rowCount) throw conflict('OUT_OF_STOCK', { sku_id: l.skuId });
    await tx.query(
      `INSERT INTO reservation_lines (reservation_id, order_line_id, sku_id, merchant_org_id, warehouse_id, qty) VALUES ($1,$2,$3,$4,$5,$6)`,
      [reservationId, l.orderLineId, l.skuId, l.merchantOrgId, wh, l.qty],
    );
  }
  return reservationId;
}

/** Release a live reservation exactly once (INV03): the status transition is the guard. */
export async function releaseReservation(tx: Tx, orderId: string, to: 'released' | 'expired'): Promise<boolean> {
  const r = await tx.query(
    `UPDATE reservations SET status=$2, version=version+1, updated_at=now()
      WHERE order_id=$1 AND status IN ('active_unpaid','allocated_for_fulfillment') ${to === 'expired' ? "AND status='active_unpaid'" : ''}
      RETURNING id`,
    [orderId, to],
  );
  if (!r.rowCount) return false;
  await tx.query(
    `UPDATE stock_balances sb SET reserved = sb.reserved - rl.qty, version = sb.version + 1, updated_at = now()
       FROM reservation_lines rl
      WHERE rl.reservation_id = $1 AND sb.sku_id = rl.sku_id AND sb.merchant_org_id = rl.merchant_org_id AND sb.warehouse_id = rl.warehouse_id`,
    [r.rows[0].id],
  );
  return true;
}

/** Dispatch: physical outflow and reservation consume in one transaction (9.1). */
export async function consumeOnDispatch(tx: Tx, orderId: string, actorId: string | null): Promise<void> {
  const r = await tx.query(
    `UPDATE reservations SET status='consumed_on_dispatch', version=version+1, updated_at=now()
      WHERE order_id=$1 AND status='allocated_for_fulfillment' RETURNING id`,
    [orderId],
  );
  if (!r.rowCount) throw conflict('NO_ALLOCATED_RESERVATION');
  const lines = await tx.query(`SELECT * FROM reservation_lines WHERE reservation_id=$1`, [r.rows[0].id]);
  for (const l of lines.rows) {
    await tx.query(
      `UPDATE stock_balances SET reserved = reserved - $4, on_hand_sellable = on_hand_sellable - $4, version=version+1, updated_at=now()
        WHERE sku_id=$1 AND merchant_org_id=$2 AND warehouse_id=$3`,
      [l.sku_id, l.merchant_org_id, l.warehouse_id, l.qty],
    );
    await tx.query(
      `INSERT INTO inventory_movements (sku_id, merchant_org_id, warehouse_id, kind, bucket, qty_delta, ref_type, ref_id, actor_user_id)
       VALUES ($1,$2,$3,'dispatch','on_hand_sellable',$4,'order_line',$5,$6)`,
      [l.sku_id, l.merchant_org_id, l.warehouse_id, -l.qty, l.order_line_id, actorId],
    );
  }
}

/** Stock movement into a bucket (receipt / returned goods / write-off), idempotent by ref. */
export async function moveStock(
  tx: Tx,
  m: { skuId: string; merchantOrgId: string; kind: string; bucket: 'on_hand_sellable' | 'quarantine' | 'damaged'; qty: number; refType: string; refId: string; actorId: string | null; reason?: string },
): Promise<boolean> {
  const wh = await mainWarehouseId(tx);
  const ins = await tx.query(
    `INSERT INTO inventory_movements (sku_id, merchant_org_id, warehouse_id, kind, bucket, qty_delta, ref_type, ref_id, actor_user_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (ref_type, ref_id, kind, bucket, sku_id, warehouse_id) DO NOTHING RETURNING id`,
    [m.skuId, m.merchantOrgId, wh, m.kind, m.bucket, m.qty, m.refType, m.refId, m.actorId, m.reason ?? null],
  );
  if (!ins.rowCount) return false;
  await tx.query(
    `INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [m.skuId, m.merchantOrgId, wh],
  );
  // CHECK constraints reject negative buckets (manual negative stock forbidden by default, §15).
  await tx.query(
    `UPDATE stock_balances SET ${m.bucket} = ${m.bucket} + $4, version=version+1, updated_at=now() WHERE sku_id=$1 AND merchant_org_id=$2 AND warehouse_id=$3`,
    [m.skuId, m.merchantOrgId, wh, m.qty],
  );
  return true;
}

/**
 * Partner short hold (V2 §09): a real server-side reservation for a complete draft, with expiry.
 * Same atomic ATP guard as orders, so two buyers can never both get the last unit (T22).
 */
export async function reserveForDraft(tx: Tx, draftId: string, partnerId: string, lines: { skuId: string; qty: number }[], minutes: number): Promise<{ id: string; expires_at: string }> {
  const wh = await mainWarehouseId(tx);
  const res = await tx.query(
    `INSERT INTO reservations (order_id, sales_draft_id, partner_id, status, expires_at) VALUES (NULL, $1, $2, 'active_unpaid', now() + make_interval(mins => $3::int)) RETURNING id, expires_at`,
    [draftId, partnerId, minutes],
  );
  const id = res.rows[0].id as string;
  const sorted = [...lines].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
  for (const l of sorted) {
    const u = await tx.query(
      `UPDATE stock_balances sb SET reserved = sb.reserved + $3, version = sb.version + 1, updated_at = now()
         FROM offers o
        WHERE o.sku_id = sb.sku_id AND o.merchant_org_id = sb.merchant_org_id AND o.status='active'
          AND sb.sku_id=$1 AND sb.warehouse_id=$2 AND sb.on_hand_sellable - sb.reserved - sb.safety_buffer >= $3
        RETURNING sb.merchant_org_id`,
      [l.skuId, wh, l.qty],
    );
    if (!u.rowCount) throw conflict('OUT_OF_STOCK', { sku_id: l.skuId });
    await tx.query(`INSERT INTO reservation_lines (reservation_id, order_line_id, sku_id, merchant_org_id, warehouse_id, qty) VALUES ($1, NULL, $2, $3, $4, $5)`,
      [id, l.skuId, u.rows[0].merchant_org_id, wh, l.qty]);
  }
  return { id, expires_at: res.rows[0].expires_at };
}

/** Release a draft hold exactly once (cancel, submit, or expiry). */
export async function releaseDraftHold(tx: Tx, where: { draftId?: string; reservationId?: string }, to: 'released' | 'expired'): Promise<boolean> {
  const r = await tx.query(
    `UPDATE reservations SET status=$3::text, version=version+1, updated_at=now()
      WHERE status='active_unpaid' AND sales_draft_id IS NOT NULL AND (sales_draft_id=$1::uuid OR id=$2::uuid) ${to === 'expired' ? 'AND expires_at <= now()' : ''}
      RETURNING id`,
    [where.draftId ?? null, where.reservationId ?? null, to],
  );
  if (!r.rowCount) return false;
  await tx.query(
    `UPDATE stock_balances sb SET reserved = sb.reserved - rl.qty, version = sb.version + 1, updated_at = now()
       FROM reservation_lines rl
      WHERE rl.reservation_id = $1 AND sb.sku_id = rl.sku_id AND sb.merchant_org_id = rl.merchant_org_id AND sb.warehouse_id = rl.warehouse_id`,
    [r.rows[0].id],
  );
  return true;
}
