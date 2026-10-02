# Testing

**Status:** 2026-09-25. `pnpm test` runs **1,570** requirement-titled tests across the package projects: 1,376 pass, 185 are skipped by design (158 `dsa/` tests gated until each structure is implemented; 27 server tests that need a PostgreSQL URL) and 9 fail in UI and AI suites that are being written right now. The performance harness (180 budgets, the checker, the frame-trace parser), the server-side fault-injection matrix, integration, e2e, accessibility and visual scaffolding are in `tests/`. Owner: R5 QA/DevOps. Reviewer: R1 Kernel.
**Built from (normative):** [specs/13-quality/testing-and-performance.md](specs/13-quality/testing-and-performance.md). If this document and the spec disagree, the spec wins.

Spec §15.2 requires the test strategy, how to run each suite, coverage, the performance budgets and the fault-injection design.

TODO(team): replace pilot figures with your own lab measurements (the authoritative numbers come only from the lab-spec machine; §4).

## 1. Rules for every test

- **The title begins with the requirement ID** (spec p3, C18): `VFS-06 rejects a write beyond quota with EDQUOT and no partial data`. [`tools/traceability.ts`](tools/traceability.ts) parses every `*.test.ts`, `*.spec.ts` and `*.bench.ts`, builds the requirement-to-test matrix (`pnpm traceability`), and `pnpm traceability --strict` fails CI on a title whose first token is not an ID; an unregistered ID prefix is a warning until the traceability spec is accepted (TRC-02). Skipped and `todo` tests are listed but never count as coverage; tests gated with `runIf` are reported as conditional.
- **Tests assert behaviour, including the edge cases** (spec §15.3: "examiners read the tests"): both the negative and the positive outcome, no snapshot-only assertions, no thresholds hard-coded in tests (they come from `budgets.json`).
- **Flakiness policy.** A flaky test is quarantined within 24 hours in [`tests/quarantine.json`](tests/quarantine.json) with an issue and an owner; at most two tests may be quarantined at once (today: none).
- **Definition of done for a test:** it has a requirement ID, runs in the project and cadence its level requires, is deterministic (seeded generators, a frozen clock where time matters), and cleans up after itself.

## 2. Test strategy: levels mapped to spec §15.3

| Level (§15.3)                             | What it must cover                                                                                                     | Tool and project                                                                                             | Where                                                                                                                     | Runs                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Unit**                                  | every DSA structure with edge cases; path resolver; permission matrix; shell parser; scheduler ordering and aging      | Vitest, one project per package (Node)                                                                       | `<pkg>/**/*.test.ts`                                                                                                      | every PR                                                                                               |
| **Property-based** (Should)               | random VFS op sequences leave `fsck` clean; heap invariants after random pushes, pops and priority changes             | fast-check 4.10.2 inside the unit projects and the `property` project                                        | `<pkg>/**/*.prop.test.ts`, [`tests/property/`](tests/property/)                                                           | every PR at 100 runs per property with a fixed seed; nightly at 10,000 runs with a random, logged seed |
| **Integration**                           | syscalls against the database; fault injection for every bulk op; concurrent clients; lock leases; outbox replay       | Vitest `integration` (Node + the Compose PostgreSQL 18.6)                                                    | `server/**/*.int.test.ts`, [`tests/integration/`](tests/integration/), [`tests/fault-injection/`](tests/fault-injection/) | every PR                                                                                               |
| Browser (Plotinium)                       | IndexedDB transactions, OPFS swap, workers, the compositor, WebCrypto                                                  | Vitest `browser` (real Chrome channel, persistent profile)                                                   | `<pkg>/**/*.browser.test.ts`                                                                                              | every PR (added with the first kernel code)                                                            |
| **End-to-end**                            | boot → login → terminal → file ops → reboot → session restored; the offline boot path                                  | Playwright `e2e` on channel `chrome` against the Compose stack                                               | [`tests/e2e/`](tests/e2e/)                                                                                                | main, each release, nightly                                                                            |
| Accessibility (Plotinium; WM-07, BOOT-13) | axe scans in both themes; keyboard-only flows                                                                          | Playwright `a11y` with @axe-core/playwright                                                                  | [`tests/a11y/`](tests/a11y/)                                                                                              | PRs touching `wm/`, app views or `web/`; main; release                                                 |
| **Performance**                           | boot time, frame time under load, query p95, autocomplete latency, page-in latency, each failing the build over budget | Vitest bench (complexity curves), Playwright `perf` (CDP traces, boot, paging), k6 (WebSocket and lock soak) | `dsa/bench/`, [`tests/performance/`](tests/performance/)                                                                  | deterministic budgets on every PR; everything nightly and per release on the lab-spec runner           |
| **AI evaluation**                         | Recall@5 and MRR; the agent benchmark; injection fixtures; prediction accuracy; recorded model responses in CI         | Vitest `ai-eval` (`LLM_MODE=replay`, recorded embeddings)                                                    | `ai/eval/`, `ai/tests/eval.*`                                                                                             | PRs touching `ai/`, `server/llm`, `protocol/`; every release (plus 3 live runs)                        |
| Clean bring-up (Plotinium; §17.1)         | `git clone` → `docker compose up -d --wait` → serving, ≤ 240 s, no login, Docker Hub blocked                           | the `bringup` job of [`release.yml`](.github/workflows/release.yml)                                          | –                                                                                                                         | every `v*` tag (weekly once `bringup.yml` exists)                                                      |

