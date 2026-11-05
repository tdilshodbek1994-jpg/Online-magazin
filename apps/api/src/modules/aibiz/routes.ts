import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, type Actor } from '../../platform/auth.js';
import { many, maybeOne, one, type Db } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { explicitPeriod, lastDays, resolvePeriod, todayPeriod, type Period } from './dates.js';
import { channelOf, classify, PARTNER_QUICK, type Intent, type Tool } from './intent.js';
import { redact } from './text.js';
import * as T from './tools.js';
import type { ToolResult } from './tools.js';

/**
 * AI Business Assistant — P0 read-only gateway.
 * auth → workspace (server-derived) → intent/date resolution → policy → allow-listed tool → facts → deterministic
 * summary → stored report revision. The model never supplies identity or scope; there is no SQL/eval/shell path.
 */
type Workspace = 'partner' | 'operator' | 'operator_lead' | 'admin' | 'superadmin';
interface Principal { userId: string; workspace: Workspace; available: Workspace[]; partnerId: string | null; scopeHash: string }

const DAILY_QUOTA = Number(process.env.AI_BIZ_DAILY_QUOTA ?? 300);
const CONNECTED: Workspace[] = ['partner'];          // P0A: partner reports; the other workspaces are wired next

async function principal(db: Db, actor: Actor, wanted?: string): Promise<Principal> {
  requireUser(actor);
  const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.read'`);
  if (!flag?.enabled) throw new AppError(503, 'AI_DISABLED', {}, false, { fallback: 'use_cabinet_reports' });
  const p = await maybeOne<{ id: string; status: string }>(db, `SELECT id, status FROM partners WHERE user_id=$1`, [actor.userId]);
  const roles = new Set(actor.grants.map((g) => g.role));
  const available: Workspace[] = [];
  if (p?.status === 'active') available.push('partner');
  if (roles.has('owner')) available.push('superadmin');
  else if (roles.has('finance') || roles.has('catalog_manager') || roles.has('warehouse')) available.push('admin');
  if (roles.has('operator')) available.push('operator');
  // Customers (and anyone without a business role) get no business AI at all — menu and API are closed.
  if (!available.length) throw new AppError(403, 'AI_FORBIDDEN');
  const workspace = (wanted && available.includes(wanted as Workspace) ? wanted : wanted ? null : available[0]) as Workspace | null;
  if (!workspace) throw new AppError(403, 'AI_WORKSPACE_FORBIDDEN');
  const partnerId = workspace === 'partner' ? p!.id : null;
  const scopeHash = createHash('sha256').update(JSON.stringify({ u: actor.userId, w: workspace, p: partnerId, r: [...roles].sort() })).digest('hex').slice(0, 32);
  return { userId: actor.userId, workspace, available, partnerId, scopeHash };
}

const som = (minor: string | number | null) => { try { return `${(BigInt(String(minor ?? 0)) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`; } catch { return '—'; } };
export function fmtFact(f: { value: string | number | null; unit: string }): string {
  if (f.value === null || f.value === undefined) return 'maʼlumot yo‘q';
  switch (f.unit) {
    case 'som': return som(f.value);
    case 'orders': return `${f.value} ta buyurtma`;
    case 'units': return `${f.value} dona`;
    case 'coins': return `${f.value} coin`;
    case 'percent': return `${f.value}%`;
    case 'count': return `${f.value} ta`;
    default: return String(f.value);
  }
}

/** Deterministic one-line answer from facts (numbers are never typed by a model). */
export function summarize(r: ToolResult): string {
  const p = r.facts.find((f) => f.primary) ?? r.facts[0];
  const when = r.period ? `${r.period.label}: ` : '';
  if (!p) return r.status === 'zero' ? `${when}bu davrda yozuv yo‘q (natija 0).` : `${when}${r.title}`;
  if (r.status === 'zero') return `${when}${p.label.toLowerCase()} — ${fmtFact(p)} (bu davrda yozuv yo‘q).`;
  return `${when}${p.label.toLowerCase()} — ${fmtFact(p)}.`;
}

