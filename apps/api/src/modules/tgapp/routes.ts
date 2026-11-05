import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { type Actor, can, hashToken, newToken, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, type Queryable, withTx } from '../../platform/db.js';
import { AppError, forbidden } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';

/**
 * Telegram Mini Apps. Each bot has its OWN token in the server env (never in code or chat):
 *   partner  → TELEGRAM_PARTNER_BOT_TOKEN / _USERNAME / _WEBHOOK_SECRET  (bot «Uzshop_admin» = partner cabinet)
 *   operator → TELEGRAM_OPERATOR_BOT_TOKEN / _USERNAME / _WEBHOOK_SECRET  (later)
 * The notification bot keeps TELEGRAM_BOT_TOKEN.
 *
 * Login rule: Telegram only proves «this is Telegram user N». Access to a cabinet needs a link N → UzShop account,
 * and that link is created only by someone who already proved the account: a logged-in session (phone OTP) or a
 * one-time 10-minute token made inside the logged-in website cabinet. Opening the bot alone gives nothing.
 */
export const TG_APPS = {
  partner: { env: 'TELEGRAM_PARTNER_BOT', home: '/partner', title: 'UzShop hamkor kabineti' },
  operator: { env: 'TELEGRAM_OPERATOR_BOT', home: '/ops', title: 'UzShop operator xonasi' },
} as const;
export type TgApp = keyof typeof TG_APPS;
const zApp = z.enum(['partner', 'operator']);

export function botToken(app: TgApp): string | null {
  const t = (process.env[`${TG_APPS[app].env}_TOKEN`] ?? '').trim();
  return t || null;
}
export function botUsername(app: TgApp): string | null {
  const u = (process.env[`${TG_APPS[app].env}_USERNAME`] ?? '').trim().replace(/^@/, '');
  return u || null;
}

export interface TgWebAppUser { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }
export type InitDataResult =
  | { ok: true; user: TgWebAppUser; authDate: number; startParam: string | null }
  | { ok: false; reason: 'malformed' | 'bad_hash' | 'expired' | 'future' | 'no_user' };

/**
 * Validates Telegram WebApp initData (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * data-check-string = every field except `hash`, sorted by key, "key=value" joined by "\n";
 * secret = HMAC_SHA256(key="WebAppData", bot_token); hash must equal hex(HMAC_SHA256(key=secret, data-check-string)).
 */
export function verifyInitData(initData: string, token: string, maxAgeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): InitDataResult {
  let params: URLSearchParams;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, reason: 'malformed' }; }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'malformed' };
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    if (seen.has(k)) return { ok: false, reason: 'malformed' }; // duplicated keys are never sent by Telegram
    seen.add(k);
    pairs.push(`${k}=${v}`);
  }
  pairs.sort((a, b) => (a.split('=')[0]! < b.split('=')[0]! ? -1 : 1));
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(pairs.join('\n')).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'malformed' };
  if (authDate > nowSeconds + 60) return { ok: false, reason: 'future' };
  if (nowSeconds - authDate > maxAgeSeconds) return { ok: false, reason: 'expired' };
  let user: TgWebAppUser | null = null;
  try { user = JSON.parse(params.get('user') ?? 'null') as TgWebAppUser | null; } catch { return { ok: false, reason: 'malformed' }; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return { ok: false, reason: 'no_user' };
  return { ok: true, user, authDate, startParam: params.get('start_param') };
}

const maxAge = () => {
  const n = Number(process.env.TG_WEBAPP_MAX_AGE_SECONDS ?? 86400);
  return Number.isFinite(n) && n >= 60 ? n : 86400;
};

function verifyOrThrow(app: TgApp, initData: string): Extract<InitDataResult, { ok: true }> {
  const token = botToken(app);
  if (!token) throw new AppError(503, 'TG_APP_NOT_CONFIGURED');
  const r = verifyInitData(initData, token, maxAge());
  if (!r.ok) throw new AppError(401, r.reason === 'expired' ? 'TG_INIT_EXPIRED' : 'TG_INIT_INVALID', {}, false, { reason: r.reason });
  return r;
}

