# tests/fault-injection

The §11.3 fault-injection harness on the server side (testing §3.6; database.md §3.14; DB-02, TST-08, TST-09).

- `matrix.ts`: every bulk op (`rm -r`, `cp -r`, `mv` of 1,000 files, directory `mv`, batch rename of 500, `chmod -R`, `chown -R`) with its node-op count M and fault points 1, 500, 999, 1,000 (where the op has them), the spec's own points and M; plus M + 1, which must commit (`fault_not_fired`). "Fail at node k" arms `plotinium.fault_after = k − 1`.
- `ops.ts`: the normative statements of database.md §4.11 run in one transaction with the fault GUCs set as `vfsTxn` sets them. TODO(R2/R5): add a driver through `server/src/vfs/tx.ts` once it lands and run the same matrix.
- `seed.ts`: users, homes and fixture trees with exact nlink, quota and de-duplicated blob refcounts.
- `server.ts`: `probes.server(sql)`: reads every row, runs `db/probes/integrity.sql` and feeds the shared oracle (`support/oracle.ts`).
- `server.test.ts`: the matrix, a random fault-point property (`PLT_FAULT_PROP_RUNS`, default 25) and the inert-trigger check.
- **Not here yet:** the client side (IndexedDB abort at request N) runs in the Vitest `browser` project next to `vfs/store/tx.ts`; the blob-store fault (`FaultyBlobStore`) belongs to the server package's integration tests.
- **How to run:** `DATABASE_URL=… pnpm exec vitest run --config tests/vitest.config.ts --project integration` (skipped without `DATABASE_URL`).
- **Runs:** every pull request (integration job).
- **Primary owner:** R5 (harness), R2 (SQL and probes). **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
