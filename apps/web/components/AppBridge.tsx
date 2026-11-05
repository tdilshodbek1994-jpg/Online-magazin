'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { cap, isNativeApp } from '@/lib/native';

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
  return null;
}
