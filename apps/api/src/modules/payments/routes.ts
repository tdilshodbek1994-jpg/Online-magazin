import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../platform/auth.js';
import { maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { handleClick } from './click.js';
import { handlePayme } from './payme.js';
import { capturePayment } from './service.js';

export function registerPayments(app: FastifyInstance, deps: Deps): void {
  const T = ['payments'];

  route(app, deps, { method: 'POST', url: '/orders/:id/payment-attempts', tags: T, summary: 'Start online payment → provider checkout URL', params: zIdParam, body: z.object({ provider: z.enum(['payme', 'click', 'mock']) }) },
    async ({ actor, db, cfg, params, body }) => {
      requireUser(actor);
      const o = await maybeOne<{ id: string; payment_method: string; commercial_status: string; payment_status: string; amount_minor: string; intent_id: string }>(db,
        `SELECT o.id, o.payment_method, o.commercial_status, o.payment_status, pi.amount_minor::text, pi.id AS intent_id FROM orders o JOIN payment_intents pi ON pi.order_id=o.id JOIN users u ON u.id=$2
          WHERE o.id=$1 AND (o.user_id=$2 OR (o.user_id IS NULL AND o.customer_phone=u.phone_e164))`, [params.id, actor.userId]);
      if (!o) throw notFound('ORDER');
      if (o.payment_method !== 'online' || o.commercial_status !== 'confirmed' || !['unpaid', 'pending', 'failed'].includes(o.payment_status)) throw unprocessable('ORDER_NOT_PAYABLE');
      const ret = `${cfg.publicWebUrl}/orders/${o.id}?payment=return`;
      if (body.provider === 'payme') {
        if (cfg.payments.payme.mode === 'disabled') throw unprocessable('PROVIDER_DISABLED');
        const params64 = Buffer.from(`m=${cfg.payments.payme.merchantId};ac.order_id=${o.id};a=${o.amount_minor};c=${ret}`).toString('base64');
        return { provider: 'payme', mode: cfg.payments.payme.mode, test: cfg.payments.payme.mode !== 'live', redirect_url: `${cfg.payments.payme.checkoutUrl}/${params64}` };
      }
      if (body.provider === 'click') {
        if (cfg.payments.click.mode === 'disabled') throw unprocessable('PROVIDER_DISABLED');
        const som = `${BigInt(o.amount_minor) / 100n}.${(BigInt(o.amount_minor) % 100n).toString().padStart(2, '0')}`;
        const u = new URL(cfg.payments.click.checkoutUrl);
        u.search = new URLSearchParams({ service_id: cfg.payments.click.serviceId, merchant_id: cfg.payments.click.merchantId, amount: som, transaction_param: o.id, return_url: ret }).toString();
        return { provider: 'click', mode: cfg.payments.click.mode, test: cfg.payments.click.mode !== 'live', redirect_url: u.toString() };
      }
      if (!cfg.payments.mockEnabled) throw unprocessable('PROVIDER_DISABLED');
      const a = await one<{ id: string }>(db, `INSERT INTO payment_attempts (intent_id, provider, amount_minor, status, provider_ref) VALUES ($1,'mock',$2,'pending',gen_random_uuid()::text) RETURNING id`, [o.intent_id, o.amount_minor]);
      return { provider: 'mock', mode: 'MOCK', test: true, attempt_id: a.id, redirect_url: `${cfg.publicWebUrl}/pay/mock/${a.id}` };
    });

  // Provider callbacks — authenticated server-to-server only.
  app.post('/webhooks/payments/payme', { schema: { tags: T, summary: 'Payme Merchant API endpoint (JSON-RPC)' } }, async (req) => handlePayme(deps.db, deps.cfg, req.headers.authorization, req.body));
  app.post('/webhooks/payments/click/prepare', { schema: { tags: T, summary: 'CLICK Prepare' } }, async (req) => handleClick(deps.db, deps.cfg, 0, req.body as Record<string, string>));
  app.post('/webhooks/payments/click/complete', { schema: { tags: T, summary: 'CLICK Complete' } }, async (req) => handleClick(deps.db, deps.cfg, 1, req.body as Record<string, string>));

  // MOCK provider for local demo/E2E only; disabled in production and labelled MOCK in UI (T097).
  route(app, deps, { method: 'POST', url: '/payments/mock/:id/complete', tags: T, summary: 'MOCK: complete a mock attempt (dev/test only)', params: zIdParam, body: z.object({ outcome: z.enum(['succeeded', 'failed']) }) },
    async ({ db, cfg, params, body }) => {
      if (!cfg.payments.mockEnabled) throw new AppError(404, 'NOT_FOUND');
      return withTx(db, async (tx) => {
        const a = await maybeOne<{ provider: string; status: string }>(tx, `SELECT provider, status FROM payment_attempts WHERE id=$1 FOR UPDATE`, [params.id]);
        if (!a || a.provider !== 'mock') throw notFound('ATTEMPT');
        if (body.outcome === 'failed') {
          await tx.query(`UPDATE payment_attempts SET status='failed', updated_at=now() WHERE id=$1 AND status='pending'`, [params.id]);
          return { ok: true, result: 'failed' };
        }
        return { ok: true, result: await capturePayment(tx, cfg.env, params.id, null) };
      });
    });
}
