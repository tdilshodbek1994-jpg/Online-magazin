import { createHash } from 'node:crypto';
import type { Actor } from '../../platform/auth.js';
import { type Db, many, maybeOne, type Queryable, withTx } from '../../platform/db.js';
import { getPolicy } from '../../platform/policies.js';

/**
 * Landing & Target P0C — ad-measurement tracking outbox.
 *
 * Rules (task §5, contracts/event_matrix.csv, D11/D12):
 *  - one opaque event_id per real business event; retries/replays/reloads reuse it (business_key UNIQUE);
 *  - Lead ≠ Purchase (different business keys, different event ids);
 *  - Purchase only from the recognition rule: prepaid captured OR COD delivered + remittance reconciled;
 *  - refunds are internal corrections — never a negative Purchase;
 *  - no consent → nothing is exported; withdrawal is re-checked right before sending;
 *  - partner-assisted (on-behalf) orders never carry the partner's browser identity;
 *  - phone is normalised + hashed exactly once; fbp/fbc only when the real browser supplied them (never generated);
 *  - event_time is the real event time; a late event becomes 'expired', its time is never rewritten;
 *  - provider timeout → 'unknown', replayed later with the same identity;
 *  - test events never go to the live dataset in production.
 */

export const BROWSER_EVENTS = ['landing.rendered', 'product.viewed', 'checkout.started'] as const;
export type BrowserEvent = (typeof BROWSER_EVENTS)[number];

export interface TrackingSettings {
  dataset_id: string | null;
  credentials_ref: string | null;
  enabled: boolean;
  mapping_version: string;
  consent_policy_version: string;
  test_event_code: string | null;
  api_version: string | null;
  updated_at: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Consent subject: the logged-in user, else a hash of the guest token. Never a phone/email. */
export function subjectKey(actor: Pick<Actor, 'userId' | 'guestToken'>): string | null {
  if (actor.userId) return `u:${actor.userId}`;
  if (actor.guestToken) return `g:${sha256(actor.guestToken)}`;
  return null;
}

export async function trackingSettings(q: Queryable): Promise<TrackingSettings> {
  return (await q.query(`SELECT dataset_id, credentials_ref, enabled, mapping_version, consent_policy_version, test_event_code, api_version, updated_at FROM tracking_settings WHERE id=1`)).rows[0];
}

export async function currentConsent(q: Queryable, subject: string | null): Promise<{ id: string; status: 'granted' | 'denied' | 'withdrawn'; policy_version: string } | null> {
  if (!subject) return null;
  return maybeOne(q, `SELECT id::text, status, policy_version FROM tracking_consents WHERE subject_key=$1 AND purpose='ad_measurement' ORDER BY id DESC LIMIT 1`, [subject]);
}

/** Hash a match field once. An already-hashed value (64 hex) is passed through unchanged (no double hashing). */
export function hashOnce(v: string): string {
  const t = v.trim();
  if (/^[a-f0-9]{64}$/.test(t)) return t;
  return sha256(t.toLowerCase());
}

/** Phone normalisation for matching: digits only with country code (E.164 without '+'). */
export const normPhone = (e164: string) => e164.replace(/\D/g, '');

const ALLOWED_QUERY = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'r']);
const PII_LIKE = /(@|%40)|(\+?\d[\d\s\-()]{8,}\d)/;

/**
 * Event source URL without personal data: only allowlisted query keys survive, any value or path segment that looks
 * like a phone/email is dropped, fragments are removed. Unparseable or non-http(s) URLs give null.
 */
export function sanitizeSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const out = new URL(`${u.protocol}//${u.host}`);
  out.pathname = u.pathname.split('/').map((seg) => (PII_LIKE.test(decodeURIComponent(seg)) ? '' : seg)).filter((s, i) => i === 0 || s !== '').join('/') || '/';
  for (const [k, v] of u.searchParams) if (ALLOWED_QUERY.has(k) && !PII_LIKE.test(v)) out.searchParams.append(k, v);
  return out.toString();
}

