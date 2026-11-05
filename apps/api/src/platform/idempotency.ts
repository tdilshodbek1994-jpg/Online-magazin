import { createHash } from 'node:crypto';
import type { Tx } from './db.js';
import { conflict } from './errors.js';

export function fingerprint(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Idempotent execution inside a transaction (MASTER 8.5, AC-M11-2, AC-X15).
 * The INSERT ... ON CONFLICT serializes parallel requests with the same key on the primary key:
 * the second request blocks until the first commits, then replays its stored response.
 * Same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function idempotent<T>(
  tx: Tx,
  scope: string,
  key: string,
  body: unknown,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const hash = fingerprint(body);
  const ins = await tx.query(
    `INSERT INTO idempotency_records (scope, key, request_hash, status) VALUES ($1,$2,$3,'in_progress')
     ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
    [scope, key, hash],
  );
  if (ins.rowCount === 0) {
    const ex = await tx.query('SELECT request_hash, status, response_status, response_body FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE', [scope, key]);
    const row = ex.rows[0];
    if (row.request_hash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED');
    if (row.status !== 'completed') throw conflict('IDEMPOTENCY_IN_PROGRESS');
    return { status: row.response_status, body: row.response_body as T, replayed: true };
  }
  const res = await run();
  await tx.query(
    `UPDATE idempotency_records SET status='completed', response_status=$3, response_body=$4, completed_at=now() WHERE scope=$1 AND key=$2`,
    [scope, key, res.status, JSON.stringify(res.body)],
  );
  return { ...res, replayed: false };
}
