
# Phase plan: weeks 1 to 18

**Roles.** R1 Kernel/Systems · R2 VFS/Database · R3 WM/UI · R4 AI Pipeline · R5 QA/DevOps & Integration.

**Capacity assumption.** Each member works about 12 to 15 hours a week, so the team has about 65 hours a week. Week 8 is the midterm, planned at about 40% capacity.

**Gate rules.** A gate is passed only by a live demo on a tagged release. Every phase follows the same rhythm:
- Features for the gate are cut off 3 days before it.
- The tag is created the day before the gate and deployed to production.
- The gate script is rehearsed once on a machine that is not a team member's.

## Phase 0 and Phase 1: architecture and defence (W1 to W4)

| Wk | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI | R5 QA/DevOps | Team milestone |
|---|---|---|---|---|---|---|
| 1 | Chrome capability probe (nested module workers, SharedArrayBuffer in executors, OPFS sync handles, isolation, Web Locks); TypeScript kernel spike harness | Postgres 18 + pgvector compose; seed script; ERD v0 | 10-window UI spike harness in 4 frameworks; name and logo sketches | LLM gateway spike; start writing AGT-40 and INJ-20; embedding harness | Repo, pnpm workspace, CI skeleton (lint, TS 7 typecheck, unit tests, gitleaks), branch protection, issue board, CODEOWNERS; start the VPS purchase retry loop | **Pre-registration PRs:** criteria, weights and thresholds for every decision are committed *before* any spike result. Instructor questions sent: public repo? instance used for the AI demo? temperature-0 equivalence? Node 26? lab machine spec? |
| 2 | Kernel spike M1 to M4 | DB spike: Q1 to Q5 before and after indexing, fault injection, concurrency torture, SQLite as the losing option | Framework benchmark; all 5 members do the Task-Manager kata | Embedding bake-off in Chrome; first LLM runs | Transport soak P1a; clean bring-up timing; self-hosted lab-spec runner (once the spec is published) | **REGISTRATION GATE:** form, OS name + tagline, `TEAM_CONTRACT.md` merged via PR, CI green on a PR, instructor added. Puter and daedalOS measurement sessions (each member measures 2 scenarios) |
| 3 | Kernel spike M5 to M7; `dsa/heap` + benchmark | Client-storage spike with R5 (OPFS vs IndexedDB swap on disk); DDL; tree representation | Terminal + editor spike; accessibility spike; identity kit v0 | LLM bake-off (3 runs per configuration, selection rule); pilot retrieval eval; predictor pilot | Transport P1b + campus WebSocket test + exactly-once property spike; `dsa/dag` | **Evidence freeze (end of W3).** STACK_DECISION draft; C4 diagrams; DSA.md draft; 2-page benchmark analysis; risk register; work breakdown (one issue per Must/Should requirement ID, each with an owner) |
| 4 | ARCHITECTURE.md + kernel slides | DATABASE.md draft + DB slides | Boot design visuals, UI slides | AI.md plan + AI slides | BOOT.md (DAG), deploy slides, rehearsal logistics | **PHASE 1 DEFENCE.** Two rehearsals with cross-examination (anyone can be asked about any decision). Revisions due within 1 week. **Stack frozen.** |

**P1 defence script (15 minutes plus 10 minutes of questions; 3 minutes per member):**
1. **R5:** context and container diagrams, deployment, bring-up, CI.
2. **R1:** kernel placement and language, scheduler, pager.
3. **R2:** database, isolation level, tree representation, fault injection.
4. **R3:** UI framework, compositor, boot design, identity.
5. **R4:** RAG, agent and predictor, with the LLM bake-off rule.

Each speaker shows, for their records, the pre-registered criteria, at least 3 options, our own measurements, the risks, and the reversal trigger. Q&A drills cover all 12 records using flashcards, and every member rehearses answers for each one.

## Phase 2: VFS and window manager, v0.2.0 (W5 to W7)

| Wk | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI (+ shell, auth) | R5 QA/DevOps |
|---|---|---|---|---|---|
| 5 | Kernel worker + host bindings; Valibot dispatcher; `PidTable`; spawn/exit/wait on one executor; program model; boundary ESLint rules | `dsa/tree`; inode tree + dentry maps; path resolver (`.`, `..`, `//`, ELOOP at 40 hops); IndexedDB `tx()` builder; mkfs hierarchy (VFS-01/02/03) | boot-ui v1 (tokens, logo, **truthful asset + kernel-init progress**); compositor core (registry, focus, z 1..n, drag); `dsa/trie` | Shell lexer and parser with property tests; first coreutils (ls, cd, pwd, cat, echo, mkdir, touch, rmdir) | Compose stack + Caddy headers on the VPS; Vitest projects (unit, browser) + coverage thresholds; bundle-budget gate; `dsa/ringbuffer` + klog; `svcmgr` v1 (DAG, Kahn, cycle panic) |
| 6 | View ports and display channels; window syscalls; event bus; pipes (kernel ring buffers); basic heap scheduler with round-robin; `dsa/hashtable` | Permission matrix (VFS-04); symlinks (VFS-05); quotas inside the transaction (VFS-06); two-phase bulk ops cp -r / mv / rm -r with fault points; fd table | 8 resize handles, snapping, min/max/restore animations, taskbar, layout persistence (WM-06); login screen; desktop; Terminal view (xterm + tty) | Server auth: sessions, argon2id, cookies, seeded users, guest and demo accounts; coreutils cp, mv, rm, ln, find, tree, stat, chmod, chown | Nightly perf on the lab runner (boot, WM-03 drag); e2e boot → login → terminal → reboot; axe in CI; tag → deploy pipeline |
| 7 | SYS-01 bypass suite; syscall hardening; `uname`, `/system/release` | Full VFS test suite; boundary tests (VFS-08); du, df, quota; File Explorer syscalls | File Explorer; tab completion (SYS-03, p95 benchmark); About dialog, manifest, favicon; accessibility fixes | grep, redirection, env vars, history, help and man; start collecting the RAG corpus | Tag **v0.2.0**; production deploy; gate rehearsal |

