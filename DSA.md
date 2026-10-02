# Data structures

**Status:** 2026-09-26. All nine structures in `dsa/` are implemented: `IMPLEMENTED = true` in every module since 2026-09-25, and their complete edge-case and property suites pass (184 tests, none failing; the 9 scaffold-contract tests skip themselves because every flag is `true`). The implementations were written by Claude Code, not by their owners: see "Authorship" below and [AI_USAGE.md §5](AI_USAGE.md). **Every benchmark and memory figure in this document is a dev-machine figure** that must be re-run on the lab machine before it is cited at a gate (see "Dev-machine figures"). Editor: R1 Kernel. Reviewer: R5.
**Built from (normative):** [specs/08-dsa/data-structures.md](specs/08-dsa/data-structures.md). If this document and the spec disagree, the spec wins. Each entry below is compiled from the filled `DSA.md` entry in its structure's README (`dsa/src/<structure>/README.md`), which holds the long form: derivations, every benchmark run and the implementation notes.

**Spec §10.2 (MUST):** "The tree, trie, heap, DAG with topological sort, and LRU list must be written by your team from first principles. Importing a package that provides one of them … scores zero for that item." Each structure lives in its own module under `dsa/`, with unit tests for the edge cases (empty, one element, duplicates, removal of the root or head) and a micro-benchmark that demonstrates its claimed complexity. This document maps every structure to its file, operations, complexity, proving tests and benchmark (spec §15.2). DSA is 20% of the mark: "whether you used the right structure, implemented it correctly, and can prove its complexity" (§10).

## Authorship and the first-principles rule (C16)

- **Who wrote the implementations.** On 2026-09-25 the session operator chose to have Claude Code write the nine structures, over the alternative it recommended (labelled temporary stand-ins, with the graded modules left to the owners). [AI_USAGE.md §5](AI_USAGE.md) records the question, the answer and the risk, and asks every member to confirm or reject the decision. Spec §10.2 requires the five mandatory structures to be "written by your team from first principles", so the five mandatory items, the hash table's distinction credit and the other extra credit are **at risk** until the instructor rules (AI_USAGE.md §5.2–§5.3). If the ruling is no, each owner rewrites their structure from an empty file, with the existing tests and benchmarks as the acceptance check. Until then each entry's "Written by" row names Claude Code, and each owner completes the AI_USAGE.md §5.4 review checklist, studies the code and must be able to explain every line in the viva.
- **No external code.** `dsa/src/` imports only relative modules and type-only imports from `@plotinium/protocol`; ESLint fails the build otherwise, with fixtures that must fail (`dsa-source-uses-process`, `dsa-test-imports-npm-structure`, `dsa-value-import-from-protocol`). No npm package and no pilot code stands in for any structure.
- **The `IMPLEMENTED` flag.** Every module started as `export const IMPLEMENTED = false` with an interface whose methods threw `NotImplementedError`, and its suites ran under `describe.runIf(IMPLEMENTED)` (reported as skipped, never as passing). All nine flags are now `true` and are never set back; `dsa/tests/scaffold.test.ts` turns its stub checks off per module as each flag flips. `dsa` is in `GATED_PACKAGES` in `vitest.config.ts`, so the whole package is held to 85% line coverage.
- **Tests and code share an author.** The interfaces, tests and benchmarks were drafted by Claude Code from the spec before the implementations, and were checked against throwaway reference implementations, including deliberately broken ones. Tests and code therefore come from the same assistant (AI_USAGE.md limitation L5); the owners' deliberate-bug checks in AI_USAGE.md §5.4 are the independent test of the tests.
- **Pilot code is evidence, not source.** The AI-written pilot structures under `docs/evidence/pilot/` are never imported or copied, and are excluded from build, lint and coverage. Their numbers appear here only with the label _(pilot figure — re-measure on the lab machine)_.

## Dev-machine figures (read before citing a number)

Every benchmark, memory and false-positive figure below comes from **one developer laptop**, not from the lab machine: an AMD Ryzen 5 7530U (6 cores/12 threads, 16 MiB L3), Linux 7.0, Node 24.13.1 (V8 13.6), `runner: dev`, seed 42, on 2026-09-25 and 2026-09-26, while 20–25 other build agents were running tests and benchmarks on the same machine (load average 4–20). Absolute times are therefore pessimistic and noisy, and some full-size shape assertions (S1 walk, S4 build at 10^5, S5 put+evict) failed on some runs for reasons the entries analyse. **None of these numbers may be cited at a gate until they are re-run on the lab machine** and committed as JSON lines under `docs/evidence/dsa/<structure>/` (spec §7.1, §7.3):

```sh
NODE_OPTIONS=--expose-gc PLT_BENCH_RUNNER=lab PLT_BENCH_OUT=docs/evidence/dsa \
  pnpm exec vitest bench --run --project 'dsa (bench)'
```

`docs/evidence/dsa/` and `tools/dsa-report.ts`, which regenerates the tables between the `dsa-report` markers from those runs, do not exist yet (TODO(R1)); until they do, the tables between the markers hold the dev-machine figures where an entry recorded them.

## Overview

