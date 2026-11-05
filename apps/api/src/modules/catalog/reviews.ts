import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one } from '../../platform/db.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

/**
 * Reviews: verified purchase only (delivered order line of this customer), one per line, moderated. Reject reasons are
 * limited to spam / personal data / offensive / not about the product — never «low rating». Author shown as first name
 * + initial; phones/addresses are refused at submit.
 */
const PII = /\+?\d[\d\s\-()]{7,}\d|@\w|t\.me\//i;
const shortName = (n: string | null) => { if (!n) return 'Xaridor'; const [a, b] = n.trim().split(/\s+/); return b ? `${a} ${b[0]}.` : a!; };

export function registerReviews(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/products/:id/reviews', tags: ['catalog'], summary: 'Published reviews + rating summary', params: zIdParam }, async ({ db, params }) => {
    const s = await one<{ n: number; avg: string | null }>(db, `SELECT COUNT(*)::int AS n, ROUND(AVG(rating)::numeric, 1)::text AS avg FROM product_reviews WHERE product_id=$1 AND status='published'`, [params.id]);
    const items = await many<{ rating: number; body: string | null; created_at: string; name: string | null }>(db,
      `SELECT r.rating, r.body, r.created_at, u.display_name AS name FROM product_reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=$1 AND r.status='published' ORDER BY r.created_at DESC LIMIT 30`, [params.id]);
    return { count: s.n, average: s.avg, items: items.map((i) => ({ rating: i.rating, body: i.body, created_at: i.created_at, author: shortName(i.name), verified: true })) };
  });

  route(app, deps, { method: 'GET', url: '/me/reviewable', tags: ['catalog'], summary: 'Delivered items I can review', }, async ({ actor, db }) => {
    requireUser(actor);
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    return { items: await many(db, `SELECT ol.id AS order_line_id, sk.product_id, ol.product_snapshot->'name' AS name, o.delivered_at
        FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN skus sk ON sk.id=ol.sku_id
       WHERE (o.user_id=$1 OR (o.user_id IS NULL AND o.customer_phone=$2)) AND o.fulfillment_status='delivered' AND ol.qty > ol.canceled_qty + ol.returned_qty
         AND NOT EXISTS (SELECT 1 FROM product_reviews r WHERE r.order_line_id=ol.id) ORDER BY o.delivered_at DESC LIMIT 30`, [actor.userId, u.phone_e164]) };
  });

  route(app, deps, { method: 'POST', url: '/me/reviews', tags: ['catalog'], summary: 'Review a delivered item (verified purchase only)',
    body: z.object({ order_line_id: z.string().uuid(), rating: z.number().int().min(1).max(5), body: z.string().trim().max(1000).optional() }).strict() },
  async ({ actor, db, body }) => {
    requireUser(actor);
    const u = await one<{ phone_e164: string }>(db, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
    const l = await maybeOne<{ product_id: string; delivered: boolean }>(db, `SELECT sk.product_id, (o.fulfillment_status='delivered') AS delivered FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN skus sk ON sk.id=ol.sku_id
        WHERE ol.id=$1 AND (o.user_id=$2 OR (o.user_id IS NULL AND o.customer_phone=$3))`, [body.order_line_id, actor.userId, u.phone_e164]);
    if (!l) throw notFound('ORDER_LINE');
    if (!l.delivered) throw unprocessable('REVIEW_REQUIRES_DELIVERY');
    if (body.body && PII.test(body.body)) throw unprocessable('REVIEW_HAS_CONTACTS');
    const r = await maybeOne<{ id: string }>(db, `INSERT INTO product_reviews (product_id, order_line_id, user_id, rating, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_line_id) DO NOTHING RETURNING id`,
      [l.product_id, body.order_line_id, actor.userId, body.rating, body.body || null]);
    if (!r) throw conflict('ALREADY_REVIEWED');
    return { id: r.id, status: 'pending', note: 'Rahmat! Sharhingiz tekshiruvdan keyin chiqadi.' };
  });

  route(app, deps, { method: 'GET', url: '/admin/reviews', tags: ['catalog'], summary: 'Moderation queue', query: z.object({ status: z.enum(['pending', 'published', 'rejected']).default('pending') }) },
    async ({ actor, db, query }) => {
      requirePerm(actor, 'catalog.write');
      return { items: await many(db, `SELECT r.id, r.rating, r.body, r.status, r.reject_reason, r.created_at, p.name AS product FROM product_reviews r JOIN products p ON p.id=r.product_id WHERE r.status=$1 ORDER BY r.created_at LIMIT 100`, [query.status]) };
    });

  route(app, deps, { method: 'POST', url: '/admin/reviews/:id/moderate', tags: ['catalog'], summary: 'Publish or reject (limited reasons; low rating is not a reason)',
    params: zIdParam, body: z.object({ decision: z.enum(['published', 'rejected']), reason: z.enum(['spam', 'personal_data', 'offensive', 'not_about_product']).optional() }).strict() },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    if (body.decision === 'rejected' && !body.reason) throw unprocessable('REJECT_REASON_REQUIRED');
    const r = await maybeOne<{ id: string }>(db, `UPDATE product_reviews SET status=$2, reject_reason=$3, moderated_by=$4, moderated_at=now() WHERE id=$1 RETURNING id`,
      [params.id, body.decision, body.decision === 'rejected' ? body.reason : null, actor.userId]);
    if (!r) throw notFound('REVIEW');
    await audit(db, actor, `review.${body.decision}`, { type: 'review', id: params.id }, { reason: body.reason ?? null });
    return { ok: true };
  });
}
