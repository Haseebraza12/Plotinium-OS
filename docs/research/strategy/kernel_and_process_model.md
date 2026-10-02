
# Kernel and process model

## 1. Where the kernel lives and how it starts

- **One dedicated module worker, `kernel.worker.ts`.** It is written in strict TypeScript. `kernel/core` is thread-agnostic, and `kernel/host/{worker,main,loopback}.ts` bind the ports. The loopback host lets unit tests run the whole kernel in Node.
- **One kernel per origin.**
  - At POST the kernel calls `navigator.locks.request('plotinium:kernel', {ifAvailable: true}, …)`.
  - If a second tab opens, it shows *"Plotinium is running in another tab — [Use here]"*. The handover goes over `BroadcastChannel('plotinium:ctl')` and runs a graceful BOOT-12 shutdown. A `{steal: true}` request is used only after 3 s of silence.
  - Each acquisition bumps a **fencing epoch** in IndexedDB `meta`. Every readwrite transaction checks that epoch, so a kernel whose lock was stolen can never commit.
- **The main thread is kept small.** It holds a *kernel-link router* that makes the platform calls a dedicated worker cannot make and forwards the results to the kernel:
  - `navigator.storage.persist()` at POST;
  - Service Worker registration and `SKIP_WAITING`;
  - `performance.measureUserAgentSpecificMemory()`, for calibration only;
  - `visibilitychange` and `pointerdown` "interactive" hints.

## 2. Process control block

```ts
type PState = 'NEW' | 'READY' | 'RUNNING' | 'BLOCKED' | 'SUSPENDED' | 'TERMINATED';
interface PCB {
  pid: number; ppid: number; pgid: number; sid: number;          // job control (fg/bg), sessions
  cred: { uid: number; gid: number; groups: number[] };          // effective creds (su'd shell = target uid)
  argv: string[]; cwdIno: string; env: Map<string, string>; umask: number; tty?: number;
  state: PState;
  priority: number; nice: number; effPrio: number;               // 0 = highest … 39 = lowest
  cls: 'interactive' | 'normal' | 'background';                  // derived from effPrio band
  seq: number; heapIdx: number;                                  // arrival sequence (RR), heap index map
  cpuTimeMs: number; lastRunAt: number; waitingSince: number; createdAt: number;
  worker: number | null;                                         // executor where the process is resident
  pageTable: Map<number, PTE>; residentBytes: number; declaredAssets: number; softLimit: number;
  fdTable: Map<number, number>;                                  // fd -> open-file-table id (VFS-owned table)
  waitingOn: WaitReason | null; exitCode: number | null; exitReason?: 'normal'|'signal'|'watchdog'|'collateral';
  caps: CapSet; windows: Set<number>; leases: Set<string>; children: Set<number>;
  checkpointable: boolean; speculative: boolean; overruns: number;
}
interface PTE { pageId: number; loc: 'RESIDENT'|'LOCAL_SWAP'|'REMOTE_SWAP'; dirty: boolean;
  lastAccess: number; size: number; sha256: string; speculative: boolean; pinned: boolean; lruSlot: number }
```

- **Process table (PROC-01).** It is our own `dsa/hashtable/PidTable.ts`:
  - open addressing with linear probing and Fibonacci hashing (`Math.imul(k, 0x9E3779B1)`);
  - backward-shift deletion, so there are no tombstones;
  - load factor kept at or below 0.5.

  It is differential-tested against `Map` with fast-check. This is the hand-written hash table that earns distinction credit.
- **PID allocation.** PID 1 is `init`. New PIDs increase and wrap at 32,768, skipping live PIDs.
- **Open-file table.** Owned by R2 (VFS). It maps an open-file id to `{ino, flags, offset, refcount, versionAtOpen, fence?}`. `dup` and pipes share entries by refcount.

## 3. Lifecycle (PROC-06)

The states follow spec Figure 9.1:
- NEW → READY (admit)
- READY ⇄ RUNNING (dispatch / pre-empt or quantum end)
- RUNNING → BLOCKED (syscall wait, lock, pipe, page fault, `net:llm`, `tty:confirm`) → READY
- READY or BLOCKED → SUSPENDED (page-out) → READY (page-in)
- any state → TERMINATED (exit, kill, watchdog)

Every transition appends `{t, pid, from, to, reason}` to the kernel log ring buffer (`dsa/ringbuffer`, 8,192 entries). It is visible through `dmesg`, `ps -o state` and a Task Manager trace export.

## 4. Program model and checkpointing

```ts
export default { init(argv) { return { lines: 0, fd: -1 }; },   // serializable state only
  *run(ctx, st) { st.fd ??= yield* ctx.sys.open(ctx.argv[1], 'r'); /* … */ yield ctx.tick; return 0; } };
```

