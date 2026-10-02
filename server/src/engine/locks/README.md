# server/src/engine/locks

The lease manager: S/X leases with a TTL (30 s, 15 s in the demo profile) and fencing tokens, the `EXCLUDE`-backed lease SQL, FIFO waiter queues, the expiry index over `dsa/heap` (a `Map` stand-in until the heap ships) rebuilt from the `locks` table at start, the single-timer sweeper, grant/deny/release/expiry notifications, release on a clean close, hold until the TTL on an abnormal close, and release on auth-session revocation.

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../../specs/06-sync/offline-and-sync.md) §3.14, [specs/09-database/database.md](../../../../specs/09-database/database.md) §3.17, §4.11.16
- **Requirement IDs:** VFS-09, PROC-07, BOOT-12

Tests: `manager.test.ts` and `fencing.test.ts` (in-memory store and heap doubles in `tests/`), and `store.int.test.ts` against PostgreSQL when `DATABASE_URL` is set.
