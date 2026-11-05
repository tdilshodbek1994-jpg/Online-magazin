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

## Domen va HTTPS bilan serverga o'rnatish (production overlay)

### 1. Server
Ubuntu 24.04 VPS, kamida 2 vCPU / 4 GB RAM / 40 GB disk. O'rnating: `git`, Docker Engine + Compose plugin. Firewall: faqat 22, 80, 443 ochiq.

### 2. DNS (domen sotib olingan joyning boshqaruv panelida)
| Turi | Nomi (Host) | Qiymati | TTL |
|---|---|---|---|
| A | `@` (yoki `shop`) | server IPv4 manzili | 300 |
| A | `www` | server IPv4 manzili | 300 |
| AAAA | `@`, `www` | server IPv6 (bo'lsa) | 300 |
Tekshirish: `dig +short sizningdomen.uz` server IP'sini qaytarishi kerak (5–30 daqiqa).

### 3. Kod va sozlamalar
```bash
git clone https://github.com/tdilshodbek1994-jpg/Online-magazin.git && cd Online-magazin
git checkout claude/online-marketplace-platform-sdtv52   # merge'dan keyin: main
cp .env.example .env
# .env ichida:
#   OM_DOMAIN=sizningdomen.uz
#   OM_DB_PASSWORD=$(openssl rand -base64 32)
#   MFA_ENC_KEY=$(openssl rand -base64 48)
#   NODE_ENV=production
#   PAYME_MODE=disabled  CLICK_MODE=disabled   (kalitlar kelguncha)
```

### 4. Ishga tushirish
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl -I https://sizningdomen.uz/health/ready     # 200 bo'lishi kerak
```
Caddy birinchi so'rovda Let's Encrypt sertifikatini avtomatik oladi (DNS to'g'ri bo'lishi shart). `www` asosiy domenga yo'naltiriladi.

### 5. Birinchi egasi (owner) akkaunti
Production'da demo seed ishlamaydi. Egasini bir marta qo'lda tayinlang:
```bash
docker compose exec om-postgres psql -U om_app -d online_magazin -c \
 "INSERT INTO users (phone_e164, phone_verified_at, display_name) VALUES ('+998XXXXXXXXX', now(), 'Owner') ON CONFLICT DO NOTHING;
  INSERT INTO memberships (user_id, role_code) SELECT id, 'owner' FROM users WHERE phone_e164='+998XXXXXXXXX';"
```
Keyin saytga shu telefon bilan kiring (SMS provayder ulangach), `/account/security` da MFA ni yoqing, xodimlarni admin panel orqali taklif qiling.

### 6. Muhim
- SMS provayder ulanmaguncha production'da OTP kod hech kimga yetib bormaydi (dev echo production'da o'chiq) — kirish ishlamaydi.
- Biznes qiymatlarini `/admin` → siyosatlar orqali tasdiqlamaguncha komissiya/payout/attribution muddatlari ishlamaydi.
- Zaxira: `scripts/backup.sh` ni cron orqali kuniga bir necha marta boshqa serverga nusxalang.