- **Where state lives.** Everything a process must keep is in `st`, or in `ctx.mem` pages it declares. Generator objects cannot be serialized, so they never hold state.
- **Page-out happens only at a yield point.** The executor encodes the state with a deterministic codec, the kernel verifies SHA-256, and only then is the generator dropped.
- **Page-in** calls `run(ctx, restoredState)` on any executor. That one mechanism gives byte-identical restore (MEM-03), restore from a new browser session (MEM-04), migration, and recovery after a collateral terminate.
- **Short-lived commands** such as `ls` are marked non-checkpointable. They are never paged, and on a collateral kill they exit with 137 and the reason `collateral`.

## 5. Scheduler

**Data structures.**
- `ready`: our binary min-heap (`dsa/heap`, struct-of-arrays).
  - Key: `effPrio · 2^32 + seq` in a `Float64Array`, exact below 2^53.
  - An index map (pid → heap index) gives O(log n) `changePriority` (PROC-02).
- `timers`: a second heap instance, holding `sleep()` wake-ups and lease and heartbeat deadlines.

**Bands and quanta** (configurable in Settings, PROC-03):

| Band | effPrio | Quantum | Pre-emption |
|---|---|---|---|
| interactive | 0-9 | 5 ms | pre-empts lower bands at their next yield (SAB flag) |
| normal | 10-29 | 10 ms | pre-emptible |
| background (niced) | 30-39 | 20 ms | pre-emptible; paused while the compositor's `interactive` hint is set (pointer gesture), for at most 1 s in any 2 s window |
| non-pre-emptive section | n/a | runs to completion | Phase 2 of a bulk op or transaction commit. Kernel-internal, bounded by the watchdog hard limit |

**Round-robin.** When a quantum ends, the process re-enters READY with a fresh `seq`. That puts it behind processes of equal priority, which gives FIFO order and hence RR within each level.

**Dispatch loop** (event-driven: runs on ready, yield, exit, syscall reply or timer):

```
while (idleExecutor() && ready.size) dispatch(ready.pop(), exec, quantumOf(pcb));
const top = ready.peek();
if (top && !idleExecutor()) {                        // no free executor: pre-empt the worst running slice
  const victim = runningSlices.maxBy(s => s.effPrio); // lowest priority currently running
  if (victim.preemptible && victim.effPrio > top.effPrio) Atomics.store(ctl[victim.exec], PREEMPT, 1);
}
```

A syscall ends the current slice. For `fast` calls, if `peek()` shows nothing of higher priority is READY, the kernel replies with `{type:'resume', pid, res, quantumLeft}` in O(1).

**Aging (PROC-04), with a proven bound.**
- Rule: `effPrio = max(0, priority + nice − ⌊wait / T_age⌋)`, where `wait = now − waitingSince`. `T_age` defaults to 250 ms.
- An aging tick every `T_age` calls `changePriority` on READY processes. For up to 256 processes this costs well under 0.1 ms.
- `seq` is assigned when a process enters READY and is kept while it ages. After a dispatch, `effPrio` resets to base.

*Bound.* Take a READY process P with base priority p ≤ 39, N runnable processes, E executors, maximum quantum Q (20 ms), and the maximum non-pre-emptive section H (250 ms, enforced by the watchdog).
1. P reaches effPrio 0 within p·T_age.
2. From then on P is at the top band. Ties at level 0 break by `seq`. Any process that entered READY after P, including every high-priority job re-queued after its slice, has a larger `seq` and so ranks behind P.
3. Only processes that were already waiting with a smaller `seq` can go first. There are at most N−1 of them, and each runs at most one slice.

Therefore **W(P) ≤ p·T_age + ⌈(N−1)/E⌉·(Q + δ) + H**, where δ ≈ 0.2 ms is dispatch overhead.

The interactive-hint pause does not extend the bound. Aging keeps running during the pause, and once P's effPrio drops below 30 it is no longer eligible to be paused.

*Declared bound for the spec's starvation test* (50 CPU-bound jobs at priority 0, one job at priority 39, E = 2). At most one job ranks ahead of P with a smaller `seq`, so W ≤ 39 × 0.25 + (20 + 0.2) ms + 0.25 s ≈ **10.0 s**. The test asserts the measured maximum wait is ≤ 10.5 s. DSA.md and ARCHITECTURE.md carry the proof. T_age is configurable: 100 ms gives about 4.2 s.

## 6. Executor pool, pre-emption and the watchdog (PROC-05, PROC-07, PROC-09)

**Size.** `clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6)`. One executor starts at boot; the rest start on demand after `desktop-interactive`.

