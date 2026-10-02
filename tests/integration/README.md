# tests/integration

Cross-package suites against the Compose database (`docker compose -f compose.yaml -f compose.test.yaml up -d --wait db`; TST-23: no Testcontainers).

- `global-setup.ts`: waits for the database and builds `plotinium_template` from every migration's `-- migrate:up` section, once per migration set (fingerprint in the database comment). Each test file then clones its own `t_<hash>` database and drops it afterwards (`support/db-template.ts`).
- `schema.test.ts`: a freshly migrated database passes every integrity probe (VFS-11); seeding a 1,000-node tree keeps quota, nlink and refcounts exact (DB-02); a directory cannot move into its own subtree (DB-03).
- `concurrency.test.ts`: DB-03 torture with 2 and 8 clients moving overlapping directories (1,000 moves on PRs, `PLT_DB03_MOVES=20000` nightly); afterwards the tree is acyclic, every inode reachable and every probe empty.
- **Planned here (owners):** outbox replay of 5,000 ops (OFF-02, R5), lock leases (VFS-09, R2), the auth suite (R2) once the server lands.
- **How to run:** `DATABASE_URL=… pnpm exec vitest run --config tests/vitest.config.ts --project integration`.
- **Runs:** every pull request.
- **Primary owner:** R5. **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
