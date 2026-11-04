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

## P1A — done (spend read-model + landing analytics)
| Item | State |
|---|---|
| Reused from the ad/commission analytics module (0014): FX snapshots frozen at entry, versioned expenses, manual/provider reconciliation, ad-level Meta Insights adapter (read-only), cohort vs financial basis, quantity-matrix commission | reused |
| Migration `0032_landing_spend.sql`: shop-paid spend without a partner (`payer='shop'`), `landing_id`, own dedupe key, `report_level` | done |
| `POST /admin/landings/:id/spend` (finance/owner): replay by external key = same row (updated as new version), campaign/adset totals refused (`SPEND_GRAIN_NOT_AD`), manual + ad-level same days → `needs_reconcile`, split over the landing's flows (≤100%); never a wallet/ledger/journal entry | done |
| `POST /admin/landings/spend/:id/reconcile` keep provider or manual (history kept) | done |
| `GET /admin/landings/:id/analytics`: visits, orders (link vs on-behalf), reviewed/confirmed/delivered, delivered units + 1/2/3/4+ distribution, funnel %, click conversion (link orders only), delivered gross, commission waiting/available, shop spend (missing ≠ 0), cost per delivered order/unit, per-flow allocation, Meta mixed label | done |
| Partner report: Meta mixed spend stays its own channel (was shown as Instagram); new `click_conversion` ratio (partner-entered orders excluded) | done |
| Admin UI «📊 Tahlil va reklama xarajati» inside the landing editor (period, tiles, flows, spend rows, spend form with flow split, explicit zero) | done |
| Live Meta Insights for the shop account | blocked: needs owner Meta OAuth (P1B/D19) |

## P1B — done with a fake adapter; live Meta blocked (no app/credentials)
| Item | State |
|---|---|
| Migration `0033_target_campaigns.sql`: `meta_connections` (OAuth state hash bound to the admin session, 10 min, single use; AES-GCM token; scopes; provider-verified assets), `campaign_drafts` (15 states), `campaign_approvals` (digest + scope + TTL), `provisioning_operations` (unique per draft/kind/digest, `client_ref`), `remote_objects`; flag `ads.live_spend=false`; demo policy `target.approval_ttl_hours=24` | done |
| Adapter boundary `target/adapter.ts`: default = honest not-connected (authorize URL only with `META_APP_ID` + `META_GRAPH_VERSION`; everything else `NOT_CONNECTED`) | done |
| Drafts from a published landing: copy only from approved facts (hero, benefits, catalog price); AI provider stays off (`generator='template'`); ad copy guard (medical/guarantee claims, links, phones); audience 18+, only geo/age/genders | done |
| Preflight: landing revision, stock, connection + `ads_management`, verified ad account/Page/dataset, dataset = Pixel setting, account currency, budget, schedule, creative, payer shown | done |
| Owner approval bound to digest of ad account, payer, currency, budget, schedule, audience, placements, creative revision, landing revision, destination, Page, dataset, objective, policy version; edit/TTL → stale | done |
| Provision → remote objects PAUSED; double call = one op; timeout → `unknown`, retry reconciles by `client_ref` (no blind create) | done |
| Activate only with `ads.live_spend` + still-valid approval, one op; status `delivery_pending` until provider effective status; sync maps PENDING_REVIEW → delivery_pending, DISAPPROVED → rejected (+reason); protective pause without approval (`pause_requested` if no answer) | done (flag off) |
| Admin «🎯 Target» tab + `/admin/meta/callback` page | done |
| Real Graph API adapter, app review, pinned version contract tests, exposure reserve across campaigns | **blocked**: owner Meta app/credentials (D19) |

