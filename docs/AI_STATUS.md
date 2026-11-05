# AI Business Assistant — status

Package: `docs/ai/` (owner task v1.0, 2026-11-05: TXT, contracts, 100 acceptance cases, 18 golden examples, decisions).
Branch `claude/online-marketplace-platform-sdtv52`. Not merged to main, not deployed by Claude. No paid provider was turned on.

## Audit (existing code this builds on)

| Area | Existing service / file | Used by AI as |
|---|---|---|
| Auth, roles, grants | `platform/auth.ts` (`loadActor`, memberships → role_permissions); roles: owner, catalog_manager, operator, warehouse, courier, finance, partner, customer | workspace derivation (server only) |
| Partner identity | `partners.user_id`, `myPartner()` in `partners/routes.ts` | partner scope (`partners.id`), never from arguments |
| Orders + current state | `orders` (`attributed_partner_id`, `attribution.link_id`, `channel`), `BUCKET_SQL` in `partners/cabinet.ts` | orders cohort + mutually exclusive current state |
| Order events | `order_status_events` (dimension, to_status, created_at) | rejections/cancels by event time |
| Commission ledger | `partner_ledger` (immutable, buckets external/estimated/pending/available/reserved/paid/debt), `partner_balances`, `commission_accruals` | «topdim», wallet snapshot, best day |
| Payout | `partner_ledger` source_type `payout`, to `paid` | payout_paid |
| Flows | `referral_links` (channel), `referral_touches` (eligible) | flows table, channel filter |
| UzCoin | `uzcoin_balances`, `uzcoin_ledger`, `currentRate()` | coin balance (rate from service) |
| Levels | `partner_level_state`, `partner_level_defs`, `partner_commission_coupons` | level / coupon status |
| Quality | `quality_cases`, `quality_warnings` | open cases (signal, not fault) |
| Charity | `charity_donations` | donated amounts |
| Contests | `contests` (legacy), `cc_contests` + `cc_versions` + `cc_enrollments` | active list (rank not yet wired) |
| Existing AI | `modules/ai` (shopping advisor, Anthropic adapter `claude.ts`, flag `ai.enabled`, `ai_usage`) | reused later for LLM intent (P0B) |

## P0A — done (partner workspace, read-only, deterministic)

| Item | State |
|---|---|
| Migration `0039_ai_business_assistant.sql`: flags `ai.business.read` (on) / `.llm` `.voice` `.export` `.actions` (off); `ai_sessions`, `ai_messages` (redacted), `ai_report_snapshots` (immutable revision + scope_hash), `ai_query_runs` (trace, no PII), `ai_feedback` | done |
| Gateway `modules/aibiz/routes.ts`: principal from auth (customer → 403 `AI_FORBIDDEN`; unknown workspace → 403), kill switch 503, per-user daily quota 429, strict zod schemas (`additionalProperties=false`), no SQL/eval/shell path | done |
| Date resolution `aibiz/dates.ts`: Asia/Tashkent, [start, end_exclusive), bugun/kecha/o‘tgan hafta (Mon–Sun)/shu hafta/oxirgi N kun/shu oy/o‘tgan oy/«25 oktabr» (year: context, else nearest past)/ISO/dd.mm.yyyy/year; future → no query | done |
| Intent `aibiz/intent.ts`: Latin + Cyrillic (transliteration), refusals first (other partner, customer PII, secrets), channel follow-up «endi faqat Telegram» | done |
| Tools `aibiz/tools.ts`: earnings (recognized net commission; bonus/penalty/payout/pending shown separately), payout_paid, orders created cohort + current state + origin, rejections by event time, wallet snapshot, best day (ties shown), top products (delivered units), shop bestsellers (rank only, ≥3 orders), flows, UzCoin, level, quality, charity, contests (partial) | done |
| Answer card: summary → period/filter/metric chips → primary fact → facts → table (cards on phones) → source links (server-built) → partial reasons → «Hisoblash usuli» → open button → feedback | done |
| Stored report re-authorised on fetch (user + workspace + scope hash) → else 404; chat history drops reports whose scope changed | done |
| Web `/partner/ai` (quick questions, chat, cards), menu + dashboard tile | done |

Tests: `apps/api/test/zn-aibiz.test.ts` (own DB `om_test_aibiz`, real PostgreSQL, real auth) — 28 tests: dates/intent units, customer denial, workspace denial, kill switch, first vertical (ledger = wallet, only own evidence, Cyrillic = Latin, partner B isolation), follow-up filter, refusal stores no report and reads nothing, strict schema rejects identity fields, report IDOR 404, cohort buckets sum, rejection by event, future date, unknown question, redacted history, every tool on the real schema.

## Not done yet (honest)

| Item | Why / next |
|---|---|
| Operator, operator lead, admin, superadmin reports | P0B. Workspaces are detected; `/ask` answers «keyingi bosqichda ulanadi», no numbers |
| LLM intent (Claude via existing adapter) | P0B; flag `ai.business.llm` off; needs owner OK on provider/budget/data policy (D14, D17) |
| «Reklamadan keyingi natija» (commission − partner-paid allocated ads) | needs mapping to `ad_expenses`/`expense_allocations` proration; answered as «ulanmagan» |
| Compare periods, forecast | P1/P2; answered as unsupported |
| Contest rank in answer | wire `cc_rankings`; currently partial with link |
| Export, voice, action drafts, scheduled reports | P1/P2 (flags off) |
| `docs/ai/tests/acceptance_cases.json` | all still `not_run` in the file; mapping to code tests comes with P0B |

## Metric decisions (proposals, owner to confirm — D07/D15)

- «Pul topdim» = recognized net commission: ledger moves of accrual commission INTO «available» in the period minus reversals of available commission in the period. Pending, bonus, penalty and payouts are separate facts.
- «Buyurtma oldim» = created cohort; states are mutually exclusive current buckets, so they add up to the total.
- «Otkaz» = distinct orders with a cancel/reject event in the period (not «created then rejected»).
- Shop bestsellers: rank + product only, delivered units, products with < 3 delivered orders suppressed.
