# @plotinium/db

The PostgreSQL 18.6 + pgvector 0.8.6 schema and everything that exercises it: plain-SQL dbmate migrations with `-- migrate:up` and `-- migrate:down`, the committed `schema.sql` dump that CI diffs, the seed scripts, the Q1-Q5 benchmark harness and the integrity probes (C7, C8).

| Field              | Value                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Primary owner      | R2 VFS / Database Engineer                                                                              |
| Secondary reviewer | R5 QA/DevOps (runs the migration round trip in CI)                                                      |
| Implements         | [specs/09-database/database.md](../specs/09-database/database.md)                                       |
| Requirement IDs    | DB-01, DB-02, DB-03, DB-04, DB-05, VFS-06, VFS-08, RAG-03                                               |
| May import         | `@plotinium/protocol` (well-known inode UUIDs for the seed, C5). Never the client packages.             |
| Status             | v0.1.0: six migrations (17 tables), schema.sql, probes P1-P9, Q1-Q5/Qb, perf-index toggles, bench seed. |

## Layout

| Folder        | Contents                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `migrations/` | `YYYYMMDDHHMMSS_name.sql` dbmate files, each with `-- migrate:up` and `-- migrate:down`                           |
| `seed/`       | deterministic seed (mulberry32, seed 42): at least 50 users, 10k and 100k inodes, demo data, precomputed vectors  |
| `bench/`      | Q1-Q5 harness, `perf-indexes.up.sql` / `perf-indexes.down.sql` for the DB-05 before and after states, reports     |
| `probes/`     | integrity probes: orphans, parentless dentries, unreachable inodes, nlink, quota drift, refcounts                 |
| `src/`        | package entry point: re-exports the deterministic bench-seed generator                                            |
| `scripts/`    | `migrate-roundtrip.sh`: the DB-01 round trip (up, N rollbacks, empty-schema check, up, dump diff, newest down/up) |

## Commands

```sh
docker compose -f compose.yaml -f compose.test.yaml up -d --wait db
db/scripts/migrate-roundtrip.sh                 # DB-01; --write regenerates db/schema.sql
node db/seed/seed.ts --profile bench10k | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U plotinium_owner -d plotinium_bench
docker compose exec -T db psql -U plotinium_owner -d plotinium_bench < db/probes/integrity.sql   # 0 rows
cat db/bench/q{1,2,3,4,5}.sql db/bench/qb.sql db/bench/explain.sql | docker compose exec -T db psql -U plotinium_owner -d plotinium_bench
```

Package checks:

```sh
pnpm --filter @plotinium/db typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/db test        # the Vitest project named "db"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
