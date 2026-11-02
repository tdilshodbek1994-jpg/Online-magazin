# Архитектура (Phase 1)

```
Browser ──> apps/web (Next.js 16, SSR маҳсулот саҳифаси, /api/v1 proxy)
              │
              ▼
          apps/api (Fastify 5, TypeScript, modular monolith)  ──>  PostgreSQL 16 (ягона ҳақиқат манбаси)
              │  identity · catalog · checkout · orders/ops · partners · commissions · returns/refunds · payments · support · admin
              ▼
          worker (jobs: FOR UPDATE SKIP LOCKED; scheduler: pg advisory lock)
```

- **Стек қарори:** мавжуд TypeScript асоси сақланди (ТЗ §05: «ишлайдиган стек бўлса сақла»). FastAPI'га кўчирилмади — бир вазифа учун иккинчи backend йўқ.
- **Redis:** Phase 1 да ишлатилмайди. Навбат ва қолдиқ — PostgreSQL. Redis йўқолиши молиявий ҳақиқатга таъсир қилмайди (§05).
- **Медиа:** `media_assets` жадвали бор; upload endpoint — `not_started` (NEXT_STEPS).
- **Пул:** BIGINT тийин; JSON'да `{amount_minor: "string", currency: "UZS"}`. Float йўқ.
- **Вақт:** база UTC (`timestamptz`), ҳисобот чегараси Asia/Tashkent.
- **Транзакциялар:** ҳар mutation битта DB транзакцияда; outbox воқеаси шу транзакцияда; ташқи HTTP чақирув DB lock ичида йўқ.
- **Рухсат:** роль → permission (`role_permissions`) ҳар so'rovda DB'дан ўқилади; объект scope (owner/partner/customer) SQL `WHERE` даражасида.

## Ҳолат машиналари
- Буюртма: `draft → awaiting_confirmation → confirmed → completed`; `cancelled`.
- Мижоз тасдиғи: `pending → verified | rejected | expired`.
- Тўлов: `unpaid → pending → paid → partially_refunded | refunded`; `failed`, `reconciliation_required`.
- Етказиш: `unallocated → reserved → picking → packed → shipped → delivered`; `failed`, `returned`.
- Резерв: `active_unpaid → allocated_for_fulfillment → consumed_on_dispatch`; `released`, `expired`.
- Комиссия: `estimated → pending → available` (+ ledger: `reserved → paid`), `reversed`, `superseded`.
- Payout: `requested → approved → paid | rejected | processing_unknown`.
- Қайтариш: `requested → approved → received (quarantine) → inspected → resolved`; `rejected`.

## Permission matrix (қисқа)
| Permission | owner | catalog | operator | warehouse | courier | finance | partner/customer |
|---|---|---|---|---|---|---|---|
| catalog.write, inventory.write | ✓ | ✓ | | inv ✓ | | | |
| catalog.read_internal (таннарх) | ✓ | | | | | | |
| commission_rules.write | ✓ | | | | | | |
| orders.read_all / orders.operate | ✓ | | ✓/✓ | read | | read | |
| fulfillment.operate | ✓ | | | ✓ | | | |
| courier.self | ✓ | | | | ✓ | | |
| cod.confirm, refunds.approve, payouts.prepare/approve | ✓ | | | | | ✓ | |
| partners.manage, policies.manage, staff.manage, audit.read | ✓ | | | | | | |
| reports.read | ✓ | | | | | ✓ | |
Партнёр ва мижоз ресурслари фақат ўз `user_id`/`partner_id` scope'ида (сервер аниқлайди).

ERD: `apps/api/migrations/*.sql` (FK/UNIQUE/CHECK билан). OpenAPI: ишлаётган API'да `/api/docs`.
