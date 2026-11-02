#!/usr/bin/env bash
# Backup of the Online Magazin database (custom format) and, if MEDIA_DIR is set, product media.
# Usage: MEDIA_DIR=/data/media scripts/backup.sh <DATABASE_URL> <out-prefix>
set -euo pipefail
pg_dump --format=custom --no-owner --no-privileges "$1" -f "$2.dump"
if [ -n "${MEDIA_DIR:-}" ] && [ -d "$MEDIA_DIR" ]; then tar -C "$MEDIA_DIR" -czf "$2.media.tgz" .; fi
sha256sum "$2".* > "$2.sha256"
echo "backup written: $2.*"
