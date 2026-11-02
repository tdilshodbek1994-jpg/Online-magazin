# PHASE 1 — репозиторий аудити

**Сана:** 2026-11-02 · **Branch:** `claude/online-marketplace-platform-sdtv52` (ушбу сессия учун белгиланган ягона branch; ТЗ §03 даги `feature/phase1-owner-affiliate` номи ўрнига шу branch ишлатилди) · **Checkpoint:** Phase 1 бошланишидан олдинги ҳолат `99318e1` commit'ида push қилинган, локал `checkpoint/pre-phase1` branch.

## 1. Remote, branch, иш дарахти
- remote: `github.com/tdilshodbek1994-jpg/Online-magazin` — фақат шу репозиторий. TAQVIM репозиторийси, сервери, базаси, токенлари ишлатилмаган.
- Phase 1 олдидан иш дарахти тоза эди (`git status` бўш), махфий файл топилмади (grep: private key / api_key= / password= — натижа йўқ).

## 2. Phase 1 бошланишидаги мавжуд код (далил)
| Қисм | Ҳолат | Далил |
|---|---|---|
| `packages/shared` — пул (bigint тийин), чегирма тақсимоти, телефон E.164, лотин/кирилл нормаллаштириш | ишлайди | vitest 19/19 |
| `apps/api/migrations/0001–0005` (63 жадвал) | ишлайди | тоза PG16 базага хатосиз қўлланди; audit ва journal immutable триггерлари текширилди |
| API платформа ядроси (tx/retry, хато формати, audit, outbox, idempotency, RBAC) | қисман | ёзилган, тестсиз эди |
| OTP кириш модули | қисман | 8 та TS хатоси бор эди |
| Каталог/сават/буюртма/тўлов модуллари | йўқ эди | `app.ts` компиляция бўлмас эди |
| Frontend, Docker, CI | йўқ эди | — |
| Ташлаб қўйилган mock'лар | йўқ | — |

## 3. Phase 1 га қайта ишлатилган қисмлар
Пул/матн утилиталари, 0001–0005 схемаси (кенгайтирилди, ўчирилмади), платформа ядроси, OTP модули (тузатилди). Миграция занжири: 0001→0006 (0006 — Phase 1 кенгайтмаси).

## 4. Аввалги 64 модулли режа
Ўчирилмади: `docs/future/master/MASTER.txt`, `docs/future/PLAN_64_MODULES.md`, `docs/future/PHASE1_PLAN_DRAFT.md`. Phase 1 ТЗ: `docs/phase1/PHASE1_TASK.txt` (устувор).

## 5. Бажарилмаган текширувлар (сабаби билан)
- Docker image build: сандбоксдаги build-контейнер npm registry'га proxy/TLS орқали чиқа олмади (`corepack prepare pnpm` — request error). Compose ва Dockerfile'лар ёзилган, image қуриш ушбу муҳитда **текширилмаган**.
- Live Payme/Click, SMS, Telegram, фискал: калит/шартнома йўқ — `externally_blocked`.
