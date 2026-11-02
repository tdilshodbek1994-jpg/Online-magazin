# Тест ҳисоботи (реал лог асосида)

**Охирги тўлиқ ишга тушириш:** Phase 1 якунлаш commit'лари (`5d85f1f`…); GitHub Actions run 41486738015 (`15a1f95`) — success. **Муҳит:** ONLINE-MAGAZIN-DEV сандбокс, Linux, Node 22.23.4, PostgreSQL 16.15 (локал), Chromium (Playwright 1.64). **Сана:** 2026-11-02.

| Тўплам | Буйруқ | Passed | Failed | Skipped |
|---|---|---|---|---|
| Shared unit (пул, тақсимот, телефон, транслитерация) | `pnpm --filter @om/shared test` | 19 | 0 | 0 |
| API integration, реал PostgreSQL (`om_test` ҳар сафар янгидан) | `pnpm --filter @om/api test` | 75 | 0 | 0 |
| Браузер E2E (web :3000 → api :4000, seed DEMO), axe-core WCAG скани ва offline сценарийси билан | `node apps/web/e2e/smoke.mjs` | 12 | 0 | 0 |
| TypeScript | `pnpm -r typecheck` (api, shared, web) | ✓ | — | — |
| Web production build | `next build` | ✓ | — | — |
| Restore drill (DB + media) | `MEDIA_DIR=… scripts/restore-drill.sh` | 8/8 текширув OK | — | — |
| Юклама (10k SKU/100k order) | `scripts/load/run.mjs` | 0 хато, 0 oversell, read p95 505 ms | — | — |
| PostgreSQL restart | docs/LOAD_TEST.md | API 0.03 с да тайёр, ҳолат бир хил | — | — |
| Dependency audit | `pnpm audit --prod --audit-level high` | 0 high/critical (2 moderate) — CI дастлаб `sharp@0.34.5` даги high заифликни топди, 0.35.5 га янгиланди | — | — |
| Docker images + Compose | `docker build` (proxy CA build secret) + `docker compose up` | api/web image қурилди; postgres, migrate, api, worker, web ишлади; ready 200, web 200, proxy 200 | — | — |

API тест файллари: `apps/api/test/b-order-flow.test.ts` (B босқич E2E + қидирув), `c-partner.test.ts` (ҳамкорлик, комиссия, payout), `d-integrity.test.ts` (параллеллик, idempotency, Payme/Click контракт, refund, рухсатлар, ҳисобот, миграция, журнал).

## Тестлар топган ва тузатилган хатолар
1. Гость саватни мавжуд саватга бирлаштиришда `carts` CHECK бузилар эди (T023).
2. Attribution тузатишда SQL параметр типи (T040).
3. Каталог қидирувида ORDER BY subquery ташқарисида (`p.published_at`) — қидирув 500 қайтарар эди (E2E).
4. SKU бўйича аниқ қидирув токенларга бўлиниб ишламас эди.
5. Checkout'да «оферта» ёзуви ҳавола бўлгани учун checkbox ўрнига бошқа саҳифага ўтиб кетар эди (E2E).
6. Ҳамкор саҳифаси хатоликда ариза формасини кўрсатар эди.
7. Тармоқ узилиши/сўров бекор бўлиши фойдаланувчини тизимдан чиқариб юборар эди (Header).
8. Ҳамкорлар рўйхатини фақат кўриш учун ҳам step-up сўралар эди.
9. Каталог/қидирув юкламада секин эди (p95 1.6 с → 505 ms).
10. AI бюджет парсери сўз ичидаги рақамларни олар эди.

## Интеграциялар ҳолати
| Провайдер | Ҳолат |
|---|---|
| Payme Merchant API | adapter + протокол контракт тестлари (auth, amount тийин, Create/Perform/Cancel/Check/GetStatement, 12 соат timeout, дубль). **Live/sandbox кабинетида текширилмаган** |
| CLICK Prepare/Complete | adapter + MD5 sign, сўм→тийин конвертация, дубль/бекор. **Live текширилмаган** |
| MOCK провайдер | фақат dev/test; production'да ўчиқ; UI'да «TEST/MOCK» |
| SMS / Telegram | йўқ (dev log adapter, `suppressed`, «етказилди» деб ҳисобланмайди) |
| Фискал | blocked |
| AI | `local_retrieval` провайдер (LLM эмас), flag off; ташқи LLM — externally_blocked |
