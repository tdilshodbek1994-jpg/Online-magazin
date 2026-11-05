#!/usr/bin/env bash
# Connects Firebase Cloud Messaging so the Android app gets push notifications. Run as the deploy user from the repo root:
#   bash scripts/server/push-setup.sh /path/to/service-account.json     (file uploaded to the server)
#   bash scripts/server/push-setup.sh                                   (paste the JSON, hidden, then Ctrl+D)
# Firebase console → Project settings → Service accounts → «Generate new private key» gives that JSON.
# Stores it base64-encoded as FCM_SERVICE_ACCOUNT_B64 in .env (backup kept), restarts the API, deletes the uploaded file.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "XATO: .env topilmadi"; exit 1; }
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
if [ -n "${1:-}" ]; then
  [ -f "$1" ] || { echo "XATO: fayl topilmadi: $1"; exit 1; }
  cp "$1" "$TMP"
else
  echo "Service account JSON ni qo'ying (ekranda ko'rinmaydi), keyin Enter va Ctrl+D bosing:"
  stty -echo 2>/dev/null || true; cat > "$TMP"; stty echo 2>/dev/null || true; echo
fi
grep -q '"type": *"service_account"' "$TMP" && grep -q '"private_key"' "$TMP" && grep -q '"project_id"' "$TMP" \
  || { echo "XATO: bu Firebase service account JSON emas"; exit 1; }
PROJECT=$(sed -n 's/.*"project_id": *"\([^"]*\)".*/\1/p' "$TMP" | head -1)
B64=$(base64 -w0 "$TMP")
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -e '^FCM_SERVICE_ACCOUNT_B64=' .env > .env.new || true
printf 'FCM_SERVICE_ACCOUNT_B64=%s\n' "$B64" >> .env.new
mv .env.new .env && chmod 600 .env
unset B64
[ -n "${1:-}" ] && rm -f "$1"
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"
$C up -d --no-build --force-recreate om-api >/dev/null
echo "TAYYOR: Firebase ($PROJECT) ulandi. Firebase bilan yig'ilgan ilova o'rnatilgan telefonlarga push boradi."
