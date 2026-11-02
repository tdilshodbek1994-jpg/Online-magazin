import { normalizeSearch, tokenize } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';
import type { Db } from '../../platform/db.js';
import { getAdviceClient } from './claude.js';

/**
 * Limited AI assist (§24). Provider abstraction: `local_retrieval` (deterministic, no LLM — answers only
 * from the live catalog/DB) is the only provider in this release; an external LLM provider is externally
 * blocked (key, budget, data-policy approval). AI never creates orders, changes prices/stock, or moves money.
 * Catalog text is treated strictly as data — it is never executed as instructions (T089).
 */
const DAILY_CAP = Number(process.env.AI_DAILY_REQUEST_CAP ?? 2000);

async function guard(db: Db, feature: string): Promise<void> {
  const f = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.enabled'`);
  if (!f?.enabled) throw new AppError(503, 'AI_DISABLED', {}, false, { fallback: 'use_search_or_operator' });
  const u = await one<{ requests: number }>(db, `INSERT INTO ai_usage (day, feature, requests) VALUES ((now() AT TIME ZONE 'Asia/Tashkent')::date, $1, 1)
      ON CONFLICT (day, feature) DO UPDATE SET requests = ai_usage.requests + 1 RETURNING requests`, [feature]);
  if (u.requests > DAILY_CAP) throw new AppError(503, 'AI_BUDGET_EXHAUSTED', {}, true, { fallback: 'use_search_or_operator' });
}

