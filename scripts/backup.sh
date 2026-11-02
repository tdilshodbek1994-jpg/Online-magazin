#!/usr/bin/env bash
# Logical backup of the Online Magazin database (custom format). Usage: scripts/backup.sh <DATABASE_URL> <out-file>
set -euo pipefail
pg_dump --format=custom --no-owner --no-privileges "$1" -f "$2"
sha256sum "$2" > "$2.sha256"
echo "backup written: $2"
