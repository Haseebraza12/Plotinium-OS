# dsa/src/tree: S1 n-ary tree

| Field              | Value                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | `IMPLEMENTED = true` (2026-09-25). Every gated test passes; the benchmark numbers below come from a dev laptop and **must be re-run on the lab machine**                                                                                                                                      |
| Owner              | R2 VFS/DB                                                                                                                                                                                                                                                                                     |
| Non-owner reviewer | R1 Kernel                                                                                                                                                                                                                                                                                     |
| Must be `true` at  | v0.2.0 (P2), target W5 (spec §3.2 gate check)                                                                                                                                                                                                                                                 |
| Requirement IDs    | VFS-01, VFS-08, DSA-TREE-01…03                                                                                                                                                                                                                                                                |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S1 in §3.5, §4, §5, §8)                                                                                                                                                                                          |
| Written by         | Claude (AI assistant), 2026-09-25, under the team decision of that date that Claude writes the `dsa/` structures, disclosed in `AI_USAGE.md`. The owner (R2) studies the code and defends it in the viva. Written from first principles: no package, no pilot code, no other `dsa/` structure |

**Mandatory location.** The VFS directory hierarchy (Spec §9.3, §10.1 tree row): an n-ary tree of inodes whose directories map names to children.

**Used by.**

- `vfs/tree` (`VfsTree` wraps an `NaryTree<InodeRec>`)
- `vfs/path.ts`
- `vfs/ops` (mv, rm -r, cp -r walks)
- `vfs/fsck.ts`
- `kernel/src/core/fs/kfs.ts` (default `treeFactory`); the kernel fs test harness switches from its double to this tree when the flag is true

## Files

| File                          | What it holds                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/tree/index.ts`       | the interface and the implementation (`createTree` returns a `LinkedNaryTree`)                                                                                          |
| `dsa/tests/tree.test.ts`      | 27 edge-case tests: the 20 of spec §8.2 plus 7 added with the implementation                                                                                            |
| `dsa/tests/tree.prop.test.ts` | 3 fast-check properties: the 2 of spec §8.2 plus a name-validation differential test (1,000 runs; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay) |
| `dsa/bench/tree.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2                                                                                       |

## How it works

**Nodes.** The node objects belong to the VFS. A directory is `{id, payload, parent, name, children}` and a file or symlink is `{id, payload}`. Files have no parent pointer because a hard-linked file sits in several directories. `children === null` means "not loaded". No node stores its path or its depth.

**The registry.** Besides the nodes, the tree keeps one `Map<node, number>` holding each node's live links: 1 for a loaded directory (the root included) and 1 or more for a loaded file (hard links). The registry does three jobs:

1. `size` (T6) is a counter of the nodes whose count is positive, so it is O(1). A file linked from two directories counts once and leaves `size` only when its last link goes.
2. Every mutation checks in O(1) that its directory arguments are live. That keeps the accounting exact: nothing can be attached below a detached or evicted directory without the tree seeing it. Queries (`lookup`, `resolve`, `walk`, `isAncestor`, `depthOf`, `pathOf`) accept any directory and change nothing.
3. A directory can be attached only if it is **not** live. The root and every linked directory are live, so this single check forbids directory hard links (T3) and attaching an ancestor below its own descendant (a cycle, T4).

**Lazy deletion in the registry.** A node whose count drops to 0 stays in the Map as a _tombstone_ instead of being deleted. The Map is rebuilt without tombstones once they outnumber the live nodes. The reason is measured, not theoretical. V8's `Map` keeps a deleted entry on its bucket chain until the next rehash, so deleting and re-inserting the **same key** over and over makes every operation on that key O(n). On this laptop, `set` + `delete` of one key cost 1.3 µs in a 10^3-entry Map, 13 µs at 10^4 and 29 µs at 10^5; fresh keys stay at about 80 ns. A detach followed by a re-attach of the same node is exactly how `VfsTree.apply` performs a rename. The first version of this tree used a plain `Set` and `Map` with deletes, and its attach+detach benchmark was 2.7 µs at 10^3 and 131 µs at 10^5 per pair. With tombstones, a re-attach is an update in place: 140 to 220 ns at every size.

