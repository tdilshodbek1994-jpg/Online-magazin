# Reklama, komissiya va daromad analitikasi — audit, qoidalar, API, testlar

Spec: `UZSHOP_REKLAMA_KOMISSIYA_ANALITIKA_CLAUDE_TASK.txt`. Branch: `claude/online-marketplace-platform-sdtv52`.
Bu hujjat tahliliy modul haqida; buxgalteriyaning yakuniy sof foyda hisoboti emas.

## 1. Audit (§2): what existed, file by file

| Topic | Where | Finding |
|---|---|---|
| Partner links ("oqim") | `apps/api/src/modules/partners/cabinet.ts` (`/partner/streams`), `referral_links` (0006) | One code per link; delete = archive (`status='disabled'`), history kept. |
| Card amounts "Foyda / Kutilmoqda" | `cabinet.ts` streams SQL | **Foyda** = Σ `commission_accruals.target_minor` in state `available` for orders attributed to that link (all time, net of return reversals). **Kutilmoqda** = Σ target in `estimated`/`pending`. This is **commission**, not profit: no ad costs were subtracted. A figure like 24 000 is the commission sum of that link's available accruals (for example a fixed 24 000 per unit, or 10% of 240 000). It is not an error, but the "Foyda" label was misleading, so it was renamed to **"Komissiya daromadi"**. The wallet's "Yechish mumkin" (`partner_balances.available_minor`) is a separate number: it is net of payouts already requested or paid. |
| Order quantities | `order_lines.qty / canceled_qty / returned_qty` (0004) | Facts used by the commission calculation. |
| Commission service | `apps/api/src/modules/commissions/service.ts` | `computeTarget` was per line (percent / fixed per unit). `accrueForOrder` runs at order creation, `recalcOrder` journals only deltas, `promoteToPending` runs on delivery + settlement, `releaseMatured` after the hold. |
| Wallet ledger | `partner_ledger` (immutable, unique effect key), `partner_balances` projection, `rebuildBalances` | Idempotent per effect; a projection can be rebuilt from the journal. |
| Refund / return | `modules/returns/*`, `modules/payments/*` → `recalcOrder` | A return changes `returned_qty`, then commission is recomputed. A money refund does not double-reverse (T077). |
| Payout | `partners/routes.ts` `/partner/payouts`, `/admin/payouts/*` | Atomic reserve; two-person approval; a paid payout is never deleted. A later reversal becomes visible **debt**. |
| Dashboards | `cabinet.ts` `/partner/dashboard`, `/partner/stats`; `p2.ts` `/partner/insights` | Conversion used to include manual orders; it now uses web orders only and needs ≥ 30 clicks. P2 ad spend (`partner_ad_spend`) is migrated into `ad_expenses`. |

**Second algorithm?** No. The new matrix lives inside `computeOrderTargets` in the same service. Orders, recalculation, draft quotes, previews, simulation and analytics all call it (§2, §20).

## 2. Quantity-matrix commission rule (§4–§7)

* Rule kind `quantity_matrix` in `commission_rules`, with columns `fixed_minor` (base), `quantity_matrix` (bps per unit position), `commission_group`, `rounding_policy=per_unit_half_up` and `return_policy=recompute_retained_qty`.
  * The rule is versioned. Content is immutable once created (trigger). Publishing in the past is refused (`NO_RETROACTIVE_RULES`).
  * The rule only takes effect while feature flag `commission.quantity_matrix` is on.
* The percentages apply to the **base commission, not the price**:

| Units | 1st unit | 2nd unit | 3rd unit | Total at base 30 000 |
|---|---|---|---|---|
| 1 | 100% | — | — | 30 000 |
| 2 | 100% | 25% | — | 37 500 |
| 3 | 100% | 50% | 25% | 52 500 |

* **Grouping:** units are grouped inside **one order** by rule version + commission group. Variants share a group, so splitting a group over several lines never pays the 100% unit twice.
* **4+ units:** there is no invented rate. The accrual is kept with `target 0, review_required, review_reason=qty_4_no_rule` and appears in `/admin/commission-review`. Order Studio refuses such bundles (`QTY_RULE_MISSING`).
* **Snapshot:** each order line stores its rule snapshot (`commission_rule_snapshot`), and the accrual stores it too (`rule_snapshot`, `commission_group`, `group_qty`).
* **Returns** (policy shown in the admin page; it must be approved before production): commission is recomputed on the retained units and the ledger receives only the difference.
  * 3→2 units: 52 500 → 37 500 (−15 000).
  * 2→1 units: 37 500 → 30 000 (−7 500).
  * All units returned: 0.
* **Goodwill / money-only refund:** matrix commission does not change. It is never treated as a quantity return.
* **Partial deliveries:** the system ships whole orders, so there is no partial-delivery event. A repeated delivery or recalculation event changes nothing (versioned effect keys).

## 3. Expenses, allocation, FX (§10–§12)

