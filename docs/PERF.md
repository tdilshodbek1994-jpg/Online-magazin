# Storefront speed on a slow mobile network (measured)

Date: 2026-11-04. Local build (Next.js standalone + API), demo catalog (~500 products), Chromium at 390 px with
network throttling **1.6 Mbit/s down, 150 ms RTT** (slow 4G). Script: Playwright + CDP (`Network.emulateNetworkConditions`).

| Page | First products visible | LCP | Requests | Transferred |
|---|---|---|---|---|
| `/` | 1.31 s | 2.03 s | 75 | 222 KB |
| `/catalog` | 1.31 s | 1.62 s | 53 | 206 KB |
| `/p/krossovka-run-x` | 1.35 s | 0.76 s | 41 | 214 KB |

All under the 2.5 s "good" LCP threshold. Product photos are served as resized WebP (640 / 1200 px) and lazy-loaded;
the installed app (service worker) serves repeat visits' static files from cache.

Caveats: same-machine server (no real network distance), demo illustrations instead of real photos (real photos are
heavier — keep uploads ≤ 5 MB; the server re-encodes them). Re-measure on uzshop.net after deploy.
