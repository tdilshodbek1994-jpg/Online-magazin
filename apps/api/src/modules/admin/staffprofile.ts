import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

/**
 * Staff profile for the owner: roles (current + history), security (MFA, sessions, last seen) and the person's own recent
 * actions from the audit log. Sign-out-everywhere is a separate, step-up protected action. Secrets never leave the server.
 */
const ACTION_UZ: Record<string, string> = {
  'user.login': 'Tizimga kirdi', 'order.cancelled': 'Buyurtmani bekor qildi', 'order.confirmed': 'Buyurtmani tasdiqladi', 'staff.role_revoked': 'Xodim rolini olib qo‘ydi',
  'staff.invited': 'Xodim taklif qildi', 'payout.paid': 'Pul to‘ladi', 'payout.approved': 'Pul yechishni tasdiqladi', 'refund.approved': 'Qaytarishni tasdiqladi', 'finance.day_closed': 'Kunni yopdi',
  'product.updated': 'Mahsulotni o‘zgartirdi', 'product.created': 'Mahsulot qo‘shdi', 'stock.adjusted': 'Qoldiqni tuzatdi', 'feature_flag.changed': 'Sozlamani o‘zgartirdi',
};

export function registerStaffProfile(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/staff/:id', tags: ['admin'], summary: 'Staff profile: roles, security, recent own actions', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'staff.manage');
    const u = await maybeOne<{ id: string; display_name: string | null; phone_e164: string; status: string; created_at: string }>(db, `SELECT id, display_name, phone_e164, status, created_at FROM users WHERE id=$1`, [params.id]);
    if (!u) throw notFound('USER');
    const roles = await many<{ role_code: string; created_at: string; revoked_at: string | null; granted_by: string | null }>(db,
      `SELECT m.role_code, m.created_at, m.revoked_at, (SELECT display_name FROM users WHERE id=m.granted_by) AS granted_by FROM memberships m WHERE m.user_id=$1 AND m.role_code <> 'customer' ORDER BY m.revoked_at NULLS FIRST, m.created_at DESC`, [params.id]);
    if (!roles.length) throw notFound('USER'); // only staff/partners are shown here
    const sec = await one<{ sessions: number; last_seen: string | null; mfa: boolean }>(db, `SELECT
        (SELECT COUNT(*)::int FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()) AS sessions,
        (SELECT MAX(last_seen_at) FROM sessions WHERE user_id=$1) AS last_seen,
        EXISTS (SELECT 1 FROM user_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL) AS mfa`, [params.id]);
    const actions = await many<{ action: string; target_type: string | null; occurred_at: string; reason: string | null }>(db,
      `SELECT action, target_type, occurred_at, reason FROM audit_events WHERE actor_user_id=$1 ORDER BY occurred_at DESC LIMIT 30`, [params.id]);
    const counts = await one<{ today: number; week: number }>(db, `SELECT COUNT(*) FILTER (WHERE occurred_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'))::int AS today,
        COUNT(*) FILTER (WHERE occurred_at > now() - interval '7 days')::int AS week FROM audit_events WHERE actor_user_id=$1`, [params.id]);
    const partner = await maybeOne<{ id: string }>(db, `SELECT id FROM partners WHERE user_id=$1`, [params.id]);
    return {
      ...u, roles, security: sec, counts,
      actions: actions.map((a) => ({ ...a, label: ACTION_UZ[a.action] ?? a.action })),
      links: { operator: roles.some((r) => r.role_code === 'operator' && !r.revoked_at) ? `/admin/operator/${u.id}` : null, partner: partner ? `/admin/partner/${partner.id}` : null },
    };
  });

  route(app, deps, { method: 'POST', url: '/admin/staff/:id/sessions/revoke', tags: ['admin'], summary: 'Sign the person out on every device', params: zIdParam, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'staff.manage');
      requireStepUp(actor);
      const r = await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [params.id]);
      await audit(db, actor, 'staff.sessions_revoked', { type: 'user', id: params.id }, { reason: body.reason });
      return { revoked: r.rowCount ?? 0 };
    });
}
