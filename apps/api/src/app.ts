import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { type Actor, loadActor } from './platform/auth.js';
import type { Db } from './platform/db.js';
import { AppError } from './platform/errors.js';
import type { Deps } from './platform/http.js';
import { registerIdentity } from './modules/identity/routes.js';
import { registerCatalog } from './modules/catalog/routes.js';
import { registerMedia, registerMediaServe } from './modules/catalog/media.js';
import { registerImports } from './modules/catalog/imports.js';
import { registerCheckout } from './modules/checkout/routes.js';
import { registerOrders } from './modules/orders/routes.js';
import { registerAmendments } from './modules/orders/amendments.js';
import { registerPartners } from './modules/partners/routes.js';
import { registerPartnerCabinet } from './modules/partners/cabinet.js';
import { registerSalesDrafts } from './modules/partners/drafts.js';
import { registerPartnerWallet } from './modules/partners/wallet.js';
import { registerPartnerPrograms } from './modules/partners/programs.js';
import { registerReturns } from './modules/returns/routes.js';
import { registerPayments } from './modules/payments/routes.js';
import { registerSupport } from './modules/support/routes.js';
import { registerAdmin } from './modules/admin/routes.js';
import { registerAdminOverview } from './modules/admin/overview.js';
import { registerMessaging } from './modules/notifications/routes.js';
import { registerAi } from './modules/ai/routes.js';
import { registerVideos, registerVideoServe, VIDEO_MAX_BYTES } from './modules/catalog/videos.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
    rawBodyText?: string;
  }
}

export async function buildApp(cfg: AppConfig, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    bodyLimit: 8 * 1024 * 1024,
  });
  // Validation is done with zod inside handlers; JSON schemas are for OpenAPI only.
  app.setValidatorCompiler(() => () => true);

  // Keep the raw body for webhook signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBodyText = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'MALFORMED_JSON'), undefined);
    }
  });
  // Product videos are uploaded as raw MP4 bytes (no base64 inflation); the route enforces its own size limit.
  app.addContentTypeParser('video/mp4', { parseAs: 'buffer', bodyLimit: VIDEO_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBodyText = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  await app.register(cors, { origin: [cfg.publicWebUrl], credentials: true, exposedHeaders: ['x-request-id', 'etag'], allowedHeaders: ['content-type', 'authorization', 'x-session-token', 'x-guest-token', 'idempotency-key', 'x-request-id'] });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Online Magazin API', version: '1.0.0', description: 'MASTER 8.4 contract. Money = {amount_minor: string, currency}.' },
      servers: [{ url: '/' }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.decorateRequest('actor', null as unknown as Actor);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Session token: X-Session-Token (web app; leaves Authorization free for an edge basic-auth on DEMO/staging)
    // or Authorization: Bearer (API clients).
    const auth = req.headers.authorization;
    const xs = req.headers['x-session-token'];
    const token = typeof xs === 'string' && xs.length > 0 ? xs : auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const guest = (req.headers['x-guest-token'] as string | undefined) ?? null;
    req.actor = await loadActor(db, token, req.id, guest && guest.length >= 16 && guest.length <= 200 ? guest : null);
  });

  app.setErrorHandler((err, req, reply) => {
    const correlation_id = req.id;
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        code: err.code, message_key: `errors.${err.code}`, field_errors: err.fieldErrors, retryable: err.retryable, correlation_id, ...(err.details ? { details: err.details } : {}),
      });
    }
    const pg = err as { code?: string; message?: string; constraint?: string };
    if (pg.code === '23505') return reply.status(409).send({ code: 'DUPLICATE', message_key: 'errors.DUPLICATE', field_errors: {}, retryable: false, correlation_id, details: { constraint: pg.constraint } });
    if (pg.code === '23514' || pg.code === '23503') return reply.status(422).send({ code: 'CONSTRAINT_VIOLATION', message_key: 'errors.CONSTRAINT_VIOLATION', field_errors: {}, retryable: false, correlation_id, details: { constraint: pg.constraint } });
    if (pg.code === 'P0001') {
      const code = (pg.message ?? 'BUSINESS_RULE').split(/[: ]/)[0]!;
      return reply.status(422).send({ code, message_key: `errors.${code}`, field_errors: {}, retryable: false, correlation_id });
    }
    if (pg.code === '40001' || pg.code === '40P01') return reply.status(409).send({ code: 'CONCURRENT_UPDATE', message_key: 'errors.CONCURRENT_UPDATE', field_errors: {}, retryable: true, correlation_id });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ code: 'BAD_REQUEST', message_key: 'errors.BAD_REQUEST', field_errors: {}, retryable: false, correlation_id });
    req.log.error({ err }, 'unhandled');
    if (process.env.DEBUG_ERRORS) console.error(err);
    // No stack traces or internals to clients (MASTER 8.5).
    return reply.status(500).send({ code: 'INTERNAL', message_key: 'errors.INTERNAL', field_errors: {}, retryable: true, correlation_id });
  });

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'db_unavailable' });
    }
  });

  const deps: Deps = { db, cfg };
  registerMediaServe(app, deps);
  registerVideoServe(app, deps);

  await app.register(
    async (api) => {
      registerIdentity(api, deps);
      registerCatalog(api, deps);
      registerImports(api, deps);
      registerMedia(api, deps);
      registerCheckout(api, deps);
      registerOrders(api, deps);
      registerAmendments(api, deps);
      registerPartners(api, deps);
      registerPartnerCabinet(api, deps);
      registerSalesDrafts(api, deps);
      registerPartnerWallet(api, deps);
      registerPartnerPrograms(api, deps);
      registerVideos(api, deps);
      registerReturns(api, deps);
      registerPayments(api, deps);
      registerSupport(api, deps);
      registerAdmin(api, deps);
      registerAdminOverview(api, deps);
      registerMessaging(api, deps);
      registerAi(api, deps);
    },
    { prefix: '/api/v1' },
  );
  return app;
}
