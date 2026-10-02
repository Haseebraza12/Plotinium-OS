#!/usr/bin/env bash
# ops/backup.sh: snapshot-consistent backup of the Plotinium database and its blobs (DB-01, DBD-12).
# Spec: specs/09-database/database.md §3.30; specs/14-devops/deployment-and-ci.md §3.14.1 (OPS-14).
#
#   ops/backup.sh [--label NAME] [--no-upload]
#
# 1. In ONE `REPEATABLE READ READ ONLY` transaction as plotinium_owner: pg_export_snapshot(), then
#    the canonical tree checksum, row counts, the schema version and the blob manifest (every blob
#    with refcount > 0). The transaction stays open while
# 2. pg_dump -Fc --snapshot=<id> runs inside the db container (its pg_dump 18.6 matches the server),
#    so the dump and the manifest describe THE SAME snapshot even while users keep writing.
# 3. The manifest JSON: dump file and SHA-256, checksum, counts, schema version, image references,
#    blob list. Then the transaction closes.
# 4. `rclone copy` (NEVER `sync`: the remote is append-only for blobs, so the local 14-day blob GC can
#    never remove a blob that a retained dump references) of the dump, the manifest and the blob
#    directory to $RCLONE_REMOTE (Cloudflare R2), unless --no-upload or RCLONE_REMOTE is unset.
# 5. Local retention: 7 daily + 4 weekly (Sunday) dumps. The weekly REMOTE prune of blobs absent
#    from every retained manifest is ops/prune (TODO(R5)).
# Swap pages are never backed up. A failure exits non-zero and records it in the state file, which
# health-report.sh reads (the 6-hourly smoke fails when the last success is older than 26 h).
#
# Environment: BACKUP_DIR (/var/backups/plotinium), BACKUP_STATE_DIR (/srv/plotinium/state),
# RCLONE_REMOTE (e.g. r2:plotinium-backups), RCLONE_CONFIG (/srv/plotinium/secrets/rclone.conf),
# COMPOSE_PROJECT_NAME (plotinium), PGDATABASE (plotinium).
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/var/backups/plotinium}"
STATE_DIR="${BACKUP_STATE_DIR:-/srv/plotinium/state}"
PROJECT="${COMPOSE_PROJECT_NAME:-plotinium}"
DBNAME="${PGDATABASE:-plotinium}"
ROOT_INO='00000000-0000-7000-8000-000000000001'
label="nightly"
upload=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --no-upload) upload=0; shift ;;
    *) echo "usage: ops/backup.sh [--label NAME] [--no-upload]" >&2; exit 64 ;;
  esac
