import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, type Actor } from '../../platform/auth.js';
import { many, maybeOne, one, type Db } from '../../platform/db.js';
import { AppError, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { explicitPeriod, lastDays, localDay, previousPeriod, resolvePeriod, todayPeriod, ymd, type Period } from './dates.js';
import { channelOf, classify, PARTNER_QUICK, type Tool } from './intent.js';
import { getIntentClient } from './llm.js';
import * as S from './staff.js';
import { classifyStaff, STAFF_QUICK, staffTools, type StaffTool } from './staff.js';
import { matchForm, redact } from './text.js';
import * as T from './tools.js';
import type { ToolResult } from './tools.js';

/**
 * AI Business Assistant — read-only gateway for every business workspace.
 * auth → workspace (server-derived) → refusals → intent/date resolution (deterministic; optional LLM routing) →
 * allow-list for THIS principal → tool → facts → deterministic summary → stored report revision.
 * The model never supplies identity or scope; there is no SQL/eval/shell path; no tool writes anything.
 */
type Workspace = 'partner' | 'operator' | 'operator_lead' | 'admin' | 'superadmin';
type AnyTool = Tool | StaffTool;
interface Principal { userId: string; workspace: Workspace; available: Workspace[]; partnerId: string | null; perms: Set<string>; scopeHash: string }

const DAILY_QUOTA = Number(process.env.AI_BIZ_DAILY_QUOTA ?? 300);
const PARTNER_TOOLS: Tool[] = ['partner_earnings_summary', 'partner_orders_count', 'partner_rejections', 'partner_wallet_snapshot', 'partner_best_day', 'partner_top_products', 'partner_flows_performance', 'partner_uzcoin_summary', 'partner_level', 'partner_quality_cases', 'partner_charity_summary', 'partner_contest_status', 'public_bestsellers'];
const ALL_TOOLS = [...PARTNER_TOOLS, 'operator_work_queue', 'operator_activity_summary', 'admin_sales_summary', 'admin_cod_summary', 'admin_inventory_summary', 'admin_operators_summary', 'admin_partners_top'] as const;
const CHANNEL_TOOLS: AnyTool[] = ['partner_earnings_summary', 'partner_orders_count', 'partner_rejections', 'partner_flows_performance'];
const COMPARABLE: AnyTool[] = ['partner_earnings_summary', 'partner_orders_count', 'partner_rejections', 'admin_sales_summary', 'operator_activity_summary', 'admin_cod_summary'];

async function principal(db: Db, actor: Actor, wanted?: string): Promise<Principal> {
  requireUser(actor);
  const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.read'`);
  if (!flag?.enabled) throw new AppError(503, 'AI_DISABLED', {}, false, { fallback: 'use_cabinet_reports' });
  const p = await maybeOne<{ id: string; status: string }>(db, `SELECT id, status FROM partners WHERE user_id=$1`, [actor.userId]);
  const roles = new Set(actor.grants.map((g) => g.role));
  const perms = new Set(actor.perms.keys());
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
  const scopeHash = createHash('sha256').update(JSON.stringify({ u: actor.userId, w: workspace, p: partnerId, r: [...roles].sort(), g: [...perms].sort() })).digest('hex').slice(0, 32);
  return { userId: actor.userId, workspace, available, partnerId, perms, scopeHash };
}

const staffScope = (pr: Principal): S.StaffScope => ({ userId: pr.userId, workspace: pr.workspace as S.StaffScope['workspace'], perms: pr.perms });
/** Tools this principal may run — computed from the server context only. */
function allowedTools(pr: Principal): AnyTool[] {
  if (pr.workspace === 'partner') return PARTNER_TOOLS;
  const st = staffTools(staffScope(pr));
  return pr.workspace === 'operator' ? [...st, 'public_bestsellers'] : st;
}
const quickFor = (pr: Principal) => pr.workspace === 'partner' ? PARTNER_QUICK : staffTools(staffScope(pr)).map((t) => STAFF_QUICK[t]);
const WS_LABEL: Record<Workspace, string> = { partner: 'Hamkor kabineti', operator: 'Operator', operator_lead: 'Jamoa', admin: 'Admin', superadmin: 'Do‘kon egasi' };
const SCOPE_LABEL: Record<Workspace, string> = { partner: 'Faqat sizning maʼlumotlaringiz', operator: 'Faqat sizga biriktirilgan ishlar', operator_lead: 'Vakolat berilgan jamoa', admin: 'Sizga berilgan bo‘limlar', superadmin: 'Butun do‘kon (maxfiy kalitlarsiz)' };

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
  if (r.metric.startsWith('compare:')) {
    const [c, b, d] = r.facts;
    return c && b && d ? `${c.label}: ${fmtFact(c)} · ${b.label}: ${fmtFact(b)} · farq ${String(d.value).startsWith('-') ? '' : '+'}${fmtFact(d)}.` : r.title;
  }
  if (!p) return r.status === 'zero' ? `${when}bu davrda yozuv yo‘q (natija 0).` : `${when}${r.title}`;
  if (r.status === 'zero') return r.period ? `${when}${p.label.toLowerCase()} — ${fmtFact(p)} (bu davrda yozuv yo‘q).` : `${p.label} — ${fmtFact(p)} (hozir).`;
  return `${when}${p.label.toLowerCase()} — ${fmtFact(p)}.`;
}

