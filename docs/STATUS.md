# STATUS — Phase 1 (2026-11-02)

Ҳолатлар: implemented / tested / externally_blocked / deferred / not_started.

| Модуль / талаб | Ҳолат |
|---|---|
| A — аудит, checkpoint, схема (0001–0008), роллар, CI | tested — GitHub Actions яшил (run 41486738015) |
| B — каталог → checkout → оператор → омбор → етказиш → COD settlement | tested (API + браузер) |
| C — referral, мижоз номидан буюртма (OTP/оператор), attribution, комиссия ledger, payout | tested |
| D — Payme/Click adapter, refund, reconciliation, ортиқча тўлов | tested (протокол контракт); live — externally_blocked |
| D — фискал чек | externally_blocked |
| E — owner ҳисобот/CSV, CRM навбатлари, support, staff invitation | tested (support/invitation — implemented, алоҳида тестсиз) |
| E — owner/finance TOTP MFA + step-up | tested |
| E — маркетинг кампаниялари + розилик suppression | tested |
| E — SMS юбориш | externally_blocked (dev adapter, `suppressed`) |
| E — Telegram боғлаш | tested (логика); бот орқали юбориш — externally_blocked |
| Каталог: CSV импорт, медиа upload (WEBP variants) | tested |
| Тасдиқланган буюртмани ўзгартириш (мижоз қайта тасдиғи) | tested |
| F — AI ёрдамчи (local_retrieval, flag off) | tested; ташқи LLM — externally_blocked |
| Юклама (10k SKU / 100k order) | tested: 0 хато, 0 oversell; реалистик профилда read p95 62 ms, checkout p95 163 ms (стресс: 505 ms) |
| PostgreSQL restart, backup/restore (DB + media) | tested (demo ҳажмда) |
| Docker images + Compose | tested: api/web image қурилди, compose'да 5 сервис ишлади |

**Тестлар:** shared 19/19, API 73/73, браузер E2E 11/11 (axe-core билан), 0 skipped. **Қабул матрицаси:** 92 tested, 5 partial, 3 manual.
**Deploy:** фақат development сандбокс. Production'га ҳеч нарса deploy қилинмаган, `main`га merge қилинмаган.
**Owner қарорисиз ёқилмайдиган қийматлар:** комиссия ставкалари, attribution муддати, hold, payout минимал/режим, етказиш тарифлари, ҳуқуқий матнлар — ҳаммаси demo (`is_demo`).
