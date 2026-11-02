import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { hashToken, requirePerm, requireStepUp, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, conflict, forbidden, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { queueNotification } from './service.js';
import { renderText } from './telegram.js';

const LATEST_CONSENT = `(SELECT c.granted FROM consents c WHERE c.user_id=u.id AND c.purpose='marketing' AND c.channel IN ($CH,'any') ORDER BY c.created_at DESC, c.id DESC LIMIT 1)`;

export function registerMessaging(app: FastifyInstance, deps: Deps): void {
  // ---------- Marketing campaigns (T087): consent re-checked at send time; transactional messages unaffected ----------
  route(app, deps, { method: 'POST', url: '/admin/campaigns', tags: ['marketing'], summary: 'Draft campaign', body: z.object({ name: z.string().min(2).max(120), channel: z.enum(['sms', 'telegram', 'in_app']), template: z.string().min(2).max(60), body: z.record(z.string(), z.string().max(1000)) }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'marketing.manage');
      return one(db, `INSERT INTO marketing_campaigns (name, channel, template, body, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, status`, [body.name, body.channel, body.template, JSON.stringify(body.body), actor.userId]);
    });

  route(app, deps, { method: 'POST', url: '/admin/campaigns/:id/approve', tags: ['marketing'], summary: 'Approve (not by creator) and snapshot audience of consenting users', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'marketing.manage');
    requireStepUp(actor);
    return withTx(db, async (tx) => {
      const c = await maybeOne<{ status: string; created_by: string; channel: string }>(tx, `SELECT * FROM marketing_campaigns WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CAMPAIGN');
      if (c.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT');
      if (c.created_by === actor.userId) throw new AppError(403, 'MAKER_CANNOT_APPROVE');
      const ins = await tx.query(`INSERT INTO marketing_recipients (campaign_id, user_id) SELECT $1, u.id FROM users u WHERE u.status='active' AND ${LATEST_CONSENT.replace('$CH', '$2')} IS TRUE`, [params.id, c.channel]);
      await tx.query(`UPDATE marketing_campaigns SET status='approved', approved_by=$2, audience_size=$3 WHERE id=$1`, [params.id, actor.userId, ins.rowCount]);
      await audit(tx, actor, 'campaign.approved', { type: 'campaign', id: params.id }, { after: { audience: ins.rowCount } });
      return { audience_size: ins.rowCount };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/campaigns/:id/send', tags: ['marketing'], summary: 'Send: suppresses users who withdrew consent after the snapshot; idempotent', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'marketing.manage');
    return withTx(db, async (tx) => {
      const c = await maybeOne<{ status: string; channel: string; template: string; body: Record<string, string> }>(tx, `SELECT * FROM marketing_campaigns WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!c) throw notFound('CAMPAIGN');
      if (!['approved', 'sending', 'sent'].includes(c.status)) throw conflict('CAMPAIGN_NOT_APPROVED');
      const recips = await many<{ user_id: string; consent: boolean | null; locale: string }>(tx,
        `SELECT r.user_id, u.locale, ${LATEST_CONSENT.replace('$CH', '$2')} AS consent FROM marketing_recipients r JOIN users u ON u.id=r.user_id WHERE r.campaign_id=$1 AND r.status='pending' FOR UPDATE OF r`, [params.id, c.channel]);
      let queued = 0, suppressed = 0;
      for (const r of recips) {
        if (r.consent !== true) {
          await tx.query(`UPDATE marketing_recipients SET status='suppressed', suppress_reason='consent_withdrawn' WHERE campaign_id=$1 AND user_id=$2`, [params.id, r.user_id]);
          suppressed++;
          continue;
        }
        await queueNotification(tx, { userId: r.user_id, channel: c.channel === 'telegram' ? 'in_app' : (c.channel as 'sms' | 'in_app'), purpose: 'marketing', template: c.template, locale: r.locale, params: c.body, dedupeKey: `campaign:${params.id}:${r.user_id}` });
        await tx.query(`UPDATE marketing_recipients SET status='queued' WHERE campaign_id=$1 AND user_id=$2`, [params.id, r.user_id]);
        queued++;
      }
      await tx.query(`UPDATE marketing_campaigns SET status='sent' WHERE id=$1`, [params.id]);
      await audit(tx, actor, 'campaign.sent', { type: 'campaign', id: params.id }, { after: { queued, suppressed } });
      return { queued, suppressed };
    });
  });

  // ---------- Telegram account linking (T086): one-time, 10-minute token; chat never swapped between accounts ----------
  route(app, deps, { method: 'POST', url: '/me/telegram/link-token', tags: ['messaging'], summary: 'One-time deep-link token for the Online Magazin bot' }, async ({ actor, db }) => {
    requireUser(actor);
    const token = randomBytes(18).toString('base64url');
    await db.query(`INSERT INTO telegram_link_tokens (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [hashToken(token), actor.userId]);
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    return { token, deep_link: bot ? `https://t.me/${bot}?start=${token}` : null, configured: Boolean(bot) };
  });

  route(app, deps, { method: 'GET', url: '/me/telegram', tags: ['messaging'], summary: 'Telegram link status for the current user' }, async ({ actor, db }) => {
    requireUser(actor);
    const l = await maybeOne<{ linked_at: string }>(db, `SELECT linked_at FROM telegram_links WHERE user_id=$1`, [actor.userId]);
    return { linked: !!l, linked_at: l?.linked_at ?? null, bot_configured: Boolean(process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_BOT_TOKEN), bot_username: process.env.TELEGRAM_BOT_USERNAME ?? null };
  });

  route(app, deps, { method: 'DELETE', url: '/me/telegram', tags: ['messaging'], summary: 'Unlink Telegram' }, async ({ actor, db }) => {
    requireUser(actor);
    await db.query(`DELETE FROM telegram_links WHERE user_id=$1`, [actor.userId]);
    await audit(db, actor, 'telegram.unlinked', { type: 'user', id: actor.userId! });
    return { ok: true };
  });

  // In-cabinet notification list (same events as Telegram; works even when Telegram is not linked).
  route(app, deps, { method: 'GET', url: '/me/notifications', tags: ['messaging'], summary: 'My recent notifications (rendered text)' }, async ({ actor, db }) => {
    requireUser(actor);
    const rows = await many<{ id: string; template: string; params: Record<string, unknown>; status: string; created_at: string }>(db,
      `SELECT id, template, params, status, created_at FROM notifications WHERE user_id=$1 AND purpose IN ('transactional','marketing') AND template LIKE 'partner.%' ORDER BY created_at DESC LIMIT 50`, [actor.userId]);
    return { items: rows.map((r) => ({ id: r.id, kind: r.template, text: renderText(r.template, r.params ?? {}), telegram: r.status === 'sent', created_at: r.created_at })) };
  });

  app.post('/webhooks/telegram', { schema: { hide: true } }, async (req, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return reply.status(503).send({ code: 'TELEGRAM_NOT_CONFIGURED' });
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    if (got.length !== Buffer.byteLength(secret) || !timingSafeEqual(got, Buffer.from(secret))) throw forbidden();
    const upd = req.body as { message?: { text?: string; chat?: { id?: number } } };
    const m = /^\/start\s+([A-Za-z0-9_-]{10,64})$/.exec(upd.message?.text ?? '');
    const chatId = upd.message?.chat?.id;
    if (!m || !chatId) return { ok: true, linked: false };
    return withTx(deps.db, async (tx) => {
      const t = await maybeOne<{ user_id: string }>(tx, `UPDATE telegram_link_tokens SET consumed_at=now(), chat_id=$2 WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id`, [hashToken(m[1]!), chatId]);
      if (!t) return { ok: true, linked: false, reason: 'token_invalid_expired_or_used' };
      const other = await maybeOne<{ user_id: string }>(tx, `SELECT user_id FROM telegram_links WHERE chat_id=$1`, [chatId]);
      if (other && other.user_id !== t.user_id) return { ok: true, linked: false, reason: 'chat_linked_to_other_account' };
      await tx.query(`INSERT INTO telegram_links (user_id, chat_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET chat_id=EXCLUDED.chat_id, linked_at=now()`, [t.user_id, chatId]);
      await audit(tx, null, 'telegram.linked', { type: 'user', id: t.user_id });
      await queueNotification(tx, { userId: t.user_id, channel: 'telegram', purpose: 'transactional', template: 'telegram.linked', locale: 'uz-Latn', params: {}, dedupeKey: `tglinked:${t.user_id}:${Date.now()}` });
      return { ok: true, linked: true };
    });
  });
}
