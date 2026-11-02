'use client';
export interface ApiError { code: string; field_errors?: Record<string, string>; details?: any; retryable?: boolean; correlation_id?: string; status: number }

function guestToken(): string {
  try {
    let g = localStorage.getItem('om_guest');
    if (!g) {
      g = crypto.randomUUID() + crypto.randomUUID();
      localStorage.setItem('om_guest', g);
    }
    return g;
  } catch {
    return 'no-storage-' + Math.random().toString(36).slice(2).padEnd(20, 'x');
  }
}
export const getToken = () => { try { return localStorage.getItem('om_token'); } catch { return null; } };
export const setToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem('om_token', t);
    else {
      // Logout/account switch clears private client state (T009).
      localStorage.removeItem('om_token');
      localStorage.removeItem('om_guest');
      sessionStorage.clear();
    }
  } catch {}
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idem?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-guest-token': guestToken() };
  const tok = getToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw { code: 'NETWORK', status: 0, retryable: true } as ApiError;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw { ...json, status: res.status } as ApiError;
  return json as T;
}

export function som(amountMinor: string | null | undefined): string {
  if (!amountMinor) return '—';
  const v = BigInt(amountMinor);
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = v % 100n;
  return `${whole}${frac ? ',' + frac.toString().padStart(2, '0') : ''} so'm`;
}
