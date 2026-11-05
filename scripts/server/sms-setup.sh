#!/usr/bin/env bash
# Connects Eskiz.uz SMS for login codes. Run as the deploy user from the repo root:
#   bash scripts/server/sms-setup.sh
# Asks for the Eskiz cabinet email + password (password hidden), checks them against Eskiz, asks for the sender name and
# the OTP text EXACTLY as approved in the Eskiz cabinet (with {code} where the code goes), stores ESKIZ_* / SMS_OTP_TEXT
# in .env (backup kept) and restarts the API. Optionally sends one test SMS to your phone.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "XATO: .env topilmadi"; exit 1; }
read -r -p "Eskiz kabinet email: " EMAIL
read -r -s -p "Eskiz parol (ekranda ko'rinmaydi): " PASS; echo
[ -n "$EMAIL" ] && [ -n "$PASS" ] || { echo "XATO: email va parol kerak"; exit 1; }
[[ "$PASS" != *"'"* ]] || { echo "XATO: parolda ' belgisi bor — Eskiz kabinetida parolni o'zgartiring"; exit 1; }
LOGIN=$(curl -sS -X POST https://notify.eskiz.uz/api/auth/login -F "email=${EMAIL}" -F "password=${PASS}") || { echo "XATO: Eskiz bilan aloqa yo'q"; exit 1; }
TOKEN=$(printf '%s' "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "XATO: Eskiz email yoki parolni qabul qilmadi"; exit 1; }
echo "Eskiz: kirish muvaffaqiyatli."
read -r -p "Jo'natuvchi nomi (Eskiz tasdiqlagan; bo'lmasa Enter = 4546): " FROM; FROM=${FROM:-4546}
echo "SMS matni Eskiz kabinetida TASDIQLANGAN matn bilan bir xil bo'lishi shart. Kod o'rniga {code} yozing."
echo "Masalan: UzShop: tasdiqlash kodi {code}. Kodni hech kimga bermang."
read -r -p "Matn: " TEXT
[[ "$TEXT" == *"{code}"* ]] || { echo "XATO: matnda {code} bo'lishi kerak"; exit 1; }
[[ "$TEXT" != *$'\n'* && "$TEXT" != *'"'* ]] || { echo "XATO: matnda qo'shtirnoq (\") bo'lmasin"; exit 1; }
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -e '^ESKIZ_EMAIL=' -e '^ESKIZ_PASSWORD=' -e '^ESKIZ_FROM=' -e '^SMS_OTP_TEXT=' .env > .env.new || true
{ printf 'ESKIZ_EMAIL=%s\n' "$EMAIL"; printf "ESKIZ_PASSWORD='%s'\n" "$PASS"; printf 'ESKIZ_FROM=%s\n' "$FROM"; printf 'SMS_OTP_TEXT="%s"\n' "$TEXT"; } >> .env.new
mv .env.new .env && chmod 600 .env
read -r -p "Sinov SMS yuborilsinmi? Telefon raqamingiz (+998..., bo'sh = yo'q): " TEST
if [ -n "$TEST" ]; then
  MOB=$(printf '%s' "$TEST" | tr -cd '0-9')
  R=$(curl -sS -X POST https://notify.eskiz.uz/api/message/sms/send -H "Authorization: Bearer ${TOKEN}" \
      -F "mobile_phone=${MOB}" -F "message=${TEXT//\{code\}/123456}" -F "from=${FROM}") || R="xato"
  echo "Eskiz javobi: $R"
fi
unset PASS TOKEN
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"
$C up -d --no-build --force-recreate om-api >/dev/null
echo "TAYYOR: Eskiz ulandi. Kirish kodlari endi SMS bilan boradi (sinov rejimida kod ekranda ham ko'rinadi)."
