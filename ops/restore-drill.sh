#!/usr/bin/env bash
# ops/restore-drill.sh: the weekly restore drill (DB-01, OPS-14; deployment-and-ci.md §3.14.3).
#
#   ops/restore-drill.sh [manifest.json]      # default: the newest manifest in $BACKUP_DIR
#   ops/restore-drill.sh --fresh-backup       # take a backup first (--no-upload), then drill it
#
# Restores the backup into the scratch database `plotinium_drill` of the running stack (the app
# keeps running on `plotinium`), runs the full verification of ops/restore.sh (tree checksum equal
# to the manifest, probes P1-P9 empty, blobs present), records the RTO and prints a result JSON
# with no data in it (for docs/evidence/deploy/restore-<date>.json), then drops the scratch
# database. With RCLONE_REMOTE set and no manifest given, the newest remote manifest is fetched
# first (the CI drill uses a read-only token). A failure exits non-zero and blocks the next tag.
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/var/backups/plotinium}"
PROJECT="${COMPOSE_PROJECT_NAME:-plotinium}"
DRILL_DB="plotinium_drill"
manifest="${1:-}"

if [[ "$manifest" == "--fresh-backup" ]]; then
  ops/backup.sh --label drill --no-upload
  manifest=""
fi
if [[ -z "$manifest" && -n "${RCLONE_REMOTE:-}" ]]; then
  mkdir -p "$BACKUP_DIR"
  latest="$(rclone lsf "${RCLONE_REMOTE}/dumps/" --include '*.manifest.json' | sort | tail -1)"
  [[ -n "$latest" ]] || { echo "drill: no remote manifest" >&2; exit 1; }
  rclone copy "${RCLONE_REMOTE}/dumps/${latest}" "$BACKUP_DIR/"
  rclone copy "${RCLONE_REMOTE}/dumps/${latest%.manifest.json}.dump" "$BACKUP_DIR/"
  manifest="${BACKUP_DIR}/${latest}"
fi
if [[ -z "$manifest" ]]; then
  manifest="$(ls -1t "${BACKUP_DIR}"/plotinium-*.manifest.json 2>/dev/null | head -1 || true)"
fi
[[ -n "$manifest" && -f "$manifest" ]] || { echo "drill: no manifest found in ${BACKUP_DIR}" >&2; exit 1; }

cleanup() {
  docker compose -p "$PROJECT" exec -T db psql -X -q -U plotinium_owner -d postgres \
    -c "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

t0=$(date +%s)
result=failed
if ops/restore.sh "$manifest" --database "$DRILL_DB"; then result=passed; fi
rto=$(( $(date +%s) - t0 ))
jq -n --arg at "$(date -u +%FT%TZ)" --arg result "$result" --argjson rto "$rto" \
  --arg manifest "$(basename "$manifest")" --arg schema "$(jq -r .schemaVersion "$manifest")" \
  --argjson counts "$(jq .counts "$manifest")" \
  '{drill: "database-restore", at: $at, result: $result, rtoSeconds: $rto, manifest: $manifest,
    schemaVersion: $schema, counts: $counts, target: {rtoSeconds: 600}}'
[[ "$result" == passed ]]
