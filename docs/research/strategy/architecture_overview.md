
# Plotinium architecture overview

**In one sentence.** Plotinium is a local-first, multi-user web OS. A TypeScript kernel runs in one dedicated Web Worker. It schedules processes onto nested executor workers, keeps a Unix-style VFS in IndexedDB, pages process state to OPFS and to the server, and runs its three AI subsystems as ordinary processes that are scheduled and permission-checked like any other. One Node process and PostgreSQL hold the authoritative copy of shared state, locks and quotas.

Sources for this plan:
- the spec: s8 reference architecture, s9 OS primitives, s12 AI, s13-17 delivery;
- the frozen stack in STACK_DECISION.md (SolidJS 1.9.15, Vite 8.3, TS 7 gate, Valibot 1.5, IndexedDB + OPFS, Node 24 + Fastify 5.12, raw WSS protocol v1, PostgreSQL 18.6 + pgvector 0.8.6, Kysely + dbmate, Caddy 2.11, Compose on a Hetzner CX33);
- the conflict resolutions recorded with it.

Where an individual decision record disagrees with a conflict resolution, the resolution wins. Examples: READ COMMITTED plus a lock protocol, not SERIALIZABLE; COEP require-corp, not credentialless; Valibot only; FsBlobStore, not Garage; ESLint, not Biome; one kernel per origin, not one session per tab.

## 1. Layers

| # | Layer | Where it runs | What lives there | Primary owner | Main requirement IDs |
|---|---|---|---|---|---|
| 1 | **User space** | Main thread for views. Executor workers for all app logic | boot-ui (framework-free, inlined), login, desktop shell and taskbar (Solid), app views (Terminal, Files, Editor, Task Manager, Settings), the shell process, coreutils, the AI shell (`ai`, `semsearch`, `predict`) | R3 (views), R4 (shell, coreutils) | BOOT-01/13, WM-01..07, SYS-02/03 |
| 2 | **Syscall interface** | MessagePorts between user space and the kernel | `protocol/` Valibot schemas, dispatcher, capability check, rwx check, audit hook, event bus | R1 | SYS-01, AGT-01/08 |
| 3 | **Kernel** | The kernel worker (exactly one per origin) | process table (own `PidTable`), scheduler (own heap + RR + aging), executor-pool manager, memory manager and LRU pager, VFS (inode tree, dentry maps, path resolver, perms, quotas, trie index), service manager (own DAG + Kahn), window-registry mirror, `syncd`, `lockd`, klog ring buffer | R1 (proc/sched/mm), R2 (VFS), R5 (svcmgr) | PROC-*, MEM-*, VFS-*, BOOT-03/04 |
| 4 | **Client execution and local persistence** | Executors 1..6, the `blkio` worker, the `ai.embed` worker, the Service Worker. IndexedDB `plotinium`, OPFS swap, Cache API | process programs; OPFS tier-1 swap device; ONNX embedding runtime; versioned shell cache | R1, R2, R4, R5 | PROC-05, MEM-03/05, OFF-01/02/05 |
| 5 | **Transport** | One origin: WSS `/ws` and HTTPS `/api/*` | protocol v1 with an ordered op lane and a control lane (leases, heartbeats, signals); bulk bytes over HTTPS | R5 (client), R2 (server) | VFS-09/10, OFF-02/04 |
| 6 | **Backend** | VPS: Caddy, ONE Node 24 process, PostgreSQL 18 + pgvector, blob volume | auth gateway and rate limits, sync engine, lock manager, blob/swap store, index API, LLM gateway, metrics | R2, R4 (gateway/LLM), R5 (ops) | DB-01..05, MEM-04, s12.6 |

## 2. Diagram

