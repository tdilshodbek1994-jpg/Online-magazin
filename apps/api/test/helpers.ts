import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { type AppConfig, loadConfig } from '../src/config.js';
import { newToken } from '../src/platform/auth.js';
import { createPool, type Db } from '../src/platform/db.js';

export interface T {
  app: FastifyInstance;
  db: Db;
  cfg: AppConfig;
}

let shared: T | null = null;
export async function setupApp(env: Partial<NodeJS.ProcessEnv> = {}): Promise<T> {
  if (shared && Object.keys(env).length === 0) return shared;
  const url = process.env.TEST_DATABASE_URL!;
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, PUBLIC_WEB_URL: 'http://localhost:3000', ...env });
  const db = createPool(url, 40);
  const app = await buildApp(cfg, db);
  const t = { app, db, cfg };
  if (Object.keys(env).length === 0) shared = t;
  return t;
}

let phoneSeq = Math.floor(Math.random() * 9_000_000) + 1_000_000;
export const nextPhone = () => `+99891${String(phoneSeq++).padStart(7, '0')}`;

export interface U {
  id: string;
  token: string;
  phone: string;
}

export async function mkUser(t: T, roles: string[] = ['customer'], phone = nextPhone(), elevated = true): Promise<U> {
  const u = await t.db.query(`INSERT INTO users (phone_e164, phone_verified_at, display_name) VALUES ($1, now(), $2) RETURNING id`, [phone, `${roles[0]} ${phone.slice(-4)}`]);
  const id = u.rows[0].id as string;
  for (const r of roles) await t.db.query(`INSERT INTO memberships (user_id, role_code) VALUES ($1,$2)`, [id, r]);
  const { token, hash } = newToken();
  // Test sessions are pre-elevated (as after a successful TOTP step-up) unless elevated=false.
  await t.db.query(`INSERT INTO sessions (user_id, token_hash, phone_at_issue, expires_at, elevated_until) VALUES ($1,$2,$3, now() + interval '1 day', CASE WHEN $4 THEN now() + interval '1 hour' END)`, [id, hash, phone, elevated]);
  return { id, token, phone };
}

export async function mkPartner(t: T, status = 'active'): Promise<U & { partnerId: string; code: string }> {
  const u = await mkUser(t, ['customer', 'partner']);
  const code = ('P' + randomUUID().replace(/-/g, '').slice(0, 8)).toUpperCase();
  const p = await t.db.query(`INSERT INTO partners (user_id, code, display_name, status) VALUES ($1,$2,'Test partner',$3) RETURNING id`, [u.id, code, status]);
  return { ...u, partnerId: p.rows[0].id, code };
}

export interface P {
  productId: string;
  skuIds: string[];
  slug: string;
}

