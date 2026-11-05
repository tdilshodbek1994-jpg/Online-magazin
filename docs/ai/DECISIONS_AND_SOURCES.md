# Қарорлар, асослар ва манбалар

Сана: 2026-11-05. Фойдаланувчининг жорий матни — функционал асос; аввалги UzShop қарорлари — интеграция контексти; S1–S8 — ташқи техник ҳужжатлар. Матнлардан узун иқтибос олинмаган.

## Қарорлар реестри

### D01 — User requirement
customerда бизнес AI йўқ; 5 та ходим/ҳамкор ролларида берилган scope.
Қабул/чегара: Қатъий; grants аудит қилинади.

### D02 — User requirement
Ҳамкор умумий магазиннинг тасдиқланган бестселлерларини кўради.
Қабул/чегара: Алоҳида aggregate API; private records ҳуқуқи эмас.

### D03 — User requirement
LLM ихтиёрий SQL ёзмайди.
Қабул/чегара: Текширилган tools, server-derived identity.

### D04 — Prior project rule
Ҳамкорнинг ҳавола ва мижоз номидан буюртма йўли.
Қабул/чегара: Бир хил order ledger, origin ва attribution алоҳида.

### D05 — Prior project rule
1/2/3 дона коэффициентлари: [1], [1,0.25], [1,0.5,0.25].
Қабул/чегара: Authoritative existing rule snapshot; эски ledgerни AI қайта ҳисобламайди.

### D06 — Prior project rule
Eligible unit = 1 UzCoin, бошланғич 3000 UZS.
Қабул/чегара: Runtime rate service; payout/commission билан аралашмасин.

### D07 — Proposed default
Пул топдим = даврда recognized net commission.
Қабул/чегара: Эга тасдиғи; current metric билан фарқни очиқ айт.

### D08 — Proposed default
Йилсиз сана = контекст йили ёки энг яқин ўтган сана.
Қабул/чегара: Сарлавҳада тўлиқ сана; sensitive actionда тасдиқ.

### D09 — Proposed default
Ўтган ҳафта Monday-Sunday; охирги7кун бугун билан.
Қабул/чегара: Product policy; UIда preview.

### D10 — Proposed default
Public bestseller rank + product, counts optional.
Қабул/чегара: Эга count disclosure/aggregation policyни тасдиқлайди.

### D11 — Proposed default
P0 read-only; P1 bounded drafts/actions.
Қабул/чегара: Молиявий команда махсус мавжуд workflowдан.

### D12 — Proposed limit
Assignment batch ≤20, result page ≤100.
Қабул/чегара: Юклама ва иш жараёнига мос тасдиқ/конфигурация.

### D13 — Proposed targets
Report p95≤2s, ordinary AI answer p95≤8s.
Қабул/чегара: Benchmark мақсади; жорий натижа эмас.

### D14 — Owner decision required
Chat/report/audio/log retention ва provider policies.
Қабул/чегара: Махфий маълумотни minimum; бирон муддат бу пакетда қотирилмаган.

### D15 — Owner decision required
Earnings recognition, tax/shipping inclusions, settled cohort definitions.
Қабул/чегара: Мавжуд finance service аниқланмасдан «соф фойда» йўқ.

### D16 — Implementation decision
RLS, cache, read replica and migration choices.
Қабул/чегара: Actual schema/DB версиясига мос; bypass/connection pool tests шарт.

### D17 — Owner decision required
Data provider, model, cost budget and fallback vendors.
Қабул/чегара: Рухсатсиз янги paid API ёки маълумот провайдери йўқ.

### D18 — Limit
Repo/CI/production/model integrations бу пакетда текширилмаган.
Қабул/чегара: acceptance_cases ҳаммаси not_run; локал арифметик текширув алоҳида.

## Манбалар

### [S1] OWASP Authorization Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
Default deny, per-request/row/field authorization. Кириш ҳуқуқи модельга топширилмайди.

### [S2] PostgreSQL 16 — Row Security Policies
https://www.postgresql.org/docs/16/ddl-rowsecurity.html
RLS ва table owner/superuser/BYPASSRLS истиснолари. Ҳақиқий repository DB версияси аудит қилинади.

### [S3] PostgreSQL 16 — Transaction Isolation
https://www.postgresql.org/docs/16/transaction-iso.html
Repeatable Read ичидаги snapshot; external servicesга автоматик тарқалмайди.

### [S4] OWASP LLM Prompt Injection Prevention Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
Tool permission ва output checks; prompt filtering бир ўзи security boundary эмас.

### [S5] OWASP Transaction Authorization Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
Action-specific preview, server-side validation, one-time operation, changed data invalidates approval.

### [S6] W3C — Understanding WCAG 2.2 Status Messages
https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
Progress/result statusларни screen readerга маъноли, фокусни олмасдан етказиш.

### [S7] OWASP — Excessive Agency (2025 reference page)
https://genai.owasp.org/llmrisk/llm062025-excessive-agency/?lang=us
Minimal tool functionality/permissions and human approval; edition is labelled, not claimed latest.

### [S8] Python zoneinfo
https://docs.python.org/3/library/zoneinfo.html
IANA вақт зонаси билан synthetic чегараларни локал текширишда ишлатилди; product stackни Pythonга алмаштириш талаби эмас.

## Текширув чегараси
Файл форматлари ва аниқ арифметик/календарь эталонлари локал текширилади. Бу repository тестлари, ҳуқуқий хулоса, кириш ҳуқуқи кафолати ёки provider performance ўлчови эмас. Docs’даги latest версияга таяниб production стекни ўзгартириш шарт эмас.
