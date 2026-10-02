# server/src/locks

The lock manager: S/X leases with fencing tokens, TTL sweeper, EBUSY on a stale fence.

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../specs/06-sync/offline-and-sync.md), [specs/09-database/database.md](../../../specs/09-database/database.md)
- **Requirement IDs:** VFS-09

No REST routes: `lock.*` frames travel on the `/ws` control lane. The manager (`../engine/locks`) is created by `createSyncRuntime`; `await sync.start()` rebuilds the expiry index from the `locks` table before the server listens, and the sweeper keeps one timer at the earliest deadline.
