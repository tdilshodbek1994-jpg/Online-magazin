# UZSHOP PRO — Contest Center: status

Branch: `claude/online-marketplace-platform-sdtv52` · Not merged to `main`, not deployed (owner approval required).

## Audit (what existed, reused)
- Orders / order lines / attribution (`orders.attributed_partner_id`, `attribution.link_id`), COD settlement (`payment_status='paid'` after finance confirms the courier remittance).
- Commission ledger: `commission_accruals` (estimated → pending → available, `recalcOrder` on returns/cancels), quantity-matrix rules (30 000 base: 1→30 000, 2→37 500, 3→52 500).
- Wallet: `bonus_awards` + `transfer()` + journal — money prizes go through it (`source='cc_prize'`, once per award).
- Old simple contests (`contests`, `/admin/contests`, `/partner/programs`) are **kept untouched**; the Contest Center is a new module (`cc_*`).

## P0 — done (backend)
| Area | State |
|---|---|
| Migration `0025_contest_center.sql` (contests, versions, enrollments, score journal, rankings, appeals, prizes, awards) | done |
| Status machine draft→review→approved→scheduled→active→calculating→appeal_window→finalized→awarded (+paused/canceled) | done (lazy clock for scheduled→active→calculating) |
| Owner-only approve / publish / cancel / finalize / award / corrections; RBAC server-side | done |
| Versioned rules: live contest edit needs a reason → new version, recompute, history kept | done (C12) |
| Voluntary join/leave, terms version, `partners_joined_after` eligibility | done |
| Score engine from orders + ledger; provisional (delivered) vs final (delivered + paid); delta journal, idempotent | done (C02, C05, C07) |
| Metrics: settled orders, settled units, confirmed commission, net sales; product/category filters | done |
| Late refund → adjustment row (−15 000), never rewrites history | done (C04, C19) |
| Ranking with announced tie-break, equal rank on full tie, min score | done (C09) |
| Close → provisional snapshot + appeal window; appeals; finalize once (unique index) | done (C06, C11) |
| Prizes: place prizes, stock-safe awards, money → wallet, item fulfilment statuses, expiry | done (C10, C16, C17) |
| Leaderboard (aliases unless consent, my place, as-of, offset cursor), "me" with counted orders (masked) + funnel | done (C01, C08) |
| Dry-run simulation, CSV export (formula-injection safe), audit for every action | done |
| Admin web: tab «Konkurs markazi» (create draft + prizes, status buttons with owner checks, dry-run, recompute, cancel, appeals queue, awards, CSV) | done |
| Partner web: `/partner/contests` (groups, my prizes) and `/partner/contests/[id]` (rules, revisions, prizes, join with name consent, my provisional/final result + counted orders, leaderboard with as-of and warning, appeal form) | done |

## Tests
- `apps/api/test/zb-contest-center.test.ts` — own database `om_test_contest` (spec: new tests on a separate DB).
- Web E2E smoke: 15/15 passed after the screens were added (2026-11-04).
- Last full run: `cd apps/api && pnpm vitest run` → **27 files, 190 tests passed, exit 0** (2026-11-04).
- Covered: C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12, C16, C17, C18, C19.
- Not covered yet: C13–C15 (ad analytics wording/allocation inside contests — existing ad analytics tests cover allocation; contest ROI metric not built), C20 (TAQVIM is a different repo — untouched).
