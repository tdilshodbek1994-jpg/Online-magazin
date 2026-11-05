#!/usr/bin/env bash
# Restore drill (T093): back up SOURCE, restore into a fresh isolated DB, verify schema version and
# money/stock invariants, print timings. Payouts must stay blocked until PSP/bank reconciliation (§27).
set -euo pipefail
SRC="${1:?source DATABASE_URL}"; ADMIN="${2:?admin URL e.g. postgres://postgres:pw@localhost:5432/postgres}"
DB="om_restore_drill_$(date +%s)"; FILE="$(mktemp -d)/om.dump"
t0=$(date +%s.%N); pg_dump --format=custom --no-owner "$SRC" -f "$FILE"; t1=$(date +%s.%N)
psql "$ADMIN" -qc "CREATE DATABASE $DB"
DST="${ADMIN%/*}/$DB"
pg_restore --no-owner -d "$DST" "$FILE"; t2=$(date +%s.%N)
q() { psql "$1" -tAc "$2"; }
for sql in "SELECT count(*) FROM schema_migrations" "SELECT count(*) FROM orders" "SELECT coalesce(sum(debit_minor),0)-coalesce(sum(credit_minor),0) FROM journal_entries" \
           "SELECT count(*) FROM stock_balances WHERE reserved > on_hand_sellable" "SELECT count(*) FROM partner_ledger" "SELECT coalesce(sum(available_minor+reserved_minor+paid_minor),0) FROM partner_balances"; do
  a=$(q "$SRC" "$sql"); b=$(q "$DST" "$sql"); s=$([ "$a" = "$b" ] && echo OK || echo MISMATCH); echo "$s | $sql | src=$a restored=$b"
done
if [ -n "${MEDIA_DIR:-}" ] && [ -d "$MEDIA_DIR" ]; then
  MT="$(mktemp -d)"; tar -C "$MEDIA_DIR" -czf "$MT/m.tgz" .; mkdir "$MT/r"; tar -C "$MT/r" -xzf "$MT/m.tgz"
  a=$(cd "$MEDIA_DIR" && find . -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16); b=$(cd "$MT/r" && find . -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)
  n=$(find "$MEDIA_DIR" -type f | wc -l); echo "$([ "$a" = "$b" ] && echo OK || echo MISMATCH) | media files=$n digest src=$a restored=$b"
  # every DB media reference must exist in the restored media
  missing=0; for k in $(psql "$DST" -tAc "SELECT storage_key FROM media_assets"); do [ -f "$MT/r/public/$k" ] || missing=$((missing+1)); done; echo "$([ $missing = 0 ] && echo OK || echo MISMATCH) | media references missing=$missing"
fi
printf 'dump_seconds=%.2f restore_seconds=%.2f size_bytes=%s\n' "$(echo "$t1-$t0" | bc)" "$(echo "$t2-$t1" | bc)" "$(stat -c %s "$FILE")"
psql "$ADMIN" -qc "DROP DATABASE $DB WITH (FORCE)"
