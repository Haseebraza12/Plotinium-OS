# dsa/src/trie: S2 radix trie (struct of arrays, namespaced)

| Field              | Value                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Status             | `IMPLEMENTED = true` (2026-09-25): the full edge-case suite, the property tests and the benchmark pass |
| Owner              | R3 Shell/WM                                                                                            |
| Non-owner reviewer | R4 AI                                                                                                  |
| Must be `true` at  | v0.2.0 (P2), target W5 (spec §3.2 gate check)                                                          |
| Requirement IDs    | SYS-03, DSA-TRIE-01…03                                                                                 |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S2 in §3.5, §4, §5, §8)   |

**Mandatory location.** Terminal autocomplete over commands, paths, flags and history (Spec §9.6, §10.1 trie row; SYS-03: p95 ≤ 1 ms over ≥ 10,000 entries, updated incrementally).

**Used by.**

- the `complete` process (executor, priority 36)
- `apps/shell` completion client
- `man -k`

**Written by.** The team decided on 2026-09-25 that Claude would write the S2 implementation, and that decision is disclosed in `AI_USAGE.md`. The code is first-principles: it imports no package and copies no pilot code. The owner (R3) must study it and be able to explain every invariant in the viva. The comments at each invariant are written for that purpose.

## Files

| File                          | What it holds                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/trie/index.ts`       | the normative interface (`Trie`, `NamespacedTrie`, `Completion`, `TrieStats`, `TrieCorruption`), `IMPLEMENTED`, and re-exports of the two classes |
| `dsa/src/trie/radix-trie.ts`  | `RadixTrie`: the struct-of-arrays radix trie (insert, remove, has, complete, removePrefix, compact, stats, checkInvariants, debugCorrupt)         |
| `dsa/src/trie/namespaced.ts`  | `NamespacedRadixTrie`: the four namespaces `cmd`, `path`, `flag`, `hist` on four `RadixTrie` instances                                            |
| `dsa/tests/trie.test.ts`      | the complete edge-case suite of spec §8 (24 tests)                                                                                                |
| `dsa/tests/trie.prop.test.ts` | fast-check model-based and differential property tests (1,000 runs; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay)         |
| `dsa/bench/trie.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2                                                                 |

## How to run

```bash
pnpm exec tsc -p dsa/tsconfig.json --noEmit
pnpm exec vitest run --project dsa dsa/tests/trie.test.ts dsa/tests/trie.prop.test.ts
PLT_PROP_RUNS=10000 pnpm exec vitest run --project dsa --testTimeout 300000 dsa/tests/trie.prop.test.ts   # nightly size
NODE_OPTIONS=--expose-gc pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/trie.bench.ts
PLT_BENCH_OUT=docs/evidence/dsa NODE_OPTIONS=--expose-gc pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/trie.bench.ts   # write §7.3 JSON lines
```

Benchmarks run in the `dsa (bench)` project. `--project dsa` matches only the test files.

## How it works (for the viva)

**Shape.** This is a radix trie (PATRICIA-style). Every chain of single-child, non-terminal nodes is contracted into one edge whose label is a string. As a result, every non-root node is either a key (terminal) or has at least 2 children (R1). A rooted tree like that with n keys has at most 2n − 1 non-root nodes, so at most 2n nodes with the root. On the benchmark corpora the measured figure is 1.16–1.65 nodes per key.

**Layout.** A node is an integer id into seven parallel typed arrays, with no object per node. Children use the left-child/right-sibling representation, and each sibling list is sorted by the label's first code unit.

