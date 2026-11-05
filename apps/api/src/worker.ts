import type { AppConfig } from './config.js';
import type { Db } from './platform/db.js';
import { withTx } from './platform/db.js';
import { releaseMatured } from './modules/commissions/service.js';
import { releaseDraftHold, releaseReservation } from './modules/inventory/service.js';
import { runP2Scheduled } from './modules/partners/p2.js';
import { renderText, sendTelegram } from './modules/notifications/telegram.js';
import { dispatchTracking } from './modules/tracking/service.js';
import { runAdSafety } from './modules/target/safety.js';
import { loadConfig } from './config.js';
import { decrypt } from './platform/mfa.js';
import { otpText, sendSms, SmsError, smsConfigured } from './modules/notifications/sms.js';
import { pushHref, sendPush } from './modules/notifications/push.js';

/**
 * Durable worker (ADR-005). Jobs are claimed with FOR UPDATE SKIP LOCKED; scheduled tasks run under a
 * pg advisory lock so two schedulers never run the same batch twice (AC-M55-2, T085).
 */
export async function runJobsOnce(db: Db, workerId: string, limit = 20): Promise<number> {
  const jobs = await withTx(db, async (tx) => {
    const r = await tx.query(
      `UPDATE jobs SET status='running', locked_at=now(), locked_by=$1, attempts=attempts+1
        WHERE id IN (SELECT id FROM jobs WHERE status='pending' AND run_at <= now() ORDER BY queue='otp' DESC, run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, payload, attempts, max_attempts`,
      [workerId, limit],
    );
    return r.rows;
  });
  for (const j of jobs) {
    try {
      await withTx(db, async (tx) => {
        if (j.kind === 'notification.send') {
          const n = (await tx.query(`SELECT n.id, n.channel, n.template, n.purpose, n.phone_e164, n.params, n.status, tl.chat_id, (n.created_at < now() - interval '10 minutes') AS stale
              FROM notifications n LEFT JOIN telegram_links tl ON tl.user_id=n.user_id WHERE n.id=$1 FOR UPDATE OF n`, [j.payload.id])).rows[0];
          const token = process.env.TELEGRAM_BOT_TOKEN;
          if (n && n.status === 'queued' && n.channel === 'sms' && n.purpose === 'otp' && smsConfigured() && n.params?.code_enc) {
            // The code is stored only encrypted and is wiped from the row after the attempt, sent or not.
            const wipe = `UPDATE notifications SET params = params - 'code_enc', attempts=attempts+1, status=$2, provider_ref=$3, sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END WHERE id=$1`;
            if (n.stale) await tx.query(wipe, [n.id, 'suppressed', 'otp_expired_before_send']);
            else {
              try {
                const code = decrypt(String(n.params.code_enc), process.env.MFA_ENC_KEY || 'dev-only-mfa-key');
                const ref = await sendSms(String(n.phone_e164), otpText(code));
                await tx.query(wipe, [n.id, 'sent', `eskiz:${ref}`]);
              } catch (e) {
                if (e instanceof SmsError && !e.permanent) throw e; // network / 5xx: job retries with backoff
                await tx.query(wipe, [n.id, 'failed', String((e as Error).message).slice(0, 120)]);
              }
            }
          } else if (n && n.status === 'queued' && n.channel === 'telegram' && token && n.chat_id) {
            try {
              const ref = await sendTelegram(token, n.chat_id, renderText(n.template, n.params ?? {}));
              await tx.query(`UPDATE notifications SET status='sent', provider_ref=$2, attempts=attempts+1 WHERE id=$1`, [n.id, `tg:${ref}`]);
            } catch (e) {
              if (!(e as { permanent?: boolean }).permanent) throw e;
              await tx.query(`UPDATE notifications SET status='failed', provider_ref=$2, attempts=attempts+1 WHERE id=$1`, [n.id, String((e as Error).message).slice(0, 120)]);
            }
          } else if (n && n.status === 'queued') {
            // No provider/link configured (SMS adapter is dev-only): never reported as delivered (§23, AC-M17-2).
            const why = n.channel === 'telegram' ? (token ? 'no_telegram_link' : 'telegram_not_configured') : n.channel === 'sms' && smsConfigured() ? 'sms_otp_only' : 'dev_log_only';
            await tx.query(`UPDATE notifications SET status='suppressed', provider_ref=$2, attempts=attempts+1, params = params - 'code_enc' WHERE id=$1`, [n.id, why]);
          }
        }
        if (j.kind === 'push.send') {
          const n = (await tx.query(`SELECT id, user_id, template, params FROM notifications WHERE id=$1`, [j.payload.id])).rows[0];
          const devices = n?.user_id ? (await tx.query(`SELECT d.id, d.token FROM push_devices d WHERE d.user_id=$1 AND d.revoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM push_deliveries x WHERE x.notification_id=$2 AND x.device_id=d.id)`, [n.user_id, n.id])).rows : [];
          let retry: string | null = null;
          for (const d of devices) {
            const r = await sendPush(d.token, { title: 'UzShop', body: renderText(n.template, n.params ?? {}), href: pushHref(n.template, n.params ?? {}) });
            if (r.ok) await db.query(`INSERT INTO push_deliveries (notification_id, device_id, provider_ref) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [n.id, d.id, r.ref.slice(0, 200)]);
            else if (r.invalidToken) await db.query(`UPDATE push_devices SET revoked_at=now() WHERE id=$1`, [d.id]);
            else if (r.retry) retry = r.error;
          }
          // Deliveries/revocations are written outside the job transaction, so a retry (429/5xx) never pushes twice.
          if (retry) throw new Error(retry);
        }
        await tx.query(`UPDATE jobs SET status='done', finished_at=now() WHERE id=$1`, [j.id]);
      });
    } catch (e) {
      const dead = j.attempts >= j.max_attempts;
      await db.query(`UPDATE jobs SET status=$2, last_error=$3, run_at=now() + make_interval(secs => LEAST(3600, 2 ^ attempts)) WHERE id=$1`, [j.id, dead ? 'dead' : 'pending', String((e as Error).message).slice(0, 500)]);
    }
  }
  return jobs.length;
}

export async function runScheduledOnce(db: Db, now: Date = new Date()): Promise<{ expired: number; released: number } | null> {
  const client = await db.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock(727100) AS ok');
    if (!got.rows[0].ok) return null; // another scheduler is active
    try {
      const expiredOrders = await db.query(`SELECT order_id FROM reservations WHERE status='active_unpaid' AND order_id IS NOT NULL AND expires_at <= $1 LIMIT 500`, [now]);
      let expired = 0;
      for (const r of expiredOrders.rows) {
        if (await withTx(db, (tx) => releaseReservation(tx, r.order_id, 'expired'))) expired++;
      }
      // Partner short holds (V2 §09) return to stock when they expire.
      const holds = await db.query(`SELECT id FROM reservations WHERE status='active_unpaid' AND sales_draft_id IS NOT NULL AND expires_at <= $1 LIMIT 500`, [now]);
      for (const h of holds.rows) if (await withTx(db, (tx) => releaseDraftHold(tx, { reservationId: h.id }, 'expired'))) expired++;
      await runP2Scheduled(db).catch(() => {});
      const released = await withTx(db, (tx) => releaseMatured(tx, now));
      await dispatchTracking(db, process.env.NODE_ENV === 'production' ? 'production' : 'development', undefined, now).catch(() => {});
      await runAdSafety(db, loadConfig()).catch(() => {}); // protective pause requests only
      { const { runAutomation } = await import('./modules/admin/automation.js'); await runAutomation(db).catch(() => {}); } // shadow/active rules, capped
      await db.query(`UPDATE outbox_events SET dispatched_at=now() WHERE dispatched_at IS NULL AND id IN (SELECT id FROM outbox_events WHERE dispatched_at IS NULL ORDER BY id LIMIT 1000)`);
      return { expired, released };
    } finally {
      await client.query('SELECT pg_advisory_unlock(727100)');
    }
  } finally {
    client.release();
  }
}

export function startWorker(db: Db, _cfg: AppConfig, workerId: string): () => void {
  let stop = false;
  const loop = async () => {
    while (!stop) {
      try {
        const n = await runJobsOnce(db, workerId);
        await runScheduledOnce(db);
        if (n === 0) await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.error('worker loop error', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  return () => {
    stop = true;
  };
}