/** fbp/fbc are accepted only in the documented cookie format; never synthesised. */
const FB_COOKIE = /^fb\.[0-9]\.[0-9]{10,16}\.[A-Za-z0-9_\-.]{1,500}$/;
export const validFbCookie = (v: string | undefined | null) => (v && FB_COOKIE.test(v) ? v : null);

export interface RecordInput {
  businessKey: string;
  internalEvent: string;
  eventTime: Date | string;
  actionSource: 'website' | 'phone_call' | 'chat' | 'system_generated';
  orderId?: string | null;
  landingId?: string | null;
  subject?: string | null;
  consent?: { id: string; status: string } | null;
  customData?: Record<string, unknown>;
  userData?: Record<string, unknown>;
  sourceUrl?: string | null;
  isTest?: boolean;
  eventId?: string;
}

/**
 * Write one business event to the outbox (same transaction as the business change). Idempotent by business key:
 * a replay returns the existing event (same event_id, same time, same values).
 */
export async function recordEvent(tx: Queryable, e: RecordInput): Promise<{ event_id: string; status: string; meta_event: string | null; created: boolean }> {
  const s = await trackingSettings(tx);
  const dict = await maybeOne<{ meta_event: string | null }>(tx, `SELECT meta_event FROM tracking_event_dictionary WHERE mapping_version=$1 AND internal_event=$2`, [s.mapping_version, e.internalEvent]);
  if (!dict) throw new Error(`unknown tracking event ${e.internalEvent}`);
  const granted = e.consent?.status === 'granted';
  const status = dict.meta_event === null ? 'internal' : granted ? 'pending' : 'suppressed';
  const reason = status === 'suppressed' ? 'no_consent' : null;
  // Without consent nothing identifying is kept, only the fact for internal diagnostics.
  const userData = status === 'pending' ? (e.userData ?? {}) : {};
  const ins = await tx.query(
    `INSERT INTO tracking_events (event_id, business_key, mapping_version, internal_event, meta_event, event_time, action_source, order_id, landing_id, subject_key, consent_id, custom_data, user_data, source_url, is_test, status, blocked_reason)
     VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING RETURNING event_id::text, status, meta_event`,
    [e.eventId ?? null, e.businessKey, s.mapping_version, e.internalEvent, dict.meta_event, e.eventTime, e.actionSource, e.orderId ?? null, e.landingId ?? null, e.subject ?? null,
      e.consent?.id ?? null, JSON.stringify(e.customData ?? {}), JSON.stringify(userData), e.sourceUrl ?? null, e.isTest ?? false, status, reason],
  );
  if (ins.rowCount) return { ...ins.rows[0], created: true };
  const ex = await maybeOne<{ event_id: string; status: string; meta_event: string | null }>(tx, `SELECT event_id::text, status, meta_event FROM tracking_events WHERE business_key=$1`, [e.businessKey]);
  if (!ex) throw Object.assign(new Error('EVENT_ID_TAKEN'), { code: 'EVENT_ID_TAKEN' });
  return { ...ex, created: false };
}

export interface OrderTrackingContext {
  on_behalf: boolean;
  subject: string | null;
  consent: { id: string; status: string } | null;
  fbp: string | null;
  fbc: string | null;
  source_url: string | null;
  landing_id: string | null;
}

export interface BrowserTrackingInput { fbp?: string; fbc?: string; source_url?: string }

/** Snapshot the tracking context on the order at creation time. On-behalf orders keep no browser identity at all. */
export async function captureOrderContext(tx: Queryable, actor: Actor, orderId: string, input: BrowserTrackingInput | undefined, opts: { onBehalf: boolean; landingId?: string | null }): Promise<OrderTrackingContext> {
  let ctx: OrderTrackingContext;
  if (opts.onBehalf) {
    ctx = { on_behalf: true, subject: null, consent: null, fbp: null, fbc: null, source_url: null, landing_id: opts.landingId ?? null };
  } else {
    const subject = subjectKey(actor);
    const c = await currentConsent(tx, subject);
    const granted = c?.status === 'granted';
    ctx = {
      on_behalf: false, subject, consent: c ? { id: c.id, status: c.status } : null,
      fbp: granted ? validFbCookie(input?.fbp) : null, fbc: granted ? validFbCookie(input?.fbc) : null,
      source_url: granted ? sanitizeSourceUrl(input?.source_url) : null, landing_id: opts.landingId ?? null,
    };
  }
  await tx.query(`UPDATE orders SET tracking_context=$2 WHERE id=$1`, [orderId, JSON.stringify(ctx)]);
  return ctx;
}