done
[[ "$label" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "backup: bad --label" >&2; exit 64; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="plotinium-${stamp}-${label}"
dump="${BACKUP_DIR}/${base}.dump"
manifest="${BACKUP_DIR}/${base}.manifest.json"
mkdir -p "$BACKUP_DIR" "$STATE_DIR" 2>/dev/null || true
t0=$(date +%s)

record_state() { # $1 = ok|failed, $2 = detail
  printf '{"at":"%s","result":"%s","detail":%s}\n' "$(date -u +%FT%TZ)" "$1" "$(jq -Rn --arg d "$2" '$d')" \
    > "${STATE_DIR}/backup-last.json" 2>/dev/null || true
}
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    record_state failed "exit ${rc}"
    rm -f "$dump" "$manifest"
  fi
}
trap on_exit EXIT

compose() { docker compose -p "$PROJECT" "$@"; }

# --- 1. open the snapshot transaction in a psql coprocess --------------------------------------
coproc PSQL { compose exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U plotinium_owner -d "$DBNAME"; }
ask() { # one query per line; the answer is one line
  printf '%s\n' "$1" >&"${PSQL[1]}"
  local line
  IFS= read -r line <&"${PSQL[0]}"
  printf '%s' "$line"
}
printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' >&"${PSQL[1]}"
snapshot="$(ask 'SELECT pg_export_snapshot();')"
[[ -n "$snapshot" ]] || { echo "backup: no snapshot id" >&2; exit 1; }
checksum="$(ask "SELECT plt_tree_checksum('${ROOT_INO}');")"
counts="$(ask "SELECT json_build_object('users',(SELECT count(*) FROM users),'inodes',(SELECT count(*) FROM inodes),'dentries',(SELECT count(*) FROM dentries),'blobs',(SELECT count(*) FROM blobs),'op_log',(SELECT count(*) FROM op_log),'audit_log',(SELECT count(*) FROM audit_log),'file_chunks',(SELECT count(*) FROM file_chunks));")"
schema="$(ask 'SELECT max(version) FROM schema_migrations;')"
blobs="$(ask "SELECT coalesce(json_agg(encode(sha256, 'hex') ORDER BY sha256), '[]') FROM blobs WHERE refcount > 0;")"

# --- 2. dump exactly that snapshot ---------------------------------------------------------------
compose exec -T db pg_dump -U plotinium_owner -Fc --snapshot="$snapshot" -d "$DBNAME" > "$dump"
printf 'COMMIT;\n' >&"${PSQL[1]}"
eval "exec ${PSQL[1]}>&-"
wait "$PSQL_PID" 2>/dev/null || true

# --- 3. the manifest -------------------------------------------------------------------------------
dump_sha="$(sha256sum "$dump" | cut -d' ' -f1)"
images="$(compose images --format json 2>/dev/null || echo '[]')"
blob_list="$(mktemp)"
printf '%s\n' "$blobs" > "$blob_list" # thousands of hashes: too long for an argument list
jq -n \
  --arg dump "$(basename "$dump")" --arg sha "$dump_sha" --arg checksum "$checksum" --arg schema "$schema" \
  --arg created "$(date -u +%FT%TZ)" --arg label "$label" --arg db "$DBNAME" \
  --argjson counts "$counts" --slurpfile blobs "$blob_list" --argjson images "$images" \
  '{format: "plotinium-backup/1", created: $created, label: $label, database: $db, dump: $dump,
    dumpSha256: $sha, treeChecksum: $checksum, schemaVersion: $schema, counts: $counts,
    images: [$images[]? | {service: .ContainerName, repository: .Repository, tag: .Tag, id: .ID}],
    blobs: $blobs[0]}' > "$manifest"
rm -f "$blob_list"

# --- 4. off-site copy (append-only) ----------------------------------------------------------------
if [[ "$upload" -eq 1 && -n "${RCLONE_REMOTE:-}" ]]; then
  export RCLONE_CONFIG="${RCLONE_CONFIG:-/srv/plotinium/secrets/rclone.conf}"
  rclone copy "$dump" "${RCLONE_REMOTE}/dumps/"
  rclone copy "$manifest" "${RCLONE_REMOTE}/dumps/"
  blob_dir="$(docker volume inspect "${PROJECT}_blobs" --format '{{.Mountpoint}}')/blobs"
  [[ -d "$blob_dir" ]] && rclone copy "$blob_dir" "${RCLONE_REMOTE}/blobs/"
else
  echo "backup: upload skipped (--no-upload or RCLONE_REMOTE unset)" >&2
fi

# --- 5. local retention: the 7 newest dumps, plus the newest 4 taken on a Sunday --------------------
mapfile -t all < <(ls -1t "${BACKUP_DIR}"/plotinium-*.dump 2>/dev/null || true)
keep=0; weekly=0
for f in "${all[@]}"; do
  if (( keep < 7 )); then keep=$((keep + 1)); continue; fi
  day="$(basename "$f" | sed -E 's/^plotinium-([0-9]{8})T.*/\1/')"
  if [[ "$(date -u -d "$day" +%u 2>/dev/null || echo 0)" == 7 ]] && (( weekly < 4 )); then weekly=$((weekly + 1)); continue; fi
  rm -f "$f" "${f%.dump}.manifest.json"
done

record_state ok "$(basename "$manifest")"
echo "backup: ${base} (checksum ${checksum}, schema ${schema}) in $(( $(date +%s) - t0 )) s"
