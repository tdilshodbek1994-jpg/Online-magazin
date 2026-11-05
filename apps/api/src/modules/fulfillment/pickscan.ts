import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, type Queryable, withTx } from '../../platform/db.js';
import { AppError, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

/**
 * Pick check by barcode/SKU (camera, hardware scanner or typed). Wrong item = recorded + 422 (packing stays blocked
 * until every line is matched). Only the minimum is shown: product, variant, quantities — no customer data.
 */
export async function pickProgress(q: Queryable, orderId: string) {
  const lines = await many<{ id: string; name: Record<string, string>; variant: unknown; sku_code: string; barcode: string | null; need: number; scanned: number }>(q, `
    SELECT ol.id, ol.product_snapshot->'name' AS name, ol.product_snapshot->'variant' AS variant, s.sku_code, s.barcode, (ol.qty - ol.canceled_qty)::int AS need,
           (SELECT COUNT(*)::int FROM pick_scans p WHERE p.order_line_id=ol.id AND p.result='match') AS scanned
      FROM order_lines ol JOIN skus s ON s.id=ol.sku_id WHERE ol.order_id=$1 AND ol.qty > ol.canceled_qty ORDER BY ol.id`, [orderId]);
  const wrong = await maybeOne<{ n: number }>(q, `SELECT COUNT(*)::int AS n FROM pick_scans WHERE order_id=$1 AND result IN ('wrong','extra')`, [orderId]);
  const any = await maybeOne<{ n: number }>(q, `SELECT COUNT(*)::int AS n FROM pick_scans WHERE order_id=$1`, [orderId]);
  const complete = lines.every((l) => l.scanned >= l.need);
  return { lines, complete, scanned_any: (any?.n ?? 0) > 0, wrong_scans: wrong?.n ?? 0 };
}

/** Called before «packed»: if scanning was used, every unit must be matched. */
export async function assertPickComplete(q: Queryable, orderId: string) {
  const p = await pickProgress(q, orderId);
  if (p.scanned_any && !p.complete) throw new AppError(409, 'PICK_INCOMPLETE', {}, false, { lines: p.lines.map((l) => ({ id: l.id, need: l.need, scanned: l.scanned })) });
}

export function registerPickScan(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/orders/:id/pick', tags: ['warehouse'], summary: 'Pick list with scan progress', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'fulfillment.operate');
    const o = await maybeOne<{ number: string; fulfillment_status: string }>(db, `SELECT number, fulfillment_status FROM orders WHERE id=$1`, [params.id]);
    if (!o) throw notFound('ORDER');
    return { number: o.number, fulfillment_status: o.fulfillment_status, ...(await pickProgress(db, params.id)) };
  });

  route(app, deps, { method: 'POST', url: '/ops/orders/:id/pick/scan', tags: ['warehouse'], summary: 'Scan one unit (barcode or SKU); wrong item is refused and recorded',
    params: zIdParam, body: z.object({ code: z.string().trim().min(1).max(64) }).strict() },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'fulfillment.operate');
    return withTx(db, async (tx) => {
      const o = await maybeOne<{ fulfillment_status: string }>(tx, `SELECT fulfillment_status FROM orders WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!o) throw notFound('ORDER');
      if (o.fulfillment_status !== 'picking') throw conflict('NOT_PICKING');
      const code = body.code.toUpperCase();
      const p = await pickProgress(tx, params.id);
      const line = p.lines.find((l) => l.sku_code.toUpperCase() === code || (l.barcode && l.barcode.toUpperCase() === code));
      const record = (lineId: string | null, result: string) => tx.query(`INSERT INTO pick_scans (order_id, order_line_id, code, result, actor_user_id) VALUES ($1,$2,$3,$4,$5)`, [params.id, lineId, body.code, result, actor.userId]);
      if (!line) {
        await record(null, 'wrong');
        await audit(tx, actor, 'pick.wrong_item', { type: 'order', id: params.id }, { after: { code: body.code } });
        return { ok: false, code: 'WRONG_ITEM', message: 'Bu tovar buyurtmada yo‘q — olib qo‘ying.', ...(await pickProgress(tx, params.id)) };
      }
      if (line.scanned >= line.need) {
        await record(line.id, 'extra');
        return { ok: false, code: 'EXTRA_UNIT', message: 'Bu tovardan yetarli olindi — ortiqchasini qaytaring.', ...(await pickProgress(tx, params.id)) };
      }
      await record(line.id, 'match');
      return { ok: true, ...(await pickProgress(tx, params.id)) };
    });
  });
}