* **`ad_expenses`** has these fields:
  * channel: `telegram_channel | telegram_ads | instagram_target | meta_mixed | organic | other`;
  * amount + currency;
  * frozen FX: `fx_rate, fx_nominal, fx_date, fx_source`, and `amount_uzs_minor` (NULL while `FX_PENDING`);
  * service period vs payment date;
  * payer: `partner | shop`;
  * kind: `planned | actual | adjustment | zero_confirmed`;
  * status: `active | needs_reconcile | superseded | void`;
  * source: `manual | csv | meta | legacy_p2`, plus `external_key`.

  Every edit is a new row in `ad_expense_versions`, with a reason.
* **Rules:**
  * `amount_uzs = amount × Rate / Nominal`, using integer arithmetic only (rates scaled to 1e6).
  * A missing rate means `FX_PENDING`. The rate is never treated as 1.
  * The latest earlier official rate is used, and its real date is shown.
  * A rate that arrives later prices only pending rows. Frozen rows never change.
* **Allocation** (`expense_allocations`) is by share or amount, and can never exceed the expense ($100 = $60 + $40). The remainder is shown as **"Taqsimlanmagan"**. Rows + unallocated = total, with no rounding loss (cumulative floor split).
* **Multi-day expenses:** they are split equally by service day. This is labelled as an analytic split, not daily provider spend.
* **Shop-paid ads** (`payer=shop`) are shown separately and never subtracted from the partner's result.
* **Unknown spend ≠ 0:** without any expense the result is `null` ("Hisob to'liq emas"). 0 only counts when the partner confirms it explicitly (`zero_confirmed`).
* **CSV import** is idempotent by `external_id`: re-importing changes only rows whose amount changed. Exported cells are formula-safe.
* **Meta Insights adapter** (`apps/api/src/modules/analytics/providers.ts`): see §8 for status.
  * Read-only, `level=ad`, `breakdown=publisher_platform`, `time_increment=1`. The key is `account|ad|platform|date`, with versioned upserts. The provider timezone is stored.
  * Only the `instagram` breakdown counts as Instagram target. Rows without a breakdown are labelled "Meta (aralash)".
  * A manual expense on the same channel and day sends the provider row to the reconciliation queue instead of adding it.
  * The token is encrypted server-side and never returned.
  * Telegram channel-admin payments are entered manually or by CSV. Telegram Ads is a separate channel.

## 4. Sources (§9)

* `campaign_placements` gives each Telegram post or Instagram campaign its own short link `/r/{code}` under a root link.
* The touch stores `placement_id`. Orders store `attribution.placement_id` and `attribution.source_channel`.
* Capture mode (`orders.channel`: `web` vs `partner_assisted`) is separate from the source. For manual orders the partner may choose their own placement; the server checks ownership.
* Old links spread on both Telegram and Instagram without a placement remain **"Manba ajratilmagan"** (no guessed split).

## 5. Reports (§13–§17)

`apps/api/src/modules/analytics/report.ts` (read-only):

* **financial** — commission recognised in the period, read from ledger moves into `available` minus later reversals. Ad costs whose service days fall in the period. Payouts never change income.
* **cohort** — orders acquired in the period. Acquisition time is the click (touch) time for click-based orders and the created time for manual or explicit-code orders; each order is shown in its current state.
* Both reports return `report_basis` and `as_of`.
* **Periods:** today / yesterday / this or last week / this or last month / this or last year / custom, in Asia/Tashkent, as `[from, to)`, with weeks Monday–Sunday.
* **Ratios** are computed as sum/sum over distinct orders. A zero denominator gives `null` ("Hisoblanmaydi"), never 0%, 100% or ∞.
* **USD view:** each item is converted at the official USD rate of its own date. It is labelled as a display equivalent, not real dollars.
* **Monthly text** comes from a deterministic template. The average per revenue link is labelled "bu o'rtacha — har biri shuncha degani emas".
* **Month close** writes versioned snapshots (`monthly_report_snapshots`). Closing the same month again adds a "qayta hisoblandi" version and never overwrites.

## 6. API (all partner endpoints are scoped to the caller's partner; other ids return 404)

| Endpoint | Purpose |
|---|---|
| `GET /partner/analytics/dashboard?period&from&to&basis&currency&channel&product_id` | Cards, counts, ratios, completeness, links, unallocated spend, channels, series, summary, comparison with the previous equal period, wallet |
| `GET /partner/links/:id/analytics?…` | The same engine filtered to one link, plus its orders, expenses, rule and formulas |
| `GET /partner/analytics/export.csv?…` | CSV; the header carries period, timezone, basis, currency, FX method, as_of and completeness |
| `POST /partner/analytics/simulate` | TAXMIN estimate; writes nothing |
| `GET /partner/products/:id/commission-preview` | Commission for 1/2/3/4 units (same function as orders) |
| `GET/POST /partner/links/:id/placements`, `POST /partner/placements/:id/archive`, `GET /partner/placements` | Telegram/Instagram tracking links |
| `POST/PATCH/GET /partner/ad-expenses`, `POST …/:id/void`, `GET …/:id/versions`, `POST …/import`, `POST …/:id/reconcile` | Expenses (Idempotency-Key supported on create) |
| `POST /partner/providers/meta/connect`, `POST …/meta/sync`, `GET /partner/providers/status` | Provider (needs flag `ads.provider_sync`) |
| `POST /admin/commission-rules/preview`, `POST /admin/commission-rules/matrix` (step-up), `GET /admin/commission-review` | Admin rules |
| `POST /admin/fx`, `POST /admin/fx/sync-cbu`, `POST /admin/reports/close-month`, `GET /partner/reports/monthly` | FX and month snapshots |

