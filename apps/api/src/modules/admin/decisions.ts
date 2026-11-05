import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm, requireStepUp } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';

/**
 * Owner «Qarorlar va muammolar markazi» + daily finance close.
 * Problems are DERIVED from live records (one row per problem kind with count, oldest since, responsible role and the
 * page where it is fixed). A problem disappears only when the underlying record is fixed — «ko‘rdim» never hides it.
 * Severity: 1 money/security · 2 blocks sales · 3 service delay · 4 advice.
 */
export interface Problem { kind: string; severity: 1 | 2 | 3 | 4; title: string; count: number; amount_minor?: string; since: string | null; owner_role: string; href: string; hint: string }

async function count(q: Queryable, sql: string, params: unknown[] = []) {
  return one<{ n: number; since: string | null; amount: string | null }>(q, sql, params);
}

export async function problems(q: Queryable): Promise<Problem[]> {
  const out: Problem[] = [];
  const add = (p: Omit<Problem, 'count' | 'since' | 'amount_minor'>, r: { n: number; since: string | null; amount?: string | null }) => { if (r.n > 0) out.push({ ...p, count: r.n, since: r.since, ...(r.amount ? { amount_minor: r.amount } : {}) }); };
  add({ kind: 'payout_unknown', severity: 1, title: 'Hamkorga to‘lov natijasi noma’lum', owner_role: 'Moliya', href: '/admin?tab=finance', hint: 'Bank/karta holatini tekshiring; qayta to‘lamang — avval natijani aniqlang.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(updated_at) AS since, SUM(amount_minor)::text AS amount FROM payout_requests WHERE status='processing_unknown'`));
  add({ kind: 'refund_unknown', severity: 1, title: 'Mijozga qaytarish natijasi noma’lum yoki xato', owner_role: 'Moliya', href: '/admin?tab=finance', hint: 'Provayder holatini tekshiring; bir xil qaytarishni ikki marta yubormang.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(updated_at) AS since, SUM(amount_minor)::text AS amount FROM refunds WHERE status IN ('unknown_result','failed')`));
  add({ kind: 'finance_exception', severity: 1, title: 'Summalar mos kelmadi (moliya istisnolari)', owner_role: 'Moliya', href: '/admin?tab=finance', hint: 'Har birini dalil bilan hal qiling; balans avtomatik tuzatilmaydi.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since, SUM(amount_minor)::text AS amount FROM finance_exceptions WHERE status='open'`));
  add({ kind: 'cod_unremitted', severity: 1, title: 'Kuryerda 2 kundan ortiq turgan naqd pul', owner_role: 'Moliya', href: '/admin?tab=finance', hint: 'Kuryerdan topshirishni so‘rang yoki farqni hujjatlang.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(collected_at) AS since, SUM(collected_minor)::text AS amount FROM cod_collections WHERE collected_minor IS NOT NULL AND remittance_id IS NULL AND collected_at < now() - interval '2 days'`));
  add({ kind: 'ads_unknown', severity: 1, title: 'Reklama holati noma’lum (provayder javob bermadi)', owner_role: 'Marketing', href: '/admin?tab=target', hint: 'Meta’da holatni tekshiring; to‘xtadi deb hisoblamang.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(updated_at) AS since FROM campaign_drafts WHERE status='unknown'`));
  add({ kind: 'landing_stockout', severity: 2, title: 'Chop etilgan landingdagi mahsulot tugagan', owner_role: 'Omborchi / Marketing', href: '/admin?tab=landings', hint: 'Tovar keltiring yoki landingni/reklamani to‘xtating.' },
    await count(q, `SELECT COUNT(DISTINCT lp.id)::int AS n, MIN(lp.published_at) AS since FROM landing_pages lp
        WHERE lp.status='published' AND EXISTS (SELECT 1 FROM unnest(lp.product_ids) pid WHERE NOT EXISTS (
          SELECT 1 FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=pid AND s.status='active' AND sb.on_hand_sellable - sb.reserved - sb.safety_buffer > 0))`));
  add({ kind: 'unassigned_orders', severity: 2, title: '30 daqiqadan beri hech kim olmagan yangi buyurtmalar', owner_role: 'Operator boshlig‘i', href: '/ops', hint: 'Operator xonasida navbatga qo‘ying yoki biriktiring.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since FROM orders WHERE commercial_status='awaiting_confirmation' AND assigned_operator_id IS NULL AND created_at < now() - interval '30 minutes'`));
  add({ kind: 'out_of_stock', severity: 2, title: 'Sotuvdagi mahsulot tugagan', owner_role: 'Omborchi', href: '/admin?tab=stock', hint: 'Kam qolganlar ro‘yxatidan to‘ldiring.' },
    await count(q, `SELECT COUNT(*)::int AS n, NULL::timestamptz AS since FROM products p WHERE p.status='published' AND NOT EXISTS (
        SELECT 1 FROM skus s JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active' AND sb.on_hand_sellable - sb.reserved - sb.safety_buffer > 0)`));
  add({ kind: 'returns_overdue', severity: 3, title: '3 kundan ortiq ko‘rilmagan qaytarish so‘rovlari', owner_role: 'Operator / Omborchi', href: '/ops', hint: 'Qaror qiling yoki mijozga sababini yozing.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since FROM return_requests WHERE status IN ('requested','reviewing') AND created_at < now() - interval '3 days'`));
  add({ kind: 'payouts_waiting', severity: 3, title: '3 kundan ortiq kutayotgan pul yechish so‘rovlari', owner_role: 'Moliya', href: '/admin?tab=finance', hint: 'Tasdiqlang yoki sababini yozib rad eting.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since, SUM(amount_minor)::text AS amount FROM payout_requests WHERE status IN ('requested','approved') AND created_at < now() - interval '3 days'`));
  add({ kind: 'data_requests', severity: 3, title: 'Mijozning ma’lumot so‘rovlari (nusxa/o‘chirish)', owner_role: 'Ega', href: '/admin?tab=staff', hint: 'Qarorni yozib qo‘ying; qonuniy saqlanadigan yozuvlar saqlanadi.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since FROM data_requests WHERE status IN ('requested','in_review')`));
  add({ kind: 'quality_cases', severity: 4, title: 'Ochiq sifat tekshiruvlari', owner_role: 'Sifat nazorati', href: '/admin?tab=quality', hint: 'Signal — ayb emas; dalil bilan qaror qiling.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(created_at) AS since FROM quality_cases WHERE status NOT IN ('final','resolved_no_fault','inconclusive','confirmed_violation')`));
  add({ kind: 'automation_alerts', severity: 3, title: 'Avtomatik qoidalar ogohlantirdi (24 soat)', owner_role: 'Ega', href: '/admin?tab=automation', hint: 'Har birini ko‘rib chiqing; qoida faqat ogohlantiradi, o‘zi hech narsani hal qilmaydi.' },
    await count(q, `SELECT COUNT(*)::int AS n, MIN(x.created_at) AS since FROM automation_runs x JOIN automation_rules r ON r.id=x.rule_id WHERE x.outcome='done' AND r.action='alert_owner' AND x.created_at > now() - interval '24 hours'`));
  return out.sort((a, b) => a.severity - b.severity || b.count - a.count);
}

const TZ = `'Asia/Tashkent'`;
/** One local day's money figures — each state separate (order amount ≠ cash; collected ≠ remitted). */
export async function daySummary(q: Queryable, day: string) {
  const r = await one<Record<string, string | number>>(q, `
    WITH b AS (SELECT ($1::date::timestamp AT TIME ZONE ${TZ}) AS s, (($1::date + 1)::timestamp AT TIME ZONE ${TZ}) AS e)
    SELECT
      (SELECT COUNT(*)::int FROM orders, b WHERE created_at >= b.s AND created_at < b.e) AS orders_created,
      (SELECT COALESCE(SUM(payable_minor),0)::text FROM orders, b WHERE fulfillment_status='delivered' AND delivered_at >= b.s AND delivered_at < b.e) AS delivered_amount,
      (SELECT COALESCE(SUM(collected_minor),0)::text FROM cod_collections, b WHERE collected_at >= b.s AND collected_at < b.e) AS cod_collected,
      (SELECT COALESCE(SUM(received_minor),0)::text FROM cod_remittances, b WHERE status='confirmed' AND confirmed_at >= b.s AND confirmed_at < b.e) AS cod_remitted,
      (SELECT COALESCE(SUM(captured_minor),0)::text FROM payment_intents, b WHERE method <> 'cod' AND updated_at >= b.s AND updated_at < b.e AND captured_minor > 0) AS online_captured,
      (SELECT COALESCE(SUM(amount_minor),0)::text FROM refunds, b WHERE status='succeeded' AND updated_at >= b.s AND updated_at < b.e) AS refunds_succeeded,
      (SELECT COALESCE(SUM(amount_minor),0)::text FROM partner_ledger, b WHERE source_type='payout' AND to_bucket='paid' AND created_at >= b.s AND created_at < b.e) AS payouts_paid,
      (SELECT COALESCE(SUM(collected_minor),0)::text FROM cod_collections WHERE collected_minor IS NOT NULL AND remittance_id IS NULL) AS cod_outstanding_now`, [day]);
  const mismatches = await many<{ id: string; expected: string; received: string; diff: string }>(q, `
    SELECT id, expected_minor::text AS expected, received_minor::text AS received, (received_minor - expected_minor)::text AS diff FROM cod_remittances
     WHERE status='confirmed' AND received_minor IS NOT NULL AND received_minor <> expected_minor
       AND confirmed_at >= ($1::date::timestamp AT TIME ZONE ${TZ}) AND confirmed_at < (($1::date + 1)::timestamp AT TIME ZONE ${TZ})`, [day]);
  return { day, timezone: 'Asia/Tashkent', figures: r, mismatches, note: 'Online to‘lov raqami provayder hisobotisiz to‘liq solishtirilmagan (provayder ulanmagan).' };
}

export function registerDecisions(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/decisions', tags: ['admin'], summary: 'Owner decisions & problems center (derived from live records)' }, async ({ actor, db }) => {
    requirePerm(actor, 'reports.read');
    const items = await problems(db);
    return { items, as_of: new Date().toISOString(), counts: { money: items.filter((i) => i.severity === 1).length, sales: items.filter((i) => i.severity === 2).length, delay: items.filter((i) => i.severity === 3).length, advice: items.filter((i) => i.severity === 4).length } };
  });

  route(app, deps, { method: 'GET', url: '/admin/finance/day', tags: ['admin'], summary: 'One day of money figures + mismatches + close history', query: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) },
    async ({ actor, db, query }) => {
      requirePerm(actor, 'payments.read');
      const s = await daySummary(db, query.day);
      const closes = await many(db, `SELECT version, mismatches, note, closed_at, (SELECT display_name FROM users WHERE id=closed_by) AS closed_by FROM finance_day_closes WHERE day=$1 ORDER BY version DESC`, [query.day]);
      return { ...s, closes };
    });

  route(app, deps, { method: 'POST', url: '/admin/finance/day/close', tags: ['admin'], summary: 'Close a day: store a snapshot (a later correction = new version)',
    body: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(500).optional() }).strict() },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'payments.read');
    requireStepUp(actor);
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    if (body.day >= today) throw new AppError(422, 'DAY_NOT_FINISHED');
    return withTx(db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('dayclose:' || $1))`, [body.day]);
      const s = await daySummary(tx, body.day);
      const prev = await maybeOne<{ version: number }>(tx, `SELECT MAX(version)::int AS version FROM finance_day_closes WHERE day=$1`, [body.day]);
      const v = (prev?.version ?? 0) + 1;
      if (v > 1 && !body.note) throw new AppError(422, 'CORRECTION_NOTE_REQUIRED');
      await tx.query(`INSERT INTO finance_day_closes (day, version, snapshot, mismatches, note, closed_by) VALUES ($1,$2,$3,$4,$5,$6)`, [body.day, v, JSON.stringify(s), s.mismatches.length, body.note ?? null, actor.userId]);
      await audit(tx, actor, 'finance.day_closed', { type: 'finance_day', id: body.day }, { after: { version: v, mismatches: s.mismatches.length } });
      return { day: body.day, version: v, mismatches: s.mismatches.length };
    });
  });
}
