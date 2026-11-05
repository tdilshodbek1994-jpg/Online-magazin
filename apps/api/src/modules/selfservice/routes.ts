import { maskPhone, normalizeUzPhone } from '@om/shared';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { encrypt } from '../../platform/mfa.js';
import { hashToken, requirePerm, requireStepUp, requireUser, type Actor } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { codeHash } from '../identity/routes.js';
import { queueNotification } from '../notifications/service.js';
import { cancelOrder } from '../orders/service.js';

/**
 * Final release PR-02 — customer self-service:
 *  - minimal order-status link (opaque, 30 days, revocable; stages only — no address, phone or money);
 *  - customer cancel before picking starts (the same cancelOrder command operators use);
 *  - phone change: current session + one-time codes on BOTH the current and the new phone; other sessions revoked;
 *  - data export/deletion REQUEST (handled by an authorised person; ledgers keep legally required records).
 */
const T = ['self-service'];
const STATUS_LINK_DAYS = 30;

async function myOrder(db: Queryable, actor: Actor, orderId: string) {
  requireUser(actor);
  const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
  const o = await maybeOne<{ id: string; number: string; commercial_status: string; fulfillment_status: string; payment_status: string; version: number }>(db,
    `SELECT id, number, commercial_status, fulfillment_status, payment_status, version FROM orders WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND customer_phone=$3))`, [orderId, actor.userId, u.phone_e164]);
  if (!o) throw notFound('ORDER'); // same answer for foreign and missing orders
  return o;
}

/** Customer-facing stage from the independent statuses (delivery ≠ payment ≠ return). */
export function customerStage(o: { commercial_status: string; confirmation_status?: string; fulfillment_status: string }): { key: string; label: string } {
  if (o.commercial_status === 'cancelled') return { key: 'cancelled', label: 'Bekor qilindi' };
  if (o.fulfillment_status === 'returned') return { key: 'returned', label: 'Qaytarildi' };
  if (o.fulfillment_status === 'failed') return { key: 'failed', label: 'Yetkazib bo‘lmadi' };
  if (o.fulfillment_status === 'delivered' || o.commercial_status === 'completed') return { key: 'delivered', label: 'Yetkazildi' };
  if (o.fulfillment_status === 'shipped') return { key: 'shipping', label: 'Yo‘lda' };
  if (['picking', 'packed'].includes(o.fulfillment_status)) return { key: 'packing', label: 'Yig‘ilmoqda' };
  if (o.commercial_status === 'confirmed') return { key: 'confirmed', label: 'Tasdiqlandi' };
  return { key: 'received', label: 'Yangi — tasdiqlanmoqda' };
}
const STAGES = ['received', 'confirmed', 'packing', 'shipping', 'delivered'];
const CANCELLABLE_FULFILMENT = ['unallocated', 'reserved'];

