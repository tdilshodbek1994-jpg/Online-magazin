import type { Queryable } from './db.js';

/**
 * Versioned business policies (Appendix B). Approved policy wins. Demo fixtures are only honoured
 * outside production, so an unapproved value never becomes a silent production default (§02).
 */
export interface PolicyValue<T> {
  value: T;
  version: number;
  approved: boolean;
  isDemo: boolean;
}

export async function getPolicy<T>(q: Queryable, key: string, env: string): Promise<PolicyValue<T> | null> {
  const r = await q.query(
    `SELECT value, version, status, is_demo FROM business_policies
      WHERE key=$1 AND effective_at <= now() AND (status='approved' OR (status='draft' AND is_demo AND $2 <> 'production'))
      ORDER BY (status='approved') DESC, version DESC LIMIT 1`,
    [key, env],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return { value: row.value as T, version: row.version, approved: row.status === 'approved', isDemo: row.is_demo };
}

export const POLICY = {
  attributionWindowDays: 'attribution.window_days',
  commissionHoldDays: 'commission.hold_days',
  payoutMinMinor: 'payout.min_minor',
  payoutApprovalMode: 'payout.approval_mode',
  partnerConfirmTtlHours: 'partner_order.confirmation_ttl_hours',
  termsVersion: 'legal.offer_version',
} as const;
