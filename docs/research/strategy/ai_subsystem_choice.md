
# Which AI subsystems to build

## Decision

**Build all three subsystems (A: RAG semantic search, B: agentic shell, C: pre-fetch predictor), but at different depths and under a pre-registered descoping rule.** A and B are the deep, examined pair. C is small, cheap and tightly coupled to the kernel. It is never dropped, because it is the only subsystem that makes "AI informs the system" true.

### Why not stop at two

1. **The four AI-native properties (s3) are not all covered by any pair that leaves out C:**

| Property | A (RAG) | B (agent) | C (pre-fetch) |
|---|---|---|---|
| AI sees the system through the kernel (reads via syscalls, kernel event bus) | yes: `vfs.*` events, `sys.read` as uid | yes: listing via syscalls as uid | yes: `wm.*`/`proc.*` events |
| AI acts through typed syscalls, never strings or eval | – | **only B** | – (it only issues speculative page-ins) |
| AI is scheduled by the system (pid, priority, budget, killable, throttled) | yes: `ai.indexer` p32, `ai.embed` page | yes: `ai.agent` process, killable | yes: `prefetch:*` p39 |
| AI informs the system (pre-loading, residency, job order) | – | – | **only C** |

   B and C together cover all four properties. A adds the deepest coupling to the database and to security. A+B, the "obvious" pair, would miss property 4.
2. **The final defence explicitly includes all three** (s17.1): "a semantic query, an agent instruction including a destructive confirmation, and a pre-fetch demonstration". The litmus test (s3.4) also names all three effects.
3. **C costs little.** It is roughly 3 person-weeks, a Markov chain of about 400 LOC plus telemetry and eval. Most of its depth lives in kernel code the team must build anyway: speculative pages, idle-priority jobs, residency hints. It is co-built by R1 as their second subsystem.

### Why this is still "depth over count"

Each subsystem must meet a written depth bar before it is claimed at the P4 gate:
- every cell in its coupling-map row is implemented **and has a named test**;
- its evaluation meets the numeric target;
- its safety tests pass in CI;
- it degrades gracefully.

A subsystem that misses this bar at the Week-12 checkpoint is handled by the descoping rule below. It is never shipped shallow.

## Pre-registered descoping rule (committed in AI.md before Week 12)

1. **What gets cut, and in what order.** Extras go first, in this order: optional RAG LLM answer, then hybrid RRF, then the naive-Bayes challenger, then `ai undo` (AGT-10, a "may"), then HNSW, then WebGPU. A whole subsystem is dropped only after every extra is gone.
2. **Week-12 checkpoint.** Each subsystem has an end-to-end skeleton: A indexes a file and answers `semsearch`; B takes a plan through validation to a dry run; C predicts and runs a pre-fetch job.
   - If A or B is not at its skeleton, it keeps its current level. Its extras are cut and freed effort moves to it. At the P4 gate the team claims the two subsystems that meet the depth bar, and the third is shown as partial.
3. **C is never dropped.** Its cost is small and it carries property 4.

## Coupling map (AI.md table; every cell names its proving test)

|   | Scheduler | Memory | VFS | Shell | Database | Security |
|---|---|---|---|---|---|---|
| **A. RAG** | `ai.indexer` process at priority 32, nice +10. It runs at a 50% duty cycle while the user is active and is paused while search has focus. One quantum is one chunk inference. **Test:** RAG-01 `ps`/`top` during typing | `ai.embed` is one declared page of about 100 MiB; evicting it means `worker.terminate()`. Vector segments of 1,024 rows are pageable pages with checksums, pinned while search has focus. **Test:** `mem-evict-embed`, byte-identical segment page-in | Subscribes to `vfs.write/rename/unlink/chmod`. Reads through `sys.read` as the uid. A rename updates metadata only; an unlink tombstones in the same transaction. **Test:** RAG-02 timed consistency | `semsearch` (pipe-able) and search in Files, with a BM25 keyword fallback when offline or while the model loads. **Test:** RAG-06 | `file_chunks vector(384)` with an FK to `inodes ON DELETE CASCADE`, exact scan, HNSW only if measurements require it, precomputed seed vectors. **Test:** fault-injected `rm -r` leaves no stray vectors | The readable-inode set (r on the file, x on every ancestor) is computed from the CURRENT tree before ranking; no uid or mode is copied into the index. **Test:** RAG-03 `rag-leak`, 0 leaks |
| **B. Agent** | `ai.agent` process at priority 20, on its own executor, BLOCKED on `net:llm` and on `tty:confirm`. `kill` rolls back the transaction. **Test:** AGT-09 kill mid-plan | 16 MB soft limit; envelope and plan state are its pages. (The spec leaves this cell empty; ours is minimal.) | Acts only through typed syscalls (`sys.batch` with `expectedVersions`). The dry run uses a read snapshot. **Test:** AGT-01/02 | `ai "…"`, `ai log`, `ai undo`; clarifying questions appear in the TTY. **Test:** AGT-07 (AGT-40 set) | One `vfsTxn` with a fingerprint re-check; `audit_log` rows with `actor='agent'` and `prompt_id`; `llm_requests` cost rows. **Test:** AGT-05/08 | Runs as the invoking uid. The kernel decides when confirmation is needed and issues an HMAC confirm token. Capabilities are narrowed. Datamarking and intent binding; no `eval`. **Test:** AGT-03/04/06 (INJ-20) |
| **C. Pre-fetch** | Emits `prefetch:<app>` jobs at priority 39, only when idle for at least 2 s and confidence ≥ θ; paused by the interactive hint. **Test:** PRE-04 frame trace | Pages the predicted app's last state in as SPECULATIVE pages: evicted first, discarded after 5 minutes unused. Needs free memory ≥ the app's bytes + 16 MB. Top-1 prediction gives a residency hint to the LRU. **Test:** PRE-04 eviction order | Warms recently used files of the predicted app into the inode cache and blob chunks. It also reorders the indexer queue so the predicted app's files are indexed first. **Test:** warm-cache hit ratio | `predict` shows the top 3 with confidence and a reason. **Test:** PRE-06 | Optional `telemetry_events`, synced only after opt-in. **Test:** PRE-05 | Telemetry stays in an on-device ring buffer that can be viewed, cleared and exported in Settings → Privacy. **Test:** PRE-05 storage inspection |