export function registerSelfService(app: FastifyInstance, deps: Deps): void {
  // ---------------------------------------------------------------- status link
  route(app, deps, { method: 'POST', url: '/me/orders/:id/status-link', tags: T, summary: 'Create a minimal, expiring order-status link to share', params: zIdParam },
    async ({ actor, db, params }) => {
      const o = await myOrder(db, actor, params.id);
      const token = randomBytes(24).toString('base64url');
      const row = await one<{ expires_at: string }>(db, `INSERT INTO order_status_links (order_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING expires_at`,
        [o.id, hashToken(token), actor.userId, STATUS_LINK_DAYS]);
      await audit(db, actor, 'order.status_link_created', { type: 'order', id: o.id });
      return { path: `/s/${token}`, expires_at: row.expires_at };
    });

  route(app, deps, { method: 'DELETE', url: '/me/orders/:id/status-links', tags: T, summary: 'Revoke all status links of my order', params: zIdParam },
    async ({ actor, db, params }) => {
      const o = await myOrder(db, actor, params.id);
      const r = await db.query(`UPDATE order_status_links SET revoked_at=now() WHERE order_id=$1 AND revoked_at IS NULL`, [o.id]);
      return { revoked: r.rowCount ?? 0 };
    });

  // Public: knowing an order number opens nothing; only a valid opaque token shows the stage list.
  route(app, deps, { method: 'GET', url: '/order-status/:token', tags: T, summary: 'Minimal order status by opaque link (no PII, no money)', params: z.object({ token: z.string().min(20).max(80) }) },
    async ({ db, params, reply }) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex');
      const l = await maybeOne<{ order_id: string }>(db, `SELECT order_id FROM order_status_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`, [hashToken(params.token)]);
      if (!l) throw notFound('STATUS_LINK');
      const o = await one<{ number: string; commercial_status: string; confirmation_status: string; fulfillment_status: string; updated_at: string; created_at: string; units: number }>(db,
        `SELECT number, commercial_status, confirmation_status, fulfillment_status, updated_at, created_at, (SELECT COALESCE(SUM(qty - canceled_qty),0)::int FROM order_lines WHERE order_id=o.id) AS units FROM orders o WHERE id=$1`, [l.order_id]);
      const stage = customerStage(o);
      const idx = STAGES.indexOf(stage.key);
      return {
        number: `OM-***${o.number.slice(-3)}`, stage, units: o.units, created_at: o.created_at, updated_at: o.updated_at,
        steps: STAGES.map((k, i) => ({ key: k, done: idx >= 0 && i <= idx })),
        note: 'Bu havola faqat holatni ko‘rsatadi. Manzil, telefon va to‘lov ma’lumotlari uchun hisobingizga kiring.',
      };
    });

  // ---------------------------------------------------------------- self cancel
  route(app, deps, { method: 'POST', url: '/me/orders/:id/cancel', tags: T, summary: 'Cancel my order before picking starts',
    params: zIdParam, body: z.object({ reason: z.string().trim().min(3).max(300), expected_version: z.number().int().optional() }).strict() },
  async ({ actor, db, params, body }) => {
    const o = await myOrder(db, actor, params.id);
    if (body.expected_version !== undefined && body.expected_version !== o.version) throw new AppError(409, 'VERSION_CONFLICT', {}, false, { current_version: o.version });
    if (o.commercial_status === 'cancelled') return { ok: true, already: true };
    if (!CANCELLABLE_FULFILMENT.includes(o.fulfillment_status)) throw conflict('ORDER_ALREADY_IN_FULFILMENT');
    await withTx(db, (tx) => cancelOrder(tx, actor, o.id, `customer: ${body.reason}`));
    return { ok: true };
  });

  // ---------------------------------------------------------------- phone change (both phones confirm)
  route(app, deps, { method: 'POST', url: '/me/phone/change', tags: T, summary: 'Start phone change: codes go to the current AND the new phone', body: z.object({ new_phone: z.string().min(5).max(32) }).strict() },
    async ({ actor, db, cfg, req, body }) => {
      requireUser(actor);
      requireStepUp(actor); // owner/finance must be freshly re-authenticated
      const next = normalizeUzPhone(body.new_phone);
      if (!next) throw badRequest('PHONE_INVALID', { 'body.new_phone': 'validation.phone' });
      return withTx(db, async (tx) => {
        const me = await one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM users WHERE id=$1 FOR UPDATE`, [actor.userId]);
        if (me.phone_e164 === next) throw conflict('PHONE_SAME');
        if (await maybeOne(tx, `SELECT 1 FROM users WHERE phone_e164=$1 AND status <> 'closed'`, [next])) throw conflict('PHONE_IN_USE');
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`phonechg:${actor.userId}`]);
        const recent = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM otp_challenges WHERE user_id=$1 AND purpose IN ('phone_change_old','phone_change_new') AND created_at > now() - interval '1 hour'`, [actor.userId]);
        if (recent.n >= 6) throw new AppError(429, 'OTP_HOURLY_LIMIT', {}, true);
        const out: Record<string, unknown> = {};
        for (const [purpose, phone] of [['phone_change_old', me.phone_e164], ['phone_change_new', next]] as const) {
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const ch = await one<{ id: string }>(tx, `INSERT INTO otp_challenges (phone_e164, purpose, code_hash, max_attempts, expires_at, ip, user_id)
              VALUES ($1,$2,'\\x00',$3, now() + make_interval(secs => $4), $5, $6) RETURNING id`, [phone, purpose, cfg.otp.maxAttempts, cfg.otp.ttlSeconds, req.ip, actor.userId]);
          await tx.query('UPDATE otp_challenges SET code_hash=$2 WHERE id=$1', [ch.id, codeHash(ch.id, code)]);
          await queueNotification(tx, { phone, channel: 'sms', purpose: 'otp', template: 'otp_login', locale: 'uz-Latn', params: { code_ref: ch.id, code_enc: encrypt(code, cfg.mfaKey) }, dedupeKey: `otp:${ch.id}` });
          const k = purpose === 'phone_change_old' ? 'current' : 'new';
          out[k] = { challenge_id: ch.id, phone_masked: maskPhone(phone), ...(cfg.otp.devEcho ? { dev_code: code } : {}) };
        }
        return { ...out, expires_in_seconds: cfg.otp.ttlSeconds };
      });
    });

  route(app, deps, { method: 'POST', url: '/me/phone/change/confirm', tags: T, summary: 'Finish phone change with both codes; other sessions are signed out',
    body: z.object({ current_challenge_id: z.string().uuid(), current_code: z.string().regex(/^\d{6}$/), new_challenge_id: z.string().uuid(), new_code: z.string().regex(/^\d{6}$/) }).strict() },
  async ({ actor, db, body }) => {
    requireUser(actor);
    requireStepUp(actor);
    // Attempts are counted even when a code is wrong (separate transaction).
    const take = (id: string, purpose: string) => withTx(db, (tx) => maybeOne<{ id: string; phone_e164: string; code_hash: Buffer }>(tx,
      `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id=$1 AND user_id=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at > now() AND attempts < max_attempts RETURNING id, phone_e164, code_hash`,
      [id, actor.userId, purpose]));
    const a = await take(body.current_challenge_id, 'phone_change_old');
    const b = await take(body.new_challenge_id, 'phone_change_new');
    if (!a || !b || !timingSafeEqual(a.code_hash, codeHash(a.id, body.current_code)) || !timingSafeEqual(b.code_hash, codeHash(b.id, body.new_code))) throw new AppError(400, 'OTP_INVALID_OR_EXPIRED');
    return withTx(db, async (tx) => {
      const c = await tx.query(`UPDATE otp_challenges SET consumed_at=now() WHERE id = ANY($1::uuid[]) AND consumed_at IS NULL RETURNING id`, [[a.id, b.id]]);
      if (c.rowCount !== 2) throw new AppError(400, 'OTP_INVALID_OR_EXPIRED');
      const me = await one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM users WHERE id=$1 FOR UPDATE`, [actor.userId]);
      if (me.phone_e164 !== a.phone_e164) throw conflict('PHONE_CHANGED_MEANWHILE');
      if (await maybeOne(tx, `SELECT 1 FROM users WHERE phone_e164=$1 AND status <> 'closed' AND id <> $2`, [b.phone_e164, actor.userId])) throw conflict('PHONE_IN_USE');
      await tx.query(`UPDATE users SET phone_e164=$2, phone_verified_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [actor.userId, b.phone_e164]);
      await tx.query(`INSERT INTO phone_history (user_id, old_phone, new_phone, method) VALUES ($1,$2,$3,'otp_both')`, [actor.userId, a.phone_e164, b.phone_e164]);
      // Guest orders placed with the old phone stay with the old phone (not silently moved to the new owner of the account).
      // Every session was issued for the old phone → all of them end (sessions are bound to phone_at_issue); sign in again.
      await tx.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [actor.userId]);
      await audit(tx, actor, 'user.phone_changed', { type: 'user', id: actor.userId! }, { before: { phone: maskPhone(a.phone_e164) }, after: { phone: maskPhone(b.phone_e164) } });
      return { ok: true, phone_masked: maskPhone(b.phone_e164), relogin: true, message: 'Raqam almashtirildi. Yangi raqam bilan qayta kiring.' };
    });
  });

  // ---------------------------------------------------------------- my returns (statuses kept separate: goods back ≠ money back)
  route(app, deps, { method: 'GET', url: '/me/returns', tags: T, summary: 'My return requests with item lines and the separate refund state' }, async ({ actor, db }) => {
    requireUser(actor);
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    const rows = await many<{ id: string; order_id: string; number: string; status: string; desired_resolution: string; reason: string; decision_note: string | null; created_at: string; updated_at: string; lines: { name: Record<string, string>; qty: number; received_qty: number }[]; refund: string | null }>(db,
      `SELECT r.id, r.order_id, o.number, r.status, r.desired_resolution, r.reason, r.decision_note, r.created_at, r.updated_at,
         (SELECT json_agg(json_build_object('name', ol.product_snapshot->'name', 'qty', rl.qty, 'received_qty', rl.received_qty)) FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id WHERE rl.return_id=r.id) AS lines,
         (SELECT f.status FROM refunds f WHERE f.return_id=r.id ORDER BY f.created_at DESC LIMIT 1) AS refund
       FROM return_requests r JOIN orders o ON o.id=r.order_id
      WHERE o.user_id=$1 OR (o.user_id IS NULL AND o.customer_phone=$2) ORDER BY r.created_at DESC LIMIT 50`, [actor.userId, u.phone_e164]);
    const ST: Record<string, string> = { requested: 'So‘rov qabul qilindi', reviewing: 'Ko‘rib chiqilmoqda', approved: 'Tasdiqlandi — tovarni topshiring', received: 'Tovar qabul qilindi, tekshirilmoqda', inspected: 'Tekshirildi', resolved: 'Yakunlandi', rejected: 'Rad etildi' };
    const RF: Record<string, string> = { requested: 'Pul qaytarish so‘raldi', approved: 'Pul qaytarish tasdiqlandi', reserved: 'Pul qaytarish tayyorlanmoqda', submitted: 'Pul yuborildi, tasdiq kutilmoqda', succeeded: 'Pul qaytarildi', failed: 'Pul qaytarishda xato — operator bog‘lanadi', unknown_result: 'Pul holati tekshirilmoqda', rejected: 'Pul qaytarish rad etildi' };
    return { items: rows.map((r) => ({ ...r, status_label: ST[r.status] ?? r.status, refund_label: r.refund ? RF[r.refund] ?? r.refund : null })) };
  });

  // ---------------------------------------------------------------- data requests
  route(app, deps, { method: 'POST', url: '/me/data-requests', tags: T, summary: 'Ask for a copy of my data or for deletion (handled by an authorised person)',
    body: z.object({ kind: z.enum(['export', 'delete']), note: z.string().trim().max(500).optional() }).strict() },
  async ({ actor, db, body }) => {
    requireUser(actor);
    const r = await maybeOne<{ id: string; status: string; created_at: string }>(db, `INSERT INTO data_requests (user_id, kind, note) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id, status, created_at`, [actor.userId, body.kind, body.note ?? null]);
    if (!r) throw conflict('DATA_REQUEST_ALREADY_OPEN');
    await audit(db, actor, `data_request.${body.kind}`, { type: 'user', id: actor.userId! });
    return { ...r, note: body.kind === 'delete' ? 'So‘rovingiz qabul qilindi. Qonun bo‘yicha saqlanishi shart bo‘lgan buyurtma va to‘lov yozuvlaridan tashqari shaxsiy ma’lumotlaringiz o‘chiriladi; natija haqida xabar beramiz.' : 'So‘rovingiz qabul qilindi. Ma’lumotlaringiz nusxasini tayyorlab beramiz.' };
  });

  route(app, deps, { method: 'GET', url: '/me/data-requests', tags: T, summary: 'My data requests' }, async ({ actor, db }) => {
    requireUser(actor);
    return { items: await many(db, `SELECT id, kind, status, resolution, created_at, resolved_at FROM data_requests WHERE user_id=$1 ORDER BY created_at DESC`, [actor.userId]) };
  });

  route(app, deps, { method: 'GET', url: '/admin/data-requests', tags: T, summary: 'Data requests queue (staff.manage)' }, async ({ actor, db }) => {
    requirePerm(actor, 'staff.manage');
    return { items: await many(db, `SELECT r.id, r.kind, r.status, r.note, r.resolution, r.created_at, r.resolved_at, u.display_name FROM data_requests r JOIN users u ON u.id=r.user_id ORDER BY (r.status IN ('requested','in_review')) DESC, r.created_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/data-requests/:id/resolve', tags: T, summary: 'Record the decision on a data request (no automatic erasure)',
    params: zIdParam, body: z.object({ status: z.enum(['in_review', 'done', 'rejected']), resolution: z.string().trim().min(5).max(1000) }).strict() },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'staff.manage');
    requireStepUp(actor);
    const r = await maybeOne<{ id: string; user_id: string }>(db, `UPDATE data_requests SET status=$2, resolution=$3, resolved_by=CASE WHEN $2 IN ('done','rejected') THEN $4::uuid END, resolved_at=CASE WHEN $2 IN ('done','rejected') THEN now() END WHERE id=$1 AND status IN ('requested','in_review') RETURNING id, user_id`,
      [params.id, body.status, body.resolution, actor.userId]);
    if (!r) throw notFound('DATA_REQUEST');
    await audit(db, actor, 'data_request.resolved', { type: 'data_request', id: r.id }, { after: { status: body.status } });
    return { ok: true };
  });
}
