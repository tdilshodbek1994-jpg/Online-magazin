'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Installable app (PWA): registers the service worker and offers "Ilovani o‘rnatish".
 * Android/Chrome gets the real install prompt; iPhone Safari gets the 2-step hint (Apple has no prompt API).
 * Hidden when already installed, on checkout, and for 14 days after "Keyinroq".
 */
const KEY = 'om-install-dismissed';
let deferred: any = null;
const listeners = new Set<() => void>();

export function canInstall() { return !!deferred; }
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  deferred.prompt();
  const r = await deferred.userChoice.catch(() => null);
  deferred = null; listeners.forEach((f) => f());
  return r?.outcome === 'accepted';
}

const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

export function InstallApp() {
  const path = usePathname();
  const [, force] = useState(0);
  const [show, setShow] = useState<'' | 'android' | 'ios'>('');
  useEffect(() => {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const onPrompt = (e: any) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()); };
    const onInstalled = () => { deferred = null; setShow(''); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const re = () => force((n) => n + 1);
    listeners.add(re);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); listeners.delete(re); };
  }, []);
  useEffect(() => {
    // Not for automated browsers (tests), not inside cabinets (staff work tools), not when already installed.
    if (isStandalone() || (navigator as any).webdriver || /^\/(admin|ops|courier)/.test(path ?? '')) return;
    let dismissed = 0;
    try { dismissed = Number(localStorage.getItem(KEY) ?? 0); } catch {}
    if (Date.now() - dismissed < 14 * 864e5) return;
    const t = setTimeout(() => setShow(deferred ? 'android' : isIos() ? 'ios' : ''), 6000);
    return () => clearTimeout(t);
  }, [path]);
  if (!show || /^\/(checkout|login|confirm|pay|f\/|t\/)/.test(path ?? '')) return null;
  const later = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} setShow(''); };
  return (
    <div className="install-bar" role="dialog" aria-label="Ilovani o‘rnatish">
      <img src="/icons/icon-192.png" alt="" width={44} height={44} />
      <div className="ib-text">
        <b>UzShop ilovasi</b>
        {show === 'ios'
          ? <small>Pastdagi <span aria-label="Ulashish">⬆️</span> «Ulashish» tugmasini bosing → «Ekranga qo‘shish»</small>
          : <small>Telefoningizga o‘rnating — tezroq ochiladi</small>}
      </div>
      {show === 'android' && <button className="btn sm" onClick={async () => { await promptInstall(); setShow(''); }}>O‘rnatish</button>}
      <button className="ib-close" aria-label="Keyinroq" onClick={later}>×</button>
    </div>
  );
}

/** A permanent "Ilovani o‘rnatish" row (account page) — works whenever the browser allows installing. */
export function InstallRow() {
  const [, force] = useState(0);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(true);
  useEffect(() => { setIos(isIos()); setStandalone(isStandalone()); const re = () => force((n) => n + 1); listeners.add(re); return () => { listeners.delete(re); }; }, []);
  if (standalone) return null;
  if (canInstall()) return <button type="button" className="link-row" onClick={() => promptInstall()}>📲 Ilovani telefonga o‘rnatish</button>;
  if (ios) return <p className="small muted">📲 Ilova qilib o‘rnatish: Safari’da «Ulashish» ⬆️ → «Ekranga qo‘shish».</p>;
  return null;
}
