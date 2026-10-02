#!/usr/bin/env bash
# ops/restore.sh: restore a backup made by ops/backup.sh and verify it (DB-01, DBD-12).
# Spec: specs/09-database/database.md §3.30; specs/14-devops/deployment-and-ci.md §3.14.2
# (RPO 24 h, RTO target <= 10 min).
#
#   ops/restore.sh <manifest.json> [--database NAME] [--keep-app]
#
# Default (production restore into `plotinium`): stop app; verify the dump's SHA-256; dropdb --force
# and createdb; pg_restore -j 2 --exit-on-error as the owner (the roles already exist: the db init
# hook creates them); copy the manifest's blobs that are missing locally from $RCLONE_REMOTE; VERIFY
# (the tree checksum equals the manifest, probes P1-P9 are empty, every blob with refcount > 0 is on
# disk); VACUUM (ANALYZE); start app. `--database NAME` restores into a scratch database instead and
# leaves app running (the restore drill). Exits non-zero on any mismatch.
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT_NAME:-plotinium}"
ROOT_INO='00000000-0000-7000-8000-000000000001'
manifest="${1:-}"
[[ -n "$manifest" && -f "$manifest" ]] || { echo "usage: ops/restore.sh <manifest.json> [--database NAME] [--keep-app]" >&2; exit 64; }
shift
target="plotinium"
keep_app=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --database) target="$2"; keep_app=1; shift 2 ;;
    --keep-app) keep_app=1; shift ;;
    *) echo "restore: unknown option $1" >&2; exit 64 ;;
  esac
done
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "restore: bad database name" >&2; exit 64; }

compose() { docker compose -p "$PROJECT" "$@"; }
psql_db() { compose exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U plotinium_owner "$@"; }
t0=$(date +%s)

dump="$(dirname "$manifest")/$(jq -r .dump "$manifest")"
want_sha="$(jq -r .dumpSha256 "$manifest")"
want_sum="$(jq -r .treeChecksum "$manifest")"
[[ -f "$dump" ]] || { echo "restore: dump $dump not found" >&2; exit 1; }
[[ "$(sha256sum "$dump" | cut -d' ' -f1)" == "$want_sha" ]] || { echo "restore: dump SHA-256 mismatch" >&2; exit 1; }

[[ "$keep_app" -eq 1 ]] || compose stop app

compose cp "$dump" db:/tmp/plotinium-restore.dump
psql_db -d postgres -c "DROP DATABASE IF EXISTS ${target} WITH (FORCE)" -c "CREATE DATABASE ${target}"
compose exec -T db pg_restore -U plotinium_owner -d "$target" -j 2 --exit-on-error /tmp/plotinium-restore.dump
compose exec -T db rm -f /tmp/plotinium-restore.dump

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  export RCLONE_CONFIG="${RCLONE_CONFIG:-/srv/plotinium/secrets/rclone.conf}"
  blob_dir="$(docker volume inspect "${PROJECT}_blobs" --format '{{.Mountpoint}}')/blobs"
  rclone copy --ignore-existing "${RCLONE_REMOTE}/blobs/" "$blob_dir"
fi

# --- verify ------------------------------------------------------------------------------------
got_sum="$(psql_db -d "$target" -c "SELECT plt_tree_checksum('${ROOT_INO}')")"
if [[ "$got_sum" != "$want_sum" ]]; then
  echo "restore: tree checksum ${got_sum} differs from the manifest ${want_sum}" >&2
  exit 1
fi
violations="$(sed -e '/^[[:space:]]*\\/d' -e '/^BEGIN/d' -e '/^COMMIT/d' -e "s/:'root'/'${ROOT_INO}'/g" db/probes/integrity.sql \
  | psql_db -d "$target" | grep -c . || true)"
if [[ "$violations" != "0" ]]; then
  echo "restore: ${violations} integrity probe rows (P1-P9 must be empty)" >&2
  exit 1
fi
missing=0
blob_dir="$(docker volume inspect "${PROJECT}_blobs" --format '{{.Mountpoint}}' 2>/dev/null || true)/blobs"
if [[ -r "$blob_dir" ]]; then
  while IFS= read -r sha; do
    [[ -f "${blob_dir}/sha256/${sha:0:2}/${sha:2:2}/${sha}" ]] || missing=$((missing + 1))
  done < <(jq -r '.blobs[]' "$manifest")
  [[ "$missing" -eq 0 ]] || { echo "restore: ${missing} referenced blobs are missing from the blob store" >&2; exit 1; }
else
  echo "restore: blob presence not checked (${blob_dir} not readable; run as root on the host)" >&2
fi

psql_db -d "$target" -c 'VACUUM (ANALYZE)'
[[ "$keep_app" -eq 1 ]] || compose start app
echo "restore: ${target} verified (checksum ${got_sum}) in $(( $(date +%s) - t0 )) s"
