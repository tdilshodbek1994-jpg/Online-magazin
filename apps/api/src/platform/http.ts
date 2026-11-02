import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Actor } from './auth.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

export interface Ctx<B = unknown, Q = unknown, P = unknown> {
  actor: Actor;
  body: B;
  query: Q;
  params: P;
  req: FastifyRequest;
  reply: FastifyReply;
  db: Db;
  cfg: AppConfig;
  idempotencyKey: string | null;
}

export interface Deps {
  db: Db;
  cfg: AppConfig;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RouteDef<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> {
  method: Method;
  url: string;
  tags: string[];
  summary: string;
  body?: B;
  query?: Q;
  params?: P;
  rawBody?: boolean;
}

function jsonSchema(s: z.ZodType | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const js = z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    delete js.$schema;
    return js;
  } catch {
    return undefined;
  }
}

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return value as z.infer<T>;
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of r.error.issues) fieldErrors[[where, ...i.path].join('.')] = i.code === 'custom' ? i.message : `validation.${i.code}`;
    throw new AppError(400, 'VALIDATION_FAILED', fieldErrors);
  }
  return r.data;
}

export function route<B extends z.ZodType = z.ZodUnknown, Q extends z.ZodType = z.ZodUnknown, P extends z.ZodType = z.ZodUnknown>(
  app: FastifyInstance,
  deps: Deps,
  def: RouteDef<B, Q, P>,
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown>,
): void {
  app.route({
    method: def.method,
    url: def.url,
    schema: Object.fromEntries(
      Object.entries({ tags: def.tags, summary: def.summary, body: jsonSchema(def.body), querystring: jsonSchema(def.query), params: jsonSchema(def.params) }).filter(([, v]) => v !== undefined),
    ),
    handler: async (req, reply) => {
      const ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>> = {
        actor: req.actor,
        body: parse(def.body, req.body, 'body'),
        query: parse(def.query, req.query, 'query'),
        params: parse(def.params, req.params, 'params'),
        req,
        reply,
        db: deps.db,
        cfg: deps.cfg,
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
      };
      const out = await handler(ctx);
      if (reply.sent) return reply;
      return out ?? { ok: true };
    },
  });
}

export const zUuid = z.string().uuid();
export const zMoneyStr = z.string().regex(/^\d+$/, 'money.amount_minor must be an integer string');
export const zLocalized = z.object({ 'uz-Latn': z.string().max(500).optional(), 'uz-Cyrl': z.string().max(500).optional(), ru: z.string().max(500).optional() })
  .refine((v) => Object.values(v).some((s) => s && s.trim().length > 0), 'validation.localized_required');
export const zIdParam = z.object({ id: zUuid });

export function requireIdempotencyKey(key: string | null): string {
  if (!key || key.length < 8 || key.length > 200) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  return key;
}

export function money(v: string | bigint | number, currency = 'UZS') {
  return { amount_minor: String(v), currency };
}