// ---------- DEMO/staging gate: the whole site is behind HTTP basic auth, which Telegram's in-app browser cannot show.
// After a VERIFIED and LINKED Telegram login the API sets a signed cookie; Caddy (forward_auth → /stage-gate) lets
// that cookie through instead of the password. Off unless OM_STAGE_GATE_SECRET (≥32 chars) is set on the server.
const GATE_COOKIE = 'om_stage';
const gateSecret = () => { const s = process.env.OM_STAGE_GATE_SECRET ?? ''; return s.length >= 32 ? s : null; };
function gateSign(exp: number, secret: string): string { return createHmac('sha256', secret).update(`stage:${exp}`).digest('base64url'); }
export function gateCookieValue(nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const s = gateSecret();
  if (!s) return null;
  const exp = nowSeconds + 30 * 86400;
  return `${exp}.${gateSign(exp, s)}`;
}
export function gateCookieValid(value: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const s = gateSecret();
  if (!s || !value) return false;
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < nowSeconds) return false;
  const a = Buffer.from(gateSign(exp, s)), b = Buffer.from(m[2]!);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
function setGateCookie(reply: FastifyReply): void {
  const v = gateCookieValue();
  // SameSite=None: Telegram Web opens the mini app inside an iframe.
  if (v) reply.header('set-cookie', `${GATE_COOKIE}=${v}; Path=/; Max-Age=${30 * 86400}; Secure; HttpOnly; SameSite=None`);
}

/** The operator bot is only for staff who work the order queue. */
const OPERATOR_PERM = 'orders.read_all';
function requireAppRole(actor: Actor, app: TgApp): void {
  if (app === 'operator' && !can(actor, OPERATOR_PERM)) throw new AppError(403, 'TG_APP_ROLE_REQUIRED');
}
async function hasOperatorRole(tx: Queryable, userId: string): Promise<boolean> {
  const r = await tx.query(`SELECT 1 FROM memberships m JOIN role_permissions rp ON rp.role_code=m.role_code
      WHERE m.user_id=$1 AND m.revoked_at IS NULL AND rp.permission_code=$2 LIMIT 1`, [userId, OPERATOR_PERM]);
  return !!r.rowCount;
}

async function linkTelegram(tx: Queryable, app: TgApp, userId: string, tg: TgWebAppUser): Promise<void> {
  const other = await maybeOne<{ user_id: string }>(tx, `SELECT user_id FROM tg_app_links WHERE app=$1 AND tg_user_id=$2 FOR UPDATE`, [app, tg.id]);
  if (other && other.user_id !== userId) throw new AppError(409, 'TG_LINKED_TO_OTHER_ACCOUNT');
  // One Telegram per account per app: a new Telegram replaces the old one (the person proved both sides).
  await tx.query(`DELETE FROM tg_app_links WHERE app=$1 AND user_id=$2 AND tg_user_id <> $3`, [app, userId, tg.id]);
  await tx.query(`INSERT INTO tg_app_links (app, tg_user_id, user_id, tg_username) VALUES ($1,$2,$3,$4)
      ON CONFLICT (app, tg_user_id) DO UPDATE SET tg_username=EXCLUDED.tg_username`, [app, tg.id, userId, tg.username ?? null]);
}

