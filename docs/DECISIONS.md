# Decision log

Формат: ID — қарор — асос — орқага қайтиш. Тахминлар **[ТАХМИН]** белгиси билан.

- **ADR-001 Монорепо (pnpm workspaces).** Битта репода api/web/shared — контрактлар синхрон. Қайтиш: пакетларни ажратиш осон.
- **ADR-002 Backend: Fastify + TypeScript, modular monolith.** Мавжуд стек йўқ (AUDIT.md), MASTER 8.1 TypeScript/React ва битта backend стекни таклиф қилади. NestJS ўрнига Fastify — кам абстракция, транзакция чегаралари очиқ. Микросервислар фақат юк асосланганда (M55).
- **ADR-003 PostgreSQL ягона ҳақиқат манбаси; ORM ўрнига `pg` + қўлда SQL миграциялар.** CHECK/UNIQUE/FK, шартли UPDATE, `SERIALIZABLE`/`FOR UPDATE` ва advisory lock'ларни аниқ назорат қилиш учун (INV02, INV09, INV10). Миграциялар checksum ва advisory lock билан, ҳар бири транзакцияда — қайта ишга тушириладиган (AC-M54-1).
- **ADR-004 Money = BIGINT minor-unit + currency; JSON'да decimal string.** MASTER 8.5. UZS учун minor unit = тийин (1 сўм = 100 тийин) — Payme тийин билан ишлайди [S05]. Float ҳеч қаерда йўқ (AC-M54-2).
- **ADR-005 Durable queue = PostgreSQL `outbox_events` + `jobs` (SKIP LOCKED).** Redis ҳақиқат манбаси эмас (M22, M55). Redis фақат кэш/rate-limit учун ихтиёрий.
- **ADR-006 Frontend: Next.js App Router, SSR.** SEO (M44), i18n uz-Latn/uz-Cyrl/ru (M04).
- **ADR-007 Тестлар: Vitest; интеграция реал PostgreSQL'да (in-memory fake йўқ, M60); E2E — Playwright.**
- **ADR-008 Ташқи провайдерлар adapter + capability matrix орқали; `mode: mock|sandbox|live`.** Mock ҳеч қачон «интеграция тугал» деб белгиланмайди.

## Бизнес тахминлари (тест default'лари, production'га яширин кўчирилмайди)

- **DEC-001** Default савдо режими `owner_only` (MASTER D02). `multi_merchant` feature flag орқали.
- **DEC-002** Attribution: 30 кунлик last eligible click, explicit verified code устувор (D05) **[ТАХМИН — тасдиқ керак]**.
- **DEC-003** Тест комиссия қоидаси: 30% tax-inclusive product net (9.3 fixture). Ҳақиқий тариф — D04.
- **DEC-004** SB: qualifying дона учун 1 SB, hold H=14 кун тест қиймати (D06/D08) **[ТАХМИН]**.
- **DEC-005** Сават чегирмаси тақсимоти: largest remainder, tie → line_id (9.2).
- **DEC-006** Commission rounding: half-up minor unit, cumulative expected усули (9.3).
- **DEC-007** OTP: 6 рақам, 5 дақиқа TTL, 60 с resend interval, 5 уриниш **[ТАХМИН]**.
- **DEC-008** Reservation unpaid TTL = 15 дақиқа **[ТАХМИН]**.
- **DEC-009** Бизнес вақти Asia/Tashkent, базада `timestamptz` (UTC).
