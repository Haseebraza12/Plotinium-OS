# syntax=docker/dockerfile:1
#
# Plotinium images (C9, C14). One multi-stage Dockerfile, three shipped targets:
#   web  Caddy 2.11.4 + the built shell (static files, every security header)
#   app  Node 24, ONE process: dbmate migrations, the idempotent demo seed, then the Fastify server
#   db   PostgreSQL 18.6 + pgvector 0.8.6 with first-start password generation
# Spec: specs/14-devops/deployment-and-ci.md §3.3-§3.5 (OPS-02, OPS-04, OPS-19).
#
# Base images are pinned by DIGEST (D-4). They are the upstream digests resolved on 2026-09-24;
# once mirror-images.yml exists, R5 replaces each default below with the GHCR mirror of the SAME
# digest (ghcr.io/<org>/mirror/...), recorded in ops/mirrors.lock.json, so that the examiner path
# never resolves a Docker Hub name. Override for experiments with --build-arg, never in a release.
ARG NODE_IMAGE=docker.io/library/node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG CADDY_IMAGE=docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
ARG PGVECTOR_IMAGE=docker.io/pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff

# ---------------------------------------------------------------------------------------------
# deps: pnpm and the package store, keyed by the lockfile only (cache layer).
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.5.1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---------------------------------------------------------------------------------------------
# buildid: ONE build identity for the web shell and the server (UI-008). The context has no .git,
# so `pnpm start` passes BUILD_SHA (the git short SHA of a clean checkout, else a content hash of
# the source tree), BUILD_VERSION, BUILD_DATE and SOURCE_DATE_EPOCH, computed by tools/build-id.ts
# on the host. Without them (a plain `docker compose up --build`) the same script hashes the source
# tree here, so no build path ships `0000000`. Valid build args always win (the release pipeline
# passes its own). Output: /build-id.env (KEY=value lines), read by the build and app stages.
# ---------------------------------------------------------------------------------------------
FROM deps AS buildid
ARG BUILD_VERSION=
ARG BUILD_SHA=
ARG BUILD_DATE=
ARG SOURCE_DATE_EPOCH
COPY . .
RUN node tools/build-id.ts > /build-id.env && cat /build-id.env

# ---------------------------------------------------------------------------------------------
# app-deps: production dependencies of @plotinium/server and its workspace dependencies only.
# The server runs from source with Node 24 type stripping (server/README.md), so workspace
# packages stay as symlinks into their real directories (Node refuses to strip types under
# node_modules; `pnpm deploy` would copy them there).
# ---------------------------------------------------------------------------------------------
FROM deps AS app-deps
# Every workspace manifest, so the frozen lockfile matches the workspace; only the server's
# production closure is installed.
COPY package.json ./
COPY protocol/package.json protocol/
COPY dsa/package.json dsa/
COPY kernel/package.json kernel/
COPY vfs/package.json vfs/
COPY services/package.json services/
COPY wm/package.json wm/
COPY apps/package.json apps/
COPY ui/package.json ui/
COPY ai/package.json ai/
COPY server/package.json server/
COPY db/package.json db/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --offline --prod --filter "@plotinium/server..."
COPY protocol/src protocol/src
COPY dsa/src dsa/src
COPY vfs/src vfs/src
COPY server/src server/src
COPY server/docker-entrypoint.sh server/docker-entrypoint.sh
COPY db/migrations db/migrations
COPY db/probes db/probes
COPY db/seed db/seed

# ---------------------------------------------------------------------------------------------
# app: the server image. Runs as `node` (uid 1000). The official image bundles OpenSSL 3.5.x,
# which node:crypto argon2 needs (SRV-17 self-test).
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production \
    PLOTINIUM_MIGRATIONS_DIR=/app/db/migrations \
    BLOB_DIR=/var/lib/plotinium/blobs
WORKDIR /app
COPY --from=app-deps /repo /app
# BUILD_SHA, BUILD_VERSION and BUILD_DATE: docker-entrypoint.sh exports them from this file, so the
# server reports the same identity as the web shell (UI-008).
COPY --from=buildid /build-id.env /app/build-id.env
RUN mkdir -p /var/lib/plotinium/blobs \
 && chown -R node:node /var/lib/plotinium \
 && chmod 0755 /app/server/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/app/server/docker-entrypoint.sh"]

