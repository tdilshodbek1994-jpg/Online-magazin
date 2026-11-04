import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, notFound } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';
import { isBotUserAgent } from '../partners/attribution.js';
import { BROWSER_EVENTS, currentConsent, dispatchTracking, recordEvent, sanitizeSourceUrl, subjectKey, trackingHealth, trackingSettings, uzs, validFbCookie } from './service.js';

const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
const T = ['tracking'];

/**
 * P0C tracking API. Public: config, consent, browser events (only real page/product/checkout views, strict schema —
 * no client-supplied values, datasets or order totals). Admin: health diagnostics; owner: single dataset settings.
 */
export function registerTracking(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/tracking/config', tags: T, summary: 'Tracking config for this visitor (pixel only when ready AND consented)' }, async ({ actor, db, reply }) => {
    reply.header('cache-control', 'private, no-store'); // personal consent state is never cached for others (LT-094)
    const s = await trackingSettings(db);
    const c = await currentConsent(db, subjectKey(actor));
    const ready = s.enabled && !!s.dataset_id;
    return {
      consent_required: ready, consent_policy_version: s.consent_policy_version,
      consent: c && c.policy_version === s.consent_policy_version ? c.status : null,
      pixel: ready && c?.status === 'granted' && c.policy_version === s.consent_policy_version ? { dataset_id: s.dataset_id } : null,
    };
  });

  route(app, deps, {
    method: 'POST', url: '/tracking/consent', tags: T, summary: 'Grant / deny / withdraw optional ad measurement (ordering works either way)',
    body: z.object({ status: z.enum(['granted', 'denied', 'withdrawn']), policy_version: z.string().max(40), source: z.enum(['banner', 'settings']).default('banner') }).strict(),
  }, async ({ actor, db, body }) => {
    const subject = subjectKey(actor);
    if (!subject) throw badRequest('GUEST_TOKEN_REQUIRED');
    const s = await trackingSettings(db);
    if (body.policy_version !== s.consent_policy_version) throw new AppError(409, 'CONSENT_POLICY_OUTDATED');
    const r = await one<{ id: string }>(db, `INSERT INTO tracking_consents (subject_key, user_id, status, policy_version, source) VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
      [subject, actor.userId, body.status, body.policy_version, body.source]);
    return { ok: true, consent_id: r.id, status: body.status };
  });

  route(app, deps, {
    method: 'POST', url: '/tracking/events', tags: T, summary: 'Browser measurement event (PageView/ViewContent/InitiateCheckout) — server validates and values it',
    body: z.object({
      event: z.enum(BROWSER_EVENTS), event_id: z.string().uuid(),
      landing_id: z.string().uuid().optional(), product_id: z.string().uuid().optional(), quote_id: z.string().uuid().optional(),
      source_url: z.string().max(2000).optional(), fbp: z.string().max(600).optional(), fbc: z.string().max(600).optional(),
    }).strict(),
  }, async ({ actor, db, body, req, reply }) => {
    const subject = subjectKey(actor);
    if (!subject) throw badRequest('GUEST_TOKEN_REQUIRED');
    if (isBotUserAgent(req.headers['user-agent'])) { reply.status(202); return { accepted: false, reason: 'BOT' }; }
    return withTx(db, async (tx) => {
      const c = await currentConsent(tx, subject);
      if (c?.status !== 'granted') { reply.status(202); return { accepted: false, reason: 'NO_CONSENT' }; }
      const recent = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM tracking_events WHERE subject_key=$1 AND created_at > now() - interval '1 minute'`, [subject]);
      if (recent.n >= 60) throw new AppError(429, 'TRACKING_RATE_LIMIT');
      let customData: Record<string, unknown> = {};
      let landingId: string | null = null;
      if (body.event === 'landing.rendered') {
        const l = await maybeOne<{ id: string }>(tx, `SELECT id FROM landing_pages WHERE id=$1 AND status='published'`, [body.landing_id ?? null]);
        if (!l) throw notFound('LANDING'); // preview/draft traffic is never measured
        landingId = l.id;
      } else if (body.event === 'product.viewed') {
        const p = await maybeOne<{ id: string; price: string | null }>(tx, `SELECT p.id, (SELECT MIN(o.price_minor)::text FROM skus s JOIN offers o ON o.sku_id=s.id WHERE s.product_id=p.id) AS price FROM products p WHERE p.id=$1 AND p.status='published'`, [body.product_id ?? null]);
        if (!p) throw notFound('PRODUCT');
        customData = { content_ids: [p.id], content_type: 'product', currency: 'UZS', ...(p.price ? { value: uzs(p.price) } : {}) };
        if (body.landing_id) landingId = (await maybeOne<{ id: string }>(tx, `SELECT id FROM landing_pages WHERE id=$1 AND status='published'`, [body.landing_id]))?.id ?? null;
      } else {
        const q = await maybeOne<{ payable_minor: string }>(tx, `SELECT payable_minor::text FROM checkout_quotes WHERE id=$1 AND expires_at > now()`, [body.quote_id ?? null]);
        if (!q) throw notFound('QUOTE');
        customData = { currency: 'UZS', value: uzs(q.payable_minor) };
      }
      const userData = { ...(validFbCookie(body.fbp) ? { fbp: body.fbp } : {}), ...(validFbCookie(body.fbc) ? { fbc: body.fbc } : {}) };
      try {
        const r = await recordEvent(tx, {
          businessKey: `${body.event}:${subject}:${body.event_id}`, eventId: body.event_id, internalEvent: body.event, eventTime: new Date(), actionSource: 'website',
          landingId, subject, consent: c, customData, userData, sourceUrl: sanitizeSourceUrl(body.source_url),
        });
        return { accepted: true, event_id: r.event_id, event_name: r.meta_event, replayed: !r.created };
      } catch (e) {
        if ((e as { code?: string }).code === 'EVENT_ID_TAKEN') throw new AppError(409, 'EVENT_ID_TAKEN');
        throw e;
      }
    });
  });

  route(app, deps, { method: 'GET', url: '/admin/tracking/health', tags: ['admin', ...T], summary: 'Pixel/CAPI diagnostics: readiness, counts by status, last success/rejection' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return trackingHealth(db);
  });

  route(app, deps, {
    method: 'PUT', url: '/admin/tracking/settings', tags: ['admin', ...T], summary: 'Owner: the single shop dataset (P0). Credentials are never accepted here.',
    body: z.object({
      dataset_id: z.string().regex(/^[0-9]{6,20}$/).nullable().optional(), enabled: z.boolean().optional(),
      test_event_code: z.string().regex(/^[A-Za-z0-9]{3,40}$/).nullable().optional(), api_version: z.string().regex(/^v\d{1,3}\.\d{1,2}$/).nullable().optional(),
    }).strict(),
  }, async ({ actor, db, cfg, body }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    if (body.test_event_code && cfg.env === 'production') throw new AppError(422, 'TEST_CODE_NOT_ALLOWED_IN_PRODUCTION');
    return withTx(db, async (tx) => {
      const before = await trackingSettings(tx);
      const next = { ...before, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
      await tx.query(`UPDATE tracking_settings SET dataset_id=$1, enabled=$2, test_event_code=$3, api_version=$4, updated_by=$5, updated_at=now() WHERE id=1`,
        [next.dataset_id, next.enabled, next.test_event_code, next.api_version, actor.userId]);
      await audit(tx, actor, 'tracking.settings', { type: 'tracking_settings', id: '1' }, { before: { dataset_id: before.dataset_id, enabled: before.enabled, api_version: before.api_version }, after: { dataset_id: next.dataset_id, enabled: next.enabled, api_version: next.api_version } });
      return trackingHealth(tx);
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/tracking/dispatch', tags: ['admin', ...T], summary: 'Owner: run the dispatcher now (diagnostics)' }, async ({ actor, db, cfg }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    return { counts: await dispatchTracking(db, cfg.env) };
  });
}
