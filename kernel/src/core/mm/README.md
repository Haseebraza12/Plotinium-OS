# kernel/src/core/mm

The memory manager: accounting, the 256 MiB budget with reservation-based admission, the global LRU, reclaim, the deterministic state codec, two-tier swap with write-behind, page faults, the thrashing guard and the data behind `free`, `vmstat` and `pmap`.

- **Primary owner:** R1 Kernel / Systems Architect. **Secondary reviewer:** R2 VFS/DB.
- **Spec:** [specs/03-kernel/memory-and-paging.md](../../../../specs/03-kernel/memory-and-paging.md)
- **Requirement IDs:** MEM-01…MEM-07, WM-05 (paging side); Plotinium design KMM-01…KMM-14.
- **Environment-free:** no `self`, `document`, `Worker` or `indexedDB`. The host injects the executor port, the swap devices (`kernel/src/blkio`), the clock and the hooks, so the whole manager runs under the Node loopback host and in unit tests.

| File                              | Contents                                                                                                                                               | Spec        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `params.ts`                       | Every constant of §3.1 (budget, soft limit, 256 KiB chunks, watermarks 85 % / 75 %, …)                                                                 | §3.1        |
| `types.ts`                        | `PTE`, `ProcMemStats`, `MemSummary`, klog records                                                                                                      | §4.1, §4.6  |
| `accounting.ts`                   | `accounted(pid)`, the Kernel line (never charged), the calibration model and `calibration.json` loader                                                 | §3.2        |
| `reserve.ts`                      | Reservations: INV-M1, the wait heap (`dsa/heap`), 10 s timeout, `maxOverBudgetMs`                                                                      | §3.7        |
| `lru.ts`                          | HOT / COLD / SPEC segments over `dsa/lru`; victim order SPEC → COLD → HOT                                                                              | §3.5        |
| `reclaim.ts`                      | Watermarks, victim actions (suspend / drop without a write / page out), residency hint                                                                 | §3.6        |
| `codec.ts` + `codec.vectors.json` | Canonical JSON + binary segments behind the 64-byte `PLTP` header; byte-identical round trip                                                           | §3.8        |
| `swap.ts`                         | `SwapDevice` / `RemoteSwap` interfaces, OPFS names, `MemorySwapDevice` (loopback, tests)                                                               | §3.10, §4.4 |
| `remote.ts`                       | `HttpRemoteSwap` for `/api/swap` (gzip, checksum over the uncompressed bytes)                                                                          | §3.11, §4.5 |
| `writebehind.ts`                  | Tier-2 upload queue: concurrency 2, back-off, supersede, pause on 401 or offline                                                                       | §3.11       |
| `thrash.ts`                       | Thrashing guard: on after 5 s above 20 faults/s, off after 5 s below 10                                                                                | §3.14       |
| `stats.ts`                        | `FreeReport`, `vmstatLine`, `VmstatProcRow`, `PmapReport`                                                                                              | §3.17       |
| `mm.ts`                           | `MemoryManager`: admission, alloc/declare/free, faults, page-out protocol, suspend and page-in, checkpoints, pre-fetch, pins, window coupling, reclaim | all         |

`dsa/lru` and `dsa/heap` are team-written (C16) and still `IMPLEMENTED = false`: the manager's default factories use them, so it runs in production once R1 flips those flags. The tests inject the test-only doubles in `fixtures/doubles.ts`.

```sh
pnpm exec vitest run --project kernel src/core/mm/   # MEM-01…07, WM-05, KMM-12/13 tests
```