/** "100 mingdan arzon", "до 100 000", "100000 so'mgacha" → max price in tiyin. */
export function parseBudget(text: string): bigint | null {
  const t = normalizeSearch(text).replace(/\s+/g, ' ');
  const m = /(?:^|[^a-z0-9])(\d{1,3}(?: \d{3})+|\d{1,10})\s*(ming|min|k|mln|million)?\s*(so'm|sum)?\s*(dan arzon|gacha|dan past|dan kam|dan oshmasin|so'mdan arzon|so'mgacha)|(?:^|\s)(?:do|до)\s+(\d{1,3}(?: \d{3})+|\d{1,10})\s*(ming|tys|tis|тыс)?/.exec(t);
  if (!m) return null;
  const num = BigInt((m[1] ?? m[5] ?? '0').replace(/ /g, ''));
  const unit = m[2] ?? m[6];
  const mult = unit === 'mln' || unit === 'million' ? 1_000_000n : unit ? 1000n : 1n;
  return num * mult * 100n;
}

export function registerAi(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/ai/shopping', tags: ['ai'], summary: 'Shopping advisor (catalog-grounded, live price/stock, source cards)', body: z.object({ message: z.string().min(2).max(500), locale: z.enum(['uz-Latn', 'uz-Cyrl', 'ru']).default('uz-Latn') }) },
    async ({ db, body }) => {
      await guard(db, 'shopping');
      const budget = parseBudget(body.message);
      const stop = new Set(['menga', 'kerak', 'bormi', 'qanday', 'arzon', 'dan', 'gacha', 'ming', "so'm", 'sum', 'do', 'mne', 'nuzhen', 'nuzhna']);
      const tokens = tokenize(body.message).filter((x) => !stop.has(x) && !/^\d+$/.test(x)).slice(0, 5);
      const syn = tokens.length ? await many<{ term: string; synonym: string }>(db, `SELECT term, synonym FROM search_synonyms WHERE term = ANY($1)`, [tokens]) : [];
      const alts = [...new Set([...tokens, ...syn.map((s) => s.synonym)])].filter((x) => x.length >= 3);
      if (!alts.length) return { provider: 'local_retrieval', answer_key: 'ai.need_more_detail', products: [], sources: [] };
      // Live price & availability from the same tables checkout uses — never generated text.
      const rows = await many<{ id: string; slug: string; name: Record<string, string>; min_price: string; available: number }>(db, `
        SELECT p.id, p.slug, p.name, MIN(o.price_minor)::text AS min_price, COALESCE(SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)),0)::int AS available
          FROM products p JOIN skus s ON s.product_id=p.id AND s.status='active' JOIN offers o ON o.sku_id=s.id AND o.status='active' LEFT JOIN stock_balances sb ON sb.sku_id=s.id
         WHERE p.status='published' AND (${alts.map((_, i) => `p.search_doc LIKE $${i + 1}`).join(' OR ')})
         GROUP BY p.id HAVING ($${alts.length + 1}::bigint IS NULL OR MIN(o.price_minor) <= $${alts.length + 1}::bigint)
         ORDER BY COALESCE(SUM(GREATEST(0, sb.on_hand_sellable - sb.reserved - sb.safety_buffer)),0) > 0 DESC, MIN(o.price_minor) ASC LIMIT 10`, [...alts.map((a) => `%${a}%`), budget?.toString() ?? null]);
      const toProduct = (r: (typeof rows)[number]) => ({ product_id: r.id, slug: r.slug, name: r.name, price: { amount_minor: r.min_price, currency: 'UZS' }, available: r.available, in_stock: r.available > 0 });
      // External LLM (optional): chooses among server-built candidates only; any failure → local result.
      const ai = rows.length ? getAdviceClient() : null;
      let fallbackReason: string | null = null;
      if (ai) {
        try {
          const cands = rows.map((r) => ({ id: r.id, name: r.name[body.locale] || r.name['uz-Latn'] || Object.values(r.name)[0] || '', price_som: (BigInt(r.min_price) / 100n).toString(), in_stock: r.available > 0 }));
          const advice = await ai.advise(body.message, cands, body.locale);
          const allowed = new Set(rows.map((r) => r.id));
          const picked = advice.product_ids.filter((id) => allowed.has(id)); // hallucinated ids are dropped
          const chosen = picked.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
          return {
            provider: 'anthropic',
            answer_text: advice.answer,
            budget_max_minor: budget?.toString() ?? null,
            products: chosen.map(toProduct),
            sources: chosen.map((r) => ({ type: 'catalog', product_id: r.id, url: `/p/${r.slug}` })),
            dropped_unknown_ids: advice.product_ids.length - picked.length,
            disclaimer_key: 'ai.price_checked_at_checkout',
          };
        } catch (e) {
          fallbackReason = (e as Error).name === 'APIConnectionTimeoutError' ? 'timeout' : (e as Error).message?.slice(0, 60) || 'error';
        }
      }
      rows.splice(5);
      return {
        provider: 'local_retrieval',
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        answer_key: rows.length ? 'ai.found_products' : budget ? 'ai.nothing_within_budget' : 'ai.nothing_found',
        budget_max_minor: budget?.toString() ?? null,
        products: rows.map((r) => ({ product_id: r.id, slug: r.slug, name: r.name, price: { amount_minor: r.min_price, currency: 'UZS' }, available: r.available, in_stock: r.available > 0 })),
        sources: rows.map((r) => ({ type: 'catalog', product_id: r.id, url: `/p/${r.slug}` })),
        disclaimer_key: 'ai.price_checked_at_checkout',
      };
    });

  // Personal order status: ownership checked on the server from the session, never from the prompt (T089).
  route(app, deps, { method: 'POST', url: '/ai/order-status', tags: ['ai'], summary: 'Own order status (ownership verified server-side)', body: z.object({ order_id: z.string().uuid() }) },
    async ({ actor, db, body }) => {
      requireUser(actor);
      await guard(db, 'order_status');
      const o = await maybeOne(db, `SELECT o.number, o.commercial_status, o.fulfillment_status, o.payment_status FROM orders o JOIN users u ON u.id=$2 WHERE o.id=$1 AND (o.user_id=$2 OR (o.user_id IS NULL AND o.customer_phone=u.phone_e164))`, [body.order_id, actor.userId]);
      if (!o) throw notFound('ORDER');
      return { provider: 'local_retrieval', order: o };
    });

  // Owner/catalog: description DRAFT from confirmed facts only; never published automatically (§24, AC-M50-1).
  route(app, deps, { method: 'POST', url: '/admin/ai/description-draft', tags: ['ai'], summary: 'Product description draft from confirmed data (requires human review)', body: z.object({ product_id: z.string().uuid() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'catalog.write');
      await guard(db, 'description_draft');
      const p = await maybeOne<{ name: Record<string, string>; brand: string | null; model: string | null; warranty_months: number | null }>(db, `SELECT p.name, b.name AS brand, p.model, p.warranty_months FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.id=$1`, [body.product_id]);
      if (!p) throw notFound('PRODUCT');
      const variants = await many<{ variant: Record<string, string> }>(db, `SELECT variant FROM skus WHERE product_id=$1 AND status='active'`, [body.product_id]);
      const facts = [p.brand && `Brend: ${p.brand}`, p.model && `Model: ${p.model}`, p.warranty_months ? `Kafolat: ${p.warranty_months} oy` : null, variants.length > 1 ? `Variantlar: ${variants.map((v) => Object.values(v.variant).join('/')).join(', ')}` : null].filter(Boolean);
      return { provider: 'local_retrieval', status: 'draft_requires_review', draft: { 'uz-Latn': `${p.name['uz-Latn'] ?? ''}.\n${facts.join('\n')}` }, facts_used: facts, unknown_fields_not_invented: ['material', 'certificates', 'performance_claims'] };
    });
}
