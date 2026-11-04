import { createHash } from 'node:crypto';
import type { Queryable, Tx } from '../../platform/db.js';

/**
 * Contest Center score engine (UZSHOP PRO §7, §8, §10, §11, §24).
 *
 * Source of truth = orders, order lines and commission accruals. A contest never trusts client numbers.
 * For every eligible order we compute the *desired* facts, compare them with the sum of the score journal for that
 * order and append only the difference. Re-running (duplicate events, retries, late refunds) is therefore idempotent:
 * the same facts produce no new rows; a refund produces one negative adjustment; history is never rewritten.
 *
 *  - provisional points: order delivered, still has kept units (COD may not be remitted yet)
 *  - final points: delivered AND payment settled (COD remitted / paid) AND kept units > 0
 */

export type Metric = 'settled_orders' | 'settled_units' | 'confirmed_commission' | 'net_sales';
export interface ContestRules {
  contest_id: string; version: number; starts_at: string; ends_at: string; metric: Metric;
  eligibility: { product_ids?: string[]; category_ids?: string[]; partners_joined_after?: string };
  min_score: number | string; tie_break: string[]; name_privacy: 'alias' | 'consent'; appeal_days: number;
}
export interface OrderFacts { partnerId: string; prov: bigint; final: bigint; units: number; net: bigint; commission: bigint; refundedUnits: number; lines: string[] }

export async function loadRules(q: Queryable, contestId: string, version?: number): Promise<ContestRules | null> {
  const r = await q.query(
    `SELECT v.*, c.current_version FROM cc_contests c JOIN cc_versions v ON v.contest_id=c.id AND v.version=COALESCE($2, c.current_version) WHERE c.id=$1`,
    [contestId, version ?? null]);
  const v = r.rows[0];
  if (!v) return null;
  return { contest_id: contestId, version: v.version, starts_at: v.starts_at, ends_at: v.ends_at, metric: v.metric, eligibility: v.eligibility ?? {}, min_score: v.min_score, tie_break: v.tie_break, name_privacy: v.name_privacy, appeal_days: v.appeal_days };
}

/**
 * Desired facts per order. `partnerIds` = enrolled partners (null = everyone, used by the dry-run simulation).
 * Only lines of eligible products/categories count (units, sales, commission); an order counts when it has such lines.
 */
export async function desiredFacts(q: Queryable, r: ContestRules, partnerIds: string[] | null): Promise<Map<string, OrderFacts>> {
  const params: unknown[] = [r.starts_at, r.ends_at];
  const conds = [`o.created_at >= $1`, `o.created_at < $2`, `o.attributed_partner_id IS NOT NULL`];
  if (partnerIds) { params.push(partnerIds); conds.push(`o.attributed_partner_id = ANY($${params.length}::uuid[])`); }
  if (r.eligibility.product_ids?.length) { params.push(r.eligibility.product_ids); conds.push(`p.id = ANY($${params.length}::uuid[])`); }
  if (r.eligibility.category_ids?.length) { params.push(r.eligibility.category_ids); conds.push(`p.category_id = ANY($${params.length}::uuid[])`); }
  const rows = await q.query(
    `SELECT o.id AS order_id, o.attributed_partner_id AS partner_id, o.commercial_status, o.fulfillment_status, o.payment_status,
            ol.id AS line_id, ol.qty, ol.canceled_qty, ol.returned_qty, ol.line_net_minor,
            (SELECT COALESCE(SUM(a.target_minor) FILTER (WHERE a.state IN ('pending','available')),0) FROM commission_accruals a WHERE a.order_line_id=ol.id AND a.state <> 'superseded') AS comm_final,
            (SELECT COALESCE(SUM(a.target_minor),0) FROM commission_accruals a WHERE a.order_line_id=ol.id AND a.state IN ('estimated','pending','available')) AS comm_prov
       FROM orders o JOIN order_lines ol ON ol.order_id=o.id JOIN skus s ON s.id=ol.sku_id JOIN products p ON p.id=s.product_id
      WHERE ${conds.join(' AND ')}
      ORDER BY o.id, ol.id`, params);
  const out = new Map<string, OrderFacts & { _delivered: boolean; _paid: boolean; _cancelled: boolean; _commProv: bigint }>();
  for (const x of rows.rows) {
    let f = out.get(x.order_id);
    if (!f) {
      f = { partnerId: x.partner_id, prov: 0n, final: 0n, units: 0, net: 0n, commission: 0n, refundedUnits: 0, lines: [],
        _delivered: x.fulfillment_status === 'delivered' || x.fulfillment_status === 'returned', _paid: x.payment_status === 'paid' || x.payment_status === 'partially_refunded', _cancelled: x.commercial_status === 'cancelled', _commProv: 0n };
      out.set(x.order_id, f);
    }
    const kept = Math.max(0, x.qty - x.canceled_qty - x.returned_qty);
    f.lines.push(x.line_id);
    f.refundedUnits += x.returned_qty;
    if (f._cancelled || kept <= 0) continue;
    f.units += kept;
    f.net += (BigInt(x.line_net_minor) * BigInt(kept)) / BigInt(x.qty);
    f.commission += BigInt(x.comm_final);
    f._commProv += BigInt(x.comm_prov);
  }
  const res = new Map<string, OrderFacts>();
  for (const [id, f] of out) {
    const provOk = !f._cancelled && f._delivered && f.units > 0;
    const finalOk = provOk && f._paid;
    const value = (fin: boolean): bigint => {
      switch (r.metric) {
        case 'settled_orders': return 1n;
        case 'settled_units': return BigInt(f.units);
        case 'net_sales': return f.net;
        case 'confirmed_commission': return fin ? f.commission : f._commProv;
      }
    };
    res.set(id, {
      partnerId: f.partnerId, prov: provOk ? value(false) : 0n, final: finalOk ? value(true) : 0n,
      units: finalOk ? f.units : 0, net: finalOk ? f.net : 0n, commission: finalOk ? f.commission : 0n, refundedUnits: f.refundedUnits, lines: f.lines,
    });
  }
  return res;
}

