#!/bin/sh
# Streaming read replica. On first start it copies the primary with pg_basebackup, then
# runs as a hot standby: it replays the primary's WAL continuously and accepts read-only
# queries. Any write sent to it fails ("cannot execute INSERT in a read-only transaction").
set -eu
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h "$PRIMARY_HOST" -U replicator -q; do
    echo "waiting for primary at $PRIMARY_HOST..."
    sleep 1
  done
  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" -U replicator -D "$PGDATA" \
    --wal-method=stream --write-recovery-conf \
    --create-slot --slot=replica_1 --no-password --progress
  chmod 0700 "$PGDATA"
fi
exec postgres -c hot_standby=on
