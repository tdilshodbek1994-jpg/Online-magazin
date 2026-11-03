import { randomUUID } from 'node:crypto';
import { normalizeSearch } from '@om/shared';
import sharp from 'sharp';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { releaseMatured } from '../modules/commissions/service.js';
import { saveProductImage } from '../modules/catalog/media.js';
import { newToken } from '../platform/auth.js';
import { createPool, withTx } from '../platform/db.js';
import { migrate, MIGRATIONS_DIR } from '../platform/migrate.js';
import { type ArtKind, PALETTES, productSvg } from './art.js';

/**
 * DEMO data filler: ~500 products and a few hundred orders driven through the REAL flows (checkout, partner links,
 * Order Studio drafts, customer SMS confirmation, operator calls, warehouse, courier, COD remittance, finance,
 * hold release, payouts) so every screen — shop, operator, admin, partner cabinet — shows realistic, consistent numbers.
 * Everything is synthetic (fictional brands, generated names/phones) and marked DEMO. Refuses to run in production.
 *
 * Usage (after seed): node dist/demo/fill.js [--products 500] [--orders 350] [--no-images]
 */
const cfg = loadConfig();
if (cfg.env === 'production') { console.error('demo fill refused: NODE_ENV=production'); process.exit(1); }
const arg = (name: string, def: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const N_PRODUCTS = arg('products', 500);
const N_ORDERS = arg('orders', 350);
const IMAGES = !process.argv.includes('--no-images');

// Deterministic PRNG so repeated runs on a fresh DB look the same.
let seed = 20261103;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const weighted = <T extends string>(w: Record<T, number>): T => { const tot = Object.values<number>(w).reduce((a, b) => a + b, 0); let r = rnd() * tot; for (const [k, v] of Object.entries<number>(w)) { r -= v; if (r <= 0) return k as T; } return Object.keys(w)[0] as T; };

const db = createPool(cfg.databaseUrl, 10);
await migrate(db, MIGRATIONS_DIR, () => {});
const app = await buildApp({ ...cfg, env: 'test' }, db); // 'test' only silences per-request logs; flows and rules are the same
const q = async <R = any>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as R[];

if (!(await q(`SELECT 1 FROM categories WHERE slug='elektronika'`)).length) { console.error('Run the seed first (deploy-from-git.sh --seed).'); process.exit(1); }
if ((await q(`SELECT 1 FROM products WHERE slug LIKE 'demo-%' LIMIT 1`)).length && !process.argv.includes('--force')) {
  console.log('DEMO data already filled (products demo-*). Use --force to add more.');
  process.exit(0);
}

type Res = { status: number; json: any };
async function call(method: string, url: string, o: { token?: string; guest?: string; idem?: string; body?: unknown; ok?: number[] } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile DEMO-fill' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.guest) headers['x-guest-token'] = o.guest;
  if (o.idem) headers['idempotency-key'] = o.idem;
  const r = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: o.body as never });
  let json: any = null; try { json = r.json(); } catch { json = r.body; }
  if (r.statusCode >= 400 && !(o.ok ?? []).includes(r.statusCode)) throw new Error(`${method} ${url} → ${r.statusCode} ${JSON.stringify(json).slice(0, 300)}`);
  return { status: r.statusCode, json };
}

