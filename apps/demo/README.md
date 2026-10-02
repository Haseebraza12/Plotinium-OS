# apps/demo

Real programs for the defence stress tests and the Demo Day script ([testing-and-performance.md §3.16.5](../../specs/13-quality/testing-and-performance.md)). Each is a `Program` (`init(argv)` → serialisable state, `*run(ctx, st)`) that reaches the OS only through `ctx.sys` system calls from `@plotinium/kernel/sys` (SYS-01), yields at every step, and has a man page in `man/` whose JSON front matter is the only source of its flags (SHL-12, same format as `apps/coreutils/man`).

| Program    | Demo Day item / test                                                        | Requirement IDs           | Owner |
| ---------- | --------------------------------------------------------------------------- | ------------------------- | ----- |
| `burn`     | 4 "CPU load + drag" (`burn --ms 120000 &` ×3); PROC-04 starvation test      | PROC-03, PROC-04, PROC-05 | R1    |
| `memhog`   | 5 "2× memory" (`memhog --total 512M --procs 8`); MEM-06 nightly test        | MEM-03, MEM-06, MEM-07    | R1    |
| `mktree`   | 6 fault-injected `rm -r ~/fixtures/tree1000` (builds the fixture)           | DB-02, VFS-07             | R2    |
| `lockdemo` | 7 two users contend for `/home/shared/plan.md`                              | VFS-09, PROC-07           | R2    |
| `idx50k`   | RAG-02 freshness: a 50 KB file, optionally timed until `semsearch` finds it | RAG-02, RAG-06            | R4    |

- **Primary owner:** R1 Kernel (folder); per-program owners above (man front matter `owner`)
- **Secondary reviewer:** R5 QA/DevOps
- **Spec:** [processes-and-scheduling.md §3.18.10](../../specs/03-kernel/processes-and-scheduling.md), [memory-and-paging.md §3.17.5](../../specs/03-kernel/memory-and-paging.md), [testing-and-performance.md §3.6.6, §3.16](../../specs/13-quality/testing-and-performance.md)

## Layout

| Path                 | Contents                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `index.ts`           | `DEMO_PROGRAMS` (name → program), `demoProgram(name)`, `DEMO_MANIFESTS` (the `/bin/<name>.json` manifests)  |
| `cmd/<name>.ts`      | one program per command, with its pure parsing and formatting helpers exported for tests                    |
| `lib/cli.ts`         | `defineDemo`: option parsing in `init`, usage (status 2), `--help`, caught signals into `st.caught`, output |
| `lib/pattern.ts`     | mulberry32 (as `tests/fixtures/rng.ts`), memhog's deterministic page fill and 64-bit page checksum          |
| `lib/pages.ts`       | memhog's page backends: `ctx.mem` (the design) or `mem.alloc` segments (fallback until `ctx.mem` lands)     |
| `lib/tree.ts`        | the `tree1000` fixture generator, identical to `tests/fixtures/trees.ts` (pinned by golden values in tests) |
| `lib/prose.ts`       | idx50k's seeded Markdown text of an exact size, with a unique marker word                                   |
| `lib/argspec.gen.ts` | GENERATED from the man front matter by `scripts/gen-argspec.mjs`                                            |
| `man/<name>.md`      | man pages (front matter + NAME … SEE ALSO)                                                                  |
| `tests/fakesys.ts`   | a multi-process fake kernel: round robin, virtual clock, signals, spawn/wait, a budgeted pager with LRU     |
| `tests/*.test.ts`    | per-program tests; titles begin with the requirement ID                                                     |

## How the programs meet their requirements

- **burn** computes in steps of `--step-us` (default 100 µs, STEP_MAX_US 500) and does `yield ctx.tick` between steps; its state is `{remainingMs, iterations, cpuMs, maxStepUs}`, so it continues after a page-out or migration. `-t T` spawns T single-thread burns; `--exclusive` asks `spawn` for exclusive executors and falls back with a warning when refused.
- **memhog** children allocate 256 KiB pages one at a time, so every byte is reserved before it exists and a child waits on `mem` instead of pushing accounted memory over the budget (MEM-06). Page bytes are a pure function of (seed, child, page, generation); the checksum of each page lives in the child's small state, so every read touch proves a paged-in page byte-identical, and a restored child re-verifies all its pages (MEM-03). A changed page makes the child exit 3 and the parent exit 3.
- **mktree** creates the fixture with one `mkdir` per directory and one `writeFile` per file; with the defaults it is node-for-node the `tree1000` the server seed and the fault-injection oracle use.
- **lockdemo** holds a lease until `--hold` or a signal and releases it with `lock.release`; with `--wait` it shows the holder and reports how long it waited.
- **idx50k** writes the file in one `writeFile`; with `--wait` it polls `ai.semsearch` once a second until the result list contains the file's inode and prints the time against the 30 s budget.

## Commands

```sh
node apps/demo/scripts/gen-argspec.mjs            # after editing a man page's front matter (--check verifies)
pnpm exec vitest run --project apps apps/demo
pnpm exec eslint apps/demo --max-warnings 0
pnpm exec tsc -p apps/tsconfig.json --noEmit
```
