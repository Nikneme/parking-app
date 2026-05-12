#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-${PG_URL:-}}" ]; then
  echo "DATABASE_URL or PG_URL is required" >&2
  exit 1
fi

DB_URL="${DATABASE_URL:-${PG_URL:-}}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/moyaparkovka-$STAMP.dump"

pg_dump "$DB_URL" --format=custom --no-owner --no-privileges --file="$OUT"
sha256sum "$OUT" > "$OUT.sha256"

echo "$OUT"