// ---------- staff sessions (DEMO users from the seed; a second finance user for the two-person payout rule) ----------
async function userId(phone: string, name: string, roles: string[]) {
  let id = (await q(`SELECT id FROM users WHERE phone_e164=$1`, [phone]))[0]?.id as string | undefined;
  if (!id) id = (await q(`INSERT INTO users (phone_e164, phone_verified_at, display_name) VALUES ($1, now(), $2) RETURNING id`, [phone, name]))[0].id;
  for (const r of roles) await q(`INSERT INTO memberships (user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, r]);
  return id!;
}
async function session(phone: string, name: string, roles: string[]) {
  const id = await userId(phone, name, roles);
  const { token, hash } = newToken();
  // Script-only session, pre-elevated like after a TOTP step-up; expires in 2 hours.
  await q(`INSERT INTO sessions (user_id, token_hash, phone_at_issue, expires_at, elevated_until) VALUES ($1,$2,$3, now() + interval '2 hours', now() + interval '2 hours')`, [id, hash, phone]);
  return { id, token };
}
const S = {
  owner: await session('+998900000001', 'Demo Owner', ['owner']),
  operator: await session('+998900000002', 'Demo Operator', ['operator']),
  warehouse: await session('+998900000003', 'Demo Warehouse', ['warehouse']),
  courier: await session('+998900000004', 'Demo Courier', ['courier']),
  finance: await session('+998900000005', 'Demo Finance', ['finance']),
  finance2: await session('+998900000009', 'Demo Finance 2', ['finance']),
};

// ---------- products ----------
const BRANDS = ['Nurli', 'Orzu', 'Zamon', 'Bahor', 'Yulduz', 'Kamalak', 'Tong', 'Sharq', 'Ufq', 'Samo', 'Lola', 'Navro‘z'];
type Tpl = { cat: string; latn: string; cyrl: string; art: ArtKind; price: [number, number]; variants?: 'color' | 'size' | 'shoe' | 'memory' | 'volume' };
const TPL: Tpl[] = [
  { cat: 'quloqchinlar', latn: 'Simsiz quloqchin', cyrl: 'Симсиз қулоқчин', art: 'headphones', price: [90_000, 650_000], variants: 'color' },
  { cat: 'quloqchinlar', latn: 'TWS quloqchin', cyrl: 'TWS қулоқчин', art: 'earbuds', price: [80_000, 450_000], variants: 'color' },
  { cat: 'quloqchinlar', latn: 'Portativ kolonka', cyrl: 'Портатив колонка', art: 'speaker', price: [150_000, 900_000] },
  { cat: 'elektronika', latn: 'Aqlli soat', cyrl: 'Ақлли соат', art: 'watch', price: [200_000, 1_500_000], variants: 'color' },
  { cat: 'elektronika', latn: 'Fitnes bilaguzuk', cyrl: 'Фитнес билагузук', art: 'watch', price: [120_000, 400_000], variants: 'color' },
  { cat: 'smartfonlar', latn: 'Smartfon', cyrl: 'Смартфон', art: 'phone', price: [1_200_000, 6_500_000], variants: 'memory' },
  { cat: 'smartfonlar', latn: 'Powerbank', cyrl: 'Повербанк', art: 'phone', price: [120_000, 350_000] },
  { cat: 'noutbuklar', latn: 'Noutbuk', cyrl: 'Ноутбук', art: 'laptop', price: [4_500_000, 14_000_000], variants: 'memory' },
  { cat: 'noutbuklar', latn: 'Planshet', cyrl: 'Планшет', art: 'laptop', price: [1_500_000, 5_000_000], variants: 'memory' },
  { cat: 'uy-rozgor', latn: 'Elektr choynak', cyrl: 'Электр чойнак', art: 'kettle', price: [120_000, 450_000], variants: 'volume' },
  { cat: 'uy-rozgor', latn: 'Stol chirog‘i', cyrl: 'Стол чироғи', art: 'lamp', price: [90_000, 300_000] },
  { cat: 'uy-rozgor', latn: 'Tungi chiroq', cyrl: 'Тунги чироқ', art: 'lamp', price: [60_000, 180_000], variants: 'color' },
  { cat: 'oshxona', latn: 'Blender', cyrl: 'Блендер', art: 'blender', price: [250_000, 900_000] },
  { cat: 'oshxona', latn: 'Mikser', cyrl: 'Миксер', art: 'blender', price: [180_000, 600_000] },
  { cat: 'oshxona', latn: 'Termos', cyrl: 'Термос', art: 'bottle', price: [60_000, 220_000], variants: 'volume' },
  { cat: 'kiyim-poyabzal', latn: 'Krossovka', cyrl: 'Кроссовка', art: 'sneaker', price: [250_000, 900_000], variants: 'shoe' },
  { cat: 'kiyim-poyabzal', latn: 'Futbolka', cyrl: 'Футболка', art: 'tshirt', price: [70_000, 220_000], variants: 'size' },
  { cat: 'kiyim-poyabzal', latn: 'Xudi', cyrl: 'Худи', art: 'tshirt', price: [180_000, 450_000], variants: 'size' },
  { cat: 'kiyim-poyabzal', latn: 'Ryukzak', cyrl: 'Рюкзак', art: 'backpack', price: [150_000, 500_000], variants: 'color' },
  { cat: 'gozallik', latn: 'Atir', cyrl: 'Атир', art: 'perfume', price: [150_000, 1_200_000], variants: 'volume' },
  { cat: 'sport', latn: 'Sport shishasi', cyrl: 'Спорт шишаси', art: 'bottle', price: [50_000, 150_000], variants: 'color' },
  { cat: 'sport', latn: 'Sport sumkasi', cyrl: 'Спорт сумкаси', art: 'backpack', price: [140_000, 380_000] },
];
const VAR: Record<string, [string, string[]]> = {
  color: ['rang', ['qora', 'oq', 'ko‘k', 'qizil', 'kulrang', 'pushti']],
  size: ['o‘lcham', ['S', 'M', 'L', 'XL']],
  shoe: ['o‘lcham', ['39', '40', '41', '42', '43', '44']],
  memory: ['xotira', ['128 GB', '256 GB', '512 GB']],
  volume: ['hajm', ['0,5 l', '1 l', '1,7 l']],
};
const round1k = (n: number) => Math.round(n / 1000) * 1000;

const org = (await q(`SELECT id FROM organizations WHERE kind='platform_owner'`))[0].id;
const wh = (await q(`SELECT id FROM warehouses WHERE code='MAIN'`))[0].id;
const catId: Record<string, string> = Object.fromEntries((await q(`SELECT slug, id FROM categories`)).map((r) => [r.slug, r.id]));
const pngCache = new Map<string, Buffer>();
const palKeys = Object.keys(PALETTES);

console.log(`== products: ${N_PRODUCTS}${IMAGES ? ' (with images)' : ''}`);
const t0 = Date.now();
for (let i = 0; i < N_PRODUCTS; i++) {
  const tp = TPL[i % TPL.length]!;
  const brand = pickOne(BRANDS);
  const model = `${String.fromCharCode(65 + int(0, 25))}${int(1, 99)}${rnd() < 0.3 ? ' Pro' : rnd() < 0.2 ? ' Lite' : ''}`;
  const latn = `${tp.latn} ${brand} ${model}`;
  const cyrl = `${tp.cyrl} ${brand} ${model}`;
  const slug = `demo-${normalizeSearch(latn).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${i}`;
  const base = round1k(tp.price[0] + rnd() * (tp.price[1] - tp.price[0]));
  const was = rnd() < 0.3 ? round1k(base * (1.1 + rnd() * 0.35)) : null;
  const vdef = tp.variants ? VAR[tp.variants]! : null;
  const vals = vdef ? vdef[1].slice(0, int(2, Math.min(4, vdef[1].length))) : [null];
  // Stock profile: some sold out, some nearly out, most in stock — so warnings show up in the cabinet.
  const profile = weighted({ out: 8, low: 15, ok: 77 });
  const days = int(0, 90);
  await withTx(db, async (tx) => {
    const b = (await tx.query(`INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [normalizeSearch(brand).replace(/[^a-z0-9]+/g, '-'), brand])).rows[0].id;
    const about = `${tp.latn} — ${brand} brendidan ${model} modeli. Sifat kafolati 12 oy, Toshkent bo‘ylab tez yetkazish.`;
    const prod = (await tx.query(`INSERT INTO products (owner_org_id, category_id, brand_id, slug, name, description, model, status, search_doc, published_at, warranty_months)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8, now() - make_interval(days => $9), 12) RETURNING id`,
      [org, catId[tp.cat], b, slug, JSON.stringify({ 'uz-Latn': latn, 'uz-Cyrl': cyrl }), JSON.stringify({ 'uz-Latn': `${about}\n\n(DEMO mahsulot — narx va tavsif namuna.)`, 'uz-Cyrl': `${cyrl} — DEMO маҳсулот.` }), model,
       normalizeSearch([latn, cyrl, brand, ...vals.filter(Boolean)].join(' ')), days])).rows[0].id;
    for (const [k, v] of vals.entries()) {
      const price = vdef?.[0] === 'xotira' || vdef?.[0] === 'hajm' ? round1k(base * (1 + k * 0.18)) : base;
      const stock = profile === 'out' ? 0 : profile === 'low' ? int(1, 3) : int(6, 80);
      const variant = v ? { [vdef![0]]: v } : {};
      const code = `DM${String(i).padStart(4, "0")}-${k}`;
      const sku = (await tx.query(`INSERT INTO skus (product_id, sku_code, variant, variant_key, cost_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [prod, code, JSON.stringify(variant), v ? `${vdef![0]}=${v}` : 'default', Math.round(price * 0.6) * 100])).rows[0].id;
      const offer = (await tx.query(`INSERT INTO offers (sku_id, merchant_org_id, price_minor, compare_at_minor) VALUES ($1,$2,$3,$4) RETURNING id`, [sku, org, price * 100, was && k === 0 ? was * 100 : null])).rows[0].id;
      await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, reason) VALUES ($1,1,$2,'demo fill')`, [offer, price * 100]);
      await tx.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id, on_hand_sellable) VALUES ($1,$2,$3,$4)`, [sku, org, wh, stock]);
      if (stock) await tx.query(`INSERT INTO inventory_movements (sku_id, merchant_org_id, warehouse_id, kind, bucket, qty_delta, ref_type, ref_id, reason) VALUES ($1,$2,$3,'receipt','on_hand_sellable',$4,'seed',$5,'demo fill')`, [sku, org, wh, stock, code]);
    }
    // DEMO commission rules only — the owner sets real ones in the admin panel.
    const fixed = rnd() < 0.25;
    await tx.query(`INSERT INTO commission_rules (product_id, version, kind, rate_bps, fixed_minor, effective_from) VALUES ($1,1,$2,$3,$4, now() - interval '120 days')`,
      [prod, fixed ? 'fixed_per_unit' : 'percent', fixed ? null : pickOne([500, 800, 1000, 1200, 1500, 2000, 2500]), fixed ? round1k(base * 0.12) * 100 : null]);
    if (IMAGES) {
      const key = `${tp.art}:${palKeys[i % palKeys.length]}`;
      let png = pngCache.get(key);
      if (!png) { png = await sharp(Buffer.from(productSvg(tp.art, PALETTES[palKeys[i % palKeys.length]!]!))).png().toBuffer(); pngCache.set(key, png); }
      await saveProductImage(tx, cfg.mediaDir, prod, png, { mime: 'image/png', width: 800, height: 800, filename: `${slug}.png`, alt: { 'uz-Latn': latn, 'uz-Cyrl': cyrl }, rights_source: 'DEMO illustration (generated)', sort: 0, uploadedBy: null });
    }
  });
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${N_PRODUCTS} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

// ---------- partners ----------
console.log('== partners');
const FIRST = ['Aziz', 'Dilnoza', 'Jasur', 'Malika', 'Sardor', 'Nilufar', 'Bekzod', 'Gulnora', 'Otabek', 'Shahlo', 'Rustam', 'Madina', 'Farrux', 'Zarina', 'Sherzod', 'Kamola', 'Javohir', 'Sevara', 'Doston', 'Mohira'];
const DISTRICTS = ['Yunusobod', 'Chilonzor', 'Mirzo Ulug‘bek', 'Yakkasaroy', 'Sergeli', 'Olmazor', 'Shayxontohur', 'Uchtepa', 'Yashnobod', 'Mirobod', 'Bektemir'];
const STREETS = ['Amir Temur', 'Bunyodkor', 'Navoiy', 'Mustaqillik', 'Bobur', 'Shota Rustaveli', 'Qatortol', 'Farg‘ona yo‘li', 'Labzak', 'Chilonzor-9'];
let phoneSeq = 3_000_000 + int(0, 999_999);
const fakePhone = () => `+99893${String(phoneSeq++).padStart(7, '0')}`;

const demoPartnerUser = (await q(`SELECT user_id, id FROM partners WHERE code='DEMO777'`))[0];
if (!demoPartnerUser) { console.error('DEMO777 partner missing — run the seed first'); process.exit(1); }
const mkSessionFor = async (uid: string, phone: string) => { const { token, hash } = newToken(); await q(`INSERT INTO sessions (user_id, token_hash, phone_at_issue, expires_at) VALUES ($1,$2,$3, now() + interval '2 hours')`, [uid, hash, phone]); return token; };
const partners: { id: string; token: string; name: string; weight: number }[] = [
  { id: demoPartnerUser.id, token: await mkSessionFor(demoPartnerUser.user_id, '+998900000007'), name: 'Demo Partner', weight: 40 },
];
for (let i = 0; i < 14; i++) {
  const phone = `+99890100${String(1000 + i).padStart(4, '0')}`;
  const name = `${FIRST[i % FIRST.length]} (DEMO hamkor)`;
  const uid = await userId(phone, name, ['customer', 'partner']);
  const code = `DEMOP${String(i + 1).padStart(2, '0')}`;
  const p = (await q(`INSERT INTO partners (user_id, code, display_name, status) VALUES ($1,$2,$3,'active') ON CONFLICT (user_id) DO UPDATE SET status='active' RETURNING id`, [uid, code, name]))[0];
  partners.push({ id: p.id, token: await mkSessionFor(uid, phone), name, weight: int(2, 9) });
}
const pickPartner = () => { const tot = partners.reduce((a, p) => a + p.weight, 0); let r = rnd() * tot; for (const p of partners) { r -= p.weight; if (r <= 0) return p; } return partners[0]!; };

// In-stock SKUs from the whole catalog (demo-* and the original seed products).
const skuPool = await q<{ sku_id: string; product_id: string; atp: number }>(`SELECT s.id AS sku_id, s.product_id, (sb.on_hand_sellable - sb.reserved - sb.safety_buffer) AS atp
  FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id JOIN products p ON p.id=s.product_id WHERE p.status='published' AND sb.on_hand_sellable - sb.reserved - sb.safety_buffer >= 4`);
const zone = (await q(`SELECT id, region_code FROM delivery_zones WHERE active ORDER BY region_code='TAS' DESC LIMIT 1`))[0];
const streams = new Map<string, string>(); // partner|product → code
async function streamCode(p: { id: string; token: string }, productId: string) {
  const k = `${p.id}|${productId}`;
  if (!streams.has(k)) streams.set(k, (await call('POST', '/partner/streams', { token: p.token, body: { product_id: productId, name: pickOne(['Telegram kanal', 'Instagram', 'Do‘stlar guruhi', 'TikTok', 'Asosiy oqim']) } })).json.code);
  return streams.get(k)!;
}

// Clicks without orders, so conversion numbers look real.
for (let i = 0; i < N_ORDERS * 2; i++) {
  const p = pickPartner(); const s = pickOne(skuPool);
  await call('POST', '/referrals/touch', { guest: randomUUID() + randomUUID(), body: { code: await streamCode(p, s.product_id) } });
}

// ---------- orders ----------
type Final = 'new' | 'callback' | 'accepted' | 'shipping' | 'delivered' | 'returned' | 'cancelled';
const stats: Record<string, number> = {};
console.log(`== orders: ${N_ORDERS}`);
async function opConfirm(orderId: string) {
  await call('POST', `/ops/orders/${orderId}/claim`, { token: S.operator.token, ok: [409] });
  const o = (await q(`SELECT payable_minor::text, version, address_snapshot->>'quick' AS quick FROM orders WHERE id=$1`, [orderId]))[0];
  if (o.quick === 'true') await call('PATCH', `/ops/orders/${orderId}/address`, { token: S.operator.token, body: { expected_version: o.version, address: { district: pickOne(DISTRICTS), street: pickOne(STREETS), house: String(int(1, 120)) }, reason: 'Mijoz telefonda aytdi' } });
  const pay = (await q(`SELECT payable_minor::text AS p FROM orders WHERE id=$1`, [orderId]))[0].p;
  await call('POST', `/ops/orders/${orderId}/calls`, { token: S.operator.token, body: { outcome: 'confirmed', confirmed_total_minor: pay, note: 'Mijoz tasdiqladi (DEMO)' } });
}
async function ship(orderId: string) {
  await call('POST', `/ops/orders/${orderId}/pick`, { token: S.warehouse.token });
  await call('POST', `/ops/orders/${orderId}/pack`, { token: S.warehouse.token });
  await call('POST', `/ops/orders/${orderId}/ship`, { token: S.warehouse.token, body: { courier_user_id: S.courier.id, tracking_id: `DEMO-${int(10000, 99999)}` } });
}
const deliveredToSettle: string[] = [];
const created: { id: string; final: Final; partnerOrder: boolean }[] = [];

for (let i = 0; i < N_ORDERS; i++) {
  const channel = weighted({ referral: 38, assisted: 22, quick: 8, web: 32 });
  const final: Final = weighted({ new: 9, callback: 5, accepted: 9, shipping: 11, delivered: 46, returned: 7, cancelled: 13 });
  const s = pickOne(skuPool);
  const qty = rnd() < 0.8 ? 1 : 2;
  const name = `${pickOne(FIRST)} ${pickOne(['A.', 'B.', 'D.', 'K.', 'M.', 'N.', 'R.', 'S.', 'T.', 'U.'])}`;
  const phone = fakePhone();
  const addr = { region_code: zone.region_code, district: pickOne(DISTRICTS), street: pickOne(STREETS), house: String(int(1, 150)) };
  let orderId: string;
  let needsOperator = true;
  try {
    if (channel === 'assisted') {
      const p = rnd() < 0.6 ? partners[0]! : pickPartner();
      const d = await call('POST', '/partner/drafts', { token: p.token, body: { lines: [{ sku_id: s.sku_id, qty }], customer_name: name, customer_phone: phone, delivery_zone_id: zone.id, address: { district: addr.district, street: addr.street, house: addr.house }, contact_time: rnd() < 0.5 ? pickOne(['Kechqurun 18:00 dan keyin', 'Ertalab', 'Tushdan keyin']) : null } });
      const sub = await call('POST', `/partner/drafts/${d.json.id}/submit`, { token: p.token });
      orderId = sub.json.order_id;
      if (final === 'new' && rnd() < 0.6) { created.push({ id: orderId, final, partnerOrder: true }); stats['assisted:sms_pending'] = (stats['assisted:sms_pending'] ?? 0) + 1; continue; }
      if (!sub.json.dev_customer_link_token) throw new Error('no dev confirmation echo (is OTP dev echo off?)');
      const decision = final === 'cancelled' && rnd() < 0.5 ? 'reject' : 'confirm';
      await call('POST', `/confirm/${sub.json.dev_customer_link_token}`, { body: { decision, code: sub.json.dev_customer_code } });
      if (decision === 'reject') { created.push({ id: orderId, final, partnerOrder: true }); stats['cancelled'] = (stats['cancelled'] ?? 0) + 1; continue; }
      needsOperator = (await q(`SELECT commercial_status FROM orders WHERE id=$1`, [orderId]))[0].commercial_status === 'awaiting_confirmation';
    } else if (channel === 'quick') {
      const g = randomUUID() + randomUUID();
      const r = await call('POST', '/checkout/quick-order', { guest: g, idem: randomUUID(), body: { sku_id: s.sku_id, qty, name, phone, delivery_zone_id: zone.id, accept_terms: true } });
      orderId = r.json.order_id;
    } else {
      const g = randomUUID() + randomUUID();
      if (channel === 'referral') await call('POST', '/referrals/touch', { guest: g, body: { code: await streamCode(pickPartner(), s.product_id) } });
      await call('PUT', '/cart/lines', { guest: g, body: { sku_id: s.sku_id, qty } });
      const qt = await call('POST', '/checkout/quotes', { guest: g, body: { delivery_zone_id: zone.id, address: addr, contact: { name, phone } } });
      const c = await call('POST', '/checkout/confirmations', { guest: g, idem: randomUUID(), body: { quote_id: qt.json.quote_id, quote_hash: qt.json.quote_hash, payment_method: 'cod', accept_terms: true } });
      orderId = c.json.order_id;
    }

    // Drive the order to its final state through the operator / warehouse / courier screens' own endpoints.
    if (final === 'new') { /* waits in the operator's "Yangi" queue */ }
    else if (final === 'callback') {
      await call('POST', `/ops/orders/${orderId}/claim`, { token: S.operator.token, ok: [409] });
      await call('POST', `/ops/orders/${orderId}/calls`, { token: S.operator.token, body: { outcome: rnd() < 0.5 ? 'call_later' : 'no_answer', note: 'Mijoz keyinroq qo‘ng‘iroq qilishni so‘radi', callback_at: new Date(Date.now() + int(1, 20) * 3600_000).toISOString() } });
    } else if (final === 'cancelled') {
      if (rnd() < 0.5) {
        await call('POST', `/ops/orders/${orderId}/claim`, { token: S.operator.token, ok: [409] });
        await call('POST', `/ops/orders/${orderId}/calls`, { token: S.operator.token, body: { outcome: 'rejected', note: 'Mijoz fikridan qaytdi' } });
      } else await call('POST', `/ops/orders/${orderId}/cancel`, { token: S.operator.token, body: { reason: pickOne(['customer_request', 'no_contact', 'duplicate'] as const), note: 'DEMO' } });
    } else {
      if (needsOperator) await opConfirm(orderId);
      if (final !== 'accepted') {
        await ship(orderId);
        if (final === 'returned') await call('POST', `/courier/orders/${orderId}/fail`, { token: S.courier.token, body: { reason: pickOne(['Mijoz telefonni ko‘tarmadi', 'Mijoz rad etdi', 'Manzil noto‘g‘ri']), return_to_warehouse: true } });
        else if (final === 'delivered') {
          await call('POST', `/courier/orders/${orderId}/deliver`, { token: S.courier.token, body: { proof: { method: 'otp', value: String(int(1000, 9999)) } } });
          deliveredToSettle.push(orderId);
        }
      }
    }
    created.push({ id: orderId, final, partnerOrder: channel !== 'web' && channel !== 'quick' });
    stats[final] = (stats[final] ?? 0) + 1;
  } catch (e) {
    stats.errors = (stats.errors ?? 0) + 1;
    if ((stats.errors ?? 0) <= 5) console.warn('  skip:', (e as Error).message);
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${N_ORDERS}`);
}