function orderUserData(ctx: OrderTrackingContext, phone: string | null): Record<string, unknown> {
  if (ctx.on_behalf) return phone ? { ph: [hashOnce(normPhone(phone))] } : {};
  return { ...(phone ? { ph: [hashOnce(normPhone(phone))] } : {}), ...(ctx.fbp ? { fbp: ctx.fbp } : {}), ...(ctx.fbc ? { fbc: ctx.fbc } : {}) };
}

async function orderFacts(tx: Queryable, orderId: string) {
  const o = await maybeOne<{ id: string; payment_method: string; payment_status: string; fulfillment_status: string; payable_minor: string; customer_phone: string | null; created_at: string; paid_at: string | null; delivered_at: string | null; tracking_context: OrderTrackingContext | null; is_test: boolean }>(
    tx, `SELECT o.id, o.payment_method, o.payment_status, o.fulfillment_status, o.payable_minor::text, o.customer_phone, o.created_at, o.paid_at, o.delivered_at, o.tracking_context, false AS is_test FROM orders o WHERE o.id=$1`, [orderId]);
  if (!o) return null;
  const lines = await many<{ product_id: string; qty: number }>(tx, `SELECT s.product_id, (ol.qty - ol.canceled_qty)::int AS qty FROM order_lines ol JOIN skus s ON s.id=ol.sku_id WHERE ol.order_id=$1`, [orderId]);
  return { o, lines };
}

/** UZS amount from tiyin as a decimal string (no float maths). */
export const uzs = (minor: string | bigint) => { const b = BigInt(minor); return `${b / 100n}.${String(b % 100n).padStart(2, '0')}`; };

/** Lead: the real customer's order/request was stored. Not for on-behalf orders (no genuine customer session). */
export async function recordLead(tx: Queryable, orderId: string) {
  const f = await orderFacts(tx, orderId);
  const ctx = f?.o.tracking_context;
  if (!f || !ctx || ctx.on_behalf) return null;
  return recordEvent(tx, {
    businessKey: `customer.request_accepted:order:${orderId}`, internalEvent: 'customer.request_accepted', eventTime: f.o.created_at, actionSource: 'website',
    orderId, landingId: ctx.landing_id, subject: ctx.subject, consent: ctx.consent, sourceUrl: ctx.source_url,
    customData: { currency: 'UZS', content_ids: f.lines.map((l) => l.product_id), content_type: 'product' },
    userData: orderUserData(ctx, f.o.customer_phone),
  });
}

/**
 * Purchase recognition (single rule): prepaid → payment captured; COD → delivered AND remittance reconciled (paid).
 * Authorization alone, delivery alone or a thank-you reload never creates a Purchase. One Purchase per order.
 */
export async function maybeRecognizeSale(tx: Queryable, orderId: string) {
  const f = await orderFacts(tx, orderId);
  if (!f) return null;
  const { o } = f;
  const recognized = o.payment_method === 'cod'
    ? o.fulfillment_status === 'delivered' && o.payment_status === 'paid'
    : o.payment_status === 'paid';
  if (!recognized || !o.paid_at) return null;
  const ctx: OrderTrackingContext = o.tracking_context ?? { on_behalf: false, subject: null, consent: null, fbp: null, fbc: null, source_url: null, landing_id: null };
  const eventTime = o.payment_method === 'cod' && o.delivered_at && new Date(o.delivered_at) > new Date(o.paid_at) ? o.delivered_at : o.paid_at;
  const lines = f.lines.filter((l) => l.qty > 0);
  return recordEvent(tx, {
    businessKey: `sale.recognized:order:${orderId}`, internalEvent: 'sale.recognized', eventTime, actionSource: ctx.on_behalf ? 'phone_call' : 'website',
    orderId, landingId: ctx.landing_id, subject: ctx.subject, consent: ctx.consent, sourceUrl: ctx.on_behalf ? null : ctx.source_url,
    customData: { currency: 'UZS', value: uzs(o.payable_minor), content_ids: lines.map((l) => l.product_id), content_type: 'product', num_items: lines.reduce((a, l) => a + l.qty, 0), order_id: orderId },
    userData: orderUserData(ctx, o.customer_phone),
  });
}

