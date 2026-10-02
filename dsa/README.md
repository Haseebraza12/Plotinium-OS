# @plotinium/dsa

Every mandatory data structure, written by the team from first principles (spec §10.2, C16). Each structure lives in its own module under `src/<structure>/` with its interface, a complete edge-case suite (empty structure, one element, duplicates, removal of the root or head, and the rest of spec §8), fast-check property tests and a micro-benchmark that demonstrates the claimed complexity from 10^3 to 10^5 entries.

| Field              | Value                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | each structure's owner (table below); R1 edits `DSA.md`                                                                                                                                                                                                  |
| Secondary reviewer | the named non-owner reviewer of each structure (spec §3.3), so the review independently checks it is written from first principles                                                                                                                       |
| Implements         | [specs/08-dsa/data-structures.md](../specs/08-dsa/data-structures.md)                                                                                                                                                                                    |
| Requirement IDs    | PROC-01, PROC-02, MEM-02, VFS-01, VFS-08, SYS-03, BOOT-03, BOOT-04, WM-01, WM-02, DSA-GEN-01…09, DSA-TREE-01…03, DSA-TRIE-01…03, DSA-HEAP-01…02, DSA-DAG-01…03, DSA-LRU-01…02, DSA-HASH-01, DSA-RING-01, DSA-BLOOM-01, DSA-ZORD-01                       |
| May import         | `@plotinium/protocol` **types only** (`import type`). Environment-agnostic: no DOM-only, worker-only or Node globals. Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins (ESLint-enforced).                               |
| Status             | Scaffold complete: all nine modules ship their normative interfaces with `IMPLEMENTED = false`, their gated edge-case and property suites, and their gated benchmarks. No structure is implemented yet; each owner implements theirs and flips the flag. |

## Structures

| #   | Folder            | Structure                                      | Owner | Reviewer | `true` at | Used by                                                  |
| --- | ----------------- | ---------------------------------------------- | ----- | -------- | --------- | -------------------------------------------------------- |
| S1  | `src/tree/`       | n-ary inode tree                               | R2    | R1       | v0.2.0    | VFS directory hierarchy (VFS-01)                         |
| S2  | `src/trie/`       | radix trie (namespaced: cmd, path, flag, hist) | R3    | R4       | v0.2.0    | terminal completion (SYS-03)                             |
| S3  | `src/heap/`       | binary min-heap with index map, top-k          | R1    | R3       | v0.2.0    | ready queue, timer heap, top-k, lease expiry (PROC-02)   |
| S4  | `src/dag/`        | DAG + Kahn levels + cycle path                 | R5    | R2       | v0.2.0    | boot order, app start-up dependencies (BOOT-03, BOOT-04) |
| S5  | `src/lru/`        | hash map + doubly linked list, pins            | R1    | R5       | v0.3.0    | LRU pager, inode cache, rate-limit keys (MEM-02)         |
| S6  | `src/hashtable/`  | open addressing, linear probing (distinction)  | R1    | R3       | v0.2.0    | process table, window registry (PROC-01, WM-01)          |
| S7  | `src/ringbuffer/` | ring buffers: generic, Float64, bytes          | R5    | R1       | v0.2.0    | klog, telemetry ring, frame meter, pipes                 |
| S8  | `src/bloom/`      | Bloom filter with double hashing               | R4    | R2       | v0.4.0    | content hashes in front of the vector index              |
| S9  | `src/zorder/`     | z-order list renumbered 1..n                   | R3    | R5       | v0.2.0    | window stacking (WM-02)                                  |

Each folder's `README.md` has the complexity table with the proving test and benchmark for every operation, the invariants, the steps to implement it and a pre-filled `DSA.md` entry. `src/index.ts` re-exports every structure, each flag as `<NAME>_IMPLEMENTED`, and `STRUCTURES` (id, owner, reviewer, flag, due tag) for `tools/dsa-status.ts`.

## Layout

| Path                                            | Contents                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/<structure>/index.ts`                      | interface, class signatures, `IMPLEMENTED`; importable as `@plotinium/dsa/<structure>`                                                                                                    |
| `src/_shared/`                                  | `errors.ts` (`DsaError`, `NotImplementedError`, `DsaStats`), `prng.ts` (mulberry32), `sampler.ts` (nearest-rank percentiles), `mem.ts` (bytes per entry; Node-only, benchmarks and tests) |
| `tests/<structure>.test.ts`                     | edge cases of spec §8, gated with `describe.runIf(IMPLEMENTED)`                                                                                                                           |
| `tests/<structure>.prop.test.ts`                | fast-check model-based or differential tests, gated the same way                                                                                                                          |
| `tests/scaffold.test.ts`                        | the C16 stub contract: every entry point of a pending module throws `TODO(<owner>)`; it turns itself off per module when the flag flips                                                   |
| `tests/shared.test.ts`, `tests/harness.test.ts` | the shared helpers and the benchmark harness (always run)                                                                                                                                 |
| `bench/<structure>.bench.ts`                    | Vitest 5 benchmarks at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2, gated the same way                                                                                     |
| `bench/harness.ts`                              | sizes, batching, §7.3 JSON-lines records, `measureCurve`                                                                                                                                  |

> **Layout note.** The spec's §3.4 and `docs/research/strategy/repo_layout.md` draw each module as `dsa/<structure>/{src,tests,bench}/`. This package uses `src/<structure>/` with package-level `tests/` and `bench/`, which is what `package.json` exports (`./*` → `./src/*/index.ts`). The tooling accepts either (the tsconfig, the Vitest project, coverage and the ESLint rules all match `dsa/**`); if the team moves to the spec's layout, update this README, the `exports` pattern and the spec together.

## The IMPLEMENTED contract (C16)

Each structure ships its interface, complete tests and benchmark with `export const IMPLEMENTED = false`; every method throws `NotImplementedError` (`TODO(<owner>): implement from first principles — see specs/08-dsa/data-structures.md`). Constructors do not throw, so a consumer can wire a structure in and gate its own tests on the flag. The owner's PR writes the implementation, flips the flag, passes every gated test, commits a benchmark run, fills the `DSA.md` entry and adds `dsa` to `GATED_PACKAGES` in `vitest.config.ts` (85% line coverage from then on). The flag is never set back.

The gated suites were checked against throwaway reference implementations kept outside the repository (and deleted), including deliberately broken ones, which the suites caught. They are therefore expected to pass unchanged against a correct implementation of the documented contract.

No npm package may stand in for these structures, and the pilot code under `docs/evidence/pilot` (AI-written) is never imported or copied (C16, spec §18).

## Commands

```sh
pnpm exec tsc -p dsa/tsconfig.json --noEmit           # type-check
pnpm exec vitest run --project dsa                     # unit and property tests (gated suites skip while pending)
pnpm exec vitest bench --project 'dsa (bench)'         # benchmarks at 10^3, 10^4, 10^5 (implemented structures only)
PLT_BENCH_SIZES=1000,10000 pnpm exec vitest bench --project 'dsa (bench)'   # pull-request sizes
PLT_BENCH_OUT=docs/evidence/dsa pnpm exec vitest bench --project 'dsa (bench)'  # append §7.3 records
PLT_PROP_RUNS=10000 pnpm exec vitest run --project dsa # nightly property runs; PLT_PROP_SEED / PLT_PROP_PATH replay a failure
```

Test titles MUST begin with the requirement ID, for example `PROC-02 decreasing a leaf's key to the minimum makes it the next pop` (C18).
