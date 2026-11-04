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

## Tests
- `apps/api/test/zf-landings.test.ts` (own DB `om_test_landing`): LT-001, 002, 004, 005, 008, 010, 011, 012, 013, 014, 015, 016, 020, 021, 022, 023, 026, 027, 028, 029, 030.
- P0B not yet mapped: LT-003 (parallel stock — covered by existing reservation tests, not re-run for landings), LT-006 (expired quote — existing checkout test), LT-007 (multi-product single order — storefront cart; landing multi UI not built), LT-009 (offline form — client), LT-017 (AI draft, P1B), LT-018 (reduced motion — CSS, needs browser check), LT-019 (promotion timer from backend — no timer block yet), LT-024/025 (on-behalf verification exists; tracking separation is P0C).
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 31 files, 223 tests passed, exit 0. Web E2E 15/15.

## Not started
P0C (consent records, event dictionary from `contracts/event_matrix.csv`, tracking outbox, Pixel/CAPI adapter with `blocked_reason` while no Meta credentials), P1A–P2B (spend import, AI drafts, Meta PAUSED provisioning, live activation gate, custom domains, A/B).
