# Хавфсизлик чеклисти (OWASP ASVS'га хариталанган; сертификат даъвоси эмас)

| Соҳа (ASVS) | Амалга оширилган | Далил |
|---|---|---|
| V2 Аутентификация | OTP: 6 рақам, TTL, resend интервали, соатлик лимит, 5 уриниш, бир марталик; код hash'и сақланади; `timingSafeEqual` | d-integrity › T011 |
| V3 Сессия | 32 байт random token, базада sha256; revoke/logout; телефон ўзгарса сессия бекор | T009/T010 |
| V4 Рухсат | permission ҳар so'rovда DB'дан; объект scope SQL'да; бегона ресурс → 404 | T003–T007, T039, T048 |
| V5 Validation | zod ҳамма body/query/params'да; пул — бутун сон string | T024, T066 |
| V7 Лог | токен/OTP/пароль/карта майдонлари `redact()`; authorization header лог redaction | `platform/audit.ts`, `app.ts` |
| V8 Маълумот ҳимояси | ҳамкорга маскаланган телефон/буюртма; CSV телефон маскаси; таннарх фақат `catalog.read_internal` | T004, T007, T084 |
| V11 Бизнес мантиқ | idempotency, атомар резерв, CHECK constraint'лар, maker≠checker | T019, T051, T068, T078 |
| V12 Файл | CSV formula injection ҳимояси; upload ҳали йўқ | T084 |
| V13 API/webhook | Payme Basic auth (timing-safe), CLICK MD5 sign, amount/order текшируви | T062, T067 |
| V14 Конфигурация | production'да OTP echo ва mock ўчиқ; `.env` ignore; секретлар фақат env | T012/T097 |
| CI | gitleaks secret scan + `pnpm audit` | `.github/workflows/ci.yml` |

**Очиқ:** owner/finance MFA ва step-up (T020), rate-limit HTTP қатламида (фақат OTP'да бор), CSRF — API Bearer token ишлатади (cookie йўқ), медиа upload ва SVG тозалаш (T030), CSP header'лари.
