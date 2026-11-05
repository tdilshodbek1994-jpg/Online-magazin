import type { Queryable } from './db.js';

export interface DomainEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  orgId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  payload: Record<string, unknown>;
}

/** Must be called inside the same transaction as the state change (MASTER 8.5 Outbox). */
export async function emit(q: Queryable, e: DomainEvent): Promise<string> {
  const r = await q.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, organization_id, correlation_id, causation_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING event_id`,
    [e.type, e.aggregateType, e.aggregateId, e.aggregateVersion ?? null, e.orgId ?? null, e.correlationId ?? null, e.causationId ?? null, JSON.stringify(e.payload, bigintReplacer)],
  );
  return r.rows[0].event_id as string;
}

export async function enqueueJob(
  q: Queryable,
  kind: string,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAt?: Date; queue?: string; maxAttempts?: number } = {},
): Promise<void> {
  await q.query(
    `INSERT INTO jobs (queue, kind, payload, dedupe_key, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [opts.queue ?? 'default', kind, JSON.stringify(payload, bigintReplacer), opts.dedupeKey ?? null, opts.runAt ?? new Date(), opts.maxAttempts ?? 10],
  );
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
