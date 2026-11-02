# STATUS — Phase 1 (2026-11-02)

Ҳолатлар: implemented / tested / externally_blocked / deferred / not_started.

| Модуль / талаб | Ҳолат |
|---|---|
| A — аудит, checkpoint, схема, роллар, CI конфиг | tested (CI GitHub'да ҳали ишлатилмаган) |
| B — каталог → checkout → оператор → омбор → етказиш → COD settlement | tested (API + браузер) |
| C — referral, мижоз номидан буюртма (OTP/оператор тасдиғи), attribution, комиссия ledger, payout | tested |
| D — Payme/Click adapter, refund, reconciliation exception'лари | tested (контракт), live — externally_blocked |
| D — фискал чек | externally_blocked |
| E — owner ҳисобот, CSV, CRM навбатлари, support тикетлари | tested (support — implemented, тестсиз) |
| E — хабарномалар (SMS/Telegram) | externally_blocked (dev adapter) |
| E — staff invitation | implemented (тестсиз) |
| E — owner/finance MFA, step-up | not_started |
| Каталог: CSV импорт, медиа upload | not_started |
| F — AI ёрдамчилар | deferred |
| Load test, PG restart drill | not_started |
| Docker image build | implemented, текширилмаган (сандбокс тармоғи) |

Тестлар: shared 19/19, API 61/61, browser E2E 9/9, 0 skipped. Қабул матрицаси: 79 tested, 8 partial, 3 manual, 2 implemented, 1 blocked, 2 deferred, 5 not_started.
Deploy ҳолати: фақат development сандбокс. Production'га ҳеч нарса deploy қилинмаган, `main`га merge қилинмаган.
