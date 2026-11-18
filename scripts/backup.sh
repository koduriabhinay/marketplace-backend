#!/usr/bin/env bash
# Logical backup of the database in pg_dump's compressed custom format.
# Usage: ./scripts/backup.sh [output-dir]      (reads DATABASE_URL, default: local dev DB)
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://marketplace:marketplace@localhost:5432/marketplace}"
OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/marketplace-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
echo "Backup written to $FILE ($(du -h "$FILE" | cut -f1))"
