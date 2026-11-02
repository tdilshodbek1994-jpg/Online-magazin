import { normalizeSearch } from '@om/shared';
import sharp from 'sharp';
import { type ArtKind, PALETTES, productSvg } from './demo/art.js';
import { saveProductImage } from './modules/catalog/media.js';
import { saveProductVideo } from './modules/catalog/videos.js';
import { readFile } from 'node:fs/promises';
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
  const cat = async (slug: string, latn: string, cyrl: string, parent: string | null = null, sort = 0) =>
    (await tx.query(`INSERT INTO categories (slug, name, parent_id, sort) VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, sort=EXCLUDED.sort RETURNING id`, [slug, JSON.stringify({ 'uz-Latn': latn, 'uz-Cyrl': cyrl }), parent, sort])).rows[0].id as string;
  const elec = await cat('elektronika', 'Elektronika', 'Электроника', null, 1);
  const phones = await cat('smartfonlar', 'Smartfonlar', 'Смартфонлар', elec, 2);
  const audio = await cat('quloqchinlar', 'Quloqchinlar', 'Қулоқчинлар', elec, 3);
  const laptops = await cat('noutbuklar', 'Noutbuklar', 'Ноутбуклар', elec, 4);
  const home = await cat('uy-rozgor', "Uy-ro'zg'or", 'Уй-рўзғор', null, 5);
  const kitchen = await cat('oshxona', 'Oshxona', 'Ошхона', home, 6);
  const fashion = await cat('kiyim-poyabzal', "Kiyim va poyabzal", 'Кийим ва пойабзал', null, 7);
  const beauty = await cat('gozallik', "Go'zallik", 'Гўзаллик', null, 8);
  const sport = await cat('sport', 'Sport va dam olish', 'Спорт ва дам олиш', null, 9);
  type Sku = { code: string; variant: Record<string, string>; price: number; was?: number; cost: number; stock: number };
  // Prices, stock and commission rules below are DEMO fixtures only — real values are set by the owner (is_demo).
  const products: { slug: string; latn: string; cyrl: string; cat: string; brand: string; art: ArtKind; pal: string; about: string; skus: Sku[]; rule: { kind: string; bps?: number; fixed?: number } }[] = [
    { slug: 'simsiz-quloqchin-x1', latn: 'Simsiz quloqchin X1', cyrl: 'Симсиз қулоқчин X1', cat: audio, brand: 'DemoSound', art: 'headphones', pal: 'mint', about: "Bluetooth 5.3, 30 soatgacha ishlash, shovqinni pasaytirish.", skus: [{ code: 'X1-BLK', variant: { rang: 'qora' }, price: 100_000, was: 129_000, cost: 55_000, stock: 25 }, { code: 'X1-WHT', variant: { rang: 'oq' }, price: 100_000, cost: 55_000, stock: 1 }], rule: { kind: 'fixed_per_unit', fixed: 30_000 } },
    { slug: 'aqlli-soat-s2', latn: 'Aqlli soat S2', cyrl: 'Ақлли соат S2', cat: elec, brand: 'DemoTime', art: 'watch', pal: 'sky', about: "Yurak urishi, qadam va uyqu nazorati, suvga chidamli.", skus: [{ code: 'S2-128', variant: { xotira: '128 GB' }, price: 450_000, cost: 300_000, stock: 10 }, { code: 'S2-256', variant: { xotira: '256 GB' }, price: 520_000, cost: 340_000, stock: 5 }], rule: { kind: 'percent', bps: 1000 } },
    { slug: 'elektr-choynak-k5', latn: 'Elektr choynak K5', cyrl: 'Электр чойнак K5', cat: home, brand: 'DemoHome', art: 'kettle', pal: 'peach', about: "1,7 litr, 2200 W, avtomatik o'chish, zanglamas po'lat.", skus: [{ code: 'K5-STD', variant: {}, price: 180_000, cost: 0, stock: 40 }], rule: { kind: 'percent', bps: 3000 } },
    { slug: 'smartfon-nova-12', latn: 'Smartfon Nova 12', cyrl: 'Смартфон Nova 12', cat: phones, brand: 'DemoMobile', art: 'phone', pal: 'lilac', about: '6,7" AMOLED ekran, 50 MP kamera, 5000 mAh batareya.', skus: [{ code: 'N12-128', variant: { xotira: '128 GB' }, price: 2_490_000, was: 2_790_000, cost: 0, stock: 15 }, { code: 'N12-256', variant: { xotira: '256 GB' }, price: 2_890_000, cost: 0, stock: 8 }], rule: { kind: 'percent', bps: 500 } },
    { slug: 'tws-quloqchin-buds-air', latn: 'TWS quloqchin Buds Air', cyrl: 'TWS қулоқчин Buds Air', cat: audio, brand: 'DemoSound', art: 'earbuds', pal: 'rose', about: "Ixcham g'ilof, 24 soat zaryad, sensorli boshqaruv.", skus: [{ code: 'BA-STD', variant: {}, price: 249_000, was: 299_000, cost: 0, stock: 30 }], rule: { kind: 'percent', bps: 1000 } },
    { slug: 'portativ-kolonka-boom', latn: 'Portativ kolonka Boom', cyrl: 'Портатив колонка Boom', cat: audio, brand: 'DemoSound', art: 'speaker', pal: 'sand', about: "20 W kuchli ovoz, IPX6 suvdan himoya, 12 soat.", skus: [{ code: 'BOOM-20', variant: {}, price: 390_000, cost: 0, stock: 12 }], rule: { kind: 'percent', bps: 1000 } },
    { slug: 'noutbuk-airbook-14', latn: 'Noutbuk AirBook 14', cyrl: 'Ноутбук AirBook 14', cat: laptops, brand: 'DemoTech', art: 'laptop', pal: 'slate', about: '14" IPS ekran, 16 GB RAM, 512 GB SSD, 1,3 kg.', skus: [{ code: 'AB14-512', variant: { xotira: '512 GB' }, price: 6_900_000, cost: 0, stock: 4 }], rule: { kind: 'percent', bps: 300 } },
    { slug: 'blender-mix-pro', latn: 'Blender Mix Pro', cyrl: 'Блендер Mix Pro', cat: kitchen, brand: 'DemoHome', art: 'blender', pal: 'white', about: "1,5 litrli idish, 1000 W, 5 tezlik, muz maydalash.", skus: [{ code: 'MIX-PRO', variant: {}, price: 520_000, was: 610_000, cost: 0, stock: 9 }], rule: { kind: 'percent', bps: 1000 } },
    { slug: 'termos-shisha-750', latn: 'Termos shisha 750 ml', cyrl: 'Термос шиша 750 мл', cat: sport, brand: 'DemoHome', art: 'bottle', pal: 'mint', about: "Issiqni 12, sovuqni 24 soat saqlaydi.", skus: [{ code: 'TS-750', variant: {}, price: 89_000, cost: 0, stock: 60 }], rule: { kind: 'percent', bps: 1500 } },
    { slug: 'stol-chirogi-led', latn: "Stol chirog'i LED", cyrl: 'Стол чироғи LED', cat: home, brand: 'DemoHome', art: 'lamp', pal: 'sky', about: "3 xil yorug'lik rejimi, ko'zni charchatmaydi.", skus: [{ code: 'LED-DL', variant: {}, price: 145_000, cost: 0, stock: 22 }], rule: { kind: 'percent', bps: 1500 } },
    { slug: 'shahar-ryukzagi', latn: 'Shahar ryukzagi', cyrl: 'Шаҳар рюкзаги', cat: fashion, brand: 'DemoStyle', art: 'backpack', pal: 'peach', about: '15,6" noutbuk bo\'limi, suv o\'tkazmaydigan mato.', skus: [{ code: 'BP-URB', variant: {}, price: 210_000, cost: 0, stock: 18 }], rule: { kind: 'percent', bps: 1500 } },
    { slug: 'krossovka-run-x', latn: 'Krossovka Run X', cyrl: 'Кроссовка Run X', cat: fashion, brand: 'DemoStyle', art: 'sneaker', pal: 'lilac', about: "Yengil, nafas oladigan, yugurish uchun.", skus: [{ code: 'RUNX-41', variant: { "o'lcham": '41' }, price: 459_000, was: 520_000, cost: 0, stock: 6 }, { code: 'RUNX-42', variant: { "o'lcham": '42' }, price: 459_000, cost: 0, stock: 7 }, { code: 'RUNX-43', variant: { "o'lcham": '43' }, price: 459_000, cost: 0, stock: 3 }], rule: { kind: 'percent', bps: 1200 } },
    { slug: 'atir-oud-50', latn: 'Atir Oud 50 ml', cyrl: 'Атир Oud 50 мл', cat: beauty, brand: 'DemoBeauty', art: 'perfume', pal: 'rose', about: "Sharqona ud va vanil notalari, uzoq saqlanadi.", skus: [{ code: 'OUD-50', variant: {}, price: 320_000, cost: 0, stock: 14 }], rule: { kind: 'percent', bps: 2000 } },
    { slug: 'futbolka-basic', latn: 'Futbolka Basic', cyrl: 'Футболка Basic', cat: fashion, brand: 'DemoStyle', art: 'tshirt', pal: 'sand', about: "100% paxta, O'zbekistonda tikilgan.", skus: [{ code: 'TB-S', variant: { "o'lcham": 'S' }, price: 99_000, cost: 0, stock: 20 }, { code: 'TB-M', variant: { "o'lcham": 'M' }, price: 99_000, cost: 0, stock: 25 }, { code: 'TB-L', variant: { "o'lcham": 'L' }, price: 99_000, cost: 0, stock: 15 }], rule: { kind: 'percent', bps: 2000 } },
  ];
  for (const p of products) {
    const brand = (await tx.query(`INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [p.brand.toLowerCase(), p.brand])).rows[0].id;
    const ex = (await tx.query(`SELECT id FROM products WHERE slug=$1`, [p.slug])).rows[0];
    if (ex) continue;
    const name = { 'uz-Latn': p.latn, 'uz-Cyrl': p.cyrl };
    const desc = { 'uz-Latn': `${p.about}\n\n(DEMO mahsulot — narx va tavsif namuna.)`, 'uz-Cyrl': `${p.cyrl} — DEMO маҳсулот тавсифи.` };
    const prod = (await tx.query(`INSERT INTO products (owner_org_id, category_id, brand_id, slug, name, description, status, search_doc, published_at, warranty_months) VALUES ($1,$2,$3,$4,$5,$6,'published',$7, now(), 12) RETURNING id`,
      [org, p.cat, brand, p.slug, JSON.stringify(name), JSON.stringify(desc), normalizeSearch([p.latn, p.cyrl, p.brand, ...p.skus.map((s) => s.code), ...p.skus.flatMap((s) => Object.values(s.variant))].join(' '))])).rows[0].id;
    for (const s of p.skus) {
      const sku = (await tx.query(`INSERT INTO skus (product_id, sku_code, variant, variant_key, cost_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [prod, s.code, JSON.stringify(s.variant), Object.entries(s.variant).map(([k, v]) => `${k}=${v}`).join('|') || 'default', s.cost ? s.cost * 100 : null])).rows[0].id;
      const offer = (await tx.query(`INSERT INTO offers (sku_id, merchant_org_id, price_minor, compare_at_minor) VALUES ($1,$2,$3,$4) RETURNING id`, [sku, org, s.price * 100, s.was ? s.was * 100 : null])).rows[0].id;
      await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, reason) VALUES ($1,1,$2,'seed')`, [offer, s.price * 100]);
      await tx.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id, on_hand_sellable) VALUES ($1,$2,$3,$4)`, [sku, org, wh, s.stock]);
      await tx.query(`INSERT INTO inventory_movements (sku_id, merchant_org_id, warehouse_id, kind, bucket, qty_delta, ref_type, ref_id, reason) VALUES ($1,$2,$3,'receipt','on_hand_sellable',$4,'seed',$5,'demo seed')`, [sku, org, wh, s.stock, s.code]);
    }
    await tx.query(`INSERT INTO commission_rules (product_id, version, kind, rate_bps, fixed_minor, effective_from) VALUES ($1,1,$2,$3,$4, now() - interval '1 day')`, [prod, p.rule.kind, p.rule.bps ?? null, p.rule.fixed ? p.rule.fixed * 100 : null]);
  }
  // DEMO illustrations through the normal media pipeline; only for demo products that have no image yet (owner photos are never touched).
  for (const p of products) {
    const row = (await tx.query(`SELECT p.id FROM products p WHERE p.slug=$1 AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.product_id=p.id)`, [p.slug])).rows[0];
    if (!row) continue;
    const png = await sharp(Buffer.from(productSvg(p.art, PALETTES[p.pal] ?? PALETTES.mint!))).png().toBuffer();
    await saveProductImage(tx, cfg.mediaDir, row.id, png, { mime: 'image/png', width: 800, height: 800, filename: `${p.slug}.png`, alt: { 'uz-Latn': p.latn, 'uz-Cyrl': p.cyrl }, rights_source: 'DEMO illustration (generated)', sort: 0, uploadedBy: null });
  }
  // DEMO reels: short generated clips shipped in demo-assets/videos (only for products that have no video yet).
  const videoDir = new URL('../demo-assets/videos/', import.meta.url);
  for (const p of products) {
    const row = (await tx.query(`SELECT p.id FROM products p WHERE p.slug=$1 AND NOT EXISTS (SELECT 1 FROM product_videos v WHERE v.product_id=p.id)`, [p.slug])).rows[0];
    if (!row) continue;
    const mp4 = await readFile(new URL(`${p.slug}.mp4`, videoDir)).catch(() => null);
    if (!mp4) continue;
    const poster = await readFile(new URL(`${p.slug}.jpg`, videoDir)).catch(() => null);
    await saveProductVideo(tx, cfg.mediaDir, row.id, mp4, { caption: { 'uz-Latn': `${p.latn} — ${p.about}`, 'uz-Cyrl': p.cyrl }, rights_source: 'DEMO video (generated)', poster, uploadedBy: null });
  }
});
console.log('seed done (synthetic DEMO data). Login: phone +99890000000{1..8}, OTP shown in dev response.');
await db.end();
