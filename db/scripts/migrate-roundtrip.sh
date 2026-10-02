#!/usr/bin/env bash
# db/scripts/migrate-roundtrip.sh: the DB-01 migration round trip (database.md §3.25, DBD-11).
#
#   docker compose up -d --wait db            # or: -f compose.yaml -f compose.test.yaml
#   db/scripts/migrate-roundtrip.sh           # check mode: fails if db/schema.sql would change
#   db/scripts/migrate-roundtrip.sh --write   # regenerate db/schema.sql after adding a migration
#
# Runs on a SCRATCH database (plotinium_roundtrip) in the Compose `db` service, never on the
# `plotinium` database, so it is safe against a developer's running stack. Steps:
#   1. dbmate --wait up on the empty scratch database
#   2. N = count(schema_migrations); dbmate rollback N times (dbmate 2.36.0 has no "roll back all")
#   3. assert no Plotinium relation, function or extension is left (0 besides plpgsql)
#   4. dbmate up again
#   5. dbmate dump through the dbmate image (pg_dump 18.6, matching the server)
#   6. normalise: drop the random `\restrict` / `\unrestrict` lines pg_dump 18 writes into every dump
#   7. compare with db/schema.sql (or write it with --write)
#   8. the newest migration alone: down, then up again
# CI wiring (tools/ci/migrate-roundtrip.sh in the integration job) is owned by R5; this script is
# the implementation it calls. kysely-codegen --verify is a separate step (server/README.md).
set -euo pipefail

cd "$(dirname "$0")/../.."
MODE="check"
[[ "${1:-}" == "--write" ]] && MODE="write"

PROJECT="${COMPOSE_PROJECT_NAME:-plotinium}"
DBNAME="${ROUNDTRIP_DB:-plotinium_roundtrip}"
DBMATE_IMAGE="${DBMATE_IMAGE:-ghcr.io/amacneil/dbmate:2.36.0@sha256:520c740c6e0ad73fde2cd1ea7e2b779aaf789d22aca8858f87a478e7094535fb}"
WORK="db/.roundtrip"

psql_db() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -X -q -At -U plotinium_owner "$@"; }

owner_pw="$(docker compose exec -T db cat /run/plotinium/owner_password)"
DATABASE_URL="postgres://plotinium_owner:${owner_pw}@db:5432/${DBNAME}?sslmode=disable"
export DATABASE_URL
unset owner_pw

dbmate() {
  # The URL travels in the environment, never in argv.
  docker run --rm --network "${PROJECT}_backplane" --user "$(id -u):$(id -g)" \
    -e DATABASE_URL -v "$PWD/db:/db" "$DBMATE_IMAGE" \
    --migrations-dir /db/migrations --schema-file "/db/.roundtrip/schema.sql" "$@"
}

cleanup() {
  psql_db -d postgres -c "DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)" >/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

t0=$(date +%s)
mkdir -p "$WORK"
psql_db -d postgres -c "DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)" -c "CREATE DATABASE ${DBNAME}"

echo "== 1. up on an empty database"
dbmate --wait --no-dump-schema up

n="$(psql_db -d "$DBNAME" -c 'SELECT count(*) FROM schema_migrations')"
echo "== 2. rollback ${n} times"
for _ in $(seq 1 "$n"); do dbmate --no-dump-schema rollback; done

echo "== 3. assert nothing is left"
left="$(psql_db -d "$DBNAME" <<'SQL'
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE s.nspname = 'public' AND c.relname NOT IN ('schema_migrations', 'schema_migrations_pkey'))
  || ' relations, ' ||
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public')
  || ' functions, ' ||
  (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') || ' extensions';
SQL
)"
echo "   ${left}"
if [[ "$left" != "0 relations, 0 functions, 0 extensions" ]]; then
  echo "FAIL: the full rollback left objects behind" >&2
  exit 1
fi

echo "== 4. up again"
dbmate --no-dump-schema up

echo "== 5-6. dump and normalise"
dbmate dump
grep -Ev '^\\(un)?restrict ' "$WORK/schema.sql" > "$WORK/schema.normalised.sql"

echo "== 7. compare with db/schema.sql (${MODE})"
if [[ "$MODE" == "write" ]]; then
  cp "$WORK/schema.normalised.sql" db/schema.sql
  echo "   wrote db/schema.sql"
elif ! diff -u db/schema.sql "$WORK/schema.normalised.sql"; then
  echo "FAIL: db/schema.sql is stale; run db/scripts/migrate-roundtrip.sh --write and commit it" >&2
  exit 1
fi

echo "== 8. newest migration: down, up"
dbmate --no-dump-schema rollback
dbmate --no-dump-schema up

echo "OK: round trip passed in $(( $(date +%s) - t0 )) s"
