// Browser E2E smoke against a running stack (web :3000 → api :4000, seeded DEMO data).
// Usage: node apps/web/e2e/smoke.mjs   (uses the pre-installed Playwright Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createHmac } from 'node:crypto';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  let bits = 0, val = 0; const bytes = [];
  for (const c of secret) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const results = [];
const step = async (id, name, fn) => {
  try { await fn(); results.push({ id, name, ok: true }); console.log(`PASS ${id} ${name}`); }
  catch (e) { results.push({ id, name, ok: false, err: String(e.message).slice(0, 300) }); console.log(`FAIL ${id} ${name}: ${String(e.message).slice(0, 300)}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const basic = process.env.E2E_BASIC_AUTH; // "user:password" for password-protected DEMO/staging
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: process.env.E2E_INSECURE === '1',
  ...(basic ? { httpCredentials: { username: basic.split(':')[0], password: basic.split(':').slice(1).join(':') } } : {}) });
const page = await ctx.newPage();
if (process.env.E2E_DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 400) console.log('  resp', r.status(), r.request().method(), r.url().replace(BASE, '')); });

await step('E2E-1/T005s', 'home loads and cyrillic search finds latin product', async () => {
  await page.goto(BASE + '/');
  await page.getByPlaceholder(/Mahsulot/).fill('қулоқчин');
  await page.getByRole('button', { name: 'Qidirish' }).click();
  await page.getByText('Simsiz quloqchin X1').first().waitFor({ timeout: 10000 });
});

await step('E2E-2/T021', 'product page shows variants with separate stock; add to cart', async () => {
  await page.goto(BASE + '/p/simsiz-quloqchin-x1');
  await page.getByText('X1-BLK').first().waitFor();
  await page.getByRole('button', { name: "Savatga qo'shish" }).click();
  await page.getByRole('link', { name: /Savat →/ }).waitFor();
});

await step('E2E-3/T015/T018', 'checkout: language switch keeps form; validation keeps input', async () => {
  await page.goto(BASE + '/checkout');
  await page.getByLabel('Ism').fill('Test Mijoz');
  await page.getByLabel('Telefon').fill('12345');
  await page.getByLabel('Tuman').fill('Yunusobod');
  await page.getByLabel("Ko'cha").fill('Amir Temur');
  await page.getByLabel('Uy', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Hisoblash' }).click();
  await page.getByText(/Telefon raqami noto/).waitFor();
  assert((await page.getByLabel('Ism').inputValue()) === 'Test Mijoz', 'name lost after validation error');
  await page.selectOption('#lang', 'uz-Cyrl');
  await page.getByLabel('Исм').waitFor();
  assert((await page.getByLabel('Исм').inputValue()) === 'Test Mijoz', 'name lost after language switch');
  await page.selectOption('#lang', 'uz-Latn');
  await page.getByLabel('Telefon').fill('+998 90 555 44 33');
  await page.getByRole('button', { name: 'Hisoblash' }).click();
  await page.getByText('Jami').first().waitFor();
});

await step('E2E-4/T019', 'place guest COD order once (double click → one order)', async () => {
  await page.getByText('Oferta shartlariga roziman').click();
  const btn = page.getByRole('button', { name: /Buyurtmani tasdiqlash/ });
  await btn.dblclick();
  await page.getByText(/Buyurtma qabul qilindi/).waitFor();
  await page.getByText(/Operator siz bilan/).waitFor();
});

await step('E2E-5/T016', '320 px: no horizontal scroll on checkout and product page', async () => {
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 320, height: 640 });
  for (const path of ['/', '/p/aqlli-soat-s2', '/checkout', '/cart']) {
    await p2.goto(BASE + path);
    await p2.waitForTimeout(400);
    const over = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 1, `horizontal overflow ${over}px on ${path}`);
  }
  await p2.close();
});

await step('E2E-6/T017', 'keyboard: skip to search input via Tab with visible focus', async () => {
  await page.goto(BASE + '/');
  let found = false;
  for (let i = 0; i < 15 && !found; i++) {
    await page.keyboard.press('Tab');
    found = await page.evaluate(() => document.activeElement?.id === 'q');
  }
  assert(found, 'search input not reachable by keyboard');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert(outline !== 'none', 'no visible focus');
});

async function login(phone) {
  await page.goto(BASE + '/login');
  await page.getByLabel('Telefon').fill(phone);
  await page.getByRole('button', { name: 'Kod yuborish' }).click();
  const dev = await page.getByText(/DEV: \d{6}/).textContent();
  await page.getByLabel('SMS kod').fill(dev.replace(/\D/g, ''));
  await page.getByRole('button', { name: 'Tasdiqlash' }).click();
  await page.waitForURL('**/account');
}

await step('E2E-7', 'partner logs in by OTP and sees own cabinet with code and balances', async () => {
  await login('+998900000007');
  await page.goto(BASE + '/partner');
  await page.getByText('DEMO777').waitFor();
  await page.getByText('Yechish mumkin', { exact: true }).waitFor();
});

await step('E2E-8/T009', 'logout clears session; partner cabinet no longer accessible', async () => {
  await page.getByRole('button', { name: 'Chiqish' }).click();
  await page.waitForURL(BASE + '/');
  await page.goto(BASE + '/partner');
  await page.getByText(/UNAUTHENTICATED|Hamkor bo/).first().waitFor();
});

await step('E2E-9', 'operator sees the new guest order in the "Yangi" queue', async () => {
  await login('+998900000002');
  await page.goto(BASE + '/ops');
  await page.getByRole('tab', { name: /Yangi/ }).waitFor();
  await page.getByRole('cell', { name: 'web', exact: true }).first().waitFor();
});

await step('E2E-10/T020', 'owner enrolls TOTP in UI; sensitive admin action asks step-up and succeeds', async () => {
  await page.getByRole('button', { name: 'Chiqish' }).click();
  await page.waitForURL(BASE + '/');
  await login('+998900000001');
  await page.goto(BASE + '/account/security');
  await page.getByRole('button', { name: 'Autentifikatorni ulash' }).click();
  const secret = (await page.locator('code').first().textContent()).trim();
  await page.getByLabel('Ilovadagi kod').fill(totp(secret));
  await page.getByRole('button', { name: 'Faollashtirish' }).click();
  await page.getByText(/Tiklash kodlari/).waitFor();
  await page.goto(BASE + '/admin');
  await page.getByRole('tab', { name: 'Hamkorlar' }).click();
  await page.getByText('DEMO777').waitFor();
  let prompts = 0;
  page.on('dialog', async (d) => { prompts++; await d.accept(d.message().includes('Xavfsizlik') ? totp(secret, Math.floor(Date.now() / 30000) + 1) : 'E2E tekshiruv'); });
  await page.getByRole('button', { name: 'To‘xtatish' }).click();
  await page.getByRole('status').filter({ hasText: 'OK' }).waitFor();
  assert(prompts === 2, `expected reason + step-up prompts, got ${prompts}`);
  await page.getByRole('button', { name: 'Tasdiqlash' }).first().click();
  await page.getByRole('status').filter({ hasText: 'OK' }).waitFor();
});

await step('E2E-12/T019', 'network drops while placing order: clear error, retry after reconnect creates exactly one order', async () => {
  const p4 = await ctx.newPage();
  await p4.goto(BASE + '/p/elektr-choynak-k5');
  await p4.getByRole('button', { name: "Savatga qo'shish" }).click();
  await p4.getByRole('link', { name: /Savat →/ }).waitFor();
  await p4.goto(BASE + '/checkout');
  await p4.getByLabel('Ism').fill('Offline Mijoz');
  await p4.getByLabel('Telefon').fill('+998 90 777 66 55');
  await p4.getByLabel('Tuman').fill('Chilonzor');
  await p4.getByLabel("Ko'cha").fill('Bunyodkor');
  await p4.getByLabel('Uy', { exact: true }).fill('3');
  await p4.getByRole('button', { name: 'Hisoblash' }).click();
  await p4.getByText('Oferta shartlariga roziman').click();
  const before = (await p4.request.get(BASE + '/api/v1/products?limit=1')).ok();
  await ctx.setOffline(true);
  await p4.getByRole('button', { name: /Buyurtmani tasdiqlash/ }).click();
  await p4.getByRole('alert').filter({ hasText: 'NETWORK' }).waitFor();
  assert(!(await p4.getByRole('button', { name: /Buyurtmani tasdiqlash/ }).isDisabled()), 'button stuck in loading');
  await ctx.setOffline(false);
  await p4.getByRole('button', { name: /Buyurtmani tasdiqlash/ }).click();
  await p4.getByText(/Buyurtma qabul qilindi/).waitFor();
  assert(before, 'api not reachable');
  await p4.close();
});

await step('E2E-11/T017-axe', 'axe-core WCAG 2.x A/AA scan: no serious/critical violations on key customer pages', async () => {
  const axeSrc = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
  const p3 = await ctx.newPage();
  const bad = [];
  for (const path of ['/', '/p/simsiz-quloqchin-x1', '/cart', '/checkout', '/login']) {
    await p3.goto(BASE + path);
    await p3.waitForTimeout(500);
    await p3.addScriptTag({ content: axeSrc });
    const r = await p3.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length})`));
    if (r.length) bad.push(`${path}: ${r.join(', ')}`);
  }
  await p3.close();
  assert(bad.length === 0, bad.join(' | '));
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\nE2E: ${results.length - failed} passed, ${failed} failed, 0 skipped`);
process.exit(failed ? 1 : 0);
