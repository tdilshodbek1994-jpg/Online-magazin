import type { Queryable } from './db.js';
import type { Actor } from './auth.js';

export async function audit(
  q: Queryable,
  actor: Actor | null,
  action: string,
  target: { type: string; id?: string | null; orgId?: string | null },
  data: { before?: unknown; after?: unknown; reason?: string | null; requestId?: string | null } = {},
): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (actor_user_id, actor_kind, action, target_type, target_id, organization_id, before, after, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      actor?.userId ?? null,
      actor ? actor.kind : 'system',
      action,
      target.type,
      target.id ?? null,
      target.orgId ?? null,
      data.before === undefined ? null : JSON.stringify(redact(data.before)),
      data.after === undefined ? null : JSON.stringify(redact(data.after)),
      data.reason ?? null,
      data.requestId ?? actor?.requestId ?? null,
    ],
  );
}

const SECRET_KEYS = /token|password|secret|otp|code_hash|card|pan|cvv/i;
/** Never log tokens/passwords/OTP/card data (M41, M57). */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(val);
    return out;
  }
  if (typeof v === 'bigint') return v.toString();
  return v;
}
