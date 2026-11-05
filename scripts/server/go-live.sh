#!/usr/bin/env bash
# DEMO → REAL shop. Run as the deploy user from the repo root:
#   bash scripts/server/go-live.sh              switch to the real shop
#   bash scripts/server/go-live.sh --rollback   go back to the DEMO (nothing is lost either way)
# What it does (switch):
#   1. checks that Eskiz SMS is connected (without SMS nobody can log in: codes are no longer shown on screen)
#   2. full backup of the DEMO database to ~/backups/demo-final-*.dump — the DEMO database itself is KEPT, not deleted
#   3. creates a new empty database «uzshop_live» and points the shop to it (OM_DB_NAME)
#   4. production mode: site without the demo password (OM_CADDYFILE=Caddyfile), OM_NODE_ENV=production,
#      online payments off (cash on delivery only), MFA_ENC_KEY created if missing
#   5. restarts everything, creates reference data and ONE owner account for your phone
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "XATO: .env topilmadi"; exit 1; }
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"
LIVE_DB=uzshop_live
setenv() { # setenv KEY VALUE — replace or append one line in .env
  grep -v -e "^$1=" .env > .env.new || true; printf '%s=%s\n' "$1" "$2" >> .env.new; mv .env.new .env; chmod 600 .env
}
wait_api() {
  for i in $(seq 1 60); do $C exec -T om-api node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && return 0; sleep 3; done
  echo "XATO: API ishga tushmadi. Ko'rish: $C logs --tail 50 om-api"; return 1
}

if [ "${1:-}" = "--rollback" ]; then
  echo "DEMO ga qaytaramiz (haqiqiy baza $LIVE_DB o'chirilmaydi)."
  cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  setenv OM_DB_NAME online_magazin; setenv OM_CADDYFILE Caddyfile.staging; setenv OM_NODE_ENV development
  $C up -d --no-build --force-recreate >/dev/null && wait_api && echo "TAYYOR: DEMO qaytdi (sayt yana parol bilan)."
  exit 0
fi

grep -qE '^ESKIZ_EMAIL=.' .env && grep -qE '^ESKIZ_PASSWORD=.' .env || { echo "XATO: avval SMS ni ulang: bash scripts/server/sms-setup.sh"; exit 1; }
grep -qE '^OM_DOMAIN=.' .env || { echo "XATO: .env da OM_DOMAIN yo'q"; exit 1; }
read -r -p "Egasi (sizning) telefon raqamingiz, +998...: " OWNER
DIG=$(printf '%s' "$OWNER" | tr -cd '0-9'); [[ "$DIG" =~ ^998[0-9]{9}$ ]] || { echo "XATO: raqam +998XXXXXXXXX ko'rinishida bo'lsin"; exit 1; }
echo
echo "Diqqat: sayt haqiqiy rejimga o'tadi. Demo mahsulot, buyurtma va hisoblar yangi saytda ko'rinmaydi"
echo "(ular eski bazada va zaxira faylda saqlanib qoladi, --rollback bilan qaytarish mumkin)."
read -r -p "Davom etish uchun HA deb yozing: " OK; [ "$OK" = "HA" ] || { echo "Bekor qilindi."; exit 1; }

echo "== 1/5 DEMO bazasining to'liq zaxirasi"
mkdir -p ~/backups
F=~/backups/demo-final-$(date +%Y%m%d%H%M%S).dump
$C exec -T om-postgres pg_dump -U om_app -Fc online_magazin > "$F"
[ -s "$F" ] || { echo "XATO: zaxira bo'sh chiqdi — hech narsa o'zgartirilmadi"; exit 1; }
ls -lh "$F"

echo "== 2/5 yangi bo'sh baza: $LIVE_DB"
if ! $C exec -T om-postgres psql -U om_app -d online_magazin -tAc "SELECT 1 FROM pg_database WHERE datname='$LIVE_DB'" | grep -q 1; then
  $C exec -T om-postgres psql -U om_app -d online_magazin -c "CREATE DATABASE $LIVE_DB OWNER om_app" >/dev/null
fi

echo "== 3/5 haqiqiy rejim sozlamalari (.env zaxirasi saqlanadi)"
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
setenv OM_DB_NAME "$LIVE_DB"; setenv OM_CADDYFILE Caddyfile; setenv OM_NODE_ENV production
setenv PAYME_MODE disabled; setenv CLICK_MODE disabled
KEY=$(grep -E '^MFA_ENC_KEY=' .env | tail -n1 | cut -d= -f2-)
[ ${#KEY} -ge 32 ] || setenv MFA_ENC_KEY "$(openssl rand -base64 48 | tr -d '\n/+=')"

echo "== 4/5 qayta ishga tushirish"
$C up -d --no-build --force-recreate --remove-orphans >/dev/null
wait_api

echo "== 5/5 boshlang'ich ma'lumot va egasi hisobi"
$C exec -T -e LIVE_OWNER_PHONE="+$DIG" om-api node dist/live-init.js
echo
echo "TAYYOR: haqiqiy sayt ishlayapti — https://$(grep -E '^OM_DOMAIN=' .env | tail -n1 | cut -d= -f2-)"
echo "Kirish: o'z raqamingiz + SMS kod. Keyin /account/security sahifasida autentifikatorni (MFA) yoqing."
echo "DEMO ga qaytish kerak bo'lsa: bash scripts/server/go-live.sh --rollback"