```
          Chrome stable  -  one origin: https://<domain>   (examiner bring-up: http://localhost:4717)
+---------------------------------------------------------------------------------------------------+
| MAIN THREAD  (renders + dispatches only; OS script <= 4 ms per frame, checked with LoAF)          |
|  [boot-ui: inline, no framework] [login] [desktop shell + taskbar: Solid] [app views: Solid, lazy] |
|  [wm/compositor.ts: registry, z 1..n, focus, drag/resize, rAF batch] [kernel-link router] [meter] |
+-----------|--------------------|------------------------|-----------------------|----------------+
  boot events |  view ports (pid,wid) | display channels     | compositor port (kernel-only)
            v   {id, call, args} -> {id, ok, value | errno}      identity = the PORT, never the message
+---------------------------------------------------------------------------------------------------+
| KERNEL WORKER  - exactly one per origin (Web Lock 'plotinium:kernel' + fencing epoch in IDB meta) |
|  dispatcher: ESRCH > ENOSYS > Valibot EINVAL > caps > rwx > audit > handler                       |
|  PidTable PCBs | scheduler: heap+RR+aging, timer heap | mm: LRU list + page tables + accounting    |
|  VFS: inode tree, dentry maps, trie, quotas, fsck | svcmgr: DAG/Kahn | event bus | klog ring       |
|  syncd + lockd (kernel services with pids) | outbox | offline verifier | IndexedDB tx() builder     |
+-------|----------------------------|------------------------------|--------------------------------+
        | dispatch/resume + 32-byte  | page bytes (transferred)     | embed jobs (batch 1)
        v SAB control block          v                              v
+--------------------+  +-----------------------+  +------------------------+  +-------------------+
| EXECUTORS 1..6     |  | BLKIO WORKER          |  | AI.EMBED WORKER        |  | SERVICE WORKER    |
| shell, coreutils,  |  | OPFS sync handles,    |  | Transformers.js + ORT  |  | versioned shell   |
| app logic, ai.*    |  | tier-1 swap           |  | WASM; one ~100 MiB     |  | cache; /api/* and |
| procs, prefetch:*  |  | (IDB fallback)        |  | page (evict=terminate) |  | /ws network-only  |
+--------------------+  +-----------------------+  +------------------------+  +-------------------+
  IndexedDB 'plotinium': inodes, dentries[parent,name], blobs, blob_chunks, users, groups, outbox,
  undo, meta, sessions, credentials, telemetry ring, bootlog          OPFS: swap pages (tier 1)
+---------------------------------------------------------------------------------------------------+
        | WSS /ws protocol v1                                  | HTTPS /api/*: auth, ops > 60 KB,
        | op lane: op.submit / op.batch (ordered)             | blobs, swap, sync/snapshot, index,
        | control lane: hb, lock.*, proc.signal, watch        | llm, telemetry (opt-in)
        v                                                     v
+---------------------------------------------------------------------------------------------------+
| VPS - Docker Compose: web, app, db                                                                 |
|  web: Caddy 2.11 - TLS/HTTP3, COOP/COEP/CORP/CSP, static shell, /models, /ort (self-hosted)        |
|  app: Node 24 + Fastify, ONE process: auth gateway | token buckets | sync engine | lock manager |   |
|       blob/swap store (FsBlobStore on a volume) | index API | LLM gateway | /metrics /healthz        |
|  db:  PostgreSQL 18.6 + pgvector 0.8.6: users, groups, inodes, dentries, blobs, locks, op_log,    |
|       auth_sessions, os_sessions, swap_pages, file_chunks vector(384), audit_log, llm_requests    |
+----------------------------------------------------------------------------|----------------------+
                                                                             v  Anthropic API (key only in server env)
```

## 3. The three mandatory boundaries: rule, mechanism, proof