const REFUSAL: Record<string, string> = {
  other_partner: 'Boshqa hamkorlarning daromadi, buyurtmasi yoki shaxsiy maʼlumotini ko‘rsata olmayman. Faqat o‘zingizning natijalaringiz va do‘konning umumiy reytingi ochiq.',
  customer_pii: 'Mijozning telefoni, manzili va ichki izohlari AI orqali ochilmaydi. Buyurtma kartasida ruxsat etilgan qismi (yashirilgan holda) ko‘rinadi.',
  secrets: 'Parol, kod, token va tizim kalitlari hech qachon ko‘rsatilmaydi.',
  not_granted: 'Bu hisobot sizning vakolatingizga kirmaydi. Kerak bo‘lsa do‘kon egasidan ruxsat so‘rang.',
};
const UNSUPPORTED: Record<string, string> = {
  compare: 'Solishtirish uchun avval bitta hisobot so‘rang (masalan «bugun qancha pul topdim?»), keyin «kechagisi bilan solishtir» deb yozing.',
  forecast: 'Prognoz hozircha yo‘q: yetarli tarix va tekshiruvsiz taxmin qilmayman.',
  channel_followup: 'Avval biror hisobot so‘rang (masalan «bugun qancha pul topdim?»), keyin «faqat Telegram» deb filtr qo‘shing.',
  future: 'Bu sana hali kelmagan — u kun uchun natija bo‘lishi mumkin emas.',
  unknown: 'Bu savolni hali tushunmadim. Quyidagilardan birini tanlang yoki davr va ko‘rsatkichni aniq yozing.',
};

interface Ctx { tool?: AnyTool; metric?: string; status?: string; channel?: string; period?: { from: string; to: string }; year?: number }

async function runTool(db: Db, pr: Principal, tool: AnyTool, a: { period?: Period; metric?: string; status?: string; channel?: string }, now: Date): Promise<ToolResult> {
  const p = a.period;
  if (pr.workspace !== 'partner') {
    const s = staffScope(pr);
    switch (tool) {
      case 'operator_work_queue': return S.operatorQueue(db, s);
      case 'operator_activity_summary': return S.operatorActivity(db, s, p ?? todayPeriod(now));
      case 'admin_sales_summary': return S.salesSummary(db, p ?? todayPeriod(now));
      case 'admin_cod_summary': return S.codSummary(db, p ?? todayPeriod(now));
      case 'admin_inventory_summary': return S.inventorySummary(db);
      case 'admin_operators_summary': return S.operatorsSummary(db, p ?? lastDays(now, 7));
      case 'admin_partners_top': return S.partnersTop(db, p ?? lastDays(now, 30));
      case 'public_bestsellers': return T.bestsellers(db, p ?? lastDays(now, 30));
      default: throw new AppError(403, 'AI_TOOL_FORBIDDEN');
    }
  }
  const s = { partnerId: pr.partnerId! };
  switch (tool) {
    case 'partner_earnings_summary': return a.metric === 'partner_after_ad_result' ? T.afterAd(db, s, p ?? resolvePeriod('shu oy', now)!) : T.earnings(db, s, p ?? todayPeriod(now), (a.metric as 'payout_paid') ?? 'commission_recognized_net', a.channel);
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
    default: throw new AppError(403, 'AI_TOOL_FORBIDDEN');
  }
}

