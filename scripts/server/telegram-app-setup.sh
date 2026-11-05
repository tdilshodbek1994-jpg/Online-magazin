#!/usr/bin/env bash
# Connects a Telegram Mini App bot (partner first). Run as the deploy user from the repo root:
#   bash scripts/server/telegram-app-setup.sh partner     (asks for the BotFather token, hidden)
# What it does: verifies the token (getMe), stores TELEGRAM_<APP>_BOT_TOKEN / _USERNAME / _WEBHOOK_SECRET in .env
# (backup kept), restarts the API, registers the bot webhook, and sets the bot's menu button to open
# https://$OM_DOMAIN/tg/<app>. The notification bot (TELEGRAM_BOT_TOKEN) is not touched.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="${1:-partner}"
case "$APP" in partner) P=TELEGRAM_PARTNER_BOT; LABEL="Kabinet" ;; operator) P=TELEGRAM_OPERATOR_BOT; LABEL="Operator" ;; *) echo "XATO: partner yoki operator deb yozing"; exit 1 ;; esac
[ -f .env ] || { echo "XATO: .env topilmadi"; exit 1; }
DOMAIN=$(grep -E '^OM_DOMAIN=' .env | tail -n1 | cut -d= -f2-)
[ -n "$DOMAIN" ] || { echo "XATO: .env da OM_DOMAIN yo'q"; exit 1; }
read -r -s -p "BotFather bergan token (${APP} boti, ekranda ko'rinmaydi): " TOKEN; echo
[[ "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "XATO: token formati noto'g'ri"; exit 1; }
ME=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe") || { echo "XATO: Telegram tokenni qabul qilmadi"; exit 1; }
USERNAME=$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
[ -n "$USERNAME" ] || { echo "XATO: bot nomi aniqlanmadi"; exit 1; }
if grep -qE "^TELEGRAM_BOT_TOKEN=${TOKEN}$" .env; then echo "XATO: bu bildirishnoma botining tokeni. ${APP} boti uchun alohida bot kerak."; exit 1; fi
SECRET=$(openssl rand -hex 24)
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -e "^${P}_TOKEN=" -e "^${P}_USERNAME=" -e "^${P}_WEBHOOK_SECRET=" .env > .env.new || true
printf "%s_TOKEN=%s\n%s_USERNAME=%s\n%s_WEBHOOK_SECRET=%s\n" "$P" "$TOKEN" "$P" "$USERNAME" "$P" "$SECRET" >> .env.new
mv .env.new .env && chmod 600 .env
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"
$C up -d --no-build --force-recreate om-api >/dev/null
for i in $(seq 1 40); do $C exec -T om-api node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 3; done
URL="https://${DOMAIN}/tg/${APP}"
api() { curl -fsS "https://api.telegram.org/bot${TOKEN}/$1" "${@:2}"; }
R1=$(api setWebhook --data-urlencode "url=https://${DOMAIN}/api/v1/webhooks/telegram/app/${APP}" --data-urlencode "secret_token=${SECRET}" --data-urlencode 'allowed_updates=["message"]') || R1="xato"
R2=$(api setChatMenuButton --data-urlencode "menu_button={\"type\":\"web_app\",\"text\":\"${LABEL}\",\"web_app\":{\"url\":\"${URL}\"}}") || R2="xato"
if [ "$APP" = partner ]; then
  api setMyShortDescription --data-urlencode "short_description=UzShop hamkor kabineti: buyurtmalar, hamyon, mahsulotlar, AI yordamchi." >/dev/null || true
  api setMyCommands --data-urlencode 'commands=[{"command":"start","description":"Kabinetni ochish"}]' >/dev/null || true
fi
unset TOKEN
case "$R1$R2" in *'"ok":true'*'"ok":true'*) echo "TAYYOR: @${USERNAME} ulandi. Botda pastdagi «${LABEL}» tugmasi ${URL} ni ochadi." ;; *) echo "Diqqat: webhook=$R1 menu=$R2"; exit 1 ;; esac