## P2A — done with a fake adapter (live spend still off)
| Item | State |
|---|---|
| Migration `0034_target_safety.sql`: `ad_safety_rules` (stock_out / landing_unpublished / price_changed, owner-approved), `ad_automation_receipts`, `ad_spend_envelopes` + `ad_envelope_reservations`, draft `synced_at`/`paused_at`/`safety_reason` | done |
| Safety evaluator (worker + `POST /admin/ad-safety/run`): only pause requests for UZSHOP-managed running campaigns; status `pause_requested` until the provider confirms PAUSED; approval revoked → restart needs a fresh owner approval (`OWNER_REAPPROVAL_REQUIRED`) | done |
| Master kill switch `POST /admin/ad-safety/kill-switch`: only campaigns with our remote ids; receipts + audit | done |
| Spending envelope: activation reserves daily×days or lifetime under a row lock; concurrent activations can never exceed it (`ENVELOPE_EXCEEDED`, `SPEND_ENVELOPE_REQUIRED`, `END_DATE_REQUIRED`) | done |
| Catalog prices are part of the approval digest (price change → stale); `price_changed` rule pauses running campaigns; ad copy price must match the catalog (`creative_price_mismatch`) | done |
| Token revoke/disconnect: response + connection health show live managed campaigns and the manual Ads Manager emergency path (never claims ads stopped) | done |
| Recommendation endpoint is advisory: stale/no sync → warning, no budget suggestion; nothing applies budgets automatically | done |
| Admin «🛡️ Xavfsizlik» panel in Target tab (rules, envelope, kill switch, receipts) | done |
| Real provider monitoring at scale, alert recipients (Telegram), live activation test with real money | **blocked**: owner Meta app + a separately approved amount/asset/time scope |

## P2B (part 1) — A/B experiments + quality regression — done
| Item | State |
|---|---|
| Migration `0035_landing_experiments.sql`: experiments (one running per landing, A = published revision, B = another revision, split), sticky assignments per subject key (no PII), `orders.experiment_snapshot`; demo evidence policy `experiments.min_evidence` | done |
| Public `/landings/:slug` serves the visitor's variant; personal responses `private, no-store` (+ `Vary`); `/tracking/config` `private, no-store` | done |
| Quick order accepts the published revision or the visitor's own variant only; snapshot stores experiment/variant/revision | done |
| Results: exposures/orders/rate per variant, pooled Σ/Σ total, verdict `insufficient_data` / `enough_data_owner_decides`; no auto-winner, no auto-publish | done |
| Admin «🧪 A/B sinov» card in the landing editor | done |
| 320px + 200% text: footer/landing no longer force horizontal scroll (manual Playwright check: scrollWidth 320 = viewport, CTA visible, focused field visible) | done |
| Domains (LT-031…040) | done (part 2, below) |

## P2B (part 2) — custom domains — done (no DNS changes by us)
| Item | State |
|---|---|
| Migration `0036_landing_domains.sql`: one active claim per host, TXT challenge token, separate `tls_status` / `meta_status`, sanitized `meta_token`, fallback chain | done |
| Ownership only via `_uzshop-verify.<host>` TXT = `uzshop-verify=<token>` (CNAME/other records ≠ proof); pending until proven | done |
| `GET /hosts/resolve` for the reverse proxy: only verified hosts, unknown → `HOST_UNKNOWN`, bounded fallback (max 3 hops), loops refused on save | done |
| Staff session guard: requests from a custom-host Origin act as anonymous (no admin rights on partner hosts) | done |
| Signed 10-minute flow token for cross-domain checkout handoff (ids only; tampered/expired rejected) | done |
| Disconnect lists dependent running campaigns; confirm → pause requests (status `pause_requested`, never claimed stopped) | done |
| Admin «🌐 Domenlar» card (TXT instructions, DNS check, SSL status, Meta code, disconnect) | done |
| Reverse-proxy wiring (Caddy/nginx host allowlist + TLS issuance) on the server | **not done**: needs the owner's domain + server change (outside this repo's deploy script) |

## Remaining P0B cases — closed
| Item | State |
|---|---|
| Multi-product landing: quick order accepts up to 5 `lines` → one order, catalog-priced; landing snapshot only if every product belongs to the landing; multi template form with per-product quantities (default CTA now «Buyurtma berish») | done |
| `promo_timer` block bound to a server-side promotion (`GET /landings/promo/:code`, server time offset; refresh never restarts; expired code refused at checkout `PROMO_NOT_APPLICABLE`); quick order accepts `promo_code` | done |
| Offline form: nothing queued or auto-sent; after reconnect live prices are reloaded and the customer must press again | done (browser-checked) |
| Ad copy claims not backed by catalog facts (certificate, warranty) → preflight `creative_unsupported_claim` | done |
| Reduced motion: Boom hero/CTA animation `none` under `prefers-reduced-motion`, normal `lp-float` otherwise | done (browser-checked) |

