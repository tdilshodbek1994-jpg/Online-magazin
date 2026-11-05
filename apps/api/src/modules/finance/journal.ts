import type { Tx } from '../../platform/db.js';

/**
 * Post a balanced journal transaction (M42 minimal). business_event_key is unique, so a retried
 * event never creates money twice (INV07, AC-M42-1). Returns false when the event was already posted.
 */
export async function postJournal(
  tx: Tx,
  key: string,
  kind: string,
  lines: { account: string; debit?: bigint; credit?: bigint }[],
  description?: string,
): Promise<boolean> {
  const nonZero = lines.filter((l) => (l.debit ?? 0n) > 0n || (l.credit ?? 0n) > 0n);
  if (nonZero.length === 0) return false;
  const ins = await tx.query(
    `INSERT INTO journal_transactions (business_event_key, kind, currency, description) VALUES ($1,$2,'UZS',$3)
     ON CONFLICT (business_event_key) DO NOTHING RETURNING id`,
    [key, kind, description ?? null],
  );
  if (!ins.rowCount) return false;
  const txId = ins.rows[0].id;
  for (const l of nonZero) {
    await tx.query(
      `INSERT INTO journal_entries (transaction_id, account_id, debit_minor, credit_minor)
       SELECT $1, id, $3, $4 FROM ledger_accounts WHERE code=$2 AND currency='UZS' AND owner_id IS NULL`,
      [txId, l.account, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString()],
    );
  }
  return true;
}