```mermaid
flowchart LR
  subgraph PR["Every pull request (hosted runner, required)"]
    L[lint · typecheck · traceability · secrets] --> U[unit + property]
    L --> B[browser: real Chrome]
    L --> I[integration: compose db, fault injection, leases, replay]
    U & B & I --> C[coverage merge + file-count check]
    L --> D[deterministic budgets: bundle, trie, Q1-Q5 at 10k]
    L --> AE[ai-eval replay + litmus, path-filtered]
  end
  subgraph MAIN["Push to main"]
    E2E[e2e + a11y on the compose stack]
  end
  subgraph NIGHT["Nightly 21:30 UTC (lab-spec runner)"]
    P[perf: frames, boot, paging, RAG, starvation] --> CB[check-budgets]
    K[k6 lock + WebSocket soak]
    DEEP[property tests x10,000]
  end
  subgraph REL["Tag v*"]
    FULL[full suite + coverage + traceability] --> BU[bring-up ≤ 240 s] --> RA[Release: JUnit, coverage, perf, traceability]
  end
  PR --> MAIN --> NIGHT
  MAIN --> REL
```

**What exists today (2026-09-25).**

| Project       | Passing                   | Notes                                                                                                                                   |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`    | 473                       | the ABI registry against the spec tables, schemas, errnos, WebSocket frame fixtures (valid and invalid)                                 |
| `apps`        | 353                       | shell lexer, parser, expansion, redirection, job control, completion client; 46 commands against a fake syscall layer                   |
| `ai`          | 164 (+2 in progress)      | RAG pipeline, agent validator/predicate/token/loop, predictor, the AGT-40 and INJ-20 harness                                            |
| `server`      | 154 (+27 need a database) | config guards, gateway, rate limiter, FsBlobStore, `vfsTxn` control flow with a fake executor, SQLSTATE mapping, deployment-file checks |
| `vfs`         | 126                       | paths, the permission truth table, quotas, every op, the IndexedDB store on a test double, fsck, conflicts, links                       |
| `tools`       | 52                        | the ESLint rules and their failing fixtures, the traceability tool                                                                      |
| `dsa`         | 21 (+158 gated)           | the shared harness; every structure's tests wait for `IMPLEMENTED = true`                                                               |
| `db`, `tests` | 14 + 14                   | migrations and seed checks; the harness smoke tests                                                                                     |
| `ui`          | 5 (+7 in progress)        | tokens and primitives, being written                                                                                                    |

The harness under `tests/` has its own configuration for now: `pnpm exec vitest run --config tests/vitest.config.ts` (projects `harness`, `property`, `integration`).

## 3. How to run each suite

| Suite                           | Command                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything in Node              | `pnpm test` (all package projects plus `property` and `tools`)                                                                                                                                                                                                                                                                                                                                                         |
| One package                     | `pnpm --filter @plotinium/vfs test`, or `pnpm exec vitest run --project vfs`                                                                                                                                                                                                                                                                                                                                           |
| Coverage                        | `pnpm test:coverage` (report in `coverage/`: `coverage-summary.json`, `lcov.info`, HTML)                                                                                                                                                                                                                                                                                                                               |
| Property tests at nightly depth | `PLT_FC_PROFILE=deep pnpm exec vitest run --project property` (10,000 runs, random seed printed)                                                                                                                                                                                                                                                                                                                       |
| Integration (PostgreSQL)        | `docker compose -f compose.yaml -f compose.test.yaml up -d --wait db`, then `pw=$(docker compose exec -T db cat /run/plotinium/owner_password)`, create a scratch database, and `DATABASE_URL=postgres://plotinium_owner:$pw@127.0.0.1:55432/<db> pnpm exec vitest run --config tests/vitest.config.ts --project integration` (suites skip themselves without `DATABASE_URL`, and a skip is never counted as verified) |
| Migration round trip (DB-01)    | `db/scripts/migrate-roundtrip.sh`                                                                                                                                                                                                                                                                                                                                                                                      |
| End-to-end                      | `docker compose up -d --wait --build`, then `pnpm e2e` (Playwright, channel `chrome`; `PLOTINIUM_BASE_URL` targets another stack)                                                                                                                                                                                                                                                                                      |
| Accessibility                   | `pnpm exec playwright test -c tests/playwright.config.ts --project a11y`                                                                                                                                                                                                                                                                                                                                               |
| Performance (lab)               | `PLT_MACHINE_CLASS=lab-spec pnpm exec playwright test -c tests/playwright.config.ts --project perf`, then `node tests/performance/check-budgets.ts --results test-results/perf --cadence nightly --machine lab-spec --week <n>`                                                                                                                                                                                        |
| Micro-benchmarks                | `pnpm bench` (all), `pnpm exec vitest bench --project 'dsa (bench)'`; `PLT_BENCH_OUT=docs/evidence/dsa` records the JSON lines                                                                                                                                                                                                                                                                                         |
| Traceability                    | `pnpm traceability` (Markdown), `--json`, `--strict`                                                                                                                                                                                                                                                                                                                                                                   |
| The CI sequence locally         | `pnpm run ci` (format check, lint, type check, tests with coverage)                                                                                                                                                                                                                                                                                                                                                    |

