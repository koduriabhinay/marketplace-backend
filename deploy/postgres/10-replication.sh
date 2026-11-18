#!/bin/sh
# Runs once, when the primary's data directory is first created.
# Creates a login that may only stream WAL (the change log) to replicas.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