| Boundary | Rule (spec) | How the design makes it true | How CI proves it (runs on every PR unless noted) |
|---|---|---|---|
| **B1: syscall-only** | Apps reach OS resources only through typed syscalls. The kernel checks permissions on every call. No app, even a built-in one, touches storage, the process table or another app's windows. | (1) An app gets only `{sys, pid, wid}`. `sys` is a port-bound client. (2) App logic runs in an executor whose runtime shadows `indexedDB`, `caches`, `navigator.storage`, `Worker` and `importScripts` before it loads app code. (3) ESLint `no-restricted-imports` and `no-restricted-globals` block `apps/*` from `kernel/`, `vfs/`, `wm/` and storage globals. (4) The compositor accepts commands only from the kernel port. (5) Caller identity comes from the port: an executor port plus the dispatched pid, or a view port bound to `(pid, wid)` when it was created. It never comes from message fields. | **SYS-01 bypass suite:** a hostile test app tries 8 bypasses (open IndexedDB, open OPFS, open a cache, import a kernel module, post to the compositor port, forge a pid, call an unknown syscall, send an oversized payload). Each must fail with an error, ENOSYS or EINVAL. A built-chunk scan also fails the build if any `apps/*` chunk references a storage global. |
| **B2: main thread renders and dispatches** | Computation runs on Web Workers. The kernel's main-thread work is small and bounded (4 ms per frame). | The only OS code on the main thread is the compositor, boot-ui, the kernel-link router and the frame meter. The VFS, scheduler, pager, sync and every AI step run in workers. Kernel events are coalesced into at most one batch per frame. Payloads are paginated or transferred. Geometry is never reactive state. | **Nightly and per release, on the lab-spec runner:** the WM-03 drag test and the PROC-05 CPU-load test (10 windows). They assert p95 frame time within budget and zero Long Animation Frames over 50 ms whose `scripts[].sourceURL` is our origin. LoAF script attribution exists only for main-thread scripts ([Chrome LoAF docs](https://developer.chrome.com/docs/web-platform/long-animation-frames)), which is exactly the thread this boundary protects. A `performance.measure` around each compositor flush plus event apply must have p95 ≤ 4 ms. |
| **B3: local-first client, authoritative server** | The client works alone offline from local state. The server is authoritative for shared multi-user state, locks and quotas. | **Client:** the IndexedDB VFS is primary. Every mutation is exactly one IndexedDB transaction plus one outbox op. No network call is on the boot critical path; `auth`, `sync`, `lockd` and `ai.*` are non-critical services. **Server:** it re-checks permissions with the same `vfs/perm.ts`. It owns `op_log` and the per-user `change_seq`, the S/X leases with fencing tokens, and the quota rows (locked in every mutating transaction). Server results (versions, conflicted copies, rejections) are applied back, and a rejection reverts the local change from `undo`. | **Offline gate test:** kill the server process rather than just calling `setOffline`, reboot, and run the core utilities (OFF-01). **Exactly-once replay property test**, with dropped acks, duplicated frames and a server kill after COMMIT (OFF-02). **VFS-09 crash-expiry test.** **Quota race:** two clients close to their quota; the server rejects one with EDQUOT and that client reverts. |

## 4. Threads and workers

| Thread | Count | Starts | Why it exists |
|---|---|---|---|
| Main | 1 | page load | render and dispatch; compositor; platform calls a worker cannot make: `navigator.storage.persist()`, Service Worker registration, `measureUserAgentSpecificMemory()` |
| Kernel worker | 1 | end of POST | all kernel state; the only code that opens IndexedDB; owns the WebSocket |
| Executors | `clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6)`. One starts at boot; the others start on demand | kernel init | run processes as resumable generators |
| blkio | 1 | `mm` service | OPFS sync handles block for 15-58 ms per 5 MB, so this work stays off the kernel thread |
| ai.embed | 0-1 | first search focus, or idle after desktop-interactive | ORT WASM, accounted as one evictable page of about 100 MiB. `numThreads = hwc ≥ 8 ? 2 : 1` |
| Service Worker | 1 | after desktop-interactive plus idle | versioned shell cache and offline boot |

