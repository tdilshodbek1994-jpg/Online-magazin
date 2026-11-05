#!/usr/bin/env bash
# Sets (or resets) the HTTP basic-auth password that guards the DEMO site (Caddyfile.staging).
# Run as the deploy user from the repo root:  bash scripts/server/set-demo-password.sh            (asks twice, silently)
#                                        or:  bash scripts/server/set-demo-password.sh 'PAROL'    (non-interactive)
# The password is read silently and never echoed or stored in plain text — only its bcrypt hash goes to .env.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "XATO: .env topilmadi ($(pwd)). Avval loyiha papkasiga kiring."; exit 1; }
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"

if [ -n "${1:-}" ]; then
  P1="$1"
  [ "${#P1}" -ge 8 ] || { echo "XATO: parol kamida 8 belgi bo'lsin."; exit 1; }
else
while true; do
  read -r -s -p "Yangi DEMO parol (kamida 8 belgi): " P1; echo
  read -r -s -p "Parolni takrorlang: " P2; echo
  if [ "${#P1}" -lt 8 ]; then echo "Parol juda qisqa, qaytadan."; continue; fi
  if [ "$P1" != "$P2" ]; then echo "Parollar mos kelmadi, qaytadan."; continue; fi
  break
done
unset P2
fi

echo "Parol shifrlanmoqda (10-30 soniya)..."
HASH=$(docker run --rm caddy:2.8.4 caddy hash-password --plaintext "$P1" 2>/dev/null | tail -n1 | tr -d '\r')
unset P1
case "$HASH" in
  '$2a$'*|'$2b$'*) ;;
  *) echo "XATO: shifrlash muvaffaqiyatsiz. .env o'zgartirilmadi."; exit 1 ;;
esac

cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -e '^OM_STAGE_HASH=' -e '^OM_STAGE_USER=' .env > .env.new || true
printf "OM_STAGE_USER=owner\nOM_STAGE_HASH='%s'\n" "$HASH" >> .env.new
mv .env.new .env && chmod 600 .env
echo ".env yangilandi: $(grep '^OM_STAGE_HASH=' .env | cut -c1-20)..."

$COMPOSE up -d --force-recreate om-caddy
echo "Caddy ishga tushishi kutilmoqda..."
sleep 8
if [ "$($COMPOSE ps --format '{{.State}}' om-caddy 2>/dev/null)" = "running" ]; then
  echo "TAYYOR. https://${OM_DOMAIN:-uzshop.net} — login: owner, parol: hozir kiritganingiz."
else
  echo "Caddy ishlamayapti. Log:"; $COMPOSE logs --tail=20 om-caddy; exit 1
fi