Error codes include: `QTY_RULE_MISSING`, `NO_RETROACTIVE_RULES`, `MATRIX_INVALID`, `ALLOCATION_EXCEEDS_EXPENSE`, `SERVICE_PERIOD_INVALID`, `VERSION_CONFLICT`, `PROVIDER_SYNC_DISABLED`, `PROVIDER_NOT_CONNECTED`, `PROVIDER_SYNC_FAILED`, `FX_SOURCE_UNAVAILABLE` and `PERIOD_INVALID`.

## 7. Migration / rollback

* **Migration** `apps/api/migrations/0014_ad_commission_analytics.sql` is additive only:
  * it adds new tables and columns;
  * the commission_rules CHECKs are widened (the old kinds keep their meaning);
  * P2 spend rows are copied into `ad_expenses`, and the originals stay in `partner_ad_spend`.
* **Backup:** `scripts/server/deploy-from-git.sh` takes a `pg_dump` before every deploy.
* **Rollback:** restore that dump, or drop the new tables and columns (no existing data was changed).
* **Feature flags** (independent):

| Flag | Default |
|---|---|
| `commission.quantity_matrix` | off in production |
| `analytics.partner_v2` | on |
| `ads.provider_sync` | off |

  The DEMO filler turns the matrix flag on.
* **Old data:** nothing was back-filled with guesses. Old orders keep their snapshots; old links without placements stay "unknown".

## 8. Acceptance map (T01–T40)

Test file: `apps/api/test/n-ad-analytics.test.ts`. "Passed" means it ran green in `pnpm --filter @om/api test`.

| T | Status | Where |
|---|---|---|
| T01–T03, T07, T09–T11, T14 | passed | unit tests of `computeOrderTargets` |
| T04, T05 | passed | unit + integration (two variants → 30 000 + 7 500) |
| T06 | passed | 4 units → review; studio `QTY_RULE_MISSING` |
| T08, T36, T37 | passed | ratios with distinct orders; null on zero denominators; rows + unallocated = totals |
| T12 | passed | repeated recalculation changes nothing (vertical test) |
| T13 | n/a | whole-order shipping only; covered by event idempotency (T12) |
| T15 | passed | new version does not touch the old snapshot; no retroactive publish |
| T16 | passed (existing) | `c-partner.test.ts` payout then reversal → visible debt, payout kept |
| T17, T29 | passed | $250 − $100 = $150 (USD view); Rate/Nominal exact; FX_PENDING |
| T18 | passed | expense does not change the wallet |
| T19, T20 | passed | unknown ≠ 0; zero_confirmed; shop-paid not subtracted |
| T21, T22 | passed | 60/40 split; unallocated kept; exact sums |
| T23–T25 | passed with **mock** provider rows | reconcile queue; versioned re-import; ad-level grain, platform split |
| T26, T27, T28 | passed | unknown source kept; placement → channel; capture mode separate; other partner gets 404 |
| T30 | passed | frozen FX; later rate prices only pending rows |
| T31 | passed | Tashkent week/month boundaries |
| T32 | passed | cohort (last month) vs financial (this month) |
| T33 | passed | versioned month snapshots |
| T34, T35, T38 | passed | averages labelled; archived link stays in totals |
| T39 | passed | not connected → explicit error; token never returned |
| T40 | partly | Mobile screenshots, light theme; E2E 15/15 incl. axe on the new pages; wallet regression = full API suite 146/146 |

**Not done or not verified (honest list):**
* The Meta adapter has **not** been run against a live ad account. The API version and permissions (e.g. `ads_read`) must be confirmed when a real account is connected.
* No live CBU fetch in tests: CBU sync is implemented, but the tests use manual rates.
* The performance goals (p95 ≤ 1 s on 100 000 orders / 1 000 links; ≤ 10 s refresh) were **not measured**. Aggregation is computed on request. There is no `analytics_daily` projection yet.
* Live updates use 30 s polling while the tab is visible, not SSE.
* Export is CSV only; XLSX is not done.
* No AI is used for any number or for the summary text.
* The shadow comparison of old vs new commission was not run, and there was no production data to compare.

In the DEMO data all commission recognition happens on the day the filler runs: ledger rows are immutable, so their timestamps cannot be back-dated. The financial report therefore shows that day's recognitions; the cohort report spreads the orders over their real acquisition dates.
