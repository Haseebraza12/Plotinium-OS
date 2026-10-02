# @plotinium/server

ONE Node 24 process, a modular monolith of Fastify 5 plugins (C9). Caddy serves the static shell and owns every security header; Fastify serves only `/api/*` and `/ws`. There is no helmet, no `@fastify/static`, no Redis and no LISTEN/NOTIFY: broadcasts happen in-process after COMMIT.

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R2 VFS/DB (sync engine, lock manager, `vfsTxn`, index API, agent `sys.batch` executor, audit)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Secondary reviewer | per plugin (table below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Implements         | [specs/11-server/backend-api.md](../specs/11-server/backend-api.md)<br>[specs/06-sync/offline-and-sync.md](../specs/06-sync/offline-and-sync.md)<br>[specs/12-security/security-model.md](../specs/12-security/security-model.md)<br>[specs/09-database/database.md](../specs/09-database/database.md)                                                                                                                                                                                                                      |
| Requirement IDs    | VFS-09, VFS-10, OFF-02, OFF-03, MEM-04, MEM-05, DB-02, DB-03, RAG-03, AGT-05, AGT-08, spec §12.6                                                                                                                                                                                                                                                                                                                                                                                                                            |
| May import         | `@plotinium/protocol`, `@plotinium/dsa`, `@plotinium/vfs/path`, `@plotinium/vfs/perm`, generated DB types. Never the client packages.                                                                                                                                                                                                                                                                                                                                                                                       |
| Status             | v0.1.0: every plugin is wired to its engine. Auth gateway; `/ws` protocol v1 (hello/resume by per-owner feed, op lane with credits, `vfs.changed` broadcast, S/X leases with fencing, heartbeats, close codes, throttle); `POST /api/ops/{opId}`; `GET /api/sync/snapshot`; `/api/blobs`; `/api/swap`; `/api/index` (AI=1); `/api/llm` (AI=1, `no-key` degrades to 503 EAIUNAVAIL); `/api/telemetry`; the fault harness (FAULT_INJECTION=1, root only). Not yet: the `copy` and `batch` op kinds (answered `retry ENOSYS`). |

## Layout

| Folder (`src/`) | Plugin                                                          | Primary | Secondary |
| --------------- | --------------------------------------------------------------- | ------- | --------- |
| `gateway/`      | auth, sessions, `su` grants, guest and demo accounts            | R5      | R2        |
| `sync/`         | WebSocket `/ws`, sync engine, per-owner feed, snapshot          | R2      | R5        |
| `locks/`        | lock manager, lease sweeper                                     | R2      | R5        |
| `vfs/`          | `vfsTxn`, lock plan, set-based ops, fault harness               | R2      | R5        |
| `storage/`      | `FsBlobStore` (content-addressed), GC                           | R1      | R2        |
| `swap/`         | `/api/swap` (tier-2 swap, write-behind)                         | R1      | R2        |
| `index/`        | `/api/index` put, pull, search, verify                          | R2      | R4        |
| `llm/`          | LLM gateway, budget, cassettes, pricing                         | R4      | R2        |
| `obs/`          | pino, prom-client `/metrics`, `/healthz`, `/readyz`             | R5      | R1        |
| `db/`           | pg Pool, Kysely, errno mapping, `types.gen.ts` (kysely-codegen) | R2      | R5        |

## Runtime notes

- Runs from source with Node 24 type stripping, so relative imports carry the `.ts` extension and only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`).
- `dbmate` is a production dependency: the container entrypoint runs `dbmate --wait --no-dump-schema up`, then the demo seed, then the server (C14).
- No credentials in the repository or in `compose.yaml`: they are generated at first start and printed only in the app logs (C10). The block is printed ONCE, by the container that ran the first seed; after the app container is recreated (any `docker compose up --build`) it is gone from `docker compose logs app`. To issue new ones (this invalidates the old passwords and revokes those accounts' sessions), send them to the app log rather than your terminal:

  ```sh
  docker compose exec -T app sh -c 'node server/src/seed.ts --reissue-credentials > /proc/1/fd/1'
  docker compose logs app | grep -A12 'RE-ISSUED CREDENTIALS'
  ```

- Graceful shutdown (SIGTERM): readyz turns `draining`, new upgrades get 503, every socket finishes its running op for up to `SHUTDOWN_GRACE_MS / 2` and then gets `bye restart` / 1012 (leases stay), then Fastify closes.

## Process

`server/docker-entrypoint.sh` (the app image) runs `dbmate --wait up` as the owner role, then `node server/src/seed.ts --demo` (idempotent first-start seed: accounts with generated passwords printed once in `docker compose logs app`, and the bench10k data set unless `PLOTINIUM_SEED_PROFILE=none`), then `exec node server/src/main.ts` as the app role. `main.ts` exits 78 on a bad configuration and 70 on a failed self-test (Argon2id and SHA-256 known answers, blob store probe, PostgreSQL 18 / pgvector 0.8.6 / builtin locale / migration version).

## Commands

```sh
pnpm --filter @plotinium/server typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/server test        # the Vitest project named "server"
```

DB-gated tests (`*.int.test.ts`, `runtime.test.ts`) run only with `DATABASE_URL` (owner role). It names a freshly migrated database that nothing is connected to; each test FILE clones it (`CREATE DATABASE … TEMPLATE`, [`tests/scratch-db.ts`](tests/scratch-db.ts)) and drops its clone afterwards, so the files run in parallel without seeing each other's rows. `TEST_APP_DATABASE_URL` (role `plotinium_app`, same database name) runs the gateway and the end-to-end wiring suite ([`src/wiring.int.test.ts`](src/wiring.int.test.ts): a listening server and a real `/ws` client) with the run-time grants:

```sh
docker compose -f compose.yaml -f compose.test.yaml up -d --wait db     # publishes 127.0.0.1:55432
pw=$(docker compose exec -T db cat /run/plotinium/owner_password)
docker compose exec -T db psql -U plotinium_owner -d postgres -c 'CREATE DATABASE plotinium_test'
DATABASE_URL="postgres://plotinium_owner:$pw@127.0.0.1:55432/plotinium_test?sslmode=disable" \
  server/node_modules/.bin/dbmate --migrations-dir db/migrations --no-dump-schema up
apw=$(docker compose exec -T db cat /run/plotinium/app_password)
DATABASE_URL=postgres://plotinium_owner:$pw@127.0.0.1:55432/plotinium_test \
TEST_APP_DATABASE_URL=postgres://plotinium_app:$apw@127.0.0.1:55432/plotinium_test \
  pnpm exec vitest run --project server
```

`compose.test.yaml` turns the `backplane` network non-internal (for the loopback port). Compose cannot flip that on a network with containers attached, so switch with `docker compose -f compose.yaml -f compose.test.yaml down` (volumes are kept) before going back to plain `docker compose up`, or run the test database as its own project: `PLOTINIUM_DB_PORT=55433 docker compose -p plotinium-servertest -f compose.yaml -f compose.test.yaml up -d --wait db`.

Route plugins are also tested without a database through `fastify.inject` on a bare instance ([`tests/plugin-app.ts`](tests/plugin-app.ts)) with in-memory stores.

Smoke check of a running stack (readiness, a guest or `SMOKE_USER`/`SMOKE_PASSWORD` login, one `/ws` hello validated against the protocol schema, logout):

```sh
docker compose exec -T app node server/src/smoke.ts          # inside the app container
node server/src/smoke.ts http://localhost:4717               # through Caddy, from the host
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
