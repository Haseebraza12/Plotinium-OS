# @plotinium/vfs

The Unix-style virtual file system that runs inside the kernel worker: the in-memory inode tree with hash-mapped dentries, the path resolver, the permission matrix, links, quotas, the IndexedDB store (ONE database `plotinium` per device, C4), bulk operations, `fsck`, plus the `syncd` client (protocol v1, outbox replay, Lamport counter, per-owner resume) and the `lockd` client (S/X leases, heartbeats, fences).

| Field              | Value                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R2 VFS / Database Engineer (`src/sync/`: R5 QA/DevOps)                                                                                                                                                                          |
| Secondary reviewer | R1 Kernel (`src/sync/`: R2 VFS/DB)                                                                                                                                                                                              |
| Implements         | [specs/04-vfs/virtual-file-system.md](../specs/04-vfs/virtual-file-system.md)<br>[specs/06-sync/offline-and-sync.md](../specs/06-sync/offline-and-sync.md)<br>[specs/09-database/database.md](../specs/09-database/database.md) |
| Requirement IDs    | VFS-01..11, OFF-01, OFF-02, DB-02 (client side)                                                                                                                                                                                 |
| May import         | `@plotinium/protocol`, `@plotinium/dsa`, `idb`. `src/path.ts` and `src/perm.ts` are isomorphic: `@plotinium/protocol` types only, no DOM or Node (the server imports them as `@plotinium/vfs/path` and `@plotinium/vfs/perm`).  |
| Status             | VFS core implemented (planners, store, fsck, OFT, events); `src/sync/` and `src/locks/` not started. `dsa/tree` is injected (tests use a double until the team's tree lands, C16).                                              |

## Layout

| Path                                      | Contents                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/path.ts`, `src/perm.ts`              | isomorphic resolver (§5.1) and permission matrix, umask, chmod grammar and wire form (§3.6, §5.4)       |
| `src/names.ts`, `src/digest.ts`           | conflicted-copy and lost+found names (§5.5); subtree digest and tree checksum (§5.6)                    |
| `src/view.ts`, `src/ops/overlay.ts`       | the `FsView` every planner reads; the copy-on-write overlay of a plan in progress (`batch` semantics)   |
| `src/ops/`                                | `PlanBuilder` (writes, guards, quota, blobs, undo pre-images, wire op, events) and one planner per call |
| `src/ops/commit.ts`, `src/store/apply.ts` | outbox + undo records, quota fast-fail; ONE readwrite transaction per plan (§3.11 phase 2)              |
| `src/store/`                              | schema and migration 001, `IdbStore` (`tx`, fault hook, chunked scans), lazy `DirLoader`                |
| `src/tree/vfs-tree.ts`                    | in-memory tree over the injected `dsa/tree`; changes only via `apply(plan.writes)` after `oncomplete`   |
| `src/quota/`, `src/oft/`                  | quota and tmpfs accounting (§3.8); open-file table and close-to-open write sessions (§3.9)              |
| `src/events.ts`, `src/fault.ts`           | `vfs.*` event drafts, delivery filter, ABI projection (§3.18); client fault arm (§3.20)                 |
| `src/mkfs.ts`, `src/fsck/`                | mkfs, seed upgrade, tmpfs clearing (§3.3); fsck I1–I14 checks, repairs and checksum (§3.21)             |
| `src/sync/`, `src/locks/`                 | `syncd` and `lockd` clients (not started; R5)                                                           |
| `tests/doubles/`                          | TEST-ONLY `dsa/tree` double, IndexedDB double, and the `World` fixture                                  |

## A mutation, end to end

```ts
const b = new PlanBuilder(tree, ctx); // phase 1: synchronous, re-run after NotLoaded
planRename(b, '/home/alice/a', '/home/alice/b');
const plan = b.build('mv', 'rename');
quotaCheck(plan, (uid) => tree.user(uid), tmpfsUsage); // EDQUOT before any transaction
const commit = prepareCommit(plan, { opId, osSessionId, principal, now, awaitSync });
await applyCommit(store, commit, { epoch, now, fault: faults.take('rename', now) }); // phase 2
tree.apply(plan.writes); // phase 3: memory, then stamped events
```

## Invariants to keep from day one (C4)

- Every user-visible mutation is exactly ONE readwrite transaction across every affected store, including quota, undo and the outbox op.
- Transaction builders are synchronous: no `await` inside (`local/no-await-in-idb-builder`).
- The in-memory tree updates only after `oncomplete`.

## Commands

```sh
pnpm --filter @plotinium/vfs typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/vfs test        # the Vitest project named "vfs"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
