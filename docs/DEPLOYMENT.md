# Ишга тушириш (development / test). Production deploy — owner рухсатисиз қилинмайди.

## Локал (Docker'сиз)
```bash
pnpm install
pnpm --filter @om/shared build
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/online_magazin
pnpm --filter @om/api db:migrate && pnpm --filter @om/api db:seed   # synthetic DEMO only
pnpm --filter @om/api dev        # API :4000, OpenAPI: /api/docs
pnpm --filter @om/web build && pnpm --filter @om/web start   # web :3000
node apps/web/e2e/smoke.mjs      # browser smoke (fresh seed, OTP_RESEND_SECONDS=1 OTP_HOURLY_LIMIT=1000)
```
Demo кириш: `+998900000001` owner, `…02` operator, `…03` warehouse, `…04` courier, `…05` finance, `…06` catalog, `…07` partner (DEMO777), `…08` customer. OTP dev жавобида кўринади (production'да йўқ).

## Docker Compose
`cp .env.example .env` → `OM_DB_PASSWORD` ни ўзгартиринг → `docker compose up --build`. Сервислар: om-postgres (127.0.0.1:5433), om-migrate, om-api (:4000), om-worker, om-web (:3000). Ушбу сандбоксда image build текширилмаган (registry'га чиқиш блокланган).

## Тестлар
`TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @om/api test`

## Миграция, backup, rollback
- Миграциялар forward-only, checksum ва advisory lock билан; ҳар файл транзакцияда.
- Олдин: `scripts/backup.sh $DATABASE_URL backup.dump`. Restore синови: `scripts/restore-drill.sh`.
- App rollback: олдинги image. Destructive миграция йўқ; керак бўлса expand/contract.
- Restore'дан кейин PSP/банк солиштирилмагунча payout ва refund бажарилмасин.
