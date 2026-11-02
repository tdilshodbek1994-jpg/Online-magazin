#!/usr/bin/env bash
# Connects the partner-notification Telegram bot. Run as the deploy user from the repo root:
#   bash scripts/server/telegram-setup.sh            (asks for the BotFather token, hidden)
# What it does: verifies the token (getMe), stores TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME / TELEGRAM_WEBHOOK_SECRET
# in .env (backup kept), restarts the API and registers https://$OM_DOMAIN/api/v1/webhooks/telegram with a secret header.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "XATO: .env topilmadi"; exit 1; }
DOMAIN=$(grep -E '^OM_DOMAIN=' .env | tail -n1 | cut -d= -f2-)
[ -n "$DOMAIN" ] || { echo "XATO: .env da OM_DOMAIN yo'q"; exit 1; }
read -r -s -p "BotFather bergan token (ekranda ko'rinmaydi): " TOKEN; echo
[[ "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "XATO: token formati noto'g'ri"; exit 1; }
ME=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe") || { echo "XATO: Telegram tokenni qabul qilmadi"; exit 1; }
USERNAME=$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
[ -n "$USERNAME" ] || { echo "XATO: bot nomi aniqlanmadi"; exit 1; }
SECRET=$(openssl rand -hex 24)
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -e '^TELEGRAM_BOT_TOKEN=' -e '^TELEGRAM_BOT_USERNAME=' -e '^TELEGRAM_WEBHOOK_SECRET=' .env > .env.new || true
printf "TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_BOT_USERNAME=%s\nTELEGRAM_WEBHOOK_SECRET=%s\n" "$TOKEN" "$USERNAME" "$SECRET" >> .env.new
mv .env.new .env && chmod 600 .env
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"
$C up -d --no-build --force-recreate om-api >/dev/null
for i in $(seq 1 40); do $C exec -T om-api node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 3; done
R=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/setWebhook" --data-urlencode "url=https://${DOMAIN}/api/v1/webhooks/telegram" --data-urlencode "secret_token=${SECRET}" --data-urlencode 'allowed_updates=["message"]')
unset TOKEN
case "$R" in *'"ok":true'*) echo "TAYYOR: @${USERNAME} ulandi. Hamkorlar kabinetdagi «Telegram'ni ulash» tugmasini bosadi." ;; *) echo "Webhook xatosi: $R"; exit 1 ;; esac
