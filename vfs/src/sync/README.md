# vfs/src/sync

The `syncd` client (a kernel service with a pid): WebSocket protocol v1 with an ordered op lane and a control lane, the durable outbox, opId (UUIDv7) plus per-session cseq plus a Lamport counter (no HLC), `op.batch` replay (at most 32 ops, credit window 16), per-owner resume, and the reconnect state machine.

- **Primary owner:** R5 QA / DevOps & Integration Engineer
- **Secondary reviewer:** R2 VFS / Database Engineer
- **Spec:** [specs/06-sync/offline-and-sync.md](../../../specs/06-sync/offline-and-sync.md)
- **Requirement IDs:** OFF-02, OFF-04, VFS-10 (plus SYN-01 … SYN-13 client parts, DB-02 rules 4–6, BOOT-12, AGT-09)

## Files

| File                                                        | What it implements                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncd.ts`                                                  | `Syncd`: the orchestrator. State machine effects, `hello` with per-owner cursors, replay, results, feed, snapshots, heartbeats, dead-man timer, back-off, `SYNC_WAIT_MS` waits, status publishing |
| `machine.ts`                                                | The §3.7 state machine as a pure `transition(state, event)`, plus the `NetStatus` mapping                                                                                                         |
| `backoff.ts`                                                | Full-jitter back-off (§5.5) with the per-close-code rules                                                                                                                                         |
| `sender.ts`                                                 | The §5.2 send loop as a pure `planSend`: principal holds, blobs first, credit window, `MAX_BATCH`, `MAX_PAYLOAD`, the POST-at-the-head rule for ops over 60 KB                                    |
| `outbox.ts`                                                 | The in-memory view of the outbox (memory-only `sent` and holds), and the `op.submit` body builder                                                                                                 |
| `feed.ts`                                                   | Per-owner cursors, the reorder buffer, the 2 s gap timer, own entries (`ownerSeqs`) and batched acks                                                                                              |
| `results.ts`                                                | One-transaction builders for final results: ack, conflicted copy, rejection with the revert cascade, parking in `~/lost+found`, and local cancel                                                  |
| `remote.ts`                                                 | Remote apply of `vfs.changed` and snapshot rows (VFS §3.17.1 rules)                                                                                                                               |
| `storage.ts`                                                | The `SyncStorage` port and `StoreSyncStorage` over the device `Store`                                                                                                                             |
| `lamport.ts`, `status.ts`, `txn.ts`, `ports.ts`, `types.ts` | The Lamport counter, taskbar labels, transaction helpers, injectable ports and shared types                                                                                                       |

## Kernel integration

1. At boot (service `sync`, non-critical): `new Syncd({session, storage: new StoreSyncStorage(store), socket: browserSocket, http, host})`, then `await syncd.start()`. No network I/O happens here.
2. After desktop-interactive: `syncd.connect()`. The router forwards `online` and `offline` (`setOnline`), and `visibilitychange` or `resume` (`onVisible`, plus `lockd.onVisible`).
3. After every synced commit: `syncd.kick()`. For bulk ops and agent batches while RESUMING or LIVE, call `await syncd.waitFor(opId)` (§3.13). When a waiting process is killed, call `syncd.cancelOp(opId)`.
4. `host.applied(effect)` hands over the rows a sync transaction wrote. Apply them with `VfsTree.apply(effect.writes)` and publish events with the effect's origin. `host.status(netStatus, label)` becomes `net.state`, and `host.notice` becomes notifications, TTY lines and SIGHUP.
5. Before coalescing a new write into a pending record (VFS §3.14.2), the VFS calls `syncd.reserve(opId)`. The reservation ends with the next `kick()`.
