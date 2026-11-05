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

## P0B — done

| Item | State |
|---|---|
| Operator workspace: own queue now (open, overdue, callbacks due, 3+ attempts; backend priority order), own actions in a period (confirmed/cancelled by me, my recorded calls by outcome) — `aibiz/staff.ts` | done |
| Admin workspace by permission: `reports.read` → sales + operators; `payments.read`/`cod.confirm` → COD; `inventory.write` → stock. Superadmin (owner) additionally gets partner ranking (names, no contacts) | done |
| Sales: delivered amount/orders/units by delivery date + created cohort states; explicitly «not cash yet». COD: outstanding now / collected / remitted / in transit kept separate | done |
| Operators view: calls, called orders (denominator), confirmed, cancelled — with the «not a fault/penalty» note | done |
| Compare «kechagisi bilan solishtir»: same tool, previous equal period; while the current period runs, only the same elapsed part of the previous one | done |
| «Reklamadan keyingi natija»: recognized net commission − partner-paid active ads prorated to the period's days; FX-missing rows reported, never counted as 0; not called «sof foyda» | done |
| LLM routing (`aibiz/llm.ts`): only when rules do not understand; Claude (official SDK, structured output, effort low, server-side refusal fallback `fallbacks: "default"`); sees question (PII-masked), today and allowed tool names only; output re-validated (allow-list, period ≤ 366 days, no future); any error → honest «tushunmadim». Needs `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` on the server AND flag `ai.business.llm` on | done (off until the owner sets the key and the flag) |
| Web: shared `components/AiChat.tsx`; `/admin/ai` (owner/finance/catalog/warehouse), `/ops/ai` (operator), workspace switch for multi-role users; staff bar link «🤖 AI»; partner home card | done |

Tests now 36 in `zn-aibiz` (+ operator isolation, operator denied shop sales, owner reports, finance/catalog permission split, compare, after-ad, LLM off/on/allow-list/bad period/provider error with a fake client — no network). Full suite: 39 files, 331 tests passed (local).

## P1 (part) — done

| Item | State |
|---|---|
| Contest place in the partner answer: legacy board or Contest Center snapshot (final > provisional) / live provisional; other partners’ numbers never returned | done |
| CSV export of a stored report revision (`GET /ai/biz/reports/:id/export.csv`): same facts as the screen, metadata (metric/period/timezone/as_of/scope/method/limits), re-authorised at download, formula-safe cells, BOM for Excel; flag `ai.business.export` on (migration 0040) | done |
| Compact answer card (meta line, one big number, ≤3 facts, ≤5 rows linked to orders/products, details folded) | done |

Tests: `zn-aibiz` 38 passed.

## Not done yet (honest)

| Item | Why / next |
|---|---|
| Operator lead («Jamoa») workspace | there is no team-membership model with effective_from/to in the schema yet; owner sees all operators instead |
| XLSX/PDF export, voice, action drafts, scheduled summaries, forecasts | P1/P2, flags off |
| Real LLM run | not executed by Claude: no key here and no paid provider was turned on |
| `docs/ai/tests/acceptance_cases.json` | still `not_run` in the file; code tests cover the P0 paths listed above |

## Metric decisions (proposals, owner to confirm — D07/D15)

- «Pul topdim» = recognized net commission: ledger moves of accrual commission INTO «available» in the period minus reversals of available commission in the period. Pending, bonus, penalty and payouts are separate facts.
- «Buyurtma oldim» = created cohort; states are mutually exclusive current buckets, so they add up to the total.
- «Otkaz» = distinct orders with a cancel/reject event in the period (not «created then rejected»).
- Shop bestsellers: rank + product only, delivered units, products with < 3 delivered orders suppressed.
