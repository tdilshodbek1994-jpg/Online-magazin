#!/usr/bin/env bash
# PULL-BASED DEMO deploy, run ON THE SERVER (no inbound SSH from CI/Claude needed — works via the Vultr web console).
# Requires: bootstrap-demo.sh done (Docker + 2 GB swap), repo cloned to ~/online-magazin, .env filled in.
# Builds images on the server (slow on 1 vCPU: ~10-20 min first time; swap prevents OOM), backs up the DB first,
# then starts the DEMO stack. Idempotent; keeps existing data.
# Flags: --seed (base DEMO users/products), --demo-data (fill the DEMO with 500 products and realistic orders).
set -euo pipefail
cd "${OM_DIR:-$HOME/online-magazin}"
BRANCH="${OM_BRANCH:-claude/online-marketplace-platform-sdtv52}"
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.demo.yml"

[[ -f .env ]] || { echo "missing .env (copy .env.example and fill in)"; exit 1; }
grep -q "^OM_DOMAIN=." .env || { echo "OM_DOMAIN not set in .env"; exit 1; }
free -m | awk '/Swap/ {if ($2 < 1000) {print "WARNING: less than 1 GB swap — run bootstrap-demo.sh first"; exit 1}}'

echo "== update code ($BRANCH)"
git fetch --quiet origin "$BRANCH" && git checkout --quiet "$BRANCH" && git pull --quiet --ff-only origin "$BRANCH"
git log --oneline -1

echo "== backup current database (if running)"
if $C ps -q om-postgres 2>/dev/null | grep -q .; then
  mkdir -p ~/backups && $C exec -T om-postgres pg_dump -U om_app -Fc online_magazin > ~/backups/pre-deploy-$(date +%Y%m%d%H%M%S).dump && ls -1t ~/backups | head -3
fi

echo "== build images (one at a time to limit memory)"
docker build -f infra/docker/api.Dockerfile -t om-api:dev .
docker build --build-arg API_INTERNAL_URL=http://om-api:4000 -f infra/docker/web.Dockerfile -t om-web:dev .

echo "== start"
$C up -d --no-build --remove-orphans
for i in $(seq 1 60); do
  $C exec -T om-api node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { echo "API ready"; break; }
  sleep 3
done
for a in "$@"; do
  if [[ "$a" == "--seed" ]]; then $C exec -T om-api node dist/seed.js; fi
  # DEMO only: ~500 products + a few hundred orders in every state through the real flows (runs once; skips if already filled).
  if [[ "$a" == "--demo-data" ]]; then $C exec -T om-api node dist/demo/fill.js; fi
done
$C ps --format "table {{.Service}}\t{{.State}}"
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}"; free -m
docker image prune -f >/dev/null