// COD: courier hands cash in batches; finance confirms (most). A few stay "with courier" → "pul tushumi solishtirilmoqda".
console.log('== COD remittances');
const settle = deliveredToSettle.filter(() => rnd() < 0.88);
for (let i = 0; i < settle.length; i += 8) {
  const batch = settle.slice(i, i + 8);
  const sum = (await q(`SELECT COALESCE(SUM(payable_minor),0)::text AS s FROM orders WHERE id = ANY($1::uuid[])`, [batch]))[0].s;
  const rem = await call('POST', '/courier/remittances', { token: S.courier.token, body: { order_ids: batch, declared_minor: sum } });
  await call('POST', `/finance/remittances/${rem.json.remittance_id}/confirm`, { token: S.finance.token, body: { received_minor: sum } });
}

// Spread history over the last ~60 days (recent states stay recent) so periods, charts and "kun admini" look alive.
console.log('== backdating history');
const span: Record<Final, [number, number]> = { new: [0, 1], callback: [0, 2], accepted: [0, 3], shipping: [1, 5], delivered: [3, 60], returned: [2, 45], cancelled: [1, 50] };
for (const o of created) {
  const [a, b] = span[o.final];
  const mins = Math.round((a + rnd() * (b - a)) * 1440) + int(0, 600);
  const iv = `${mins} minutes`;
  await withTx(db, async (tx) => {
    await tx.query(`UPDATE orders SET created_at=created_at - $2::interval, updated_at=updated_at - $2::interval, delivered_at=delivered_at - $2::interval WHERE id=$1`, [o.id, iv]);
    await tx.query(`UPDATE order_status_events SET created_at=created_at - $2::interval WHERE order_id=$1`, [o.id, iv]);
    await tx.query(`UPDATE commission_accruals SET created_at=created_at - $2::interval, pending_at=pending_at - $2::interval, available_after=available_after - $2::interval WHERE order_id=$1`, [o.id, iv]);
    await tx.query(`UPDATE referral_touches SET touched_at=touched_at - $2::interval WHERE id::text = (SELECT attribution->>'touch_id' FROM orders WHERE id=$1)`, [o.id, iv]).catch(() => {});
    await tx.query(`UPDATE call_logs SET created_at=created_at - $2::interval WHERE order_id=$1`, [o.id, iv]).catch(() => {});
  });
}
await q(`UPDATE referral_touches t SET touched_at = touched_at - make_interval(mins => (abs(hashtext(t.id::text)) % 86400)) WHERE t.touched_at > now() - interval '1 hour'`).catch(() => {});