const REFUSAL: Record<string, string> = {
  other_partner: 'Boshqa hamkorlarning daromadi, buyurtmasi yoki shaxsiy maʼlumotini ko‘rsata olmayman. Faqat o‘zingizning natijalaringiz va do‘konning umumiy reytingi ochiq.',
  customer_pii: 'Mijozning telefoni, manzili va ichki izohlari AI orqali ochilmaydi. Buyurtma kartasida ruxsat etilgan qismi (yashirilgan holda) ko‘rinadi.',
  secrets: 'Parol, kod, token va tizim kalitlari hech qachon ko‘rsatilmaydi.',
};
const UNSUPPORTED: Record<string, string> = {
  compare: 'Solishtirish keyingi bosqichda qo‘shiladi. Hozircha har bir davrni alohida so‘rang, masalan «kecha qancha pul topdim?» va «bugun qancha pul topdim?».',
  after_ad_result: '«Reklamadan keyingi natija» (komissiya − o‘zingiz to‘lagan reklama) hali ulanmagan. Hozir komissiyani so‘rashingiz mumkin: «shu oy qancha pul topdim?». Reklama xarajatlari «Reklama» bo‘limida.',
  forecast: 'Prognoz hozircha yo‘q: yetarli tarix va tekshiruvsiz taxmin qilmayman.',
  workspace: 'Bu ish muhiti uchun AI hisobotlari keyingi bosqichda ulanadi. Hozircha oddiy panel hisobotlaridan foydalaning.',
  channel_followup: 'Avval biror hisobot so‘rang (masalan «bugun qancha pul topdim?»), keyin «faqat Telegram» deb filtr qo‘shing.',
  future: 'Bu sana hali kelmagan — u kun uchun natija bo‘lishi mumkin emas.',
};

interface Ctx { tool?: Tool; metric?: string; status?: string; channel?: string; period?: { from: string; to: string }; year?: number }

async function runTool(db: Db, pr: Principal, tool: Tool, a: { period?: Period; metric?: string; status?: string; channel?: string }, now: Date): Promise<ToolResult> {
  const s = { partnerId: pr.partnerId! };
  const p = a.period;
  switch (tool) {
    case 'partner_earnings_summary': return T.earnings(db, s, p ?? todayPeriod(now), (a.metric as 'payout_paid') ?? 'commission_recognized_net', a.channel);
    case 'partner_orders_count': return T.ordersCount(db, s, p ?? todayPeriod(now), a.status, a.channel);
    case 'partner_rejections': return T.rejections(db, s, p ?? todayPeriod(now), a.channel);
    case 'partner_wallet_snapshot': return T.wallet(db, s);
    case 'partner_best_day': return T.bestDay(db, s, p ?? resolvePeriod('shu yil', now)!);
    case 'partner_top_products': return T.topProducts(db, s, p ?? lastDays(now, 30));
    case 'partner_flows_performance': return T.flows(db, s, p ?? lastDays(now, 30), a.channel);
    case 'public_bestsellers': return T.bestsellers(db, p ?? lastDays(now, 30));
    case 'partner_uzcoin_summary': return T.uzcoin(db, s);
    case 'partner_level': return T.level(db, s);
    case 'partner_quality_cases': return T.quality(db, s);
    case 'partner_charity_summary': return T.charity(db, s, p ?? resolvePeriod('shu oy', now)!);
    case 'partner_contest_status': return T.contests(db, s);
  }
}

async function quota(db: Db, userId: string) {
  const n = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM ai_query_runs WHERE user_id=$1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent')`, [userId]);
  if (n.n >= DAILY_QUOTA) throw new AppError(429, 'AI_QUOTA_EXCEEDED', { limit: String(DAILY_QUOTA) }, true);
}

async function session(db: Db, pr: Principal, id?: string | null): Promise<{ id: string; context: Ctx }> {
  if (id) {
    const s = await maybeOne<{ id: string; context: Ctx }>(db, `SELECT id, context FROM ai_sessions WHERE id=$1 AND user_id=$2 AND workspace=$3 AND deleted_at IS NULL`, [id, pr.userId, pr.workspace]);
    if (s) return s;
    throw notFound('AI_SESSION'); // same answer whether it does not exist or belongs to someone else
  }
  return one(db, `INSERT INTO ai_sessions (user_id, workspace) VALUES ($1,$2) RETURNING id, context`, [pr.userId, pr.workspace]);
}

