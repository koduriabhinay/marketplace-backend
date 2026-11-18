#!/usr/bin/env bash
# Runs ON THE SERVER. Backs up the database and the uploaded photos into backups/, and
# deletes backups older than 14 days. Cron runs it nightly; deploy.sh runs it before
# every deploy. Restore steps are in docs/PHASE-7.md.
#
# These files live on the same disk as the data. Copy them somewhere else too (the guide
# shows how): a backup on the machine that died is not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

mkdir -p backups
chmod 700 backups # dumps contain email addresses and password hashes
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

# pg_dump runs inside the Postgres container, so the server needs no database tools.
dc exec -T postgres pg_dump -U marketplace --format=custom --no-owner --no-privileges marketplace \
  > "backups/marketplace-$stamp.dump.tmp"
mv "backups/marketplace-$stamp.dump.tmp" "backups/marketplace-$stamp.dump"

api="$(dc ps -q api | head -n 1)"
if [ -n "$api" ]; then
  docker exec "$api" tar -czf - -C /app uploads > "backups/uploads-$stamp.tar.gz"
fi

find backups -type f \( -name '*.dump' -o -name '*.tar.gz' -o -name '*.tmp' \) -mtime +14 -delete
echo "Backup $stamp written to backups/ ($(du -sh backups | cut -f1) in total)"
