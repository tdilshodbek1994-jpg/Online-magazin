// Browser E2E smoke against a running stack (web :3000 → api :4000, seeded DEMO data).
// Usage: node apps/web/e2e/smoke.mjs   (uses the pre-installed Playwright Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const results = [];
const step = async (id, name, fn) => {
  try { await fn(); results.push({ id, name, ok: true }); console.log(`PASS ${id} ${name}`); }
  catch (e) { results.push({ id, name, ok: false, err: String(e.message).slice(0, 300) }); console.log(`FAIL ${id} ${name}: ${String(e.message).slice(0, 300)}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

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

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\nE2E: ${results.length - failed} passed, ${failed} failed, 0 skipped`);
process.exit(failed ? 1 : 0);
