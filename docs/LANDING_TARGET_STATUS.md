# UZSHOP Landing Builder & Target AI — status

Branch `claude/online-marketplace-platform-sdtv52` · not merged to main · not deployed without the owner. No DNS, domain purchase, paid API or ad spend.

## P0A — audit (done)
- Reused, not rebuilt: Product/SKU/offer catalog, quote + idempotent order services (`/checkout/quick-order`, cart checkout), referral links (= partner flows), attribution (explicit code → last eligible click), partner-assisted orders with independent customer confirmation, commission engine (quantity matrix 30 000 → 37 500 → 52 500), UzCoin, ad-expense analytics.
- Policy D09 (attribution) already exists in code with an approved/demo window policy — unchanged.

## P0B — done (vertical slice)
| Item | State |
|---|---|
| Migration `0030_landings.sql`: landing pages, immutable revisions (trigger), flow = referral link + `landing_id` + `channel`, `orders.landing_snapshot` | done |
| Allowlisted block schema (hero, gallery, video adapter, benefits, specs, faq, delivery/returns, order form, contact, footer); plain text only; prices/stock never in a revision | done |
| Templates: simple, pro, boom (motion off under reduced-motion), multi (schema/API; storefront checkout reused) | done |
| Workflow draft → review → owner approve (bound to revision digest) → publish (atomic) → rollback/revoke/archive; optimistic lock | done |
| Public `/l/<slug>`: published revision + live catalog facts; unavailable page when out of stock (no hidden swap) | done |
| Flow on a landing (partner chooses landing + channel in Market); `/r/<code>` → `/l/<slug>` | done |
| Landing short form → existing quick order; server validates published revision + product; snapshot stored | done |
| Admin tab «🧩 Landinglar»: create, block editor (add/remove/reorder, text fields), 360/390/430 preview (no orders, no analytics), workflow buttons | done |

## P0C — done (consent + event dictionary + tracking outbox + diagnostics)
| Item | State |
|---|---|
| Migration `0031_tracking.sql`: `tracking_consents` (append-only, latest wins), `tracking_event_dictionary` v1 (from `docs/landing/contracts/event_matrix.csv`), `tracking_settings` (single owner dataset, credentials = vault reference only), `tracking_events` outbox (one opaque `event_id` per `business_key`), `tracking_dispatch_attempts`, `orders.tracking_context` | done |
| Consent: `POST /tracking/consent` (granted/denied/withdrawn, policy version); banner only when a dataset is connected; refusing never blocks ordering | done |
| Browser events `POST /tracking/events`: PageView (published landing only, never preview), ViewContent (catalog product id + server price), InitiateCheckout (server quote value). Strict schema: no client value/dataset/order total; bot UA ignored; 60/min per visitor | done |
| AddToCart recorded by the cart service only after the line was accepted (same transaction) | done |
| Lead = stored customer order/request (quick order + cart checkout), same transaction; event id returned for browser dedup | done |
| Purchase = single recognition rule: prepaid captured payment; COD delivered **and** remittance reconciled. Authorization, delivery alone, reload/replay never add a Purchase | done (D10 still owner gate) |
| Refund = internal `order.refunded` only; no negative Purchase | done |
| On-behalf (partner-assisted) orders: no partner cookie/IP/UA/fbp/fbc, no Lead from the partner session | done |
| URL sanitizer (allowlisted query keys, phone/email removed), hash-once, fbp/fbc only in valid cookie format (never generated) | done |
| Dispatcher (worker, SKIP LOCKED): re-checks consent before send, test events blocked in production, late events → `expired` with original time, timeout → `unknown` and replay with same id/time, readiness → `blocked` with reason (`tracking_disabled` / `no_dataset` / `no_credentials` / `adapter_not_connected`) | done |
| Admin «📡 Pixel / CAPI diagnostikasi» (inside Landinglar): readiness, counts by status, last success/rejection, dictionary, recent events; owner sets dataset id + on/off; tokens are never entered here | done |
| Real Meta HTTP adapter (Graph API CAPI), browser Pixel script loader, CSP allowlist | **blocked**: no Meta app/credentials/app review (D19); owner OAuth is P1 |

## Tests
- `apps/api/test/zf-landings.test.ts` (own DB `om_test_landing`): LT-001, 002, 004, 005, 008, 010, 011, 012, 013, 014, 015, 016, 020, 021, 022, 023, 026, 027, 028, 029, 030.
- P0B not yet mapped: LT-003 (parallel stock — covered by existing reservation tests, not re-run for landings), LT-006 (expired quote — existing checkout test), LT-007 (multi-product single order — storefront cart; landing multi UI not built), LT-009 (offline form — client), LT-017 (AI draft, P1B), LT-018 (reduced motion — CSS, needs browser check), LT-019 (promotion timer from backend — no timer block yet), LT-024/025 (on-behalf verification exists; tracking separation is P0C).
- `apps/api/test/zg-tracking.test.ts` (own DB `om_test_tracking`): LT-041, 042, 043, 044, 045, 046, 047, 048, 049, 050, 051, 052, 053, 054, 055, 056, 057, 058, 059, 060 + readiness/health test (15 tests).
- LT-048 note: local outbox dedup is tested; provider-side dedup can only be verified with a real dataset (not run).
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 32 files, 238 tests passed, exit 0. Web build OK; manual browser check: consent banner appears only after the owner connects a dataset, PageView recorded after consent. Web E2E not re-run for P0C (banner hidden by default).

## Not started
P1A–P2B (spend import, AI drafts, Meta OAuth + PAUSED provisioning, live activation gate, custom domains, A/B).

## Policy register (demo defaults, not approved business values)
- `tracking.server_event_max_age_days` = 7 (draft, is_demo) — provider acceptance window must be re-checked for the pinned API version.
- Consent text version `ad-2026-11-v1`, mapping `v1` — legal/cookie review is a release gate (D20).
