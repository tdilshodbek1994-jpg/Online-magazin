import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../platform/auth.js';
import { type Deps, route } from '../../platform/http.js';

/** Android app push tokens. A token follows whoever is logged in on that phone now; logout removes it. */
export function registerPushDevices(app: FastifyInstance, deps: Deps): void {
  const zToken = z.string().min(20).max(4096).regex(/^[\w:.\-]+$/);
  route(app, deps, { method: 'POST', url: '/me/devices', tags: ['messaging'], summary: 'Register this phone for push notifications',
    body: z.object({ token: zToken, platform: z.enum(['android', 'ios']), app_version: z.string().max(40).optional() }).strict() },
  async ({ actor, body, db }) => {
    requireUser(actor);
    await db.query(`INSERT INTO push_devices (user_id, token, platform, app_version) VALUES ($1,$2,$3,$4)
        ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, app_version=EXCLUDED.app_version, last_seen_at=now(), revoked_at=NULL`,
      [actor.userId, body.token, body.platform, body.app_version ?? null]);
    return { ok: true };
  });
  route(app, deps, { method: 'POST', url: '/me/devices/remove', tags: ['messaging'], summary: 'Stop push notifications on this phone (logout)',
    body: z.object({ token: zToken }).strict() },
  async ({ actor, body, db }) => {
    requireUser(actor);
    const r = await db.query(`UPDATE push_devices SET revoked_at=now() WHERE token=$1 AND user_id=$2 AND revoked_at IS NULL`, [body.token, actor.userId]);
    return { ok: true, removed: r.rowCount ?? 0 };
  });
}
