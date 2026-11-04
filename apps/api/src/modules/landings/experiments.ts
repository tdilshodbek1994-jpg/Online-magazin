import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { getPolicy } from '../../platform/policies.js';
import { subjectKey } from '../tracking/service.js';

/**
 * P2B A/B experiments on landing revisions. One running experiment per landing; each visitor gets one sticky variant
 * (stored once, deterministic). Orders carry the experiment snapshot. Results use pooled sums (Σorders/Σexposures),
 * never an average of percentages, and say "insufficient data" below the evidence policy. No automatic winner/publish.
 */
const A = ['admin', 'landings'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');

/** Pooled rate over groups: Σconv / Σn × 100 (LT-099: 1/2 and 9/90 → 10/92 ≈ 10.869565%). */
export function pooledRate(groups: { conv: number; n: number }[]): number | null {
  const n = groups.reduce((a, g) => a + g.n, 0);
  return n > 0 ? (groups.reduce((a, g) => a + g.conv, 0) / n) * 100 : null;
}

/** Sticky assignment for a visitor (or null when no running experiment / no subject). */
export async function assignVariant(q: Queryable, landingId: string, actor: Pick<Actor, 'userId' | 'guestToken'>) {
  const e = await maybeOne<{ id: string; variant_a_revision: number; variant_b_revision: number; split_bps: number }>(q, `SELECT id, variant_a_revision, variant_b_revision, split_bps FROM landing_experiments WHERE landing_id=$1 AND status='running'`, [landingId]);
  const subject = subjectKey(actor);
  if (!e || !subject) return null;
  const h = parseInt(createHash('sha256').update(`${e.id}:${subject}`).digest('hex').slice(0, 8), 16) % 10000;
  const variant = h < e.split_bps ? 'A' : 'B';
  const rev = variant === 'A' ? e.variant_a_revision : e.variant_b_revision;
  await q.query(`INSERT INTO experiment_assignments (experiment_id, subject_key, variant, revision) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [e.id, subject, variant, rev]);
  const a = await one<{ variant: string; revision: number }>(q, `SELECT variant, revision FROM experiment_assignments WHERE experiment_id=$1 AND subject_key=$2`, [e.id, subject]);
  return { experiment_id: e.id, variant: a.variant, revision: a.revision };
}

/** The assignment this visitor already has (for validating an order's revision). */
export async function currentAssignment(q: Queryable, landingId: string, actor: Pick<Actor, 'userId' | 'guestToken'>) {
  const subject = subjectKey(actor);
  if (!subject) return null;
  return maybeOne<{ experiment_id: string; variant: string; revision: number }>(q, `SELECT a.experiment_id, a.variant, a.revision FROM landing_experiments e JOIN experiment_assignments a ON a.experiment_id=e.id
    WHERE e.landing_id=$1 AND e.status='running' AND a.subject_key=$2`, [landingId, subject]);
}

export function registerExperiments(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'POST', url: '/admin/landings/:id/experiments', tags: A, summary: 'Owner: start an A/B test between the published revision (A) and another revision (B)', params: zIdParam,
    body: z.object({ variant_b_revision: z.number().int().min(1), split_bps: z.number().int().min(100).max(9900).default(5000) }).strict() }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    const l = await maybeOne<{ status: string; published_revision: number | null }>(db, `SELECT status, published_revision FROM landing_pages WHERE id=$1`, [params.id]);
    if (!l || l.status !== 'published' || !l.published_revision) throw new AppError(422, 'LANDING_NOT_PUBLISHED');
    if (body.variant_b_revision === l.published_revision) throw new AppError(422, 'SAME_REVISION');
    if (!(await maybeOne(db, `SELECT 1 FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [params.id, body.variant_b_revision]))) throw notFound('REVISION');
    try {
      const e = await one<{ id: string }>(db, `INSERT INTO landing_experiments (landing_id, variant_a_revision, variant_b_revision, split_bps, started_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [params.id, l.published_revision, body.variant_b_revision, body.split_bps, actor.userId]);
      await audit(db, actor, 'landing.experiment_started', { type: 'landing', id: params.id }, { after: { a: l.published_revision, b: body.variant_b_revision, split_bps: body.split_bps } });
      return { id: e.id };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'EXPERIMENT_ALREADY_RUNNING');
      throw err;
    }
  });

  route(app, deps, { method: 'POST', url: '/admin/experiments/:id/stop', tags: A, summary: 'Owner: stop (assignments and order snapshots are kept; nothing is auto-published)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    const r = await db.query(`UPDATE landing_experiments SET status='stopped', stopped_at=now() WHERE id=$1 AND status='running'`, [params.id]);
    if (!r.rowCount) throw notFound('EXPERIMENT');
    await audit(db, actor, 'landing.experiment_stopped', { type: 'experiment', id: params.id }, {});
    return { ok: true };
  });

  route(app, deps, { method: 'GET', url: '/admin/landings/:id/experiments', tags: A, summary: 'Experiments with pooled results and an evidence verdict (owner decides)', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    requirePerm(actor, 'catalog.write');
    const pol = (await getPolicy<{ exposures_per_variant: number; orders_total: number }>(db, 'experiments.min_evidence', cfg.env))?.value ?? { exposures_per_variant: 100, orders_total: 20 };
    const exps = await many<{ id: string; status: string; variant_a_revision: number; variant_b_revision: number; split_bps: number; started_at: string; stopped_at: string | null }>(db,
      `SELECT id, status, variant_a_revision, variant_b_revision, split_bps, started_at, stopped_at FROM landing_experiments WHERE landing_id=$1 ORDER BY started_at DESC`, [params.id]);
    const items = [];
    for (const e of exps) {
      const v = await many<{ variant: string; n: number }>(db, `SELECT variant, COUNT(*)::int AS n FROM experiment_assignments WHERE experiment_id=$1 GROUP BY variant`, [e.id]);
      const o = await many<{ variant: string; n: number }>(db, `SELECT experiment_snapshot->>'variant' AS variant, COUNT(*)::int AS n FROM orders WHERE experiment_snapshot->>'experiment_id'=$1 GROUP BY 1`, [e.id]);
      const variants = ['A', 'B'].map((k) => {
        const n = v.find((x) => x.variant === k)?.n ?? 0, conv = o.find((x) => x.variant === k)?.n ?? 0;
        return { variant: k, revision: k === 'A' ? e.variant_a_revision : e.variant_b_revision, exposures: n, orders: conv, rate: n ? (conv / n) * 100 : null };
      });
      const enough = variants.every((x) => x.exposures >= pol.exposures_per_variant) && variants.reduce((a, x) => a + x.orders, 0) >= pol.orders_total;
      items.push({ ...e, variants, pooled_rate: pooledRate(variants.map((x) => ({ conv: x.orders, n: x.exposures }))),
        verdict: enough ? 'enough_data_owner_decides' : 'insufficient_data', auto_winner: null, policy: pol });
    }
    return { items };
  });
}