## Tests
- `apps/api/test/zf-landings.test.ts` (own DB `om_test_landing`): LT-001, 002, 004, 005, 008, 010, 011, 012, 013, 014, 015, 016, 020, 021, 022, 023, 026, 027, 028, 029, 030.
- P0B not yet mapped: LT-003 (parallel stock — covered by existing reservation tests, not re-run for landings), LT-006 (expired quote — existing checkout test), LT-007 (multi-product single order — storefront cart; landing multi UI not built), LT-009 (offline form — client), LT-017 (AI draft, P1B), LT-018 (reduced motion — CSS, needs browser check), LT-019 (promotion timer from backend — no timer block yet), LT-024/025 (on-behalf verification exists; tracking separation is P0C).
- `apps/api/test/zg-tracking.test.ts` (own DB `om_test_tracking`): LT-041, 042, 043, 044, 045, 046, 047, 048, 049, 050, 051, 052, 053, 054, 055, 056, 057, 058, 059, 060 + readiness/health test (15 tests).
- `apps/api/test/zh-landing-analytics.test.ts` (own DB `om_test_landing_analytics`): LT-081 (orders vs units on a landing), 082 (funnel 100/70/56 → 70/80/56), 083 (20 visits, 2 link + 2 on-behalf orders → 10%), 084, 085, 086, 087, 088 (100 000 UZS split 60/40, no ledger/journal change, partner ad stays null), 090. LT-081 matrix amount (56 orders/76 units/1 830 000) and LT-089 (cohort vs financial month) are covered by the existing `n-ad-analytics.test.ts` T07 and T32.
- `apps/api/test/zi-target.test.ts` (own DB `om_test_target`, fake adapter): LT-061…LT-070, LT-071…LT-080 + honest blocked state without app/connection + copy/audience guard (18 tests).
- `apps/api/test/zj-landing-p2b.test.ts` (own DB `om_test_landing_p2b`): LT-091, 092, 094, 095 (no server-side media URL fetch exists; internal URLs refused by the block schema), 096, 097, 098, 099, 100 (8 tests). LT-093 = manual browser check above.
- `apps/api/test/zk-domains.test.ts` (own DB `om_test_domains`, simulated DNS): LT-031…LT-040 (8 tests).
- `apps/api/test/zl-landing-remaining.test.ts` (own DB `om_test_landing_rest`): LT-003, 006, 007, 009, 017, 019, 024 + 025 (7 tests). Browser (Playwright) checks 2026-11-04: LT-018 reduced-motion animation `none`; LT-009 offline → no order, message, after reconnect price refresh and manual resubmit → 1 order with 2 lines (multi).
- LT-048 note: local outbox dedup is tested; provider-side dedup can only be verified with a real dataset (not run).
- Full run 2026-11-04 (final): `cd apps/api && pnpm vitest run` → 37 files, 285 tests passed, exit 0. Web E2E 15/15 (fresh DB, before the last web change set; re-run below).
- Acceptance coverage: 100 of 100 package cases have an automated test or a recorded browser check (provider-side behaviour — Meta dedup, real moderation, real DNS/TLS — is simulated, not run against live services). (After P0C: 32 files, 238.) Web build OK; manual browser check: consent banner appears only after the owner connects a dataset, PageView recorded after consent. Web E2E not re-run for P0C (banner hidden by default).

## Not started
Catalog ads, Facebook/Instagram lead forms, partner-owned ad accounts (each needs its own owner decision + flag); real Meta Graph adapter (blocked by the Meta app).

## Policy register (demo defaults, not approved business values)
- `tracking.server_event_max_age_days` = 7 (draft, is_demo) — provider acceptance window must be re-checked for the pinned API version.
- Consent text version `ad-2026-11-v1`, mapping `v1` — legal/cookie review is a release gate (D20).