| Array      | Type          | Bytes      | Meaning                                                                       |
| ---------- | ------------- | ---------- | ----------------------------------------------------------------------------- |
| `lblStart` | `Int32Array`  | 4          | start of the node's edge label in `pool`                                      |
| `lblLen`   | `Uint16Array` | 2          | label length in UTF-16 code units (≤ 65,535)                                  |
| `first`    | `Uint16Array` | 2          | first code unit of the label, so a sibling scan never reads `pool`            |
| `child`    | `Int32Array`  | 4          | first child, −1 = none                                                        |
| `next`     | `Int32Array`  | 4          | next sibling, −1 = none; for a free node, the next free node                  |
| `term`     | `Uint8Array`  | 1          | 1 if a key ends here                                                          |
| `meta`     | `Int32Array`  | 4          | slot in `metas` (the key's `kind`/`detail`), −1 = none                        |
| `pool`     | `Uint16Array` | 2 per unit | every label, as ranges of one array; `poolLen` handed out, `poolGarbage` dead |

That makes 21 bytes per node plus 2 bytes per label unit. Node 0 is the root and has an empty label. Freed node ids go on a free list threaded through `next` and are reused first, so insert/remove churn never grows the arrays. The arrays double when full (amortised O(1) per node).

**Descend.** Scan the children of the current node for the one whose `first` equals the next code unit, stopping early at a larger `first` because siblings are sorted. Then compare the rest of that child's label unit by unit.

**Insert** (§5 S2) has three cases:

- (a) The word ends exactly at a node: set `term` and store the meta.
- (b) The word leaves or ends inside an edge label after j units: **split**. A new node `mid` takes the first j units of the same pool range, with no copy. It replaces the old child in the sibling list, and the old child keeps the rest of its label and its whole subtree under `mid`. The rest of the word becomes a new leaf under `mid`, placed in sorted position; if nothing is left, `mid` itself is the key.
- (c) No edge starts with the next code unit: append the rest of the word to the pool as a new leaf in sorted position.

**Remove.** Descend while recording `pathNode[d]` and `pathPrev[d]` (the node at each depth and its previous sibling). Clear `term`, then:

- If the node is now a childless non-terminal, unlink it in O(1), since its previous sibling is known, and free it.
- If the surviving node is non-root, non-terminal and has exactly one child, **merge** it with that child. The labels are concatenated: in place when adjacent in the pool, which is always true right after a split; otherwise by appending, with the old units counted as garbage.

**complete(prefix, k).** First find the locus, the highest node whose spelled string starts with the prefix. The prefix may end inside the locus's label. Then run a pre-order DFS below it with an explicit stack of one entry per depth. Because siblings are sorted by first code unit, pre-order is lexicographic (code-unit) order, and a key comes before its extensions (`ls` before `lsof`), so no sort is needed. The DFS stops after k keys. Each result's text is the caller's `prefix` followed by the units spelled after it, so only the suffix is ever converted to a string.

**removePrefix.** Find the locus as `complete` does, unlink it, free its subtree with an explicit stack (O(m)), then prune and merge above it exactly as `remove` does. `removePrefix('')` frees every subtree of the root and keeps the root.

**Pool and compaction.** Live label ranges never overlap, so `poolLen − poolGarbage` equals the sum of live label lengths (R8). A freed label at the end of the pool is handed back directly by lowering `poolLen`; anywhere else it becomes garbage. When `poolGarbage > poolLen / 2`, `compact()` copies every live label, in DFS order, into a fresh pool of twice the live size. It never makes the pool smaller than the constructor's capacity, nor larger than the old pool.

**Key metadata.** `insert(word, meta)` stores `meta` without its `text`, because the path from the root already spells the key; storing it would duplicate every key. `complete` returns `{ text, ...meta }` as a fresh object, so callers cannot corrupt the trie. Plain `insert(word)` stores nothing and returns `{ text }`.

**Long labels (edge case).** `lblLen` is 16-bit, so a new key suffix longer than 65,535 units becomes a chain of full-length labels. Such a chain link is a unary non-terminal node, so R1 exempts exactly the unary nodes that cannot merge with their only child (`lblLen[n] + lblLen[child] > 65,535`). Plotinium keys are at most 4,096 + 37 units, so this never happens in production. A scratch differential run with keys up to 3·65,535 + 5 units checked invariants after each of 3,600 operations to confirm the code handles it.

**No recursion.** Every walk (complete, compact, removePrefix, checkInvariants) uses an explicit stack, so a 4,136-unit key cannot overflow the call stack.

## Operations and complexity

L = key length, P = prefix length, k = results, m = nodes removed, σ = distinct first code units among siblings (bounded by the alphabet), D = depth in nodes (≤ the longest key).

| Operation           | Complexity                          | Proof sketch                                                                                                                                                                                                                | Proving test                                                      | Proving benchmark                                       |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| insert              | O(L) (+ O(σ) per level)             | one descent comparing code units; a split is O(1) node work and reuses the pool range; the new leaf's append is O(L)                                                                                                        | `DSA-TRIE-01 inserting keys that diverge at every offset …`       | `trie.bench.ts` insert+remove                           |
| remove              | O(L) (+ O(σ) per level)             | descent with the path recorded; the unlink is O(1) because the previous sibling is recorded; a merge is O(1) node work plus at most an O(L) label copy                                                                      | `DSA-TRIE-01 removing the shorter of two keys merges nodes …`     | `trie.bench.ts` insert+remove                           |
| has                 | O(L)                                | one descent                                                                                                                                                                                                                 | `DSA-TRIE-01 one key completes for every prefix …`                | –                                                       |
| complete(prefix, k) | O(P + k) (precisely O(σ·P + k + D)) | locus in O(σ·P); in the DFS region before the k-th emission, every fully explored non-terminal node has ≥ 2 visited children, so the region has ≤ 2k − 1 such nodes plus ≤ D on the frontier path; **nothing depends on n** | `DSA-TRIE-01 a prefix ending inside an edge label …`              | `trie.bench.ts` complete p95 vs n, linear-scan baseline |
| removePrefix        | O(P + m)                            | locus in O(σ·P), then an iterative free of the m nodes below                                                                                                                                                                | `DSA-TRIE-01 removePrefix of an absent prefix …`                  | –                                                       |
| compact             | O(live label units), amortised O(1) | it runs only once ≥ poolLen/2 garbage units exist, and each unit was created by an earlier O(L) operation                                                                                                                   | `DSA-TRIE-01 removing the only key … compaction empties the pool` | `trie.bench.ts` memory                                  |

## Invariants (`checkInvariants()`; each failure message names its id)

1. R1 every non-root node is terminal or has ≥ 2 children (exception: a long-label chain link that cannot merge, see above)
2. R2 every non-root node has `lblLen ≥ 1` and `first[n] === pool[lblStart[n]]`, and its label lies inside the pool
3. R3 siblings have strictly increasing `first`
4. R4 every leaf is terminal
5. R5 `size` equals the number of terminal nodes, and a meta slot is set only on a terminal node
6. R6 the spelled key set equals the inserted keys (checked by the property test)
7. R7 free-list nodes are unreachable, no node is reachable twice, and reachable + free = allocated = the live-node counter
8. R8 `poolLen − poolGarbage` equals the sum of reachable label lengths

`debugCorrupt('unsorted-siblings')` breaks only R3, and `debugCorrupt('unary-node')` breaks only R1. The unary corruption skips the root, because R1 does not apply to it.

## Benchmark results (dev machine; re-run on the lab machine)

> **These numbers are from a developer laptop, not the lab machine.** The CPU is an AMD Ryzen 5 7530U (6 cores / 12 threads), running Node v24.13.1 and V8 13.6 on Linux 7.0. During the run, other agents' test suites were running in parallel (load average about 6). Re-run `vitest bench` on the lab runner for `DSA.md` (spec §7.3, final defence).

The seed is 42 (`mulberry32`). Each query is a prefix of length 1–10 of an existing key (after the fixed `dirIno/` or `uid\0` part), 10% of queries are misses, and each returns at most 20 completions. Times are ns per operation.

**`complete(prefix, 20)`: SYS-03 hard limit p95 ≤ 1 ms (1,000,000 ns); target p95 ≤ 100 µs.**

| Namespace | n = 10^3 mean / p95 | n = 10^4 mean / p95 | n = 10^5 mean / p95 | SYS-03                                    |
| --------- | ------------------- | ------------------- | ------------------- | ----------------------------------------- |
| `path`    | 1,594 / 3,947       | 2,680 / 6,302       | 3,915 / 7,765       | pass (p95 ≤ 7.8 µs, 128× under the limit) |
| `cmd`     | 758 / 3,186         | 1,259 / 4,187       | 1,737 / 4,909       | pass                                      |
| `flag`    | 2,074 / 6,522       | 2,215 / 5,491       | 3,427 / 8,305       | pass                                      |
| `hist`    | 2,136 / 4,899       | 2,733 / 5,370       | 3,882 / 7,163       | pass                                      |

**The flat curve against the naive baseline (`path` workload, shape test):**

| n                     | trie mean | trie p95           | linear-scan mean | linear-scan p95 |
| --------------------- | --------- | ------------------ | ---------------- | --------------- |
| 10^3                  | 1,339     | 3,307              | 189,542          | 267,438         |
| 10^4                  | 2,072     | 3,657              | 1,866,347        | 2,316,078       |
| 10^5                  | 2,533     | 4,329              | 17,560,792       | 23,619,238      |
| **ratio 10^5 / 10^3** | **1.89**  | **1.31** (limit 3) | **93**           | **88**          |

The trie's p95 is flat: it grows 1.31× while n grows 100×. The linear-scan baseline (`filter(startsWith).sort().slice(0, 20)`) grows about 90×, and at 10^5 the trie is about 5,500× faster at p95. The mean grows slightly more than p95 because the workload is not the same at each size. At 10^3, many length-1–10 prefixes match fewer than 20 keys, so the mean result count k is 6.8, against 11.7 at 10^4 and 12.3 at 10^5. The cost follows k, as O(P + k) predicts, not n.

**insert + remove (`path`, keys of about 50 units, batches of 100 pairs):** the mean per pair is 584 → 637 → 850 ns (ratio 1.46, limit 3), and p95 is 1,273 → 708 → 963 ns. That is about 0.3–0.4 µs per operation, against the mean target of ≤ 5 µs.

**Run-to-run variation.** Across 7 benchmark runs of the final code on this shared machine (load average 6–19), the `path` p95 shape ratio ranged from 0.99 to 1.42, with one outlier of 3.30 during a load spike. The p95 was always ≤ 17 µs, far below the 1 ms hard limit. The shape assertion should be judged on the lab runner.

**Memory (DSA-TRIE-03: ≤ 32 MB per namespace at 10^5, reversal trigger 6; target ≤ 128 B/entry for `path:`; kernel-record target about 24 MB at 10^5 path entries).**

| Namespace                                     | bytes/entry allocated (10^3 / 10^4 / 10^5) | used               | measured* at 10^5 | total at 10^5 | nodes per key at 10^5 |
| --------------------------------------------- | ------------------------------------------ | ------------------ | ----------------- | ------------- | --------------------- |
| `path`                                        | 60.5 / 47.6 / 48.5                         | 40.9 / 37.4 / 36.9 | 49.0              | **4.6 MB**    | 1.26                  |
| `cmd`                                         | 60.5 / 47.6 / 38.0                         | 37.6 / 34.5 / 33.7 | 38.4              | 3.6 MB        | 1.16                  |
| `flag`                                        | 60.5 / 60.7 / 76.0                         | 44.0 / 44.0 / 44.0 | 76.5              | 7.3 MB        | 1.40                  |
| `hist`                                        | 60.5 / 47.6 / 65.5                         | 46.7 / 39.2 / 37.0 | 66.0              | 6.3 MB        | 1.40                  |
| `path` via `addPath` with `{ kind }` metadata | –                                          | –                  | 74.7              | 7.1 MB        | 1.26                  |

- _Allocated_ is the capacity of the typed arrays: node slots × 21 B, pool capacity × 2 B, and the scratch arrays. _Used_ counts live nodes × 21 B plus `poolLen` × 2 B. Allocated steps up where an array has just doubled (for example `flag` at 10^5, whose node capacity went from 131,072 to 262,144).
- _Measured_ is Δ(`heapUsed` + `arrayBuffers`) / n, taken from a probe that awaits between `gc()` calls (see Known limits). At 10^5 it agrees with _allocated_ to within 1%, which confirms that the typed arrays are the whole cost. The last row is the real VFS usage: each key also keeps a small `{ kind }` object, about 26 B per entry.
- At 10^5, `path:` uses 4.6 MB, or 7.1 MB with metadata. That is about 5× under the kernel record's ~24 MB target and 4.5× under the 32 MB hard limit, and 49–75 B/entry is well under the 128 B/entry target. For comparison, the pilot's Map-per-node trie needed 492.7 MB _(pilot figure; re-measure on the lab machine)_.

## `DSA.md` entry template (spec §3.6)

Copy this into `DSA.md`. The benchmark table between the markers is generated by `tools/dsa-report.ts` from a lab-runner JSONL run.

```markdown
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

<!-- dsa-report:trie:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:trie:end -->

<chart: docs/evidence/dsa/trie/chart.svg>

### Known limits and reversal

The sibling scan is O(σ) per level. On a CJK-heavy corpus, σ could reach thousands. If the S2 benchmark on such a corpus misses its budget, child lookup moves to an S6 table keyed by `(node, codeUnit)` (about 24 B per edge), as spec §3.5 keeps in reserve. Labels longer than 65,535 units become chains (R1 exemption). Arrays never shrink implicitly; the pool shrinks only on compaction.
```

## Known limits and notes

- **Harness memory probe.** `measureBytesPerEntry` in `_shared/mem.ts` takes its snapshots synchronously. V8 sweeps dead objects and frees ArrayBuffer backing stores concurrently after `gc()`, so the previous fixture's memory can be released between the two snapshots, and the recorded _measured_ column is then too low or even negative. A synchronous probe stayed off by up to about 160 B/entry however many `gc()` calls it made; an async probe that awaited 30 ms between three `gc()` calls agreed with _allocated_ to within 1%. The measured numbers above come from that probe. The harness owner should make `measureBytesPerEntry` async, or `await` a macrotask between its `gc()` calls. `trie.bench.ts` already flattens its template-literal keys before measuring (see the note in the test), which removed the larger negative bias.
- **Property tests at 10,000 runs** take about 22 s, beyond vitest's 5 s default timeout. The nightly job needs `--testTimeout` (all runs pass: seeds 1, 7, 42 and 1234 at 10,000 runs each).
- **`stats().capacity`** reports node slots. A key needs at most two, so `capacity / 2` keys always fit without growth.
- **`stats().bytesAllocated`** counts the typed arrays, the pool and the scratch arrays. It excludes the `metas` objects (about 26 B per key with metadata); the measured column includes them.
- **Reversal trigger** (spec §3.5): a CJK-heavy corpus with long sibling lists moves child lookup to an S6 `(node, codeUnit)` table.

## Rules

1. The code is first-principles work: no npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and so was this implementation, by team decision on 2026-09-25. `AI_USAGE.md` records this, and the owner records what they changed and why (spec §3.1 rule 5).
