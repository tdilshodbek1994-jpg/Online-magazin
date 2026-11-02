#!/usr/bin/env bash
# One-command local DEMO with the SAME topology as the 2 GB server (Caddy + password + memory limits).
# Usage: scripts/demo-local.sh [--build] [--down]
#   --build  rebuild images from the current code first
#   --down   stop the DEMO and delete its local data volumes
# Opens https://localhost (self-signed local cert). Never touches any remote server.
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"

if [[ "${1:-}" == "--down" ]]; then $C down -v; exit 0; fi

if [[ ! -f .env ]]; then
  PASS="demo-$(openssl rand -hex 4)"
  HASH=$(docker run --rm caddy:2.8.4 caddy hash-password --plaintext "$PASS")
  cp .env.example .env
  sed -i "s|^OM_DOMAIN=.*|OM_DOMAIN=localhost|; s|^OM_CADDYFILE=.*|OM_CADDYFILE=Caddyfile.staging|; s|^OM_NODE_ENV=.*|OM_NODE_ENV=development|; s|^OM_STAGE_HASH=.*|OM_STAGE_HASH='$HASH'|; s|^OTP_RESEND_SECONDS=.*|OTP_RESEND_SECONDS=5|" .env
  sed -i "s|^OM_DB_PASSWORD=.*|OM_DB_PASSWORD=$(openssl rand -hex 16)|; s|^MFA_ENC_KEY=.*|MFA_ENC_KEY=$(openssl rand -base64 48 | tr -d '\n')|" .env
  echo "DEMO_PASSWORD_HINT=$PASS" >> .env   # local convenience only; .env is git-ignored
  echo "created .env (local DEMO password: $PASS)"
fi
set -a; . ./.env; set +a

if [[ "${1:-}" == "--build" ]] || ! docker image inspect om-api:dev om-web:dev >/dev/null 2>&1; then
  BUILD_ARGS=()
  [[ -n "${HTTPS_PROXY:-}" ]] && BUILD_ARGS+=(--network host --build-arg HTTPS_PROXY --build-arg HTTP_PROXY)
  [[ -f /root/.ccr/ca-bundle.crt ]] && BUILD_ARGS+=(--secret id=ca,src=/root/.ccr/ca-bundle.crt)
  docker build "${BUILD_ARGS[@]}" -f infra/docker/api.Dockerfile -t om-api:dev .
  docker build "${BUILD_ARGS[@]}" --build-arg API_INTERNAL_URL=http://om-api:4000 -f infra/docker/web.Dockerfile -t om-web:dev .
fi

$C up -d --no-build
echo -n "waiting for API"; for i in $(seq 1 90); do
  $C exec -T om-api node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; echo -n "."; sleep 2; done; echo
$C exec -T om-api node dist/seed.js | tail -1
$C ps --format "table {{.Service}}\t{{.State}}"
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" | grep online-magazin || true
cat <<MSG

DEMO ready:  https://localhost   (browser login: ${OM_STAGE_USER:-owner} / ${DEMO_PASSWORD_HINT:-<your password>})
Demo phones (OTP shown on screen): +998900000001 owner, ...02 operator, ...03 warehouse, ...04 courier,
                                   ...05 finance, ...06 catalog, ...07 partner (DEMO777), ...08 customer
Browser test:  WEB_URL=https://localhost E2E_BASIC_AUTH=${OM_STAGE_USER:-owner}:<password> E2E_INSECURE=1 node apps/web/e2e/smoke.mjs
Stop:          scripts/demo-local.sh --down
MSG