// Older delivered orders have passed the return hold → "Yechish mumkin".
const released = await withTx(db, (tx) => releaseMatured(tx, new Date()));
console.log(`  released to available: ${released}`);

// ---------- DEMO777: payouts history, open drafts, a fill link, a dispute ----------
console.log('== Demo Partner extras');
const P0 = partners[0]!;
await call('PUT', '/partner/payout-destination', { token: P0.token, body: { type: 'card', holder: 'DEMO PARTNER', number: '8600000000000000' } });
await call('POST', `/admin/partners/${P0.id}/verify-destination`, { token: S.finance.token });
const avail = BigInt((await q(`SELECT available_minor::text AS a FROM partner_balances WHERE partner_id=$1`, [P0.id]))[0]?.a ?? '0');
if (avail > 0n) {
  const paid = (avail * 45n) / 100n / 100000n * 100000n;
  if (paid > 0n) {
    const pr = await call('POST', '/partner/payouts', { token: P0.token, idem: randomUUID(), body: { amount_minor: paid.toString() } });
    await call('POST', `/admin/payouts/${pr.json.payout_id}/prepare`, { token: S.finance.token });
    await call('POST', `/admin/payouts/${pr.json.payout_id}/approve`, { token: S.finance2.token });
    await call('POST', `/admin/payouts/${pr.json.payout_id}/result`, { token: S.finance2.token, body: { outcome: 'paid', reference: 'DEMO-BANK-0001', evidence: 'DEMO bank statement' } });
  }
  const req = (avail * 15n) / 100n / 100000n * 100000n;
  if (req > 0n) await call('POST', '/partner/payouts', { token: P0.token, idem: randomUUID(), body: { amount_minor: req.toString() } }); // waits in the finance queue
}
const sp = () => pickOne(skuPool).sku_id;
await call('POST', '/partner/drafts', { token: P0.token, body: { lines: [{ sku_id: sp(), qty: 1 }], customer_name: 'Sardor', customer_phone: fakePhone(), address_later: true, contact_time: 'Kechqurun 18:00 dan keyin' } });
await call('POST', '/partner/drafts', { token: P0.token, body: { lines: [{ sku_id: sp(), qty: 2 }], customer_phone: fakePhone(), note: 'Mijoz ismini keyin aytadi' } });
const linkDraft = await call('POST', '/partner/drafts', { token: P0.token, body: { lines: [{ sku_id: sp(), qty: 1 }] } });
await call('POST', `/partner/drafts/${linkDraft.json.id}/share`, { token: P0.token, body: { hours: 72 } });
const someOrder = created.find((o) => o.final === 'delivered' && o.partnerOrder);
if (someOrder) {
  const own = (await q(`SELECT attributed_partner_id FROM orders WHERE id=$1`, [someOrder.id]))[0];
  const owner = partners.find((p) => p.id === own?.attributed_partner_id);
  if (owner) await call('POST', '/partner/disputes', { token: owner.token, body: { order_id: someOrder.id, subject: 'Komissiya miqdori', body: 'Ikki dona edi, komissiya bittaga hisoblanganga o‘xshaydi — tekshirib bering (DEMO).' } });
}

// Script sessions are not needed after the run.
await q(`DELETE FROM sessions WHERE expires_at <= now() + interval '2 hours' AND created_at > now() - interval '3 hours' AND user_id IN (SELECT id FROM users WHERE phone_e164 LIKE '+99890%')`).catch(() => {});

const bal = (await q(`SELECT estimated_minor::text e, pending_minor::text p, available_minor::text a, paid_minor::text pd FROM partner_balances WHERE partner_id=$1`, [P0.id]))[0];
console.log('== done', JSON.stringify(stats));
console.log(`   products: ${(await q(`SELECT COUNT(*)::int n FROM products WHERE status='published'`))[0].n}, orders: ${(await q(`SELECT COUNT(*)::int n FROM orders`))[0].n}`);
console.log(`   Demo Partner (DEMO777) balances (tiyin): ${JSON.stringify(bal)}`);
await app.close();
await db.end();
