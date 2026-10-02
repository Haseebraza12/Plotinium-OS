
# Role matrix

The spec (s4.2) sets four rules. Every subsystem has a primary owner and a named secondary reviewer. Every PR is approved by another member. Every member writes meaningful code in at least 2 subsystems. Every member can be examined on the whole system.

## 1. Per member

| Role | Primary subsystem (spec s4.1) | Second subsystem where they write code | DSA they own | Documents they own | Viva shadow (studies deeply) |
|---|---|---|---|---|---|
| **R1 Kernel / Systems Architect** | Process table and PCBs, scheduler (bands, aging, pre-emption), executor pool, watchdog, syscall dispatcher and IPC bridge, event bus, memory manager, LRU pager, swap tiers | **Server blob and swap store** (FsBlobStore, `/api/swap`, GC; MEM-04/05). **AI coupling:** pre-fetch jobs, speculative pages, ai.embed page accounting, indexer throttling | binary heap + index map; `PidTable` hash table (distinction credit); page-table maps; LRU list | ARCHITECTURE.md (lead editor); scheduler and paging benchmark reports; DSA.md (editor; each owner writes their own entries) | DB transactions and sync (R2) |
| **R2 VFS / Database Engineer** | VFS tree, path resolution, permissions, links, quotas, IndexedDB store; DB schema, migrations, `vfsTxn` and lock protocol, indexes; sync engine and lock manager on the server | **AI backend:** `file_chunks`, `index.put/pull/search` with the readable-set CTE, the agent `sys.batch` server executor, fingerprint re-check, `audit_log`, cancel | n-ary tree; B-tree and hash indexes (DB); file-handle (open-file) table | DATABASE.md (ERD, isolation level, indexes, benchmarks, EXPLAIN plans); SECURITY.md (permission model, auth, secrets); fault-injection and query benchmark reports | Agent pipeline (R4) |
| **R3 WM / UI Subsystem Lead** | boot-ui (boot screen, menu, panic, recovery visuals), login, desktop, compositor, taskbar, Terminal interface and completion, built-in app views, accessibility, frame rate | **AI search:** BM25 keyword index, RRF, snippet and citation builder (`ai/search`, RAG-06), plus the completion-trie service process (`complete`) | window registry; z-order list; trie; optional interval structure for hit-testing (extra credit) | README.md (front page); identity kit (`docs/identity`, `/system/branding`); accessibility audit; frame-time evidence; slides and the demo video (with R5) | Scheduler and pager (R1) |
| **R4 AI Pipeline Specialist** | Embedding pipeline, indexer, vector search, agentic shell (planner client, validator, intent binding, dry run, confirm, execute, undo), predictor model, evaluation sets, AI safety | **Shell and coreutils** (lexer, parser, executor, pipes, redirection, jobs syntax, all required commands, man pages). **Server gateway:** auth sessions, `su` grants, guest accounts, LLM gateway and budget | vector index (Float32 segments + heap top-k); Bloom filter; telemetry Markov model | AI.md (coupling map, models, evals, safety, cost report); evaluation reports; AI_USAGE.md (curator: every member adds entries through the PR template) | Boot and offline sync (R5) |
| **R5 QA / DevOps & Integration Engineer** | Service manager and boot orchestration (DAG, degraded state, back-off, safe/recovery modes, bootlog), offline execution (Service Worker, update flow), CI/CD, test and performance harness, fault-injection harness, deployment, backups, observability | **VFS sync client:** `syncd` (WebSocket protocol v1, outbox replay, HLC, reconnect state machine) and the offline login verifier | DAG + topological sort; ring buffer for logs | BOOT.md; TESTING.md; CHANGELOG.md; THIRD_PARTY.md; TEAM_CONTRACT.md (secretary); STACK_DECISION.md (editor; each record is written by its spike owner); the `ops/` runbook | Compositor and UI (R3) |

