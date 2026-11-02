# Бажарилиш режаси — M01–M64

Манба: `docs/master/MASTER.txt` (v1.0, 2026-11-01). Ҳолатлар реестри: `docs/REQUIREMENTS.md`. Қарорлар: `docs/DECISIONS.md`.

## 1. Архитектура (ADR-001…ADR-008, тафсилот DECISIONS.md да)

```
apps/api      Fastify + TypeScript, modular monolith (src/modules/<domain>)
              PostgreSQL 16 — ягона ҳақиқат манбаси; SQL миграциялар (expand/contract)
              outbox/inbox + jobs жадвали (FOR UPDATE SKIP LOCKED) — durable worker
apps/web      Next.js (App Router, SSR/SEO), i18n: uz-Latn, uz-Cyrl, ru
packages/shared  Money codec (minor-unit, string JSON), i18n калитлари, умумий типлар
infra/        Docker Compose (postgres, redis, minio, api, worker, web)
.github/      CI: lint/typecheck → unit → integration (реал PG) → build → e2e
```

Доменлар (8.1): identity, config, catalog, pricing, checkout, orders, payments, inventory,
fulfillment, returns, affiliates, rewards, merchants, finance, crm, content, messaging,
analytics, ai, platform (audit/outbox/idempotency/jobs).

## 2. Боғлиқлик графи (асосий)

```
M54 data model ─┬─> M55 infra ─> M60 tests ─> M61 CI/release
                ├─> M41 RBAC/audit ─┬─> M01 config/modes ─> M35..M38 merchants (P6)
                │                   └─> M02 auth ─> M03 cabinet ─> M09, M10, M18
                ├─> M53 API/outbox/idempotency ─> M14 payments, M17 notify, M24 carriers
                ├─> M42 ledger ─> M14 ─> M16 refunds ─> M30 commission ─> M31 payouts
                └─> M06 categories ─> M19 products/SKU/offer ─> M20 import ─> M07 search ─> M08 PDP
M19 + M22 stock/reserve + M12 pricing ─> M11 cart/quote ─> M13 orders ─> M14 ─> M15 fiscal
M13 + M23 WMS + M24 delivery ─> M25 courier/COD, M26 pickup ─> M16 returns ─> M27 reverse/recall
M29 attribution (order line snapshot) ─> M30 ─> M32 SB ─> M33 rewards ─> M34 contests
M52 AI gateway ─> M48, M49, M50, M51 (AI ҳеч қачон асосий савдо йўлида блокловчи эмас)
M56 legal, M57 security, M58 perf, M59 observability — ҳар фазада кесишувчи
```

## 3. Фазалар ва ушбу сессиядаги иш тартиби

| Фаза | Модуллар | Gate (MASTER XIII) |
|---|---|---|
| P0 | аудит, реестр, қарорлар | бажарилди — AUDIT.md, PLAN.md, DECISIONS.md, REQUIREMENTS.md |
| P1 | M01–M06, M19–M20, M41, M53–M57 асоси, M42 schema, M60–M61 | owner маҳсулот қўшади, мижоз кўради, affiliate қўша олмайди |
| P2 | M07–M15, M22, M16 refund ядроси, M17 transactional | товардан тасдиқланган тўловгача E2E; duplicate/late callback; concurrency |
| P3 | M16, M21, M23–M27 | қисман delivery/return, COD, recall |
| P4 | M28–M34 | 100 000/30 000 мисоли, partial refund, payout collision, SB double-spend |
| P5 | M18, M39–M44, M64 | реал маълумот билан бошқарув панели |
| P6 | M35–M38 | икки merchant split order, tenant isolation |
| P7 | M48–M52 | 500-case eval, human-confirmed actions |
| P8 | M45–M47, M62–M63 | ҳар extension алоҳида gate |
| P9 | M58–M61, M64 | perf, restore drill, UAT; production deploy — фақат эгаси рухсати билан |

Устуворлик: аввал пул/қолдиқ/комиссия ядроси (инвариантлар INV01–INV23) реал PostgreSQL
тестлари билан, кейин UI. Ҳар бир модул ҳолати фақат далил (тест/файл) асосида ўзгаради.

## 4. Ташқи блокерлар (код тайёрланади, live текширилмайди)

Payme/Click credentials ва шартнома (D13), фискал провайдер (D14), SMS/Telegram sender,
ташувчилар API (D12), AI провайдер калити ва PII шартлари (D15), домен/TLS/production (D20).
