#!/bin/sh
# server/docker-entrypoint.sh: ENTRYPOINT of the `app` image (Dockerfile target `app`).
# Spec: specs/14-devops/deployment-and-ci.md §3.3; backend-api.md §3.18.1 (C14).
#
#   1. dbmate --wait up as the OWNER role (migrations are the only DDL path, DBD-01);
#   2. the idempotent demo seed as the owner (first start only: accounts, bench dataset, and the
#      generated passwords printed once in `docker compose logs app`, SRV-20);
#   3. exec the server as the APP role (DATABASE_URL + DATABASE_PASSWORD_FILE).
# The owner password is read from the generated secret file and handed to dbmate through an env
# prefix for that one command (never argv, so it is not in the process list), then unset; the
# OWNER_* variables are removed before the server starts.
set -eu

# The build identity the image was built with (Dockerfile stage `buildid`, UI-008): the same
# BUILD_SHA / BUILD_VERSION / BUILD_DATE as the web shell. The file holds KEY=value lines of hex
# digits, versions and dates only, written by tools/build-id.ts; nothing else is read from it.
if [ -r /app/build-id.env ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      BUILD_SHA) BUILD_SHA=$value; export BUILD_SHA ;;
      BUILD_VERSION) BUILD_VERSION=$value; export BUILD_VERSION ;;
      BUILD_DATE) BUILD_DATE=$value; export BUILD_DATE ;;
    esac
  done < /app/build-id.env
fi

: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL is required}"
: "${OWNER_PASSWORD_FILE:?OWNER_PASSWORD_FILE is required}"

owner_pw=$(cat "$OWNER_PASSWORD_FILE")
# postgres://plotinium_owner@db:5432/plotinium -> postgres://plotinium_owner:<pw>@db:5432/plotinium
owner_url=$(printf '%s' "$OWNER_DATABASE_URL" | sed "s#^\(postgres[a-z]*://[^@/:]*\)@#\1:${owner_pw}@#")
case "$owner_url" in *\?*) owner_url="${owner_url}&sslmode=disable" ;; *) owner_url="${owner_url}?sslmode=disable" ;; esac

DATABASE_URL="$owner_url" /app/server/node_modules/.bin/dbmate \
  --migrations-dir /app/db/migrations --wait --wait-timeout 60s --no-dump-schema up
unset owner_pw owner_url

node /app/server/src/seed.ts --demo

unset OWNER_DATABASE_URL OWNER_PASSWORD_FILE
exec node /app/server/src/main.ts