**Why R4 carries auth and the gateway.** The spec does not assign auth, and R2's primary is already the largest role. The LLM gateway needs sessions and rate limiting anyway, so one owner keeps the whole "API gateway and auth" layer coherent. Estimated person-weeks from W5 to W16 are about 11 to 12 for every role.

## 2. Subsystem ownership (drives CODEOWNERS)

| Subsystem / path | Primary | Secondary reviewer | Why this reviewer |
|---|---|---|---|
| `kernel/core/{proc,sched,ipc}`, `kernel/runtime` | R1 | R5 | Boot orchestration and the test harness sit on the kernel |
| `kernel/core/mm`, `kernel/blkio` | R1 | R2 | Storage, swap device and IndexedDB expertise |
| `vfs/` (tree, path, perm, quota, store, ops) | R2 | R1 | Syscall and scheduler integration |
| `vfs/sync`, `vfs/locks` | R5 | R2 | Must mirror the server protocol exactly |
| `server/sync`, `server/locks`, `server/vfs`, `db/` | R2 | R5 | CI, concurrency tests, operations |
| `server/storage`, `server/swap` | R1 | R2 | Transaction ordering: blob upload before the DB transaction |
| `server/gateway` (auth, `su`, guest), `server/llm`, `server/ratelimit.ts` | R4 | R2 | Schema and security |
| `wm/compositor`, `wm/shell`, `wm/tokens`, `apps/*/view.tsx` | R3 | R1 | Main-thread budget and frame performance |
| `wm/boot-ui`, `services/` | R5 (orchestration) and R3 (UI) | each reviews the other | Shared boot surface |
| `apps/terminal` (tty, xterm) | R3 | R4 | Shell integration |
| `apps/shell`, `apps/coreutils`, `apps/demo` | R4 | R3 | Terminal integration |
| `ai/indexer`, `ai/embed`, `ai/agent`, `ai/predictor`, `ai/eval` | R4 | R2 (indexer, agent), R1 (embed, predictor) | Database, security, scheduling and memory coupling |
| `ai/search` (BM25, citations) | R3 | R4 | |
| `dsa/*` | each owner | a member who does not own it (rotating) | Independent check that the code is written from first principles |
| `.github/`, `ops/`, `tools/`, `tests/performance` | R5 | R1 | |
| `protocol/` | R1 | R2 + R4 (2 approvals) | Changes the ABI for every consumer |
| `db/migrations` | R2 | R5 (runs the round-trip) | |

## 3. STACK_DECISION.md record owners (write, present, defend; everyone must be able to answer on all of them)

| Records | Owner |
|---|---|
| UI framework, styling, terminal, editor | R3 |
| Kernel language and placement, IPC and validation | R1 |
| Backend runtime, HTTP/WS framework, transport | R5 with R2 |
| Primary database, ORM and query builder, migrations, driver | R2 |
| Client storage and Service Worker | R2 with R5 |
| Vector store, embedding model and runtime, LLM, predictor | R4 |
| Deployment, reverse proxy, observability, CI, testing and benchmarks | R5 |
| Auth and security model | R4 with R2 |

## 4. Keeping contributions fair and verifiable (Code Quality & Equity, 10%)

- **Weekly equity report.** `tools/equity.ts` runs in CI and posts to the job summary: commits, lines by package (excluding generated code, lockfiles and fixtures), PRs authored, and PRs reviewed per member.
- **Target band:** each member authors 15 to 25% of non-generated lines and at least 15% of reviews.
- **Trigger.** If anyone falls outside the band for 2 weeks in a row, it goes on the Monday agenda and the TEAM_CONTRACT escalation ladder applies.
- **Pairing.** Pair programming is credited with `Co-authored-by:` trailers.
- **Explain your PR.** A reviewer can ask the author to explain any line. If the author cannot, the PR is not merged. This prepares every member for the viva.
- **Teach-backs.** A 30-minute teach-back each week: the owner explains a subsystem to their shadow, and the shadow re-explains it the following week. From W15, mock vivas rotate so that every member is questioned on every subsystem.
