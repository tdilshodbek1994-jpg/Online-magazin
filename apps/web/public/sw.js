/* UzShop service worker — keeps the installed app fast and shows a friendly page when offline.
 * Rules: API calls are never cached (prices, stock and orders must always be live);
 * hashed Next.js assets and product photos are cached; pages are network-first with an offline fallback. */
const VERSION = 'uzshop-v1';
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll([OFFLINE, '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live

  // Hashed build assets and media never change under the same URL: cache-first.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(STATIC).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic' && !url.pathname.startsWith('/media/v/')) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Pages: network first; when offline show the last copy of that page or the offline screen.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && !/^\/(partner|admin|ops|courier|account|orders|checkout|confirm)/.test(url.pathname)) {
        const copy = res.clone(); caches.open(PAGES).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(async () => (await caches.match(req)) || (await caches.match(OFFLINE))));
  }
});