**Grafts.** `attach` or `setLoaded` of a detached directory that still holds loaded content validates the whole subtree first. Every directory in it must be new to the tree and reached only once, and every key must be a valid name. Only then is the subtree registered. A refused call changes nothing, because every mutation runs all of its checks before its first write.

## Operations and complexity

| Operation                   | Complexity                                               | Proof sketch                                                                                                                                                                                                                                                                               | Proving test                                                      | Proving benchmark                        |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------- |
| lookup                      | O(1) average                                             | one `Map.get` on the directory's children                                                                                                                                                                                                                                                  | `DSA-TREE-01 attach then lookup returns the node …`               | –                                        |
| attach                      | O(1) average (a file, or an empty or unloaded directory) | name check (≤ 255 steps, a constant); one registry lookup; `Map.has` + `Map.set`; one registry update. A graft of a pre-built subtree costs O(k) for its k links, the unavoidable cost of counting them                                                                                    | `DSA-TREE-01 attaching an existing name throws DUPLICATE …`       | `tree.bench.ts` attach+detach            |
| detach                      | O(1) average; O(1) amortised for a non-empty directory   | a constant number of Map operations. Detaching a loaded subtree of k links visits them once to take them out of `size`, and each was paid for when it was added (see "Amortised bounds")                                                                                                   | `DSA-TREE-01 detaching a non-empty directory drops its subtree …` | `tree.bench.ts` attach+detach            |
| resolve (d components)      | O(d)                                                     | d lookups, independent of n                                                                                                                                                                                                                                                                | `VFS-08 a 32-level chain resolves, walks and computes depth 32`   | `tree.bench.ts` resolve at depth 32 vs n |
| isAncestor, depthOf, pathOf | O(depth) (pathOf O(depth + \|path\|))                    | follow `parent` to the root; pathOf then does one join                                                                                                                                                                                                                                     | `DSA-TREE-03 a 10,000-level chain walks and checks ancestry …`    | –                                        |
| move                        | O(1) + O(depth(dst))                                     | the ancestor check walks `parent` from dst (dst lies below the moved directory exactly when that directory is on dst's parent chain), then one `delete`, one `set` and two field writes. No descendant is touched because no node stores a path or depth, and the registry does not change | `DSA-TREE-02 after moving a subtree of 10^5 nodes …`              | `tree.bench.ts` move vs subtree size     |
| walk (k loaded links)       | O(k)                                                     | explicit stack of (entry, Map iterator): each link is produced by one iterator step, and each loaded directory is pushed and popped once and gets one extra prefetch pass over its entries                                                                                                 | `DSA-TREE-01 walk pre-order and post-order …`                     | `tree.bench.ts` walk per node            |
| setLoaded                   | O(k)                                                     | validate the k entries into a new Map aside, then install and register them                                                                                                                                                                                                                | `VFS-01 setLoaded checks every entry before installing any …`     | –                                        |
| unload                      | O(1) amortised                                           | drops the entries below the directory from the accounting, then `children = null`. The VFS evicts only leaf directories (VFS spec §3.17.3), so this is the directory's own entries, each paid for by the setLoaded that loaded it                                                          | `VFS-01 unload removes the dropped entries from size …`           | –                                        |
| size, stats                 | O(1)                                                     | counters                                                                                                                                                                                                                                                                                   | `DSA-GEN-09 stats count the loaded nodes`                         | memory record                            |
| checkInvariants             | O(n)                                                     | one iterative walk plus one pass over the registry                                                                                                                                                                                                                                         | `DSA-TREE-01 checkInvariants names T1, T3, T5 and T6 …`           | –                                        |

### Amortised bounds (potential method, CLRS ch. 17)

Let L be the number of live links (entries in loaded children maps, `#links`) and T the number of tombstones. Let c be a constant that bounds the work of one Map or registry step, and define

Φ = 3c · L + 2c · T.

Φ starts at 0 and never goes negative, so the sum of the amortised costs bounds the actual total.

- **`attach` of a file or an empty or unloaded directory.** Actual ≤ c. L grows by 1 and T does not grow (reviving a tombstone shrinks it), so the amortised cost is ≤ 4c = O(1).
- **`setLoaded` of k entries, or a graft of k links.** Actual ≤ ck and ΔΦ ≤ 3ck, so amortised O(k).
- **`detach` or `unload` that drops m links in total.** Actual ≤ c(1 + m). L falls by m, and each dropped link creates at most one tombstone, so ΔΦ ≤ −3cm + 2cm = −cm. The amortised cost is ≤ c = **O(1)**.
- **Registry rebuild.** It runs when T > live, and its actual cost is ≤ c(live + T) < 2cT. It sets T to 0, so ΔΦ = −2cT and the amortised cost is ≤ 0. After every operation T ≤ live, so the registry holds at most 2 · size entries.
- **`move`.** Actual O(depth(dst)) and ΔΦ = 0.

### Why the walk makes an extra pass (memory-level parallelism)

On a tree larger than the CPU caches, each node the walk reaches costs a cache miss. The miss is to read the child's shape for the directory test, plus the Map header for a subdirectory. Between two `yield`s the CPU can only wait for these misses one at a time. `prefetchChildren` reads those fields for all children of a directory in one tight loop. The loads are independent, so their misses overlap, and the walk then finds the data in cache. It changes no state and keeps the walk O(k).

Measured best-of-7, interleaved, on the random 10^5-node benchmark tree: 158 to 164 ns/node with the pass against 205 to 212 without it (about 23% faster). At 10^3, where everything is already in cache, it costs about 13 ns/node (66 vs 53).

## Invariants (`checkInvariants()`; each failure message starts with its id)

1. T1 `root.parent === null` and `root.name === ''`
2. T2 every directory child's `parent` and `name` match its map entry
3. T3 every non-root directory is in exactly one parent's map (checked before T2, so a directory linked twice reports T3, and the check terminates on a cyclic structure)
4. T4 parent chains reach the root within `size` steps. Directories are checked in discovery order, each one's parent already known to reach the root. This follows from T2 and T3 but is checked directly
5. T5 every key is a valid name: 1–255 UTF-8 bytes, no `/`, no U+0000, not `.` or `..`. It is also enforced on entry by `attach`, `move` and `setLoaded`, and the byte count is tested against `TextEncoder` by a property test
6. T6 `size` equals the number of distinct loaded nodes. The registry must also hold exactly count 1 for every loaded directory and the link count for every loaded file; its live and tombstone counters must match; tombstones ≤ live; and the link counter must match

## Tests

- **Edge cases (`tree.test.ts`, 27).** The 20 from spec §8.2:
  - root-only tree; empty directory; attach then lookup; duplicate name; missing name; detach and move of the root;
  - move into a descendant; same-place move as a no-op; rename keeping identity; a 10^5-node subtree move touching one parent pointer;
  - hard link walked under both directories; NOT_LOADED then setLoaded; NOT_DIR mid-path; unload; the pre- and post-order sequences;
  - a 32-level chain; a 10,000-level chain without a stack overflow; a 255-byte UTF-8 name and case-distinct names; a corrupted parent pointer (T2); stats.

  Added with the implementation (7):
  - detaching a non-empty directory with a hard link out of it, then grafting it back;
  - attach refusals (root, ancestor, self, a second link, seven invalid names, the 255-byte astral boundary, NOT_LOADED);
  - a graft with a cycle or a live directory inside;
  - move NOT_FOUND, NOT_LOADED and an invalid new name;
  - unload with hard links, and unload of the root;
  - setLoaded atomicity and a preloaded subdirectory;
  - checkInvariants naming T1, T3, T5 and T6.

- **Properties (`tree.prop.test.ts`, 3).**
  - Random mkdir/create/link/unlink/rmdir/mv sequences against a path-set model, with `checkInvariants()`, the full walk and `size` compared after every step.
  - Moving an ancestor under a descendant is always refused.
  - Added: name validation is differential against `TextEncoder` over arbitrary strings, including surrogate pairs and lone surrogates.
- **Seed policy.** fast-check prints the seed and path of any failure; replay with `PLT_PROP_SEED` and `PLT_PROP_PATH`. The property file sets a per-test timeout of `max(5 s, 20 ms × runs)`. The spec's nightly 10,000 runs take about 20 s, beyond Vitest's default 5 s. Verified with `PLT_PROP_RUNS=10000`: all 3 pass.
- **Coverage.** 99.2% of lines and 91% of branches of `index.ts` from the two tree test files. The uncovered lines are the defensive T4 and T6 throws that T2 and T3 make unreachable.

## Benchmark

Commands:

- PR sizes: `PLT_BENCH_SIZES=1000,10000 NODE_OPTIONS=--expose-gc pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/tree.bench.ts`
- Nightly sizes: the same without `PLT_BENCH_SIZES`.
- Add `PLT_BENCH_OUT=docs/evidence/dsa` to write the §7.3 JSON lines.

> **Dev-machine figures, not lab figures.** AMD Ryzen 5 7530U laptop (6 cores/12 threads, 16 MiB L3), Node v24.13.1, runner `dev`, 2026-09-25. About 20 other agents were running builds and benchmarks at the same time (load average 9–20 on 12 threads), so the spread between runs is large. **Re-run on the lab machine** and commit that JSON run before citing these numbers in `DSA.md`.

Means in ns per operation over three full runs (min–max), with the shape ratio t(largest)/t(smallest) of each run:

| Operation                                           | n = 10^3 | n = 10^4 | n = 10^5 | Shape ratio (limit)                 | Curve                                                     | Budget (lab)                                      |
| --------------------------------------------------- | -------- | -------- | -------- | ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| resolve at depth 32                                 | 399–528  | 508–619  | 448–624  | 1.12 / 1.15 / 1.18 (≤ 2) pass       | flat: O(d) with d = 32 fixed                              | mean ≤ 5 µs: met                                  |
| attach + detach (per pair)                          | 138–480  | 145–222  | 201–389  | 1.60 / 0.81 / 1.13 (≤ 2) pass       | flat: O(1)                                                | ≤ 0.5 µs: met (one noisy 480 ns mean, p50 243 ns) |
| walk, per node                                      | 75–130   | 77–273   | 172–240  | 2.48 / 1.84 / 2.10 (≤ 2) **1 of 3** | linear total time, per-node cost rising with cache misses | ≤ 100 ns/node: met at 10^3 only                   |
| move vs subtree size (10 / 10^3 / 10^5 descendants) | 139–214  | 120–172  | 150–189  | 0.87 / 0.88 / 1.36 (≤ 2) pass       | flat: O(1) + O(depth(dst) = 32)                           | mean ≤ 2 µs: met                                  |

PR-size run (10^3 vs 10^4, as run on every pull request): resolve 1.32, attach+detach 1.33, walk 1.33, move 0.86. **All pass.**

**Bytes per loaded node** (`measureBytesPerEntry` with `--expose-gc`), everything the benchmark builds: node objects, id and name strings, directory Maps, children entries and the registry.

| n    | measured  | stats() estimate (tree bookkeeping only) |
| ---- | --------- | ---------------------------------------- |
| 10^3 | 185–199 B | 48 B                                     |
| 10^4 | 213–215 B | 48 B                                     |
| 10^5 | 204 B     | 48 B                                     |

The `stats()` estimate counts 24 B per children-Map entry and 24 B per registry entry (key, value and chain link, 8 bytes each, no pointer compression).

**Reading the walk result.** The walk is O(k): per node, one iterator step, one entry object and a constant number of loads. The per-node time still roughly doubles from 10^3 to 10^5 on this laptop because the 10^5-node tree (about 20 MB) no longer fits in the 16 MiB L3 cache. The benchmark also allocates nodes in random order, so each node reached is a cache miss.

The effect is not algorithmic:

- a plain loop with no generator, allocation or yield shows the same jump (14 → 108 ns/node);
- building the same tree with nodes allocated in walk order cuts the 10^5 cost from 271 to 183 ns/node;
- with the same number of steps per node, only memory latency changes.

The VFS loads a directory's children together (`setLoaded`), so its layout is closer to the favourable case. The ratio passes at the PR sizes and passed 1 of 3 full runs. The nightly full-size assertion is meant for the lab runner, and it should be read from there.

## Known limits and reversal

- **Same-name churn in one large directory.** The children maps are built-in `Map`s, as spec §10.2 requires and as the VFS reads directly. Re-creating and deleting the same name over and over in a directory with m entries lengthens that key's V8 bucket chain until the Map's next rehash, costing up to O(m) per operation between rehashes. The registry avoids this with tombstones; the children maps cannot, because `children.get(name)` must return `undefined` for a deleted name. The benchmark directory holds at most 20 entries, so the effect is bounded there. Reversal trigger: a lock-file pattern in a directory of more than 10^4 entries shows in profiles. The fix is then a periodic copy of that one Map, O(m) every m deletions.
- **Grafts are O(k).** Attaching a detached directory that still holds loaded content registers every link in it. `VfsTree.apply` performs a rename as detach + attach, so a rename of a loaded directory with k loaded links costs O(k) there. `tree.move` does the same re-link in O(1) + O(depth), so the VFS should use it for renames (a VFS change, reported to R2).
- **Stricter than the VFS test double.** The real tree throws INVALID where the double silently corrupted the structure: a directory linked twice, a mutation below a directory that is no longer loaded, `setLoaded` of an already loaded directory, or an invalid name. The kernel fs suite (79 tests) and the whole kernel (395) and vfs (222) projects pass against it.
- **Resolution** is O(depth), bounded by the 4,096-byte path limit. If a resolve budget is missed, the VFS adds a dentry cache in front of the tree (an S12 registry), never a path-keyed structure.

## `DSA.md` entry (spec §3.6), filled

Copy this into `DSA.md`. The benchmark table between the markers is generated by `tools/dsa-report.ts` from the lab run, and the rows shown are the dev-machine run above.

```markdown
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

<!-- dsa-report:tree:start -->

| op                       | n           | p50 ns    | p95 ns    | mean ns   | bytes/entry (measured / allocated) | shape ratio (limit)                 |
| ------------------------ | ----------- | --------- | --------- | --------- | ---------------------------------- | ----------------------------------- |
| resolve depth 32         | 10^3 / 10^5 | 393 / 432 | 435 / 584 | 399 / 448 | –                                  | 1.12 (2)                            |
| attach+detach            | 10^3 / 10^5 | 136 / 197 | 166 / 240 | 138 / 220 | –                                  | 1.60 (2)                            |
| walk per node            | 10^3 / 10^5 | 68 / 187  | 103 / 221 | 75 / 187  | –                                  | 2.48 (2), dev laptop; PR sizes 1.33 |
| move (subtree 10 / 10^5) | –           | 155 / 140 | 245 / 155 | 173 / 150 | –                                  | 0.87 (2)                            |
| memory                   | 10^5        | –         | –         | –         | 204 / 48                           | –                                   |

<!-- dsa-report:tree:end -->

<chart: docs/evidence/dsa/tree/chart.svg>

### Known limits and reversal

Re-creating one name repeatedly in a directory of m entries costs up to O(m) between V8 Map rehashes (built-in Map required by §10.2); the registry avoids the same effect with tombstones. A detach + attach rename in `VfsTree.apply` re-counts a loaded subtree (O(k)); `tree.move` is O(1) + O(depth). The walk is O(k) but memory-latency bound beyond the L3 cache. Resolution is O(depth), bounded by the 4,096-byte path limit; if a resolve budget is missed, the VFS adds a dentry cache in front of the tree, never a path-keyed structure.
```

## Rules

1. Written from first principles. No npm package and no pilot code stands in for it (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and the implementation was written by Claude. `AI_USAGE.md` records this, and the owner records what they changed and why (spec §3.1 rule 5).
