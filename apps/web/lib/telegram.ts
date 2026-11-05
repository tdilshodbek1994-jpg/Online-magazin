'use client';
/**
 * Telegram Mini App bridge. The same /partner pages run inside Telegram; this file only talks to Telegram's
 * official WebApp SDK (telegram.org/js/telegram-web-app.js), which is loaded ONLY when the page is opened from a bot.
 */
export interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string; username?: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  openLink(url: string, o?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { impactOccurred(s: 'light' | 'medium' | 'heavy'): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void };
}

export type TgAppName = 'partner' | 'operator';
export const TG_HOME: Record<TgAppName, string> = { partner: '/partner', operator: '/ops' };
const KEY = 'om_tg_app';

/** Which mini app this tab was opened as (kept for the whole Telegram session, survives reloads). */
export function tgAppName(): TgAppName | null {
  try { const v = sessionStorage.getItem(KEY); return v === 'partner' || v === 'operator' ? v : null; } catch { return null; }
}
export function markTgApp(app: TgAppName): void { try { sessionStorage.setItem(KEY, app); } catch {} }

export function tg(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  const w = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
  return w && w.initData ? w : null;
}

let loading: Promise<TgWebApp | null> | null = null;
export function loadTelegramSdk(): Promise<TgWebApp | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if ((window as unknown as { Telegram?: { WebApp?: unknown } }).Telegram?.WebApp) return Promise.resolve(tg());
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.async = true;
    const timer = setTimeout(() => resolve(tg()), 6000);
    s.onload = () => { clearTimeout(timer); resolve(tg()); };
    s.onerror = () => { clearTimeout(timer); loading = null; resolve(null); };
    document.head.appendChild(s);
  });
  return loading;
}

/** «rgb(255, 255, 255)» → «#ffffff» (Telegram accepts only #RRGGBB). */
export function toHex(c: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : null;
  return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
}

/** start_param from the bot link → page inside the app. Unknown values open the home page. */
export function startPath(app: TgAppName, p: string | null | undefined): string {
  const home = TG_HOME[app];
  if (!p || app !== 'partner') return home;
  const o = /^o_([0-9a-f-]{36})$/.exec(p);
  if (o) return `/partner/orders/${o[1]}`;
  const MAP: Record<string, string> = { orders: '/partner/orders', wallet: '/partner/wallet', ai: '/partner/ai', new: '/partner/new', market: '/partner/market', notifications: '/partner/notifications', stats: '/partner/stats', payouts: '/partner/payouts' };
  return MAP[p] ?? home;
}