## 4. Coverage

**Spec: MUST, §15.3:** at least **70%** line coverage overall and at least **85%** on `dsa/`, `vfs/` and `kernel/`, reported by CI on every pull request.

- Provider `@vitest/coverage-v8`; `coverage.include` lists every package's sources, so files no test loads still count (since Vitest 4 only loaded files count otherwise). Excluded: tests and benchmarks, `*.d.ts`, generated files (`*.gen.ts`), fixtures, `ai/eval/`, `db/migrations/` (SQL) and `docs/` (including the pilot evidence).
- **Ratchet** ([`vitest.config.ts`](vitest.config.ts)): a package's gate switches on in the PR that merges its first real code by adding it to `GATED_PACKAGES`, and is never removed; the overall 70% gate switches on with the first gated package; `dsa/` is gated per module as each flips `IMPLEMENTED = true` (unimplemented modules are listed as pending, not missing). **Today `GATED_PACKAGES` is still empty** — TODO(R5): add the packages that already have real code (`protocol`, `vfs`, `apps`, `ai`, `server`, `db`).
- CI writes the coverage table to the job summary on every PR ([`ci.yml`](.github/workflows/ci.yml)); every release attaches `coverage-summary.json`, `coverage-lcov.info` and the HTML report to the GitHub Release (PLT-DEL-03).

## 5. Performance budgets

Every budget is an entry in [`tests/performance/budgets.json`](tests/performance/budgets.json) (180 entries, validated by `budgets.schema.ts`) and fails the build when exceeded. **Where numbers come from:** the Department's lab-spec machine in the current stable Chrome (spec p3); hosted CI runners give smoke numbers and deterministic budgets only, never gate evidence.

### 5.1 The spec's numeric targets

