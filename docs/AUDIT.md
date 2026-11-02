# Репозиторий аудити — Online-magazin

**Сана:** 2026-11-02
**Branch:** `claude/online-marketplace-platform-sdtv52`
**Мақсад:** 64 модулли MASTER техник топшириқ асосида ишлашдан олдин бошланғич ҳолатни қайд этиш.

## 1. Репозиторий ҳолати

| Кўрсаткич | Натижа |
|---|---|
| Commitлар сони | 1 (`78973b7 Initial commit`) |
| Файллар | фақат `README.md` |
| Branchлар | `main`, `claude/online-marketplace-platform-sdtv52` |
| Мавжуд код / архитектура | **йўқ** — лойиҳа нолдан бошланади |
| Тестлар, CI/CD, Docker, БД схемаси | **йўқ** |
| TAQVIM лойиҳаси билан боғлиқлик | **йўқ** — ҳеч қандай умумий код, конфиг ёки сервер манзили топилмади |

README: *"Professional AI-powered e-commerce marketplace for Uzbekistan with customer, partner, seller, admin, payments, logistics and rewards management."*

## 2. Ишлаб чиқиш муҳити (текширилди)

| Восита | Версия | Ҳолат |
|---|---|---|
| Node.js / npm / pnpm | 22.23 / 10.9 / 10.28 | ✅ |
| Python | 3.13 | ✅ |
| Java (OpenJDK) | 21 | ✅ |
| PostgreSQL | 16.15 | ✅ локал кластер ишга туширилди (5432) |
| Docker Engine | 29.9.2 | ✅ daemon ишга туширилди |
| Go | — | ❌ ўрнатилмаган |
| Chromium + Playwright | олдиндан ўрнатилган | ✅ (E2E тестлар учун) |

## 3. Хулоса

Архитектура ҳали мавжуд эмас, шунинг учун уни MASTER топшириқ асосида лойиҳалаш керак.
MASTER келгунча қуйидаги бошланғич таклиф (тасдиқланмаган) тайёр:

- **Монорепо:** pnpm workspaces + Turborepo
- **Backend:** NestJS (TypeScript), модулли монолит → кейинчалик микросервисларга ажратиш имконияти
- **БД:** PostgreSQL 16 + Prisma ORM, миграциялар; Redis (кэш, навбатлар)
- **Frontend:** Next.js (харидор витринаси) + алоҳида admin / seller панеллар; i18n: ўзбек (лотин/кирилл), рус, инглиз
- **AI:** алоҳида `ai-service` (қидирув, тавсиялар, модерация, чат-ёрдамчи)
- **Тўловлар:** Payme, Click, Uzum — адаптерлар орқали
- **Инфра:** Docker Compose (dev), GitHub Actions CI (lint, typecheck, unit, integration, e2e)

Якуний танлов MASTER топшириқдаги талабларга мослаштирилади.

## 4. Кейинги қадам

1. MASTER техник топшириқни `docs/master/` га жойлаш.
2. 64 модул бўйича режа, боғлиқликлар графи ва босқичларни `docs/PLAN.md` га ёзиш.
3. Босқичма-босқич амалга ошириш, ҳар босқичда тестлар ва ҳисобот.

## Қоидалар (фойдаланувчи томонидан белгиланган)

- Фақат шу репозиторийда ишланади; TAQVIM кодига, серверига, базасига тегилмайди.
- Барча иш `claude/online-marketplace-platform-sdtv52` branchида.
- `main` га merge ва production deploy — фақат эгасининг тасдиғи билан.
