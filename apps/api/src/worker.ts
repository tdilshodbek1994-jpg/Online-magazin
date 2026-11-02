import type { AppConfig } from './config.js';
import type { Db } from './platform/db.js';
import { withTx } from './platform/db.js';
import { releaseMatured } from './modules/commissions/service.js';
import { releaseReservation } from './modules/inventory/service.js';

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
          // DEV adapter: no SMS/Telegram provider configured. Never reported as delivered (§23, AC-M17-2).
          await tx.query(`UPDATE notifications SET status='suppressed', provider_ref='dev_log_only', attempts=attempts+1 WHERE id=$1 AND status='queued'`, [j.payload.id]);
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
      const expiredOrders = await db.query(`SELECT order_id FROM reservations WHERE status='active_unpaid' AND expires_at <= $1 LIMIT 500`, [now]);
      let expired = 0;
      for (const r of expiredOrders.rows) {
        if (await withTx(db, (tx) => releaseReservation(tx, r.order_id, 'expired'))) expired++;
      }
      const released = await withTx(db, (tx) => releaseMatured(tx, now));
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
