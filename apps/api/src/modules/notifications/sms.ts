/**
 * Eskiz.uz SMS adapter (notify.eskiz.uz). Configuration lives only in the server env:
 *   ESKIZ_EMAIL, ESKIZ_PASSWORD   — Eskiz cabinet login (never in code or chat)
 *   ESKIZ_FROM                    — sender name approved by Eskiz (default 4546 = Eskiz test sender)
 *   SMS_OTP_TEXT                  — the OTP text EXACTLY as approved by Eskiz moderation, with {code} in place of the code
 * Eskiz rejects texts that differ from an approved template, so the text is configuration, not code.
 */
const BASE = (process.env.ESKIZ_BASE_URL ?? 'https://notify.eskiz.uz/api').replace(/\/$/, '');
const DEFAULT_OTP_TEXT = 'UzShop: tasdiqlash kodi {code}. Kodni hech kimga bermang.';

export function smsConfigured(): boolean {
  return !!(process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD);
}
export function otpText(code: string): string {
  const t = (process.env.SMS_OTP_TEXT ?? '').trim() || DEFAULT_OTP_TEXT;
  return t.includes('{code}') ? t.replace('{code}', code) : `${t} ${code}`;
}

export class SmsError extends Error {
  constructor(message: string, public permanent: boolean) { super(message); }
}

let token: { value: string; at: number } | null = null;
/** Test hook: forget the cached token. */
export function resetSmsToken(): void { token = null; }

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ email: process.env.ESKIZ_EMAIL, password: process.env.ESKIZ_PASSWORD }),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: { token?: string }; message?: string };
  if (!res.ok || !j.data?.token) throw new SmsError(`eskiz login ${res.status}: ${j.message ?? 'error'}`, res.status === 401 || res.status === 422);
  token = { value: j.data.token, at: Date.now() };
  return token.value;
}

/** Sends one SMS; returns the Eskiz message id. Phone in E.164 (+998…). Re-logs in once on an expired token. */
export async function sendSms(phoneE164: string, text: string): Promise<string> {
  const mobile = phoneE164.replace(/\D/g, '');
  if (!/^998\d{9}$/.test(mobile)) throw new SmsError('phone_not_uz', true);
  // Eskiz tokens live 30 days; renew a bit earlier.
  let tok = token && Date.now() - token.at < 25 * 86400_000 ? token.value : await login();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}/message/sms/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ mobile_phone: mobile, message: text, from: process.env.ESKIZ_FROM || '4546' }),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string | number; status?: string; message?: unknown };
    if (res.status === 401 && attempt === 0) { tok = await login(); continue; }
    if (!res.ok || j.status === 'error') {
      const msg = typeof j.message === 'string' ? j.message : JSON.stringify(j.message ?? '');
      // 4xx (template not approved, bad number, no balance) will not fix itself by retrying an OTP that expires in minutes.
      throw new SmsError(`eskiz ${res.status}: ${msg}`.slice(0, 200), res.status >= 400 && res.status < 500);
    }
    return String(j.id ?? '');
  }
  throw new SmsError('eskiz auth failed', true);
}
