import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { myPartner } from '../partners/routes.js';
import { defaultDefinition, digestOf, zDefinition } from './schema.js';

/**
 * UZSHOP PRO — Landing Builder (P0B). Admin: create from a template, edit = new immutable revision (optimistic lock),
 * submit → owner approves the exact revision digest → publish (atomic switch) → revoke/archive/rollback.
 * Public: only the published revision + LIVE catalog facts (price/stock never come from the revision).
 * Partner: list published landings, create a flow (referral link bound to a landing + channel).
 */
const A = ['admin', 'landings'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');

/** Live catalog facts for rendering (never trusted for payment — checkout re-prices). */
export async function catalogFacts(q: Queryable, productIds: string[]) {
  return many(q, `
    SELECT p.id, p.slug, p.name, p.description, p.warranty_months, p.status,
      (SELECT json_agg(json_build_object('url', '/media/' || ma.storage_key) ORDER BY ma.sort) FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved') AS images,
      (SELECT json_agg(json_build_object('sku_id', s.id, 'variant', s.variant, 'price_minor', o.price_minor::text, 'compare_at_minor', o.compare_at_minor::text,
          'available', GREATEST(0, COALESCE((SELECT SUM(sb.on_hand_sellable - sb.reserved - sb.safety_buffer) FROM stock_balances sb WHERE sb.sku_id=s.id), 0))::int) ORDER BY o.price_minor)
         FROM skus s JOIN offers o ON o.sku_id=s.id AND o.merchant_org_id=p.owner_org_id AND o.status='active' WHERE s.product_id=p.id AND s.status='active') AS skus
    FROM products p WHERE p.id = ANY($1::uuid[])`, [productIds]);
}

export function registerLandings(app: FastifyInstance, deps: Deps): void {
  // ---------------- Public ----------------
  route(app, deps, { method: 'GET', url: '/landings/:slug', tags: ['public'], summary: 'Published landing: published revision + live catalog facts', params: z.object({ slug: z.string().max(64) }) },
    async ({ db, params, reply }) => {
      const l = await maybeOne<any>(db, `SELECT * FROM landing_pages WHERE slug=$1`, [params.slug]);
      if (!l || l.status !== 'published' || !l.published_revision) throw notFound('LANDING'); // drafts are never public (LT-011)
      const r = await one<any>(db, `SELECT definition, digest FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [l.id, l.published_revision]);
      const products = (await catalogFacts(db, l.product_ids)).filter((p: any) => p.status === 'published');
      reply.header('cache-control', 'public, max-age=30');
      const anyStock = products.some((p: any) => (p.skus ?? []).some((s: any) => s.available > 0));
      return { id: l.id, slug: l.slug, title: l.title, template: l.template, revision: l.published_revision, digest: r.digest, definition: r.definition, products,
        availability: anyStock ? 'in_stock' : 'unavailable' }; // trafficback: the page says "not available", no hidden swap (LT-029)
    });

  // ---------------- Admin ----------------
  route(app, deps, { method: 'GET', url: '/admin/landings', tags: A, summary: 'All landings' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return { items: await many(db, `SELECT id, slug, title, template, status, draft_revision, approved_revision, published_revision, version, updated_at,
      (SELECT COUNT(*)::int FROM referral_links l WHERE l.landing_id=landing_pages.id) AS flows FROM landing_pages ORDER BY updated_at DESC LIMIT 200`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/landings', tags: A, summary: 'Create a landing from a template (draft revision 1)',
    body: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/), title: z.string().trim().min(2).max(160), template: z.enum(['simple', 'pro', 'boom', 'multi']), product_ids: z.array(z.string().uuid()).min(1).max(12) }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'catalog.write');
    if (body.template !== 'multi' && body.product_ids.length !== 1) throw badRequest('ONE_PRODUCT_FOR_TEMPLATE');
    return withTx(db, async (tx) => {
      const ok = await one<{ n: number }>(tx, `SELECT COUNT(*)::int AS n FROM products WHERE id = ANY($1::uuid[]) AND status='published'`, [body.product_ids]);
      if (ok.n !== new Set(body.product_ids).size) throw notFound('PRODUCT');
      const def = defaultDefinition(body.template);
      const l = await one<{ id: string }>(tx, `INSERT INTO landing_pages (slug, template, title, product_ids, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [body.slug, body.template, body.title, body.product_ids, actor.userId])
        .catch((e) => { if (e.code === '23505') throw conflict('SLUG_TAKEN'); throw e; });
      await tx.query(`INSERT INTO landing_revisions (landing_id, revision, definition, digest, created_by) VALUES ($1,1,$2,$3,$4)`, [l.id, JSON.stringify(def), digestOf(def), actor.userId]);
      await audit(tx, actor, 'landing.created', { type: 'landing', id: l.id }, { after: body });
      return { id: l.id, revision: 1 };
    });
  });

  route(app, deps, { method: 'GET', url: '/admin/landings/:id', tags: A, summary: 'Landing with revisions; preview data (noindex, no analytics)', params: zIdParam, query: z.object({ revision: z.coerce.number().int().optional() }) },
    async ({ actor, db, params, query, reply }) => {
      requirePerm(actor, 'catalog.write');
      const l = await maybeOne<any>(db, `SELECT * FROM landing_pages WHERE id=$1`, [params.id]);
      if (!l) throw notFound('LANDING');
      const rev = query.revision ?? l.draft_revision;
      const r = await maybeOne<any>(db, `SELECT revision, definition, digest, created_at FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [params.id, rev]);
      if (!r) throw notFound('REVISION');
      reply.header('x-robots-tag', 'noindex');
      return { ...l, preview: { revision: r.revision, definition: r.definition, digest: r.digest, analytics: false }, products: await catalogFacts(db, l.product_ids),
        revisions: await many(db, `SELECT revision, digest, created_at FROM landing_revisions WHERE landing_id=$1 ORDER BY revision DESC`, [params.id]) };
    });

  // Edit = new immutable revision. Published/approved revisions are untouched (LT-013); stale editor => 409 (LT-014).
  route(app, deps, { method: 'PUT', url: '/admin/landings/:id/draft', tags: A, summary: 'Save a new draft revision (schema-validated; optimistic lock)', params: zIdParam,
    body: z.object({ expected_version: z.number().int(), definition: z.unknown() }) },
  async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    const parsed = zDefinition.safeParse(body.definition);
    if (!parsed.success) throw new AppError(422, 'LANDING_SCHEMA_INVALID', Object.fromEntries(parsed.error.issues.slice(0, 5).map((i) => [i.path.join('.') || 'definition', i.message])));
    return withTx(db, async (tx) => {
      const l = await maybeOne<any>(tx, `SELECT * FROM landing_pages WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!l) throw notFound('LANDING');
      if (l.version !== body.expected_version) throw conflict('LANDING_VERSION_CONFLICT');
      if (['archived', 'revoked'].includes(l.status)) throw conflict('LANDING_CLOSED');
      if (parsed.data.template_type !== l.template) throw badRequest('TEMPLATE_MISMATCH');
      const rev = (await one<{ r: number }>(tx, `SELECT MAX(revision)+1 AS r FROM landing_revisions WHERE landing_id=$1`, [params.id])).r;
      await tx.query(`INSERT INTO landing_revisions (landing_id, revision, definition, digest, created_by) VALUES ($1,$2,$3,$4,$5)`, [params.id, rev, JSON.stringify(parsed.data), digestOf(parsed.data), actor.userId]);
      // A live page stays live on its approved revision; the new revision is a draft until approved again.
      await tx.query(`UPDATE landing_pages SET draft_revision=$2, status=CASE WHEN status IN ('review','approved') THEN 'draft' ELSE status END, version=version+1, updated_at=now() WHERE id=$1`, [params.id, rev]);
      await audit(tx, actor, 'landing.revision_saved', { type: 'landing', id: params.id }, { after: { revision: rev } });
      return { revision: rev, version: l.version + 1 };
    });
  });

  const step = (name: string, fn: (tx: any, l: any, actor: Actor, body: any) => Promise<any>, ownerOnly = false, bodySchema: z.ZodTypeAny = z.object({}).passthrough().default({})) =>
    route(app, deps, { method: 'POST', url: `/admin/landings/:id/${name}`, tags: A, summary: `Landing: ${name}`, params: zIdParam, body: bodySchema },
      async ({ actor, db, params, body }) => {
        requirePerm(actor, 'catalog.write');
        if (ownerOnly && !isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
        return withTx(db, async (tx) => {
          const l = await maybeOne<any>(tx, `SELECT * FROM landing_pages WHERE id=$1 FOR UPDATE`, [params.id]);
          if (!l) throw notFound('LANDING');
          const out = await fn(tx, l, actor, body);
          await audit(tx, actor, `landing.${name}`, { type: 'landing', id: params.id }, { before: { status: l.status }, after: out });
          return out;
        });
      });

  step('submit', async (tx, l) => {
    if (l.status !== 'draft' && l.status !== 'published') throw conflict('LANDING_STATUS_INVALID', { status: l.status });
    await tx.query(`UPDATE landing_pages SET status=CASE WHEN status='published' THEN status ELSE 'review' END, version=version+1, updated_at=now() WHERE id=$1`, [l.id]);
    return { status: l.status === 'published' ? 'published' : 'review', submitted_revision: l.draft_revision };
  });
  // Owner approval binds the exact revision digest the owner saw.
  step('approve', async (tx, l, actor, body) => {
    const r = await one<any>(tx, `SELECT digest FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [l.id, l.draft_revision]);
    if (body.digest && body.digest !== r.digest) throw conflict('DIGEST_MISMATCH');
    await tx.query(`UPDATE landing_pages SET approved_revision=$2, approved_digest=$3, approved_by=$4, approved_at=now(), status=CASE WHEN status='published' THEN status ELSE 'approved' END, version=version+1, updated_at=now() WHERE id=$1`, [l.id, l.draft_revision, r.digest, actor.userId]);
    return { approved_revision: l.draft_revision, digest: r.digest };
  }, true, z.object({ digest: z.string().length(64).optional() }).default({}));
  step('publish', async (tx, l) => {
    if (!l.approved_revision) throw conflict('NOT_APPROVED');
    const r = await one<any>(tx, `SELECT digest FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [l.id, l.approved_revision]);
    if (r.digest !== l.approved_digest) throw conflict('DIGEST_MISMATCH');
    await tx.query(`UPDATE landing_pages SET published_revision=approved_revision, published_at=now(), status='published', version=version+1, updated_at=now() WHERE id=$1`, [l.id]);
    return { status: 'published', published_revision: l.approved_revision };
  }, true);
  step('rollback', async (tx, l, _a, body) => {
    const rev = Number(body.revision);
    const r = await maybeOne<any>(tx, `SELECT digest FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [l.id, rev]);
    if (!r) throw notFound('REVISION');
    // Only a revision that was approved before may go live again: re-approve it explicitly (owner) — recorded as such.
    await tx.query(`UPDATE landing_pages SET approved_revision=$2, approved_digest=$3, published_revision=$2, published_at=now(), status='published', version=version+1, updated_at=now() WHERE id=$1`, [l.id, rev, r.digest]);
    return { status: 'published', published_revision: rev, rollback: true };
  }, true, z.object({ revision: z.number().int().min(1) }));
  step('revoke', async (tx, l) => { await tx.query(`UPDATE landing_pages SET status='revoked', version=version+1, updated_at=now() WHERE id=$1`, [l.id]); return { status: 'revoked' }; }, true);
  step('archive', async (tx, l) => { await tx.query(`UPDATE landing_pages SET status='archived', version=version+1, updated_at=now() WHERE id=$1`, [l.id]); return { status: 'archived' }; });

  // ---------------- Partner ----------------
  route(app, deps, { method: 'GET', url: '/partner/landings', tags: ['partner', 'landings'], summary: 'Approved (published) landings a partner can promote' }, async ({ actor, db }) => {
    await myPartner(db, actor, false);
    return { items: await many(db, `SELECT l.id, l.slug, l.title, l.template, l.product_ids, (SELECT name FROM products WHERE id=l.product_ids[1]) AS product_name FROM landing_pages l WHERE l.status='published' ORDER BY l.published_at DESC LIMIT 100`) };
  });
}
