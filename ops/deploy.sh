#!/usr/bin/env bash
# ops/deploy.sh: deploy a RELEASED tag to the VPS by image digest (OPS-08, OPS-16, OPS-22).
# Spec: specs/14-devops/deployment-and-ci.md §3.11.1, §5.1 (deploy state machine), D-5, D-6.
#
#   ops/deploy.sh <tag> [--project prod|staging] [--no-backup]
#   ops/deploy.sh edge@sha256:<digest> --project staging --no-backup     # nightly staging
#
# Runs on the VPS as user `deploy` from /srv/plotinium (a clone of the repository), under
# flock /srv/plotinium/.deploy.lock:
#   1. git fetch --tags; git checkout --detach <tag> (compose files and ops scripts come from the tag)
#   2. download images.lock.json from the tag's GitHub Release (public asset) and write .env.images
#      with PLOTINIUM_{WEB,APP,DB}_IMAGE=ghcr.io/...@sha256:...; refuse any reference that is not a digest
#   3. unless --no-backup: ops/backup.sh --label pre-<tag>
#   4. docker compose ... pull
#   5. docker compose ... up -d --wait --wait-timeout 240 (db, app, web in one pass; the app
#      entrypoint applies the pending migrations, which MUST be expand-only)
#   6. smoke: /api/readyz is 200, /version.json names the tag, /sw.js is served no-cache
#   7. on a failure in 5 or 6: roll back to the previous successful tag (deploy.sh <prev> --no-backup)
#      and exit non-zero, which marks the GitHub deployment failed
#   8. prune images older than 7 days; append one JSON line to /srv/plotinium/deploys.log
# Environment: PLOTINIUM_REPO (<org>/plotinium, for the release asset URL), PLOTINIUM_DOMAIN (from
# .env), DEPLOY_ROOT (/srv/plotinium), GITHUB_ACTOR / DEPLOY_APPROVER (recorded in the log).
set -euo pipefail

ROOT="${DEPLOY_ROOT:-/srv/plotinium}"
REPO="${PLOTINIUM_REPO:?PLOTINIUM_REPO=<org>/plotinium is required}"
DIGEST_RE='^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'

ref="${1:-}"
[[ -n "$ref" ]] || { echo "usage: ops/deploy.sh <tag> [--project prod|staging] [--no-backup]" >&2; exit 64; }
shift
project=prod
backup=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --no-backup) backup=0; shift ;;
    *) echo "deploy: unknown option $1" >&2; exit 64 ;;
  esac
done
[[ "$project" == prod || "$project" == staging ]] || { echo "deploy: --project is prod or staging" >&2; exit 64; }

cd "$ROOT"
exec 9>"${ROOT}/.deploy.lock"
flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 75; }

if [[ "$project" == prod ]]; then
  compose_args=(-p plotinium -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .env.images)
else
  compose_args=(-p plotinium-staging -f compose.yaml -f compose.staging.yaml --env-file .env.staging --env-file .env.images)
fi
compose() { docker compose "${compose_args[@]}" "$@"; }
now_ms() { date +%s%3N; }
t_start=$(now_ms)
declare -A dur=([backup]=0 [pull]=0 [up]=0 [smoke]=0)
prev_tag="$(tail -n 50 "${ROOT}/deploys.log" 2>/dev/null | jq -r "select(.result == \"ok\" and .project == \"${project}\") | .tag" | tail -1 || true)"

log_result() { # $1 = ok|rolled-back|failed
  jq -cn --arg at "$(date -u +%FT%TZ)" --arg tag "$ref" --arg project "$project" --arg result "$1" \
    --arg by "${GITHUB_ACTOR:-$(whoami)}" --arg approvedBy "${DEPLOY_APPROVER:-unknown}" \
    --argjson images "$(cat images.lock.json 2>/dev/null | jq '.images // {}' || echo '{}')" \
    --argjson backup "${dur[backup]}" --argjson pull "${dur[pull]}" --argjson up "${dur[up]}" --argjson smoke "${dur[smoke]}" \
    '{at: $at, tag: $tag, project: $project, by: $by, approvedBy: $approvedBy, images: $images, result: $result,
      durations: {backup: $backup, pull: $pull, up: $up, smoke: $smoke}}' >> "${ROOT}/deploys.log"
}

