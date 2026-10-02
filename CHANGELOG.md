# Changelog

All notable changes to Plotinium are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), and entries are grouped by requirement ID (PLT-DOC-12).

Release tags: `v0.2.0` at the Phase 2 gate (Week 7), `v0.3.0` at P3, `v0.4.0` at P4, `v1.0.0-rc.N` in Weeks 16–17 and `v1.0.0` at the final defence. A fix after a gate tag is a patch release, for example `v0.3.1`. Owner: R5 QA/DevOps. Every user-visible change adds a line under **Unreleased** in the same pull request.

**How a release uses this file.** Before tagging `vX.Y.Z`, a PR renames `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, opens a new empty `[Unreleased]`, and sets `package.json` to `X.Y.Z`. The `verify` job of [`release.yml`](.github/workflows/release.yml) refuses a tag without that section, and the GitHub Release notes are that section plus the generated notes and the evidence (coverage, bring-up time, image digests).

## [Unreleased]

Work since the 0.1.0 scaffold, on the way to `v0.2.0`. Nothing here is released or deployed yet; see the README's [known limitations](README.md#known-limitations).

### Added

- **Specifications (SPX-01…SPX-09, PLT-DOC-\*).** 28 specification files under `specs/`: architecture and the system-call ABI, boot and services, processes and scheduling, memory and paging, the VFS, the window manager and the UI design system, offline and sync, the shell, data structures, the database, the four AI specs, the backend API, the security model, testing and performance, deployment and CI, the stack decisions and the delivery plan; the requirement-traceability matrix.
- **System-call ABI (SYS-01, §9.6; ABI-01…ABI-16).** `protocol/`: the `{id, call, args}` → `{id, ok, value | errno}` envelope and the executor and view port frames; the registry of 119 calls in 12 groups with argument and result schemas, class, origin, capabilities, audit level and errnos, checked against the spec's tables; the closed 25-errno set (C3); 22 capabilities; event topics, audit records, signals; the ABI version and digest; well-known inode UUIDs (C5).
- **Sync protocol (VFS-09, VFS-10, OFF-02; C6).** `protocol/src/ws/`: WebSocket protocol v1 frames, constants and close codes, with valid and invalid fixtures for every frame type.
- **Data structures (DSA-GEN-01…09, PROC-01, PROC-02, MEM-02, SYS-03, BOOT-04, WM-02).** `dsa/`: interfaces, complete edge-case and fast-check property tests (158) and benchmarks with shape assertions for the tree, trie, heap, DAG, LRU, hash table, ring buffer, Bloom filter and z-order list, each behind `IMPLEMENTED = false` for its owner to implement (C16); the shared sampler and bench harness.
- **Virtual file system (VFS-01…VFS-11, OFF-02, DB-02 client side).** `vfs/`: path resolution, the isomorphic permission matrix (`perm.ts`), names, quotas, every operation as a plan plus one IndexedDB transaction, the store schema and migrations, the open-file table and write sessions, conflict handling, fsck with repair, and the client fault injector.
- **Shell and commands (SYS-02, SYS-03).** `apps/shell`: lexer, parser, expansion, globbing, redirection, pipelines, job control, history, the completion client, prompt and builtins; `apps/coreutils`: 46 commands with man pages; `apps/terminal`: the TTY device glue.
- **AI subsystems (RAG-01…06, AGT-01…10, PRE-01…06; C12).** `ai/`: the RAG pipeline (chunker, extraction, hashing, indexer queue, exact vector index, readable set, BM25, hybrid, citations, metrics); the agent (envelope and datamarking, strict tool schemas, intent binding, validator and dry run, confirmation predicate, HMAC plan token, audit, undo, root drop, observation loop, cassettes); the predictor (Witten-Bell Markov-2, baselines, evaluator, pre-fetch policy); the AGT-40 (40 cases) and INJ-20 (20 cases) fixtures and grading harness.
- **Server (SRV-01…SRV-20, OFF-03 server side, §12.6).** `server/`: one Fastify 5 process with configuration and production guards, graceful shutdown, `/api/healthz` and `/api/readyz`, metrics, pino logs with redaction, the token-bucket rate limiter, FsBlobStore, `vfsTxn` with the L0–L4 lock order and retries, the SQLSTATE → errno mapper, the auth gateway (login, logout, me, `su`, guest, password change with Argon2id) and the first-start seed; the remaining plugins answer `501 ENOSYS`.
- **Database (DB-01…DB-05).** `db/`: six expand-only dbmate migrations (17 tables) with down scripts, `schema.sql`, the acyclicity trigger, the fault-injection hook, the canonical tree checksum, integrity probes P1–P9, Q1–Q5 and Qb with the perf-index toggles, a deterministic 10k/100k seed and the migration round-trip script.
- **UI kit (WM-07, BOOT-13).** `ui/`: design tokens, motion, fonts, icons and accessible primitives, with a gallery; the Stitch designs for 24 screens in `docs/design/stitch/`.
- **Test harness (TST-\*).** `tests/`: 180 performance budgets with a validator and `check-budgets`, the Chrome-trace frame parser, the per-op sampler, the server-side fault-injection matrix, the shared oracle, integration, e2e, accessibility and visual scaffolding, the quarantine file.
- **Containers (OPS-01…OPS-06, OPS-09, §17.1).** `compose.yaml` with `compose.prod.yaml` and `compose.test.yaml` (three services, loopback-only publishing, generated database passwords), a three-target `Dockerfile` with digest-pinned bases and a placeholder shell until `web/` builds, and the `Caddyfile` with every security header and a build-time CSP.
- **Operations (OPS-08, OPS-12, OPS-14, OPS-15, DB-01).** `ops/deploy.sh` (digest-only deploy with pre-deploy backup, smoke test and automatic rollback), `ops/backup.sh`, `ops/restore.sh` and `ops/restore-drill.sh`; `ops/cloud-init.yaml` and `ops/provision.sh` (host provisioning: Docker, the `deploy` user, key-only SSH, firewall 22/80/443 tcp and 443 udp, BBR, unattended upgrades, backup timers); [`ops/RUNBOOK.md`](ops/RUNBOOK.md).
- **Release and deploy pipelines (OPS-04, OPS-05, OPS-07, OPS-08, OPS-10, PLT-ID-15, PLT-DEL-03).** [`release.yml`](.github/workflows/release.yml): tag verification, the test suite with coverage and JUnit, performance evidence, multi-arch `web`/`app`/`db` images pushed to GHCR by digest with SBOMs and provenance, a timed clean bring-up (≤ 240 s, no login, Docker Hub blocked), the GitHub Release with its artefacts, the pin PR and the approval-gated deploy. [`deploy.yml`](.github/workflows/deploy.yml): deploy or roll back a released tag over SSH after environment approval, then verify the digests and smoke-test `/api/readyz`.
- **Documents (PLT-DOC-01…PLT-DOC-13).** The root documents README, ARCHITECTURE, STACK_DECISION, DSA, DATABASE, AI, BOOT, TESTING and SECURITY written from the specs and the code, with pilot figures labelled for re-measurement.
- **System call `window.setCloseGuard` (WMD-12; C4).** Registered in `specs/01-architecture/syscall-abi.md` §4.4.4, `protocol/` and the kernel (120 calls); the Editor sets a guard while it has unsaved documents, and the shell asks "Discard unsaved changes?" before closing.
- **Lint rule `local/no-static-jsx-style` (UI-147).** Flags all-literal `style={{…}}` objects in `*.tsx` under `ui/`, `wm/`, `apps/` and `web/`, which the strict CSP would drop in the Docker build. Gallery pages and tests are excluded.
- **Terminal and coreutils.** `man` pages, working `find` and `du`, `bootlog --list` (UI-135), an Edit menu with keyboard copy, and the end-to-end test `tests/e2e/polish-terminal.spec.ts` (UI-131).

### Changed

- **Logo (identity).** The two-orbit "luminous atom" is replaced by the "Bohr P" on every surface: favicon, app icons, boot splash, login, menu bar and About ([decision record](docs/design/logo/DECISION.md)).
- **Fonts (D15).** UI text uses Inter 4 variable with the optical-size axis; code uses JetBrains Mono variable (revised 2026-09-30 from Geist Mono, whose `r` reads as `ɪ` at 12–14 px on 1x screens; UI-004). Both are self-hosted. [Decision record](docs/design/fonts/DECISION.md). `CLAUDE.md` standing decision 2 still names Geist Mono and awaits a team decision.
- **Development servers.** `vite preview` sends the same CSP as Caddy and `vite dev` sends it Report-Only; `pnpm dev` no longer shows an error overlay for the ONNX runtime files in `/ort/`.

### Fixed

- **Polish and stabilization (UI-001…UI-166), 2026-09-27 to 2026-09-30.** Of the 166 bugs in [BUGS.md](docs/design/bug-hunt/BUGS.md), 154 are fixed and independently verified on the Docker build with the real CSP, including both blockers: the login screen resetting itself every second (UI-001) and the Editor unable to save a file it had locked (UI-002). Also: sync is live through Caddy (UI-006), the Service Worker registers and an offline reload boots (UI-007), one build id on every tier (UI-008), the AI daemons no longer crash at start (UI-049), recovery-console actions work (UI-057, UI-058), 0 CSP violations from xterm and CodeMirror (UI-050, UI-051), window sizes, focus, snapping and session restore (UI-011, UI-017–UI-019, UI-034, UI-038), the Files header, path bar, shortcuts and menus (UI-009, UI-010, UI-014–UI-016), and contrast, accent colour and Task Manager fixes. 9 are still open and 3 could not be reproduced; the per-bug status and the open list are in the Status summary of [BUGS.md §2](docs/design/bug-hunt/BUGS.md#2-summary-priority-order), and the close-out report is `docs/design/polish/REPORT.md`.

## [0.1.0] - 2026-09-24

Untagged repository scaffold.

### Added

- pnpm 12 workspace with the packages `protocol`, `dsa`, `kernel`, `vfs`, `services`, `wm`, `apps`, `ai`, `server`, `db` and `web`; exact version catalog; TypeScript 7 type-check gate with the TypeScript 6 API for tooling (C14).
- ESLint 10 with typescript-eslint, eslint-plugin-solid and the local rules `no-yieldless-loop-in-generator`, `no-await-in-idb-builder`, `no-html-sinks` and `no-relative-import-outside-package`; package-boundary rules with failing fixtures (ARC-01); Prettier.
- Vitest 5 projects with v8 coverage and a coverage ratchet; Playwright on Chrome stable; the traceability matrix tool (C18).
- GitHub Actions CI with gitleaks (§18); CODEOWNERS; pull-request and issue templates; the root documents required by spec §15.2 as templates.
