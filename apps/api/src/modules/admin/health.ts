import type { FastifyInstance } from 'fastify';
import { requirePerm } from '../../platform/auth.js';
import { maybeOne, one } from '../../platform/db.js';
import { type Deps, route } from '../../platform/http.js';
import { getIntentClient } from '../aibiz/llm.js';

/**
 * Integration & service health from REAL signals (not just «container alive»): database round-trip, job queue age and
 * dead jobs, outbox lag, notification outcomes per channel, payment mode + unknown results, AI capability, ads.
 * A failing external service is shown as degraded/not_configured — never as «0 orders».
 */
type State = 'ok' | 'degraded' | 'down' | 'not_configured' | 'off';
interface Check { key: string; label: string; state: State; detail: string; action?: string }

export function registerHealth(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/integrations/health', tags: ['admin'], summary: 'Live health of services and integrations (real signals)' }, async ({ actor, db, cfg }) => {
    requirePerm(actor, 'reports.read');
    const checks: Check[] = [];
    const t0 = Date.now();
    await db.query('SELECT 1');
    const dbMs = Date.now() - t0;
    checks.push({ key: 'database', label: 'Ma’lumotlar bazasi', state: dbMs < 500 ? 'ok' : 'degraded', detail: `Javob: ${dbMs} ms` });

    const q = await one<{ pending: number; oldest_s: number | null; dead_24h: number; done_10m: number }>(db, `SELECT
        COUNT(*) FILTER (WHERE status='pending' AND run_at <= now())::int AS pending,
        EXTRACT(EPOCH FROM now() - MIN(run_at) FILTER (WHERE status='pending' AND run_at <= now()))::int AS oldest_s,
        COUNT(*) FILTER (WHERE status='dead' AND created_at > now() - interval '24 hours')::int AS dead_24h,
        COUNT(*) FILTER (WHERE status='done' AND finished_at > now() - interval '10 minutes')::int AS done_10m
      FROM jobs`);
    const qState: State = (q.oldest_s ?? 0) > 600 ? 'down' : (q.oldest_s ?? 0) > 120 || q.dead_24h > 0 ? 'degraded' : 'ok';
    checks.push({ key: 'worker', label: 'Fon vazifalari (worker)', state: qState, detail: `Navbatda: ${q.pending}${q.oldest_s ? `, eng eskisi ${Math.round(q.oldest_s / 60)} daqiqa` : ''} · 24 soatda to‘xtagan: ${q.dead_24h} · 10 daqiqada bajarilgan: ${q.done_10m}`, action: qState === 'down' ? 'Worker jarayoni ishlayaptimi — serverda tekshiring.' : undefined });

    const o = await maybeOne<{ n: number; oldest_s: number | null }>(db, `SELECT COUNT(*)::int AS n, EXTRACT(EPOCH FROM now() - MIN(recorded_at))::int AS oldest_s FROM outbox_events WHERE dispatched_at IS NULL`);
    checks.push({ key: 'outbox', label: 'Voqealar navbati (outbox)', state: (o?.oldest_s ?? 0) > 900 ? 'degraded' : 'ok', detail: `Yuborilmagan: ${o?.n ?? 0}${o?.oldest_s ? `, eng eskisi ${Math.round(o.oldest_s / 60)} daqiqa` : ''}` });

    const tg = await one<{ sent: number; failed: number; suppressed: number; last_sent: string | null }>(db, `SELECT COUNT(*) FILTER (WHERE status='sent')::int AS sent, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE status='suppressed')::int AS suppressed, MAX(sent_at) FILTER (WHERE status='sent') AS last_sent FROM notifications WHERE channel='telegram' AND created_at > now() - interval '24 hours'`);
    const tgOn = !!process.env.TELEGRAM_BOT_TOKEN;
    checks.push({ key: 'telegram', label: 'Telegram bot', state: !tgOn ? 'not_configured' : tg.failed > tg.sent && tg.failed > 0 ? 'degraded' : 'ok',
      detail: tgOn ? `24 soat: yuborildi ${tg.sent}, xato ${tg.failed}, ulanmagan foydalanuvchi ${tg.suppressed}. «Yuborildi» = Telegram qabul qildi, o‘qildi degani emas.` : 'Bot token qo‘yilmagan — xabarlar faqat kabinetda ko‘rinadi.', action: tgOn ? undefined : 'Serverga TELEGRAM_BOT_TOKEN qo‘ying.' });
    const sms = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM notifications WHERE channel='sms' AND created_at > now() - interval '24 hours'`);
    checks.push({ key: 'sms', label: 'SMS', state: 'not_configured', detail: `SMS provayder ulanmagan (24 soatda ${sms.n} ta xabar faqat jurnalga yozildi, yuborilmadi).`, action: 'SMS provayder shartnomasi va kaliti kerak.' });

    const pay = await one<{ unknown: number }>(db, `SELECT (SELECT COUNT(*)::int FROM refunds WHERE status='unknown_result') + (SELECT COUNT(*)::int FROM payout_requests WHERE status='processing_unknown') AS unknown`);
    for (const [k, l, m] of [['payme', 'Payme', cfg.payments.payme.mode], ['click', 'Click', cfg.payments.click.mode]] as const) {
      checks.push({ key: k, label: l, state: m === 'live' ? 'ok' : m === 'sandbox' ? 'degraded' : 'off', detail: m === 'live' ? 'Jonli rejim' : m === 'sandbox' ? 'Sinov rejimi — haqiqiy pul o‘tmaydi' : 'O‘chiq — faqat naqd (COD)', action: m === 'live' ? undefined : 'Merchant shartnomasi va kalitlar kerak.' });
    }
    checks.push({ key: 'money_unknown', label: 'Natijasi noma’lum pul operatsiyalari', state: pay.unknown ? 'degraded' : 'ok', detail: `${pay.unknown} ta (qaytarish/pul yechish) — qayta yubormasdan holatini tekshiring.` });

    const flags = Object.fromEntries((await db.query(`SELECT key, enabled FROM feature_flags WHERE key IN ('ai.business.read','ai.business.llm','ads.live_spend')`)).rows.map((r) => [r.key, r.enabled]));
    const llm = !!getIntentClient();
    checks.push({ key: 'ai', label: 'AI yordamchi', state: !flags['ai.business.read'] ? 'off' : flags['ai.business.llm'] && !llm ? 'degraded' : 'ok',
      detail: !flags['ai.business.read'] ? 'O‘chirilgan (kill switch)' : flags['ai.business.llm'] ? (llm ? 'Hisobotlar + Claude ulangan' : 'Claude yoqilgan, lekin kalit yo‘q — qoidalar bilan ishlayapti') : 'Hisobotlar ishlayapti; tashqi AI o‘chiq' });
    const ads = await one<{ unknown: number }>(db, `SELECT COUNT(*)::int AS unknown FROM campaign_drafts WHERE status='unknown'`);
    checks.push({ key: 'ads', label: 'Meta reklama', state: !flags['ads.live_spend'] ? 'off' : ads.unknown ? 'degraded' : 'ok', detail: !flags['ads.live_spend'] ? 'Jonli sarf o‘chiq (faqat qoralama/PAUSED)' : `Holati noma’lum kampaniyalar: ${ads.unknown}` });
    checks.push({ key: 'fiscal', label: 'Fiskal chek', state: 'not_configured', detail: 'Fiskal provayder ulanmagan. Oddiy PDF fiskal chek emas.', action: 'Provayder shartnomasi va moliyachi tasdig‘i kerak.' });

    const worst: State = checks.some((c) => c.state === 'down') ? 'down' : checks.some((c) => c.state === 'degraded') ? 'degraded' : 'ok';
    return { overall: worst, checks, as_of: new Date().toISOString() };
  });
}
