import { normalizeSearch } from '@om/shared';
import { loadConfig } from './config.js';
import { bootstrapReference } from './platform/bootstrap.js';
import { createPool, withTx } from './platform/db.js';
import { migrate, MIGRATIONS_DIR } from './platform/migrate.js';

/** Synthetic demo data only (no real customers). Refuses to run in production (T097). */
const cfg = loadConfig();
if (cfg.env === 'production') {
  console.error('seed refused: NODE_ENV=production');
  process.exit(1);
}
const db = createPool(cfg.databaseUrl, 2);
await migrate(db, MIGRATIONS_DIR, console.log);
await withTx(db, async (tx) => {
  await bootstrapReference(tx);
  const users: [string, string, string[]][] = [
    ['+998900000001', 'Demo Owner', ['owner', 'customer']],
    ['+998900000002', 'Demo Operator', ['operator', 'customer']],
    ['+998900000003', 'Demo Warehouse', ['warehouse', 'customer']],
    ['+998900000004', 'Demo Courier', ['courier', 'customer']],
    ['+998900000005', 'Demo Finance', ['finance', 'customer']],
    ['+998900000006', 'Demo Catalog', ['catalog_manager', 'customer']],
    ['+998900000007', 'Demo Partner', ['customer']],
    ['+998900000008', 'Demo Customer', ['customer']],
  ];
  for (const [phone, name, roles] of users) {
    const u = await tx.query(`INSERT INTO users (phone_e164, phone_verified_at, display_name) VALUES ($1, now(), $2) ON CONFLICT DO NOTHING RETURNING id`, [phone, name]);
    const id = u.rows[0]?.id ?? (await tx.query(`SELECT id FROM users WHERE phone_e164=$1`, [phone])).rows[0].id;
    for (const r of roles) await tx.query(`INSERT INTO memberships (user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, r]);
  }
  const partnerUser = (await tx.query(`SELECT id FROM users WHERE phone_e164='+998900000007'`)).rows[0].id;
  const doc = (await tx.query(`SELECT id FROM legal_document_versions WHERE doc_type='partner' AND version=1`)).rows[0].id;
  const acc = (await tx.query(`INSERT INTO acceptances (user_id, legal_document_version_id, context) VALUES ($1,$2,'partner_signup') RETURNING id`, [partnerUser, doc])).rows[0].id;
  await tx.query(`INSERT INTO partners (user_id, code, display_name, status, agreement_acceptance_id) VALUES ($1,'DEMO777','Demo Partner','active',$2) ON CONFLICT DO NOTHING`, [partnerUser, acc]);
  await tx.query(`INSERT INTO memberships (user_id, role_code) VALUES ($1,'partner') ON CONFLICT DO NOTHING`, [partnerUser]);

  const org = (await tx.query(`SELECT id FROM organizations WHERE kind='platform_owner'`)).rows[0].id;
  const wh = (await tx.query(`SELECT id FROM warehouses WHERE code='MAIN'`)).rows[0].id;
  const cat = async (slug: string, latn: string, cyrl: string, parent: string | null = null) =>
    (await tx.query(`INSERT INTO categories (slug, name, parent_id) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [slug, JSON.stringify({ 'uz-Latn': latn, 'uz-Cyrl': cyrl }), parent])).rows[0].id as string;
  const elec = await cat('elektronika', 'Elektronika', 'Электроника');
  const audio = await cat('quloqchinlar', 'Quloqchinlar', 'Қулоқчинлар', elec);
  const home = await cat('uy-rozgor', "Uy-ro'zg'or", 'Уй-рўзғор');
  const products: { slug: string; latn: string; cyrl: string; cat: string; brand: string; skus: { code: string; variant: Record<string, string>; price: number; cost: number; stock: number }[]; rule: { kind: string; bps?: number; fixed?: number } }[] = [
    { slug: 'simsiz-quloqchin-x1', latn: 'Simsiz quloqchin X1', cyrl: 'Симсиз қулоқчин X1', cat: audio, brand: 'DemoSound', skus: [{ code: 'X1-BLK', variant: { rang: 'qora' }, price: 100_000, cost: 55_000, stock: 25 }, { code: 'X1-WHT', variant: { rang: 'oq' }, price: 100_000, cost: 55_000, stock: 1 }], rule: { kind: 'fixed_per_unit', fixed: 30_000 } },
    { slug: 'aqlli-soat-s2', latn: 'Aqlli soat S2', cyrl: 'Ақлли соат S2', cat: elec, brand: 'DemoTime', skus: [{ code: 'S2-128', variant: { xotira: '128 GB' }, price: 450_000, cost: 300_000, stock: 10 }, { code: 'S2-256', variant: { xotira: '256 GB' }, price: 520_000, cost: 340_000, stock: 5 }], rule: { kind: 'percent', bps: 1000 } },
    { slug: 'elektr-choynak-k5', latn: 'Elektr choynak K5', cyrl: 'Электр чойнак K5', cat: home, brand: 'DemoHome', skus: [{ code: 'K5-STD', variant: {}, price: 180_000, cost: 0, stock: 40 }], rule: { kind: 'percent', bps: 3000 } },
  ];
  for (const p of products) {
    const brand = (await tx.query(`INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [p.brand.toLowerCase(), p.brand])).rows[0].id;
    const ex = (await tx.query(`SELECT id FROM products WHERE slug=$1`, [p.slug])).rows[0];
    if (ex) continue;
    const name = { 'uz-Latn': p.latn, 'uz-Cyrl': p.cyrl };
    const desc = { 'uz-Latn': `${p.latn} — DEMO mahsulot tavsifi.`, 'uz-Cyrl': `${p.cyrl} — DEMO маҳсулот тавсифи.` };
    const prod = (await tx.query(`INSERT INTO products (owner_org_id, category_id, brand_id, slug, name, description, status, search_doc, published_at, warranty_months) VALUES ($1,$2,$3,$4,$5,$6,'published',$7, now(), 12) RETURNING id`,
      [org, p.cat, brand, p.slug, JSON.stringify(name), JSON.stringify(desc), normalizeSearch([p.latn, p.cyrl, p.brand, ...p.skus.map((s) => s.code), ...p.skus.flatMap((s) => Object.values(s.variant))].join(' '))])).rows[0].id;
    for (const s of p.skus) {
      const sku = (await tx.query(`INSERT INTO skus (product_id, sku_code, variant, variant_key, cost_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [prod, s.code, JSON.stringify(s.variant), Object.entries(s.variant).map(([k, v]) => `${k}=${v}`).join('|') || 'default', s.cost ? s.cost * 100 : null])).rows[0].id;
      const offer = (await tx.query(`INSERT INTO offers (sku_id, merchant_org_id, price_minor) VALUES ($1,$2,$3) RETURNING id`, [sku, org, s.price * 100])).rows[0].id;
      await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, reason) VALUES ($1,1,$2,'seed')`, [offer, s.price * 100]);
      await tx.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id, on_hand_sellable) VALUES ($1,$2,$3,$4)`, [sku, org, wh, s.stock]);
      await tx.query(`INSERT INTO inventory_movements (sku_id, merchant_org_id, warehouse_id, kind, bucket, qty_delta, ref_type, ref_id, reason) VALUES ($1,$2,$3,'receipt','on_hand_sellable',$4,'seed',$5,'demo seed')`, [sku, org, wh, s.stock, s.code]);
    }
    await tx.query(`INSERT INTO commission_rules (product_id, version, kind, rate_bps, fixed_minor, effective_from) VALUES ($1,1,$2,$3,$4, now() - interval '1 day')`, [prod, p.rule.kind, p.rule.bps ?? null, p.rule.fixed ? p.rule.fixed * 100 : null]);
  }
});
console.log('seed done (synthetic DEMO data). Login: phone +99890000000{1..8}, OTP shown in dev response.');
await db.end();