/** Append the difference between desired facts and the journal. Serialized per contest. Returns rows written. */
export async function recompute(tx: Tx, contestId: string): Promise<{ written: number }> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cc:' || $1::text))`, [contestId]);
  const r = await loadRules(tx, contestId);
  if (!r) return { written: 0 };
  const enrolled = (await tx.query(`SELECT partner_id FROM cc_enrollments WHERE contest_id=$1 AND left_at IS NULL`, [contestId])).rows.map((x) => x.partner_id as string);
  if (!enrolled.length) return { written: 0 };
  const desired = await desiredFacts(tx, r, enrolled);
  const have = new Map<string, { n: number; prov: bigint; final: bigint; units: number; net: bigint; comm: bigint; ref: number }>();
  for (const x of (await tx.query(
    `SELECT order_id, COUNT(*)::int AS n, SUM(prov_points) AS prov, SUM(final_points) AS fin, SUM(final_units)::int AS units, SUM(final_net_sales_minor) AS net, SUM(final_commission_minor) AS comm, SUM(refunded_units)::int AS ref
       FROM cc_score_events WHERE contest_id=$1 AND order_id IS NOT NULL GROUP BY order_id`, [contestId])).rows) {
    have.set(x.order_id, { n: x.n, prov: BigInt(x.prov), final: BigInt(x.fin), units: x.units, net: BigInt(x.net), comm: BigInt(x.comm), ref: x.ref });
  }
  let written = 0;
  // Orders that dropped out entirely (e.g. cancelled after being counted, product filter unchanged) are handled too.
  const ids = new Set([...desired.keys(), ...have.keys()]);
  for (const orderId of ids) {
    const d = desired.get(orderId);
    const h = have.get(orderId) ?? { n: 0, prov: 0n, final: 0n, units: 0, net: 0n, comm: 0n, ref: 0 };
    const partnerId = d?.partnerId ?? (await tx.query(`SELECT partner_id FROM cc_score_events WHERE contest_id=$1 AND order_id=$2 LIMIT 1`, [contestId, orderId])).rows[0]?.partner_id;
    const delta = { prov: (d?.prov ?? 0n) - h.prov, final: (d?.final ?? 0n) - h.final, units: (d?.units ?? 0) - h.units, net: (d?.net ?? 0n) - h.net, comm: (d?.commission ?? 0n) - h.comm, ref: (d?.refundedUnits ?? 0) - h.ref };
    if (!delta.prov && !delta.final && !delta.units && !delta.net && !delta.comm && !delta.ref) continue;
    const key = `cc:${contestId}:${orderId}:${h.n + 1}`;
    const ins = await tx.query(
      `INSERT INTO cc_score_events (contest_id, partner_id, order_id, kind, prov_points, final_points, final_units, final_net_sales_minor, final_commission_minor, refunded_units, contest_version, idem_key, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (idem_key) DO NOTHING`,
      [contestId, partnerId, orderId, h.n === 0 ? 'order' : 'adjustment', delta.prov.toString(), delta.final.toString(), delta.units, delta.net.toString(), delta.comm.toString(), delta.ref, r.version, key,
       JSON.stringify({ order_line_ids: d?.lines ?? [], metric: r.metric })]);
    written += ins.rowCount ?? 0;
  }
  return { written };
}

