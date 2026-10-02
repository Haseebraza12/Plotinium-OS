# Glossary

| Field | Value |
|---|---|
| Title | Plotinium glossary: the spec's Appendix B terms and Plotinium's own terms |
| Status | Draft v0.1, 2026-09-24 |
| Primary owner | R4 AI Pipeline Specialist |
| Secondary reviewer | R5 QA/DevOps & Integration Engineer |
| Must be demonstrable at | **P1 architecture defence (Week 4):** every term used in the defence slides, `ARCHITECTURE.md` and `STACK_DECISION.md` is defined here. Kept current to **v1.0.0** (final defence, W17–18), where "any member about any decision" (§14.4) and the whole-system viva (§16.4, §17.1) apply. |
| Requirement IDs covered | Spec Appendix B (p52–53), all 24 terms. Plotinium design IDs GLO-01..GLO-05. |
| Related specs | [Spec index](../README.md) · [Requirements traceability](./requirements-traceability.md) · [Identity and branding](./identity-and-branding.md) · [Architecture](../01-architecture/architecture.md) · [System-call ABI](../01-architecture/syscall-abi.md) · [Boot and services](../02-boot/boot-and-services.md) · [Processes and scheduling](../03-kernel/processes-and-scheduling.md) · [Memory and paging](../03-kernel/memory-and-paging.md) · [Virtual file system](../04-vfs/virtual-file-system.md) · [Window manager](../05-wm/window-manager.md) · [UI design system](../05-wm/ui-design-system.md) · [Offline and sync](../06-sync/offline-and-sync.md) · [Shell and terminal](../07-shell/shell-and-terminal.md) · [Data structures](../08-dsa/data-structures.md) · [Database](../09-database/database.md) · [RAG semantic search](../10-ai/rag-semantic-search.md) · [Agentic shell](../10-ai/agentic-shell.md) · [Predictive pre-fetch](../10-ai/predictive-prefetch.md) · [AI safety and evaluation](../10-ai/ai-safety-and-evaluation.md) · [Backend API](../11-server/backend-api.md) · [Security model](../12-security/security-model.md) · [Testing and performance](../13-quality/testing-and-performance.md) · [Deployment and CI](../14-devops/deployment-and-ci.md) · [Stack decisions](../15-decisions/stack-decisions.md) · [Implementation plan](../16-delivery/implementation-plan.md) |

---

## 1. Purpose and scope

One vocabulary for the five engineers, the specs, the code, the report and the viva. An examiner may ask any member about any decision (§14.4), and a member who uses a word two different ways loses the point being made. This file:

- restates every term of the spec's Appendix B, with how Plotinium realises it (§3.2);
- defines every Plotinium-specific term used in the specs, grouped by subsystem (§3.3 to §3.13);
- disambiguates words that mean different things in different layers ("session", "epoch", "lock", "freeze", …) (§3.14);
- lists retired terms that must never describe the current design, with their replacements (§6.1).

A term's **normative** definition lives in the spec named in the "Defined in" column; this file summarises it. If the two ever disagree, the owning spec wins and this file is corrected in the same PR (GLO-03).

Out of scope: tutorial explanations. Each entry is one to three sentences.

## 2. Requirements table

| ID | Summary | Spec § | How verified |
|---|---|---|---|
| GLO-01 | Spec: Appendix B. Every one of the 24 Appendix B terms appears in §3.2 with the spec's meaning, quoted or faithfully restated. | App. B p52–53 | `tools/spec-lint.ts` compares §3.2 term names with the list in §4.2 |
| GLO-02 | Plotinium design. Every Plotinium-specific term used in a heading, requirement row or test title of any spec file is defined here exactly once. | §14.4, §16.4 (viva readiness) | `spec-lint` term index: terms tagged in specs with `*term*` on first use must have an anchor here |
| GLO-03 | Plotinium design. A definition here never contradicts the owning spec or a canonical decision (C1–C18). | README precedence rules | Review rule: a PR that changes a normative definition in a spec also changes the entry here |
| GLO-04 | Plotinium design. Overloaded words are always qualified in specs and code comments (§3.14). | — | Review checklist item; `spec-lint` warns on an unqualified "session" or "epoch" in headings |
| GLO-05 | Plotinium design. Retired terms (§6.1) never describe the current design. They may be named only as rejected or superseded alternatives ("Lamport, not HLC"). | — | Docs lint lists every occurrence as a reviewer warning; the code lint fails on retired identifiers in source (`hlc`, `serverSeq`, `outboxPartition`, `perUidDb`) |

## 3. Design (normative)

### 3.1 How to read an entry

- **Source** says where the meaning comes from: `App. B` (the spec glossary), `Spec §x` (another part of the spec), `C1`–`C18` (a canonical decision, binding), or `Plotinium design` (our own choice, defined in the linked spec).
- **Defined in** links to the spec that is normative for the term.
- Numbers from the AI-run pilot are labelled *pilot figure — re-measure on the lab machine*.
- `hwc` always means `navigator.hardwareConcurrency`.

### 3.2 Spec glossary terms (Appendix B, p52–53)

