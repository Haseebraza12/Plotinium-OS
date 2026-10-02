# server/src/engine/sync

The sync engine as pure, tested modules that the `sync` Fastify plugin wires: the WebSocket protocol v1 router (a pure function), the per-connection op lane with the credit window, the op pipeline around `vfsTxn` (L0 dedup, per-owner feed numbers, `op.result`), content writes with version compare-and-swap and conflicted copies, base checks for structural ops, the in-process broadcaster, per-owner resume with the `snapshot.required` fallback, throttling, backpressure, close codes and the server-side timers on an injectable clock.

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../../specs/06-sync/offline-and-sync.md), [specs/09-database/database.md](../../../../specs/09-database/database.md), [specs/11-server/backend-api.md](../../../../specs/11-server/backend-api.md)
- **Requirement IDs:** OFF-02, VFS-09, VFS-10, SYN-01 … SYN-18

Entry point for the plugins: `createSyncRuntime` in `runtime.ts`. Tests: `*.test.ts` (fakes in `tests/`), and `sync.int.test.ts` against PostgreSQL when `DATABASE_URL` is set.
