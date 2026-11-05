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

| V2.8 MFA | owner/finance: TOTP (RFC 6238, AES-256-GCM да сақланади), replay ҳимояси, 8 та бир марталик tiklash kodi; муҳим амаллар олдидан step-up (10 дақ) | e-phase1 › T020, E2E-10 |
| V12 Upload | magic-byte, ҳажм/ўлчам, SVG/HTML рад, қайта кодлаш (EXIF олиб ташланади), hash-ном | e-phase1 › T030 |
| AI (OWASP LLM) | read-only tool'лар, ownership серверда, каталог матни маълумот сифатида, kill-switch flag, кунлик лимит | e-phase1 › T088–T090 |

**Очиқ:** умумий HTTP rate-limit (ҳозир фақат OTP'да), CSP header'лари, қўлда pentest. CSRF: API Bearer token ишлатади (cookie йўқ).