/** Product with SKUs; prices in so'm (converted to tiyin), optional commission rule. */
export async function mkProduct(t: T, o: { prices?: number[]; stock?: number[]; rule?: { kind: 'percent'; bps: number } | { kind: 'fixed_per_unit'; fixed: number }; status?: string; name?: string } = {}): Promise<P> {
  const prices = o.prices ?? [100_000];
  const stock = o.stock ?? prices.map(() => 10);
  const org = (await t.db.query(`SELECT id FROM organizations WHERE kind='platform_owner'`)).rows[0].id;
  const wh = (await t.db.query(`SELECT id FROM warehouses WHERE code='MAIN'`)).rows[0].id;
  let cat = (await t.db.query(`SELECT id FROM categories WHERE slug='test-cat'`)).rows[0]?.id;
  if (!cat) cat = (await t.db.query(`INSERT INTO categories (slug, name) VALUES ('test-cat','{"uz-Latn":"Test"}') ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`)).rows[0].id;
  const slug = `p-${randomUUID().slice(0, 8)}`;
  const name = o.name ?? `Mahsulot ${slug}`;
  const p = await t.db.query(`INSERT INTO products (owner_org_id, category_id, slug, name, status, search_doc, published_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
    [org, cat, slug, JSON.stringify({ 'uz-Latn': name }), o.status ?? 'published', name.toLowerCase()]);
  const productId = p.rows[0].id;
  const skuIds: string[] = [];
  for (let i = 0; i < prices.length; i++) {
    const s = await t.db.query(`INSERT INTO skus (product_id, sku_code, variant, variant_key, cost_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [productId, `${slug}-${i}`, JSON.stringify({ v: String(i) }), `v=${i}`, prices[i]! * 50]);
    const sku = s.rows[0].id;
    await t.db.query(`INSERT INTO offers (sku_id, merchant_org_id, price_minor) VALUES ($1,$2,$3)`, [sku, org, prices[i]! * 100]);
    await t.db.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id, on_hand_sellable) VALUES ($1,$2,$3,$4)`, [sku, org, wh, stock[i]]);
    skuIds.push(sku);
  }
  if (o.rule) {
    await t.db.query(`INSERT INTO commission_rules (product_id, version, kind, rate_bps, fixed_minor, effective_from) VALUES ($1,1,$2,$3,$4, now() - interval '1 hour')`,
      [productId, o.rule.kind, o.rule.kind === 'percent' ? o.rule.bps : null, o.rule.kind === 'fixed_per_unit' ? o.rule.fixed * 100 : null]);
  }
  return { productId, skuIds, slug };
}

export async function zoneId(t: T): Promise<string> {
  return (await t.db.query(`SELECT id FROM delivery_zones WHERE region_code='TAS' AND active LIMIT 1`)).rows[0].id;
}

export interface ReqOpts {
  token?: string;
  guest?: string;
  idem?: string;
  body?: unknown;
  ua?: string;
  headers?: Record<string, string>;
}

export async function api(t: T, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: ReqOpts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.guest) headers['x-guest-token'] = o.guest;
  if (o.idem) headers['idempotency-key'] = o.idem;
  headers['user-agent'] = o.ua ?? 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile';
  const res = await t.app.inject({ method, url: url.startsWith('/api') || url.startsWith('/health') || url.startsWith('/media') ? url : `/api/v1${url}`, headers, payload: o.body as never });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, raw: res };
}

export const address = { region_code: 'TAS', district: 'Yunusobod', street: 'Amir Temur', house: '1' };

/** Customer flow: put lines in cart → quote → confirm. Returns order id/number. */
export async function placeOrder(t: T, who: { token?: string; guest?: string; phone: string }, lines: { sku_id: string; qty: number }[], o: { payment?: 'cod' | 'online'; referral_code?: string; idem?: string; promo?: string } = {}) {
  for (const l of lines) {
    const r = await api(t, 'PUT', '/cart/lines', { token: who.token, guest: who.guest, body: l });
    if (r.status !== 200) throw new Error(`cart ${r.status} ${JSON.stringify(r.json)}`);
  }
  const q = await api(t, 'POST', '/checkout/quotes', { token: who.token, guest: who.guest, body: { delivery_zone_id: await zoneId(t), address, contact: { name: 'Mijoz', phone: who.phone }, ...(o.promo ? { promo_code: o.promo } : {}) } });
  if (q.status !== 200) throw new Error(`quote ${q.status} ${JSON.stringify(q.json)}`);
  const c = await api(t, 'POST', '/checkout/confirmations', {
    token: who.token, guest: who.guest, idem: o.idem ?? randomUUID(),
    body: { quote_id: q.json.quote_id, quote_hash: q.json.quote_hash, payment_method: o.payment ?? 'cod', accept_terms: true, ...(o.referral_code ? { referral_code: o.referral_code } : {}) },
  });
  return { ...c, quote: q.json };
}

export async function staff(t: T) {
  return {
    owner: await mkUser(t, ['owner']),
    operator: await mkUser(t, ['operator']),
    operator2: await mkUser(t, ['operator']),
    warehouse: await mkUser(t, ['warehouse']),
    courier: await mkUser(t, ['courier']),
    finance: await mkUser(t, ['finance']),
    finance2: await mkUser(t, ['finance']),
    catalog: await mkUser(t, ['catalog_manager']),
  };
}

export type Staff = Awaited<ReturnType<typeof staff>>;

/** Drive a confirmed COD order through warehouse → courier → remittance → finance. */
export async function fulfilCod(t: T, s: Staff, orderId: string, opts: { collected?: string; received?: string } = {}) {
  for (const step of ['pick', 'pack']) {
    const r = await api(t, 'POST', `/ops/orders/${orderId}/${step}`, { token: s.warehouse.token });
    if (r.status !== 200) throw new Error(`${step} ${r.status} ${JSON.stringify(r.json)}`);
  }
  const ship = await api(t, 'POST', `/ops/orders/${orderId}/ship`, { token: s.warehouse.token, body: { courier_user_id: s.courier.id, tracking_id: 'TRK-1' } });
  if (ship.status !== 200) throw new Error(`ship ${ship.status} ${JSON.stringify(ship.json)}`);
  const del = await api(t, 'POST', `/courier/orders/${orderId}/deliver`, { token: s.courier.token, body: { proof: { method: 'otp', value: '1234' }, ...(opts.collected ? { cod_collected_minor: opts.collected } : {}) } });
  if (del.status !== 200) throw new Error(`deliver ${del.status} ${JSON.stringify(del.json)}`);
  const ord = (await t.db.query(`SELECT payable_minor FROM orders WHERE id=$1`, [orderId])).rows[0];
  const rem = await api(t, 'POST', '/courier/remittances', { token: s.courier.token, body: { order_ids: [orderId], declared_minor: opts.collected ?? ord.payable_minor } });
  if (rem.status !== 200) throw new Error(`remit ${rem.status} ${JSON.stringify(rem.json)}`);
  const conf = await api(t, 'POST', `/finance/remittances/${rem.json.remittance_id}/confirm`, { token: s.finance.token, body: { received_minor: opts.received ?? opts.collected ?? ord.payable_minor } });
  if (conf.status !== 200) throw new Error(`confirm ${conf.status} ${JSON.stringify(conf.json)}`);
  return { remittanceId: rem.json.remittance_id, confirm: conf.json };
}

export async function balances(t: T, partnerId: string) {
  const r = await t.db.query(`SELECT estimated_minor::text e, pending_minor::text p, available_minor::text a, reserved_minor::text r, paid_minor::text pd, debt_minor::text d FROM partner_balances WHERE partner_id=$1`, [partnerId]);
  return r.rows[0] ?? { e: '0', p: '0', a: '0', r: '0', pd: '0', d: '0' };
}

export const tiyin = (som: number) => String(som * 100);
