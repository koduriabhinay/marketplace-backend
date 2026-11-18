#!/usr/bin/env bash
# Restores a backup made by backup.sh into the database at DATABASE_URL.
# Usage: ./scripts/restore.sh backups/marketplace-<timestamp>.dump
# A backup you've never restored is only a hope: rehearse this regularly.
set -euo pipefail

FILE="${1:?Usage: restore.sh <backup-file>}"
DATABASE_URL="${DATABASE_URL:-postgres://marketplace:marketplace@localhost:5432/marketplace}"

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  --dbname="$DATABASE_URL" "$FILE"
echo "Restored $FILE"