**Milestone at the end of W5: walking skeleton.** On the deployed URL, the boot screen leads to the kernel worker, then a stub login, then the desktop. The Terminal runs `echo hi | cat` entirely through syscalls.

**P2 gate script (the examiner uses the production URL):**
1. Open the URL. The boot screen shows name, logo, version and build hash. Turn on DevTools "Slow 4G" and reload: the progress bar visibly slows.
2. Log in as `demo`. The desktop appears.
3. Open 10 windows: 4 Terminals, 3 File Explorers, 3 Editors. Drag and resize them with the frame meter on: p95 ≤ 16.7 ms.
4. Show the VFS suite green in the CI run for tag v0.2.0.
5. Live permission test: as `bob`, `cat /home/alice/notes.md` gives EACCES; `chmod 644` as alice; `ls -la /`.
6. Quota test: `quota`, then write past it (`EDQUOT`, and `du` shows no partial file); `df`.
7. `ln -s a b; ln -s b a; cat a` gives ELOOP. Nest 32 levels deep.
8. Tab completion over a directory with 10k entries, with `complete --bench` printing p95.
9. `reboot`. The window layout is restored.

## Phase 3: scheduler and persistence, v0.3.0 (W8 to W11, midterm in W8)

To make this phase fit, some work is pulled forward into Phase 2: `svcmgr` (R5, W5), the core migration and auth (R4 and R2, W6), and the heap scheduler (R1, W6).

