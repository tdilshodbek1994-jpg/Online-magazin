import { createHash } from 'node:crypto';
import type { Queryable } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';
import { getPolicy, POLICY } from '../../platform/policies.js';
import type { Attribution } from '../orders/service.js';

export const visitorHash = (guestToken: string) => createHash('sha256').update(`visitor:${guestToken}`).digest();

const BOT_UA = /(bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|vkshare|skype|embedly|quora link|pinterest|bingpreview|headless)/i;
export const isBotUserAgent = (ua: string | undefined) => !ua || BOT_UA.test(ua);

/**
 * Attribution policy (§11): explicit verified partner code at checkout has priority; otherwise the last
 * eligible referral touch inside the approved window. Snapshot is frozen on the order (T036).
 * Ineligible partners never break the purchase — the buyer still buys, commission is just not granted (T035).
 */
export async function resolveAttribution(
  q: Queryable,
  env: string,
  input: { explicitCode?: string | null; guestToken: string | null; customerUserId: string | null },
): Promise<Attribution | null> {
  const window = await getPolicy<{ days: number }>(q, POLICY.attributionWindowDays, env);
  const ruleVersion = window?.version ?? 0;
  const now = new Date().toISOString();
  if (input.explicitCode) {
    const p = await q.query(`SELECT id, user_id, status FROM partners WHERE code=$1`, [input.explicitCode.trim().toUpperCase()]);
    const partner = p.rows[0];
    if (!partner) throw badRequest('PARTNER_CODE_INVALID', { 'body.referral_code': 'validation.partner_code' });
    return finalize({ partner_id: partner.id, campaign_id: null, touch_id: null, link_id: null, rule_version: ruleVersion, reason: 'explicit_code', attributed_at: now, eligible: true }, partner, input.customerUserId);
  }
  if (!window) return null; // no approved/demo window => click attribution disabled
  const conds: string[] = [];
  const params: unknown[] = [window.value.days];
  if (input.guestToken) {
    params.push(visitorHash(input.guestToken));
    conds.push(`t.visitor_hash = $${params.length}`);
  }
  if (input.customerUserId) {
    params.push(input.customerUserId);
    conds.push(`t.user_id = $${params.length}`);
  }
  if (!conds.length) return null;
  const t = await q.query(
    `SELECT t.id AS touch_id, t.link_id, l.campaign_id, l.status AS link_status, c.status AS campaign_status, p.id AS partner_id, p.user_id, p.status
       FROM referral_touches t JOIN referral_links l ON l.id=t.link_id JOIN partners p ON p.id=t.partner_id LEFT JOIN partner_campaigns c ON c.id=l.campaign_id
      WHERE t.eligible AND t.touched_at > now() - make_interval(days => $1) AND (${conds.join(' OR ')})
      ORDER BY t.touched_at DESC, t.id DESC LIMIT 1`,
    params,
  );
  const row = t.rows[0];
  if (!row) return null;
  const base: Attribution = { partner_id: row.partner_id, campaign_id: row.campaign_id, touch_id: row.touch_id, link_id: row.link_id, rule_version: ruleVersion, reason: 'last_eligible_click', attributed_at: now, eligible: true };
  if (row.link_status !== 'active' || (row.campaign_id && row.campaign_status !== 'active')) return { ...base, eligible: false, ineligible_reason: 'link_or_campaign_disabled' };
  return finalize(base, row, input.customerUserId);
}

function finalize(a: Attribution, partner: { user_id: string; status: string }, customerUserId: string | null): Attribution {
  if (partner.status !== 'active') return { ...a, eligible: false, ineligible_reason: `partner_${partner.status}` };
  if (customerUserId && partner.user_id === customerUserId) return { ...a, eligible: false, ineligible_reason: 'self_referral_review' };
  return a;
}
