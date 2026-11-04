import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { requestPause } from '../target/safety.js';

/**
 * P2B custom domains. A host is "verified" only after the owner publishes the TXT record we generated
 * (`_uzshop-verify.<host>` = `uzshop-verify=<token>`); a CNAME alone proves nothing. TLS readiness and Meta domain
 * verification are tracked separately and never merged into one "success". Unknown hosts are rejected; staff sessions
 * never act from a custom host; checkout handoff uses a short-lived signed flow token without PII.
 */
const A = ['admin', 'domains'];
const isOwner = (a: Actor) => a.grants.some((g) => g.role === 'owner');
const zHost = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);

type TxtResolver = (name: string) => Promise<string[][]>;
let txtResolver: TxtResolver = (n) => resolveTxt(n);
/** Test hook: swap the DNS TXT resolver. */
export function setTxtResolver(r: TxtResolver | null) { txtResolver = r ?? ((n) => resolveTxt(n)); }

/** Custom hosts that may serve landings (active = DNS-verified). Used by the staff-session guard and routing. */
export async function isCustomHost(q: Queryable, host: string) {
  return !!(await maybeOne(q, `SELECT 1 FROM landing_domains WHERE host=$1 AND status <> 'disconnected'`, [host.toLowerCase()]));
}

/** Meta domain verification: accept the bare token or the official meta tag; extract only the token (no script ever stored). */
export function metaToken(input: string): string | null {
  const s = input.trim();
  if (/^[a-z0-9]{20,40}$/.test(s)) return s;
  const m = s.match(/^<meta\s+name=["']facebook-domain-verification["']\s+content=["']([a-z0-9]{20,40})["']\s*\/?>$/i);
  return m ? m[1]!.toLowerCase() : null;
}

const b64 = (b: Buffer) => b.toString('base64url');
/** Short-lived signed flow token for a cross-domain checkout handoff: ids only, no phone/email/customer ids. */
export function signFlowToken(key: string, p: { flow_id: string | null; landing_id: string; ttlSec?: number }) {
  const body = b64(Buffer.from(JSON.stringify({ f: p.flow_id, l: p.landing_id, e: Math.floor(Date.now() / 1000) + (p.ttlSec ?? 600) })));
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}
export function verifyFlowToken(key: string, token: string): { flow_id: string | null; landing_id: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { f: string | null; l: string; e: number };
    if (p.e < Math.floor(Date.now() / 1000)) return null;
    return { flow_id: p.f, landing_id: p.l };
  } catch { return null; }
}

export function registerDomains(app: FastifyInstance, deps: Deps): void {
  const flowKey = () => `flow:${deps.cfg.mfaKey}`;

  route(app, deps, { method: 'GET', url: '/admin/domains', tags: A, summary: 'Custom domains with DNS / TLS / Meta statuses (separate)' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return { items: await many(db, `SELECT d.id, d.host, d.landing_id, l.title AS landing, d.status, d.txt_token, d.verified_at, d.last_check_at, d.last_check_result, d.tls_status, d.meta_status, d.fallback_domain_id, d.created_at
      FROM landing_domains d JOIN landing_pages l ON l.id=d.landing_id WHERE d.status <> 'disconnected' ORDER BY d.created_at DESC`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/domains', tags: A, summary: 'Owner: claim a host for a landing → pending until the TXT record proves ownership',
    body: z.object({ host: zHost, landing_id: z.string().uuid() }).strict() }, async ({ actor, db, cfg, body }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    if (body.host === new URL(cfg.publicWebUrl).hostname) throw new AppError(422, 'MAIN_HOST_RESERVED');
    if (!(await maybeOne(db, `SELECT 1 FROM landing_pages WHERE id=$1`, [body.landing_id]))) throw notFound('LANDING');
    try {
      const d = await one<{ id: string; txt_token: string }>(db, `INSERT INTO landing_domains (host, landing_id, txt_token, created_by) VALUES ($1,$2,$3,$4) RETURNING id, txt_token`,
        [body.host, body.landing_id, randomBytes(18).toString('hex'), actor.userId]);
      await audit(db, actor, 'domain.claimed', { type: 'landing_domain', id: d.id }, { after: { host: body.host } });
      return { id: d.id, status: 'pending', dns_record: { type: 'TXT', name: `_uzshop-verify.${body.host}`, value: `uzshop-verify=${d.txt_token}` } };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'DOMAIN_TAKEN'); // an existing claim is never moved
      throw e;
    }
  });

  route(app, deps, { method: 'POST', url: '/admin/domains/:id/verify', tags: A, summary: 'Check the TXT challenge (CNAME/A records are not ownership proof)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    const d = await maybeOne<{ host: string; txt_token: string; status: string }>(db, `SELECT host, txt_token, status FROM landing_domains WHERE id=$1 AND status <> 'disconnected'`, [params.id]);
    if (!d) throw notFound('DOMAIN');
    let records: string[] = [];
    let result = 'txt_not_found';
    try { records = (await txtResolver(`_uzshop-verify.${d.host}`)).map((r) => r.join('')); } catch (e) { result = `dns_error:${(e as { code?: string }).code ?? 'unknown'}`; }
    const ok = records.includes(`uzshop-verify=${d.txt_token}`);
    if (ok) result = 'txt_ok';
    await db.query(`UPDATE landing_domains SET status=CASE WHEN $2 THEN 'verified' ELSE status END, verified_at=CASE WHEN $2 AND verified_at IS NULL THEN now() ELSE verified_at END, last_check_at=now(), last_check_result=$3 WHERE id=$1`, [params.id, ok, result]);
    return { status: ok ? 'verified' : d.status === 'verified' ? 'verified' : 'pending', result };
  });

  route(app, deps, { method: 'PUT', url: '/admin/domains/:id', tags: A, summary: 'Owner: TLS status (from the proxy), Meta verification token (sanitized), fallback (no loops)', params: zIdParam,
    body: z.object({ tls_status: z.enum(['pending', 'ready', 'failed']).optional(), meta_verification: z.string().max(300).optional(), meta_status: z.enum(['verified', 'unverified']).optional(), fallback_domain_id: z.string().uuid().nullable().optional() }).strict() },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'catalog.write');
      if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
      const d = await maybeOne<{ id: string }>(db, `SELECT id FROM landing_domains WHERE id=$1 AND status <> 'disconnected'`, [params.id]);
      if (!d) throw notFound('DOMAIN');
      if (body.meta_verification !== undefined) {
        const tok = metaToken(body.meta_verification);
        if (!tok) throw new AppError(400, 'META_TOKEN_INVALID'); // scripts or other markup are never accepted
        await db.query(`UPDATE landing_domains SET meta_token=$2, meta_status='token_saved' WHERE id=$1`, [d.id, tok]);
      }
      if (body.meta_status) await db.query(`UPDATE landing_domains SET meta_status=$2 WHERE id=$1 AND meta_token IS NOT NULL`, [d.id, body.meta_status]);
      if (body.tls_status) await db.query(`UPDATE landing_domains SET tls_status=$2 WHERE id=$1`, [d.id, body.tls_status]);
      if (body.fallback_domain_id !== undefined) {
        // walk the chain from the proposed fallback; reaching this domain again = loop
        let cur = body.fallback_domain_id, hops = 0;
        while (cur) {
          if (cur === d.id || ++hops > 10) throw new AppError(422, 'REDIRECT_LOOP');
          cur = (await maybeOne<{ f: string | null }>(db, `SELECT fallback_domain_id AS f FROM landing_domains WHERE id=$1`, [cur]))?.f ?? null;
        }
        await db.query(`UPDATE landing_domains SET fallback_domain_id=$2 WHERE id=$1`, [d.id, body.fallback_domain_id]);
      }
      await audit(db, actor, 'domain.updated', { type: 'landing_domain', id: d.id }, { after: { ...body, meta_verification: body.meta_verification ? '[token]' : undefined } });
      return one(db, `SELECT id, host, status, tls_status, meta_status, fallback_domain_id FROM landing_domains WHERE id=$1`, [d.id]);
    });

  route(app, deps, { method: 'POST', url: '/admin/domains/:id/disconnect', tags: A, summary: 'Owner: disconnect; running campaigns pointing at this landing are listed and get pause requests (not claimed stopped)', params: zIdParam,
    body: z.object({ confirm: z.boolean().default(false) }).strict() }, async ({ actor, db, cfg, params, body }) => {
    requirePerm(actor, 'catalog.write');
    if (!isOwner(actor)) throw new AppError(403, 'OWNER_APPROVAL_REQUIRED');
    const d = await maybeOne<{ id: string; landing_id: string; host: string }>(db, `SELECT id, landing_id, host FROM landing_domains WHERE id=$1 AND status <> 'disconnected'`, [params.id]);
    if (!d) throw notFound('DOMAIN');
    const deps2 = await many<{ id: string; title: string; status: string }>(db, `SELECT id, title, status FROM campaign_drafts WHERE landing_id=$1 AND status IN ('activation_requested','delivery_pending','delivering','unknown')`, [d.landing_id]);
    if (deps2.length && !body.confirm) return { disconnected: false, dependencies: deps2, note: 'Bu domenga yo‘naltirilgan reklamalar bor — tasdiqlasangiz ularga to‘xtatish so‘rovi yuboriladi.' };
    const pauses = [];
    for (const c of deps2) pauses.push({ id: c.id, result: await requestPause(db, cfg, c.id, `domain_disconnect:${d.host}`, actor) });
    await db.query(`UPDATE landing_domains SET status='disconnected', disconnected_at=now() WHERE id=$1`, [d.id]);
    await audit(db, actor, 'domain.disconnected', { type: 'landing_domain', id: d.id }, { after: { host: d.host, campaigns: pauses.length } });
    return { disconnected: true, pause_requests: pauses, note: pauses.length ? 'To‘xtatish so‘rovlari yuborildi — Meta tasdiqlamaguncha reklama to‘xtagan deb hisoblanmaydi.' : null };
  });

  // ---------------- public: host routing + checkout handoff ----------------
  route(app, deps, { method: 'GET', url: '/hosts/resolve', tags: ['public'], summary: 'Reverse-proxy helper: which landing a verified custom host serves (unknown → 404)', query: z.object({ host: zHost }) },
    async ({ db, query, reply }) => {
      reply.header('cache-control', 'public, max-age=60');
      type Row = { id: string; status: string; tls_status: string; fallback_domain_id: string | null; slug: string; lstatus: string };
      const first = await maybeOne<Row>(db,
        `SELECT d.id, d.status, d.tls_status, d.fallback_domain_id, l.slug, l.status AS lstatus FROM landing_domains d JOIN landing_pages l ON l.id=d.landing_id WHERE d.host=$1 AND d.status <> 'disconnected'`, [query.host]);
      if (!first || first.status !== 'verified') throw new AppError(404, 'HOST_UNKNOWN'); // never another tenant's content
      let d: Row = first;
      let hops = 0;
      while (d.lstatus !== 'published' && d.fallback_domain_id && hops++ < 3) { // bounded: no endless redirects
        const next: Row | null = await maybeOne<Row>(db, `SELECT d.id, d.status, d.tls_status, d.fallback_domain_id, l.slug, l.status AS lstatus FROM landing_domains d JOIN landing_pages l ON l.id=d.landing_id WHERE d.id=$1 AND d.status='verified'`, [d.fallback_domain_id]);
        if (!next) break;
        d = next;
      }
      if (d.lstatus !== 'published') throw new AppError(404, 'LANDING_NOT_AVAILABLE');
      return { slug: d.slug, tls_ready: d.tls_status === 'ready' };
    });

  route(app, deps, { method: 'POST', url: '/hosts/flow-token', tags: ['public'], summary: 'Signed 10-minute flow token for a cross-domain checkout handoff (ids only, no PII)',
    body: z.object({ host: zHost, flow_code: z.string().max(20).optional() }).strict() }, async ({ db, body }) => {
    const d = await maybeOne<{ landing_id: string }>(db, `SELECT landing_id FROM landing_domains WHERE host=$1 AND status='verified'`, [body.host]);
    if (!d) throw new AppError(404, 'HOST_UNKNOWN');
    const flow = body.flow_code ? await maybeOne<{ id: string }>(db, `SELECT id FROM referral_links WHERE code=$1 AND landing_id=$2`, [body.flow_code, d.landing_id]) : null;
    return { token: signFlowToken(flowKey(), { flow_id: flow?.id ?? null, landing_id: d.landing_id }) };
  });

  route(app, deps, { method: 'POST', url: '/hosts/flow-token/verify', tags: ['public'], summary: 'Server-side check of a flow token (expired/tampered → rejected)',
    body: z.object({ token: z.string().max(600) }).strict() }, async ({ body }) => {
    const p = verifyFlowToken(flowKey(), body.token);
    if (!p) throw new AppError(400, 'FLOW_TOKEN_INVALID');
    return p;
  });
}
