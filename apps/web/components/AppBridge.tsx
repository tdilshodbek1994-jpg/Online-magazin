'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { api, getToken } from '@/lib/api';
import { appCanPush, cap, isNativeApp, PUSH_KEY } from '@/lib/native';

/** Android app only: marks the page, wires the hardware Back button (back in history, exit on the start screens). */
export function AppBridge() {
  const path = usePathname() ?? '/';
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (!isNativeApp()) return;
    document.documentElement.classList.add('native-app');
    const App = cap()?.Plugins?.App;
    if (!App?.addListener) return;
    const ROOTS = ['/', '/app', '/partner', '/ops', '/admin', '/courier'];
    const h = App.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
      if (ROOTS.includes(pathRef.current) || !canGoBack) App.exitApp?.();
      else window.history.back();
    });
    return () => { void Promise.resolve(h).then((x: any) => x?.remove?.()); };
  }, []);

  // Push: only in Firebase builds, only when the server can send, only for a logged-in person. Asked once per login.
  useEffect(() => {
    if (!appCanPush() || !getToken()) return;
    const P = cap()!.Plugins!.PushNotifications;
    let alive = true;
    const subs: any[] = [];
    void api('/features').then(async (f) => {
      if (!alive || !f.push) return;
      subs.push(await P.addListener('registration', (t: { value: string }) => {
        api('/me/devices', { method: 'POST', body: { token: t.value, platform: 'android', app_version: (/UzShopApp\/([\d.]+)/.exec(navigator.userAgent) ?? [])[1] } })
          .then(() => { try { localStorage.setItem(PUSH_KEY, t.value); } catch {} }).catch(() => {});
      }));
      // Tap on a notification → the page it is about (same-site paths only).
      subs.push(await P.addListener('pushNotificationActionPerformed', (a: { notification?: { data?: { href?: string } } }) => {
        const href = a.notification?.data?.href;
        if (href && /^\/[a-z]/.test(href)) location.href = href;
      }));
      let perm = await P.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await P.requestPermissions();
      if (perm.receive === 'granted') await P.register();
    }).catch(() => {});
    return () => { alive = false; subs.forEach((x) => x?.remove?.()); };
  }, [path === '/app']); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