/** Refund: internal correction only. Never a negative Purchase; provider adjustment is a separate future capability. */
export async function recordRefund(tx: Queryable, orderId: string, refundRef: string, amountMinor: string | bigint, at: Date | string = new Date()) {
  return recordEvent(tx, {
    businessKey: `order.refunded:${refundRef}`, internalEvent: 'order.refunded', eventTime: at, actionSource: 'system_generated', orderId,
    customData: { currency: 'UZS', refund_value: uzs(amountMinor) },
  });
}

// ---------------------------------------------------------------- dispatcher

export interface ProviderPayload {
  event_name: string; event_time: number; event_id: string; action_source: string; event_source_url?: string;
  user_data: Record<string, unknown>; custom_data: Record<string, unknown>;
}
export interface TransportResult { outcome: 'sent' | 'rejected' | 'unknown' | 'blocked'; http_status?: number; detail?: string }
export interface TrackingTransport {
  send(req: { dataset_id: string; api_version: string | null; test_event_code: string | null; credentials_ref: string; events: ProviderPayload[] }): Promise<TransportResult>;
}

/** Default: no HTTP adapter is connected in P0C (no credentials, no app review). Honest blocked state, never "sent". */
export const notConnectedTransport: TrackingTransport = { send: async () => ({ outcome: 'blocked', detail: 'adapter_not_connected' }) };

export function toProviderPayload(e: { event_id: string; meta_event: string; event_time: string | Date; action_source: string; source_url: string | null; user_data: Record<string, unknown>; custom_data: Record<string, unknown> }): ProviderPayload {
  return {
    event_name: e.meta_event, event_time: Math.floor(new Date(e.event_time).getTime() / 1000), event_id: e.event_id, action_source: e.action_source,
    ...(e.source_url ? { event_source_url: e.source_url } : {}), user_data: e.user_data, custom_data: e.custom_data,
  };
}

/** Why the shop cannot export right now (null = ready). */
export function blockedReason(s: TrackingSettings): string | null {
  if (!s.enabled) return 'tracking_disabled';
  if (!s.dataset_id) return 'no_dataset';
  if (!s.credentials_ref) return 'no_credentials';
  return null;
}

/**
 * Send pending/blocked/unknown events. Each event is claimed with SKIP LOCKED in its own short transaction; the HTTP
 * call never runs inside an open transaction for longer than the adapter timeout. Safe to run concurrently/restart.
 */
