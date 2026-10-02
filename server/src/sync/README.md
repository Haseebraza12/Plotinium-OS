# server/src/sync

The sync engine: `/ws` protocol v1 (ordered op lane and control lane), `op_log`, the per-owner `feed`, replay with credits, `GET /api/sync/snapshot`, in-process broadcast after COMMIT.

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../specs/06-sync/offline-and-sync.md), [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md)
- **Requirement IDs:** OFF-02, VFS-10, SYN-01, SYN-13, SRV-07

`routes.ts` registers `GET /ws` (checks in the backend-api.md §3.7 order before the upgrade: draining 503, the `ws-upgrade` bucket 429, exact Origin 403, `Sec-Fetch-Site` 403, cookie session 401 / store down 503, at most 4 sockets per auth session 429; then the socket goes to `SyncHub.accept` with its listeners attached synchronously), `POST /api/ops/{opId}` (ops over 60 KB; joins the live socket's op lane) and `GET /api/sync/snapshot` (`snapshot.ts`). `su-grants.ts` is the in-process registry of live `su` grants the sockets read; a grant that ends sends `proc.signal SIGHUP`. The engine itself is `../engine/sync`.