| Wk | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI (+ shell) | R5 QA/DevOps |
|---|---|---|---|---|---|
| **8 midterm (~40%)** | Written proof of the aging bound; SAB control-block PR | All migrations with down scripts (inodes, dentries, blobs, locks, op_log, os_sessions, swap_pages, audit_log); seed script | Task Manager skeleton + tests | Markov predictor (pure code + unit tests) | Service Worker precache + offline shell; CI integration project (`compose up db`). **Rule for this week: no merges on critical paths, only reviews, tests and docs.** |
| 9 | Priority bands and quanta, SAB pre-emption, watchdog, placement; ps, top, kill, nice, renice, jobs, bg, fg, &; starvation test (PROC-04); PROC-05 frame gate | Server `vfsTxn` + `lockPlan`; set-based bulk SQL; acyclicity trigger; fault trigger + harness; DB-02 and DB-03 property tests; Q1 to Q5 indexes + benchmark | Task Manager (256 rows, reconcile, kill/renice); Editor (CodeMirror) with `expectedVersion`, conflict banner | Server LLM gateway module (budget, token bucket, cassettes); agent harness in CI; `su` grants; remaining coreutils (lsof, fsck front end, bootlog, uptime) | `syncd`: WS v1 client, outbox replay with credits, HLC, reconnect state machine; offline PBKDF2 verifier |
| 10 | Memory manager: accounting, `dsa/lru`, page tables, OPFS blkio swap, page-out/page-in, "restoring" window state, free, vmstat, pmap, thrashing guard | Sync engine (op pipeline, per-user change_seq, conflicted copies, lost+found); lock manager (leases, fences, sweeper); `/api/blobs` | Boot v2 UI (boot menu, verbose log, panic screen, recovery console); taskbar connectivity and degraded badges (OFF-04); lock read-only banner | ai.embed worker in the repo (self-hosted weights); chunker; `dsa/bloom`; eval corpus reaches 200 docs | Boot v2 orchestration (DAG-driven, degraded + back-off, safe/recovery modes, `bootlog --critical-path`); exactly-once replay suite; k6 lock soak |
| 11 | Remote swap client + **server `/api/swap` and FsBlobStore (R1's second subsystem)**; MEM-04 page-in from a new session; 2× workload test; MEM-05 benchmark | DB-05 report with EXPLAIN plans; backup and restore drill; VFS-09/10 tests; fsck (VFS-11) | Frame-time evidence under load; accessibility audit #2 | BM25 hand-off to R3; AGT-40 extended; `file_chunks` design with R2 | Offline e2e (server killed); Service Worker update flow (OFF-05); tag **v0.3.0**; gate rehearsal |

**P3 gate script:**
1. `burn --ms 120000 &` ×3, then `top`. Drag 10 windows: frame meter p95 ≤ 16.7 ms and 0 LoAF over 50 ms from our code.
2. `memhog --total 512M --procs 8`. Task Manager's Memory tab shows faults and bytes out; `free` and `vmstat 1`. Restore a minimised window: "Restoring…" appears, and the page-in time is printed.
3. As root, `debug inject rm 500`. As alice, `rm -r ~/fixtures/tree1000` fails with EIO and rolls back. `fsck` reports 0 orphans; the checksum and `quota` are unchanged on the client and on the server.
4. Kill the server (`docker compose stop app`) or cut the network, then `reboot`. The desktop comes up offline. Use Terminal, Files, Editor, Task Manager and Settings. The taskbar shows "Offline · n queued". Reconnect: the ops replay exactly once.
5. Two Chrome profiles: alice gets the X lock and bob gets read-only. End alice's renderer from Chrome's Task Manager. Bob acquires the lock within the lease TTL, and `lsof` shows the countdown.
6. Hold Esc to open the boot menu, choose Verbose, then `bootlog --critical-path`. Show Safe mode. The examiner adds a cycle, `reboot`, and the panic screen names the cycle; recover from there.
7. Show the starvation test output against the declared bound, and the Q1 to Q5 report.

## Phase 4: foundational AI layer, v0.4.0 (W12 to W14)

| Wk | R1 Kernel | R2 VFS/DB | R3 WM/UI | R4 AI | R5 QA/DevOps |
|---|---|---|---|---|---|
| 12 | Indexer throttle, duty cycle and pause-on-search-focus; ai.embed as a declared page; `prefetch:*` jobs + speculative pages; agent kill via AbortSignal | `file_chunks` migration; `index.put`, `pull` and `search` with the readable-set CTE; `sys.batch` server executor + fingerprint check + `audit_log` | Semantic search in Files (citations); Settings → Privacy; predictions shown in Task Manager | Indexer process end to end; `semsearch`; agent envelope, planner client and validator (intent binding) | ai-eval CI project (cassettes, no key); `rag-leak` suite; litmus job; RAG-05 and PRE-01 budgets. **Week-12 AI checkpoint (descoping rule)** |
| 13 | PRE-03 launch-latency measurement; PRE-04 frame trace during pre-fetch; residency hint and indexer ordering fed by predictions | `pg_cancel_backend` on kill; `ai undo` inverse ops (optional); server search oracle | Confirmation dialog UX (focus trap, default N); dry-run rendering; accessibility | Dry run, kernel-owned confirmation + HMAC token, execute, audit, `ai log`; datamarking; RAG and PRE evaluation runs | INJ-20 and AGT-40 replay in CI; cost-report pipeline from `llm_requests`; self-hosted models on production; budget alerts |
| 14 | Hardening, tests | Hardening, tests | Polish | AI.md (coupling map, evals, safety, cost) + evaluation reports | Tag **v0.4.0**; gate rehearsal |

**P4 gate script:**
1. `ps` shows `ai.indexer` (priority 32, niced), `ai.search` and `prefetch:*`. Save a 50 KB file; `semsearch` finds it within 30 s (RAG-02).
2. The examiner types a hidden semantic query in both Terminal and Files. Results carry path:line citations.
3. The examiner gives an agent instruction. The plan and dry run appear with the blast radius; the prompt defaults to N; after `y` it commits one transaction; `ai log` shows the record.
4. Kill the agent mid-plan: it rolls back.
5. Safety run live:
   - the injection fixture from the examiners produces no tool call;
   - the permission-leak suite (bob searches for alice's 600-mode files) returns 0 results;
   - a destructive plan without confirmation is refused.
6. `predict` shows the top 3 with confidence. Launch the predicted app and compare its latency with and without pre-fetch. Task Manager shows the speculative pages.
7. Litmus test: the AI-off build runs side by side and everything else works.
8. Present AI.md and the cost report.

## Hardening, freeze and Phase 5 (W15 to W18)

| Wk | Focus | Output |
|---|---|---|
| 15 | Bug bash led by R5 (every member tests someone else's subsystem); performance tuning on the lab machine; ARCHITECTURE.md "two decisions we would reverse"; draft report chapters; **first full 30-minute rehearsal** on a machine the team does not own; OFF-05 rehearsal; restore drill | Bug list sorted by severity; all documents in draft |
| 16 | **Feature freeze: tag v1.0.0-rc.1.** All documents complete; CHANGELOG; coverage report; **full rehearsal (the gate)**. After this, only `fix:` PRs, each with 2 approvals | Freeze passed |
| 17 | Production deploy of the release candidate; 20–30 page technical report (Typst); slides; 5–7 minute demo video (OBS, understandable without narration); two mock vivas; failure drills (see demo-day readiness) | rc.N tags as needed |
| 18 | Tag **v1.0.0** early in the week; final production deploy; freeze the production `.env`; T-1 checklist | **Final defence** following s17.1 |

**Peer assessment** is confidential and collected twice; follow the instructor's dates, likely around W9 and W17. **Checkpoint meetings:** 15 minutes every Friday, where each member demos what they merged to main that week.
