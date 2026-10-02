
# Repository layout: pnpm monorepo `plotinium/`

The spec (s15.1) asks for subsystem boundaries that are visible in the tree. Each top-level folder below is a pnpm workspace package, except `docs/`, `ops/`, `tools/` and `tests/`. Shared versions live in the `pnpm-workspace.yaml` catalog, and every version is pinned exactly.

```
plotinium/
├── package.json · pnpm-workspace.yaml (catalogs) · pnpm-lock.yaml · .npmrc (strict-peer, no hoist)
├── tsconfig.base.json            # strict; no baseUrl / node10 / es5 (removed in TS 7)
├── eslint.config.js · .prettierrc · vitest.config.ts (projects) · playwright.config.ts
├── compose.yaml · compose.prod.yaml · Caddyfile · Dockerfile (targets: web, app) · .env.example
├── README.md  ARCHITECTURE.md  STACK_DECISION.md  DSA.md  DATABASE.md  AI.md  BOOT.md
│   TESTING.md  SECURITY.md  AI_USAGE.md  TEAM_CONTRACT.md  CHANGELOG.md  THIRD_PARTY.md
│
├── protocol/            @plotinium/protocol   Valibot schemas: syscalls, errno, events, ws v1, oplog,
│                                               agent tools; ABI_VERSION. Pure: no DOM, no Node.
├── dsa/                 @plotinium/dsa        hand-written structures, each: src/ tests/ bench/
│   ├── heap/            binary min-heap + index map (ready queue, timers, top-k, lease expiry)
│   ├── trie/            struct-of-arrays radix trie (completion, SYS-03)
│   ├── tree/            n-ary inode tree helpers (VFS-01)
│   ├── dag/             DAG + Kahn levels + cycle path (boot)
│   ├── lru/             Map + typed-array doubly linked list (pager, inode cache, rate-limit keys)
│   ├── hashtable/       PidTable: open addressing, Fibonacci hash, backward-shift delete
│   ├── ringbuffer/      klog, telemetry ring, frame meter
│   ├── bloom/           content-hash Bloom filter (RAG, extra credit)
│   └── zorder/          z-order list with 1..n renumbering (WM)  [+ optional interval/ for hit-testing]
├── kernel/              @plotinium/kernel
│   ├── core/            proc/ (PCB, lifecycle, signals, job control) sched/ (heap, aging, bands)
│   │                    mm/ (accounting, pages, reclaim, swap tiers) ipc/ (dispatcher, caps, audit,
│   │                    events, pipes) hooks/ (no-op AI seams) klog/
│   ├── host/            worker.ts · main.ts (kernel-link router) · loopback.ts (Node tests)
│   ├── runtime/         executor.ts (slice loop, SAB control block, global shadowing, codec)
│   └── blkio/           blkio.worker.ts (OPFS SwapDevice) + idb-swap fallback
├── vfs/                 @plotinium/vfs
│   ├── path.ts · perm.ts    ISOMORPHIC (imported by the server too)
│   ├── tree/ quota/ ops/ (open, write, unlink, rename, cp, chmod, batch …) fsck.ts fault.ts
│   ├── store/           IndexedDB tx() builder, schema + client migrations, readonly helpers (idb)
│   ├── sync/            syncd client: WS protocol v1, outbox, HLC, replay, state machine
│   └── locks/           lockd client: leases, heartbeat, fences, local advisory locks
├── services/            @plotinium/services   manifests/*.json + svcmgr (DAG build, start/stop,
│                                               back-off, degraded state, bootlog, critical path)
├── wm/                  @plotinium/wm
│   ├── compositor/      framework-free: registry, focus, z, drag/resize, snap, rAF batch
│   ├── boot-ui/         framework-free, inlined: boot screen, boot menu, panic, recovery console
│   ├── shell/           Solid: desktop, taskbar, login, secure prompt, notifications
│   ├── tokens/          tokens.css (single source; seeded to /system/branding)
│   └── frame-meter/
├── apps/                built-in apps; each = view.tsx (Solid) + proc.ts (runs in an executor)
│   ├── terminal/        xterm TTY device + tty.ts (line discipline, job-control keys)
│   ├── shell/           lexer, parser, executor (pipes, redirs, ; && &, $VARS, history)
│   ├── coreutils/       ls cd pwd … grep; ps top kill …; free vmstat pmap; uname … man (+ man pages)
│   ├── files/ editor/ taskmgr/ settings/
│   └── demo/            burn, memhog (real programs used by the defence stress tests)
├── ai/                  @plotinium/ai
│   ├── embed/           ai.embed worker (Transformers.js/ORT, batch 1)
│   ├── indexer/         chunker (chunker-v1), indexer process, reconciliation
│   ├── search/          VecIndex segments, BM25, RRF, citations/snippets
│   ├── agent/           envelope, planner-client, validate, intent, dryrun, confirm, execute, undo
│   ├── predictor/       telemetry schema, Markov-2 (Witten-Bell), baselines, prefetch policy
│   └── eval/            rag/ agt40/ inj20/ pre/ cassettes/ bench/ reports/
├── server/              @plotinium/server   (Node 24, one process, Fastify plugins)
│   └── src/             app.ts main.ts gateway/(auth, sessions, su, guest) ratelimit.ts
│                        sync/(ws, engine, feed, snapshot) locks/(manager, sweeper) vfs/(tx.ts vfsTxn,
│                        lockPlan, ops set-based, fault harness) storage/(BlobStore, FsBlobStore, gc)
│                        swap/ index/(put, pull, search) llm/(gateway, anthropic, budget, cassette,
│                        pricing) obs/(metrics, healthz, readyz) db/(client, errors, types.gen.ts)
├── db/                  @plotinium/db
│   ├── migrations/      YYYYMMDDHHMMSS_name.sql, each with -- migrate:up / -- migrate:down (dbmate)
│   ├── schema.sql       committed dbmate dump (CI diffs it)
│   ├── seed/            seed.ts (mulberry32 seed 42; ≥50 users; 10k/100k inodes), demo.ts, vectors/
│   ├── bench/           q1..q5.ts, run.ts, perf-indexes.up/down.sql, reports/
│   └── probes/          integrity.sql (orphans, parentless, unreachable, nlink, quota drift, refcount)
├── web/                 @plotinium/web   Vite root: index.html (inlines boot-ui + tokens), main.ts,
│                        sw.ts (workbox-precaching/routing via vite-plugin-pwa injectManifest),
│                        vite.config.ts (headers, define: name/version/sha/date), public/ (icons,
│                        manifest.webmanifest, models/, ort/ — excluded from precache)
├── tests/
│   ├── e2e/             Playwright (channel 'chrome'): boot→login→terminal→file ops→reboot; offline
│   ├── integration/     cross-package: syscalls vs DB, concurrent clients, leases, replay
│   ├── fault-injection/ rm -r, cp -r, mv, batch rename, chmod/chown -R (client + server)
│   ├── property/        fast-check: VFS op sequences → fsck clean; heap; exactly-once
│   ├── performance/     budgets.json, frame/, boot/, k6/, client-storage/, transport/, ui-framework/
│   ├── a11y/            axe scans in both themes, keyboard-only flows
│   └── fixtures/        seeded trees, AGT-40/INJ-20, rag corpus, telemetry traces
├── docs/
│   ├── diagrams/        Mermaid C4 (context, containers, components), ERD, sequence diagrams
│   ├── adr/             post-freeze decision records (new record + instructor approval)
│   ├── evidence/        raw JSON/CSV per spike: kernel/ ui/ transport/ db/ client-storage/ rag/
│   │                    llm-eval/ deploy/ benchmarks-puter-daedalos/
│   ├── identity/        logo.svg, logo-mono.svg, wordmark.svg, favicon.svg, tokens.css copy, usage.md
│   ├── report/          Typst sources for the 20–30 page report (built in CI)
│   └── slides/          Typst slides
├── ops/                 deploy.sh, backup.sh, restore-drill.sh, sysctl.conf, uptime checks
├── tools/               eslint-rules/ (no-yieldless-loop-in-generator, no-await-in-idb-builder,
│                        no-html-sinks), bundle-budget.ts, check-budgets.ts, coverage-summary.ts,
│                        traceability.ts (req ID → issue → PR → test → evidence)
└── .github/             workflows/ci.yml nightly.yml release.yml · CODEOWNERS · PR/issue templates
```

