import { DEFAULT_LOCALE, maskPhone, normalizeUzPhone } from '@om/shared';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { newToken, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { mergeGuestCart } from '../checkout/cart-merge.js';
import { queueNotification } from '../notifications/service.js';

const zPhone = z.string().min(5).max(32);
const zLocale = z.enum(['uz-Latn', 'uz-Cyrl', 'ru']);

function codeHash(challengeId: string, code: string): Buffer {
  return createHash('sha256').update(`${challengeId}:${code}`).digest();
}

export function registerIdentity(app: FastifyInstance, deps: Deps): void {
  const T = ['identity'];

  route(app, deps, { method: 'POST', url: '/auth/otp/request', tags: T, summary: 'Request OTP (M02)', body: z.object({ phone: zPhone, purpose: z.enum(['login']).default('login'), locale: zLocale.optional() }) },
    async ({ body, db, cfg, req }) => {
      const phone = normalizeUzPhone(body.phone);
      if (!phone) throw badRequest('PHONE_INVALID', { 'body.phone': 'validation.phone' });
      return withTx(db, async (tx) => {
        // Serialize per phone to enforce resend interval under concurrency.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp:${phone}`]);
        const last = await maybeOne<{ age: number }>(tx, `SELECT EXTRACT(EPOCH FROM now()-created_at)::int AS age FROM otp_challenges WHERE phone_e164=$1 ORDER BY created_at DESC LIMIT 1`, [phone]);
        if (last && last.age < cfg.otp.resendIntervalSeconds) {
          throw new AppError(429, 'OTP_RESEND_TOO_SOON', {}, true, { retry_after_seconds: cfg.otp.resendIntervalSeconds - last.age });
        }
        const hourly = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM otp_challenges WHERE phone_e164=$1 AND created_at > now() - interval '1 hour'`, [phone]);
        if (hourly.n >= 5) throw new AppError(429, 'OTP_HOURLY_LIMIT', {}, true);
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const ch = await one<{ id: string }>(tx, `INSERT INTO otp_challenges (phone_e164, purpose, code_hash, max_attempts, expires_at, ip)
            VALUES ($1,$2,'\\x00',$3, now() + make_interval(secs => $4), $5) RETURNING id`, [phone, body.purpose, cfg.otp.maxAttempts, cfg.otp.ttlSeconds, req.ip]);
        await tx.query('UPDATE otp_challenges SET code_hash=$2 WHERE id=$1', [ch.id, codeHash(ch.id, code)]);
        await queueNotification(tx, { phone, channel: 'sms', purpose: 'otp', template: 'otp_login', locale: body.locale ?? DEFAULT_LOCALE, params: { code_ref: ch.id }, dedupeKey: `otp:${ch.id}` });
        return {
          challenge_id: ch.id,
          phone_masked: maskPhone(phone),
          expires_in_seconds: cfg.otp.ttlSeconds,
          resend_after_seconds: cfg.otp.resendIntervalSeconds,
          ...(cfg.otp.devEcho ? { dev_code: code } : {}),
        };
      });
    });

  route(app, deps, { method: 'POST', url: '/auth/otp/verify', tags: T, summary: 'Verify OTP, create session, merge guest cart', body: z.object({ challenge_id: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }) },
    async ({ body, db, cfg, actor, req }) => {
      // Attempt counter is committed even when the code is wrong (separate tx).
      const ch = await withTx(db, async (tx) =>
        maybeOne<{ id: string; phone_e164: string; code_hash: Buffer }>(tx,
          `UPDATE otp_challenges SET attempts = attempts + 1
            WHERE id=$1 AND consumed_at IS NULL AND expires_at > now() AND attempts < max_attempts
            RETURNING id, phone_e164, code_hash`, [body.challenge_id]));
      if (!ch) throw new AppError(400, 'OTP_INVALID_OR_EXPIRED');
      const ok = timingSafeEqual(ch.code_hash, codeHash(ch.id, body.code));
      if (!ok) throw new AppError(400, 'OTP_INVALID_OR_EXPIRED');
      return withTx(db, async (tx) => {
        // Single use: only one verify can consume the challenge (AC-M02-1).
        const consumed = await tx.query(`UPDATE otp_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id`, [ch.id]);
        if (!consumed.rowCount) throw new AppError(400, 'OTP_INVALID_OR_EXPIRED');
        let user = await maybeOne<{ id: string; locale: string; status: string }>(tx, `SELECT id, locale, status FROM users WHERE phone_e164=$1 AND status <> 'closed' FOR UPDATE`, [ch.phone_e164]);
        let created = false;
        if (!user) {
          user = await one(tx, `INSERT INTO users (phone_e164, phone_verified_at) VALUES ($1, now()) RETURNING id, locale, status`, [ch.phone_e164]);
          await tx.query(`INSERT INTO phone_history (user_id, new_phone, method) VALUES ($1,$2,'initial')`, [user.id, ch.phone_e164]);
          await tx.query(`INSERT INTO memberships (user_id, role_code) VALUES ($1, 'customer')`, [user.id]);
          created = true;
        }
        if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_LOCKED');
        const { token, hash } = newToken();
        const s = await one<{ id: string }>(tx, `INSERT INTO sessions (user_id, token_hash, phone_at_issue, user_agent, ip, expires_at)
            VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6)) RETURNING id`,
          [user.id, hash, ch.phone_e164, req.headers['user-agent'] ?? null, req.ip, cfg.sessionTtlHours]);
        await mergeGuestCart(tx, actor.guestToken, user.id);
        await audit(tx, { ...actor, kind: 'user', userId: user.id }, created ? 'user.registered' : 'user.login', { type: 'user', id: user.id }, { after: { session_id: s.id } });
        return { token, session_id: s.id, user_id: user.id, created };
      });
    });

  route(app, deps, { method: 'GET', url: '/auth/sessions', tags: T, summary: 'List my sessions' }, async ({ actor, db }) => {
    requireUser(actor);
    const rows = await many(db, `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [actor.userId]);
    return { items: rows.map((r) => ({ ...r, current: r.id === actor.sessionId })) };
  });

  route(app, deps, { method: 'DELETE', url: '/auth/sessions/:id', tags: T, summary: 'Revoke a session', params: zIdParam }, async ({ actor, db, params }) => {
    requireUser(actor);
    const r = await db.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='user' WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [params.id, actor.userId]);
    if (!r.rowCount) throw notFound('SESSION');
    return { ok: true };
  });

  route(app, deps, { method: 'POST', url: '/auth/logout', tags: T, summary: 'Logout current session' }, async ({ actor, db }) => {
    requireUser(actor);
    await db.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='logout' WHERE id=$1`, [actor.sessionId]);
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/me', tags: T, summary: 'Current user' }, async ({ actor, db }) => {
    requireUser(actor);
    const u = await one(db, `SELECT id, phone_e164, display_name, locale, version, created_at FROM users WHERE id=$1`, [actor.userId]);
    return { ...u, roles: actor.grants, permissions: [...actor.perms.keys()].sort() };
  });

  route(app, deps, { method: 'PATCH', url: '/me', tags: T, summary: 'Update profile (optimistic version)', body: z.object({ display_name: z.string().max(120).optional(), locale: zLocale.optional(), expected_version: z.number().int() }) },
    async ({ actor, db, body }) => {
      requireUser(actor);
      const r = await db.query(`UPDATE users SET display_name=COALESCE($2,display_name), locale=COALESCE($3,locale), version=version+1, updated_at=now()
          WHERE id=$1 AND version=$4 RETURNING id, display_name, locale, version`, [actor.userId, body.display_name ?? null, body.locale ?? null, body.expected_version]);
      if (!r.rowCount) throw conflict('VERSION_CONFLICT');
      return r.rows[0];
    });

  const zAddress = z.object({
    label: z.string().max(60).optional(),
    recipient_name: z.string().min(1).max(120),
    recipient_phone: zPhone,
    region_code: z.string().min(2).max(10),
    district: z.string().min(1).max(120),
    mahalla: z.string().max(120).optional(),
    street: z.string().min(1).max(200),
    house: z.string().min(1).max(30),
    apartment: z.string().max(30).optional(),
    floor: z.number().int().min(-5).max(200).optional(),
    landmark: z.string().max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    delivery_note: z.string().max(500).optional(),
    source: z.enum(['manual', 'map']).default('manual'),
  });

  route(app, deps, { method: 'GET', url: '/me/addresses', tags: T, summary: 'My addresses' }, async ({ actor, db }) => {
    requireUser(actor);
    return { items: await many(db, `SELECT * FROM addresses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at`, [actor.userId]) };
  });

  route(app, deps, { method: 'POST', url: '/me/addresses', tags: T, summary: 'Add address (map or manual are equal, AC-M03-1)', body: zAddress }, async ({ actor, db, body }) => {
    requireUser(actor);
    const phone = normalizeUzPhone(body.recipient_phone);
    if (!phone) throw badRequest('PHONE_INVALID', { 'body.recipient_phone': 'validation.phone' });
    const region = await maybeOne(db, `SELECT code FROM service_regions WHERE code=$1`, [body.region_code]);
    if (!region) throw badRequest('REGION_UNKNOWN', { 'body.region_code': 'validation.region' });
    return one(db, `INSERT INTO addresses (user_id,label,recipient_name,recipient_phone,region_code,district,mahalla,street,house,apartment,floor,landmark,lat,lng,delivery_note,source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [actor.userId, body.label ?? null, body.recipient_name, phone, body.region_code, body.district, body.mahalla ?? null, body.street, body.house, body.apartment ?? null, body.floor ?? null, body.landmark ?? null, body.lat ?? null, body.lng ?? null, body.delivery_note ?? null, body.source]);
  });

  route(app, deps, { method: 'DELETE', url: '/me/addresses/:id', tags: T, summary: 'Delete address (orders keep snapshot, AC-M03-2)', params: zIdParam }, async ({ actor, db, params }) => {
    requireUser(actor);
    const r = await db.query(`UPDATE addresses SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [params.id, actor.userId]);
    if (!r.rowCount) throw notFound('ADDRESS');
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/me/consents', tags: T, summary: 'Current consents' }, async ({ actor, db }) => {
    requireUser(actor);
    const rows = await many(db, `SELECT DISTINCT ON (purpose, channel) purpose, channel, granted, created_at FROM consents WHERE user_id=$1 ORDER BY purpose, channel, created_at DESC`, [actor.userId]);
    return { items: rows };
  });

  route(app, deps, { method: 'POST', url: '/me/consents', tags: T, summary: 'Grant/withdraw consent (history kept)', body: z.object({ purpose: z.enum(['marketing', 'personalization', 'analytics']), channel: z.enum(['sms', 'email', 'push', 'telegram', 'in_app', 'any']), granted: z.boolean() }) },
    async ({ actor, db, body }) => {
      requireUser(actor);
      await db.query(`INSERT INTO consents (user_id, purpose, channel, granted, source) VALUES ($1,$2,$3,$4,'cabinet')`, [actor.userId, body.purpose, body.channel, body.granted]);
      return { ok: true };
    });

  route(app, deps, { method: 'GET', url: '/regions', tags: T, summary: 'Service regions' }, async ({ db }) => ({ items: await many(db, `SELECT code, name, active, restriction_reason FROM service_regions ORDER BY code`) }));
}
