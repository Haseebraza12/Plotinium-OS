#!/bin/sh
# ops/db/entrypoint.sh — ENTRYPOINT of the `db` image (Dockerfile target `db`).
# Spec: specs/14-devops/deployment-and-ci.md §3.3 (OPS-03); database.md §3.2, §4.1 (C10).
#
# Generates the two database passwords at FIRST start into the `dbsecrets` volume mounted at
# /run/plotinium, then hands over to the official postgres entrypoint. No password is ever written
# in the repository, compose.yaml or .env.example.
#   owner_password  plotinium_owner, the bootstrap superuser (dbmate, seed, backups)
#   app_password    plotinium_app, the run-time role (created by initdb.d/10-app-role.sh)
# Files are 64 hex characters, mode 0440, owner postgres (999) and group node (1000), so the app
# container's `node` user can read them through the read-only mount.
set -eu

d=/run/plotinium
mkdir -p "$d"
for f in owner_password app_password; do
  if [ ! -s "$d/$f" ]; then
    # umask only in this subshell: the postgres entrypoint must keep its default umask, or the
    # data directory parents it creates as root become unreadable for the postgres user.
    (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$d/$f.tmp")
    mv "$d/$f.tmp" "$d/$f"
  fi
done
chown 999:1000 "$d/owner_password" "$d/app_password"
chmod 0440 "$d/owner_password" "$d/app_password"

export POSTGRES_PASSWORD_FILE="$d/owner_password"
exec docker-entrypoint.sh "$@"
