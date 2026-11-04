'use client';
import { api } from '@/lib/api';

/**
 * Ad-measurement client (P0C). Nothing is sent unless the shop's single dataset is ready AND this visitor granted
 * consent. Refusing never blocks ordering. Values are always computed by the server; the browser only names the event.
 */
export interface TrackingConfig { consent_required: boolean; consent_policy_version: string; consent: 'granted' | 'denied' | 'withdrawn' | null; pixel: { dataset_id: string } | null }

let cfg: Promise<TrackingConfig | null> | null = null;
export function trackingConfig(refresh = false): Promise<TrackingConfig | null> {
  if (!cfg || refresh) cfg = api<TrackingConfig>('/tracking/config').catch(() => null);
  return cfg;
}

export async function setConsent(status: 'granted' | 'denied' | 'withdrawn') {
  const c = await trackingConfig();
  if (!c) return;
  await api('/tracking/consent', { method: 'POST', body: { status, policy_version: c.consent_policy_version } }).catch(() => {});
  await trackingConfig(true);
  window.dispatchEvent(new Event('uz-consent'));
}

function cookie(name: string): string | undefined {
  try { return document.cookie.split('; ').find((x) => x.startsWith(name + '='))?.split('=')[1]; } catch { return undefined; }
}

/** Browser identifiers that already exist on the customer's own device (never invented) + the current URL. */
export function browserContext(): { fbp?: string; fbc?: string; source_url: string } {
  const fbp = cookie('_fbp'); const fbc = cookie('_fbc');
  return { ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}), source_url: location.href.slice(0, 2000) };
}

export async function trackEvent(event: 'landing.rendered' | 'product.viewed' | 'checkout.started', refs: { landing_id?: string; product_id?: string; quote_id?: string }) {
  const c = await trackingConfig();
  if (!c?.consent_required || c.consent !== 'granted') return null;
  return api('/tracking/events', { method: 'POST', body: { event, event_id: crypto.randomUUID(), ...refs, ...browserContext() } }).catch(() => null);
}