| #   | Structure                                   | Location                                             | Used for (spec §10.1)                                    | Operations and complexity                                                                      | Proving tests (all passing)                              | Benchmark                 | Line coverage | Owner / reviewer | Due at tag   | Status                                                                               |
| --- | ------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------- | ------------- | ---------------- | ------------ | ------------------------------------------------------------------------------------ |
| S1  | n-ary tree                                  | [`dsa/src/tree/`](dsa/src/tree/index.ts)             | VFS hierarchy (VFS-01)                                   | lookup, attach, detach O(1) avg; resolve O(d); move O(1) + O(depth) ancestor check; walk O(k)  | `dsa/tests/tree.test.ts` (27), `tree.prop.test.ts` (3)   | `dsa/bench/tree.bench.ts` | 98.8%         | R2 / R1          | v0.2.0 (W5)  | `IMPLEMENTED = true`; AI-written (AI_USAGE.md §5); dev-machine benchmark             |
| S2  | radix trie, struct-of-arrays, 4 namespaces  | [`dsa/src/trie/`](dsa/src/trie/index.ts)             | completion of commands, paths, flags, history (SYS-03)   | insert, remove, has O(L); complete O(P + k); removePrefix O(P + m)                             | `trie.test.ts` (24), `trie.prop.test.ts` (2)             | `trie.bench.ts`           | 95.6–96.4%    | R3 / R4          | v0.2.0 (W5)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S3  | binary min-heap + index map                 | [`dsa/src/heap/`](dsa/src/heap/index.ts)             | scheduler ready queue, timers, top-k (PROC-02)           | push, pop, changePriority, remove, replaceTop O(log n); peek O(1)                              | `heap.test.ts` (20), `heap.prop.test.ts` (3)             | `heap.bench.ts`           | 95.4%         | R1 / R3          | v0.2.0 (W3)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S4  | DAG + Kahn's sort                           | [`dsa/src/dag/`](dsa/src/dag/index.ts)               | boot order, app start-up dependencies (BOOT-03, BOOT-04) | build + Kahn + levels O(V + E); cycle path O(V + E); cursor step O(outdeg); ancestors O(V + E) | `dag.test.ts` (17), `dag.prop.test.ts` (3)               | `dag.bench.ts`            | 97.5%         | R5 / R2          | v0.2.0 (W3)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark (10^5 shape fails there)     |
| S5  | LRU: `Map` + typed-array doubly linked list | [`dsa/src/lru/`](dsa/src/lru/index.ts)               | pager, inode cache, rate-limit keys (MEM-02)             | get, put, putAtLru, touch, moveToLru, evict, delete, pin, unpin O(1)                           | `lru.test.ts` (18), `lru.prop.test.ts` (1)               | `lru.bench.ts`            | 99.1%         | R1 / R5          | v0.3.0 (W10) | `IMPLEMENTED = true`; AI-written; dev-machine benchmark (put+evict shape borderline) |
| S6  | hash table (open addressing) — extra credit | [`dsa/src/hashtable/`](dsa/src/hashtable/index.ts)   | process table, window registry (PROC-01, WM-01)          | get, set, delete O(1) expected at α ≤ ½; set amortised                                         | `hashtable.test.ts` (17), `hashtable.prop.test.ts` (2)   | `hashtable.bench.ts`      | 97.0%         | R1 / R3          | v0.2.0 (W6)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S7  | ring buffer — extra credit                  | [`dsa/src/ringbuffer/`](dsa/src/ringbuffer/index.ts) | klog, telemetry, frame meter, pipes                      | push, shift, at, peek O(1); byte copies O(bytes)                                               | `ringbuffer.test.ts` (14), `ringbuffer.prop.test.ts` (2) | `ringbuffer.bench.ts`     | 93.9%         | R5 / R1          | v0.2.0 (W5)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S8  | Bloom filter — extra credit                 | [`dsa/src/bloom/`](dsa/src/bloom/index.ts)           | content hashes in front of the vector index              | add, mayContain O(k) = O(1); rebuild O(m/32)                                                   | `bloom.test.ts` (7), `bloom.prop.test.ts` (2)            | `bloom.bench.ts`          | 94.7%         | R4 / R2          | v0.4.0 (W10) | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S9  | z-order list — extra credit                 | [`dsa/src/zorder/`](dsa/src/zorder/index.ts)         | window stacking with 1..n renumbering (WM-02)            | insertTop, zOf O(1); raise, lower, remove O(1) relink + O(n − p) renumber                      | `zorder.test.ts` (9), `zorder.prop.test.ts` (1)          | `zorder.bench.ts`         | 96.4%         | R3 / R5          | v0.2.0 (W5)  | `IMPLEMENTED = true`; AI-written; dev-machine benchmark                              |
| S10 | interval tree (MAY)                         | `dsa/src/interval/`                                  | window hit-testing                                       | build O(n log n); stab, overlap O(log n + m)                                                   | –                                                        | –                         | –             | R3 / R1          | not gated    | not started; ships only if its benchmark beats a linear scan                         |
| S11 | B-tree and hash indexes                     | PostgreSQL (not in `dsa/`)                           | database metadata (§11.4)                                | point lookup and range scan O(log n)                                                           | DB-05 benchmark                                          | Q1–Q5 before/after        | –             | R2 / R5          | –            | the index list is in [DATABASE.md §6](DATABASE.md#6-indexes-and-benchmarks)          |
| S12 | registries on built-in `Map`/`Set`          | in their subsystems                                  | open files, fds, page tables, dentries                   | O(1) average                                                                                   | owning subsystems' tests                                 | –                         | –             | each owner       | –            | documented below                                                                     |

Test counts are the `it` cases in each file on 2026-09-26. Line coverage is per structure folder from three `pnpm test:coverage` runs on the dev machine on 2026-09-26 (the package total is 96.7–96.9% of lines, against the 85% gate); the `dsa/src/_shared/` helpers are at 100%. The property tests draw a fresh seed per run, so a folder whose rare branches only a property reaches can move by about a point between runs (the trie: 95.6–96.4%). Shared team helpers live in [`dsa/src/_shared/`](dsa/src/_shared/) (errors, the `mulberry32` PRNG, the per-op sampler, bytes-per-entry measurement). The spec's gate check (a release fails if a structure due at that gate is still `IMPLEMENTED = false`, via `tools/dsa-status.ts`) is not wired into `release.yml` yet (TODO(R5)); today all nine flags are `true`.

**Conventions for every module** (spec §3.4): pure and isomorphic (no DOM and no Node API in `src/`), so the kernel, the main thread and the server share one implementation; integer handles and struct-of-arrays typed arrays on hot paths; no recursion whose depth depends on input (explicit stacks, so depth 10^4 works); deterministic iteration order; `undefined`/`false` for "absent" and a `DsaError` with a code for contract violations (the kernel maps codes to errnos at the syscall boundary); `checkInvariants()` called after every operation by the property tests; `stats()` for memory accounting.

## Benchmark method (every structure)

- **Harness:** [`dsa/bench/harness.ts`](dsa/bench/harness.ts) on Vitest 5 bench (the `dsa (bench)` project), Node 24 with `--expose-gc`, plus the team's own sampler for percentiles (Vitest reports no p95). Operations far below the timer resolution are timed in batches of 1,000; p95 over ≥ 1,000 batches after 200 discarded warm-up batches.
- **Sizes:** n = 10^3, 10^4, 10^5 (plus n = 256 for the heap); n = 10, 10^2, 10^3 for the z-order list. Workloads are seeded with `mulberry32(42)`.
- **Baselines for contrast:** linear-scan completion for the trie, a sorted array for the heap, an `indexOf` + `splice` array for the LRU, `Map` for the hash table, a linear scan for the interval tree.
- **Output:** JSON lines in `docs/evidence/dsa/<structure>/<date>-<runner>.jsonl` (ns/op p50/p95/p99, bytes per entry measured and allocated, the shape ratio and the budget), rendered into the "Benchmark (generated)" tables below by `tools/dsa-report.ts` (not yet written). Run with `pnpm exec vitest bench --run --project 'dsa (bench)'`; `PLT_BENCH_SIZES=1000,10000` for the pull-request sizes, `PLT_BENCH_OUT=docs/evidence/dsa` to record, `PLT_BENCH_RUNNER=lab` on the lab machine.
- **Shape assertions** (run on every PR at 10^3 and 10^4, nightly at all sizes) compare time per operation at the largest and smallest n; **absolute budgets** run nightly on the lab-spec runner. Two limits fail on any runner: trie completion p95 ≤ 1 ms at 10^4 and 10^5, and ≤ 32 MB at 10^5 per trie namespace.
- **Property tests:** fast-check with 1,000 runs per property on pull requests and 10,000 nightly (`PLT_PROP_RUNS=10000`); a failure prints its seed and path, which `PLT_PROP_SEED` and `PLT_PROP_PATH` replay. The root `vitest.config.ts` gives the `dsa` project a timeout proportional to the run count (30 ms per run, at least 60 s), because the slowest properties took 4–6 s at 1,000 runs with the dsa project in parallel, 6–14.4 s inside a full `pnpm test` run and 7.8–16.1 s inside a full `pnpm test:coverage` run on the shared dev machine (lru 16.1 s, 2026-09-26), past Vitest's 5 s default. `dsa/tests/helpers.ts` exports the same value as `PROP_TIMEOUT_MS`; a suite that sets its own per-test timeout replaces the project's, so it must pass that value (tree.prop and lru.prop still pass lower local ones: 20 s and 30 s at 1,000 runs).

TODO(team): replace every dev-machine and _(pilot figure)_ number with the lab measurements before the P2 gate.

---

## S1 N-ary tree

| Field                      | Value                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/tree/index.ts` (`NaryTree<P>`, `createTree`; one file)                                                                                                                                       |
| Owner / non-owner reviewer | R2 VFS/DB / R1 Kernel                                                                                                                                                                                 |
| Mandatory location (§10.1) | The VFS directory hierarchy (Spec §9.3, §10.1 tree row): an n-ary tree of inodes whose directories map names to children.                                                                             |
| Used by                    | vfs/tree; vfs/path.ts; vfs/ops (mv, rm -r, cp -r walks); vfs/fsck.ts; kernel/src/core/fs/kfs.ts                                                                                                       |
| Written by                 | Claude (AI assistant) on 2026-09-25 under the team decision that Claude writes the dsa/ structures; first principles (no package, no pilot code, no other dsa/ structure); studied and defended by R2 |
| AI assistance              | Interface, tests and benchmark drafted with AI from the spec (C16); implementation written by Claude; see the AI_USAGE.md entry of 2026-09-25                                                         |

### Operations and complexity

| Operation                   | Complexity                                               | Proof sketch (one line)                                                                  | Proving test                                                    | Proving benchmark                        |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| lookup                      | O(1) average                                             | one `Map.get` on the directory's children                                                | `DSA-TREE-01 attach then lookup returns the node …`             | –                                        |
| attach, detach              | O(1) average (detach of a loaded subtree O(1) amortised) | a constant number of Map operations plus one registry update; no path or depth is stored | `DSA-TREE-01 attaching an existing name throws DUPLICATE …`     | `tree.bench.ts` attach+detach            |
| resolve (d components)      | O(d)                                                     | d lookups                                                                                | `VFS-08 a 32-level chain resolves, walks and computes depth 32` | `tree.bench.ts` resolve at depth 32 vs n |
| isAncestor, depthOf, pathOf | O(depth)                                                 | follows `parent` to the root                                                             | `DSA-TREE-03 a 10,000-level chain walks and checks ancestry …`  | –                                        |
| move                        | O(1) + O(depth(dst))                                     | the ancestor check plus one re-link; no descendant is touched                            | `DSA-TREE-02 after moving a subtree of 10^5 nodes …`            | `tree.bench.ts` move vs subtree size     |
| walk (k loaded nodes)       | O(k)                                                     | explicit stack: every node pushed and popped once                                        | `DSA-TREE-01 walk pre-order and post-order …`                   | `tree.bench.ts` walk per node            |
| setLoaded / unload          | O(k) / O(1) amortised                                    | install k entries / drop the map (each dropped entry was paid for by its setLoaded)      | `VFS-01 resolve returns NOT_LOADED …`                           | –                                        |

### Why this structure

A materialised-path map makes `mv` O(subtree); nested sets make it O(n); a closure table makes it O(subtree × depth). The n-ary tree re-parents one node (DSA-TREE-02).

### Memory layout

One VFS-owned object per loaded node (`{id, payload}` for files, plus `parent`, `name` and a `children` Map for directories), one children-Map entry per link, and one registry entry (node → live links, with lazily deleted tombstones, at most 2 · size entries). Estimated 48 B per node of tree bookkeeping (`stats()`); measured 185–215 B per loaded node including the node objects and strings (dev run, to be replaced by the lab run).

### Invariants

1. T1 `root.parent === null` and `root.name === ''`
2. T2 every directory child's `parent` and `name` match its map entry
3. T3 every non-root directory is in exactly one parent's map
4. T4 parent chains reach the root within `size` steps
5. T5 every key is a valid name (1–255 UTF-8 bytes, no `/`, no U+0000, not `.` or `..`)
6. T6 `size` equals the number of distinct loaded nodes (and the registry holds exactly their link counts)

### Tests

`dsa/tests/tree.test.ts` (27 edge cases: the 20 of spec §8.2 plus subtree detach and graft, attach refusals, cyclic or overlapping grafts, move errors, unload with hard links, setLoaded atomicity, invariant ids), `dsa/tests/tree.prop.test.ts` (3 properties: path-set model with checkInvariants after every step, ancestor-under-descendant moves always refused, name validation against TextEncoder). fast-check prints the seed and path of any failure; replay with PLT_PROP_SEED and PLT_PROP_PATH; 1,000 runs on PRs, 10,000 nightly.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/tree/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:tree:start -->

| op                       | n           | p50 ns    | p95 ns    | mean ns   | bytes/entry (measured / allocated) | shape ratio (limit)                 |
| ------------------------ | ----------- | --------- | --------- | --------- | ---------------------------------- | ----------------------------------- |
| resolve depth 32         | 10^3 / 10^5 | 393 / 432 | 435 / 584 | 399 / 448 | –                                  | 1.12 (2)                            |
| attach+detach            | 10^3 / 10^5 | 136 / 197 | 166 / 240 | 138 / 220 | –                                  | 1.60 (2)                            |
| walk per node            | 10^3 / 10^5 | 68 / 187  | 103 / 221 | 75 / 187  | –                                  | 2.48 (2), dev laptop; PR sizes 1.33 |
| move (subtree 10 / 10^5) | –           | 155 / 140 | 245 / 155 | 173 / 150 | –                                  | 0.87 (2)                            |
| memory                   | 10^5        | –         | –         | –         | 204 / 48                           | –                                   |

<!-- dsa-report:tree:end -->

_Chart: `docs/evidence/dsa/tree/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

Re-creating one name repeatedly in a directory of m entries costs up to O(m) between V8 Map rehashes (built-in Map required by §10.2); the registry avoids the same effect with tombstones. A detach + attach rename in `VfsTree.apply` re-counts a loaded subtree (O(k)); `tree.move` is O(1) + O(depth). The walk is O(k) but memory-latency bound beyond the L3 cache. Resolution is O(depth), bounded by the 4,096-byte path limit; if a resolve budget is missed, the VFS adds a dentry cache in front of the tree, never a path-keyed structure.

Full notes, derivations and every run: [`dsa/src/tree/README.md`](dsa/src/tree/README.md).

## S2 Radix trie (struct of arrays, namespaced)

| Field                      | Value                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/trie/index.ts` (+ `radix-trie.ts`, `namespaced.ts`)                                                                                                                                                            |
| Owner / non-owner reviewer | R3 Shell/WM / R4 AI                                                                                                                                                                                                     |
| Mandatory location (§10.1) | Terminal autocomplete over commands, paths, flags and history (Spec §9.6, §10.1 trie row; SYS-03: p95 ≤ 1 ms over ≥ 10,000 entries, updated incrementally).                                                             |
| Used by                    | the `complete` process (executor, priority 36); apps/shell completion client; `man -k`                                                                                                                                  |
| Written by                 | Claude (AI), by team decision of 2026-09-25, written from first principles with no package and no pilot code; studied and defended by R3; implementing PR #…                                                            |
| AI assistance              | Claude wrote the implementation (`radix-trie.ts`, `namespaced.ts`) against the AI-drafted interface, tests and benchmark; see the AI_USAGE.md entry of 2026-09-25. R3 reviews it and records what they changed and why. |

### Operations and complexity

| Operation           | Complexity                          | Proof sketch (one line)                                                                                                                  | Proving test                                                      | Proving benchmark                                       |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| insert              | O(L)                                | code-unit comparisons along labels; a split is O(1) node work and reuses the pool range                                                  | `DSA-TRIE-01 inserting keys that diverge at every offset …`       | `trie.bench.ts` insert+remove                           |
| remove              | O(L)                                | descend with the path recorded; the unlink (previous sibling known) and the merge are O(1) node work                                     | `DSA-TRIE-01 removing the shorter of two keys merges nodes …`     | `trie.bench.ts` insert+remove                           |
| has                 | O(L)                                | one descent                                                                                                                              | `DSA-TRIE-01 one key completes for every prefix …`                | –                                                       |
| complete(prefix, k) | O(P + k)                            | O(σ·P + k + D) node visits: the DFS region before the k-th key has ≤ 2k − 1 branching nodes plus one frontier path; nothing depends on n | `DSA-TRIE-01 a prefix ending inside an edge label …`              | `trie.bench.ts` complete p95 vs n, linear-scan baseline |
| removePrefix        | O(P + m)                            | locus, then an iterative free of the m nodes below                                                                                       | `DSA-TRIE-01 removePrefix of an absent prefix …`                  | –                                                       |
| compact             | O(live label units), amortised O(1) | runs only after ≥ poolLen/2 garbage units, each created by an earlier O(L) operation                                                     | `DSA-TRIE-01 removing the only key … compaction empties the pool` | `trie.bench.ts` memory                                  |

### Why this structure

The pilot's one-character, Map-per-node trie needed 492.7 MB at 10^5 path entries (pilot figure — re-measure on the lab machine). Radix compression bounds nodes at 2n (measured 1.16–1.65 per key); struct-of-arrays removes per-node objects. Per-directory `path:` keys make a directory rename one remove plus one insert.

### Memory layout

Seven parallel typed arrays per namespace instance: `lblStart` Int32, `lblLen` Uint16, `first` Uint16, `child` Int32, `next` Int32, `term` Uint8, `meta` Int32 = 21 B/node, plus a shared `pool: Uint16Array` of labels (2 B/unit) and a `metas` side table for kind/detail. Estimated: ≤ 2n nodes × 21 B + Σ label units × 2 B. Measured on a dev machine at 10^5 (lab re-run pending): `path` 48.5 B/entry allocated (4.6 MB), 74.7 B/entry with `{ kind }` metadata (7.1 MB); `cmd` 38.0; `flag` 76.0; `hist` 65.5; ≤ 7.3 MB per namespace against the 32 MB limit.

### Invariants

1. R1 every non-root node is terminal or has ≥ 2 children (a long-label chain link that cannot merge, lblLen[n] + lblLen[child] > 65,535, is exempt; it needs keys longer than 65,535 units)
2. R2 every non-root node has `lblLen ≥ 1` and `first[n] === pool[lblStart[n]]`
3. R3 siblings have strictly increasing `first`
4. R4 every leaf is terminal
5. R5 `size` equals the number of terminal nodes
6. R6 the spelled key set equals the inserted keys (checked by the property test)
7. R7 free-list nodes are unreachable; reachable + free = allocated
8. R8 `poolLen − poolGarbage` equals the sum of reachable label lengths

### Tests

`dsa/tests/trie.test.ts` has 24 edge-case tests: empty trie; empty-string key; one key; duplicate insert and meta replacement; a key that is a prefix of another; merge on remove; splits at every offset; removing the only key, then compaction; removing the root's first child; a prefix ending inside a label; limit 0 and a large limit; a RANGE limit; code-unit order; surrogates and combining marks; a 4,136-unit key; growth to 2^17 keys from capacity 1; churn with node reuse; removePrefix; the four namespaces; the directory rename as exactly one remove plus one insert; `history -c`; and the corruption detection. `dsa/tests/trie.prop.test.ts` holds 2 fast-check properties: a model-based differential against a Set, with checkInvariants after every operation, and "remove all → root only". They run 1,000 times on PRs and 10,000 nightly, with the seed printed on failure and replayable via `PLT_PROP_SEED`/`PLT_PROP_PATH`.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/trie/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:trie:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:trie:end -->

Dev-machine results (from `dsa/src/trie/README.md`, seed 42; each query a 1–10 unit prefix of a key, 10% misses, at most 20 completions), ns per operation:

| `complete(prefix, 20)` | n = 10^3 mean / p95 | n = 10^4 mean / p95 | n = 10^5 mean / p95 | SYS-03 (p95 ≤ 1 ms)         |
| ---------------------- | ------------------- | ------------------- | ------------------- | --------------------------- |
| `path`                 | 1,594 / 3,947       | 2,680 / 6,302       | 3,915 / 7,765       | pass (128× under the limit) |
| `cmd`                  | 758 / 3,186         | 1,259 / 4,187       | 1,737 / 4,909       | pass                        |
| `flag`                 | 2,074 / 6,522       | 2,215 / 5,491       | 3,427 / 8,305       | pass                        |
| `hist`                 | 2,136 / 4,899       | 2,733 / 5,370       | 3,882 / 7,163       | pass                        |

Shape against the linear-scan baseline (`path`): the trie's p95 grows 1.31× (limit 3) from 10^3 to 10^5 while the baseline (`filter(startsWith).sort().slice(0, 20)`) grows 88×; at 10^5 the trie is about 5,500× faster at p95. Across 7 runs on the shared machine the `path` p95 ratio ranged 0.99–1.42, with one outlier of 3.30 during a load spike. insert + remove: 584 → 637 → 850 ns per pair (ratio 1.46, limit 3). Memory at 10^5: `path` 4.6 MB (7.1 MB with `{ kind }` metadata), `cmd` 3.6 MB, `flag` 7.3 MB, `hist` 6.3 MB, all under the 32 MB per-namespace limit.

_Chart: `docs/evidence/dsa/trie/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

The sibling scan is O(σ) per level. On a CJK-heavy corpus, σ could reach thousands. If the S2 benchmark on such a corpus misses its budget, child lookup moves to an S6 table keyed by `(node, codeUnit)` (about 24 B per edge), as spec §3.5 keeps in reserve. Labels longer than 65,535 units become chains (R1 exemption). Arrays never shrink implicitly; the pool shrinks only on compaction.

Full notes, derivations and every run: [`dsa/src/trie/README.md`](dsa/src/trie/README.md).

## S3 Binary min-heap with index map

| Field                      | Value                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module                     | `dsa/src/heap/index.ts` (+ `binary-heap.ts`, `priority-queue.ts`, `bounded-top-k.ts`)                                                                                                                                                      |
| Owner / non-owner reviewer | R1 Kernel / R3 Shell/WM                                                                                                                                                                                                                    |
| Mandatory location (§10.1) | The scheduler ready queue (Spec §9.1, §10.1 heap row; PROC-02), keyed by `effPrio · 2^32 + seq`.                                                                                                                                           |
| Used by                    | kernel/core/sched (ready heap, timer heap); ai/search (bounded top-k); ai/indexer (work queue); server/locks (lease expiry)                                                                                                                |
| Written by                 | Implementation written by Claude (AI assistant) on 2026-09-25 under the team decision of that date, from the spec alone (no package, no pilot code). The R1 owner (name to fill) studied it and defends it in the viva; implementing PR #… |
| AI assistance              | Interface, tests and benchmark drafted with AI from the spec; implementation written by AI on 2026-09-25 (team decision). The owner records what they reviewed, changed or rejected. See the AI_USAGE.md entry of 2026-09-25               |

### Operations and complexity

| Operation                           | Complexity            | Proof sketch (one line)                                                  | Proving test                                                                     | Proving benchmark                   |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------- |
| push, pop                           | O(log n)              | one sift along a root-to-leaf path of a complete tree of height ⌊log₂ n⌋ | `DSA-HEAP-01 ascending, descending and random inputs pop in ascending key order` | `heap.bench.ts` pop+push vs n       |
| changePriority                      | O(log n)              | `pos[h]` finds the entry in O(1); one sift up or down                    | `PROC-02 decreasing a leaf's key to the minimum …`                               | `heap.bench.ts` changePriority vs n |
| remove                              | O(log n)              | move the last entry into the hole; sift up or down                       | `DSA-HEAP-02 remove of the root, the last element, a middle element …`           | `heap.bench.ts` remove+push         |
| replaceTop                          | O(log n)              | overwrite the root; one sift down                                        | `DSA-HEAP-02 replaceTop on an empty heap behaves as push`                        | –                                   |
| peek, peekKey, has, keyOf           | O(1)                  | array reads                                                              | `DSA-HEAP-01 pop, peek and peekKey on an empty heap …`                           | –                                   |
| BoundedTopK.offer / drainDescending | O(log k) / O(k log k) | a min-heap of at most k entries                                          | `DSA-HEAP-02 BoundedTopK …`                                                      | –                                   |

### Why this structure

A sorted array costs O(n) per insert (the rubric's 'Developing' column); a balanced BST has the same bounds with larger constants and more code. The index map is what makes changePriority O(log n) (Spec §10.1).

### Memory layout

Struct of arrays: `keys: Float64Array` (heap order), `hnd: Int32Array` (handle at each position) and `pos: Int32Array` (handle → position, −1 when absent), each grown by doubling. Estimated 16 B/entry for dense handles (8 + 4 + 4). Measured on a dev machine: 15.0 / 16.0 / 16.0 B/entry at 10^3 / 10^4 / 10^5; allocated = used = 16.0 B/entry. `BoundedTopKHeap` adds 8 B per slot (`ids: Float64Array`), 24·k bytes in total. `HeapPriorityQueue<T>` adds a `Map` entry and an array slot per item.

### Invariants

1. H1 `keys[(i−1) >> 1] ≤ keys[i]`
2. H2 `pos[hnd[i]] === i`
3. H3 `pos[h] === −1` for absent handles
4. H4 every key is finite

### Tests

`dsa/tests/heap.test.ts` (20 edge-case tests) and `dsa/tests/heap.prop.test.ts` (3 properties). Edge cases: empty heap (pop, peek, peekKey, has, keyOf, remove); one element; 100 equal keys; duplicate handle (`DUPLICATE`); NaN, ±∞ keys and negative or fractional handles (`RANGE`); changePriority to an absent handle, to the same key, of a leaf to the minimum, and of the root upwards; remove of the root, the last, a middle and the only element, including the sift-UP case; replaceTop on empty and of the popped handle itself; index-map growth to handle 100,000; growth from capacity 1 to 2^17; clear and reuse; ascending, descending and random inputs; scheduler keys at effPrio 39 and seq 2^32 − 1; BoundedTopK with k = 0, fewer than k and ties at the threshold; checkInvariants detecting a broken index map; the PriorityQueue facade; stats. Properties: a model-based test (Map model, random push, pop, changePriority, remove and replaceTop over 64 handles and keys in [−50, 50], checkInvariants after every step); heap-sort equals `Array.sort` on random doubles; BoundedTopK equals sort-descending-and-slice. Seed policy: fast-check picks a fresh seed per run and prints the seed and path of a failure. 1,000 runs per PR and `PLT_PROP_RUNS=10000` nightly; replay with `PLT_PROP_SEED` and `PLT_PROP_PATH`.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/heap/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:heap:start -->

| op                               | n       | p50 ns   | p95 ns   | mean ns  | bytes/entry (measured / allocated) | shape ratio (limit) |
| -------------------------------- | ------- | -------- | -------- | -------- | ---------------------------------- | ------------------- |
| pop+push                         | 1,000   | 50.7     | 78.4     | 54.1     | –                                  | –                   |
| pop+push                         | 10,000  | 67.8     | 82.3     | 68.5     | –                                  | –                   |
| pop+push                         | 100,000 | 78.0     | 107.9    | 80.5     | –                                  | 1.49 (3)            |
| changePriority                   | 1,000   | 43.1     | 46.5     | 43.6     | –                                  | –                   |
| changePriority                   | 10,000  | 34.8     | 36.1     | 35.1     | –                                  | –                   |
| changePriority                   | 100,000 | 34.1     | 37.9     | 34.5     | –                                  | 0.79 (3)            |
| remove+push                      | 1,000   | 59.7     | 64.7     | 60.7     | –                                  | –                   |
| remove+push                      | 10,000  | 77.1     | 117.0    | 81.7     | –                                  | –                   |
| remove+push                      | 100,000 | 90.0     | 99.4     | 90.9     | –                                  | 1.50 (3)            |
| pop+push [scheduler]             | 256     | 49.4     | 68.4     | 52.4     | –                                  | –                   |
| push+pop [baseline:sorted-array] | 1,000   | 168.4    | 188.9    | 174.2    | –                                  | –                   |
| push+pop [baseline:sorted-array] | 10,000  | 1,232.5  | 1,653.2  | 1,306.4  | –                                  | –                   |
| push+pop [baseline:sorted-array] | 100,000 | 26,181.3 | 31,780.1 | 26,764.3 | –                                  | –                   |
| memory                           | 1,000   | –        | –        | –        | 15.04 / 16.00                      | –                   |
| memory                           | 10,000  | –        | –        | –        | 15.96 / 16.00                      | –                   |
| memory                           | 100,000 | –        | –        | –        | 16.01 / 16.00                      | –                   |

<!-- dsa-report:heap:end -->

Dev machine (AMD Ryzen 5 7530U, Node v24.13.1), 2026-09-25: re-run on the lab machine before the final defence.
_Chart: `docs/evidence/dsa/heap/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

- **Dense handles only.** `pos` is sized to the largest handle, so one handle of 10^6 costs 4 MB. Pids, timer ids and lock slots are dense by design. Callers with sparse ids use `HeapPriorityQueue<T>` (free-handle stack) or `BoundedTopKHeap` (slots). Handles are limited to int32 (≤ 2^31 − 1).
- **No tie-breaking.** Equal keys pop in an unspecified order. The scheduler encodes FIFO order into the key (`effPrio · 2^32 + seq`, exact below 2^53), and the timer module sorts due entries itself.
- **No implicit shrink** (spec §3.4). A heap that once held many entries keeps its arrays.
- **Reversal.** If `pop+push` misses the mean ≤ 1 µs at 10^5 budget on the lab machine (the dev machine measures about 81 ns), the options in order are: a bottom-up (Floyd) sift-down, with one comparison per level on the way down; a 4-ary heap, with half the levels and better cache use; and a hand-written WASM heap (pilot: 65–128 ns). All three keep this interface.

Full notes, derivations and every run: [`dsa/src/heap/README.md`](dsa/src/heap/README.md).

## S4 DAG with Kahn's topological sort

| Field                      | Value                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/dag/index.ts` (single file)                                                                                                                                                                                                                                                                                                                                                               |
| Owner / non-owner reviewer | R5 QA/DevOps / R2 VFS/DB                                                                                                                                                                                                                                                                                                                                                                           |
| Mandatory location (§10.1) | Service dependencies and boot order (Spec §6.4, §10.1 DAG row; BOOT-03, BOOT-04) and application start-up dependencies.                                                                                                                                                                                                                                                                            |
| Used by                    | services/svcmgr (boot, shutdown, progress closure); kernel/core/proc/spawn (app closure); `bootlog --critical-path`; `svc.verify`                                                                                                                                                                                                                                                                  |
| Written by                 | Claude (AI), by team decision of 2026-09-25, from first principles: no package, no pilot code, no other dsa structure. Owner R5 (owner name to fill) studies and defends it in the viva; implementing PR #(to fill)                                                                                                                                                                                |
| AI assistance              | Claude wrote the implementation, the memory record in `dag.bench.ts` and this entry from specs/08-dsa/data-structures.md §3.5/§4.4/§5 S4 and the existing contract and tests. Accepted: the CSR layout, the transpose-based dependents half, duplicate edges detected from sorted rows, the cycle walk. Added to the contract: `stats()` (§3.4 "Accounting"). See AI_USAGE.md (entry link to fill) |

### Operations and complexity

| Operation                              | Complexity  | Proof sketch (one line)                                                               | Proving test                                              | Proving benchmark                              |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| buildDag (index + CSR + Kahn + levels) | O(V + E)    | each node enqueued and dequeued once, each edge decremented once; two counting passes | `DSA-DAG-01 random DAGs (500 nodes) …` (property)         | `dag.bench.ts` ns per (V + E)                  |
| cycle path                             | O(V + E)    | each walk step scans one predecessor list; pigeonhole gives the cycle                 | `BOOT-04 a 2-cycle and a 3-cycle are reported …`          | –                                              |
| cursor().complete(v)                   | O(outdeg v) | decrement v's dependents                                                              | `DSA-DAG-03 the cursor rejects completing a node twice …` | –                                              |
| ancestors(targets)                     | O(V + E)    | iterative DFS over `requires`; each node pushed at most once                          | `DSA-DAG-03 the shipped 18 service manifests …`           | `dag.bench.ts` app closure at 8, 32, 128 nodes |
| reversed()                             | O(V + E)    | swap the two CSR halves, one transpose, one Kahn                                      | `DSA-DAG-03 reversed topological order …`                 | –                                              |

### Why this structure

Start-up order is a partial order; only a DAG expresses it, and a cycle means the system cannot boot (Spec §10.1). Kahn gives the order, the levels for parallel start and the cycle test in one O(V + E) pass. DFS-based topological sort was rejected: it needs an explicit stack to avoid recursion, gives no levels without a second pass, and its order depends on the visiting order, not on the input. Adjacency lists of objects were rejected for CSR typed arrays: 20 B/node + 8 B/edge with no per-node objects.

### Memory layout

`names: string[]`, `index: Map<string, number>`; Int32Array `inStart`(V+1)/`inFrom`(E), `outStart`(V+1)/`outTo`(E), `indeg`, `level`, `order` (V each). Allocated: 4·(5V + 2 + 2E) bytes = 59.9 B/node at E ≈ 5V. Measured (dev, `--expose-gc`): 104.6 B/node built, 124.8 B/node with the cached `levels()`/`topoOrder()` lists at V = 10^5.

### Invariants

1. D1 `names` and `index` are a bijection (`checkInvariants`: "D1 …")
2. D2 Σ out-degree = Σ in-degree = `edges`; both CSR halves describe the same edge set, with no self-loop and no repeated edge ("D2 …")
3. D3 `level[v] ≥ level[u] + 1` on every edge, with equality for at least one predecessor; sources are level 0 ("D3 …")
4. D4 `topoOrder` is a permutation and respects every edge ("D4 …")

### Tests

`dsa/tests/dag.test.ts` (17 edge-case tests: V = 0, one node, diamond, several sources, duplicate name/edge, unknown requirement, self-loop, 2- and 3-cycles, cycle behind a tail, two disjoint cycles, 10^5 chain/flat/cycle without recursion, cursor misuse, ancestors of a source, 18 shipped manifests, reversed order, topoLevels, RANGE); `dsa/tests/dag.prop.test.ts` (3 fast-check properties, 1,000 runs per PR and 10,000 nightly via PLT_PROP_RUNS; failures replay with PLT_PROP_SEED/PLT_PROP_PATH).

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/dag/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:dag:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:dag:end -->

Dev-machine build + Kahn + levels per (V + E), E ≈ 5V (from `dsa/src/dag/README.md`):

| V    | p50 ns | p95 ns | mean ns | bytes/node (measured / allocated) | shape ratio (limit 2)                                          |
| ---- | ------ | ------ | ------- | --------------------------------- | -------------------------------------------------------------- |
| 10^3 | 47.4   | 66.7   | 50.6    | 120.9 / 58.77                     | –                                                              |
| 10^4 | 77.3   | 121.0  | 83.6    | 133.1 / 59.60                     | 1.49 on the PR sizes: pass                                     |
| 10^5 | 181.5  | 445.6  | 225.8   | 124.8 / 59.87                     | 4.46 under load, 2.63 at lower load: **fails on this machine** |

Budgets: the 18 shipped services build in 8.1 µs (≤ 50 µs, pass); a 32-node app closure takes 13.4 µs mean, 22.7 µs p95 (≤ 1 ms, pass). The 10^5 shape is dominated by `Map` string hashing (72–79% of build time); the team-written CSR and Kahn part grows 2.1× (11.2 → 23.9 ns per (V + E)). The nightly shape assertion must be judged on the lab machine; see "Known limits and reversal".

_Chart: `docs/evidence/dsa/dag/chart.svg`, generated from the committed lab run (pending)._
Dev-machine figures (re-run on the lab machine): 50.6 / 83.6 / 225.8 ns per (V + E) at 10^3 / 10^4 / 10^5; 18 services 8.1 µs; app closure at 32 nodes 13.4 µs.

### Known limits and reversal

The 10^5 shape ratio is dominated by `Map` string hashing (72–79% of build time). It was 4.46 and 2.63 against the limit of 2 on the shared dev machine; the team-written CSR and Kahn part grows from 11.2 to 23.9 ns per (V + E). See dsa/src/dag/README.md "Known limits and reversal" for the options. Reversal trigger: the boot DAG above 50 µs or an app closure above 1 ms on the lab machine.

Full notes, derivations and every run: [`dsa/src/dag/README.md`](dsa/src/dag/README.md).

## S5 LRU (hash map + doubly linked list)

| Field                      | Value                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/lru/index.ts` (single file)                                                                                                                                                                                                                                                                                                                                            |
| Owner / non-owner reviewer | R1 Kernel / R5 QA/DevOps                                                                                                                                                                                                                                                                                                                                                        |
| Mandatory location (§10.1) | The LRU pager (Spec §9.2, §10.1 LRU row; MEM-02), plus the VFS inode cache and the server's rate-limit keys (bounded mode).                                                                                                                                                                                                                                                     |
| Used by                    | kernel/core/mm (pager); vfs/tree (inode cache); server/ratelimit.ts (key bound)                                                                                                                                                                                                                                                                                                 |
| Written by                 | Claude Code (AI) on 2026-09-25, under the team's `dsa/` decision of that day (AI_USAGE.md §5). This is AI-written work, not the owner's own authorship. It uses no npm package and no pilot code, and follows the algorithms of data-structures.md §5 S5. The R1 owner studies it, completes the AI_USAGE.md §5.4 checklist and must explain it in the viva. Implementing PR #… |
| AI assistance              | Asked: implement S5 to the spec and the existing contract, tests and benchmark. Accepted: the whole implementation. Test change: one timeout added to the property test (see Tests). Recorded in AI_USAGE.md log row 8 (`plotinium-dsa`) and §5                                                                                                                                 |

### Operations and complexity

| Operation                          | Complexity      | Proof sketch (one line)                                                                                                                                                 | Proving test                                                             | Proving benchmark              |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| get, touch                         | O(1)            | one `Map.get`, then `unlink` + `linkHead` (at most 8 slot-array writes) unless pinned or already MRU                                                                    | `MEM-02 get moves an entry to the MRU end …`                             | `lru.bench.ts` get (hit, Zipf) |
| put, putAtLru (existing key)       | O(1)            | one `Map.get`, value write, `unlink` + `linkHead`/`linkTail`                                                                                                            | `DSA-LRU-01 putting an existing key updates the value …`                 | –                              |
| put, putAtLru (new key)            | O(1) amortised  | `Map.get` (miss), an optional O(1) evict, a free-stack pop, `link`, `Map.set`; the slot arrays double only when the free stack is empty, so growth costs O(1) amortised | `DSA-LRU-01 a bounded put on a full cache returns the evicted LRU entry` | `lru.bench.ts` put+evict       |
| moveToLru                          | O(1)            | `Map.get`, `unlink` + `linkTail` unless pinned                                                                                                                          | `DSA-LRU-02 moveToLru makes an entry the next eviction`                  | –                              |
| evict, peekLru                     | O(1) worst case | pinned entries are unlinked, so the tail is always evictable: no scan past pinned entries                                                                               | `MEM-02 a pinned entry is never evicted …`                               | `lru.bench.ts` put+evict       |
| pin, unpin                         | O(1)            | count update; `unlink` on 0→1, `linkHead` on 1→0                                                                                                                        | `DSA-LRU-01 pin twice then unpin once …`                                 | `lru.bench.ts` pin+unpin       |
| delete                             | O(1)            | `unlink` (if unpinned) + `Map.delete` + push the slot on the free stack                                                                                                 | `DSA-LRU-01 deleting the MRU head, the LRU tail and a middle entry …`    | –                              |
| peek, has, isPinned, isSpeculative | O(1)            | one `Map` lookup and one array read                                                                                                                                     | property test                                                            | –                              |
| keysMruToLru                       | O(n)            | walk `next` from `head`                                                                                                                                                 | `DSA-LRU-02 putAtLru entries are evicted before older normal entries`    | –                              |

`Map` operations are amortised O(1) (V8's `Map` is a hash table that rehashes by doubling); every other step is a constant number of typed-array reads and writes. No operation other than `keysMruToLru`, `checkInvariants` and the slot-array doubling contains a loop.

### Why this structure

Neither structure alone gives O(1) recency updates and O(1) lookup (Spec §10.1): the map finds the list node, the list keeps recency. An array LRU needs `indexOf` + `splice`, O(n) per access; the benchmark's array-LRU baseline grows 72–139× from 10^3 to 10^5 while this structure stays within about 2×.

### Memory layout

- `index: Map<K, number>`: key → slot. `Map` is the allowed hashing primitive (§10.2) and the only hashing in the structure.
- Slot arrays (struct of arrays; slot s holds one entry): `keys: K[]`, `vals: V[]`, `prev: Int32Array`, `next: Int32Array`, `pins: Uint16Array` (pin count), `flags: Uint8Array` (bit 0 = speculative).
- `head` (MRU) and `tail` (LRU) slot indices, `-1` (NIL) when the list is empty.
- A free-slot stack whose links reuse `next`, so free slots cost no extra array.
- Each slot is in exactly one state. _Linked_: unpinned, on the recency list. _Pinned_: pin count > 0, off the list, with prev and next set to NIL. _Free_: on the free stack, with keys and vals cleared so the GC can reclaim them.
- The arrays grow by doubling (clamped to `capacity` in bounded mode) and never shrink implicitly (§3.4).
- **Estimated:** 27 B per slot, from the typed arrays (4 + 4 + 2 + 1 = 11 B) plus one 8-byte element in each of `keys` and `vals`. `stats().bytesAllocated` and `stats().bytesUsed` report this per allocated and per used slot, excluding the `Map`.
- **Measured** (dev machine, Node 24.13.1, `--expose-gc`, number keys and values, unbounded, default `initialSlots` 16):

| n    | measured B/entry (incl. `Map`) | allocated B/entry    | used B/entry |
| ---- | ------------------------------ | -------------------- | ------------ |
| 10^3 | 46–59                          | 27.6 (1,024 slots)   | 27.0         |
| 10^4 | 100                            | 44.2 (16,384 slots)  | 27.0         |
| 10^5 | 78.6                           | 35.4 (131,072 slots) | 27.0         |

The measured figure is Map-dominated (§7.2: "reported (Map-dominated)"). The 10^4 point is the highest because both the `Map`'s table and the slot arrays have just doubled past n.

### Invariants

`checkInvariants()` runs in O(slots) using one scratch mark per slot. Each failure throws an `Error` whose message starts with `dsa/lru invariant <id> violated`.

1. L1 walking `next` from `head` reaches `tail` over exactly `evictableSize` slots, `prev`/`next` consistent (checks: `head`/`tail` agree on emptiness; every `prev[s]` equals the slot visited before it; no slot is visited twice; the walk ends at `tail`; the count equals `evictableSize`)
2. L2 every indexed slot is linked (pins = 0) or unlinked (pins > 0), never both (also: every linked slot holds an indexed entry)
3. L3 `index.size === size` and `keys[index.get(k)] === k` (size is checked against the count of used slots, so a leaked slot is caught; keys are compared with SameValueZero, Map's own equality, so `NaN` keys work; no slot is indexed twice)
4. L4 free and used slots are disjoint (the free stack is acyclic and in range; free slots carry no stale pin count or flag; free + used = allocated slots; all slot arrays have one length)
5. L5 `size ≤ capacity` in bounded mode

### Tests

`dsa/tests/lru.test.ts`, `dsa/tests/lru.prop.test.ts`.

- 18 edge-case tests (spec §8.6): empty cache; one entry; duplicate put; get order and evict; deleting the head, the tail and a middle entry; pinned entries never evicted; FULL when every entry is pinned; counted pins; relink at MRU on the last unpin; get of a pinned entry; NOT_FOUND and INVALID; putAtLru eviction order; promotion of speculative entries; moveToLru; bounded eviction and RANGE capacities; doubling and slot reuse under delete churn; number and string keys, with -0 and +0 treated as one key; checkInvariants detecting the `pinned-linked` corruption.
- 1 model-based fast-check property test covering all nine mutators in bounded (capacity 1–8) and unbounded modes, with up to 200 operations per run over 12 keys. After every step it calls `checkInvariants()` and compares the whole observable state with an ordered-array model.
- Seed policy: 1,000 runs on PRs and 10,000 nightly (`PLT_PROP_RUNS`). fast-check prints the seed and path of a failing run, which `PLT_PROP_SEED` and `PLT_PROP_PATH` replay.
- Mutation check (2026-09-25): three injected bugs were each caught by the suites. They were: `unpin` relinking at the LRU end; `get` not clearing the speculative flag; `delete` leaving a stale pin count on the freed slot.
- Test change: the property test now has an explicit timeout of `max(30 s, 20 ms × numRuns)`. The 5 s Vitest default made the nightly 10,000-run setting fail by timeout (about 32–43 s; the cache itself is under 10% of that), and 1,000 runs already took 3.6 s. No run, operation or assertion changed.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/lru/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:lru:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:lru:end -->

_Chart: `docs/evidence/dsa/lru/chart.svg`, generated from the committed lab run (pending)._

**Dev-machine results, 2026-09-25.** AMD Ryzen 5 7530U (6 cores/12 threads, 512 KB L2 per core, 16 MB shared L3), Linux 7.0, Node 24.13.1, Vitest 5.0.1 bench, batches of 1,000 operations.

Each cell is the median of 3 runs, as mean / p50 / p95 in ns per operation. The ratio columns give t(10^5) / t(10^3) for each of the three runs, first on the mean (the asserted value) and then on the p50.

| op                               | 10^3            | 10^4                  | 10^5                     | mean ratio, 3 runs (limit 2) | p50 ratio, 3 runs |
| -------------------------------- | --------------- | --------------------- | ------------------------ | ---------------------------- | ----------------- |
| get (hit, Zipf)                  | 62 / 58 / 79    | 68 / 63 / 82          | 80 / 77 / 100            | 1.27, 1.30, 1.44             | 1.28, 1.33, 1.41  |
| put+evict (bounded, new keys)    | 120 / 117 / 150 | 162 / 119 / 242       | 229 / 175 / 376          | 2.40, 1.89, 2.09             | 1.84, 1.49, 1.42  |
| pin+unpin                        | 65 / 63 / 70    | 86 / 80 / 92          | 101 / 91 / 132           | 1.62, 1.53, 1.15             | 1.64, 1.43, 1.14  |
| baseline: array-LRU touch (Zipf) | 341 / 309 / 506 | 2,644 / 2,550 / 3,394 | 27,475 / 27,143 / 29,672 | 72, 80, 139                  | 80, 88, 166       |

Complexity curve, mean ns/op:

    n:                 10^3     10^4     10^5
    get                  62       68       80    flat    (O(1))
    pin+unpin            65       86      101    flat    (O(1))
    put+evict           120      162      229    ~2x     (O(1) ops; Map rehash and cache misses at 10^5)
    array-LRU touch     341    2,644   27,475    ~80x    (O(n): indexOf + splice)

- In the three tabulated runs, every mean is at most 0.3 µs, within the §7.2 absolute target of 0.5 µs.
- The PR shape gate (`PLT_BENCH_SIZES=1000,10000`) passed in both runs made.
- Eight full-size runs were made in all:
  - `get` passed its shape assertion in all 8.
  - `pin+unpin` stayed at or below 1.62 in all 8.
  - `put+evict` passed in 1 of 8. The mean ratios were 1.89, 2.09, 2.17 and 2.40 at load 4–8, 3.58, 3.78 and 3.94 at load 7–8, and 6.02 in one run where even `get` at 10^3 showed ±15% rme and 10 ms single samples.
- These numbers are from a **dev machine under heavy load**: about 25 other agents were building and testing in parallel, with load average 5–9 on 12 threads. **Re-run them on the lab machine** before they go into `DSA.md` (§7.1: lab runner, Node 24, nightly).

Why `put+evict` sits at the limit:

- Per operation it does three `Map` operations (a get that misses, a delete and a set) plus a constant number of slot-array writes. In this workload the slot accesses touch only neighbouring slots (i-1, i, i+1), so they stream sequentially.
- The part that grows with n is the `Map`. At 10^5 its table is about 7 MB, well past L2. Under delete-and-insert churn, V8 also rehashes it every O(n) insertions (O(1) amortised, but it causes the p95 spikes shown at 10^4 and 10^5).
- Raw `Map` churn (get-miss, delete-oldest, set-new) measured alone on the same machine grew 1.7–3.5× from 10^3 to 10^5.
- The p50 ratio of 1.4–1.8 is the steady per-operation cost; the mean includes the rehash spikes.

### Known limits and reversal

- **Pin counts** saturate at 65,535 (`Uint16Array`). `pin` beyond that throws `RANGE` rather than wrapping to 0, which would silently make a pinned page evictable.
- **Slot limit:** at most 2^30 slots (int32 slot indices); `capacity` and `initialSlots` outside [1, 2^30] and [0, 2^30] throw `RANGE`.
- **Arrays never shrink.** A cache that once held n entries keeps n slots (27 B each) until it is dropped (§3.4: no implicit shrink).
- **Iteration:** `keysMruToLru` reads the successor before it yields, so deleting, evicting or touching the key just yielded is safe. Any other mutation during iteration is not.
- **Keys:** `Map` (SameValueZero) equality. `-0` and `+0` are one key, and `NaN` is a valid key. Object keys compare by identity.
- **Reversal trigger:** the lab machine's nightly run fails the `put+evict` shape limit (≤ 2) at 10^5, or the pager's page-in budget in memory-and-paging.md is missed because of LRU cost. The option then is a spec change to replace `Map` with S6's open-addressing `IntHashTable` for integer keys (the pager's page slots): no per-entry heap objects and no tombstone rehash. This needs an amendment to §3.5, because `Map` is the specified hashing primitive of S5.

Full notes, derivations and every run: [`dsa/src/lru/README.md`](dsa/src/lru/README.md).

## S6 Open-addressing hash table

| Field                      | Value                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/hashtable/index.ts` (single file)                                                                                                                                                                                                                                                   |
| Owner / non-owner reviewer | R1 Kernel / R3 Shell/WM                                                                                                                                                                                                                                                                      |
| Mandatory location (§10.1) | The process table pid → PCB (PROC-01) and the window registry wid → WinRec (WM-01): the distinction-credit hash table of Spec §10.2.                                                                                                                                                         |
| Used by                    | kernel/core/proc (PidTable); wm/compositor (window registry); dsa/zorder (wid → slot)                                                                                                                                                                                                        |
| Written by                 | Implemented by Claude (AI) from first principles on 2026-09-25, following the team decision of that date. No npm package, no pilot code and no other dsa structure was used. R1 ((owner name to fill)) studied it and defends it at the viva; implementing PR #…                             |
| AI assistance              | The whole implementation, 3 additional tests and this entry were written by Claude from the S6 spec. Nothing was rejected. Behaviour added beyond the spec: fail-fast iteration, `INVALID` for undefined values, `RANGE` for initialCapacity > 2^30. See the AI_USAGE.md entry of 2026-09-25 |

### Operations and complexity

| Operation            | Complexity              | Proof sketch (one line)                                                                                   | Proving test                                                              | Proving benchmark                         |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| get, has             | O(1) expected           | ≈ ½(1 + 1/(1−α)) ≤ 1.5 probes at α ≤ ½ (Knuth, TAOCP vol. 3 §6.4); measured mean 1.21–1.42 on random keys | `DSA-HASH-01 200,000 random … operations match Map …` (property)          | `hashtable.bench.ts` mixed vs Map         |
| set                  | O(1) amortised expected | doubling moves each entry O(1) times amortised                                                            | `DSA-HASH-01 inserting past load 0.5 doubles capacity …`                  | `hashtable.bench.ts` mixed get/set/delete |
| delete               | O(1) expected           | backward shift stops at the end of an O(1)-expected cluster                                               | `DSA-HASH-01 deleting the head, middle and tail of a colliding cluster …` | `hashtable.bench.ts` mixed get/set/delete |
| forEach, keys, clear | O(capacity)             | slot scan                                                                                                 | `DSA-HASH-01 clear empties the table and forEach visits every key once`   | –                                         |

### Why this structure

Declared collision strategy (Spec §10.2):

- Linear probing at load ≤ ½, with backward-shift deletion. There are no tombstones, so probe paths never lengthen with churn.
- Fibonacci hashing, which scatters sequential pids and wids (max probe ≤ 2 for pids 1..32,768).
- Linear probing reads adjacent slots of one Int32Array, so a probe usually stays within one cache line.

### Memory layout

- Struct of arrays: `keys: Int32Array(cap)` (−1 = EMPTY) and `vals: (V | undefined)[]`, plus `size`, `cap`, `mask`, `shift`.
- 12 B per slot (4 B key + 8 B element pointer), so 24–48 B per entry at load ¼–½, excluding the value objects.
- Measured with `--expose-gc` at 10^3 / 10^4 / 10^5: 24.97 / 40.69 / 31.47 B/entry, against 24.58 / 39.32 / 31.46 allocated (dev machine).

### Invariants

1. HT1 reachability: every slot from `h(k)` to the slot of k is occupied
2. HT2 keys are unique
3. HT3 `size` equals the occupied slots and `size ≤ cap/2`
4. HT4 `cap` is a power of two ≥ 8 with `shift = 32 − log2(cap)`
5. HT5 `vals[j] === undefined` iff `keys[j] === −1`

### Tests

`dsa/tests/hashtable.test.ts` (17) and `dsa/tests/hashtable.prop.test.ts` (2).

Edge cases:

- empty table
- one key
- the same key set twice
- delete then re-insert
- deleting the head, middle and tail of a colliding cluster
- a cluster that wraps from the last slot to slot 0
- keys 0 and 2^31−1, and RANGE for −1, 1.5, 2^31 and NaN
- growth past load ½
- shrink below ⅛ with hysteresis
- minimum capacity 8
- sequential pids 1..32,768 with wrap-around reuse
- the window registry
- clear and forEach
- the checkInvariants probe-hole corruption
- fail-fast iteration
- undefined values
- stats accounting

Property tests:

- A fast-check differential test against `Map`: 1,000 runs of up to 200 operations on keys chosen to collide and wrap, with HT1–HT5 checked after every operation. Nightly: `PLT_PROP_RUNS=10000`.
- A seeded mulberry32(42) run of 200,000 operations.

Seed policy: fast-check prints the seed and path of any failure, and `PLT_PROP_SEED` / `PLT_PROP_PATH` replay it.

Mutation check: changing `≥` to `>` in the backward-shift condition fails 4 tests.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/hashtable/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:hashtable:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:hashtable:end -->

Dev-machine results (from `dsa/src/hashtable/README.md`; 50% get / 25% set / 25% delete over a pool of 2n keys, batches of 1,000, median of three runs), mean / p50 / p95 ns per operation:

| n    | table, sequential   | `Map`, sequential   | table, random       | `Map`, random       |
| ---- | ------------------- | ------------------- | ------------------- | ------------------- |
| 10^3 | 61.5 / 48.4 / 87.9  | 68.5 / 60.5 / 100.1 | 61.5 / 55.7 / 99.5  | 66.0 / 58.0 / 103.0 |
| 10^4 | 81.3 / 70.6 / 109.9 | 73.6 / 65.6 / 107.2 | 64.5 / 56.4 / 99.8  | 73.6 / 72.1 / 116.8 |
| 10^5 | 65.4 / 55.9 / 100.5 | 60.9 / 57.5 / 90.8  | 62.0 / 58.0 / 103.8 | 66.9 / 58.1 / 106.4 |

Shape t(10^5)/t(10^3) (limit 2): sequential 1.17, 1.11, 0.73; random 1.01, 0.99, 0.98 over three runs, so the curve is flat. Budget mean ≤ 0.3 µs: pass (55–90 ns). Not slower than `Map` by more than 1.5×: 0.7–1.4× in two of three runs; one noisy run reached 1.5–2.3× on random keys with equal p50s (a soft, recorded budget). Without the harness (10^6 operations, best of 7) the table takes 0.55–0.83× as long as `Map`.

_Chart: `docs/evidence/dsa/hashtable/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

- Keys must be int32 handles in 0..2^31−1. Other key types belong in a `Map`.
- Iteration is fail-fast: there is no delete-while-iterating.
- Capacity is at most 2^30 slots.
- Tables pre-sized with `initialCapacity` shrink on their first delete while below ⅛ load.
- Reversal trigger: if a lab-machine run shows mixed operations slower than `Map` by more than 1.5× at any size, or a max probe above 32 on the real pid/wid workload, revert the process table to `Map` and keep S6 for the window registry only.

Full notes, derivations and every run: [`dsa/src/hashtable/README.md`](dsa/src/hashtable/README.md).

## S7 Ring buffer

| Field                      | Value                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/ringbuffer/index.ts` (`RingBuffer<T>`, `Float64Ring`, `ByteRingBuffer`; internal `RingIndex`)                                                                                                                                                                                                                        |
| Owner / non-owner reviewer | R5 QA/DevOps / R1 Kernel                                                                                                                                                                                                                                                                                                      |
| Mandatory location (§10.1) | Extra credit (Spec §10.1 note): the kernel log. Also the telemetry ring, the frame meter and pipes.                                                                                                                                                                                                                           |
| Used by                    | kernel/core/klog (8,192, overwrite); ai/predictor telemetry ring (4,096, mirrored with `slotOf`); wm/frame-meter (Float64Ring of 1,024); kernel/core/ipc pipes (ByteRing, 64 KiB, reject)                                                                                                                                     |
| Written by                 | Claude Code (Anthropic, Claude Opus 5.5) on 2026-09-25, following the team decision of 2026-09-25 that Claude writes the dsa/ structures with disclosure in AI_USAGE.md; written from first principles (no package, no pilot code, no other dsa structure). R5 studies and defends it in the viva. Implementing PR #(to fill) |
| AI assistance              | Asked: implement S7 against the contract, tests and spec, and record the benchmark. Accepted: the whole implementation, 3 added tests, the benchmark fix. The team records what it later changes or rejects in AI_USAGE.md (entry (to fill)).                                                                                 |

### Operations and complexity

| Operation                                                | Complexity                                                                | Proof sketch (one line)                                                                             | Proving test                                                        | Proving benchmark                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| push, tryPush, shift, peekOldest, peekNewest, at, slotOf | O(1) worst case (not amortised: the array never grows)                    | a constant number of comparisons, one add and one AND `(head + i) & mask`, one array store; no loop | `DSA-RING-01 overwrite mode replaces the oldest and counts dropped` | `ringbuffer.bench.ts` push+shift and overwrite push, flat from 10^3 to 10^5 |
| toArray, iteration                                       | O(n)                                                                      | n iterations of the O(1) `at` arithmetic, oldest to newest                                          | `DSA-RING-01 filling exactly to capacity …`                         | –                                                                           |
| clear                                                    | O(n) for `RingBuffer` (releases the n live slots), O(1) for `Float64Ring` | one store per live slot; doubles hold no references                                                 | `DSA-RING-01 clear empties the ring and keeps it usable`            | –                                                                           |
| ByteRing write / read                                    | O(bytes)                                                                  | at most two contiguous `Uint8Array.set` copies (before and after the wrap)                          | `DSA-RING-01 ByteRing partial write when nearly full …`             | `ringbuffer.bench.ts` ByteRing 4 KiB throughput                             |
| Float64Ring percentile                                   | O(n log n)                                                                | copy the live range (≤ 2 segments), sort the copy, index rank − 1                                   | `DSA-RING-01 Float64Ring nearest-rank percentile is exact …`        | – (27 µs at n = 1,024, dev machine)                                         |
| checkInvariants                                          | O(capacity)                                                               | one pass over the slots; tests and `__DEV__` only                                                   | every test                                                          | –                                                                           |

**Correctness proof sketch.** Representation invariant: the abstract ring is the sequence x_0 … x_{count−1} (oldest first), x_i is stored at slot `(head + i) & mask`, and every other slot is free.

- _No two elements share a slot (RB3)._ For 0 ≤ i < j < count ≤ capacity: `(head+i) & mask = (head+j) & mask` ⇔ capacity divides j − i, impossible because 0 < j − i < capacity.
- _push, not full._ The target `(head + count) & mask` is logical index `count`, distinct from the occupied slots by the same argument (count < capacity), so nothing is overwritten; count + 1 ≤ capacity keeps RB1.
- _push, full, overwrite._ The target is `(head + capacity) & mask = head`, the slot of x_0. After `head' = head + 1`, old x_{i+1} is new logical i, and the new element is at `(head' + capacity − 1) & mask = head`, logical `capacity − 1` (the newest). Exactly one element (x_0) is lost, counted by `dropped`.
- _shift._ Returns x_0, frees its slot, and `head' = head + 1` renumbers x_{i+1} as i with count − 1.
- _RB2._ Every assignment to `head` is `(…) & mask` or 0, so 0 ≤ head ≤ mask < capacity.
- _ByteRing._ The free region starts at `tail = (head + count) & mask` and has `capacity − count` slots; `write` copies `n = min(len, free)` bytes as `min(n, capacity − tail)` bytes up to the physical end, then the rest from slot 0, which is exactly slots `(tail + j) & mask` for j < n. `read` is symmetric from `head`.

### Why this structure

Fixed memory, O(1) append and oldest-first overwrite are exactly a log's retention policy; an array with `shift()` is O(n) per removal. Capacity is a power of two so the modulo is one AND, and the physical slot index `slotOf` is stable, which lets the telemetry ring be mirrored slot by slot into IndexedDB (key = physical slot, head in `meta`).

### Memory layout

- `RingBuffer<T>`: one preallocated `T[]` of `capacity` slots (8 B per slot: one tagged pointer, Node 24 without pointer compression), plus `head`, `count`, `dropped`, `capacity`, `mask`, mode. Free slots hold `undefined`. Element objects are the caller's and are not counted.
- `Float64Ring`: one `Float64Array(capacity)`, 8 B per slot, unboxed (a push allocates nothing).
- `ByteRingBuffer`: one `Uint8Array(capacity)`, 1 B per slot.
- Real users: klog 8,192 × 8 B = 64 KiB of slots; telemetry 4,096 × 8 B = 32 KiB; frame meter 1,024 × 8 B = 8 KiB; one pipe 64 KiB.

Bytes per entry with n entries in a ring of capacity nextPow2(n) (dev machine; _allocated_ and _used_ from `stats()`, _measured_ = Δ(heapUsed + arrayBuffers)/n between two forced GCs with `--expose-gc`, `dsa/src/_shared/mem.ts`):

| n    | capacity | allocated | used | measured `RingBuffer<number>` | measured `Float64Ring` | measured `ByteRing` |
| ---- | -------- | --------- | ---- | ----------------------------- | ---------------------- | ------------------- |
| 10^3 | 1,024    | 8.19      | 8.00 | 8.78                          | 16.72                  | 3.26                |
| 10^4 | 16,384   | 13.11     | 8.00 | 13.31                         | 13.20                  | 1.74                |
| 10^5 | 131,072  | 10.49     | 8.00 | 10.54                         | 10.54                  | 1.27                |

_Used_ is exactly 8 B per entry (spec memory target "exact"). _Allocated − used_ is only the power-of-two round-up of the capacity, at most 2× and 1.64× at 10^4. _Measured_ matches _allocated_ within fixed per-object overhead (object, array and ArrayBuffer headers), which dominates at 10^3 and amortises away by 10^5.

### Invariants

1. RB1 `0 ≤ count ≤ capacity` (checked in `RingIndex.checkIndexInvariants` and `ByteRingBuffer.checkInvariants`)
2. RB2 `0 ≤ head < capacity` (same)
3. RB3 logical i ↦ physical `(head + i) & mask` is a bijection onto the occupied slots: capacity is a power of two with `mask = capacity − 1` and storage length = capacity; the images of 0..count−1 are pairwise distinct (checked with an occupancy map); and, for `RingBuffer`, every slot outside the image holds `undefined`, so the image _is_ the occupied set and `shift`/`clear` released what they removed
4. RB4 (ByteRing) `available + free === capacity`

Each failure throws `DsaError('INVALID', 'RBn violated: …')`. The contract has no corruption hook for rings, so the failure branches are not reached by tests (they are the only uncovered lines; line coverage of `index.ts` is 93.9%).

### Tests

`dsa/tests/ringbuffer.test.ts` (14), `dsa/tests/ringbuffer.prop.test.ts` (2).

- Edge cases: empty ring (shift, peek, at, toArray, iteration); capacity 1 in overwrite mode; exactly full with dropped 0; overwrite counting dropped; reject mode (`FULL`, `tryPush` false, then accepts after a shift); 8×10^6 pushes and 10^6 shift+push wrap-arounds with head in range; `at` for −1, size, capacity, 1.5 and NaN; non-power-of-two capacities 0, 3, 6, 1000, −4, 2.5 for all three classes; ByteRing empty read, zero-length read and write, partial write when nearly full, short read, split copies across the wrap; `slotOf` mapping and `RANGE`; Float64Ring newest-kept, nearest-rank percentiles and `RANGE` for q; clear keeps the ring usable. Added: Float64Ring whole API in reject mode, iteration after a wrap, exact `stats()`, unknown mode `INVALID`; percentile exact at q = k/n for n ≤ 64 (0.3 · 10 = 3.0000000000000004 would make a plain `⌈q·n⌉` pick rank 4).
- Mandatory cases (§6.1): empty = empty ring; one element = capacity 1; duplicates = none (FIFO keeps duplicates as separate entries); remove head = shift the oldest.
- Properties: (1) random push/shift/at/clear against an array model in both modes and capacities 1–16, checking items, size, dropped, peeks and every `slotOf` after each step, and ByteRing against a concatenated-bytes model; (2) Float64Ring differential against `RingBuffer<number>` with arbitrary doubles (−0, NaN, ±∞). `checkInvariants()` after every operation.
- Seed policy: fast-check picks a random seed per run and prints seed and path on failure; replay with `PLT_PROP_SEED` and `PLT_PROP_PATH`. 1,000 runs on PRs, `PLT_PROP_RUNS=10000` nightly (passes, about 30 s).

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/ringbuffer/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:ringbuffer:start -->

| op                                  | n        | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit)           |
| ----------------------------------- | -------- | ------ | ------ | ------- | ---------------------------------- | ----------------------------- |
| push+shift (half full)              | 10^3     | 4.66   | 8.67   | 5.06    | 8.78 / 8.19                        | –                             |
| push+shift (half full)              | 10^4     | 5.42   | 9.59   | 5.85    | 13.31 / 13.11                      | –                             |
| push+shift (half full)              | 10^5     | 5.36   | 10.42  | 6.08    | 10.54 / 10.49                      | 1.12 median, 1.61 worst (≤ 2) |
| push (full, overwrite)              | 10^3     | 4.50   | 9.42   | 4.97    | 8.78 / 8.19                        | –                             |
| push (full, overwrite)              | 10^4     | 4.50   | 8.37   | 5.13    | 13.31 / 13.11                      | –                             |
| push (full, overwrite)              | 10^5     | 4.42   | 6.90   | 4.58    | 10.54 / 10.49                      | 0.94 median, 1.36 worst (≤ 2) |
| ByteRing write+read 4 KiB, per byte | 65,536 B | 0.06   | 0.11   | 0.07    | 1 B/slot                           | –                             |

<!-- dsa-report:ringbuffer:end -->

Dev machine, not the lab machine: AMD Ryzen 5 7530U, Linux 7.0, Node v24.13.1 (V8 13.6), runner `dev`, seed 42. Medians of 15 benchmark runs taken while other agents were running (load average 4–6). ns are per operation: batches of 1,000 for push/shift, per byte for ByteRing. **Re-run on the lab machine** with `PLT_BENCH_RUNNER=lab PLT_BENCH_OUT=docs/evidence/dsa` before the final defence.

- Curve: flat, as O(1) predicts. Mean ns/op against n: push+shift 5.06 → 5.85 → 6.08 (×1.20 over a 100× larger ring); overwrite push 4.97 → 5.13 → 4.58 (×0.92). The small rise for push+shift is cache: the 10^5 ring's 1 MiB slot array does not fit in L1/L2. The cost does not depend on n.
- Budgets (§7.2): ≤ 50 ns per push/shift pair: 6 ns, pass. ByteRing ≥ 500 MB/s with 4 KiB chunks: median 15,343 MB/s (range 1,867–22,492 over 15 runs), pass.
- Shape assertion t(10^5)/t(10^3) ≤ 2: 15 of 15 runs passed after the benchmark fix below.
  _Chart: `docs/evidence/dsa/ringbuffer/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

- Capacity is fixed at construction and must be a power of two up to 2^30 (all four users already use powers of two). A ring never grows; a longer klog history means a bigger ring at boot.
- `RingBuffer<T>` returns `undefined` both for "empty" and for a stored `undefined`. Check `size` when `T` can be `undefined` (klog and telemetry push objects).
- Iteration reads the live ring. Pushing or shifting inside a `for … of` loop changes what comes next, so take `toArray()` first.
- `percentile` sorts a copy on every call (27 µs at 1,024 values on the dev machine), which is fine for a HUD refreshed a few times a second. **Reversal trigger:** if the frame meter needs a percentile every frame, keep a fixed-bucket histogram updated in `push` (O(1) per push, O(buckets) per query).
- `ByteRingBuffer` never overwrites; a full pipe returns 0 accepted bytes and the kernel blocks the writer.
- **Reversal trigger:** if klog must retain by bytes rather than entries (very uneven message sizes), store length-prefixed records in a `ByteRingBuffer` and evict whole records.

Full notes, derivations and every run: [`dsa/src/ringbuffer/README.md`](dsa/src/ringbuffer/README.md).

## S8 Bloom filter (double hashing)

| Field                      | Value                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/bloom/index.ts` (one file: `DoubleHashBloom`, `u32le`, `modU32`, `popcount32`)                                                                                                                              |
| Owner / non-owner reviewer | R4 AI / R2 VFS/DB                                                                                                                                                                                                    |
| Mandatory location (§10.1) | Extra credit (Spec §10.1 note): a Bloom filter in front of the vector index's content-hash lookup.                                                                                                                   |
| Used by                    | kernel `ai.index.lookup` fast path (rag-semantic-search.md §3.9)                                                                                                                                                     |
| Written by                 | Claude (AI assistant), by team decision of 2026-09-25, from first principles: no package, no pilot code, no other `dsa/` structure. R4 studies it and defends it in the viva. Implementing PR: PR #… (to fill)       |
| AI assistance              | Claude wrote the implementation, this entry and the benchmark run against the pre-existing spec, interface, tests and benchmark, none of which it changed. See the `AI_USAGE.md` entry of 2026-09-25 (link to fill). |

### Operations and complexity

| Operation                 | Complexity  | Proof sketch (one line)                                                                                                       | Proving test                                                                                                                                                       | Proving benchmark                                                  |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| add, mayContain           | O(k) = O(1) | 7 positions by double hashing from the first 8 hash bytes; each is one add, one compare and one word access, independent of n | `DSA-BLOOM-01 no false negatives for random hash sets` (property)                                                                                                  | `bloom.bench.ts` add / mayContain vs n (ratio t(10^5)/t(10^3) ≤ 2) |
| rebuild                   | O(m / 32)   | allocate (or `fill(0)`) m/32 words                                                                                            | `DSA-BLOOM-01 rebuild clears every bit and resizes to 10 bits per key rounded to 32`                                                                               | –                                                                  |
| bitCount, checkInvariants | O(m / 32)   | one SWAR popcount per word                                                                                                    | `DSA-BLOOM-01 adding the same hash twice leaves the bits unchanged`                                                                                                | –                                                                  |
| expectedFpr               | O(1)        | (1 − e^{−k·count/m})^k                                                                                                        | `DSA-BLOOM-01 expectedFpr follows (1 − e^(−k·count/m))^k`; `DSA-BLOOM-01 empirical false-positive rate over 10^5 non-members at n_design is between 0.4% and 1.3%` | `bloom.bench.ts` bytes per key                                     |

### Why this structure

At 10 bits per key and k = 7 the false-positive rate is ≈ 0.82%, so about 99% of certainly-new hashes skip an IndexedDB `byHash` lookup (an asynchronous IndexedDB round trip, much slower than the ≈ 0.1 µs filter probe). No deletions are needed: stale bits only cost an extra lookup, and the filter is rebuilt at compaction and at start. A `Set` of 32-byte hashes would cost well over 50 bytes per key; the filter costs 1.25.

### Memory layout

One `Uint32Array(m / 32)` with `m = ⌈10 · nDesign / 32⌉ · 32` bits, plus four number fields (`m`, `nDesign`, `count`, last popcount). Bit `p` is bit `p & 31` of word `p >>> 5`.

| n = nDesign | m (bits)  | allocated B/key (`stats()`) | measured B/key (`--expose-gc`, Δ heap + arrayBuffers)                 |
| ----------- | --------- | --------------------------- | --------------------------------------------------------------------- |
| 10^3        | 10,016    | 1.252                       | 13.3 (fixed object and ArrayBuffer overhead of about 12 KB dominates) |
| 10^4        | 100,000   | 1.250                       | 1.78                                                                  |
| 10^5        | 1,000,000 | 1.250                       | 1.257                                                                 |

### Invariants

1. BF1 after `add(x)`, `mayContain(x)` is true until the next `rebuild` (property test: every member of a random set is reported present)
2. BF2 the popcount never decreases between rebuilds (`checkInvariants()`: `BF2 popcount fell from … to …`; also `BF2 popcount … exceeds k · count`)
3. BF3 `mBits` is a multiple of 32 and ≥ 10 · `nDesign` (`checkInvariants()`: `BF3 mBits … must be a multiple of 32, ≥ 10 · nDesign …, and equal 32 · words`)

### Tests

`dsa/tests/bloom.test.ts` (7 edge-case tests) and `dsa/tests/bloom.prop.test.ts` (2 property tests).

- **Edge cases:**
  - an empty filter reports 1,000 hashes absent, with count 0, popcount 0 and expectedFpr 0
  - one added hash is present, and a hash differing only after byte 8 collides by design
  - a duplicate add leaves the bits unchanged, and count counts adds
  - fewer than 8 bytes and nDesign ∈ {0, −1, 1.5, NaN} throw `RANGE` in the constructor and in `rebuild`
  - rebuild clears the bits and resizes: 100 → 1,024 bits, 1,000 → 10,016, 16,384 → 163,840, 1 → 32, and `bytesAllocated = m/8`
  - h2 is forced odd: 7 distinct bits, and even h2 gives the same positions as h2 + 1
  - expectedFpr matches the formula (≈ 0.0082 at design load)
- **Property:** fast-check arrays of up to 300 hashes of 8–32 bytes, with nDesign in 1..500. It checks BF1, BF2 after every add, `count`, and `checkInvariants()`.
- **Measured false-positive rate:** 16,384 members, then 10^5 random non-members, which must land within 0.4–1.3%. The nightly run uses 10^6 non-members and 0.6–1.05% (`PLT_BLOOM_TRIALS=1000000`).
- **Seed policy:** 1,000 runs on pull requests and `PLT_PROP_RUNS=10000` nightly. fast-check prints a failing seed and path, and `PLT_PROP_SEED` and `PLT_PROP_PATH` replay them. The false-positive test uses fixed mulberry32 seeds 1 (members) and 2 (probes).
- **Dev-machine results:** all 9 pass. They also pass at the nightly settings (`PLT_PROP_RUNS=10000 PLT_BLOOM_TRIALS=1000000`).

Measured false-positive rate on the dev machine (members with mulberry32 seed 1, probes with seed 2):

| nDesign | m         | fill (popcount / m) | expected | measured, 10^5 probes | measured, 10^6 probes |
| ------- | --------- | ------------------- | -------- | --------------------- | --------------------- |
| 1,000   | 10,016    | 0.504               | 0.813%   | 0.797%                | 0.847%                |
| 10,000  | 100,000   | 0.504               | 0.819%   | 0.810%                | 0.823%                |
| 16,384  | 163,840   | 0.504               | 0.819%   | 0.907%                | 0.845%                |
| 100,000 | 1,000,000 | 0.503               | 0.819%   | 0.794%                | 0.820%                |

The fill of ≈ 0.5 matches theory: `1 − e^{−0.7} = 0.503`.

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/bloom/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:bloom:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:bloom:end -->

_Chart: `docs/evidence/dsa/bloom/chart.svg`, generated from the committed lab run (pending)._

**Dev-machine run (not the lab machine).** Re-run on the lab machine before the final defence. Setup: AMD Ryzen 5 7530U, Node v24.13.1 (V8 13.6), Linux 7.0, runner `dev`, seed 42, batch 1,000 operations per timed call, 2,400–3,600 samples per point. The load average was about 5 because other agents were running tests at the same time, so expect lower and tighter numbers on an idle lab machine.

Command: `PLT_BENCH_OUT=<dir> pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/bloom.bench.ts`

Representative run (the middle of three):

| op                       | n    | p50 ns | p95 ns | mean ns | bytes/key allocated | shape ratio t(10^5)/t(10^3) (limit 2) |
| ------------------------ | ---- | ------ | ------ | ------- | ------------------- | ------------------------------------- |
| add                      | 10^3 | 70.5   | 113.5  | 79.0    | –                   |                                       |
| add                      | 10^4 | 78.1   | 120.5  | 87.5    | –                   |                                       |
| add                      | 10^5 | 79.7   | 113.3  | 84.3    | –                   | 1.07 (pass)                           |
| mayContain (50% members) | 10^3 | 68.2   | 91.4   | 71.0    | –                   |                                       |
| mayContain (50% members) | 10^4 | 74.0   | 91.8   | 75.9    | –                   |                                       |
| mayContain (50% members) | 10^5 | 80.3   | 128.8  | 85.3    | –                   | 1.20 (pass)                           |
| memory                   | 10^3 | –      | –      | –       | 1.252               |                                       |
| memory                   | 10^4 | –      | –      | –       | 1.250               |                                       |
| memory                   | 10^5 | –      | –      | –       | 1.250               |                                       |

Over three runs the shape ratio was 1.07–1.35 for add and 0.86–1.44 for mayContain, and the mean stayed between 70 and 102 ns at every size. All of this is within the ≤ 2 shape limit and the ≤ 200 ns target of spec §7.2.

**Complexity curve.** The curve is flat: time per operation does not grow with n, which is what O(k) = O(1) predicts. The small rise from 10^3 to 10^5 is a cache effect, not an algorithmic one. The array is 1.25 KB at 10^3 (it fits in L1) and 125 KB at 10^5 (L2), and each operation makes 7 random word accesses. A tight Node loop without the bench harness measured about 60 ns per add at both 10^3 and 10^5.

### Known limits and reversal

- **No deletions.** Stale bits after chunk deletions raise the false-positive rate until the next rebuild. Beyond design load the rate climbs fast: 4.9% at 1.5 · nDesign and 13.8% at 2 · nDesign. The indexer must therefore rebuild (doubling nDesign) once live chunks exceed nDesign, as rag-semantic-search.md §3.9 requires. `expectedFpr()` exposes the current estimate so the indexer can trigger that.
- **Fixed parameters.** k = 7 and 10 bits per key are fixed by the rag spec. A different target rate would need `m = −n·ln p / (ln 2)^2` and `k = (m/n)·ln 2`, which the interface does not expose.
- **Reversal triggers:**
  - the nightly measured rate at design load exceeds 1.05%
  - the indexer needs true deletions (then a counting Bloom filter, 4 bits per counter and 4× the memory, or a cuckoo filter)
  - profiling shows the `byHash` lookup is not on the critical path, in which case the filter is dropped as unjustified extra credit

Full notes, derivations and every run: [`dsa/src/bloom/README.md`](dsa/src/bloom/README.md).

## S9 Z-order list (renumbered 1..n)

| Field                      | Value                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/zorder/index.ts` (one file; imports S6 `dsa/src/hashtable/index.ts` for wid → slot)                                                                                                                                                                                                                      |
| Owner / non-owner reviewer | R3 Shell/WM / R5 QA/DevOps                                                                                                                                                                                                                                                                                        |
| Mandatory location (§10.1) | The compositor's stacking order (Spec §9.4, WM-02; R3's 'z-order structure' of §4.1).                                                                                                                                                                                                                             |
| Used by                    | wm/compositor                                                                                                                                                                                                                                                                                                     |
| Written by                 | Claude Code (Claude Opus 5.5) on 2026-09-25 by team decision, from first principles (no package, no pilot code); owner R3 reviews, studies and defends it; implementing PR #…                                                                                                                                     |
| AI assistance              | Implementation, O(1)-curve and memory benchmark cases, and this entry were written by the assistant against the spec's interface, tests and benchmark (themselves AI-drafted, §3.1 rule 5); see the AI_USAGE.md row for 2026-09-25 (dsa implementations). Owner to record what was accepted, changed or rejected. |

### Operations and complexity

| Operation                   | Complexity                                                | Proof sketch (one line)                                                                                         | Proving test                                                    | Proving benchmark                                                                    |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| insertTop, zOf, top, bottom | O(1) (amortised expected for insertTop, expected for zOf) | link at the tail; S6 lookup of the slot; arrays double                                                          | `WM-02 an empty list has no top and no bottom`                  | `zorder.bench.ts` insertTop+remove (top) and zOf, flat n = 10 → 1,000                |
| raise, remove               | O(1) relink + O(n − p) renumber                           | only the windows between the old position and the top change (inherent in WM-02, so the walk is output-optimal) | `WM-02 raising the bottom of three renumbers all three to 1..3` | `zorder.bench.ts` raise at n = 10, 100, 1,000 (linear); raise (second from top) flat |
| lower                       | O(1) relink + O(p) renumber                               | only the window and the p − 1 below it change                                                                   | `WM-02 raising the bottom of three renumbers all three to 1..3` | –                                                                                    |
| topWhere, bottomToTop       | O(n)                                                      | one walk                                                                                                        | `DSA-ZORD-01 topWhere with no match returns undefined`          | –                                                                                    |

### Why this structure

Stacking changes are move-to-front operations: an array needs an O(n) splice per raise; a list relinks in O(1). Renumbering bounds z by n, where increment-on-raise would grow without limit (CSS `z-index` is 32-bit). Renumbering forces Θ(n − p) writes on any structure; the list's walk touches exactly those windows, and the stored z makes `zOf` O(1) where an array would need `indexOf`.

### Memory layout

Struct of arrays: `widAt`, `prev`, `next`, `z` (`Int32Array`, 16 B per slot, doubled when full, free slots chained through `next`) + S6 `OpenAddressingTable<number>` wid → slot (12 B per table slot, table capacity ≥ 2n). Used 28 B/window; allocated 41–66 B/window; measured 47–67 B/window at 10^3–10^5 (dev machine).

### Invariants

1. Z1 the z numbers are exactly {1..n}, strictly increasing from bottom to top (`dsa/zorder Z1 violated: …`)
2. Z2 list membership equals hash-table membership (`dsa/zorder Z2 violated: …`)
3. Z3 `prev`/`next` are mutually consistent, no cycle, every slot is listed or free (`dsa/zorder Z3 violated: …`)

### Tests

`dsa/tests/zorder.test.ts` (9 edge-case tests: empty list; one window raised and lowered; raising the top; raising the bottom of three, then a middle window, then lowering; removing the top, the bottom and a middle window; duplicate wid → DUPLICATE and wid −1 → RANGE; operations on a missing wid → []; 10^6 raises keep z ≤ n; topWhere order and no match). `dsa/tests/zorder.prop.test.ts` (1 model-based property against an array model: order, size, z = 1..n, top, bottom and the exact change list after every random insert/remove/raise/lower, `checkInvariants()` after every step; 1,000 runs per PR, 10,000 nightly; fast-check prints the seed and path of a failure, replay with `PLT_PROP_SEED` and `PLT_PROP_PATH`).

### Benchmark (generated)

> **Dev-machine figures.** Every number in this section was measured on a developer laptop (AMD Ryzen 5 7530U, 6 cores/12 threads, Node 24.13.1, `runner: dev`, 2026-09-25) while other build agents were running on it. **Re-run on the lab machine** and commit the JSON under `docs/evidence/dsa/zorder/` before citing any of them (spec §7.1, §7.3); `tools/dsa-report.ts` then regenerates the table between the markers.

<!-- dsa-report:zorder:start -->

| op                             | n                  | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated)          | shape ratio (limit)      |
| ------------------------------ | ------------------ | ------ | ------ | ------- | ------------------------------------------- | ------------------------ |
| raise+renumber (random window) | 10                 | 79     | 147    | 88      | –                                           | –                        |
| raise+renumber (random window) | 100                | 653    | 1,086  | 733     | –                                           | –                        |
| raise+renumber (random window) | 1,000              | 7,615  | 9,991  | 7,955   | –                                           | 82 (O(n), recorded only) |
| raise+renumber [budget n=64]   | 64                 | 440    | 768    | 485     | –                                           | budget ≤ 2,000 ns: pass  |
| insertTop+remove (top)         | 1,000              | 87     | 164    | 100     | –                                           | 0.65–1.44 (≤ 3)          |
| zOf (random window)            | 1,000              | 55     | 96     | 62      | –                                           | 1.24–1.37 (≤ 3)          |
| raise (second from top)        | 1,000              | 71     | 137    | 84      | –                                           | 1.06–1.10 (≤ 3)          |
| memory                         | 10^3 / 10^4 / 10^5 | –      | –      | –       | 47–55 / 41.0; 66.3–66.8 / 65.5; 52.4 / 52.4 | –                        |

<!-- dsa-report:zorder:end -->

Dev-machine medians of three runs (2026-09-25, Ryzen 5 7530U, Node 24.13.1, heavily loaded); to be regenerated from a lab-runner JSON run.
_Chart: `docs/evidence/dsa/zorder/chart.svg`, generated from the committed lab run (pending)._

### Known limits and reversal

- Raise is Θ(n − p) by WM-02; at the supported window counts (≤ 256) that is well under the 2 µs budget measured at n = 64. The DOM writes the compositor makes per returned change cost more than the walk.
- `lower` is O(p), the mirror image of raise.
- The arrays and the table never shrink (a desktop's window count is small and bounded); a long session that once opened thousands of windows keeps that memory until reload.
- Reversal trigger: if a profile shows z-order work above 1 ms per frame, first batch style writes; the structure itself would only change if WM-02's renumbering rule were relaxed (for example gap numbering with lazy renumbering), which the spec forbids.

Full notes, derivations and every run: [`dsa/src/zorder/README.md`](dsa/src/zorder/README.md).

## S10 Interval tree (MAY)

A static centred interval tree rebuilt at drag start, for magnetic snapping and drop targets during a window drag: build O(n log n), stab and overlap O(log n + m). **Justification rule:** it ships, and is claimed here, only if its benchmark beats the linear scan at the window counts we support (up to 256); otherwise the compositor keeps the linear scan and this entry says why. Not started.

## S11 Database B-tree and hash indexes

PostgreSQL's own B-tree and hash indexes (§10.1 row "B-tree / hash indexes: database metadata, point lookup and range scan O(log n)"); not in §10.2's list of structures the team must write. A B-tree lookup reads O(log_B n) pages. The index list (`dentries_pkey (parent_ino, name) INCLUDE (ino, d_type)`, `inodes_uid_mtime`, the hash index on `blobs(sha256)`, the pattern-ops index on lower-cased names, …) and the before/after EXPLAIN evidence for Q1–Q5 are in [DATABASE.md §6](DATABASE.md#6-indexes-and-benchmarks).

## S12 Registries on built-in `Map`/`Set` (DSA-MAP-01)

**Spec §10.2:** built-in hash tables are allowed as the hashing primitive; "the registries and tables you build on top of them are your own and must be documented".

| Registry                      | Key → value                                                                         | Operations (O(1) average)   | Owner                                    | Spec                | Where                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Directory entries             | name → tree node (inside S1)                                                        | lookup, add, remove         | R2                                       | VFS-01              | `dsa/src/tree`, `vfs/src/tree`                                     |
| Open-file table               | open-file id → `{ino, flags, offset, refcount, versionAtOpen, fence?}`              | open, dup (refcount), close | R2                                       | §10.1 hash-maps row | `vfs/src/oft/table.ts`                                             |
| Per-process fd table          | fd → open-file id                                                                   | get, set, delete            | R1                                       | §9.1                | `vfs/src/oft/table.ts` (lowest free fd, EMFILE at 256 per process) |
| Page table                    | pageId → PTE `{loc, dirty, lastAccess, size, sha256, speculative, pinned, lruSlot}` | get, set, delete            | R1                                       | §9.2, MEM-02        | `kernel/src/core/mm` (`types.ts`, `mm.ts`)                         |
| Memory-mapped handles (MAY)   | handle → `{ino, pages}`                                                             | get, set, delete            | R1                                       | MEM-08              | `kernel/src/core/mm` (`mmap` page kind; the handle table is TODO)  |
| Resident table per executor   | pid → executor-local process record                                                 | get, set, delete            | R1                                       | §9.1                | `kernel/runtime` (TODO)                                            |
| Server rate-limit buckets     | key → token bucket (bounded by S5)                                                  | get, set, evict             | R5 by CODEOWNERS (the DSA spec lists R4) | C9                  | `server/src/ratelimit/`                                            |
| Server connections and leases | osSessionId → socket; lockKey → lease                                               | get, set, delete            | R2 / R5                                  | VFS-09              | `server/src/engine/sync`, `server/src/engine/locks`                |