/** Two runs of the same tool → current vs. baseline (equal elapsed part when the current period is still running). */
function compareResults(cur: ToolResult, prev: ToolResult): ToolResult {
  const c = cur.facts.find((f) => f.primary) ?? cur.facts[0];
  const b = prev.facts.find((f) => f.id === c?.id) ?? prev.facts.find((f) => f.primary);
  const num = (v: unknown) => { try { return BigInt(String(v ?? 0)); } catch { return null; } };
  const cv = num(c?.value), bv = num(b?.value);
  if (!c || !b || cv === null || bv === null || !['som', 'orders', 'count', 'units'].includes(c.unit)) {
    return { ...cur, status: 'unsupported', metric: `compare:${cur.metric}`, title: 'Bu ko‘rsatkichni solishtirib bo‘lmaydi', facts: [], partial_reasons: [] };
  }
  const diff = cv - bv;
  const pct = bv !== 0n ? Number((diff * 1000n) / bv) / 10 : null;
  return {
    ...cur, metric: `compare:${cur.metric}`, title: `Solishtirish: ${cur.title}`,
    facts: [{ ...c, label: cur.period?.label ?? 'Hozir', primary: true }, { ...b, label: prev.period?.label ?? 'Oldingi', primary: false },
      { id: 'diff', label: 'Farq', value: c.unit === 'som' ? diff.toString() : Number(diff), unit: c.unit, kind: 'computed' },
      ...(pct === null ? [] : [{ id: 'diff_pct', label: 'Farq (%)', value: pct, unit: 'percent' as const, kind: 'computed' as const }])],
    table: undefined,
    method: `${cur.method} Solishtirish: xuddi shu ko‘rsatkich oldingi teng davr bilan${cur.period?.partial_today ? '; joriy davr tugamagani uchun oldingi davrning xuddi shu vaqtgacha bo‘lgan qismi olindi' : ''}.`,
    partial_reasons: [...cur.partial_reasons.filter((x) => !x.startsWith('Davr hali')), ...(bv === 0n ? ['Oldingi davr 0 — foiz hisoblanmadi.'] : [])],
  };
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

async function store(db: Db, pr: Principal, sessionId: string | null, question: string | null, tool: string, args: unknown, result: ToolResult | null, status: string, summary: string, trace: string, started: number, intent: string, provider = 'deterministic') {
  const rep = result ? await one<{ id: string; as_of: string }>(db, `INSERT INTO ai_report_snapshots (user_id, workspace, scope_hash, tool, arguments, result, metric_version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, as_of`,
    [pr.userId, pr.workspace, pr.scopeHash, tool, JSON.stringify(args ?? {}), JSON.stringify(result), result.metric_version]) : null;
  if (sessionId) {
    if (question !== null) await db.query(`INSERT INTO ai_messages (session_id, role, text) VALUES ($1,'user',$2)`, [sessionId, redact(question)]);
    await db.query(`INSERT INTO ai_messages (session_id, role, text, report_id, status) VALUES ($1,'assistant',$2,$3,$4)`, [sessionId, summary, rep?.id ?? null, status]);
    await db.query(`UPDATE ai_sessions SET updated_at=now(), title=COALESCE(title, $2) WHERE id=$1`, [sessionId, question ? redact(question).slice(0, 80) : null]);
  }
  await db.query(`INSERT INTO ai_query_runs (trace_id, user_id, workspace, intent, tool, status, duration_ms, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [trace, pr.userId, pr.workspace, intent, tool || null, status, Date.now() - started, provider]);
  return rep;
}

const card = (rep: { id: string; as_of: string } | null, status: string, summary: string, result: ToolResult | null, pr: Principal, sessionId: string | null, extra: Record<string, unknown> = {}) =>
  ({ report_id: rep?.id ?? null, session_id: sessionId, status, summary, result, as_of: rep?.as_of ?? new Date().toISOString(), workspace: pr.workspace, workspace_label: WS_LABEL[pr.workspace], scope_label: SCOPE_LABEL[pr.workspace], provider: 'deterministic', ...extra });

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LLM_HINT: Record<string, string> = {
  partner_earnings_summary: 'my earned commission / payouts / result after ads for a period', partner_orders_count: 'how many orders I received in a period', partner_rejections: 'cancelled/rejected orders in a period',
  partner_wallet_snapshot: 'my balance now', partner_best_day: 'my best earning day', partner_top_products: 'my best-selling products', partner_flows_performance: 'my referral links (flows) results',
  partner_uzcoin_summary: 'my UzCoin balance', partner_level: 'my level and coupon', partner_quality_cases: 'quality checks and warnings about me', partner_charity_summary: 'my charity donations',
  partner_contest_status: 'running contests', public_bestsellers: 'shop-wide best-selling products (rank only)', operator_work_queue: 'my open work queue now', operator_activity_summary: 'what I (operator) did in a period',
  admin_sales_summary: 'shop sales in a period', admin_cod_summary: 'cash on delivery collected/remitted', admin_inventory_summary: 'low / out-of-stock products', admin_operators_summary: 'operators activity', admin_partners_top: 'top partners',
};

export function registerAiBiz(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ai/biz/capabilities', tags: ['ai-biz'], summary: 'Workspaces, quick questions and connected reports for the current user', query: z.object({ workspace: z.string().max(20).optional() }) },
    async ({ actor, db, query }) => {
      const pr = await principal(db, actor, query.workspace);
      const llm = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.llm'`);
      const llmOn = !!llm?.enabled && !!getIntentClient();
      return {
        workspace: pr.workspace, workspace_label: WS_LABEL[pr.workspace], available: pr.available.map((w) => ({ key: w, label: WS_LABEL[w] })), connected: allowedTools(pr).length > 0,
        tools: allowedTools(pr), quick_questions: quickFor(pr),
        llm: { enabled: llmOn, note: llmOn ? 'Erkin savollarni AI tushunadi; raqamlar faqat hisobotlardan.' : 'Savollar tayyor qoidalar bilan tushuniladi (tashqi AI o‘chiq).' },
        voice: false, export: !!(await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.export'`))?.enabled, actions: false, timezone: 'Asia/Tashkent',
      };
    });

  route(app, deps, { method: 'POST', url: '/ai/biz/ask', tags: ['ai-biz'], summary: 'Ask in plain Uzbek (Latin/Cyrillic); answer is a stored, source-backed report card',
    body: z.object({ text: z.string().trim().min(2).max(500), session_id: z.string().uuid().nullish(), workspace: z.string().max(20).optional() }).strict() },
  async ({ actor, db, body }) => {
    const started = Date.now(); const trace = randomUUID(); const now = new Date();
    const pr = await principal(db, actor, body.workspace);
    await quota(db, pr.userId);
    const ses = await session(db, pr, body.session_id);
    const quick = quickFor(pr);
    const allowed = allowedTools(pr);
    const reply = async (status: string, summary: string, intent: string, extra: Record<string, unknown> = {}) => {
      await store(db, pr, ses.id, body.text, '', null, null, status, summary, trace, started, intent);
      return card(null, status, summary, null, pr, ses.id, extra);
    };
    const finish = async (tool: AnyTool, args: Record<string, unknown>, result: ToolResult, ctx: Ctx, provider: string) => {
      const summary = summarize(result);
      await db.query(`UPDATE ai_sessions SET context=$2 WHERE id=$1`, [ses.id, JSON.stringify(ctx)]);
      const rep = await store(db, pr, ses.id, body.text, tool, args, result, result.status, summary, trace, started, tool, provider);
      return card(rep, result.status, summary, result, pr, ses.id, { provider });
    };

    // 1) refusals before anything is read. Partners may not ask about other partners; staff rankings are permission-gated.
    const base = classify(body.text);
    if (base.kind === 'forbidden' && (pr.workspace === 'partner' || base.reason !== 'other_partner')) return reply('forbidden', REFUSAL[base.reason]!, `forbidden:${base.reason}`);

    if (base.kind === 'smalltalk') {
      const T2: Record<string, string> = {
        greeting: `Assalomu alaykum! Yaxshi, rahmat 🙂 Men ${pr.workspace === 'partner' ? 'pulingiz, buyurtmalaringiz, balans, oqimlar, UzCoin va konkurslar' : 'sizga ruxsat etilgan hisobotlar'} bo‘yicha aniq raqam bilan javob beraman. Nima bilmoqchisiz?`,
        thanks: 'Arzimaydi! Yana savol bo‘lsa yozing.',
        help: `Men faqat hisobot bo‘yicha javob beraman — raqamlar to‘g‘ridan-to‘g‘ri hisobingizdan olinadi. Davrni ham yozing: «bugun», «kecha», «shu oy», «25-oktabr». Masalan:`,
      };
      return reply('ok', T2[base.reason]!, `smalltalk:${base.reason}`, base.reason === 'thanks' ? {} : { suggestions: quick.slice(0, 6) });
    }
    // 2) «kechagisi bilan solishtir»: same report, previous equal period (equal elapsed part if still running).
    if (/solishtir|taqqosla|sravn/.test(matchForm(body.text))) {
      const c = ses.context;
      if (!c.tool || !COMPARABLE.includes(c.tool) || !c.period || !allowed.includes(c.tool)) return reply('unsupported', UNSUPPORTED.compare!, 'compare:no_context', { suggestions: quick.slice(0, 4) });
      const curP = explicitPeriod(c.period.from, c.period.to, now)!;
      const a = { metric: c.metric, status: c.status, channel: c.channel };
      const cur = await runTool(db, pr, c.tool, { ...a, period: curP }, now);
      const prev = await runTool(db, pr, c.tool, { ...a, period: previousPeriod(curP, now) }, now);
      return finish(c.tool, { ...a, compare: true, period: c.period }, compareResults(cur, prev), c, 'deterministic');
    }

    let tool: AnyTool | undefined; let metric: string | undefined; let status: string | undefined; let channel: string | undefined; let followup = false;
    let period = resolvePeriod(body.text, now, ses.context.year ?? null);
    let provider = 'deterministic';
    if (pr.workspace === 'partner') {
      if (base.kind === 'unsupported') return reply('unsupported', UNSUPPORTED[base.reason] ?? UNSUPPORTED.unknown!, `unsupported:${base.reason}`, { suggestions: quick.slice(0, 4) });
      if (base.kind === 'tool') ({ tool, metric, status, channel } = base), followup = !!base.followup;
    } else {
      tool = classifyStaff(body.text) ?? (base.kind === 'tool' && base.tool === 'public_bestsellers' ? 'public_bestsellers' : undefined);
    }

    // 3) optional LLM routing for questions the rules did not understand (no data, no identity sent; output re-validated).
    if (!tool) {
      const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.llm'`);
      const ai = flag?.enabled ? getIntentClient() : null;
      if (ai) {
        try {
          const prop = await ai.propose(body.text, ymd(localDay(now)), allowed.map((n) => ({ name: n, hint: LLM_HINT[n] ?? n })));
          if (prop.tool !== 'none' && (allowed as string[]).includes(prop.tool)) {
            tool = prop.tool as AnyTool; provider = 'llm';
            status = prop.status ?? undefined; channel = prop.channel ?? undefined;
            metric = tool === 'partner_earnings_summary' ? prop.metric ?? undefined : undefined;
            if (prop.date_from && prop.date_to_exclusive) {
              const p = explicitPeriod(prop.date_from, prop.date_to_exclusive, now);
              if (!p) return reply('unsupported', 'Davrni aniqlay olmadim. Masalan «25-oktabr» yoki «shu oy» deb yozing.', 'llm:bad_period', { provider: 'llm' });
              period = p;
            }
          }
        } catch { /* provider error → same honest answer as without AI */ }
      }
    }
    if (!tool) return reply('unsupported', UNSUPPORTED.unknown!, 'unknown', { suggestions: quick });
    if (!allowed.includes(tool)) return reply('forbidden', REFUSAL.not_granted!, `forbidden:not_granted:${tool}`);

    if (followup) {
      // «endi faqat Telegram»: same report and period, one extra allowed filter — the scope stays the server's.
      if (!ses.context.tool || !CHANNEL_TOOLS.includes(ses.context.tool)) return reply('unsupported', UNSUPPORTED.channel_followup!, 'followup');
      tool = ses.context.tool; metric = ses.context.metric; status = ses.context.status; channel = channelOf(body.text);
      period = ses.context.period ? explicitPeriod(ses.context.period.from, ses.context.period.to, now) : period;
    }
    if (period?.future) return reply('zero', UNSUPPORTED.future!, 'future');
    const ch = CHANNEL_TOOLS.includes(tool) ? channel : undefined;
    const result = await runTool(db, pr, tool, { period: period ?? undefined, metric, status, channel: ch }, now);
    const ctx: Ctx = { tool, metric, status, channel: ch, period: result.period ? { from: result.period.from, to: result.period.to_exclusive } : undefined, year: period && ['day', 'month'].includes(period.kind) ? Number(period.from.slice(0, 4)) : ses.context.year };
    return finish(tool, { metric, status, channel: ch, period: ctx.period }, result, ctx, provider);
  });

  // Structured call used by quick cards and «Filtrni o‘zgartirish»: same tools, strict schema, no identity fields.
  route(app, deps, { method: 'POST', url: '/ai/biz/tool', tags: ['ai-biz'], summary: 'Run one allow-listed report tool with explicit arguments',
    body: z.object({
      tool: z.enum(ALL_TOOLS),
      arguments: z.object({ date_from: zDate.optional(), date_to_exclusive: zDate.optional(), metric: z.enum(['commission_recognized_net', 'payout_paid', 'partner_after_ad_result']).optional(), status: z.enum(['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled']).optional(), channel: z.enum(['telegram', 'instagram', 'facebook', 'youtube', 'tiktok']).optional() }).strict().default({}),
      session_id: z.string().uuid().nullish(), workspace: z.string().max(20).optional(),
    }).strict() },
  async ({ actor, db, body }) => {
    const started = Date.now(); const trace = randomUUID(); const now = new Date();
    const pr = await principal(db, actor, body.workspace);
    if (!allowedTools(pr).includes(body.tool)) throw new AppError(403, 'AI_TOOL_FORBIDDEN');
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

  // CSV of a stored report revision: same facts as the screen, re-authorised at download, formula-safe cells.
  route(app, deps, { method: 'GET', url: '/ai/biz/reports/:id/export.csv', tags: ['ai-biz'], summary: 'Download a stored report revision as CSV (same numbers as the screen)', params: zIdParam },
    async ({ actor, db, params, reply }) => {
      requireUser(actor);
      const flag = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM feature_flags WHERE key='ai.business.export'`);
      if (!flag?.enabled) throw new AppError(403, 'AI_EXPORT_DISABLED');
      const r = await maybeOne<{ id: string; workspace: string; scope_hash: string; result: ToolResult; as_of: string }>(db, `SELECT id, workspace, scope_hash, result, as_of FROM ai_report_snapshots WHERE id=$1 AND user_id=$2`, [params.id, actor.userId]);
      if (!r) throw notFound('AI_REPORT');
      let pr: Principal;
      try { pr = await principal(db, actor, r.workspace); } catch { throw notFound('AI_REPORT'); }
      if (pr.scopeHash !== r.scope_hash) throw notFound('AI_REPORT');
      const x = r.result;
      const esc = (v: unknown) => { const s = String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1"); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const val = (f: { value: string | number | null; unit: string }) => (f.unit === 'som' && f.value !== null ? (Number(BigInt(String(f.value)) / 100n)).toString() : String(f.value ?? ''));
      const unitName: Record<string, string> = { som: 'so‘m', orders: 'buyurtma', units: 'dona', coins: 'coin', percent: '%', count: 'ta', text: '', date: 'sana' };
      const lines: string[][] = [
        ['Hisobot', x.title], ['Ko‘rsatkich', `${x.metric} v${x.metric_version}`], ['Davr', x.period ? `${x.period.label} [${x.period.from}, ${x.period.to_exclusive}) ${x.period.timezone}` : 'hozirgi holat'],
        ['Filtr', x.filters ? Object.entries(x.filters).map(([k, v]) => `${k}=${v}`).join('; ') : '—'], ['Qamrov', SCOPE_LABEL[pr.workspace]], ['Holat vaqti', new Date(r.as_of).toISOString()],
        ['Hisobot ID', r.id], ['Natija holati', x.status], ['Hisoblash usuli', x.method], ...x.partial_reasons.map((p) => ['Cheklov', p]), [],
        ['Ko‘rsatkich', 'Qiymat', 'Birlik', 'Turi'], ...x.facts.map((f) => [f.label, val(f), unitName[f.unit] ?? f.unit, f.kind === 'computed' ? 'hisoblangan' : 'kuzatilgan']),
      ];
      if (x.table?.rows.length) lines.push([], x.table.columns, ...x.table.rows.map((row) => row.cells.map((c, i) => (/Komissiya/.test(x.table!.columns[i]!) ? (Number(BigInt(String(c)) / 100n)).toString() : String(c)))));
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="uzshop-ai-${r.id.slice(0, 8)}.csv"`);
      return '\ufeff' + lines.map((l) => l.map(esc).join(',')).join('\n');
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