## Spec layout mapping

| Spec (s15.1) | Here | Notes |
|---|---|---|
| `apps/` | `apps/` | The shell, coreutils and the defence demo programs are user space too |
| `kernel/` | `kernel/` | The syscall/IPC bridge lives here; its schemas live in `protocol/` |
| `vfs/` | `vfs/` | Includes the lock client and sync client, as the spec says |
| `wm/` | `wm/` | Compositor, taskbar, boot, login, desktop screens |
| `ai/` | `ai/` | Indexer, vector search, agent, predictor, `eval/` |
| `dsa/` | `dsa/` | Every structure has `tests/` and `bench/` |
| `services/` | `services/` | Manifests and the service manager |
| `server/` | `server/` | API, sync engine, lock manager, swap storage, LLM gateway |
| `db/` | `db/` | Up and down migrations, seeds, benchmark queries |
| `tests/` | `tests/` | Cross-package suites. Unit tests sit next to their package |
| `docs/` | `docs/` | Diagrams, decision records, identity kit |
| (extra) `protocol/`, `web/`, `ops/`, `tools/` | | Shared schemas, the Vite entry, operations scripts, CI scripts |

## Conventions

- **Test names start with the requirement ID**, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data`. `tools/traceability.ts` builds the requirement-to-test matrix for the report.
- **Coverage** uses `include` globs that list every source directory, with thresholds of 70% overall and 85% on `dsa/**`, `vfs/**` and `kernel/**`. `server/db/types.gen.ts`, generated code and `*.bench.ts` are excluded.
- **CODEOWNERS** assigns each top-level package its primary owner plus its secondary reviewer. See the role matrix.
- **VFS-02 seeding:** the VFS `/system/branding` and `/system/services` directories are created at first boot (mkfs) from `docs/identity` and `services/manifests`. `/bin` lists the coreutils programs. `/system/release` prints `NAME`, `VERSION`, `BUILD` and `TEAM`.