`ai.search`, `ai.indexer`, `ai.predictor`, `ai.agent` and `prefetch:*` are ordinary processes on executors. `syncd` and `lockd` are kernel services with their own pids. On a 4-thread lab machine this gives: main + kernel + 1-2 executors (+ ai.embed only while it is active). That leaves the headroom PROC-05 needs.

## 5. Import rules (ESLint-enforced)

```
protocol/            <- everyone (pure schemas + types; no DOM, no Node)
dsa/                 <- kernel, vfs, wm, ai, server (imports nothing but protocol types)
vfs/perm.ts, path.ts <- kernel AND server (isomorphic, pure: one permission matrix for both sides)
kernel/core          imports no self/document/Worker/indexedDB (host bindings live in kernel/host)
wm/compositor.ts     imports no Solid
apps/*               -> protocol + the sys client only (never kernel/, vfs/, wm/, server/)
ai/*                 -> protocol, dsa, kernel hook interfaces (the kernel ships no-op AI hooks)
server/              -> protocol, dsa, vfs/perm.ts, vfs/path.ts, db types
```

## 6. One origin, one set of headers

- **Caddy owns all static files and all security headers:**
  - `COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`
  - `CSP: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  - HSTS; `no-cache` on `index.html` and `sw.js`; `immutable` on hashed assets.
- **Fastify serves only `/api/*` and `/ws`.**
- **Why the isolation headers:** cross-origin isolation is required for:
  - the SharedArrayBuffer pre-emption control blocks;
  - 2-thread ORT;
  - `measureUserAgentSpecificMemory()` (MEM-01).
- **Offline:** the Service Worker stores full `Response` objects, so the headers survive an offline boot.
- **Verification:** e2e asserts `crossOriginIsolated` in the window and in a worker, both online and after an offline reboot.
- **No third-party origins:** system fonts, bundled icons, and self-hosted `/models` and `/ort`.

## 7. How the architecture answers the two benchmarks (s7)

| Benchmark limitation | Structural answer in Plotinium | Where it is proven live |
|---|---|---|
| Puter: cloud coupling | Local-first IndexedDB VFS, an outbox with idempotency keys, and no network on the boot critical path. | P3 gate: kill the server, reboot offline, use all core utilities, then reconnect and replay exactly once. |
| Puter: superficial AI | AI jobs are processes with pids, priorities and memory pages. The agent acts only through typed syscalls. The index lives next to the inode table. The litmus build removes `ai/` and everything else still works. | P4 gate: litmus build, `ps` during indexing, kill the agent mid-plan. |
| daedalOS: memory bloat | 256 MB accounted budget, a hand-written LRU, and two-tier swap (OPFS, then server) with byte-identical page-in. | P3 gate: a 2× workload with paging visible in Task Manager, `vmstat` and `free`. |
| daedalOS: no orchestration | Multi-tenant server: quota in the same transaction as the write, S/X leases with fencing, versioned sync, conflicted copies. | P3 gate: two users contend for a lock, then a crash-expiry test. |

Phase 1 evidence: run both systems with 1, 5 and 10 apps open. Record memory from the Chrome Task Manager and `measureUserAgentSpecificMemory`, plus offline behaviour (reload with the network cut). This is the 2-page analysis.

## 8. "Two decisions we would reverse" (ARCHITECTURE.md, s15.2)

Keep a running candidate list from Week 5 and decide it with evidence in Week 16. Current candidates, each with a reversal trigger already in STACK_DECISION.md:
- SolidJS vs React. Trigger: reactivity-bug counts per phase.
- Exact client vector scan vs server-only search. Trigger: ai.embed memory above 120 MiB.
- Raw WebSocket vs an SSE adapter. Trigger: failure rate on the campus network.
- Per-op IndexedDB metadata vs SQLite-WASM. Trigger: the 1,000-node bulk-op budget.

The document must name the two the team would actually reverse, with the data behind them.
