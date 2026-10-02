# kernel/src/blkio

The `blkio` worker: tier-1 swap on OPFS `FileSystemSyncAccessHandle`, falling back to the IndexedDB database `plotinium-swap`. Page-out serialises, writes, verifies by checksum and only then frees memory. Tier 2 (the server, `/api/swap`) is write-behind: when online every page-out is also uploaded and the local copy is kept as a cache (C4).

- **Primary owner:** R1 Kernel / Systems Architect
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/03-kernel/memory-and-paging.md](../../../specs/03-kernel/memory-and-paging.md) §3.9–§3.11, §4.4
- **Requirement IDs:** MEM-03, MEM-04, MEM-05

| File                      | Contents                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blkio.worker.ts`         | Worker entry; picks OPFS or the IndexedDB fallback once at POST (`init`); LOCAL_SWAP_CAP = min(2 GiB, 25 % of the quota)                           |
| `protocol.ts`             | `{t, id, …}` requests mirroring `SwapDevice`, replies, `progress`; `transferList`                                                                  |
| `server.ts` / `client.ts` | Worker-side request loop / kernel-side `BlkioClient implements SwapDevice`                                                                         |
| `opfs.ts`                 | `/swap/u<uid>/<osSession>/<pid>/p<pageId>-g<gen>.pg`: write `.tmp`, flush, read back, verify, rename; pipelined digests, in-order acks; boot sweep |
| `idb.ts`                  | `plotinium-swap`, store `pages`, key `[uid, osSession, pid, pageId]`; put (relaxed) then get and verify                                            |
| `compress.ts`             | gzip / gunzip (Compression Streams) and `crypto.subtle` SHA-256 for `HttpRemoteSwap`                                                               |

The back ends are written against minimal structural interfaces of the File System and IndexedDB APIs; `fixtures/fakes.ts` implements them in memory, and `fixtures/contract.ts` runs the same SwapDevice contract on every back end.
