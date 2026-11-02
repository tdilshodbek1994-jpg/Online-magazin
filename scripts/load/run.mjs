// T095 load run: 100 parallel browser-like sessions (catalog/search/product) + 10 parallel checkout loops.
// Usage: API_URL=http://localhost:4000 DURATION_S=60 node scripts/load/run.mjs
import { randomUUID } from 'node:crypto';
const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api/v1';
const DURATION = Number(process.env.DURATION_S ?? 60) * 1000;
const THINK_MS = Number(process.env.THINK_MS ?? 0); // per-session pause between page views (0 = closed loop)
const lat = { read: [], checkout: [] };
let errors = { read: 0, checkout: 0 }, ok = { read: 0, checkout: 0 }, conflicts = 0;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1) : 'n/a'; };
async function timed(kind, fn) { const t = performance.now(); try { const r = await fn(); lat[kind].push(performance.now() - t); return r; } catch (e) { errors[kind]++; return null; } }
async function j(url, opts = {}) { const r = await fetch(API + url, opts); const b = await r.json().catch(() => ({})); if (r.status >= 500) throw new Error(String(r.status)); return { status: r.status, body: b }; }
const end = Date.now() + DURATION;
const zone = (await j('/delivery-zones')).body.items[0].id;
async function browser() {
  const g = randomUUID() + randomUUID();
  const h = { 'x-guest-token': g };
  while (Date.now() < end) {
    const n = 1 + Math.floor(Math.random() * 10000);
    const which = Math.random();
    const r = await timed('read', () => which < 0.4 ? j(`/products?limit=24&offset=${Math.floor(Math.random() * 500)}`, { headers: h }) : which < 0.7 ? j(`/products?q=yuklama%20${n}`, { headers: h }) : j(`/products/load-${n}`, { headers: h }));
    if (r) ok.read++;
    if (THINK_MS) await new Promise((res) => setTimeout(res, THINK_MS * (0.5 + Math.random())));
  }
}
async function checkout() {
  while (Date.now() < end) {
    const g = randomUUID() + randomUUID();
    const h = { 'x-guest-token': g, 'content-type': 'application/json' };
    const n = 1 + Math.floor(Math.random() * 10000);
    const r = await timed('checkout', async () => {
      const p = await j(`/products/load-${n}`, { headers: h });
      await j('/cart/lines', { method: 'PUT', headers: h, body: JSON.stringify({ sku_id: p.body.variants[0].sku_id, qty: 1 }) });
      const q = await j('/checkout/quotes', { method: 'POST', headers: h, body: JSON.stringify({ delivery_zone_id: zone, address: { region_code: 'TAS', district: 'X', street: 'Y', house: '1' }, contact: { name: 'Load', phone: '+99890' + String(1000000 + n).slice(-7) } }) });
      const c = await j('/checkout/confirmations', { method: 'POST', headers: { ...h, 'idempotency-key': randomUUID() }, body: JSON.stringify({ quote_id: q.body.quote_id, quote_hash: q.body.quote_hash, payment_method: 'cod', accept_terms: true }) });
      if (c.status === 409) conflicts++;
      if (c.status !== 201 && c.status !== 409) throw new Error('checkout ' + c.status);
      return c;
    });
    if (r) ok.checkout++;
  }
}
const t0 = Date.now();
await Promise.all([...Array.from({ length: 100 }, browser), ...Array.from({ length: 10 }, checkout)]);
const secs = (Date.now() - t0) / 1000;
const report = {
  duration_s: secs, read: { ok: ok.read, errors: errors.read, rps: (ok.read / secs).toFixed(1), p50_ms: pct(lat.read, 50), p95_ms: pct(lat.read, 95), p99_ms: pct(lat.read, 99) },
  checkout_flow_4_requests: { ok: ok.checkout, errors: errors.checkout, expected_conflicts: conflicts, per_s: (ok.checkout / secs).toFixed(2), p50_ms: pct(lat.checkout, 50), p95_ms: pct(lat.checkout, 95), p99_ms: pct(lat.checkout, 99) },
};
console.log(JSON.stringify(report, null, 2));