| Budget ID                                                  | Metric                                                                         | Target                                           | Spec         | Cadence                  | Machine         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | ------------ | ------------------------ | --------------- |
| `BOOT-10.warm` / `.cold`                                   | boot to desktop-interactive, p95 of 20                                         | ≤ 1.5 s / ≤ 3.0 s                                | BOOT-10      | nightly, release         | lab             |
| `BOOT-10.no-large-assets`                                  | large assets requested before interactive                                      | 0                                                | BOOT-10      | PR (browser), nightly    | any             |
| `PROC-05.frame`, `PROC-05.loaf`                            | p95 frame duration with 3 × `burn` + 10 windows; LoAF > 50 ms from our scripts | ≤ 16.7 ms; 0                                     | PROC-05      | nightly, release         | lab             |
| `WM-03.drag-frame`, `WM-03.drag-loaf`                      | the same while dragging and resizing 10 windows                                | ≤ 16.7 ms; 0                                     | WM-03        | nightly, release         | lab             |
| `ARC-04.main-thread`                                       | kernel and compositor work on the main thread per frame                        | ≤ 4 ms p95                                       | Fig. 8.1     | nightly                  | lab             |
| `PROC-04.starvation`                                       | longest wait with 50 CPU jobs at priority 0 and one at 39                      | ≤ the declared bound (5,450 ms for one executor) | PROC-04, C13 | nightly, release         | lab             |
| `MEM-05.local` / `.remote`                                 | 5 MB page-in p95                                                               | ≤ 300 ms / ≤ 2 s                                 | MEM-05       | nightly / weekly         | lab / prod      |
| `MEM-06.over-budget`                                       | time above budget with a 2× workload                                           | spec ≤ 1 s; ours 0 ms (reservation admission)    | MEM-06       | nightly, release         | lab             |
| `SYS-03.trie-p95`                                          | trie prefix lookup p95 at 10^4 and 10^5                                        | ≤ 1 ms (fails on any runner)                     | SYS-03       | PR, nightly              | any             |
| `DB-05.q1` … `q5`                                          | Q1–Q5 p95 over 1,000 runs                                                      | ≤ 10 ms at 100k (10k on PRs)                     | DB-05        | PR (10k), nightly (100k) | any / lab       |
| `VFS-09.crash-expiry`                                      | lease released after a crashed holder's last renewal                           | ≤ TTL + 0.5 s                                    | VFS-09       | main, release            | any             |
| `RAG-02.freshness` / `RAG-04.recall5` / `RAG-05.retrieval` | re-index a 50 KB file; Recall@5; retrieval p95 over ≥ 10k chunks, warm model   | ≤ 30 s; ≥ 0.80; ≤ 500 ms                         | RAG-02/04/05 | nightly / PR / nightly   | lab / any / lab |
| `AGT-06.injection` / `AGT-07.benchmark`                    | tool calls triggered by injected content; our AGT-40                           | 0; median ≥ 36/40                                | AGT-06/07    | PR (path), release       | any             |
| `PRE-01.predict` / `PRE-02.top3` / `PRE-03.latency-cut`    | one prediction p95; top-3 vs max(MFU, MRU); launch-latency cut                 | ≤ 5 ms; strictly higher; ≥ 30%                   | PRE-01/02/03 | PR / PR / release        | any / any / lab |
| `OFF-02.exactly-once`                                      | lost / duplicated ops after replay                                             | 0 / 0                                            | OFF-01/02    | PR, main                 | any             |
| `OPS-05.bringup`                                           | clean clone to a serving stack                                                 | ≤ 3 commands, CI fails > 240 s (spec 300 s)      | §17.1        | every tag                | hosted          |
| `TST-03.coverage`                                          | line coverage overall / on `dsa`, `vfs`, `kernel`                              | ≥ 70% / ≥ 85%                                    | §15.3        | PR                       | any             |

The Plotinium-internal budgets (syscall round trip ≤ 1 ms p95 under UI load, bundle sizes, DSA complexity shapes, service-manager overheads, …) are in [testing-and-performance.md §7.2](specs/13-quality/testing-and-performance.md) and in `budgets.json`.

### 5.2 How frame time is measured (C13)

