# Plotinium

> **A local-first web OS that pages its own memory and lets AI act only through the kernel.**
> _(Recommended tagline, candidate 1 of [identity-and-branding.md §3.4](specs/00-product/identity-and-branding.md); it becomes final after the team vote and is then stored once in `docs/identity/identity.json`.)_

Plotinium is an AI-native, local-first operating system that runs in the browser, built by a five-student team for the BSCS capstone at Lahore Garrison University (Fall 2026). The name is coined from plutonium, element 94: dense and energetic, like the element.

- **A real kernel.** A TypeScript kernel runs in one dedicated Web Worker. It schedules processes as resumable generators on executor workers, checks permissions on every system call, and accounts memory against a budget, paging process state out to OPFS and to the server.
- **A real file system.** A Unix-style virtual file system (inodes, dentries, uid/gid and rwx, quotas, symlinks) lives in IndexedDB, works fully offline, and syncs to PostgreSQL over a WebSocket protocol with an exactly-once outbox, leases with fencing tokens and conflicted copies.
- **AI inside the OS, not on top of it.** Semantic file search (RAG), an agentic shell and predictive pre-fetch run as ordinary scheduled, permission-checked processes that act only through typed system calls. The model proposes; the kernel decides.

|                       |                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live URL**          | `https://<domain>`: not deployed yet. The first production deploy is the `v0.2.0` tag at the Phase 2 gate (Week 7), through [`release.yml`](.github/workflows/release.yml) and [`deploy.yml`](.github/workflows/deploy.yml). |
| **Status page**       | UptimeRobot, linked here after the first deploy ([RUNBOOK §9](ops/RUNBOOK.md#9-monitoring-with-uptimerobot))                                                                                                                 |
| **Version**           | `0.1.0` (untagged development line). Tags: `v0.2.0` (P2), `v0.3.0` (P3), `v0.4.0` (P4), `v1.0.0-rc.N` (freeze), `v1.0.0` (final defence)                                                                                     |
| **Examiner accounts** | handed over on paper at each gate; never written in this repository (spec §18)                                                                                                                                               |

## Bring-up (three commands)

```sh
git clone https://github.com/<org>/plotinium.git
cd plotinium
docker compose up -d --wait
```

Then open **<http://localhost:4717>** in Google Chrome. Use `localhost`, not a LAN IP: the OS needs a secure context, and the stack listens on `127.0.0.1` only.

- **Port taken?** `PLOTINIUM_PORT=4718 docker compose up -d --wait`.
- **First-start passwords** are generated for your stack and printed once: `docker compose logs app | grep -A 20 'FIRST-START CREDENTIALS'`. No credential is ever written in this README or in `compose.yaml`.
- **Reset:** `docker compose down -v` deletes every volume, including the generated database passwords.
- **Prerequisites:** Docker Engine or Docker Desktop with Compose 2.24 or newer, on amd64 or arm64; about 1.5 GB of free RAM and 2 GB of disk; Google Chrome stable.
- **How it is built:** three services only: `web` (Caddy 2.11, the static shell and every security header), `app` (one Node 24 process: migrations, first-start seed, then the Fastify server under `/api/*` and `/ws`) and `db` (PostgreSQL 18.6 with pgvector 0.8.6, no published port). Images come from GHCR, pinned by digest on `main` by each release; if an image is missing for your platform, Compose builds it from this repository.
- **What you see today** (2026-09-25): the stack starts and becomes healthy, `http://localhost:4717/api/readyz` answers `{"status":"ready", …}` with the full isolation header set (COOP, COEP, CORP, CSP), and the page is a placeholder, because the browser shell (`web/`) is not built yet. See [What works now](#what-works-now).

The release pipeline times exactly these three commands on a fresh runner with no `docker login` and Docker Hub blocked, and fails the release above 240 seconds (spec §17.1 allows 5 minutes).

## What works now

Honest status on 2026-09-25, from the code on disk. "Tests" are Vitest tests whose titles begin with a requirement ID (C18); `pnpm test` ran **1,570** of them on this date: 1,376 passed, 185 skipped by design (158 `dsa/` tests gated until each structure is implemented, 27 server tests that need a PostgreSQL URL) and 9 failed in the UI and AI suites that are being written right now.

| Area                         | State                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Specifications               | 28 specification files (about 29,000 lines): requirement tables, designs, test plans and the traceability matrix                                                                                                                                                                                                                                                                                                             | [`specs/`](specs/README.md)                                      |
| System-call ABI              | complete contract: 119 calls in 12 groups, the 25-errno set, capabilities, events, audit records, signals, WebSocket protocol v1 frames with valid and invalid fixtures, ABI digest; 473 tests                                                                                                                                                                                                                               | [`protocol/`](protocol/)                                         |
| Data structures              | interfaces, complete edge-case and property tests, and benchmarks for all nine structures; **every implementation is deliberately left to its owner** (`IMPLEMENTED = false`, spec §10.2)                                                                                                                                                                                                                                    | [`dsa/`](dsa/), [DSA.md](DSA.md)                                 |
| Virtual file system          | paths, the isomorphic permission matrix, names, quotas, every operation (create, write, rename, unlink, copy, link, attributes, batch) as plan + one transaction, the IndexedDB store and migrations, fsck, the fault injector, the open-file table; 126 tests against an IndexedDB test double                                                                                                                              | [`vfs/`](vfs/)                                                   |
| Shell and command-line tools | the shell (lexer, parser, expansion, globbing, redirection, pipelines, job control, history, completion client, prompt, builtins) and 46 commands with man pages; 353 tests against a fake system-call layer                                                                                                                                                                                                                 | [`apps/shell`](apps/shell/), [`apps/coreutils`](apps/coreutils/) |
| AI subsystems                | RAG pipeline (chunker, extraction, hashing, indexer queue, exact vector index, readable set, BM25, hybrid, citations), agent (datamarking, strict tool schemas, intent binding, validator and dry run, kernel confirmation predicate, HMAC plan token, audit, undo, root drop, observation loop, cassettes), predictor (Witten-Bell Markov-2, baselines, evaluator, pre-fetch policy); AGT-40 and INJ-20 fixtures; 164 tests | [`ai/`](ai/), [AI.md](AI.md)                                     |
| Server                       | configuration with production guards, runtime and graceful shutdown, `/api/healthz` and `/api/readyz`, metrics, logs, token-bucket rate limiter, FsBlobStore, `vfsTxn` with the L0–L4 lock order, retries and SQLSTATE → errno mapping, the auth gateway (login, logout, me, `su`, guest, password change) and the first-start seed; 154 tests                                                                               | [`server/`](server/)                                             |
| Database                     | 6 dbmate migrations (17 tables) with down scripts, `schema.sql`, integrity probes P1–P9, Q1–Q5 and Qb, the perf-index toggles, a deterministic 10k/100k seed                                                                                                                                                                                                                                                                 | [`db/`](db/), [DATABASE.md](DATABASE.md)                         |
| UI kit                       | design tokens, motion, fonts, icons and about two dozen accessible primitives (in progress)                                                                                                                                                                                                                                                                                                                                  | [`ui/`](ui/)                                                     |
| Containers and operations    | `compose.yaml` (+ prod and test overrides), a three-target Dockerfile, the Caddyfile with the CSP hashes, backup, restore, restore drill, deploy, host provisioning, release and deploy workflows                                                                                                                                                                                                                            | [`ops/`](ops/), [RUNBOOK](ops/RUNBOOK.md)                        |
| Test harness                 | 180 performance budgets with a checker, the frame-trace parser, fault-injection matrix, integration and e2e scaffolding, a11y harness, lint rules with failing fixtures, the traceability tool                                                                                                                                                                                                                               | [`tests/`](tests/), [`tools/`](tools/), [TESTING.md](TESTING.md) |

## Known limitations

Stated honestly, as spec §15.2 asks. This list is updated at every gate.

- **Nothing boots in the browser yet.** The kernel worker, the process table and scheduler, the memory manager, the service manager, the compositor and window manager, and the Vite web shell (`kernel/`, `services/`, `wm/`, `web/`) are not written. The VFS, shell, commands and AI pipelines are libraries tested in Node against test doubles; they are not yet wired to a running kernel.
- **The nine data structures are not implemented.** By spec §10.2 the tree, trie, heap, DAG and LRU (and the extra hash table, ring buffer, Bloom filter and z-order list) are written by their owners from first principles. Their tests are ready and skip until each owner flips `IMPLEMENTED` to `true`.
- **Sync, locks, swap, index, LLM and telemetry endpoints answer `501 ENOSYS`.** The WebSocket `/ws` protocol, the lock manager, remote swap, the index API and the LLM gateway adapter are specified and have their database tables, but the server routes are skeletons.
- **No AI model is wired.** No embedding weights are self-hosted yet, the LLM bake-off has not run, and there is no provider adapter: on any stack without a key the gateway reports `no-key` and the AI features degrade, as designed.
- **Not deployed.** There is no production URL and no GHCR image yet; `compose.yaml` still names placeholder `:0.1.0` image tags, so today the three commands build the images from source (slower than the 240-second budget, which is measured on released images).
- **Performance figures are pilot numbers.** Every number quoted in the documents that comes from the AI-run pilot is labelled _pilot figure — re-measure on the lab machine_ until the team measures it on the lab-spec machine.
- **Coverage gates are not switched on yet.** They switch on per package by a ratchet in the PR that lands its first real code (70% overall, 85% on `dsa/`, `vfs/` and `kernel/`).
- **Local data is not encrypted at rest.** Anyone who controls the browser profile's operating-system account can read the IndexedDB mirror, as on UNIX with physical access ([SECURITY.md](SECURITY.md)).

## Developing

Prerequisites: Node.js 24 (see `.node-version`), pnpm 12.5.1 (`corepack enable`), Docker, and Google Chrome stable.

```sh
pnpm install          # exact versions from pnpm-lock.yaml
pnpm run ci           # format check, lint, type check, tests with coverage
docker compose up -d --wait --build   # the stack from your working tree
```

**Build identity.** The Docker build context has no `.git`, so `pnpm start` runs `node tools/build-id.ts -- docker compose up -d --wait --build`, which passes one identity to both images as build arguments: `BUILD_SHA` is the 7-digit git short SHA of a clean checkout, or else (no git, or uncommitted changes) the first 7 hex digits of a SHA-256 over the paths and bytes of every source file the images are built from (the workspace packages, `ops/`, the lockfile and the root build files; never `node_modules`, `dist` or logs), so the same source always gets the same id; `BUILD_VERSION` is `<package.json version>-dev.<commits since the last v* tag>`, or the tag's version on a clean tagged commit; `BUILD_DATE` is the day of the commit, or of the newest source file. A plain `docker compose up --build` computes the same values inside the build (the Dockerfile's `buildid` stage), and valid build arguments always win, as in the release pipeline. The splash, the login screen, `/version.json`, `/api/readyz` and the WebSocket `hello.ok` all show it; `node tools/build-id.ts` prints it.

| Command                             | What it does                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                    | TypeScript 7 over the whole repository, then every package against its own `tsconfig.json` |
| `pnpm lint`                         | ESLint 10 with `--max-warnings 0`, including the package-boundary and local rules          |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                   |
| `pnpm test` / `pnpm test:coverage`  | Vitest projects (one per package, plus `property` and `tools`)                             |
| `pnpm bench`                        | Vitest micro-benchmarks (`*.bench.ts`)                                                     |
| `pnpm e2e`                          | Playwright on Chrome stable against a running stack                                        |
| `pnpm traceability`                 | the requirement-to-test matrix built from test titles                                      |
| `pnpm run ci`                       | the CI sequence locally (`pnpm ci` is pnpm's clean-install command, so use `run`)          |

Every test title begins with its requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data`. All work goes through reviewed pull requests into a protected `main` ([TEAM_CONTRACT.md](TEAM_CONTRACT.md)).

## Repository map

| Path                              | What lives there                                                                                             | Primary owner        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| [`protocol/`](protocol/README.md) | Valibot schemas for system calls, errnos, events, WebSocket protocol v1 and agent tools                      | R1                   |
| [`dsa/`](dsa/README.md)           | the team's own tree, trie, heap, DAG, LRU, hash table, ring buffer, Bloom filter, z-order list               | each owner           |
| [`kernel/`](kernel/README.md)     | process table, scheduler, executors, dispatcher, memory manager, pager, swap                                 | R1                   |
| [`vfs/`](vfs/README.md)           | inode tree, paths, permissions, quotas, IndexedDB store, fsck; sync and lock clients                         | R2 (sync client: R5) |
| [`services/`](services/README.md) | the 18 service manifests and the service manager (boot DAG)                                                  | R5                   |
| [`wm/`](wm/README.md)             | compositor, boot screen, login, desktop, taskbar, frame meter                                                | R3                   |
| [`ui/`](ui/)                      | design tokens and accessible UI primitives                                                                   | R3                   |
| [`apps/`](apps/README.md)         | terminal, shell, coreutils, files, editor, task manager, settings, demo programs                             | R3, R2, R1           |
| [`ai/`](ai/README.md)             | embedding worker, indexer, semantic search, agentic shell, predictor, evaluation                             | R4                   |
| [`server/`](server/README.md)     | one Node process: auth, sync engine, lock manager, blob and swap store, LLM gateway                          | R2 with R1, R4, R5   |
| [`db/`](db/README.md)             | PostgreSQL migrations (up and down), seeds, benchmark queries, integrity probes                              | R2                   |
| [`web/`](web/README.md)           | Vite entry, `index.html`, Service Worker                                                                     | R5                   |
| [`tests/`](tests/)                | end-to-end, integration, fault-injection, property, performance and accessibility suites                     | R5                   |
| `tools/`                          | ESLint rules, traceability and bundle-budget scripts                                                         | R5                   |
| [`ops/`](ops/README.md)           | host provisioning, deploy, backup, restore and drill scripts; the [runbook](ops/RUNBOOK.md)                  | R5                   |
| `docs/`                           | diagrams, decision records, identity kit, Stitch designs, report, slides, research inputs and pilot evidence | all                  |
| [`specs/`](specs/README.md)       | the engineering specifications this code implements                                                          | all                  |

## Documents

[ARCHITECTURE.md](ARCHITECTURE.md) · [STACK_DECISION.md](STACK_DECISION.md) · [DSA.md](DSA.md) · [DATABASE.md](DATABASE.md) · [AI.md](AI.md) · [BOOT.md](BOOT.md) · [TESTING.md](TESTING.md) · [SECURITY.md](SECURITY.md) · [AI_USAGE.md](AI_USAGE.md) · [TEAM_CONTRACT.md](TEAM_CONTRACT.md) · [CHANGELOG.md](CHANGELOG.md) · [THIRD_PARTY.md](THIRD_PARTY.md) · [ops/RUNBOOK.md](ops/RUNBOOK.md)

The specifications start at [specs/README.md](specs/README.md); if a root document and a spec disagree, the spec wins and the document is corrected. AI assistance in writing this repository, including these documents, is disclosed in [AI_USAGE.md](AI_USAGE.md) (spec §18).