export function registerTgApps(app: FastifyInstance, deps: Deps): void {
  const T = ['telegram-app'];

  // Opened from the bot: Telegram identity → session, when this Telegram is linked. Otherwise says how to link.
  route(app, deps, { method: 'POST', url: '/auth/telegram/webapp', tags: T, summary: 'Mini App login from verified Telegram initData',
    body: z.object({ app: zApp, init_data: z.string().min(20).max(4096) }).strict() },
  async ({ actor, body, db, cfg, req, reply }) => {
    const v = verifyOrThrow(body.app, body.init_data);
    const linkTok = v.startParam && /^l_[A-Za-z0-9_-]{20,40}$/.test(v.startParam) ? v.startParam.slice(2) : null;
    const res = await withTx(db, async (tx) => {
      let linkedNow = false;
      if (linkTok) {
        const t = await maybeOne<{ user_id: string }>(tx, `UPDATE tg_app_link_tokens SET consumed_at=now(), tg_user_id=$3
            WHERE token_hash=$1 AND app=$2 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id`, [hashToken(linkTok), body.app, v.user.id]);
        if (t) {
          await linkTelegram(tx, body.app, t.user_id, v.user);
          await audit(tx, null, 'telegram_app.linked', { type: 'user', id: t.user_id }, { after: { app: body.app, method: 'link_token' } });
          linkedNow = true;
        }
      }
      const l = await maybeOne<{ user_id: string; phone_e164: string; status: string }>(tx,
        `SELECT u.id AS user_id, u.phone_e164, u.status FROM tg_app_links l JOIN users u ON u.id=l.user_id WHERE l.app=$1 AND l.tg_user_id=$2`, [body.app, v.user.id]);
      if (!l) return { linked: false as const, link_token_rejected: !!linkTok, first_name: v.user.first_name ?? null };
      if (l.status !== 'active') throw new AppError(403, 'ACCOUNT_LOCKED');
      if (body.app === 'operator' && !(await hasOperatorRole(tx, l.user_id))) throw new AppError(403, 'TG_APP_ROLE_REQUIRED');
      const { token, hash } = newToken();
      const s = await one<{ id: string }>(tx, `INSERT INTO sessions (user_id, token_hash, phone_at_issue, user_agent, ip, expires_at)
          VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6)) RETURNING id`,
        [l.user_id, hash, l.phone_e164, `telegram-${body.app}-app ${String(req.headers['user-agent'] ?? '').slice(0, 200)}`, req.ip, cfg.sessionTtlHours]);
      await tx.query(`UPDATE tg_app_links SET last_login_at=now(), tg_username=$3 WHERE app=$1 AND tg_user_id=$2`, [body.app, v.user.id, v.user.username ?? null]);
      await audit(tx, { ...actor, kind: 'user', userId: l.user_id }, 'user.login', { type: 'user', id: l.user_id }, { after: { session_id: s.id, method: `telegram_${body.app}_app` } });
      return { linked: true as const, linked_now: linkedNow, token, session_id: s.id, user_id: l.user_id, home: TG_APPS[body.app].home };
    });
    if (res.linked) setGateCookie(reply);
    return res;
  });

  // Inside the mini app, after a phone-OTP login: tie this Telegram to the logged-in account.
  route(app, deps, { method: 'POST', url: '/me/telegram/apps/link', tags: T, summary: 'Link the verified Telegram user to my account',
    body: z.object({ app: zApp, init_data: z.string().min(20).max(4096) }).strict() },
  async ({ actor, body, db, reply }) => {
    requireUser(actor);
    requireAppRole(actor, body.app);
    const v = verifyOrThrow(body.app, body.init_data);
    await withTx(db, async (tx) => {
      await linkTelegram(tx, body.app, actor.userId!, v.user);
      await audit(tx, actor, 'telegram_app.linked', { type: 'user', id: actor.userId! }, { after: { app: body.app, method: 'session' } });
    });
    setGateCookie(reply);
    return { linked: true, home: TG_APPS[body.app].home };
  });

  // Website cabinet → «Telegram ilovada ochish»: one-time link that opens the bot's mini app already tied to me.
  route(app, deps, { method: 'POST', url: '/me/telegram/apps/link-token', tags: T, summary: 'One-time 10-minute link that opens the mini app tied to my account',
    body: z.object({ app: zApp }).strict() },
  async ({ actor, body, db }) => {
    requireUser(actor);
    requireAppRole(actor, body.app);
    const bot = botUsername(body.app);
    if (!bot || !botToken(body.app)) return { configured: false, url: null, expires_in_seconds: 0 };
    const recent = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM tg_app_link_tokens WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [actor.userId]);
    if (recent.n >= 10) throw new AppError(429, 'TG_LINK_TOO_MANY', {}, true);
    const token = randomBytes(18).toString('base64url');
    await db.query(`INSERT INTO tg_app_link_tokens (token_hash, app, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')`, [hashToken(token), body.app, actor.userId]);
    return { configured: true, url: `https://t.me/${bot}?startapp=l_${token}`, expires_in_seconds: 600 };
  });

  route(app, deps, { method: 'GET', url: '/me/telegram/apps', tags: T, summary: 'My Telegram mini app links' }, async ({ actor, db }) => {
    requireUser(actor);
    const rows = await many<{ app: TgApp; tg_username: string | null; linked_at: string; last_login_at: string | null }>(db,
      `SELECT app, tg_username, linked_at, last_login_at FROM tg_app_links WHERE user_id=$1 ORDER BY app`, [actor.userId]);
    return { items: (Object.keys(TG_APPS) as TgApp[]).map((a) => {
      const r = rows.find((x) => x.app === a);
      return { app: a, configured: !!(botToken(a) && botUsername(a)), bot_username: botUsername(a), linked: !!r, tg_username: r?.tg_username ?? null, linked_at: r?.linked_at ?? null, last_login_at: r?.last_login_at ?? null };
    }) };
  });

  route(app, deps, { method: 'DELETE', url: '/me/telegram/apps/:app', tags: T, summary: 'Unlink Telegram from a mini app (next open asks to link again)',
    params: z.object({ app: zApp }) },
  async ({ actor, params, db }) => {
    requireUser(actor);
    const r = await db.query(`DELETE FROM tg_app_links WHERE app=$1 AND user_id=$2`, [params.app, actor.userId]);
    if (r.rowCount) await audit(db, actor, 'telegram_app.unlinked', { type: 'user', id: actor.userId! }, { after: { app: params.app } });
    return { ok: true, removed: r.rowCount ?? 0 };
  });

  // Caddy forward_auth target (staging only). 200 = let the request through without the basic-auth password.
  app.get('/stage-gate', { schema: { hide: true } }, async (req, reply) => {
    if (gateCookieValid(readCookie(req, GATE_COOKIE))) return reply.status(200).send({ ok: true });
    // Clear a stale cookie so the next request falls back to the normal password prompt.
    return reply.status(401).header('set-cookie', `${GATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`).send({ code: 'STAGE_GATE' });
  });

  // Bot webhook: /start (and anything else) answers with one button that opens the mini app. Nothing is linked here.
  app.post('/webhooks/telegram/app/:app', { schema: { hide: true } }, async (req, reply) => {
    const parsed = zApp.safeParse((req.params as { app?: string }).app);
    if (!parsed.success) return reply.status(404).send({ code: 'NOT_FOUND' });
    const a = parsed.data;
    const secret = process.env[`${TG_APPS[a].env}_WEBHOOK_SECRET`] ?? '';
    const token = botToken(a);
    if (!secret || !token) return reply.status(503).send({ code: 'TG_APP_NOT_CONFIGURED' });
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    if (got.length !== Buffer.byteLength(secret) || !timingSafeEqual(got, Buffer.from(secret))) throw forbidden();
    const upd = req.body as { message?: { text?: string; chat?: { id?: number; type?: string } } };
    const chatId = upd.message?.chat?.id;
    if (!chatId || upd.message?.chat?.type !== 'private') return { ok: true };
    const url = `${deps.cfg.publicWebUrl.replace(/\/$/, '')}/tg/${a}`;
    const text = a === 'partner'
      ? 'Assalomu alaykum! Bu UzShop hamkor kabineti.\n\nBuyurtmalar, hamyon, mahsulotlar va AI yordamchi — hammasi shu yerda. Pastdagi tugmani bosing.\n\nBirinchi marta kirsangiz: telefon raqamingiz bilan bir marta tasdiqlaysiz, keyin kabinet o‘zi ochiladi.'
      : 'UzShop operator xonasi. Pastdagi tugmani bosing.';
    void fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: a === 'partner' ? '📱 Kabinetni ochish' : '📱 Ochish', web_app: { url } }]] } }),
    }).catch(() => {});
    return { ok: true };
  });
}