The gate is **p95 frame duration ≤ 16.7 ms from a Chrome trace**, plus **zero LoAF entries longer than 50 ms attributed to our scripts**, on the lab-spec machine in Chrome stable — not raw `requestAnimationFrame` deltas, and not "refresh interval + 1 ms" (which would allow 17.67 ms at 60 Hz). The parser ([`tests/performance/frame/`](tests/performance/frame/)) reads the `PipelineReporter` events of a CDP trace inside the script window, takes the refresh interval V from consecutive frames, gives each presented frame the duration `(1 + dropped frames before it) · V`, and takes the nearest-rank p95. At 60 Hz the gate therefore holds if and only if fewer than 5% of presented frames follow a dropped frame. A run whose raw presentation intervals disagree with the model by more than a quarter of V on more than 1% of frames is invalid and repeated. The run procedure (20 s scripted drag and resize, 3 runs, median of the p95s) is fixed in [window-manager.md §8.2](specs/05-wm/window-manager.md). The in-OS frame meter is a live indicator only, never the gate.

### 5.3 Hard gates, ratchets and the lab runner

- Each budget has a `hardFrom` week. Before it, the budget is a **ratchet**: a regression of more than 10% against the last accepted lab baseline fails the nightly. From `hardFrom`, the absolute threshold fails the build. `check-budgets` exits 0 (pass), 1 (a real regression) or 2 (infrastructure: a due budget not measured, a lab budget without a lab result, invalid runs).
- The **lab-spec runner** is a self-hosted runner with the label `lab-spec` that accepts only `schedule` and `workflow_dispatch` jobs on `main` (never pull requests, so fork code never runs on it; OPS-11). Its results come back to `main` through an evidence PR.
- A release needs a passing lab result for the same tree, at most 7 days old (the `perf` job of `release.yml`; enforced once `REQUIRE_LAB_PERF` is set).

Pilot context _(pilot figures — re-measure on the lab machine)_: a main-thread kernel measured syscall p95 9.3–9.5 ms under 10 ms of UI work per frame against 125–165 µs from a worker; with 10 busy workers even vanilla JS reached 33–50 ms frame p95, which is why the frame gate is about worker scheduling rather than the UI framework.

## 6. Fault-injection design (DB-02, DB-03)

**Spec: MUST, §11.3:** "Your test build must include a hook that throws an error after N of M node operations. The reference test runs `rm -r` on a 1,000-node tree and fails at node 500. It then checks that the tree's checksum is unchanged, that both orphan probes return nothing, and that the user's quota usage is unchanged. The same test runs for `mv`, `cp -r`, batch rename and `chmod -R`. It is repeated live at the final defence."

The two sides use different mechanisms because their execution models differ; the syscall and the oracle are shared.

