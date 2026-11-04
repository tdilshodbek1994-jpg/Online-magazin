import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { decrypt, encrypt } from '../../platform/mfa.js';
import { getPolicy } from '../../platform/policies.js';
import { catalogFacts } from '../landings/routes.js';
import { metaAdapter, type RemoteIds } from './adapter.js';

/**
 * UZSHOP AI TARGET PRO — P1B. Owner connects Meta (OAuth state bound to the admin session, encrypted token, read vs
 * manage scopes, provider-verified assets). Campaign drafts come from approved product/landing facts (template; the AI
 * provider is off). Preflight → owner approval bound to a digest of everything that spends money (TTL) → provisioning
 * creates remote objects PAUSED through one idempotent operation (unknown outcome → reconcile by client_ref, never a
 * blind re-create). Activation needs the live-spend flag (off) and the same still-valid approval. Configured status and
 * provider effective status are separate. AI never launches, changes budgets or targeting on its own.
 */
const A = ['admin', 'target'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
function ownerOnly(a: Actor) { requirePerm(a, 'catalog.write'); if (!isOwner(a)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED'); }
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);

interface Draft {
  id: string; landing_id: string; landing_revision: number; flow_id: string | null; title: string; objective: string; ad_account_id: string | null; page_id: string | null; dataset_id: string | null;
  payer_label: string | null; currency: string; budget_type: 'daily' | 'lifetime'; budget_minor: string; start_at: string | null; end_at: string | null; audience: Record<string, unknown>; placements: string[];
  creative: Record<string, string>; creative_revision: number; policy_version: string; status: string; version: number; blocked_reason: string | null;
}
const DRAFT_COLS = `id, landing_id, landing_revision, flow_id, title, objective, ad_account_id, page_id, dataset_id, payer_label, currency, budget_type, budget_minor::text, start_at, end_at, audience, placements, creative, creative_revision, policy_version, status, version, blocked_reason, configured_status, effective_status, review_feedback`;
const getDraft = async (q: Queryable, id: string, lock = false) => {
  const d = await maybeOne<Draft>(q, `SELECT ${DRAFT_COLS} FROM campaign_drafts WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!d) throw notFound('CAMPAIGN');
  return d;
};

async function destinationUrl(q: Queryable, cfg: AppConfig, d: Draft) {
  const l = await one<{ slug: string }>(q, `SELECT slug FROM landing_pages WHERE id=$1`, [d.landing_id]);
  const code = d.flow_id ? (await maybeOne<{ code: string }>(q, `SELECT code FROM referral_links WHERE id=$1`, [d.flow_id]))?.code : null;
  return `${cfg.publicWebUrl}/l/${l.slug}${code ? `?r=${encodeURIComponent(code)}` : ''}`; // no PII in the URL
}

/** Everything that changes money, audience, creative or destination is in the approval scope (task §6.4). */
export async function approvalScope(q: Queryable, cfg: AppConfig, d: Draft) {
  const scope = {
    ad_account: d.ad_account_id, payer: d.payer_label, currency: d.currency, budget_type: d.budget_type, budget_minor: d.budget_minor,
    start_at: d.start_at ? new Date(d.start_at).toISOString() : null, end_at: d.end_at ? new Date(d.end_at).toISOString() : null,
    audience: d.audience, placements: d.placements, creative_revision: d.creative_revision, landing_id: d.landing_id, landing_revision: d.landing_revision,
    destination: await destinationUrl(q, cfg, d), page: d.page_id, dataset: d.dataset_id, objective: d.objective, policy_version: d.policy_version,
  };
  return { scope, digest: sha(stable(scope)) };
}

async function connection(q: Queryable) {
  return maybeOne<{ id: string; status: string; token_ciphertext: string | null; token_expires_at: string | null; scopes: string[]; ad_account_id: string | null; account_currency: string | null; account_timezone: string | null; page_id: string | null; dataset_id: string | null; verified_assets: Record<string, string>; business_id: string | null; last_error: string | null }>(
    q, `SELECT * FROM meta_connections WHERE status IN ('connected','pending','expired','error') ORDER BY (status='connected') DESC, updated_at DESC LIMIT 1`);
}
const tokenOf = (cfg: AppConfig, c: { token_ciphertext: string | null }) => decrypt(c.token_ciphertext!, cfg.mfaKey);

function connectionBlocker(c: Awaited<ReturnType<typeof connection>>, needManage: boolean): string | null {
  if (!c || c.status !== 'connected' || !c.token_ciphertext) return 'meta_not_connected';
  if (c.token_expires_at && new Date(c.token_expires_at) < new Date()) return 'meta_token_expired';
  if (needManage && !c.scopes.includes('ads_management')) return 'permission_missing:ads_management';
  return null;
}

/** Ad copy guard: plain text, no links/phones, no unprovable medical/guarantee claims (task §6.3). */
const BANNED = [/davolaydi|shifo|kasallikdan|tuzatadi/i, /100\s*%\s*(kafolat|natija)/i, /<|>|https?:\/\/|www\./i, /\+?998[\s\d-]{7,}/];
export const creativeIssues = (texts: string[]) => texts.flatMap((t) => BANNED.filter((r) => r.test(t)).map((r) => r.source.slice(0, 24)));

export async function preflight(q: Queryable, cfg: AppConfig, d: Draft) {
  const checks: { check: string; ok: boolean; reason?: string }[] = [];
  const add = (check: string, ok: boolean, reason?: string) => checks.push(ok ? { check, ok } : { check, ok, reason });
  const l = await maybeOne<{ status: string; published_revision: number | null; product_ids: string[] }>(q, `SELECT status, published_revision, product_ids FROM landing_pages WHERE id=$1`, [d.landing_id]);
  add('landing_published', !!l && l.status === 'published' && l.published_revision === d.landing_revision, !l || l.status !== 'published' ? 'landing_not_published' : 'landing_revision_changed');
  const facts = l ? await catalogFacts(q, l.product_ids) : [];
  add('product_available', facts.some((p: any) => (p.skus ?? []).some((s: any) => s.available > 0)), 'out_of_stock');
  const c = await connection(q);
  const cb = connectionBlocker(c, true);
  add('meta_connection', cb === null, cb ?? undefined);
  const va = c?.verified_assets ?? {};
  add('ad_account_verified', !!d.ad_account_id && va.ad_account === d.ad_account_id, 'asset_not_verified:ad_account');
  add('page_verified', !!d.page_id && va.page === d.page_id, 'asset_not_verified:page');
  add('dataset_verified', !d.dataset_id || va.dataset === d.dataset_id, 'asset_not_verified:dataset');
  const ts = await maybeOne<{ dataset_id: string | null }>(q, `SELECT dataset_id FROM tracking_settings WHERE id=1`);
  add('dataset_matches_tracking', !d.dataset_id || ts?.dataset_id === d.dataset_id, 'dataset_mismatch');
  add('currency_matches_account', !!c?.account_currency && c.account_currency === d.currency, 'currency_mismatch');
  add('budget_set', BigInt(d.budget_minor) > 0n, 'budget_missing');
  const now = Date.now();
  const s = d.start_at ? Date.parse(d.start_at) : NaN, e = d.end_at ? Date.parse(d.end_at) : NaN;
  add('schedule_valid', Number.isFinite(s) && s > now - 5 * 60_000 && (d.budget_type === 'daily' ? !d.end_at || e > s : e > s), 'schedule_invalid');
  const texts = [d.creative.headline ?? '', d.creative.primary_text ?? ''];
  add('creative_present', texts.every((t) => t.trim().length > 1), 'creative_missing');
  const issues = creativeIssues(texts);
  add('creative_policy', issues.length === 0, issues.length ? `creative_policy:${issues.join('|')}` : undefined);
  add('payer_shown', !!d.payer_label, 'payer_missing');
  return { ok: checks.every((x) => x.ok), checks };
}

async function validApproval(q: Queryable, cfg: AppConfig, d: Draft) {
  const a = await maybeOne<{ id: string; digest: string; expires_at: string }>(q, `SELECT id, digest, expires_at FROM campaign_approvals WHERE draft_id=$1 AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1`, [d.id]);
  const { digest } = await approvalScope(q, cfg, d);
  if (!a) return { ok: false as const, reason: 'approval_missing', digest };
  if (new Date(a.expires_at) <= new Date()) return { ok: false as const, reason: 'approval_expired', digest };
  if (a.digest !== digest) return { ok: false as const, reason: 'approval_stale', digest };
  return { ok: true as const, digest, approvalId: a.id };
}

const zCreative = z.object({ headline: z.string().trim().min(2).max(60), primary_text: z.string().trim().min(2).max(500), cta: z.enum(['SHOP_NOW', 'ORDER_NOW', 'LEARN_MORE']).default('ORDER_NOW') }).strict();
const zAudience = z.object({ geo: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(5), age_min: z.number().int().min(18).max(65), age_max: z.number().int().min(18).max(65), genders: z.array(z.enum(['male', 'female'])).max(2).optional() }).strict()
  .refine((a) => a.age_max >= a.age_min, 'age_range'); // no minors, no sensitive interests (not accepted at all)

export function registerTarget(app: FastifyInstance, deps: Deps): void {
  // ---------------------------------------------------------------- connection
  route(app, deps, { method: 'GET', url: '/admin/meta/connection', tags: A, summary: 'Meta connection + capability matrix (never the token)' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    const c = await connection(db);
    const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ads.live_spend'`);
    return {
      status: c?.status ?? 'not_connected', blocked_reason: connectionBlocker(c, false), scopes: c?.scopes ?? [], business_id: c?.business_id ?? null,
      ad_account_id: c?.ad_account_id ?? null, account_currency: c?.account_currency ?? null, account_timezone: c?.account_timezone ?? null, page_id: c?.page_id ?? null, dataset_id: c?.dataset_id ?? null,
      verified_assets: c?.verified_assets ?? {}, token_expires_at: c?.token_expires_at ?? null, last_error: c?.last_error ?? null,
      capabilities: { reporting: !!c?.scopes.includes('ads_read'), manage_ads: !!c?.scopes.includes('ads_management'), live_spend_flag: !!flag?.enabled },
      app_configured: metaAdapter().authorizeUrl('x', 'x') !== null, adapter: metaAdapter().name,
    };
  });

  route(app, deps, { method: 'POST', url: '/admin/meta/oauth/start', tags: A, summary: 'Owner: start Meta OAuth (state bound to this admin session, 10 min, single use)' }, async ({ actor, db, cfg }) => {
    ownerOnly(actor);
    if (!actor.sessionId) throw new AppError(401, 'SESSION_REQUIRED');
    const state = randomBytes(24).toString('base64url');
    const redirect = `${cfg.publicWebUrl}/admin/meta/callback`;
    const url = metaAdapter().authorizeUrl(state, redirect);
    if (!url) throw new AppError(409, 'META_APP_NOT_CONFIGURED');
    await db.query(`INSERT INTO meta_connections (owner_user_id, status, state_hash, state_session_id, state_expires_at) VALUES ($1,'pending',$2,$3, now() + interval '10 minutes')`, [actor.userId, sha(state), actor.sessionId]);
    return { authorize_url: url };
  });

  route(app, deps, { method: 'POST', url: '/admin/meta/oauth/callback', tags: A, summary: 'Owner: finish OAuth — state must match this session; token stored encrypted',
    body: z.object({ state: z.string().min(16).max(200), code: z.string().min(4).max(2000) }).strict() }, async ({ actor, db, cfg, body }) => {
    ownerOnly(actor);
    return withTx(db, async (tx) => {
      const p = await maybeOne<{ id: string }>(tx, `SELECT id FROM meta_connections WHERE status='pending' AND state_hash=$1 AND state_session_id=$2 AND state_expires_at > now() AND owner_user_id=$3 FOR UPDATE`, [sha(body.state), actor.sessionId, actor.userId]);
      if (!p) throw badRequest('OAUTH_STATE_INVALID'); // foreign/expired/replayed state never connects an account
      await tx.query(`UPDATE meta_connections SET state_hash=NULL, state_expires_at=NULL WHERE id=$1`, [p.id]); // single use
      let ex;
      try { ex = await metaAdapter().exchangeCode(body.code, `${cfg.publicWebUrl}/admin/meta/callback`); }
      catch (e) {
        await tx.query(`UPDATE meta_connections SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [p.id, (e as { code?: string }).code ?? 'exchange_failed']);
        return { ok: false, status: 'error', reason: (e as { code?: string }).code ?? 'exchange_failed' };
      }
      await tx.query(`UPDATE meta_connections SET status='revoked', token_ciphertext=NULL, updated_at=now() WHERE status='connected' AND id<>$1`, [p.id]);
      await tx.query(`UPDATE meta_connections SET status='connected', token_ciphertext=$2, token_expires_at=$3, scopes=$4, business_id=$5, last_error=NULL, updated_at=now() WHERE id=$1`,
        [p.id, encrypt(ex.token, cfg.mfaKey), ex.expires_at, ex.scopes, ex.business_id]);
      await audit(tx, actor, 'meta.connected', { type: 'meta_connection', id: p.id }, { after: { scopes: ex.scopes } });
      return { ok: true, status: 'connected', scopes: ex.scopes };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/meta/assets', tags: A, summary: 'Owner: bind ad account / Page / dataset — only what the provider confirms is stored',
    body: z.object({ ad_account_id: z.string().regex(/^act_\d{3,30}$/).optional(), page_id: z.string().regex(/^\d{3,30}$/).optional(), dataset_id: z.string().regex(/^\d{6,20}$/).optional() }).strict() },
    async ({ actor, db, cfg, body }) => {
      ownerOnly(actor);
      const c = await connection(db);
      const cb = connectionBlocker(c, false);
      if (cb) throw new AppError(409, cb.toUpperCase());
      const v = await metaAdapter().verifyAssets(tokenOf(cfg, c!), body);
      const verified: Record<string, string> = {};
      if (v.ad_account) verified.ad_account = v.ad_account.id;
      if (v.page) verified.page = v.page;
      if (v.dataset) verified.dataset = v.dataset;
      await db.query(`UPDATE meta_connections SET verified_assets=$2, ad_account_id=$3, account_currency=$4, account_timezone=$5, page_id=$6, dataset_id=$7, updated_at=now() WHERE id=$1`,
        [c!.id, JSON.stringify(verified), v.ad_account?.id ?? null, v.ad_account?.currency ?? null, v.ad_account?.timezone ?? null, v.page, v.dataset]);
      const missing = Object.entries(body).filter(([k]) => !verified[k.replace(/_id$/, '')]).map(([k]) => k);
      return { verified, not_confirmed: missing };
    });

  route(app, deps, { method: 'POST', url: '/admin/meta/disconnect', tags: A, summary: 'Owner: revoke locally (token deleted). Remote ads are NOT deleted by this.' }, async ({ actor, db }) => {
    ownerOnly(actor);
    await db.query(`UPDATE meta_connections SET status='revoked', token_ciphertext=NULL, updated_at=now() WHERE status IN ('connected','pending','error','expired')`);
    await audit(db, actor, 'meta.disconnected', { type: 'meta_connection', id: '-' }, {});
    return { ok: true, note: 'Token o‘chirildi. Meta’dagi reklamalar o‘chmaydi — kerak bo‘lsa avval to‘xtating.' };
  });

  // ---------------------------------------------------------------- drafts
  route(app, deps, { method: 'GET', url: '/admin/ad-campaigns', tags: A, summary: 'Campaign drafts with status, configured vs effective status' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return { items: await many(db, `SELECT c.id, c.title, c.status, c.blocked_reason, c.budget_type, c.budget_minor::text, c.currency, c.configured_status, c.effective_status, c.review_feedback, c.generator, c.updated_at, l.title AS landing, l.slug
        FROM campaign_drafts c JOIN landing_pages l ON l.id=c.landing_id ORDER BY c.updated_at DESC LIMIT 100`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns', tags: A, summary: 'Create a draft from a published landing (copy only from approved product facts; AI never launches)',
    body: z.object({ landing_id: z.string().uuid(), flow_id: z.string().uuid().optional(), title: z.string().trim().min(2).max(120).optional() }).strict() }, async ({ actor, db, body }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const l = await maybeOne<{ id: string; title: string; status: string; published_revision: number | null; product_ids: string[] }>(tx, `SELECT id, title, status, published_revision, product_ids FROM landing_pages WHERE id=$1`, [body.landing_id]);
      if (!l || l.status !== 'published' || !l.published_revision) throw new AppError(422, 'LANDING_NOT_PUBLISHED');
      if (body.flow_id && !(await maybeOne(tx, `SELECT 1 FROM referral_links WHERE id=$1 AND landing_id=$2`, [body.flow_id, l.id]))) throw notFound('FLOW');
      const rev = await one<{ definition: { blocks: { type: string; props: Record<string, any> }[] } }>(tx, `SELECT definition FROM landing_revisions WHERE landing_id=$1 AND revision=$2`, [l.id, l.published_revision]);
      const [p] = await catalogFacts(tx, l.product_ids) as any[];
      const name = p?.name?.['uz-Latn'] ?? l.title;
      const hero = rev.definition.blocks.find((b) => b.type === 'hero')?.props ?? {};
      const benefits: string[] = rev.definition.blocks.find((b) => b.type === 'benefits')?.props.items ?? [];
      const price = p?.skus?.[0]?.price_minor ? `${(BigInt(p.skus[0].price_minor) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m` : null;
      // Template copy from approved facts only (no invented claims, reviews or numbers). The AI provider is off (ai.enabled=false).
      const creative = {
        headline: String(hero.headline || name).slice(0, 60),
        primary_text: [hero.subline, ...benefits.slice(0, 3).map((b) => `✓ ${b}`), price ? `Narxi: ${price}. To‘lov qabul qilganda.` : null].filter(Boolean).join('\n').slice(0, 500) || name,
        cta: 'ORDER_NOW',
      };
      const c = await connection(tx);
      const tomorrow = new Date(Date.now() + 86_400_000); tomorrow.setUTCHours(4, 0, 0, 0); // 09:00 Tashkent
      const d = await one<{ id: string }>(tx, `INSERT INTO campaign_drafts (landing_id, landing_revision, flow_id, title, ad_account_id, page_id, dataset_id, currency, start_at, creative, generator, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'template',$11) RETURNING id`,
        [l.id, l.published_revision, body.flow_id ?? null, body.title ?? `${name} — kampaniya`, c?.verified_assets?.ad_account ?? null, c?.verified_assets?.page ?? null, c?.verified_assets?.dataset ?? null,
          c?.account_currency ?? 'UZS', tomorrow.toISOString(), JSON.stringify(creative), actor.userId]);
      await audit(tx, actor, 'campaign.draft_created', { type: 'campaign', id: d.id }, { after: { landing_id: l.id, generator: 'template' } });
      return { id: d.id };
    });
  });

  route(app, deps, { method: 'GET', url: '/admin/ad-campaigns/:id', tags: A, summary: 'Draft + current approval scope/digest + approval validity + operations', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    requirePerm(actor, 'catalog.write');
    const d = await getDraft(db, params.id);
    const { scope, digest } = await approvalScope(db, cfg, d);
    const appr = await validApproval(db, cfg, d);
    const ops = await many(db, `SELECT kind, status, attempts, error, created_at, updated_at FROM provisioning_operations WHERE draft_id=$1 ORDER BY created_at`, [d.id]);
    const remote = await many(db, `SELECT level, remote_id, configured_status, effective_status FROM remote_objects WHERE draft_id=$1 ORDER BY id`, [d.id]);
    const p = await maybeOne(db, `SELECT preflight FROM campaign_drafts WHERE id=$1`, [d.id]);
    return { ...d, scope, digest, approval: appr.ok ? { valid: true } : { valid: false, reason: appr.reason }, operations: ops, remote, preflight: (p as any)?.preflight ?? null };
  });

  route(app, deps, { method: 'PUT', url: '/admin/ad-campaigns/:id', tags: A, summary: 'Edit (optimistic lock). Any change to money/audience/creative/destination invalidates the previous approval.', params: zIdParam,
    body: z.object({
      expected_version: z.number().int(), title: z.string().trim().min(2).max(120).optional(), objective: z.enum(['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS']).optional(),
      ad_account_id: z.string().regex(/^act_\d{3,30}$/).optional(), page_id: z.string().regex(/^\d{3,30}$/).optional(), dataset_id: z.string().regex(/^\d{6,20}$/).nullable().optional(),
      payer_label: z.string().trim().min(2).max(120).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), budget_type: z.enum(['daily', 'lifetime']).optional(),
      budget_minor: z.string().regex(/^\d{1,15}$/).optional(), start_at: z.string().datetime({ offset: true }).optional(), end_at: z.string().datetime({ offset: true }).nullable().optional(),
      audience: zAudience.optional(), placements: z.array(z.enum(['facebook', 'instagram'])).min(1).max(2).optional(), creative: zCreative.optional(),
    }).strict() }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const d = await getDraft(tx, params.id, true);
      if (!['draft', 'preflight_failed', 'review', 'owner_approved', 'blocked'].includes(d.status)) throw new AppError(409, 'CAMPAIGN_LOCKED');
      if (d.version !== body.expected_version) throw new AppError(409, 'CAMPAIGN_VERSION_CONFLICT');
      const { expected_version: _v, creative, ...rest } = body;
      const sets: string[] = []; const vals: unknown[] = [d.id];
      for (const [k, v] of Object.entries(rest)) { if (v === undefined) continue; vals.push(k === 'audience' || k === 'placements' ? JSON.stringify(v) : v); sets.push(`${k}=$${vals.length}`); }
      if (creative && stable(creative) !== stable(d.creative)) { vals.push(JSON.stringify(creative)); sets.push(`creative=$${vals.length}`, 'creative_revision=creative_revision+1'); }
      if (!sets.length) return { id: d.id, version: d.version };
      const r = await one<{ version: number }>(tx, `UPDATE campaign_drafts SET ${sets.join(', ')}, status='draft', blocked_reason=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, vals);
      await audit(tx, actor, 'campaign.edited', { type: 'campaign', id: d.id }, { after: Object.keys(body) });
      return { id: d.id, version: r.version };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/preflight', tags: A, summary: 'Landing/stock/connection/permissions/assets/currency/budget/schedule/creative checks', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const d = await getDraft(tx, params.id, true);
      if (!['draft', 'preflight_failed', 'review', 'blocked'].includes(d.status)) throw new AppError(409, 'CAMPAIGN_LOCKED');
      const pf = await preflight(tx, cfg, d);
      await tx.query(`UPDATE campaign_drafts SET preflight=$2, status=$3, blocked_reason=$4, updated_at=now() WHERE id=$1`,
        [d.id, JSON.stringify(pf), pf.ok ? 'review' : 'preflight_failed', pf.ok ? null : pf.checks.filter((c) => !c.ok).map((c) => c.reason).join(',')]);
      const { digest, scope } = await approvalScope(tx, cfg, d);
      return { ...pf, digest: pf.ok ? digest : null, scope: pf.ok ? scope : null };
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/approve', tags: A, summary: 'Owner approves the exact scope (digest) for a limited time', params: zIdParam,
    body: z.object({ digest: z.string().length(64) }).strict() }, async ({ actor, db, cfg, params, body }) => {
    ownerOnly(actor);
    return withTx(db, async (tx) => {
      const d = await getDraft(tx, params.id, true);
      if (d.status !== 'review') throw new AppError(409, 'PREFLIGHT_REQUIRED');
      const { digest, scope } = await approvalScope(tx, cfg, d);
      if (digest !== body.digest) throw new AppError(409, 'APPROVAL_DIGEST_MISMATCH');
      const ttl = (await getPolicy<{ hours: number }>(tx, 'target.approval_ttl_hours', cfg.env))?.value.hours ?? 24;
      await tx.query(`UPDATE campaign_approvals SET revoked_at=now() WHERE draft_id=$1 AND revoked_at IS NULL`, [d.id]);
      await tx.query(`INSERT INTO campaign_approvals (draft_id, digest, scope, approved_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`, [d.id, digest, JSON.stringify(scope), actor.userId, ttl]);
      await tx.query(`UPDATE campaign_drafts SET status='owner_approved', updated_at=now() WHERE id=$1`, [d.id]);
      await audit(tx, actor, 'campaign.approved', { type: 'campaign', id: d.id }, { after: { digest, budget_minor: d.budget_minor, currency: d.currency, payer: d.payer_label } });
      return { ok: true, digest, expires_in_hours: ttl };
    });
  });

  /** One idempotent operation per (draft, kind, approved digest). Returns the operation row after claiming it. */
  async function claim(draftId: string, kind: 'provision' | 'activate' | 'pause', digest: string, actorId: string | null) {
    return withTx(deps.db, async (tx) => {
      await tx.query(`INSERT INTO provisioning_operations (draft_id, kind, digest, client_ref, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (draft_id, kind, digest) DO NOTHING`,
        [draftId, kind, digest, `uzshop-${kind}-${randomUUID()}`, actorId]);
      const op = await one<{ id: string; status: string; client_ref: string; attempts: number }>(tx, `SELECT id, status, client_ref, attempts FROM provisioning_operations WHERE draft_id=$1 AND kind=$2 AND digest=$3 FOR UPDATE`, [draftId, kind, digest]);
      if (op.status === 'succeeded' || op.status === 'in_flight') return { op, claimed: false };
      await tx.query(`UPDATE provisioning_operations SET status='in_flight', attempts=attempts+1, updated_at=now() WHERE id=$1`, [op.id]);
      return { op, claimed: true };
    });
  }
  const finish = (opId: string, status: string, error: string | null = null) =>
    deps.db.query(`UPDATE provisioning_operations SET status=$2, error=$3, updated_at=now() WHERE id=$1`, [opId, status, error]);
  const remoteIds = async (draftId: string): Promise<RemoteIds | null> => {
    const r = await many<{ level: string; remote_id: string }>(deps.db, `SELECT level, remote_id FROM remote_objects WHERE draft_id=$1`, [draftId]);
    const m = Object.fromEntries(r.map((x) => [x.level, x.remote_id]));
    return m.campaign ? { campaign_id: m.campaign, adset_id: m.adset!, creative_id: m.creative!, ad_id: m.ad! } : null;
  };

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/provision', tags: A, summary: 'Owner: create remote objects PAUSED (idempotent; unknown outcome → reconcile by client_ref)', params: zIdParam },
    async ({ actor, db, cfg, params }) => {
      ownerOnly(actor);
      const d = await getDraft(db, params.id);
      if (d.status === 'provisioned_paused') return { status: d.status, replayed: true };
      if (!['owner_approved', 'unknown', 'blocked'].includes(d.status)) throw new AppError(409, 'APPROVAL_REQUIRED');
      const ap = await validApproval(db, cfg, d);
      if (!ap.ok) throw new AppError(409, ap.reason.toUpperCase());
      const c = await connection(db);
      const cb = connectionBlocker(c, true);
      if (cb || (c!.verified_assets.ad_account !== d.ad_account_id)) {
        const reason = cb ?? 'asset_not_verified:ad_account';
        await db.query(`UPDATE campaign_drafts SET status='blocked', blocked_reason=$2, updated_at=now() WHERE id=$1`, [d.id, reason]);
        return { status: 'blocked', blocked_reason: reason }; // honest: nothing was created
      }
      const { op, claimed } = await claim(d.id, 'provision', ap.digest, actor.userId);
      if (!claimed) return { status: op.status === 'succeeded' ? 'provisioned_paused' : 'provisioning', replayed: true };
      await db.query(`UPDATE campaign_drafts SET status='provisioning', updated_at=now() WHERE id=$1`, [d.id]);
      const token = tokenOf(cfg, c!);
      try {
        // After an unknown outcome the provider is asked first — never a blind second create.
        let ids = op.attempts > 0 ? await metaAdapter().findByClientRef(token, d.ad_account_id!, op.client_ref) : null;
        if (!ids) ids = await metaAdapter().createPaused(token, {
          client_ref: op.client_ref, ad_account_id: d.ad_account_id!, page_id: d.page_id!, dataset_id: d.dataset_id, objective: d.objective, budget_type: d.budget_type, budget_minor: d.budget_minor,
          currency: d.currency, start_at: new Date(d.start_at!).toISOString(), end_at: d.end_at ? new Date(d.end_at).toISOString() : null, audience: d.audience, placements: d.placements, creative: d.creative,
          destination_url: await destinationUrl(db, cfg, d),
        });
        await withTx(db, async (tx) => {
          for (const [level, id] of [['campaign', ids!.campaign_id], ['adset', ids!.adset_id], ['creative', ids!.creative_id], ['ad', ids!.ad_id]] as const)
            await tx.query(`INSERT INTO remote_objects (draft_id, level, remote_id, configured_status) VALUES ($1,$2,$3,'PAUSED') ON CONFLICT (draft_id, level) DO UPDATE SET remote_id=EXCLUDED.remote_id, configured_status='PAUSED', updated_at=now()`, [d.id, level, id]);
          await tx.query(`UPDATE campaign_drafts SET status='provisioned_paused', configured_status='PAUSED', blocked_reason=NULL, updated_at=now() WHERE id=$1`, [d.id]);
          await tx.query(`UPDATE provisioning_operations SET status='succeeded', error=NULL, updated_at=now() WHERE id=$1`, [op.id]);
          await audit(tx, actor, 'campaign.provisioned_paused', { type: 'campaign', id: d.id }, { after: ids });
        });
        return { status: 'provisioned_paused', remote: ids };
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'provider_error';
        if (code === 'TIMEOUT') {
          await finish(op.id, 'unknown', 'timeout');
          await db.query(`UPDATE campaign_drafts SET status='unknown', blocked_reason='provider_timeout', updated_at=now() WHERE id=$1`, [d.id]);
          return { status: 'unknown', note: 'Natija noma’lum — qayta urinishda avval Meta’dan tekshiriladi.' };
        }
        await finish(op.id, 'failed', code);
        await db.query(`UPDATE campaign_drafts SET status='blocked', blocked_reason=$2, updated_at=now() WHERE id=$1`, [d.id, code === 'NOT_CONNECTED' ? 'adapter_not_connected' : code]);
        return { status: 'blocked', blocked_reason: code === 'NOT_CONNECTED' ? 'adapter_not_connected' : code };
      }
    });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/activate', tags: A, summary: 'Owner: request activation (needs ads.live_spend flag + still-valid approval; one operation)', params: zIdParam },
    async ({ actor, db, cfg, params }) => {
      ownerOnly(actor);
      const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ads.live_spend'`);
      if (!flag?.enabled) throw new AppError(409, 'LIVE_SPEND_DISABLED');
      const d = await getDraft(db, params.id);
      if (['activation_requested', 'delivery_pending', 'delivering'].includes(d.status)) return { status: d.status, replayed: true };
      if (d.status !== 'provisioned_paused') throw new AppError(409, 'PROVISION_REQUIRED');
      const ap = await validApproval(db, cfg, d);
      if (!ap.ok) throw new AppError(409, ap.reason.toUpperCase());
      const c = await connection(db);
      const cb = connectionBlocker(c, true);
      if (cb) throw new AppError(409, cb.toUpperCase());
      const { op, claimed } = await claim(d.id, 'activate', ap.digest, actor.userId);
      if (!claimed) return { status: op.status === 'succeeded' ? 'delivery_pending' : 'activation_requested', replayed: true };
      await db.query(`UPDATE campaign_drafts SET status='activation_requested', updated_at=now() WHERE id=$1`, [d.id]);
      try {
        await metaAdapter().activate(tokenOf(cfg, c!), (await remoteIds(d.id))!);
        await finish(op.id, 'succeeded');
        // ACTIVE requested ≠ delivering: the provider's effective status decides (moderation, billing, schedule).
        await db.query(`UPDATE campaign_drafts SET status='delivery_pending', configured_status='ACTIVE', updated_at=now() WHERE id=$1`, [d.id]);
        await db.query(`UPDATE remote_objects SET configured_status='ACTIVE', updated_at=now() WHERE draft_id=$1`, [d.id]);
        await audit(db, actor, 'campaign.activation_requested', { type: 'campaign', id: d.id }, { after: { digest: ap.digest } });
        return { status: 'delivery_pending' };
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'provider_error';
        await finish(op.id, code === 'TIMEOUT' ? 'unknown' : 'failed', code);
        await db.query(`UPDATE campaign_drafts SET status=$2, blocked_reason=$3, updated_at=now() WHERE id=$1`, [d.id, code === 'TIMEOUT' ? 'unknown' : 'provisioned_paused', code]);
        return { status: code === 'TIMEOUT' ? 'unknown' : 'provisioned_paused', error: code };
      }
    });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/pause', tags: A, summary: 'Protective pause (no approval needed). No provider answer → "pause_requested".', params: zIdParam },
    async ({ actor, db, cfg, params }) => {
      requirePerm(actor, 'catalog.write');
      const d = await getDraft(db, params.id);
      const ids = await remoteIds(d.id);
      if (!ids) throw new AppError(409, 'NOTHING_TO_PAUSE');
      const c = await connection(db);
      await db.query(`UPDATE campaign_drafts SET status='pause_requested', updated_at=now() WHERE id=$1`, [d.id]);
      try {
        if (connectionBlocker(c, true)) throw Object.assign(new Error('x'), { code: 'NOT_CONNECTED' });
        await metaAdapter().pause(tokenOf(cfg, c!), ids);
        await db.query(`UPDATE campaign_drafts SET status='paused', configured_status='PAUSED', updated_at=now() WHERE id=$1`, [d.id]);
        await audit(db, actor, 'campaign.paused', { type: 'campaign', id: d.id }, {});
        return { status: 'paused' };
      } catch {
        return { status: 'pause_requested', note: 'To‘xtatish tasdig‘i kutilmoqda' };
      }
    });

  route(app, deps, { method: 'POST', url: '/admin/ad-campaigns/:id/sync', tags: A, summary: 'Refresh provider effective status (configured ≠ effective)', params: zIdParam }, async ({ actor, db, cfg, params }) => {
    requirePerm(actor, 'catalog.write');
    const d = await getDraft(db, params.id);
    const ids = await remoteIds(d.id);
    if (!ids) throw new AppError(409, 'NOT_PROVISIONED');
    const c = await connection(db);
    const cb = connectionBlocker(c, false);
    if (cb) throw new AppError(409, cb.toUpperCase());
    const st = await metaAdapter().status(tokenOf(cfg, c!), ids);
    const next = st.effective === 'DISAPPROVED' ? 'rejected'
      : st.effective === 'PAUSED' || st.configured === 'PAUSED' ? (d.status === 'provisioned_paused' ? 'provisioned_paused' : 'paused')
      : st.effective === 'ACTIVE' ? 'delivering'
      : ['PENDING_REVIEW', 'IN_PROCESS', 'PENDING_BILLING_INFO', 'WITH_ISSUES'].includes(st.effective) ? 'delivery_pending' : 'unknown';
    await db.query(`UPDATE campaign_drafts SET status=$2, configured_status=$3, effective_status=$4, review_feedback=$5, updated_at=now() WHERE id=$1`, [d.id, next, st.configured, st.effective, st.review_feedback]);
    await db.query(`UPDATE remote_objects SET configured_status=$2, effective_status=$3, updated_at=now() WHERE draft_id=$1`, [d.id, st.configured, st.effective]);
    return { status: next, configured_status: st.configured, effective_status: st.effective, review_feedback: st.review_feedback };
  });

  void conflict;
}