export interface RankRow { partner_id: string; rank: number | null; score: string; net_sales_minor: string; refund_ratio: number | null; reached_at: string | null; units: number; orders: number; qualified: boolean }

/** Ranking with the announced tie-break; equal on every key => equal rank (1, 1, 3). No randomness anywhere. */
export function rankRows(rows: Omit<RankRow, 'rank'>[], tieBreak: string[]): RankRow[] {
  const key = (r: Omit<RankRow, 'rank'>, k: string): number => {
    switch (k) {
      case 'score': return -Number(r.score);
      case 'net_sales': return -Number(r.net_sales_minor);
      case 'refund_ratio': return r.refund_ratio === null ? 0 : r.refund_ratio;
      case 'reached_at': return r.reached_at ? new Date(r.reached_at).getTime() : Number.MAX_SAFE_INTEGER;
      default: return 0;
    }
  };
  const keys = tieBreak.length ? tieBreak : ['score'];
  const cmp = (a: Omit<RankRow, 'rank'>, b: Omit<RankRow, 'rank'>) => { for (const k of keys) { const d = key(a, k) - key(b, k); if (d) return d; } return 0; };
  const q = rows.filter((r) => r.qualified).sort(cmp);
  const out: RankRow[] = [];
  q.forEach((r, i) => { const prev = out[i - 1]; out.push({ ...r, rank: prev && cmp(q[i - 1]!, r) === 0 ? prev.rank : i + 1 }); });
  for (const r of rows.filter((x) => !x.qualified)) out.push({ ...r, rank: null });
  return out;
}

/** Live ranking from the journal ('provisional' uses prov points, 'final' uses settled points). */
export async function liveRanking(q: Queryable, contestId: string, kind: 'provisional' | 'final', rules: ContestRules): Promise<RankRow[]> {
  const pts = kind === 'final' ? 'final_points' : 'prov_points';
  const rows = await q.query(
    `SELECT e.partner_id, SUM(e.${pts}) AS score, SUM(e.final_net_sales_minor) AS net, SUM(e.final_units)::int AS units, SUM(e.refunded_units)::int AS ref,
            COUNT(DISTINCT e.order_id) FILTER (WHERE e.${pts} <> 0)::int AS orders,
            MAX(e.created_at) FILTER (WHERE e.${pts} > 0) AS reached_at
       FROM cc_score_events e JOIN cc_enrollments en ON en.contest_id=e.contest_id AND en.partner_id=e.partner_id AND en.left_at IS NULL
      WHERE e.contest_id=$1 GROUP BY e.partner_id`, [contestId]);
  const min = BigInt(rules.min_score ?? 0);
  return rankRows(rows.rows.map((x) => {
    const units = Number(x.units), ref = Number(x.ref);
    return { partner_id: x.partner_id, score: String(x.score), net_sales_minor: String(x.net), units, orders: x.orders,
      refund_ratio: units + ref >= 5 ? Math.round((ref / (units + ref)) * 1000) / 1000 : null, // too little data => no refund ratio
      reached_at: x.reached_at ? new Date(x.reached_at).toISOString() : null, qualified: BigInt(x.score) >= min && BigInt(x.score) > 0n };
  }), rules.tie_break);
}

/** C01: delivery from accepted vs overall. 100 created, 70 accepted, 56 delivered => 80% and 56%. */
export function funnel(created: number, accepted: number, delivered: number) {
  return { created, accepted, delivered,
    delivery_from_accepted_pct: accepted ? Math.round((delivered / accepted) * 1000) / 10 : null,
    overall_pct: created ? Math.round((delivered / created) * 1000) / 10 : null };
}

/** Name on a public leaderboard: real name only with consent, otherwise a stable alias. */
export const alias = (partnerId: string) => `Ishtirokchi #${createHash('sha256').update(partnerId).digest('hex').slice(0, 4).toUpperCase()}`;

/** Monday 00:00 Asia/Tashkent (UTC+5, no DST) of the week containing `d`, as a UTC instant, plus the next Monday. */
export function tashkentWeek(d = new Date()): { starts_at: string; ends_at: string } {
  const local = new Date(d.getTime() + 5 * 3600e3);
  const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
  const start = new Date(mondayLocal - 5 * 3600e3);
  return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 7 * 86400e3).toISOString() };
}