- **Arming.** `debug inject [--target client|server|both] <op> <N>` issues `debug.inject({target, op, after: N})`: uid 0 and capability `debug.fault` only, audited as a security event, one-shot, scoped to the caller's OS session, expiring after 10 minutes unused. The server half exists only when the stack runs with `FAULT_INJECTION=1` (the local, examiner and CI profile); production forces `0` and the server refuses to start otherwise, so the live DB-02 demonstration runs on the local/defence stack.
- **Client (IndexedDB).** The synchronous transaction builder counts `inodes` requests and calls `tx.abort()` in the `onsuccess` of the N-th; IndexedDB rolls back every store in the transaction, `onabort` maps to EIO, and because the in-memory tree is updated only after `oncomplete`, nothing else changed (the test asserts that no VFS event was emitted). The in-code injector is [`vfs/src/fault.ts`](vfs/src/fault.ts).
- **Server (PostgreSQL).** A `BEFORE INSERT OR UPDATE OR DELETE … FOR EACH ROW` trigger on `inodes` and `dentries`, inert unless the transaction sets `plotinium.fault_after = N`; the N+1-th row raises `P0001` (hint `plotinium.fault`), the whole `vfsTxn` rolls back, the server answers EIO and records the deterministic rejection in `op_log` so a resend gets the same answer. Online, bulk ops wait for the server result, so `rm -r` prints `Input/output error (injected fault at node 500) — rolled back` synchronously and the client reverts from `undo`.
- **The oracle** ([`tests/support/oracle.ts`](tests/support/oracle.ts)), run before arming and after the failed operation, on both sides: the subtree checksum is unchanged; orphan inodes and parentless dentries are empty (the spec's two probes); quota for every affected owner is unchanged; blob refcounts and `nlink` are consistent; no new outbox entry (client) and no committed `op_log` row (server) for the failed op; `fsck --checksum` and `fsck --server` are clean. The oracle is a pure function unit-tested on hand-built corrupt trees, so each probe is proven to detect what it claims.
- **The matrix** ([`tests/fault-injection/matrix.ts`](tests/fault-injection/matrix.ts)):

  | Op                                  | Tree                                | Fault points N       | Targets                    |
  | ----------------------------------- | ----------------------------------- | -------------------- | -------------------------- |
  | `rm -r`                             | `tree1000` (1,000 nodes, depth ≥ 6) | 1, 500, 999, 1000, M | client, server             |
  | `cp -r`                             | `tree1000` into a new parent        | 1, 500, 999, 1000, M | client, server             |
  | `mv` of 1,000 files; directory `mv` | `tree1000`                          | 1, 500, 999; 1       | client, server             |
  | batch rename                        | 500 files                           | 1, 250, 499          | client, server             |
  | `chmod -R`, `chown -R`              | `tree1000`                          | 1, 500, 999          | client, server             |
  | agent `batch` (AGT-05)              | a 4-step plan                       | step 3               | client, server             |
  | blob upload                         | 20 files                            | 1, 10                | server (`FaultyBlobStore`) |

  Plus M + 1, which must commit normally and report `fault_not_fired` (the hook is inert when not reached), and a fast-check property that picks N in [1, M] at random. Today the server half runs through the database's normative SQL (`tests/fault-injection/server.test.ts`, skipped without `DATABASE_URL`); TODO(R2/R5): drive the same matrix through `server/src/vfs/tx.ts` and add the client half in the browser project with the kernel.

- **Concurrency and crash tests.** DB-03 torture: 2 and 8 clients move overlapping subtrees for 60 s, after which the tree is acyclic, every inode is reachable, the probes are empty and every failed move returned EINVAL, EBUSY or succeeded after a retry (1,000 iterations on PRs, 20,000 nightly; [`tests/integration/concurrency.test.ts`](tests/integration/concurrency.test.ts)). VFS-09 crash expiry: two persistent browser contexts, kill the holder's renderer, the waiter gets the lease within TTL + 0.5 s. OFF-02: 5,000 queued ops replayed with zero disconnects and one `op_log` row per `opId`, plus a property variant that drops, duplicates and reorders frames. Kill during commit: `pg_cancel_backend` mid-transaction (AGT-09) leaves the oracle clean on both sides.

## 7. Other suites

- **End-to-end scenarios** ([testing-and-performance.md §3.8](specs/13-quality/testing-and-performance.md), E1–E21): boot to session restore, the offline boot with the server killed (not just `setOffline`, which leaves WebSockets open), lock contention between two users, the boot menu and panic, the hash-only update (OFF-05) with two OS tabs, and the rest; the first specs are in [`tests/e2e/`](tests/e2e/).
- **Accessibility:** axe with zero serious or critical violations on every screen in both themes, keyboard-only flows, boot-screen announcements at most one per 750 ms ([`tests/a11y/`](tests/a11y/)).
- **Visual:** the UI gallery compared with the Stitch designs ([`tests/visual/`](tests/visual/)).
- **AI evaluation:** see [AI.md §5](AI.md#5-evaluation-results); CI never holds an API key and replays recorded responses.
- **Security:** the SYS-01 bypass suite (8 cases from an executor and from a view), the auth security suite, `rag-leak`, the header and CSP assertions and gitleaks ([SECURITY.md §8](SECURITY.md#8-security-tests)).

## 8. Demo Day rehearsals

Four full rehearsals of the §17.1 script (0:00–0:05 clean bring-up, 0:05–0:08 boot, 0:08–0:18 the system under test including the live DB-02 fault injection and the hidden AI prompts, then the viva) on a machine the team does not control, with pre-flight checklists at T-7 and T-1 days ([testing-and-performance.md §3.16](specs/13-quality/testing-and-performance.md), [ops/RUNBOOK.md §11](ops/RUNBOOK.md#11-gate-week-checklist)).
