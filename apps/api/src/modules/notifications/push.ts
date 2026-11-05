import { createSign } from 'node:crypto';

/**
 * Firebase Cloud Messaging (HTTP v1) for the Android app. Server env only:
 *   FCM_SERVICE_ACCOUNT_B64 — base64 of the Firebase service-account JSON (project_id, client_email, private_key).
 * Never in code or chat. Without it nothing is sent and no push jobs are queued.
 */
interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let sa: ServiceAccount | null | undefined;
function account(): ServiceAccount | null {
  if (sa !== undefined) return sa;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_B64;
    const j = raw ? (JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount) : null;
    sa = j?.project_id && j.client_email && j.private_key ? j : null;
  } catch { sa = null; }
  return sa;
}
export function fcmConfigured(): boolean { return !!account(); }
/** Test hook. */
export function resetFcm(): void { sa = undefined; access = null; }

let access: { token: string; exp: number } | null = null;
async function accessToken(a: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (access && access.exp - 60 > now) return access.token;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(a.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !j.access_token) throw new Error(`fcm oauth ${res.status}`);
  access = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return access.token;
}

export type PushResult = { ok: true; ref: string } | { ok: false; invalidToken: boolean; retry: boolean; error: string };
export async function sendPush(token: string, msg: { title: string; body: string; href?: string | null }): Promise<PushResult> {
  const a = account();
  if (!a) return { ok: false, invalidToken: false, retry: false, error: 'fcm_not_configured' };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken(a)}` }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ message: { token, notification: { title: msg.title, body: msg.body.slice(0, 900) }, data: msg.href ? { href: msg.href } : {}, android: { priority: 'HIGH', notification: { color: '#0B7A55' } } } }),
  });
  const j = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string } };
  if (res.ok) return { ok: true, ref: j.name ?? '' };
  const status = j.error?.status ?? '';
  return { ok: false, invalidToken: res.status === 404 || status === 'UNREGISTERED' || (res.status === 400 && status === 'INVALID_ARGUMENT'), retry: res.status === 429 || res.status >= 500, error: `fcm ${res.status} ${status}`.trim() };
}

/** Where a tap on the notification leads (same targets as the in-cabinet list). */
export function pushHref(template: string, params: Record<string, unknown>): string {
  const oid = typeof params.order_id === 'string' && /^[0-9a-f-]{36}$/.test(params.order_id) ? params.order_id : null;
  if (template.startsWith('partner.') && oid) return `/partner/orders/${oid}`;
  const STATIC: Record<string, string> = { 'partner.payout_paid': '/partner/payouts', 'partner.bonus': '/partner/wallet', 'partner.penalty': '/partner/wallet', 'partner.contest_prize': '/partner/contests', 'partner.level_up': '/partner/level', 'partner.coupon_issued': '/partner/level', 'automation.alert': '/admin' };
  return STATIC[template] ?? (template.startsWith('partner.') ? '/partner/notifications' : '/app');
}