async function store(db: Db, pr: Principal, sessionId: string | null, question: string | null, tool: string, args: unknown, result: ToolResult | null, status: string, summary: string, trace: string, started: number, intent: string) {
  const rep = result ? await one<{ id: string; as_of: string }>(db, `INSERT INTO ai_report_snapshots (user_id, workspace, scope_hash, tool, arguments, result, metric_version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, as_of`,
    [pr.userId, pr.workspace, pr.scopeHash, tool, JSON.stringify(args ?? {}), JSON.stringify(result), result.metric_version]) : null;
  if (sessionId) {
    if (question !== null) await db.query(`INSERT INTO ai_messages (session_id, role, text) VALUES ($1,'user',$2)`, [sessionId, redact(question)]);
    await db.query(`INSERT INTO ai_messages (session_id, role, text, report_id, status) VALUES ($1,'assistant',$2,$3,$4)`, [sessionId, summary, rep?.id ?? null, status]);
    await db.query(`UPDATE ai_sessions SET updated_at=now(), title=COALESCE(title, $2) WHERE id=$1`, [sessionId, question ? redact(question).slice(0, 80) : null]);
  }
  await db.query(`INSERT INTO ai_query_runs (trace_id, user_id, workspace, intent, tool, status, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [trace, pr.userId, pr.workspace, intent, tool || null, status, Date.now() - started]);
  return rep;
}

const card = (rep: { id: string; as_of: string } | null, status: string, summary: string, result: ToolResult | null, pr: Principal, sessionId: string | null, extra: Record<string, unknown> = {}) =>
  ({ report_id: rep?.id ?? null, session_id: sessionId, status, summary, result, as_of: rep?.as_of ?? new Date().toISOString(), workspace: pr.workspace, scope_label: pr.workspace === 'partner' ? 'Faqat sizning maʼlumotlaringiz' : pr.workspace, provider: 'deterministic', ...extra });

const CHANNEL_TOOLS: Tool[] = ['partner_earnings_summary', 'partner_orders_count', 'partner_rejections', 'partner_flows_performance'];
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerAiBiz(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ai/biz/capabilities', tags: ['ai-biz'], summary: 'Workspaces, quick questions and connected reports for the current user', query: z.object({ workspace: z.string().max(20).optional() }) },
    async ({ actor, db, query }) => {
      const pr = await principal(db, actor, query.workspace);
      const llm = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.llm'`);
      return {
        workspace: pr.workspace, available: pr.available, connected: CONNECTED.includes(pr.workspace),
        quick_questions: pr.workspace === 'partner' ? PARTNER_QUICK : [],
        llm: { enabled: !!llm?.enabled, note: llm?.enabled ? null : 'Savollar tayyor qoidalar bilan tushuniladi (tashqi AI o‘chiq).' },
        voice: false, export: false, actions: false, timezone: 'Asia/Tashkent',
      };
    });

  route(app, deps, { method: 'POST', url: '/ai/biz/ask', tags: ['ai-biz'], summary: 'Ask in plain Uzbek (Latin/Cyrillic); answer is a stored, source-backed report card',
    body: z.object({ text: z.string().trim().min(2).max(500), session_id: z.string().uuid().nullish(), workspace: z.string().max(20).optional() }).strict() },
  async ({ actor, db, body }) => {
    const started = Date.now(); const trace = randomUUID(); const now = new Date();
    const pr = await principal(db, actor, body.workspace);
    await quota(db, pr.userId);
    const ses = await session(db, pr, body.session_id);
    const reply = async (status: string, summary: string, intent: string, extra: Record<string, unknown> = {}) => {
      await store(db, pr, ses.id, body.text, '', null, null, status, summary, trace, started, intent);
      return card(null, status, summary, null, pr, ses.id, extra);
    };
    if (!CONNECTED.includes(pr.workspace)) return reply('unsupported', UNSUPPORTED.workspace!, 'workspace');
    const intent: Intent = classify(body.text);
    if (intent.kind === 'forbidden') return reply('forbidden', REFUSAL[intent.reason]!, `forbidden:${intent.reason}`);
    if (intent.kind === 'unsupported') return reply('unsupported', UNSUPPORTED[intent.reason]!, `unsupported:${intent.reason}`, { suggestions: PARTNER_QUICK.slice(0, 4) });
    if (intent.kind === 'unknown') return reply('unsupported', 'Bu savolni hali tushunmadim. Quyidagilardan birini tanlang yoki davr va ko‘rsatkichni aniq yozing (masalan «25-oktabrda nechta buyurtma oldim?»).', 'unknown', { suggestions: PARTNER_QUICK });

    let tool = intent.tool; let metric = intent.metric; let status = intent.status; let channel = intent.channel;
    let period = resolvePeriod(body.text, now, ses.context.year ?? null);
    if (intent.followup) {
      // «endi faqat Telegram»: same report and period, one extra allowed filter — the scope stays the server's.
      if (!ses.context.tool || !CHANNEL_TOOLS.includes(ses.context.tool)) return reply('unsupported', UNSUPPORTED.channel_followup!, 'followup');
      tool = ses.context.tool; metric = ses.context.metric; status = ses.context.status; channel = channelOf(body.text);
      period = ses.context.period ? explicitPeriod(ses.context.period.from, ses.context.period.to, now) : period;
    }
    if (period?.future) return reply('zero', UNSUPPORTED.future!, 'future');
    const result = await runTool(db, pr, tool, { period: period ?? undefined, metric, status, channel: CHANNEL_TOOLS.includes(tool) ? channel : undefined }, now);
    const summary = summarize(result);
    const ctx: Ctx = { tool, metric, status, channel, period: result.period ? { from: result.period.from, to: result.period.to_exclusive } : undefined, year: period && ['day', 'month'].includes(period.kind) ? Number(period.from.slice(0, 4)) : ses.context.year };
    await db.query(`UPDATE ai_sessions SET context=$2 WHERE id=$1`, [ses.id, JSON.stringify(ctx)]);
    const rep = await store(db, pr, ses.id, body.text, tool, { metric, status, channel, period: ctx.period }, result, result.status, summary, trace, started, tool);
    return card(rep, result.status, summary, result, pr, ses.id);
  });

  // Structured call used by quick cards and «Filtrni o‘zgartirish»: same tools, strict schema, no identity fields.
  route(app, deps, { method: 'POST', url: '/ai/biz/tool', tags: ['ai-biz'], summary: 'Run one allow-listed report tool with explicit arguments',
    body: z.object({
      tool: z.enum(['partner_earnings_summary', 'partner_orders_count', 'partner_rejections', 'partner_wallet_snapshot', 'partner_best_day', 'partner_top_products', 'partner_flows_performance', 'partner_uzcoin_summary', 'partner_level', 'partner_quality_cases', 'partner_charity_summary', 'partner_contest_status', 'public_bestsellers']),
      arguments: z.object({ date_from: zDate.optional(), date_to_exclusive: zDate.optional(), metric: z.enum(['commission_recognized_net', 'payout_paid']).optional(), status: z.enum(['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled']).optional(), channel: z.enum(['telegram', 'instagram', 'facebook', 'youtube', 'tiktok']).optional() }).strict().default({}),
      session_id: z.string().uuid().nullish(), workspace: z.string().max(20).optional(),
    }).strict() },
  async ({ actor, db, body }) => {
    const started = Date.now(); const trace = randomUUID(); const now = new Date();
    const pr = await principal(db, actor, body.workspace);
    if (!CONNECTED.includes(pr.workspace)) throw new AppError(403, 'AI_TOOL_FORBIDDEN');
    await quota(db, pr.userId);
    const a = body.arguments;
    let period: Period | undefined;
    if (a.date_from || a.date_to_exclusive) {
      if (!a.date_from || !a.date_to_exclusive) throw new AppError(422, 'AI_INVALID_PERIOD');
      const p = explicitPeriod(a.date_from, a.date_to_exclusive, now);
      if (!p) throw new AppError(422, 'AI_INVALID_PERIOD', { max_days: '366' });
      if (p.future) throw new AppError(422, 'AI_FUTURE_PERIOD');
      period = p;
    }
    const ses = body.session_id ? await session(db, pr, body.session_id) : null;
    const result = await runTool(db, pr, body.tool, { period, metric: a.metric, status: a.status, channel: CHANNEL_TOOLS.includes(body.tool) ? a.channel : undefined }, now);
    const summary = summarize(result);
    const rep = await store(db, pr, ses?.id ?? null, null, body.tool, a, result, result.status, summary, trace, started, body.tool);
    return card(rep, result.status, summary, result, pr, ses?.id ?? null);
  });

  // Stored report: re-authorised on every fetch (same user, workspace still allowed, same scope) — else 404.
  route(app, deps, { method: 'GET', url: '/ai/biz/reports/:id', tags: ['ai-biz'], summary: 'Fetch a stored report revision (re-authorised)', params: zIdParam },
    async ({ actor, db, params }) => {
      requireUser(actor);
      const r = await maybeOne<{ id: string; workspace: string; scope_hash: string; result: ToolResult; as_of: string }>(db, `SELECT id, workspace, scope_hash, result, as_of FROM ai_report_snapshots WHERE id=$1 AND user_id=$2`, [params.id, actor.userId]);
      if (!r) throw notFound('AI_REPORT');
      let pr: Principal;
      try { pr = await principal(db, actor, r.workspace); } catch { throw notFound('AI_REPORT'); }
      if (pr.scopeHash !== r.scope_hash) throw notFound('AI_REPORT');
      return card({ id: r.id, as_of: r.as_of }, r.result.status, summarize(r.result), r.result, pr, null);
    });

  route(app, deps, { method: 'GET', url: '/ai/biz/sessions', tags: ['ai-biz'], summary: 'My chats in the current workspace', query: z.object({ workspace: z.string().max(20).optional() }) },
    async ({ actor, db, query }) => {
      const pr = await principal(db, actor, query.workspace);
      return { items: await many(db, `SELECT id, title, updated_at FROM ai_sessions WHERE user_id=$1 AND workspace=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30`, [pr.userId, pr.workspace]) };
    });

  route(app, deps, { method: 'GET', url: '/ai/biz/sessions/:id', tags: ['ai-biz'], summary: 'Messages of one chat (reports re-checked against current scope)', params: zIdParam, query: z.object({ workspace: z.string().max(20).optional() }) },
    async ({ actor, db, params, query }) => {
      const pr = await principal(db, actor, query.workspace);
      await session(db, pr, params.id);
      const msgs = await many<{ id: string; role: string; text: string; status: string | null; created_at: string; report_id: string | null; scope_hash: string | null; result: ToolResult | null }>(db,
        `SELECT m.id, m.role, m.text, m.status, m.created_at, m.report_id, r.scope_hash, r.result FROM ai_messages m LEFT JOIN ai_report_snapshots r ON r.id=m.report_id WHERE m.session_id=$1 ORDER BY m.created_at`, [params.id]);
      // A report whose scope no longer matches is not shown again (redacted placeholder).
      return { items: msgs.map((m) => ({ id: m.id, role: m.role, text: m.scope_hash && m.scope_hash !== pr.scopeHash ? 'Bu hisobotga endi ruxsat yo‘q.' : m.text, status: m.status, created_at: m.created_at, report_id: m.scope_hash === pr.scopeHash ? m.report_id : null, result: m.scope_hash === pr.scopeHash ? m.result : null })) };
    });

  route(app, deps, { method: 'DELETE', url: '/ai/biz/sessions/:id', tags: ['ai-biz'], summary: 'Delete my chat', params: zIdParam, query: z.object({ workspace: z.string().max(20).optional() }) },
    async ({ actor, db, params, query }) => {
      const pr = await principal(db, actor, query.workspace);
      await session(db, pr, params.id);
      await db.query(`UPDATE ai_sessions SET deleted_at=now() WHERE id=$1`, [params.id]);
      await db.query(`DELETE FROM ai_messages WHERE session_id=$1`, [params.id]);
      return { ok: true };
    });

  route(app, deps, { method: 'POST', url: '/ai/biz/feedback', tags: ['ai-biz'], summary: '«Xato haqida xabar»: verdict on one stored report', body: z.object({ report_id: z.string().uuid(), verdict: z.enum(['correct', 'wrong', 'unclear']), note: z.string().max(500).optional() }).strict() },
    async ({ actor, db, body }) => {
      requireUser(actor);
      const r = await maybeOne(db, `SELECT 1 FROM ai_report_snapshots WHERE id=$1 AND user_id=$2`, [body.report_id, actor.userId]);
      if (!r) throw notFound('AI_REPORT');
      await db.query(`INSERT INTO ai_feedback (user_id, report_id, verdict, note) VALUES ($1,$2,$3,$4)`, [actor.userId, body.report_id, body.verdict, body.note ? redact(body.note) : null]);
      return { ok: true };
    });
}