## Litmus test as a CI job (s3.4)

- **Seams.** `kernel/core` exposes three hook interfaces with no-op defaults:
  - `SchedulerHints` (the predictor);
  - `ShellNL` (the `ai` command);
  - `FsSemanticSearch` (semsearch and Files search).

  `ai/` registers them at service start.
- **The AI-off build.** A Vite define `__AI__=false` tree-shakes the registrations, and server env `AI=0` removes `/api/llm/*` and `/api/index/*`.
- **The `litmus` job.** It runs on PRs that touch `ai/` or `kernel/`, and on every release. It builds with AI off and runs the full non-AI e2e suite: boot, login, file operations, offline boot, Task Manager, reboot. It then asserts:
  - `ai`, `semsearch` and `predict` report "command not found";
  - Files search is keyword-only;
  - there are zero `prefetch:*` processes;
  - everything else passes.
- **At the P4 gate:** show the two builds side by side.

## Models, runtime and cost (from the frozen stack)

| Subsystem | Model | Where it runs | Offline behaviour |
|---|---|---|---|
| A | `MongoDB/mdbr-leaf-ir` q8 ONNX, MRL-truncated to 384 dims; fallback `Xenova/bge-small-en-v1.5` q8 | Browser, `ai.embed` worker (Transformers.js 4.3 on ORT WASM), batch size 1, ≤ 512 tokens; weights self-hosted and loaded after `desktop-interactive` | Works fully offline once the weights are cached; BM25 while they load |
| B | Claude through `server/llm`. Provisional: `claude-opus-5-5` at effort medium. Final choice by the Week-3 bake-off rule | Server gateway: key only in the server env, per-uid limits, reserve/settle budget | "agent unavailable (offline) — nothing was run". `ai log` and `ai undo` still work |
| C | Hand-written Witten-Bell interpolated Markov-2 → Markov-1 → MFU by time bucket → global MFU. MFU is used until 50 launches | Executor process | Unaffected by being offline |

LLM spend estimate: about $0.047-0.066 per command, $130-185 for the semester. The hard cap is never above $250, with alerts at 50%, 80% and 100%. The team should ask Anthropic for the academic discount. The cost report comes from `llm_requests`. Both Opus models reject `temperature`, so get the instructor's written agreement before Week 4 that cassettes, fixed seeds, a frozen clock and 3 live runs satisfy s12.6.

## Evaluation plan (datasets built progressively)

| Subsystem | Dataset | Metrics and targets | When |
|---|---|---|---|
| A | Own corpus: 60 docs at W3 → 200 docs / 30 queries at W11 → 300 docs / 50 queries at W13, covering course notes, Markdown and source code. Queries are written by members who did not write the documents | Recall@5 ≥ 0.80 and MRR (RAG-04); p95 ≤ 500 ms over ≥ 10k chunks warm, with the indexer active, and first query after eviction (RAG-05); 0 leaks (RAG-03); ≤ 30 s consistency (RAG-02) | ai-eval on each release |
| B | AGT-40: 10 pipelines, 8 relative-date, 8 glob, 8 ambiguous (must ask for clarification), 6 must-reject. INJ-20: 10 malicious names and 10 malicious contents | AGT-40 median ≥ 36/40 (the examiners require ≥ 16/20); INJ-20 executed-unrequested = 0; destructive actions without confirmation = 0 | Replayed cassettes per PR; 3 live runs per release |
| C | ≥ 500 real launch events: the team dogfoods the OS daily from W9, plus a seeded 3-persona generator for unit tests. Chronological 70/30 split and a prequential curve | Top-1 and top-3 accuracy versus MFU and MRU (PRE-02); ≥ 30% median launch-latency cut on correct predictions (PRE-03); prediction ≤ 5 ms (PRE-01); wasted pre-fetch bytes | Per release |

## Staffing (AI is 20% of the mark; spread it)

| Role | Contribution |
|---|---|
| R4 (lead) | Everything in `ai/agent`; the indexer, chunker, embed worker and eval harnesses; the predictor model; AI.md |
| R1 | Scheduling and memory coupling: throttling, the ai.embed page, pre-fetch jobs, speculative pages, residency hints, the PRE-03 latency measurement |
| R2 | Server `file_chunks`, `index.put/pull/search` with the readable-set CTE; the `sys.batch` server executor, fingerprint check, `audit_log`, cancel |
| R3 | BM25 keyword index and snippet/citation builder (their second subsystem); Files semantic-search UI; the confirmation dialog; Settings → Privacy |
| R5 | ai-eval CI project (cassettes, no key), the `rag-leak` and INJ-20 gates, the litmus job, the RAG-05 and PRE-01 perf budgets, the cost-report pipeline |
