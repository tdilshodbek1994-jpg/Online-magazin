# uzshop.net — Vultr serveri va Namecheap domeni bilan o'rnatish

## 1. Vultr: server yaratish
Deploy (+) → **Cloud Compute – Shared CPU** (yoki Regular Performance):
- **Location:** Frankfurt yoki Warsaw (O'zbekistonga yaqin, past kechikish).
- **Image:** Ubuntu 24.04 LTS x64.
- **Plan:** kamida 2 vCPU / 4 GB RAM / 80 GB SSD.
- **SSH Keys:** kompyuteringizdagi ochiq kalitni qo'shing (parol bilan kirishdan xavfsizroq).
- **Server Hostname:** `uzshop-prod`. *Auto Backups* — yoqing.
Deploy tugagach serverning **IPv4** manzilini yozib oling.

**Firewall** (Products → Network → Firewall → Add group): inbound faqat TCP 22 (o'z IP'ingizdan), TCP 80, TCP 443, UDP 443. Guruhni serverga biriktiring.

## 2. Namecheap: DNS
Domain List → `uzshop.net` → **Manage** → **Nameservers: Namecheap BasicDNS** (Custom bo'lmasin) → **Advanced DNS** tab:
1. Mavjud `CNAME www → parkingpage...` va `URL Redirect @` yozuvlarini **o'chiring**.
2. Qo'shing:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | Vultr IPv4 | 5 min |
| A Record | `www` | Vultr IPv4 | 5 min |

Tekshirish (5–30 daqiqa): `nslookup uzshop.net` → Vultr IP.

## 3. Serverga ulanish va Docker
```bash
ssh root@VULTR_IP
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh
adduser --disabled-password --gecos "" om && usermod -aG docker om
```

## 4. Kod
Repozitoriy private bo'lsa: GitHub → Settings → Developer settings → Fine-grained token (faqat shu repo, Contents: read).
```bash
su - om
git clone https://github.com/tdilshodbek1994-jpg/Online-magazin.git && cd Online-magazin
git checkout claude/online-marketplace-platform-sdtv52    # PR merge qilingach: main
cp .env.example .env
```

## 5a. Staging (hozir, SMS provayder ulanmaguncha) — sayt parol ortida
```bash
HASH=$(docker run --rm caddy:2.8.4 caddy hash-password --plaintext 'KUCHLI-PAROL')
cat >> .env <<EOT
OM_DOMAIN=uzshop.net
OM_DB_PASSWORD=$(openssl rand -hex 24)
MFA_ENC_KEY=$(openssl rand -base64 48)
OM_CADDYFILE=Caddyfile.staging
OM_NODE_ENV=development
NODE_ENV=development
OM_STAGE_USER=owner
OM_STAGE_HASH='$HASH'
EOT
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec om-api node dist/seed.js   # DEMO ma'lumot
```
`https://uzshop.net` — brauzer login/parol so'raydi (owner / KUCHLI-PAROL). Ichkarida SMS kod ekranda (DEV) ko'rinadi — shuning uchun sayt albatta parol ortida turadi. Demo telefonlar: `docs/DEPLOYMENT.md`.

## 5b. Production (SMS provayder + siyosatlar tasdiqlangach)
`.env` da: `OM_CADDYFILE=Caddyfile`, `OM_NODE_ENV=production`, `NODE_ENV=production`, SMS kalitlari. Demo bazani tozalab (yoki yangi `om_pgdata`), egasini `docs/DEPLOYMENT.md` 5-band bo'yicha tayinlang, keyin:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## 6. Ehtiyot choralar
- **Shaxsiy ma'lumotlar:** server chet elda (Vultr). Real mijoz ma'lumotlarini saqlashdan oldin ЎРҚ-547 (27¹-modda, 2026 tahriri) bo'yicha huquqiy tekshiruv kerak (PHASE1_TASK §26). Staging'da faqat demo ma'lumot.
- Zaxira: Vultr Auto Backups + `scripts/backup.sh` ni cron orqali boshqa joyga.
- Yangilash: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.

## 7. Hamkorlar uchun Telegram bot (ixtiyoriy)
1. Telegram'da **@BotFather** → `/newbot` → nom (masalan `UzShop hamkor`) va username (masalan `uzshop_hamkor_bot`). BotFather token beradi — uni chatga yoki boshqa joyga yozmang.
2. Serverda (`om` foydalanuvchisi, `~/online-magazin`):
   ```bash
   bash scripts/server/telegram-setup.sh
   ```
   Token ekranda ko'rinmaydi; skript tokenni tekshiradi, `.env` ga yozadi (zaxira nusxa qoladi), API'ni qayta ishga tushiradi va webhook'ni `https://<domen>/api/v1/webhooks/telegram` ga maxfiy kalit bilan ulaydi.
3. Hamkor kabinetida **«Telegram'ni ulash»** → botda **Start**. Shundan keyin yangi buyurtma, yetkazildi, bekor qilindi, hisobga pul o'tdi, to'lov o'tkazildi xabarlari keladi. Xabarlarda mijozning ism/telefoni bo'lmaydi.
Bot sozlanmagan bo'lsa ham xabarlar kabinetdagi «Bildirishnomalar» bo'limida ko'rinadi.