**Placement rules.**
- Processes with different uids never share an executor, and neither do agent and user processes. Processes in the same realm could forge each other's pid.
- The focused process goes to the least-loaded executor.
- A process that overruns twice gets an executor of its own.
- Many sleeping processes can be resident on one executor. This is how we reach ≥ 256 processes (PROC-09).

**Control block.** Each executor has an `Int32Array(8)` on a SharedArrayBuffer:

| Slot | Meaning |
|---|---|
| `[0] PREEMPT` | 0 none, 1 yield, 2 kill |
| `[1] RUNNING_PID` | pid of the slice now running |
| `[2] HEARTBEAT` | bumped at every yield point |
| `[3] SLICE_SEQ` | slice counter |

The check costs about 8 ns per yield point. Without cross-origin isolation, pre-emption falls back to messages and `bootlog` says so.

**Slice loop.**
- The executor runs `gen.next()` until one of: the quantum expires, `PREEMPT` is set, a syscall is issued, or the process exits. Then it reports to the kernel.
- The executor runtime, not app code, stamps `RUNNING_PID` onto every outgoing syscall envelope.

**Watchdog.** Every 50 ms (a timer is fine here; only boot progress must not be timer-driven):
1. If a slice has run longer than `max(20 × quantum, 250 ms)` and `HEARTBEAT` has not moved, set `PREEMPT = 2`.
2. After 100 ms more with no report, call `worker.terminate()` and respawn the executor (measured at 6-8 ms).
3. The runaway exits with code 137 (reason `watchdog`).
4. Processes that shared that executor are restored from clean swap copies where they have one. Otherwise they exit with 137 (reason `collateral`).

Mid-slice termination loses nothing in the kernel. Syscalls are atomic at call granularity, VFS writes commit in one IndexedDB transaction, and the kernel owns every fd and lease.

**`kill` path (PROC-07).**
1. Send the signal (SIGTERM, then SIGKILL after 3 s for windowed apps).
2. Mark the PCB TERMINATED and free its executor slot, terminating the executor if the process was running a slice.
3. Close every fd and drop the open-file refcounts.
4. `lockd` releases its leases, and the server broadcasts `lock.released`. Local `navigator.locks` handles are dropped.
5. Re-parent its children to pid 1.
6. Tell the compositor to close its windows.
7. Free its pages and queue its swap pages for GC.
8. Wake any `wait()`ers and write an audit entry.

A property test kills random processes and asserts no leaked fds, leases or pages.

**Job control and commands (PROC-08).**
- `pgid` and a foreground process group per TTY.
- Keys: Ctrl-C sends SIGINT, Ctrl-Z sends SIGTSTP (the process becomes BLOCKED on `sigcont`).
- Commands: `ps`, `top` (alternate screen), `kill`, `nice`, `renice`, `jobs`, `bg`, `fg`, trailing `&`.
- The Task Manager shows state, CPU share (from `cpuTimeMs` deltas per second), memory and page faults.

## 7. Memory manager (MEM-01..08)

### Accounting model (documented in ARCHITECTURE.md; calibration report in docs/evidence/mem)

```
accounted(pid) = Σ size(resident pages)          // bytes the codec measured at page boundaries
               + declaredAssets(pid)             // ArrayBuffers, ImageBitmaps (w·h·4), WASM memory.buffer.byteLength
               + overhead(executor residency)    // calibrated constant per resident process
accounted(system) = Σ accounted(pid) + ai.embed (declared ~100 MiB, measured) + vector segments resident
```

- **Budget.** The global budget defaults to 256 MB and is set in Settings (`mm.budget`). Each process also has a soft limit (default 64 MB): crossing it warns in `top` and moves that process's pages to the front of the eviction order.
- **Kernel baseline.** The inode tree, trie and caches are reported on their own `kernel` line in `free`. Their size is estimated from the measured bytes-per-entry of each DSA benchmark.
- **Calibration.** Run scripted scenarios (idle, 10 windows, 2× workload) in Chrome with `--enable-blink-features=ForceEagerMeasureMemory`. Fit the overhead constant against `measureUserAgentSpecificMemory()`, and report the model error; the target is under 25%. That API is never called in the live loop because it is slow.

### Pages and the LRU (MEM-02)

- **What a page is.** Pages are logical units (one document, one canvas, one editor buffer) or fixed 256 KB chunks of a large buffer.
- **The list.** One global `dsa/lru`: a Map from key to slot, plus a doubly linked list in `Int32Array` prev and next arrays. Touch and evict are O(1).
- **Pinned pages:** the focused process, system services, and any process inside a non-pre-emptive section.
- **Speculative pages** (from pre-fetch) are inserted at the LRU end, so they go first.

