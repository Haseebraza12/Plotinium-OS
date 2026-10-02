# vfs/src/locks

The `lockd` client (a kernel service with a pid): S/X leases with TTL 30 s (15 s in the demo profile), a heartbeat at TTL/3 from the kernel worker, fencing tokens on every grant, and local advisory locks.

- **Primary owner:** R2 VFS / Database Engineer
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../specs/06-sync/offline-and-sync.md) §3.14, [specs/04-vfs/virtual-file-system.md](../../../specs/04-vfs/virtual-file-system.md) §3.16
- **Requirement IDs:** VFS-09, PROC-07 (lease release on kill), PVFS-13

## Files

| File          | What it implements                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lockd.ts`    | `Lockd`: acquire and release on the control lane of syncd's socket, one server lease per inode shared by local holders, S → X upgrade, FIFO per inode, fences (`fenceFor`), loss handling (the stale-fence path), `onVisible` re-verification, reconnect upgrade of local locks, and `lsof` rows with the countdown |
| `table.ts`    | The per-device local table: `ino → holders`, compatibility and waiters                                                                                                                                                                                                                                              |
| `advisory.ts` | Local advisory locks through `navigator.locks` (`plotinium:vfs:<ino>`) for degraded mode                                                                                                                                                                                                                            |
| `types.ts`    | Requests, results, grants, `lsof` rows and lock events                                                                                                                                                                                                                                                              |

## Kernel integration

- `const lockd = new Lockd({channel: syncd, newId: uuidv7, locks: platformLocks(), emit})`, then `syncd.attachLocks(lockd)`. syncd sends `hb` every `hbMs` (TTL/3 from `hello.ok.timers`) carrying `lockd.heartbeatLeases()`.
- Syscalls: `lock.acquire` → `lockd.acquire({pid, ino, mode, wait, timeoutMs, principal})`. `lock.release` → `lockd.release(pid, leaseId)`. `lock.status` and `lsof` use `lockd.status(ino)` and `lockd.lsof()`, with paths resolved by the kernel.
- `open` for writing calls `lockd.checkWritable(ino, pid)`. That returns EBUSY with the holder named, for the read-only Editor banner. Every commit of a process that holds X passes `lockd.fenceFor(pid, ino)` as `CommitMeta.fence`.
- The kill path (PROC-07) calls `lockd.releaseAll(pid)`.
