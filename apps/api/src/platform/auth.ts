import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './db.js';
import { forbidden, unauthorized } from './errors.js';

export interface Grant {
  role: string;
  orgId: string | null; // null = platform-wide
}

export interface Actor {
  kind: 'user' | 'ai' | 'anonymous';
  userId: string | null;
  sessionId: string | null;
  requestId: string;
  grants: Grant[];
  /** permission -> set of org ids (or '*' for platform scope) */
  perms: Map<string, Set<string>>;
  maxAmount: Map<string, bigint | null>;
  guestToken: string | null;
}

export function anonymous(requestId: string, guestToken: string | null): Actor {
  return { kind: 'anonymous', userId: null, sessionId: null, requestId, grants: [], perms: new Map(), maxAmount: new Map(), guestToken };
}

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Loads the actor from a bearer token. Permissions are read on every request so revocation applies immediately (AC-M41-1). */
export async function loadActor(q: Queryable, token: string | null, requestId: string, guestToken: string | null): Promise<Actor> {
  if (!token) return anonymous(requestId, guestToken);
  const s = await q.query(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.id = s.user_id AND u.status = 'active'
        AND (s.phone_at_issue IS NOT DISTINCT FROM u.phone_e164)
      RETURNING s.id, s.user_id, u.kind`,
    [hashToken(token)],
  );
  if (s.rowCount === 0) return anonymous(requestId, guestToken);
  const { id: sessionId, user_id: userId, kind } = s.rows[0];
  const g = await q.query(
    `SELECT m.role_code, m.organization_id, rp.permission_code, rp.max_amount_minor
       FROM memberships m JOIN role_permissions rp ON rp.role_code = m.role_code
      WHERE m.user_id = $1 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())`,
    [userId],
  );
  const grants = new Map<string, Grant>();
  const perms = new Map<string, Set<string>>();
  const maxAmount = new Map<string, bigint | null>();
  for (const r of g.rows) {
    grants.set(`${r.role_code}:${r.organization_id ?? '*'}`, { role: r.role_code, orgId: r.organization_id });
    const set = perms.get(r.permission_code) ?? new Set<string>();
    set.add(r.organization_id ?? '*');
    perms.set(r.permission_code, set);
    const lim = r.max_amount_minor === null ? null : BigInt(r.max_amount_minor);
    const prev = maxAmount.get(r.permission_code);
    if (prev === undefined || (prev !== null && (lim === null || lim > prev))) maxAmount.set(r.permission_code, lim);
  }
  return { kind: kind === 'ai' ? 'ai' : 'user', userId, sessionId, requestId, grants: [...grants.values()], perms, maxAmount, guestToken };
}

export function requireUser(a: Actor): asserts a is Actor & { userId: string } {
  if (!a.userId) throw unauthorized();
}

export function can(a: Actor, perm: string, orgId?: string | null): boolean {
  const set = a.perms.get(perm);
  if (!set) return false;
  if (set.has('*')) return true;
  return orgId ? set.has(orgId) : false;
}

/** Server-side permission check; UI hiding is never relied upon (AC-M41-1, INV14). */
export function requirePerm(a: Actor, perm: string, orgId?: string | null): void {
  requireUser(a);
  if (!can(a, perm, orgId)) throw forbidden();
}

export function requireAmountWithin(a: Actor, perm: string, amountMinor: bigint): void {
  const lim = a.maxAmount.get(perm);
  if (lim !== undefined && lim !== null && amountMinor > lim) throw forbidden();
}

/** Org ids on which the actor holds perm; '*' means all. */
export function orgsWith(a: Actor, perm: string): Set<string> {
  return a.perms.get(perm) ?? new Set();
}