**Reclaim.** A high watermark (95%) triggers reclaim down to a low watermark (85%). Victims are taken in this order:
1. speculative pages;
2. pages of processes whose windows are minimised (WM-05);
3. the rest in LRU order.

A clean page that already has a valid swap copy is dropped without being rewritten. The predictor's top-1 next app gets a "residency hint": its pages are skipped once per pass. This is one of the ways C informs the system.

**Budget guard (MEM-06).** If accounted memory stays above the budget for 750 ms, the kernel stops admission: no new page-ins except faults in the focused process, and no heavy spawns. It sends SIGSTOP to background processes over their soft limit until reclaim catches up. The assertion is: never above the budget for more than 1 s.

### Swap tiers, faults and thrashing (MEM-03..07)

**Page-out (MEM-03).**
1. At a yield point the executor serialises the page and transfers the ArrayBuffer to the kernel.
2. The kernel forwards it to `blkio`, which does: write `<osSession>-<pid>-<page>.tmp`, flush, read back, verify SHA-256, rename.
3. On ack the PTE becomes `LOCAL_SWAP` with its checksum, and the executor releases its references.
4. The fallback device is the IndexedDB database `plotinium-swap`, chosen automatically at POST when OPFS sync handles are unavailable.

**Tier 2 (MEM-04).**
- Used when `estimate().usage/quota > 0.8`, or when local swap exceeds `min(2 GB, 25% of quota)`.
- The page is gzipped with `CompressionStream` and sent with `PUT /api/swap/{os_session}/{pid}/{page}`. The checksum is computed over the uncompressed bytes.
- The local copy is deleted after the server ack. The server keys pages by `owner_uid`, so a new browser session can list and page in the state of a previous one.

**Page fault.**
1. The process becomes BLOCKED with `waitingOn = page:<id>`, and its window shows "Restoring… n MB" with real byte progress.
2. `blkio` (or HTTPS) reads the page and the checksum is verified.
3. The page is inserted at the MRU end and the process returns to READY.

Budgets: 5 MB page-in p95 ≤ 300 ms locally (pilot 35-56 ms) and ≤ 2 s remotely (MEM-05).

**Thrashing guard.** If the fault rate stays above 20 per second for 5 s, the kernel refuses to spawn heavy processes (declared state above 16 MB) and tells the user.

**Commands (MEM-07).** `free`, `vmstat 1` (faults, hit ratio, bytes in and out), `pmap <pid>` (the page table). The Task Manager's Memory tab shows the same numbers.

**MEM-08 (may).** Only if the P3 gate is green by Week 10: `sys.mmap(path)` returns a handle whose pages are file-backed, with `msync` writing dirty pages through the VFS.

## 8. Window–process coupling (WM-05)

- **Ownership.** Every `WinRec` stores its owning `pid`. The kernel checks `pcb.windows.has(wid)` on every window syscall.
- **Closing and killing.** Closing a window sends SIGTERM to its process. Killing a process closes its windows.
- **Minimise and restore.** Minimise sets the pages' eviction class to "first candidates". Restore (a taskbar click) calls `mm.pageIn(pid)` before focus, and the window shows "Restoring" until the process is READY.
- **Focus.** Focus pins the process: its pages are never evicted and it is placed on the least-loaded executor.
- **Views and migration.** Views talk to their process over a display MessageChannel that the kernel creates at `sys.window.create`. When a process migrates or its executor respawns, the kernel creates a new channel and hands the view a new port. The view's client reconnects transparently.

## 9. Kernel DSA inventory (all hand-written, each in `dsa/<name>` with `tests/` and `bench/`)

| Structure | Used for | Key ops and complexity | Owner |
|---|---|---|---|
| PidTable (open addressing) | process table | get/set/delete O(1) average | R1 |
| Binary heap + index map | ready queue, timer heap, lease-expiry heap (server), RAG top-k | push/pop/changePriority O(log n), peek O(1) | R1 |
| LRU (Map + typed-array list) | pager, inode cache, rate-limit key bound | touch/evict O(1) | R1 |
| n-ary inode tree + dentry Maps | VFS | resolve O(depth), readdir O(k) | R2 |
| Trie (struct-of-arrays, radix) | completion | lookup O(P + k); p95 ≤ 1 ms at 10^4 and 10^5 | R3 |
| DAG + Kahn | boot/shutdown order, cycle path, levels | O(V + E) | R5 |
| Ring buffer | klog, telemetry, frame meter | O(1) | R5 |

Every `bench/` reports ns/op and **bytes/entry** from 10^3 to 10^5 entries. The pilot's Map-per-node trie used 493 MB at 10^5 entries; the struct-of-arrays trie used 24 MB.