rollback() {
  local why="$1"
  echo "deploy: ${why}" >&2
  if [[ -n "$prev_tag" && "$prev_tag" != "$ref" && "${PLOTINIUM_NO_ROLLBACK:-0}" != 1 ]]; then
    echo "deploy: rolling back to ${prev_tag}" >&2
    log_result rolled-back
    flock -u 9
    PLOTINIUM_NO_ROLLBACK=1 "$0" "$prev_tag" --project "$project" --no-backup || true
  else
    log_result failed
  fi
  exit 1
}

# --- 1. the tag's compose files and scripts -----------------------------------------------------
if [[ "$project" == prod ]]; then
  git fetch --tags --force --quiet
  git checkout --quiet --detach "$ref"
fi

# --- 2. images by digest -------------------------------------------------------------------------
if [[ "$project" == staging ]]; then
  # staging (OPS-22, SHOULD): the nightly workflow passes the three `edge` digests of main.
  # TODO(R5): compose.staging.yaml (127.0.0.1:4718 only, own volumes) is not written yet.
  [[ -f compose.staging.yaml ]] || { echo "deploy: compose.staging.yaml does not exist yet" >&2; exit 1; }
  : "${STAGING_IMAGES:?STAGING_IMAGES must hold the three PLOTINIUM_*_IMAGE=...@sha256 lines}"
  printf '%s\n' "$STAGING_IMAGES" > .env.images
  echo '{"images":{}}' > images.lock.json
else
  curl -fsSL --retry 3 -o images.lock.json "https://github.com/${REPO}/releases/download/${ref}/images.lock.json"
  {
    printf 'PLOTINIUM_WEB_IMAGE=%s\n' "$(jq -r '.images.web.ref + "@" + .images.web.digest' images.lock.json)"
    printf 'PLOTINIUM_APP_IMAGE=%s\n' "$(jq -r '.images.app.ref + "@" + .images.app.digest' images.lock.json)"
    printf 'PLOTINIUM_DB_IMAGE=%s\n' "$(jq -r '.images.db.ref + "@" + .images.db.digest' images.lock.json)"
  } > .env.images
fi
while IFS='=' read -r name value; do
  [[ -z "$name" ]] && continue
  [[ "$value" =~ $DIGEST_RE ]] || { echo "deploy: ${name} is not an image digest reference: ${value}" >&2; exit 1; }
done < .env.images

# --- 3. pre-deploy backup ------------------------------------------------------------------------
if [[ "$backup" -eq 1 ]]; then
  t=$(now_ms); ops/backup.sh --label "pre-${ref//[^a-zA-Z0-9._-]/_}"; dur[backup]=$(( $(now_ms) - t ))
fi

# --- 4-5. pull and recreate in one pass ------------------------------------------------------------
t=$(now_ms); compose pull --quiet; dur[pull]=$(( $(now_ms) - t ))
t=$(now_ms)
compose up -d --wait --wait-timeout 240 || rollback "the stack did not become healthy"
dur[up]=$(( $(now_ms) - t ))

# --- 6. smoke --------------------------------------------------------------------------------------
t=$(now_ms)
if [[ "$project" == prod ]]; then
  base="https://${PLOTINIUM_DOMAIN:-$(sed -n 's/^PLOTINIUM_DOMAIN=//p' .env)}"
else
  base="http://127.0.0.1:4718"
fi
curl -fsS --retry 5 --retry-delay 2 "${base}/api/readyz" >/dev/null || rollback "readyz is not 200"
if [[ "$project" == prod ]]; then
  version="$(curl -fsS "${base}/version.json" | jq -r .version)"
  [[ "v${version}" == "$ref" ]] || rollback "version.json says ${version}, expected ${ref}"
fi
curl -fsSI "${base}/sw.js" | grep -qi '^cache-control: no-cache' || rollback "sw.js is not served no-cache"
dur[smoke]=$(( $(now_ms) - t ))

# --- 8. housekeeping -------------------------------------------------------------------------------
docker image prune -f --filter "until=168h" >/dev/null
log_result ok
echo "deploy: ${ref} (${project}) healthy in $(( ($(now_ms) - t_start) / 1000 )) s"