| Term | Spec meaning (App. B) | How Plotinium realises it | Defined in |
|---|---|---|---|
| **ACID** | Atomicity, Consistency, Isolation, Durability: the guarantees a transaction gives. Here, above all, that a bulk operation happens completely or not at all. | Every user-visible mutation is exactly one IndexedDB readwrite transaction on the client (C4) and one `vfsTxn` on the server (C7); any error rolls back both sides (DB-02). | [database.md](../09-database/database.md), [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Aging** | Gradually raising the priority of a process the longer it waits, so that low-priority work never starves. | The effective priority of a waiting process improves by one step every `T_age`; the starvation bound W is declared and tested exactly (C13, PROC-04). | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Blast radius** | The set of files and inodes an operation will create, modify or delete, shown to the user before an agent's plan runs. | Computed by the kernel's dry run, never by the model; more than 20 inodes forces confirmation (AGT-03). | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Cosine similarity** | (a·b)/(‖a‖‖b‖), the cosine of the angle between two vectors; 1 means the same direction, 0 means unrelated. | Vectors are L2-normalised after truncation to 384 dimensions, so the score is a dot product over `Float32Array` rows. | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **DAG** | Directed acyclic graph. Here, the graph of service dependencies whose topological order is the boot order. | `dsa/dag` orders the 18 service manifests (C17) and also resolves application start-up dependencies from `/bin/<app>.json` in `sys.spawn`. | [boot-and-services.md](../02-boot/boot-and-services.md), [data-structures.md](../08-dsa/data-structures.md) |
| **Embedding** | A vector produced by a model to represent the meaning of a piece of text. | 384 dimensions from `mdbr-leaf-ir` q8 (fallback `bge-small-en-v1.5` q8), computed in the `ai.embed` worker (C12). | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Idempotency key** | A unique ID attached to an operation so that retrying it never applies it twice. | The `opId` (a UUIDv7) of every op; the server's first lock step inserts it into `op_log` with `ON CONFLICT DO NOTHING` (L0, C7). | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Inode** | The record describing a file, directory or link: type, owner, mode, size, times and where its content is stored. | `ino` is a UUIDv7; `type` is `f`, `d` or `l`; `version` supports optimistic concurrency; content is a SHA-256-addressed blob (C5, C7). | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Kahn's algorithm** | A topological sort that repeatedly removes nodes with no remaining incoming edges. If nodes remain at the end, the graph has a cycle. | Ours also returns **levels** (services in a level start concurrently) and the **cycle path** for the panic screen (BOOT-03, BOOT-04). | [data-structures.md](../08-dsa/data-structures.md) |
| **Lease** | A lock that expires unless renewed, so that a crashed client cannot hold a resource forever. | S/X leases with TTL 30 s (15 s in the demo profile), a heartbeat every TTL/3 from the kernel worker and a fencing token on every grant (C6). | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **LRU** | Least Recently Used: the replacement policy that evicts the entry that has gone unused the longest. | `dsa/lru` (hash map plus doubly linked list) drives the pager and the inode cache; speculative pages are evicted before LRU order applies. | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **OPFS** | Origin Private File System: a fast, private file-system storage area that the browser provides to each origin. | Swap tier 1, through `FileSystemSyncAccessHandle` in the blkio worker (C4). | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Outbox / operation log** | A durable queue of local changes, replayed to the server in order when connectivity returns. | IndexedDB store `outbox` (durability `strict`) on the client; table `op_log` on the server (C4, C6). | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **p95** | The 95th percentile: 95% of measurements are at or below this value. Targets use p95 so that averages cannot hide slow cases. | Sample sizes and the percentile method are fixed in the testing spec; authoritative numbers come from the lab-spec machine. | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **Page fault** | An access to state that is not resident in memory, which makes the memory manager page it in. | The process becomes BLOCKED, the page is read and its SHA-256 verified, the process returns to READY; its window shows "Restoring…". | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **PCB** | Process control block: the kernel's record for one process. | Stored in `PidTable`, our own hash table (PROC-01). | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Prompt injection** | An attack in which text the model reads, such as a file's contents, contains instructions meant to hijack its behaviour. | Defended by datamarking, intent binding, read-only observation and kernel-decided confirmation; tested by INJ-20 (AGT-06). | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **Quantum** | The time slice a process may run before the scheduler reconsiders which process runs next. | Configurable per priority band (PROC-03); a slice ends at the first yield point after the quantum expires. | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **RAG** | Retrieval-augmented generation: retrieve relevant documents first, then generate an answer grounded in and citing them. | Subsystem A. Retrieval with `path:line` citations is the core; LLM answer generation is optional and first on the cut list. | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Recall@5 / MRR** | Retrieval metrics: the fraction of queries whose relevant file appears in the top five, and the average of 1/rank of the first relevant result. | RAG-04 requires Recall@5 ≥ 0.80 on our evaluation set, with MRR reported. | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **Service Worker** | A browser script that intercepts network requests, making offline operation and cached shell updates possible. | Hand-written `sw.ts` on `workbox-precaching` and `workbox-routing`; registered after desktop-interactive plus idle; `/api/*` and `/ws` are network-only (C11). | [deployment-and-ci.md](../14-devops/deployment-and-ci.md), [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Topological sort** | An ordering of a DAG's nodes in which every node comes after all of the nodes it depends on. | Boot order and app start-up order; shutdown runs the same order in reverse (BOOT-12). | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Trie** | A tree in which each edge is a character, so all words sharing a prefix share a path, which makes prefix completion fast. | `dsa/trie` is a radix (compressed) variant whose edges carry strings; `DSA.md` explains why it keeps the O(L) and O(P + k) bounds (SYS-03). | [data-structures.md](../08-dsa/data-structures.md) |
| **Web Worker** | A background thread in the browser that runs JavaScript off the main (UI) thread and talks to it by messages. | The kernel worker, the executors, the blkio worker and the ai.embed worker (C2). | [architecture.md](../01-architecture/architecture.md) |

### 3.3 Threads, kernel and processes

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Kernel worker** | The one dedicated module worker, `kernel.worker.ts`, that runs the kernel core: process table, scheduler, dispatcher, memory manager, VFS, and the `syncd` and `lockd` services. | C2 | [architecture.md §3.6](../01-architecture/architecture.md) |
| **One kernel per origin** | Only one kernel runs per origin, enforced by the Web Lock `plotinium:kernel` plus the kernel fencing epoch. A second tab shows the takeover screen. | C2 | [architecture.md](../01-architecture/architecture.md) |
| **Kernel fencing epoch** | A counter in the IndexedDB `meta` store, bumped each time a kernel acquires `plotinium:kernel`. Every readwrite transaction checks it, so a kernel whose lock was taken over can never commit. Not the same as a lock's fencing token (§3.14). | C2 | [architecture.md](../01-architecture/architecture.md) |
| **Takeover screen** | "Plotinium is running in another tab — [Use here]". The hand-over runs a graceful BOOT-12 shutdown in the old tab first. | C2 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Kernel-link router** | Main-thread module that connects the page to the kernel worker. It makes the Window-only calls (`navigator.storage.persist()`, Service Worker registration, `performance.measureUserAgentSpecificMemory()`), forwards visibility and "interactive" hints, and after POST shadows `window.indexedDB`, `caches`, `navigator.storage.getDirectory` and `Worker` before any app view chunk loads. | C2, ARC-07 | [architecture.md](../01-architecture/architecture.md) |
| **Executor** | A nested worker, owned by the kernel worker, that runs process slices. Executors provide **isolation** (dedicated per uid, or to the agent); **concurrency** is limited separately by run tokens. | C2 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Run token** | A permit from the kernel's run-token semaphore. A slice runs only while its executor holds one. Count = clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6). | C2 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Special worker** | The three OS workers that are not executors: the kernel worker, the blkio worker and the ai.embed worker. The Service Worker is a browser mechanism, not one of them. | C2, ARC-05 | [architecture.md](../01-architecture/architecture.md) |
| **blkio worker** | Kernel-owned worker that runs the tier-1 swap device on OPFS `FileSystemSyncAccessHandle`: write a temporary file, flush, read back and verify, rename. Falls back to the IndexedDB database `plotinium-swap`. | C2, C4 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **ai.embed worker** | Special worker running Transformers.js on ORT WASM for embeddings, batch size 1, at most 512 tokens. Accounted as one evictable page of about 100 MiB (*pilot figure — re-measure on the lab machine*); evicting it means `worker.terminate()`. | C2, C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Program model** | Every program exports `init(argv) → state` and a generator `*run(ctx, state)`. Everything that must survive a page-out lives in `state` or in declared `ctx.mem` pages; generator objects never hold state. | Plotinium design | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Yield point** | A `yield` inside `run`. The only place where a slice ends cooperatively and the only place where a process can be paged out. Enforced in part by the lint rule `no-yieldless-loop-in-generator`. | Plotinium design, C14 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Slice** | One run of a process on an executor, from dispatch to the yield that ends its quantum, a block, or exit. | Spec §9.1 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Control block** | A small SharedArrayBuffer per executor through which the kernel requests pre-emption at the next yield point without a message round trip. Requires cross-origin isolation. | Plotinium design | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Watchdog** | Kernel timer that forcibly ends an executor whose slice exceeds its hard limit (`worker.terminate()` then respawn). Its worst-case kill latency is `H_kill`, about 400 ms. | Spec §9.1, C13 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Collateral kill** | A process that was resident on an executor the watchdog terminated. A checkpointable one resumes from its last page-out; a non-checkpointable one exits with status 137 and reason `collateral`. | Plotinium design | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Checkpointable** | A process whose state can be paged out and restored. Short-lived commands such as `ls` are not checkpointable and are never paged. | Plotinium design | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Effective priority** (`effPrio`) | Static priority (0 highest to 39 lowest) adjusted by `nice` and improved by aging. The ready-queue key is `(effPrio, seq)`, where `seq` is the arrival sequence number that gives round-robin order within a level. | Spec §9.1 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Declared bound W** | The PROC-04 starvation bound: W ≤ (p+1)·T_age + ⌈(N−1)/E⌉·(Q+δ) + H_kill, with H_kill ≈ 400 ms. The test asserts exactly the declared value (5450 ms in the kernel spec's default configuration). Symbols: p, the waiting process's base priority (aging steps to 0); T_age, the aging interval; N, the most runnable user processes during the wait, itself included; E, the parallelism available to its predecessors (E = 1 for the declared bound); Q + δ, the longest conforming slice. | C13 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **PidTable** | Our own open-addressing hash table (linear probing, Fibonacci hashing, backward-shift deletion) from `dsa/hashtable`, used as the process table. The same module backs the window registry. | C16 | [data-structures.md](../08-dsa/data-structures.md) |
| **init** | PID 1. Adopts orphaned processes (PROC-07). | Spec §9.1 | [processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md) |
| **Syscall envelope** | `{id, call, args}` → `{id, ok, value \| errno}` over MessagePorts. | Spec §9.6, C3 | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Executor port / view port** | The two kinds of port a syscall can arrive on. The caller's identity comes from the port (executor port plus the dispatched pid, or a view port bound to `(pid, wid)`), never from message fields. | C3 | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Dispatcher order** | The fixed order of checks for every syscall: ESRCH > ENOSYS > schema EINVAL > capability > rwx > audit > handler. | C3 | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Capability** | A named permission in the PCB (for example `ai.index`, `mm.speculative`), checked after schema validation and before rwx. Children inherit a subset; only `su` through the secure prompt widens them. | Plotinium design | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Event bus** | Kernel publish/subscribe channel for system events (`vfs.*`, `proc.*`, `wm.*`). VFS events fire only after the IndexedDB transaction's `oncomplete`. | Spec §3.2, C4 | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **`ABI_VERSION`** | Integer in `protocol/`, bumped on any breaking syscall or wire change. Independent of the OS version. | Plotinium design | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Interactive hint** | On `pointerdown`, the compositor tells the kernel the user is interacting, which pauses niced background work. | Plotinium design | [window-manager.md](../05-wm/window-manager.md) |

### 3.4 Memory

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Accounting model** | Our documented rule for counting memory: the serialised size of each process's state plus the declared sizes of its large assets (blobs, bitmaps, WebAssembly memory), calibrated against `measureUserAgentSpecificMemory()`. | Spec §9.2 (MUST define) | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Memory budget / soft limit** | Global limit on accounted memory (default 256 MB) and per-process limit (MEM-01). | Spec §9.2 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Page, page table, PTE** | A page is a fixed-size chunk of serialised state or a logical unit. The per-process page table maps each page to a page-table entry: location `RESIDENT`, `LOCAL_SWAP` or `REMOTE_SWAP`, dirty bit, last access, size, SHA-256, speculative and pinned flags. | Spec §9.2 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Reservation-based admission** | `mem.alloc`, `mem.declare` and page-in block (the process is BLOCKED on memory) until reclaim has freed space, so accounted memory never exceeds the budget. | C13 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Reclaim watermark** | Reclaim starts when accounted memory reaches 85% of the budget. | C13 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Victim order** | Speculative pages first, then pages of processes whose windows are minimised, then LRU order. Pinned pages are skipped. | Spec §9.2, §9.4, §12.4 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Pinned** | Never evicted: the focused process, system services, non-pre-emptive sections, and ai.embed while a search box has focus. | Spec §9.2 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Speculative page** | A page brought in by a `prefetch:*` job. Evicted before any other page (PRE-04). | Spec §12.4, C12 | [predictive-prefetch.md](../10-ai/predictive-prefetch.md) |
| **Residency hint** | Advice to the pager (from the top-1 prediction or from search hits) that raises a page's LRU position. It never overrides the budget. | C12 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Swap tier 1 / tier 2** | Tier 1: OPFS in the blkio worker, falling back to IndexedDB `plotinium-swap`. Tier 2: the server, `/api/swap`, stored in FsBlobStore and keyed by `owner_uid`. | Spec §9.2, C4 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Write-behind swap** | When online, every page-out is also uploaded to tier 2 and the local copy is kept as a cache. This is what lets MEM-04 restore from a new browser session. | C4 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Codec** | Our deterministic serialiser for process state: canonical JSON (sorted keys, no `undefined`) plus raw ArrayBuffer segments, with a length and SHA-256 header. Page-in restores a byte-identical state (MEM-03). | Plotinium design | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **Thrashing guard** | If the page-fault rate stays above a threshold, the OS refuses to start new heavy processes and tells the user. | Spec §9.2 | [memory-and-paging.md](../03-kernel/memory-and-paging.md) |
| **"Restoring" state** | The window overlay shown during page-in, with real byte progress, instead of a blank window. | Spec §9.2 | [window-manager.md](../05-wm/window-manager.md) |

### 3.5 Virtual file system and client storage

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **ino** | Inode id: a UUIDv7 in both client and server. `ls -i` shows a short form. | C5 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **UUIDv7** | Time-ordered UUID ([RFC 9562](https://www.rfc-editor.org/rfc/rfc9562)). The client generates it offline; PostgreSQL 18's `uuidv7()` is the server default. | C5 | [database.md](../09-database/database.md) |
| **Well-known UUIDs** | Fixed ids in `protocol/` for `/`, `/bin`, `/system`, `/system/services`, `/system/log`, `/system/branding`, `/root`, `/home`, `/tmp` and `/mnt`, used by both the client `mkfs` and the server seed, so the two never create two inodes for one path. | C5 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **mkfs** | First-boot creation of the standard hierarchy with its owners and modes (VFS-02). `/home/<user>` is created only on the server, when the user is created. | Spec §9.3, C5 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Dentry** | Directory entry: `(parent ino, name) → (ino, d_type)`, stored apart from the inode, which makes hard links possible. Client store key `[parent, name]`; server primary key `(parent_ino, name)`. | Spec §11.1, C4, C7 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Inode version** | Counter for optimistic concurrency. Every content write carries the version it expects to replace (VFS-10). | Spec §9.3 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Blob / blob chunk** | File content stored under its SHA-256 hash, so identical files share one copy. Client stores `blobs` and `blob_chunks`; server FsBlobStore. | Spec §11.1, C4, C9 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Transaction builder** | A synchronous function that issues every request of one IndexedDB readwrite transaction, with no `await` inside (lint rule `no-await-in-idb-builder`). The in-memory tree changes only after `oncomplete`. | C4 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Durability `strict` / `relaxed`** | IndexedDB durability hints: `strict` for `outbox`, `credentials` and `users`; `relaxed` for session autosave and telemetry. | C4 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Undo store** | IndexedDB store holding the inverse of each locally committed op, used to revert it if the server rejects it. | C4 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Quota mirror** | The `users` store's copy of quota counters, checked inside the same local transaction as the write. The server's `users` row is authoritative. | C4 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Conflicted copy** | `name (conflict from <user>, <YYYY-MM-DD>).ext`, created when a content write's base version no longer matches. Content is never silently overwritten (VFS-10). | Spec §9.3, C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **fsck** | The invariant checker (VFS-11): every inode reachable, link counts correct, no directory cycles, quota totals consistent. `fsck --server` (root) runs the server-side probes. | Spec §9.3 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Node op** | One inode-row write. The unit the fault-injection harness counts ("fail at node 500"). A `mv` is one node op (one dentry row). | Spec §11.3, C7 | [database.md](../09-database/database.md) |
| **Lazy directory load** | Directory contents are loaded into the in-memory tree on first access, not at boot. | C4 | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |
| **Kernel-synthesised file** | A read-only file (mode 0444, root) whose content the kernel generates on each read and never stores or syncs, with a fixed well-known id: `/system/release` and the logs under `/system/log`. Writes fail with EPERM even for root (PVFS-09). | Plotinium design | [virtual-file-system.md](../04-vfs/virtual-file-system.md) |

### 3.6 Synchronisation, transport and locks

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Protocol v1** | Our versioned JSON protocol over raw WSS on `/ws`. No CRDT library. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Op lane / control lane** | Two lanes on one socket. The op lane is ordered (`op.submit`, `op.batch`, `op.result`). The control lane carries heartbeats, `lock.*`, `proc.signal` and `watch`, and bypasses the op queue. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **opId** | The op's UUIDv7 idempotency key. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **cseq** | Per-session client sequence number; gives the outbox its order. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Lamport counter** | Logical clock carried by every op. Plotinium uses no hybrid logical clock. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Base version / subtree digest** | An op's preconditions: the inode versions the change was based on, or, for a subtree op, a digest of the subtree. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **`op.batch` / credit window** | Replay sends batches of at most 32 ops, with at most 16 unacknowledged ops in flight. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **`retryAfterMs`** | The rate limiter's throttling reply during replay. A replaying session is throttled, never disconnected. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Synchronous commit (online)** | While online, bulk ops and agent batches wait for the server's `op.result` before reporting success, so an injected server fault prints EIO at once. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Owner feed / owner_seq** | `feed(owner_uid, owner_seq, op_id)` rows written inside the transaction under each affected owner's L1 lock. The client resumes every owner it mirrors, so it also sees other users' changes to shared directories. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Retention horizon / snapshot** | Feed rows older than the horizon may be gone; a client behind it rebuilds from `GET /api/sync/snapshot`. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **S/X lock** | Shared (read) and exclusive (write) leases held by the server lock manager. | Spec §9.3, C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Fencing token (fence)** | A number issued with every lock grant and carried by every write. A write with a stale fence gets EBUSY; its bytes are kept as a conflicted copy. Not the kernel fencing epoch (§3.14). | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Heartbeat / pong** | Heartbeats, sent by the kernel worker every TTL/3, renew leases. WebSocket pongs only prove the socket is alive and renew nothing. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Demo profile** | Configuration used at gates and on Demo Day, for example lease TTL 15 s. | C6 | [deployment-and-ci.md](../14-devops/deployment-and-ci.md) |
| **syncd / lockd** | Kernel services (with pids) inside the kernel worker. `syncd` replays the outbox and resumes feeds; `lockd` holds leases and sends heartbeats. | C2 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **os_session / auth_session** | `auth_sessions` is the revocable login session behind the cookie. `os_sessions` is the desktop session: window layout, and the key that locks, `op_log` and swap pages refer to. Revoking an auth session releases that session's leases. | C6, C7 | [database.md](../09-database/database.md) |
| **Local advisory lock** | Offline, `lockd` can only take local locks through `navigator.locks`; the server lock is taken on reconnect. | C6 | [offline-and-sync.md](../06-sync/offline-and-sync.md) |

### 3.7 Server and database

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **vfsTxn** | The one server helper through which every VFS mutation runs: READ COMMITTED, locks taken through `lockPlan`, retry on SQLSTATE 40001, 40P01 and 55P03 up to 5 times with full jitter, `lock_timeout` 2 s mapped to EBUSY. | C7 | [database.md](../09-database/database.md) |
| **lockPlan** | The helper that computes and takes locks in the canonical order. For `rm -r`, `cp -r`, `chmod -R` and `chown -R` it plans, locks, then re-plans. | C7 | [database.md](../09-database/database.md) |
| **Canonical lock order (L0–L4)** | L0 `INSERT op_log … ON CONFLICT DO NOTHING`; L1 `users` rows `FOR UPDATE` in uid order (quota and per-owner feed sequence); L2 `pg_advisory_xact_lock` for cross-parent directory moves only; L3 directory inodes `FOR UPDATE` in ino order; L4 file inode version compare-and-swap. | C7 | [database.md](../09-database/database.md) |
| **Acyclicity trigger** | `BEFORE UPDATE OF parent_ino` trigger that refuses to move a directory into its own subtree (EINVAL). | C7 | [database.md](../09-database/database.md) |
| **Fault-injection harness** | A row-counting trigger that raises P0001 after N node ops when the GUC `plotinium.fault_after` is set. Reachable only through a root-only, audited endpoint when `FAULT_INJECTION=1`, and never on production. | Spec §11.3, C7 | [database.md](../09-database/database.md) |
| **Set-based SQL** | Bulk operations written as single recursive statements over the subtree, not as one statement per node. | C7 | [database.md](../09-database/database.md) |
| **Integrity probes** | SQL checks run after every failed operation: orphaned inodes and entries with no parent (spec §11.3), plus unreachable nodes, link counts, quota drift and blob reference counts. | Spec §11.3 | [database.md](../09-database/database.md) |
| **Perf-index scripts** | Separate up and down scripts that drop and restore the §11.4 indexes, giving the DB-05 "before indexing" state. | C8 | [database.md](../09-database/database.md) |
| **FsBlobStore** | Our content-addressed blob store on a Docker volume: SHA-256 computed while streaming, atomic rename, blobs uploaded before the DB transaction; garbage collection after 1 h for never-referenced blobs and 14 days for dereferenced ones. | C9 | [backend-api.md](../11-server/backend-api.md) |
| **Modular monolith** | The server is one Node.js 24 process made of Fastify 5 plugins. Caddy serves static files and every security header; Fastify serves only `/api/*` and `/ws`. | C9 | [backend-api.md](../11-server/backend-api.md) |
| **LLM gateway** | Server module behind `/api/llm/*` that holds the provider key. Budget flow: reserve in a short transaction, call the provider outside any transaction, then settle. Each call is logged in `llm_requests`; budgets live in `llm_usage`. | C9, C12 | [backend-api.md](../11-server/backend-api.md) |
| **Token bucket** | Our own rate limiter for HTTP routes and WS frames, with keys bounded by `dsa/lru`. | C9 | [backend-api.md](../11-server/backend-api.md) |
| **dbmate migration** | One plain-SQL file with `-- migrate:up` and `-- migrate:down`. CI rolls back N times, migrates up, dumps and diffs `db/schema.sql`. | C8 | [database.md](../09-database/database.md) |

### 3.8 Boot and services

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Boot stages** | 1 POST, 2 Bootloader, 3 Kernel init, 4 Service start, 5 Login, 6 Session restore. | Spec §6.3 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **POST** | Power-on self-test: detect required browser capabilities, check the Service Worker cache, read the storage estimate and request persistent storage. | Spec §6.3 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Service manifest** | `/system/services/<name>.json` with `name`, `requires`, `critical`, `weight`, `timeoutMs`, `priority` and `safeMode`. Plotinium has 18 manifests. | Spec §6.4, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Critical / degradable service** | A critical service's failure halts boot and opens the recovery screen. A degradable (non-critical) service's failure lets boot continue; it is shown as degraded and retried with back-off. | Spec §6.4, BOOT-07/08 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Level** | A service's Kahn level: the longest path from `kernel`. Services in one level start concurrently. Plotinium's DAG has 7 levels. | Spec §6.4, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Critical path** | The chain of services that determined boot time, printed by `bootlog --critical-path`. The static critical chain of our DAG is kernel > storage > vfs > login > session > desktop. | Spec BOOT-11, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **desktop-interactive** | The mark at which boot time is measured: the desktop shell is mounted and the first input-ready frame has been drawn. Non-critical services may still be starting. Large assets (model weights, `/ort`, xterm and CodeMirror chunks) load only after it. | BOOT-10, C11, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Warm boot / cold boot** | Warm: the shell is served from the Service Worker cache. Cold: empty HTTP and Service Worker caches, measured both with and without existing IndexedDB data. | BOOT-10 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Boot-critical JS** | Main-thread JavaScript needed before desktop-interactive. Budget ≤ 60 KB gzip. | C13 | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **boot-ui** | Framework-free code inlined into `index.html` for the boot screen, boot menu, kernel panic screen and recovery console. | C11 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Boot menu** | Offers Normal, Safe mode, Recovery and Verbose. Reached by holding Esc, by `reboot --menu`, or by a Settings flag for the next boot. | Spec BOOT-06, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Safe mode / Recovery** | Safe mode: no AI services, no autostart apps, default theme. Recovery: file-system check, clear local cache, reset session. | Spec BOOT-06 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Kernel panic screen** | Full-screen stop that names the cause, for example the dependency cycle `auth → sync → lockd → auth` (cycles are printed rotated to the smallest service name), with recovery, safe-mode and diagnostics actions. | Spec BOOT-04 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **bootlog** | The persisted per-stage and per-service timings (IndexedDB store `bootlog`), printed by the `bootlog` command. | Spec BOOT-11 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Degraded** | State of a non-critical service that failed or timed out; listed by the taskbar and retried with back-off. | Spec BOOT-07, OFF-04 | [boot-and-services.md](../02-boot/boot-and-services.md) |
| **Offline-ready badge** | Taskbar badge shown once the Service Worker has installed the versioned precache; only then does an offline reboot work. | Plotinium design | [offline-and-sync.md](../06-sync/offline-and-sync.md) |
| **Restart to update** | Notice shown when a new shell version is installed and waiting; it activates on the next boot (OFF-05). | Spec §9.5 | [deployment-and-ci.md](../14-devops/deployment-and-ci.md) |
| **Precache** | The Service Worker's versioned shell cache. `/ort`, `/models` and the Transformers.js chunk are never precached. | C11 | [deployment-and-ci.md](../14-devops/deployment-and-ci.md) |
| **App manifest** | `/bin/<app>.json` with a `requires` list (services, shared chunks, helper processes), resolved with `dsa/dag` by `sys.spawn`. | Spec §10.1, C17 | [boot-and-services.md](../02-boot/boot-and-services.md) |

### 3.9 Window manager and UI

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Compositor** | `wm/compositor.ts`, framework-free and the **sole** writer of window geometry and z-index. Uses pointer capture and `translate3d` batched per animation frame; pushes only coarse events into the UI framework. | Spec §9.4, C11 | [window-manager.md](../05-wm/window-manager.md) |
| **Window registry** | Hash map from `wid` to window state (owning pid, title, geometry, z, state, restore rectangle, focus, size limits), built on `dsa/hashtable`. | Spec §9.4, C16 | [window-manager.md](../05-wm/window-manager.md) |
| **Z-order renumbering** | After every change, z-indices are renumbered 1..n so they never grow without limit (WM-02). | Spec §9.4 | [window-manager.md](../05-wm/window-manager.md) |
| **Secure prompt** | A prompt drawn only by the compositor on the topmost layer, used for `su` passwords and agent confirmations. No app can draw above it. | C10, C12 | [ui-design-system.md](../05-wm/ui-design-system.md) |
| **Frame duration** | The time each frame takes, read from a Chrome trace. It is the metric for the ≤ 16.7 ms p95 gate; raw `requestAnimationFrame` deltas are not used. | C13 | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **LoAF** | Long Animation Frames API entries. The gate allows zero entries over 50 ms attributed to our scripts. | C13 | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **Main-thread OS script budget** | At most 4 ms of OS script per frame on the main thread (spec Figure 8.1 label; ARC-04). | Spec Fig. 8.1, C2 | [architecture.md](../01-architecture/architecture.md) |
| **Design tokens** | The single `tokens.css` holding colours, typography, spacing and motion for light and dark themes, plus reduced-motion tokens. | Spec §5.2, C11 | [ui-design-system.md](../05-wm/ui-design-system.md) |

### 3.10 Shell and terminal

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **TTY device** | xterm.js, used only to render text and capture keys. | C11 | [shell-and-terminal.md](../07-shell/shell-and-terminal.md) |
| **Line discipline** | Our code between the TTY device and the shell: line editing, echo, job-control keys. The lexer, parser and completion are also ours. | C11 | [shell-and-terminal.md](../07-shell/shell-and-terminal.md) |
| **Kernel-owned TTY input** | Keystrokes the kernel reads from the TTY itself, bypassing the foreground process and any pipe. The only channel through which an agent plan can be confirmed. | C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Completion namespaces** | The completion trie holds four namespaces: commands, paths, flags per command (from man-page front matter) and history (SYS-03). | Spec SYS-03, §10.1 | [shell-and-terminal.md](../07-shell/shell-and-terminal.md) |
| **Job** | A pipeline started from the shell; `&` runs it in the background and `jobs`, `bg`, `fg` control it (PROC-08). | Spec §9.6 | [shell-and-terminal.md](../07-shell/shell-and-terminal.md) |

### 3.11 AI subsystems

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **AI-native properties** | The four properties of spec §3.2: sees the system through the kernel; acts through system calls, not strings; is scheduled by the system; informs the system. Every subsystem we build shows all four. | Spec §3.2, C12 | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **AI seam** | A kernel hook interface with a no-op default (`SchedulerHints`, `ShellNL`, `FsSemanticSearch`). `ai/` registers the real implementation at service start. | Plotinium design | [architecture.md](../01-architecture/architecture.md) |
| **Litmus build** | CI job that builds with `__AI__=false` and runs the server with `AI=0`. Everything non-AI must still pass (spec §3.4 litmus test). | Spec §3.4, C12 | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **Coupling map** | The §12.5 table in `AI.md`: for each subsystem, how it touches scheduler, memory, VFS, shell, database and security. | Spec §12.5 | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **AI processes** | `ai.search`, `ai.indexer`, `ai.predictor`, `ai.agent` and `prefetch:<app>` are ordinary processes on executors, visible in `ps` and killable. | C2 | [architecture.md](../01-architecture/architecture.md) |
| **Chunk** | An overlapping piece of a file's text that respects paragraph and heading boundaries, at most 512 tokens, stored with its inode, offsets and content hash. | Spec §12.2, C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **modelKey** | Identifier of the embedding model, revision and dimension count stored with every chunk. A query never scores rows of a different modelKey. | Plotinium design | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **MRL truncation** | Keeping the first 384 dimensions of a Matryoshka-trained embedding and re-normalising. | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Query prefix** | The instruction string the embedding model expects before a query (not before documents). | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Vector segment** | A `Float32Array` block of 1,024 index rows in the client index; a pageable page. | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Readable set** | The set of inodes a uid may read right now: r on the file and x on every ancestor, computed from the **current** tree before ranking (RAG-03). | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Index verify** | Online, results from inodes the querying uid does not own are re-checked by the server with `POST /api/index/verify` before they are shown; offline, such results are hidden. | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **BM25 fallback** | Our own keyword ranking, used when the model is unavailable or still loading, with a clear notice (RAG-06). | C12 | [rag-semantic-search.md](../10-ai/rag-semantic-search.md) |
| **Observation loop** | The agent's loop of at most 6 turns in which read-only tools run immediately and return datamarked results before the model proposes the next step. | C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Read-only tool / mutating tool** | Read-only tools (`readdir`, `stat`, `find` with `-name`/`-mtime`/`-size`/`-type`, `grep -l`/`-c` run by the kernel as the uid, `du`, `wc`) execute at once. Mutating tools are buffered into one plan. Each tool is exactly one syscall schema. | C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Plan** | The buffered list of mutating steps. It goes through validate, dry run, confirmation decided by the kernel, execution as one transaction as the caller's uid, audit, and optional `ai undo`. | Spec §12.3, C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Dry run** | The kernel runs the plan against a read snapshot and lists exactly which inodes it would affect (the blast radius). | Spec §3.4, §12.3 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Plan fingerprint** | The `(ino, version)` set recorded by the dry run. The kernel and the server re-check it before commit; if anything changed, the plan fails with EAGAIN (`stale-plan`) and nothing runs. | Plotinium design | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Confirmation token** | An HMAC token, bound to the plan hash and the dry-run hash, single-use and pid-bound, that the kernel issues only after the user confirms on kernel-owned TTY input. Default answer N; a plan needing confirmation is refused with ENOTTY when there is no controlling TTY. | C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Intent binding** | Each plan step must quote a verbatim span of the user's request that licenses it; a step that cannot is rejected. | C12 | [agentic-shell.md](../10-ai/agentic-shell.md) |
| **Datamarking** | File names and tool results enter the model's context wrapped with a per-request random nonce, so data can be told apart from instructions. The planner never sees file contents. | C12 | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **AGT-40 / INJ-20** | Our agent benchmark (40 tasks: 10 pipelines, 8 relative-date, 8 glob, 8 ambiguous needing a clarifying question, 6 must-reject) and our injection set (10 malicious names, 10 malicious contents). | Plotinium design | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **Bake-off** | The Week-3 LLM comparison on AGT-40 and INJ-20, 3 runs per configuration; the cheapest qualifying configuration wins under a pre-registered rule. | C12 | [stack-decisions.md](../15-decisions/stack-decisions.md) |
| **Cassette** | A recorded LLM request and response replayed in CI, which runs with no API key. The recorder scrubs auth headers and gitleaks scans every cassette. | C10, C12 | [ai-safety-and-evaluation.md](../10-ai/ai-safety-and-evaluation.md) |
| **EAIUNAVAIL / EAIREFUSED** | Our errnos for "AI service unavailable" (the LLM gateway is offline, rate-limited, over budget, has no key, or the upstream failed) and "the model refused the request". Both lead to graceful absence (spec §3.4). | C3 | [syscall-abi.md](../01-architecture/syscall-abi.md) |
| **Witten-Bell Markov-2** | The predictor: a second-order Markov chain over app launches with Witten-Bell interpolation, backing off to first order, then to time-bucket most-frequently-used, then global most-frequently-used. Until 50 launches it ranks by time-bucketed MFU with confidence 0. | C12 | [predictive-prefetch.md](../10-ai/predictive-prefetch.md) |
| **MFU / MRU baselines** | Most-frequently-used and most-recently-used predictors. PRE-02 requires beating the better of the two. | Spec §12.4 | [predictive-prefetch.md](../10-ai/predictive-prefetch.md) |
| **θ (confidence threshold)** | A prediction triggers a pre-fetch only if its confidence is at least θ, the system has been idle for at least 2 s and memory is free. | Spec §12.4, C12 | [predictive-prefetch.md](../10-ai/predictive-prefetch.md) |
| **Telemetry ring** | On-device, per-uid ring buffer of launch, focus and close events. It can be viewed, cleared and exported in Settings > Privacy; it syncs through `POST /api/telemetry` only after opt-in. | Spec §12.4, C12 | [predictive-prefetch.md](../10-ai/predictive-prefetch.md) |

### 3.12 Security and authentication

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Opaque session token** | `<id>.<secret>`; the server stores only SHA-256(secret). Adapted from the Lucia reference (0BSD). | C10 | [security-model.md](../12-security/security-model.md) |
| **Session cookie** | `__Host-plt_sid` in production, `plt_sid` on `http://localhost`; always HttpOnly, SameSite=Strict, Path=/. 10-day sliding expiry with a 30-day absolute cap; guests 2 h. | C10 | [security-model.md](../12-security/security-model.md) |
| **Argon2id** | Password hash on the server (node:crypto, m=19456, t=2, p=1), at most 2 concurrent hashes, with a known-answer self-test at startup. | C10 | [security-model.md](../12-security/security-model.md) |
| **Offline verifier** | Per-uid PBKDF2-SHA256 (600k iterations) verifier that lets a user log in offline without storing the password (OFF-03). Never created for root. | C10 | [security-model.md](../12-security/security-model.md) |
| **su grant** | A 15-minute server grant obtained by typing the password into the secure prompt. | C10 | [security-model.md](../12-security/security-model.md) |
| **Cross-origin isolation** | COOP `same-origin` plus COEP `require-corp` (and CORP `same-origin`) make `crossOriginIsolated` true, which SharedArrayBuffer, ORT threads and `measureUserAgentSpecificMemory()` need. Every asset is self-hosted. | C10 | [security-model.md](../12-security/security-model.md) |
| **Secure context** | A page served over HTTPS or from `localhost`. Plotinium must be opened at `http://localhost:4717`, never a LAN IP, or the Service Worker, OPFS and SharedArrayBuffer are unavailable. | C1, C10 | [deployment-and-ci.md](../14-devops/deployment-and-ci.md) |
| **First-start credentials** | No password is ever in the README or `compose.yaml`. The seed generates credentials at first start and prints them only in the app logs; examiners receive theirs on paper. | C10 | [security-model.md](../12-security/security-model.md) |

### 3.13 Delivery, quality and process

| Term | Meaning in Plotinium | Source | Defined in |
|---|---|---|---|
| **Gate** | A live review on a tagged release: G0 Registration (W2), P1 architecture defence (W4), P2 (W7, v0.2.0), P3 (W11, v0.3.0), P4 (W14, v0.4.0), FRZ feature freeze (W16, v1.0.0-rc.N), P5 final defence (W17–18, v1.0.0). Weeks are indicative; exact dates come from Google Classroom. | Spec §13 | [requirements-traceability.md](./requirements-traceability.md) |
| **Requirement ID** | A spec identifier such as `VFS-06` (prefixes BOOT, PROC, MEM, VFS, WM, OFF, SYS, DB, RAG, AGT, PRE). | Spec p3 | [requirements-traceability.md](./requirements-traceability.md) |
| **Plotinium design ID** | An identifier for one of our own normative choices (for example `ARC-02`, `PLT-ID-13`). Its prefix must be registered in the traceability spec. | Plotinium design | [requirements-traceability.md](./requirements-traceability.md) |
| **Canonical decision (C1–C18)** | The binding decisions block that applies the source precedence to the research inputs. Every spec follows it. | Plotinium design | [README](../README.md) |
| **Traceability matrix** | Requirement → owner → gate → test titles → evidence, generated by `tools/traceability.ts` from test titles. | C18 | [requirements-traceability.md](./requirements-traceability.md) |
| **Evidence artefact** | A committed file that proves a requirement at a gate: a CI report, a lab performance JSON, a screenshot or terminal transcript from the gate, or a document section. | Plotinium design | [requirements-traceability.md](./requirements-traceability.md) |
| **Pilot figure** | A number measured by the AI-run pilot on a development laptop (`docs/evidence/pilot/`). Always labelled *pilot figure — re-measure on the lab machine*; never used as gate evidence. | Plotinium design | [README](../README.md) |
| **Lab-spec machine** | The Department's standard workstation, published in Week 2. Numerical targets are measured there, in current stable Chrome. | Spec p3 | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **Spike / pre-registration** | A time-boxed experiment that produces evidence for a decision record. Its criteria, weights and thresholds are committed before any result, so they are not reverse-engineered from the winner (§14.1). | Spec §14.1 | [stack-decisions.md](../15-decisions/stack-decisions.md) |
| **Decision record / ADR** | A record with context, at least three options, pre-declared criteria, evidence, decision and reversal trigger (§14.1). After the Week-4 stack freeze, a change needs a new record in `docs/adr/` plus the instructor's approval (§14.4). | Spec §14 | [stack-decisions.md](../15-decisions/stack-decisions.md) |
| **Primary owner / secondary reviewer** | Every subsystem and every path has one of each (§4.2), encoded in `.github/CODEOWNERS`. | Spec §4.2, C15 | [implementation-plan.md](../16-delivery/implementation-plan.md) |
| **Definition of done** | The TEAM_CONTRACT list a task must satisfy: merged through a reviewed PR with CI green, tests named by requirement ID, coverage kept, budgets green, docs updated, demoable on the deployed build, and explainable line by line. | Spec §4.4 | [implementation-plan.md](../16-delivery/implementation-plan.md) |
| **`IMPLEMENTED` flag** | `export const IMPLEMENTED = false` in each `dsa/` module until its owner writes it from first principles; its tests run under `describe.runIf(IMPLEMENTED)`. | C16 | [data-structures.md](../08-dsa/data-structures.md) |
| **budgets.json** | `tests/performance/budgets.json`, read by the performance tests, which fail the build when a budget is exceeded. | Spec §15.3 | [testing-and-performance.md](../13-quality/testing-and-performance.md) |
| **Clean bring-up** | `git clone …`, `cd plotinium`, `docker compose up -d --wait`, then open `http://localhost:4717` (`PLOTINIUM_PORT` overrides the port). The spec allows three commands and five minutes; CI fails a release above 240 s. | Spec §17.1, C1, C14 | [deployment-and-ci.md](../14-devops/deployment-and-ci.md) |
| **Equity report** | `tools/equity.ts`: commits, lines by package, PRs authored and reviewed per member, posted in CI (Code Quality & Equity, 10%). | Plotinium design | [implementation-plan.md](../16-delivery/implementation-plan.md) |

### 3.14 Words with more than one meaning

Always qualify these words in specs, code comments, commit messages and the viva (GLO-04).

| Word | Meanings in Plotinium | Say |
|---|---|---|
| session | (1) `auth_session`, the revocable login cookie session; (2) `os_session`, the desktop session that locks, `op_log` and swap refer to; (3) a shell session (`sid` in the PCB, for job control); (4) a browser session (a tab or profile lifetime). | "auth session", "OS session", "shell session", "browser session" |
| epoch / fence / version / sequence | Kernel fencing epoch (one kernel per origin); lock fencing token (stale writer → EBUSY); inode version (optimistic concurrency); `cseq` (outbox order); `owner_seq` (feed resume); Lamport counter (op ordering); heap `seq` (round-robin arrival order). | the full name every time |
| lock | Web Lock `plotinium:kernel`; S/X lease from the server lock manager; local advisory lock (offline); PostgreSQL row and advisory locks L1–L4. | "kernel lock", "lease", "local lock", "row lock" |
| transaction | IndexedDB readwrite transaction (client); PostgreSQL transaction in `vfsTxn` (server); the agent's "txn" id printed after a committed plan. | "IDB transaction", "server transaction", "plan txn" |
| freeze | Stack freeze after the P1 defence (W4, §14.4); feature freeze at W16 (only fixes afterwards, §13.2). | "stack freeze", "feature freeze" |
| critical | Critical service (halts boot); critical path (`bootlog --critical-path`); axe "critical" accessibility issues. | "critical service", "critical path", "axe-critical" |
| snapshot | `GET /api/sync/snapshot` (resume past the retention horizon); the dry run's read snapshot. | "sync snapshot", "dry-run snapshot" |
| index | Vector index (client segments and pgvector); database indexes (§11.4); IndexedDB indexes; BM25 keyword index. | "vector index", "DB index", "IDB index", "keyword index" |
| page | Memory page (paging); a web page; a pageable vector segment. | "memory page", "vector segment" |
| worker | Executor; special worker (kernel, blkio, ai.embed); Service Worker; CI runner. | the specific name |
| priority | Static priority (0–39); `nice`; effective priority (with aging); the `PRI` column shown by `ps`. | "static priority", "nice", "effPrio", "PRI" |
| quota | A user's byte and inode quota (VFS-06); the browser's storage quota (`navigator.storage.estimate()`). | "user quota", "browser storage quota" |
| kernel | Our kernel core in the kernel worker; the "kernel" release string printed by `uname` (`kernel 0.3.0-a1f93c2`). | "kernel worker", "kernel release" |

## 4. Interfaces and data shapes

### 4.1 Entry format

Each glossary table row has exactly four cells: term (bold, optionally with a code form in parentheses), meaning, source, defined-in link. Headings `### 3.x` group terms by subsystem. Anchors follow GitHub's heading slugs; a spec links a term through its group heading, for example `../00-product/glossary.md#36-synchronisation-transport-and-locks`.

### 4.2 Machine-readable term list (for `tools/spec-lint.ts`)

```ts
// tools/spec-lint/glossary.ts — Plotinium design
export interface GlossaryTerm {
  term: string;                 // the bold text of the first cell, e.g. "Kernel fencing epoch"
  aliases: string[];            // code forms and abbreviations, e.g. ["effPrio"]
  source: 'App. B' | `Spec §${string}` | `C${number}` | 'Plotinium design' | 'Plotinium design (proposed)';
  definedIn: string;            // relative link target
  group: string;                // the ### heading
}

// Appendix B terms that GLO-01 requires (exact spelling of the spec)
export const APPENDIX_B_TERMS = [
  'ACID', 'Aging', 'Blast radius', 'Cosine similarity', 'DAG', 'Embedding', 'Idempotency key',
  'Inode', "Kahn's algorithm", 'Lease', 'LRU', 'OPFS', 'Outbox / operation log', 'p95',
  'Page fault', 'PCB', 'Prompt injection', 'Quantum', 'RAG', 'Recall@5 / MRR',
  'Service Worker', 'Topological sort', 'Trie', 'Web Worker',
] as const;                     // 24 terms

// GLO-05: docs occurrences are reported as warnings for the reviewer (negated mentions such as
// "Lamport, not HLC" are legitimate); source identifiers fail the code lint.
export const RETIRED_DOC_TERMS = [
  'HLC', 'hybrid logical clock', 'ESTALE', 'per-uid IndexedDB', 'outbox partition',
  'syncd worker', 'refresh interval + 1 ms', 'Kernium', 'serverSeq',
] as const;
export const RETIRED_IDENTIFIERS = ['hlc', 'serverSeq', 'outboxPartition', 'perUidDb'] as const;
```

The parser reads the Markdown tables of §3 and produces `GlossaryTerm[]`. It does not parse prose.

## 5. Algorithms and invariants

- **Invariant G-1 (GLO-01).** `APPENDIX_B_TERMS ⊆ terms(§3.2)`, with the spec's spelling.
- **Invariant G-2 (GLO-02).** Each term string (case-insensitive, aliases included) occurs in exactly one row of §3. Duplicate detection is a hash-set pass over all rows, O(t) for t terms.
- **Invariant G-3 (GLO-03).** Every `definedIn` link resolves to an existing file (the link checker in [README §8](../README.md)).
- **Invariant G-4 (GLO-05).** No retired identifier appears in source code (ESLint `id-denylist`). Retired phrases in `specs/**` and `docs/**` are listed in the CI job summary as warnings; the reviewer confirms each is a negated or historical mention. The docs scan is one pass over the text with a set of lowercase phrases, O(total characters × number of phrases).

## 6. Errors and edge cases

### 6.1 Retired terms (never used for the current design)

| Retired term | Why it is gone | Use instead | Authority |
|---|---|---|---|
| HLC, hybrid logical clock | Conflict detection uses inode versions only; a wall-clock-aware clock added viva surface for no benefit | Lamport counter plus `cseq`; offline mtime clamped by the server at commit | C6 |
| ESTALE | Not in the canonical errno set | EAGAIN with `detail.reason = 'stale-plan'` | C3; [syscall-abi.md](../01-architecture/syscall-abi.md), [agentic-shell.md](../10-ai/agentic-shell.md) |
| `sessions` table (spec reference schema) | One word meant three things | `auth_sessions` and `os_sessions` | C6, C7 |
| per-uid IndexedDB databases | Contradicted the boot DAG and the P2 permission demo | One database `plotinium` per device; the kernel enforces rwx | C4 |
| per-tab outbox partitions, leader adoption | Only one kernel runs per origin | One kernel per origin, takeover screen | C2 |
| syncd worker, ai.search worker, ai.predictor worker, auth worker | Oversubscribed a 4-thread lab CPU | Kernel services or ordinary executor processes | C2 |
| "refresh interval + 1 ms" frame gate, rAF-delta frame time | 17.67 ms at 60 Hz fails the spec's 16.7 ms | Chrome-trace frame duration p95 ≤ 16.7 ms and zero LoAF over 50 ms from our scripts | C13 |
| change feed keyed by the acting uid | Missed other users' changes to shared directories | Per-owner feed | C6 |
| SERIALIZABLE `vfsTxn` | Most writes retried under load in the pilot | READ COMMITTED with the canonical lock order | C7 |
| bigint inode ids, sequence blocks | Failed offline when a block ran out | UUIDv7 everywhere | C5 |
| TypeBox, Zod | Three schema libraries; JIT paths break under our CSP | Valibot only | C3 |
| `@fastify/helmet`, `@fastify/static` | Duplicated Caddy and broke cross-origin isolation | Caddy owns static files and headers | C9 |
| Kernium (alternative name) | An existing company name | Tabium | [identity-and-branding.md §3.3](./identity-and-branding.md) |
| "root password in the README" | Secrets must never be in the repository (§18) | First-start credentials printed only in app logs; examiners on paper | C10 |

### 6.2 Edge cases for the glossary itself

| Case | Rule |
|---|---|
| A spec introduces a term not defined here | Its author adds the row in the same PR; `spec-lint` warns while the spec is Draft and fails once it is Accepted. |
| Two specs define a term differently | The spec owning the topic (index in [README §3.1](../README.md)) wins; the other spec and this file are corrected in one PR. |
| A term's meaning changes after the stack freeze | Only through the change process in [README §3.6](../README.md) (new decision record plus instructor approval when a decision changes). |
| The spec PDF is amended (numbered written amendment on Google Classroom) | Appendix B rows are updated in the week the amendment is posted; the amendment number is noted in the row. |
| A proposed term is rejected by its owning spec | The row is removed or moved to §6.1 with the reason. |

The glossary defines no errnos. Errno names, meanings and mappings are normative in [syscall-abi.md](../01-architecture/syscall-abi.md); §3.11 lists only the two AI errnos because they are Plotinium-specific words.

## 7. Performance budgets

None. The glossary checks run inside the docs CI job, which has a total budget set in [testing-and-performance.md](../13-quality/testing-and-performance.md).

## 8. Test plan

| Test title | Level | Runs |
|---|---|---|
| `GLO-01 glossary section 3.2 contains all 24 Appendix B terms with the spec spelling` | docs lint | every PR touching `specs/**` |
| `GLO-02 no glossary term or alias appears in more than one row` | docs lint | every PR touching `specs/**` |
| `GLO-02 every emphasised first-use term in a spec file has a glossary row` | docs lint | every PR touching `specs/**` (warning while Draft) |
| `GLO-03 every Defined-in link in the glossary resolves to an existing spec file` | docs lint | every PR touching `specs/**` |
| `GLO-05 source code contains no retired identifier such as hlc, serverSeq or outboxPartition` | lint | every PR |
| `GLO-05 the docs job summary lists every retired phrase in specs and docs for reviewer confirmation` | docs lint | every PR touching `specs/**` or `docs/**` |

## 9. Open questions and cross-spec requests

**Open questions**
- Q1 (R4, W3): should the glossary be copied into the technical report as an appendix, or referenced? The report has a 30-page ceiling (§17.2).
- Q2 (R5, W2): does the instructor want Urdu equivalents for key terms in the viva? No requirement says so; not planned.

**Cross-spec requests**
- To [../03-kernel/processes-and-scheduling.md](../03-kernel/processes-and-scheduling.md): confirm whether `PRI` in `ps` equals priority plus nice (the RAG spec assumes so), so the "priority" row of §3.14 can be made exact.
- To every spec author: mark each new Plotinium term with emphasis on first use and add its row here in the same PR (GLO-02).
