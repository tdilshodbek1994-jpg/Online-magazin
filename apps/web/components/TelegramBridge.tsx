'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { loadTelegramSdk, markTgApp, TG_HOME, tg, tgAppName, toHex, type TgAppName } from '@/lib/telegram';

/**
 * Runs only when the site is opened as a Telegram Mini App (entry /tg/<app>, or a reload inside Telegram):
 * tells Telegram the app is ready, expands it, matches the header colour, drives Telegram's Back button and opens
 * outside links through Telegram. On the normal website it does nothing and loads nothing.
 */
export function TelegramBridge() {
  const path = usePathname() ?? '/';
  const router = useRouter();
  const [app, setApp] = useState<TgAppName | null>(null);
  const backRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const fromPath = /^\/tg\/(partner|operator)(\/|$)/.exec(location.pathname)?.[1] as TgAppName | undefined;
    if (fromPath) markTgApp(fromPath);
    const name = tgAppName();
    if (!name && !location.hash.includes('tgWebAppData')) return;
    let cancelled = false;
    void loadTelegramSdk().then((w) => {
      if (!w || cancelled) return;
      const a = name ?? 'partner';
      markTgApp(a);
      document.documentElement.classList.add('tg-app');
      try {
        w.ready();
        w.expand();
        if (w.isVersionAtLeast('7.7')) w.disableVerticalSwipes?.(); // scrolling a long list must not close the app
        const bg = toHex(getComputedStyle(document.body).backgroundColor);
        const head = toHex(getComputedStyle(document.querySelector('header.top') ?? document.body).backgroundColor);
        if (w.isVersionAtLeast('6.1')) { if (head) w.setHeaderColor(head); if (bg) w.setBackgroundColor(bg); }
        if (bg && w.isVersionAtLeast('7.10')) w.setBottomBarColor?.(bg);
      } catch {}
      setApp(a);
    });
    return () => { cancelled = true; };
  }, []);

  // Telegram's own Back button: shown everywhere except the app's home and entry pages.
  useEffect(() => {
    const w = tg();
    if (!app || !w || !w.isVersionAtLeast('6.1')) return;
    const home = TG_HOME[app];
    if (backRef.current) w.BackButton.offClick(backRef.current);
    if (path === home || path.startsWith('/tg/')) { w.BackButton.hide(); return; }
    const onBack = () => { if (window.history.length > 1) router.back(); else router.replace(home); };
    backRef.current = onBack;
    w.BackButton.onClick(onBack);
    w.BackButton.show();
  }, [app, path, router]);

  // Links that leave the site (t.me share, Instagram, maps…) go through Telegram instead of replacing the app.
  useEffect(() => {
    if (!app) return;
    const onClick = (e: MouseEvent) => {
      const w = tg();
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!w || !a || e.defaultPrevented || e.button !== 0) return;
      let u: URL;
      try { u = new URL(a.href, location.href); } catch { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (u.origin === location.origin && a.target !== '_blank') return;
      e.preventDefault();
      if (u.hostname === 't.me' || u.hostname === 'telegram.me') w.openTelegramLink(u.href);
      else if (u.origin === location.origin) router.push(u.pathname + u.search + u.hash);
      else w.openLink(u.href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [app, router]);

  return null;
}