# ---------------------------------------------------------------------------------------------
# build: builds the real shell (web/dist: the inlined boot splash, the kernel and executor
# bundles, the Service Worker sw.js with its precache manifest, version.json, boot-manifest.json),
# then the CSP with the SHA-256 of every inline script and style of the built index.html
# (security-model.md §3.9, OPS-19). The web build writes that CSP as web/dist/csp.caddy (the same
# policy as ops/caddy/csp-hash.ts, which stays the fallback); it is moved out of the web root.
# WEB_BUILD=required (default): a missing or failing shell build fails the image, so an image can
#   never silently ship a page that is not Plotinium.
# WEB_BUILD=auto (escape hatch, e.g. --build-arg WEB_BUILD=auto while web/ is broken): on failure
#   ship the static placeholder of ops/web-placeholder with a loud warning.
# BUILD_SHA / BUILD_VERSION / SOURCE_DATE_EPOCH feed the build identity (the context has no .git):
# they come from the buildid stage's /build-id.env, which this stage starts from (UI-008).
# ---------------------------------------------------------------------------------------------
FROM buildid AS build
ARG WEB_BUILD=required
RUN set -eu; \
    set -a; . /build-id.env; set +a; \
    built=0; \
    if [ -f web/index.html ]; then \
      if pnpm install --frozen-lockfile --offline \
         && pnpm --filter @plotinium/web build \
         && [ -f web/dist/index.html ] && [ -f web/dist/sw.js ]; then \
        built=1; \
      elif [ "$WEB_BUILD" = required ]; then \
        echo "web build failed and WEB_BUILD=required" >&2; exit 1; \
      fi; \
    elif [ "$WEB_BUILD" = required ]; then \
      echo "web/index.html is missing and WEB_BUILD=required" >&2; exit 1; \
    fi; \
    if [ "$built" = 0 ]; then \
      echo "WARNING: shipping the placeholder shell (ops/web-placeholder): web/ did not build" >&2; \
      rm -rf web/dist && mkdir -p web/dist && cp -R ops/web-placeholder/. web/dist/; \
    fi
RUN set -eu; \
    set -a; . /build-id.env; set +a; \
    if [ -f web/dist/csp.caddy ]; then \
      mv web/dist/csp.caddy /repo/csp.caddy; \
    else \
      node ops/caddy/csp-hash.ts web/dist/index.html > /repo/csp.caddy; \
    fi; \
    grep -q "Content-Security-Policy" /repo/csp.caddy; \
    if [ ! -f web/dist/version.json ]; then \
      printf '{"name":"Plotinium","version":"%s","build":"%s","date":"%s"}\n' \
        "$BUILD_VERSION" "$BUILD_SHA" "$BUILD_DATE" > web/dist/version.json; \
    fi

# ---------------------------------------------------------------------------------------------
# web: Caddy with the baked shell. Caddy owns static files and EVERY security header (OPS-06).
# ---------------------------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS web
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/csp.caddy /etc/caddy/csp.caddy
RUN mkdir -p /etc/caddy/prod.d
COPY --from=build /repo/web/dist /srv
EXPOSE 4717 80 443 443/udp 8081

# ---------------------------------------------------------------------------------------------
# db: PostgreSQL 18.6 + pgvector 0.8.6. Adds nothing to PostgreSQL itself: a wrapper that
# generates the passwords at first start, and the init hook that creates role plotinium_app.
# Compose passes the -c settings of database.md §3.24.
# ---------------------------------------------------------------------------------------------
FROM ${PGVECTOR_IMAGE} AS db
COPY --chmod=0755 ops/db/entrypoint.sh /usr/local/bin/plotinium-db-entrypoint.sh
COPY --chmod=0755 ops/db/initdb.d/ /docker-entrypoint-initdb.d/
RUN test "$(id -u postgres)" = "999"
ENTRYPOINT ["plotinium-db-entrypoint.sh"]
CMD ["postgres"]
