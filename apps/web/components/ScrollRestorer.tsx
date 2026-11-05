'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

/**
 * Back button returns to the same place in the list (user: "orqaga qaytsam yana tepaga qaytib qolyapman").
 * Pages load their data after mount, so the browser's own restore fires while the page is still short; we remember
 * the position per URL and, after a back/forward navigation, keep trying for a few seconds until the page is tall enough.
 */
function Restorer() {
  const path = usePathname();
  const sp = useSearchParams();
  const key = `scroll:${path}?${sp.toString()}`;
  const back = useRef(false);
  useEffect(() => {
    try { history.scrollRestoration = 'manual'; } catch {}
    const onPop = () => { back.current = true; };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    let raf = 0;
    const save = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { sessionStorage.setItem(key, String(Math.round(window.scrollY))); } catch {} }); };
    window.addEventListener('scroll', save, { passive: true });
    let timer: any;
    if (back.current) {
      back.current = false;
      let y = 0; try { y = Number(sessionStorage.getItem(key) ?? 0); } catch {}
      if (y > 0) {
        const started = Date.now();
        const tryIt = () => {
          if (document.documentElement.scrollHeight - window.innerHeight >= y - 4) { window.scrollTo(0, y); return; }
          if (Date.now() - started < 4000) timer = setTimeout(tryIt, 100); else window.scrollTo(0, y);
        };
        tryIt();
      }
    }
    return () => { window.removeEventListener('scroll', save); clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [key]);
  return null;
}

export function ScrollRestorer() { return <Suspense fallback={null}><Restorer /></Suspense>; }
