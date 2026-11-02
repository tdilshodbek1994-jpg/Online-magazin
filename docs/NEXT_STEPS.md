# NEXT STEPS (устувор тартибда)

1. **Owner қарорлари (Appendix B):** комиссия қоидалари, attribution муддати, hold, payout минимал/режим, етказиш ҳудудлари → `POST /admin/policies` + approve.
2. **Payme sandbox:** merchant кабинетида test kassa, `PAYME_KEY`; Payme test suite'ни ўтказиш → биринчи live провайдер (§17).
3. **SMS провайдер** (OTP ва мижоз тасдиғи учун зарур) — адаптер интерфейси тайёр (`notifications` + worker).
4. **T020** owner/finance MFA ва муҳим амал олдидан step-up OTP.
5. **T029/T030** CSV импорт (preview, сатр хатолари, SKU дубликатсиз) ва медиа upload (MIME/ҳажм/ўлчам, SVG рад).
6. **T050** тасдиқланган буюртма таркибини ўзгартириш оқими (янги quote + мижоз қайта тасдиғи) ва негатив тест.
7. **T087** маркетинг юбориш + suppression; **T086** Telegram бот (алоҳида токен).
8. Docker image'ни тармоқ рухсати бор муҳитда қуриш, GitHub Actions CI'ни яшил қилиш.
9. Load test (L1 профил), PostgreSQL restart drill, медиа backup.
10. Фискал провайдер ва ҳуқуқий матнлар (оферта, қайтариш, privacy, ҳамкор шартномаси) — мутахассис текшируви.
11. Stage F: read-only AI ёрдамчи (feature flag, бюджет, fallback).