export async function dispatchTracking(db: Db, env: string, transport: TrackingTransport = notConnectedTransport, now: Date = new Date(), limit = 100) {
  const counts: Record<string, number> = {};
  const maxAge = (await getPolicy<{ days: number }>(db, 'tracking.server_event_max_age_days', env))?.value.days ?? 7;
  const ids = await many<{ event_id: string }>(db, `SELECT event_id::text FROM tracking_events WHERE status IN ('pending','blocked','unknown') ORDER BY created_at LIMIT $1`, [limit]);
  for (const { event_id } of ids) {
    const outcome = await withTx(db, async (tx) => {
      const e = (await tx.query(`SELECT * FROM tracking_events WHERE event_id=$1 AND status IN ('pending','blocked','unknown') FOR UPDATE SKIP LOCKED`, [event_id])).rows[0];
      if (!e) return null;
      const set = async (status: string, reason: string | null, http?: number, attempt = true) => {
        const changed = status !== e.status || reason !== e.blocked_reason;
        await tx.query(`UPDATE tracking_events SET status=$2, blocked_reason=$3, attempts=attempts + $4, last_attempt_at=CASE WHEN $4=1 THEN $5 ELSE last_attempt_at END, sent_at=CASE WHEN $2='sent' THEN $5 ELSE sent_at END WHERE event_id=$1`,
          [event_id, status, reason, attempt ? 1 : 0, now]);
        if (changed || attempt) await tx.query(`INSERT INTO tracking_dispatch_attempts (event_id, outcome, http_status, detail) VALUES ($1,$2,$3,$4)`, [event_id, status === 'pending' ? 'unknown' : status, http ?? null, reason]);
        return status;
      };
      // 1) consent is re-checked right before sending (withdrawal stops pending exports)
      if (e.subject_key) {
        const c = await currentConsent(tx, e.subject_key);
        if (c?.status !== 'granted') return set('suppressed', c ? 'consent_withdrawn' : 'no_consent', undefined, false);
      } else if (!e.consent_id) return set('suppressed', 'no_consent', undefined, false);
      // 2) synthetic/test events never reach a live dataset in production
      if (e.is_test && env === 'production') return set('rejected', 'test_event_in_production', undefined, false);
      // 3) late events keep their real time and become explicitly expired
      if (now.getTime() - new Date(e.event_time).getTime() > maxAge * 86_400_000) return set('expired', 'outside_provider_window', undefined, false);
      // 4) connection readiness
      const s = await trackingSettings(tx);
      const br = blockedReason(s);
      if (br) return e.status === 'blocked' && e.blocked_reason === br ? 'blocked' : set('blocked', br, undefined, false);
      const payload = toProviderPayload(e);
      let r: TransportResult;
      try {
        r = await Promise.race([
          transport.send({ dataset_id: s.dataset_id!, api_version: s.api_version, test_event_code: env === 'production' ? null : s.test_event_code, credentials_ref: s.credentials_ref!, events: [payload] }),
          new Promise<TransportResult>((resolve) => setTimeout(() => resolve({ outcome: 'unknown', detail: 'timeout' }), 10_000)),
        ]);
      } catch (err) {
        r = { outcome: 'unknown', detail: String((err as Error).message ?? 'error').slice(0, 200) };
      }
      return set(r.outcome, r.outcome === 'sent' ? null : (r.detail ?? r.outcome), r.http_status);
    });
    if (outcome) counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

/** Health read-model for the admin «Pixel/CAPI diagnostikasi» panel (no PII, no secrets). */
export async function trackingHealth(q: Queryable) {
  const s = await trackingSettings(q);
  const byStatus = await many<{ status: string; n: number }>(q, `SELECT status, COUNT(*)::int AS n FROM tracking_events GROUP BY status`);
  const byEvent = await many<{ internal_event: string; meta_event: string | null; status: string; n: number }>(q, `SELECT internal_event, meta_event, status, COUNT(*)::int AS n FROM tracking_events WHERE created_at > now() - interval '30 days' GROUP BY 1,2,3 ORDER BY 1`);
  const lastSent = await maybeOne<{ at: string }>(q, `SELECT MAX(sent_at) AS at FROM tracking_events WHERE status='sent'`);
  const lastReject = await maybeOne<{ at: string; reason: string }>(q, `SELECT last_attempt_at AS at, blocked_reason AS reason FROM tracking_events WHERE status='rejected' ORDER BY last_attempt_at DESC NULLS LAST LIMIT 1`);
  const recent = await many(q, `SELECT event_id, internal_event, meta_event, status, blocked_reason, action_source, event_time, attempts, order_id FROM tracking_events ORDER BY created_at DESC LIMIT 30`);
  const dictionary = await many(q, `SELECT internal_event, meta_event, transport, value_rule FROM tracking_event_dictionary WHERE mapping_version=$1 ORDER BY meta_event NULLS LAST, internal_event`, [s.mapping_version]);
  const reason = blockedReason(s);
  return {
    connection: { state: reason ? 'blocked' : 'ready', blocked_reason: reason, dataset_id: s.dataset_id, has_credentials: !!s.credentials_ref, enabled: s.enabled, api_version: s.api_version, mapping_version: s.mapping_version, consent_policy_version: s.consent_policy_version, test_mode: !!s.test_event_code },
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), by_event: byEvent,
    last_success_at: lastSent?.at ?? null, last_rejection: lastReject?.at ? lastReject : null, recent, dictionary,
    notes: ['HTTP 200 does not prove that an order was attributed.', 'Meta numbers are not the internal ledger and are never reconciled into it.'],
  };
}
