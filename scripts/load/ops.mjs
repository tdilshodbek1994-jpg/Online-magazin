// Operator Centre load run (spec §32): N parallel operators work the queue (first screen, take next, record a result)
// against a DB prepared with scripts/load/prepare.sql (100 000 historical orders) + ops-prepare.sql (open tasks).
// Measures p50/p95 per call and checks the safety invariant: a task is never held by two operators at once.
// Usage: API_URL=http://localhost:4000 DATABASE_URL=... OPERATORS=30 DURATION_S=60 node scripts/load/ops.mjs
// Disposable DB only. Requires OTP_DEV_ECHO (dev codes) on the API.
import { createRequire } from 'node:module';
const pg = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api/v1';
const N = Number(process.env.OPERATORS ?? 30);
const DURATION = Number(process.env.DURATION_S ?? 60) * 1000;
const db = new pg.Client(process.env.DATABASE_URL); await db.connect();
const lat = { center: [], next: [], contact: [] };
let errors = 0, conflicts = 0, empty = 0, done = 0;
const holder = new Map(); // task_id -> operator index (while held)
let violations = 0;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(0) : 'n/a'; };
async function j(url, opts = {}, tok) {
  const t = performance.now();
  const r = await fetch(API + url, { ...opts, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(opts.headers ?? {}) } });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, body: b, ms: performance.now() - t };
}
// Operators: synthetic users with the operator role (load-only phones).
const tokens = [];
for (let i = 0; i < N; i++) {
  const phone = '+99877' + String(1000000 + i);
  const u = (await db.query(`SELECT id FROM users WHERE phone_e164=$1 AND status <> 'closed'`, [phone])).rows[0]
    ?? (await db.query(`INSERT INTO users (phone_e164, display_name) VALUES ($1,$2) RETURNING id`, [phone, `Load operator ${i}`])).rows[0];
  await db.query(`INSERT INTO memberships (user_id, role_code) SELECT $1,'operator' WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=$1 AND role_code='operator' AND revoked_at IS NULL)`, [u.id]);
  await db.query(`DELETE FROM otp_challenges WHERE phone_e164=$1`, [phone]).catch(() => {});
  const c = await j('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
  const v = await j('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ challenge_id: c.body.challenge_id, code: c.body.dev_code }) });
  if (!v.body.token) throw new Error('login failed: ' + JSON.stringify(v.body));
  tokens.push(v.body.token);
  await j('/ops/center/shift', { method: 'PUT', body: JSON.stringify({ state: 'working' }) }, v.body.token);
}
const end = Date.now() + DURATION;
async function operator(i) {
  const tok = tokens[i];
  while (Date.now() < end) {
    const c = await j('/ops/center', {}, tok); lat.center.push(c.ms); if (c.status >= 500) errors++;
    const n = await j('/ops/center/next', { method: 'POST' }, tok); lat.next.push(n.ms);
    if (n.status >= 500) { errors++; continue; }
    if (n.status === 409) { conflicts++; continue; }
    const task = n.body.task;
    if (!task) { empty++; await new Promise((r) => setTimeout(r, 200)); continue; }
    if (holder.has(task.id) && holder.get(task.id) !== i) violations++;
    holder.set(task.id, i);
    const r = await j(`/ops/center/tasks/${task.id}/contact`, { method: 'POST', body: JSON.stringify({ expected_version: task.version, outcome: 'info_given' }) }, tok);
    lat.contact.push(r.ms); if (r.status >= 500) errors++;
    const rel = await j(`/ops/center/tasks/${task.id}/release`, { method: 'POST', body: JSON.stringify({ expected_version: r.body?.task?.version ?? task.version + 1, reason: 'load test release' }) }, tok);
    if (rel.status >= 500) errors++;
    holder.delete(task.id);
    done++;
  }
}
const t0 = Date.now();
await Promise.all(tokens.map((_, i) => operator(i)));
const secs = (Date.now() - t0) / 1000;
const open = (await db.query(`SELECT COUNT(*)::int AS n FROM ops_tasks WHERE state NOT IN ('resolved','closed')`)).rows[0].n;
const orders = (await db.query(`SELECT COUNT(*)::int AS n FROM orders`)).rows[0].n;
console.log(JSON.stringify({
  operators: N, duration_s: Math.round(secs), orders_in_db: orders, open_tasks: open, cycles: done, empty_queue: empty, conflicts_409: conflicts, errors_5xx: errors, double_hold_violations: violations,
  p50_ms: { center: pct(lat.center, 50), next: pct(lat.next, 50), contact: pct(lat.contact, 50) },
  p95_ms: { center: pct(lat.center, 95), next: pct(lat.next, 95), contact: pct(lat.contact, 95) },
  targets_ms: { list_p95: 800, claim_p95: 500 },
}, null, 2));
await db.end();
