#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-${PG_URL:-}}" ]; then
  echo "DATABASE_URL or PG_URL is required" >&2
  exit 1
fi

if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo "Refusing to restore without CONFIRM_RESTORE=YES" >&2
  exit 1
fi

if [ $# -ne 1 ]; then
  echo "Usage: CONFIRM_RESTORE=YES DATABASE_URL=... bash scripts/restore-postgres.sh path/to/backup.dump" >&2
  exit 1
fi

DB_URL="${DATABASE_URL:-${PG_URL:-}}"
BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [ -f "$BACKUP_FILE.sha256" ]; then
  sha256sum -c "$BACKUP_FILE.sha256"
fi

pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DB_URL" "$BACKUP_FILE"
