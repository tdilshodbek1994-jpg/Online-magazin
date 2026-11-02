import type { Queryable } from '../../platform/db.js';
import { enqueueJob } from '../../platform/outbox.js';

/**
 * Queue a notification (M17). OTP/security bypass marketing consent; marketing checks consent at send time.
 * Actual provider delivery is done by the worker through an SMS adapter (dev adapter logs only — not a live integration).
 */
export async function queueNotification(
  q: Queryable,
  n: { userId?: string | null; phone?: string | null; channel: 'sms' | 'in_app'; purpose: 'otp' | 'transactional' | 'marketing' | 'security'; template: string; locale: string; params: Record<string, unknown>; dedupeKey?: string },
): Promise<void> {
  const r = await q.query(
    `INSERT INTO notifications (user_id, phone_e164, channel, purpose, template, locale, params, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.userId ?? null, n.phone ?? null, n.channel, n.purpose, n.template, n.locale, JSON.stringify(n.params), n.dedupeKey ?? null],
  );
  if (r.rowCount) await enqueueJob(q, 'notification.send', { id: r.rows[0].id }, { queue: n.purpose === 'otp' ? 'otp' : 'default', dedupeKey: `notif:${r.rows[0].id}` });
}
