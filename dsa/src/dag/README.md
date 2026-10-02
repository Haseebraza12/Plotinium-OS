# dsa/src/dag: S4 DAG with Kahn's topological sort

| Field              | Value                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Status             | `IMPLEMENTED = true` (2026-09-25). Interface, edge-case tests, property tests and benchmark all run against the implementation |
| Owner              | R5 QA/DevOps                                                                                                                   |
| Non-owner reviewer | R2 VFS/DB                                                                                                                      |
| Must be `true` at  | v0.2.0 (P2), target W3 (spec §3.2 gate check)                                                                                  |
| Requirement IDs    | BOOT-03, BOOT-04, DSA-DAG-01…03                                                                                                |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S4 in §3.5, §4, §5, §8)                           |

**Mandatory location.** Service dependencies and boot order (Spec §6.4, §10.1 DAG row; BOOT-03, BOOT-04) and application start-up dependencies.

**Used by.**

- `services/svcmgr` (boot, shutdown, progress closure)
- `kernel/core/proc/spawn` (app closure)
- `bootlog --critical-path`
- `svc.verify`

## Files

| File                         | What it holds                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/dag/index.ts`       | the implementation: `buildDag`, `topoLevels`, `CycleError`, `UnknownNodeError`, the `Dag` and `KahnCursor` interfaces                        |
| `dsa/tests/dag.test.ts`      | the edge-case suite of spec §8.5 (17 tests: empty, one element, duplicates, removal of the root or head, and the rest)                       |
| `dsa/tests/dag.prop.test.ts` | fast-check property tests (3 properties, 1,000 runs each; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay)              |
| `dsa/bench/dag.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertion of spec §7.2, the app-closure and 18-service budgets, and bytes per node |

`dsa/tests/scaffold.test.ts` turned its `dsa/dag` row off when the flag flipped.

## How the code is organised (read `index.ts` top to bottom)

| Function      | Step of §5 S4            | What to be able to explain in the viva                                                                                                                                                               |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildDag`    | build 1–2                | one `Map.set` per name (a repeat leaves `size` unchanged, so that is the duplicate test); one `Map.get` per requirement fills the requirements half row by row                                       |
| `transpose`   | build 3                  | two counting passes: count the row lengths, prefix-sum them into row starts, then drop every v into the rows of its neighbours. v runs in increasing order, so every dependents row comes out sorted |
| `firstRepeat` | build 2 (duplicate edge) | sorted rows put a repeated edge u→v as two equal neighbours in row u, so one sequential scan finds it                                                                                                |
| `kahn`        | Kahn with levels         | the FIFO queue is the output order; `level[w]` is relaxed on every edge and is final when w is appended                                                                                              |
| `cyclePath`   | cycle path               | walk to the smallest-named remaining predecessor until a node repeats; cut the tail; reverse, rotate, close                                                                                          |
| `finish`      | –                        | in-degrees, Kahn, then either `CycleError` or the graph; shared by `buildDag` and `reversed()`                                                                                                       |
| `CsrDag`      | –                        | the immutable graph: queries, `ancestors`, `reversed`, `cursor`, `checkInvariants`, `stats`                                                                                                          |
| `CsrCursor`   | cursor                   | Kahn one completion at a time, for asynchronous service starts                                                                                                                                       |

### Error order

`buildDag` checks, in this order: a repeated name (`DUPLICATE`, first in input order), an unknown requirement (`UnknownNodeError`, first in input order), a repeated requirement (`DUPLICATE`), a self-loop (`CycleError([a, a])`, smallest name), and finally a longer cycle (`CycleError(path)`). So a cycle is only reported for a structurally valid input, and which cycle is reported depends on the names, not on the input order (`DSA-DAG-02 two disjoint cycles report the same one on every run` runs the input reversed as well).

## Operations and complexity

| Operation                                    | Complexity                  | Proof sketch                                                                                                                   | Proving test                                              | Proving benchmark                              |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------- |
| buildDag (index + CSR + Kahn + levels)       | O(V + E)                    | V `Map.set`, E `Map.get`; two counting passes over E entries; each node enqueued and dequeued once, each edge decremented once | `DSA-DAG-01 random DAGs (500 nodes) …` (property)         | `dag.bench.ts` ns per (V + E)                  |
| cycle path                                   | O(V + E)                    | each walk step scans one predecessor list and no node is visited twice before the repeat; pigeonhole gives the cycle           | `BOOT-04 a 2-cycle and a 3-cycle are reported …`          | –                                              |
| cursor().complete(v)                         | O(outdeg v)                 | decrement v's dependents                                                                                                       | `DSA-DAG-03 the cursor rejects completing a node twice …` | –                                              |
| ancestors(targets)                           | O(V + E)                    | iterative DFS over `requires`; a node is marked when pushed, so it is pushed at most once                                      | `DSA-DAG-03 the shipped 18 service manifests …`           | `dag.bench.ts` app closure at 8, 32, 128 nodes |
| reversed()                                   | O(V + E)                    | swap the two CSR halves, re-sort the new dependents rows by one `transpose`, run Kahn                                          | `DSA-DAG-03 reversed topological order …`                 | –                                              |
| name, indexOf, levelOf, requires, dependents | O(1)                        | array read, `Map.get`, or a subarray view of a CSR row                                                                         | unit tests                                                | –                                              |
| topoOrder, levels                            | O(V) first call, O(1) after | copied out of the typed arrays once (levels by a counting sort on `level`), then cached and frozen                             | `DSA-DAG-01 a diamond gives levels …`                     | `dag.bench.ts` (build + levels)                |

## Proofs

**Kahn is O(V + E).** A node is appended to the queue only when its pending in-degree drops to 0 (or starts at 0), which happens once, and the head only moves forward, so each node is popped at most once. Popping u scans u's dependents row once and decrements each edge once. The counting passes of `transpose` touch each entry of an E-array twice and each row start once. So the whole build is O(V + E) whether or not a cycle stops Kahn early.

**Kahn outputs all V nodes iff the graph is acyclic.** If there is a cycle, no node on it can reach pending 0 before another cycle member is output, so none is ever output. If the output is short, every remaining node still has pending ≥ 1, and pending counts exactly the predecessors that were not output (an output node decrements its edges when it pops). So every remaining node has a remaining predecessor, and walking backwards from any of them forever must repeat a node: a cycle.

**The order is topological.** A node is appended only after all its predecessors have popped, and pops happen in append order.

**Levels are longest paths (D3).** When w is appended, every predecessor u has popped, and each pop relaxed `level[w] = max(level[w], level[u] + 1)`. So `level[w] = 1 + max level of its predecessors`, and by induction along the topological order that is the length of the longest path from a source. The property test compares every level with a brute-force longest-path oracle.

**The cycle path is a real, simple, deterministic cycle.** The walk goes from each node to one of its remaining predecessors, so consecutive walk nodes are real edges. It stops at the first repeated node v; the stretch from v's first visit to the end is a cycle with no repeated node, and the part before it (the tail) is dropped. Reversing turns "requires" steps into "is required by" steps, rotation keeps every consecutive pair, and closing repeats the first name. Every choice (start, next step, rotation) is by smallest name, so the result depends only on the graph.

**Cursor.** `pending[v]` counts v's requirements not yet completed. `complete(v)` is allowed only when `pending[v] = 0` and v is not done, so no node completes before its requirements or twice. Completing v decrements v's dependents and returns those that reach 0; each node reaches 0 exactly once, so each is returned once (initial() returns the sources).

## Memory layout

Nodes are indexed 0..V−1 in input order. `names: string[]` and `index: Map<string, number>` map both ways. Edges point from a dependency to its dependent ("A → B: B requires A", spec Figure 6.3) and are stored twice in CSR form:

| Array               | Type       | Length   | Meaning                                                          |
| ------------------- | ---------- | -------- | ---------------------------------------------------------------- |
| `inStart`, `inFrom` | Int32Array | V + 1, E | row v = what v requires, in the order of v's `requires` array    |
| `outStart`, `outTo` | Int32Array | V + 1, E | row u = the nodes that require u, by increasing index            |
| `indeg`             | Int32Array | V        | in-degree (the cursor copies it)                                 |
| `level`             | Int32Array | V        | longest path from a source                                       |
| `order`             | Int32Array | V        | Kahn's queue = the topological order; the sources are its prefix |

Typed arrays: exactly 4 · (5V + 2 + 2E) bytes, which is 20 bytes per node plus 8 bytes per edge (≈ 60 B/node at E = 5V, reported by `stats()`, asserted by the bench). `reversed()` shares `names`, `index` and the original dependents half with the original graph; nothing is written after construction.

Measured on the dev machine with `node --expose-gc` and `dsa/src/_shared/mem.ts` (median of 9 builds of the benchmark's layered DAG, E ≈ 5V):

| V    | typed arrays (`stats()`), B/node | measured, built graph, B/node | measured with `levels()` and `topoOrder()` materialised, B/node |
| ---- | -------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| 10^3 | 58.77                            | 97.2                          | 120.9                                                           |
| 10^4 | 59.60                            | 113.6                         | 133.1                                                           |
| 10^5 | 59.87                            | 104.6                         | 124.8                                                           |

The rest of the measured figure is the `Map` index and the `names` array (about 40–55 B/node), plus about 20 B/node for the plain-array copies that `levels()` and `topoOrder()` cache. That is about 21 B per (V + E). The input manifests and their strings are not counted.

## Invariants (`checkInvariants()`; each failure throws `DsaError` INVALID whose message starts with its id)

1. **D1** `names` and `index` are a bijection: V names, V index entries, `index.get(names[v]) === v`.
2. **D2** Both halves span exactly E entries over V + 1 non-decreasing row starts with entries in 0..V−1; `indeg[v]` equals the row length; no self-loop; every dependents row is strictly increasing; the transpose of the requirements half equals the dependents half element by element, so both describe the same edge set with no edge stored twice.
3. **D3** `level[v] ≥ level[u] + 1` on every edge u→v, with equality for at least one predecessor; sources are level 0; the recorded maximum level is the maximum.
4. **D4** `order` is a permutation of 0..V−1 and every requirement comes before the node that requires it.

## Tests

- `dsa/tests/dag.test.ts`: 17 edge-case tests. Empty graph (V = 0); one node (level 0); diamond levels and order; several sources with ties in input order; duplicate name and duplicate edge (`DUPLICATE`); unknown requirement (`UnknownNodeError` naming both nodes); self-loop `a → a`; 2-cycle and 3-cycle with real edges, rotated and closed; a cycle reached through a tail (only the cycle is reported); two disjoint cycles (the same one every run, also on reversed input); a 10^5-node chain, 10^5 independent nodes and a cycle of 10^5 + 1 nodes, all without recursion; the cursor rejecting a node completed twice or not ready; ancestors of a source; the 18 shipped service manifests (30 edges, 7 levels, desktop closure of 9 services with weight 25); reversed order for shutdown; `topoLevels` returning the caller's objects; `name` out of range (`RANGE`).
- `dsa/tests/dag.prop.test.ts`: 3 fast-check properties, 1,000 runs each on pull requests (also passed at `PLT_PROP_RUNS=10000`): random DAGs up to 500 nodes (order respects every edge, levels equal brute-force longest paths, `checkInvariants` passes); random completion order through the cursor; a random back edge always raises a `CycleError` whose consecutive pairs are real edges, starting at the smallest name. fast-check prints the seed and path of a failure; replay with `PLT_PROP_SEED` and `PLT_PROP_PATH`.

## Benchmark

Dev machine, not the lab machine: AMD Ryzen 5 7530U (6 cores, 16 MB shared L3), Node v24.13.1, V8 13.6, Linux 7.0, `runner: dev`, seed 42, 2026-09-25. **Re-run every figure on the lab machine before the final defence (spec §7.1).** The machine was shared with about 25 other agents running tests and benchmarks (load average 3.5–14 during the runs), so absolute figures are pessimistic and the 10^5 point is the noisiest.

Commands:

```bash
# nightly shape (all sizes) and the JSON records of spec §7.3
PLT_BENCH_OUT=docs/evidence/dsa pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/dag.bench.ts
# pull-request sizes (spec §7.2: 10^3 and 10^4)
PLT_BENCH_SIZES=1000,10000 pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/dag.bench.ts
# add NODE_OPTIONS=--expose-gc to fill bytesPerEntryMeasured
```

**build + Kahn + levels** (`buildDag(nodes).levels()` on a random layered DAG with E ≈ 5V), time per (V + E):

| V    | V + E   | p50 ns | p95 ns | mean ns | whole build (mean) | bytes/node (measured / allocated) | shape ratio (limit)                 |
| ---- | ------- | ------ | ------ | ------- | ------------------ | --------------------------------- | ----------------------------------- |
| 10^3 | 5,845   | 47.4   | 66.7   | 50.6    | 0.30 ms            | 120.9 / 58.77                     | –                                   |
| 10^4 | 59,500  | 77.3   | 121.0  | 83.6    | 4.98 ms            | 133.1 / 59.60                     | 1.49 on the PR run (2): **pass**    |
| 10^5 | 598,420 | 181.5  | 445.6  | 225.8   | 135 ms             | 124.8 / 59.87                     | 4.46 (2): **fails on this machine** |

A second full-size run at lower load (2026-09-26 00:03, load average 4.0–4.3) gave means of 49.3, 107.7 and 129.7 ns per (V + E) at 10^3, 10^4 and 10^5, a shape ratio of **2.63**: still above 2, but most of the gap to the recorded run was contention.

```text
mean ns per (V + E)       0        50       100      150      200      250
10^3   50.6  |██████████
10^4   83.6  |█████████████████
10^5  225.8  |█████████████████████████████████████████████
```

A flat line would mean constant cost per (V + E). The operation count is linear, and the property test and the 10^5 chain test confirm the O(V + E) algorithm. The curve rises because the per-operation cost rises once the working set leaves the cache. A phase profile of the final code (standalone Node process, same workload, best of 3 runs at load average about 5) shows where the time goes, in ns per (V + E):

| Phase                                | 10^3 | 10^4 | 10^5  | Growth 10^3 → 10^5 |
| ------------------------------------ | ---- | ---- | ----- | ------------------ |
| index names (`Map.set` × V)          | 6.7  | 15.3 | 22.2  | 3.3×               |
| resolve requirements (`Map.get` × E) | 22.4 | 31.6 | 65.8  | 2.9×               |
| CSR transpose + duplicate-edge scan  | 5.3  | 6.9  | 12.3  | 2.3×               |
| in-degrees + Kahn + levels           | 4.5  | 6.7  | 10.6  | 2.4×               |
| levels() grouping                    | 1.4  | 1.4  | 1.0   | 0.7×               |
| **total**                            | 40.3 | 62.0 | 112.0 | 2.8×               |

About 72–79% of the time is string hashing in the `index: Map<string, number>` that §3.5 prescribes. Each `Map.get` of a random requirement string touches a bucket, an entry and one or two candidate key strings. At 10^3 these all sit in L2; at 10^5 (about 4 MB of table and names, plus 20 MB of input) they miss in a 16 MB L3 that the other processes also use. The team-written part (transpose, Kahn, levels) grows from 11.2 to 23.9 ns per (V + E), a ratio of 2.1. The vitest figures above are higher than this profile because they were taken with the other agents' test runs in parallel: in the vitest run the fastest 10^5 sample was 118 ns per (V + E) against a mean of 226. Two changes made during implementation took random accesses out of the hot loops: one `Map` operation per name instead of `has` + `set`, and duplicate-edge detection from the sorted dependents rows instead of a per-edge "seen" array. After them the PR-size shape assertion passed on every run at load average below 5 (1.49 on the recorded run).

**Budgets:**

| Benchmark                                          | Result (mean, p95)     | Budget (§7.2)          | Verdict                                         |
| -------------------------------------------------- | ---------------------- | ---------------------- | ----------------------------------------------- |
| boot DAG, the 18 shipped services (build + levels) | 8.1 µs, 11.3 µs        | ≤ 50 µs                | pass (6×)                                       |
| app closure (build + ancestors + levels), 8 nodes  | 1.4 µs, 3.4 µs         | –                      | –                                               |
| app closure, 32 nodes                              | 13.4 µs, 22.7 µs       | ≤ 1 ms at 32 nodes     | pass (44× on p95)                               |
| app closure, 128 nodes                             | 38.9 µs, 70.4 µs       | linear in closure size | pass (2.9× time for 4.7× the V + E of 32 nodes) |
| build + Kahn + levels per (V + E)                  | 50.6 / 83.6 / 225.8 ns | ≤ 100 ns (lab machine) | 10^3 and 10^4 within; 10^5 not on this machine  |

### Known limits and reversal

- **The 10^5 shape assertion (≤ 2, nightly) does not hold on this dev machine**: 4.46 on the recorded vitest run with other agents' runs in parallel, 2.63 on a second vitest run at lower load, and 2.8 in a standalone profile. The cause is mostly the `Map` string lookups, not Kahn. If the lab-machine nightly also fails, the options are: (a) keep the §7.2 limit on the pull-request sizes 10^3–10^4, where it passes; (b) time name resolution and Kahn separately, so the O(V + E) shape of the team-written part is visible on its own (11.2 → 23.9 ns per (V + E) here, a ratio of 2.1); or (c) raise the S4 limit at 10^5 with this evidence. Each option changes the spec's benchmark, so the team decides and records it in the spec. The test was not weakened here.
- Real inputs are small: 18 services, and app closures of tens of nodes. There the fixed cost (a `Map` and about ten typed-array allocations) dominates, and both budgets pass with a wide margin.
- Reversal trigger: switch to a different layout only if the boot DAG exceeds 50 µs or an app closure exceeds 1 ms on the lab machine. The first thing to try would be one shared `ArrayBuffer` for all the Int32 arrays.

## `DSA.md` entry template (spec §3.6)

Copy this into `DSA.md` and fill in the angle-bracket fields. The benchmark table between the markers is generated by `tools/dsa-report.ts`.

```markdown
## S4 DAG with Kahn's topological sort

| Field                      | Value                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module                     | `dsa/src/dag/index.ts` (single file)                                                                                                                                                                                                                                                                                                                                                       |
| Owner / non-owner reviewer | R5 QA/DevOps / R2 VFS/DB                                                                                                                                                                                                                                                                                                                                                                   |
| Mandatory location (§10.1) | Service dependencies and boot order (Spec §6.4, §10.1 DAG row; BOOT-03, BOOT-04) and application start-up dependencies.                                                                                                                                                                                                                                                                    |
| Used by                    | services/svcmgr (boot, shutdown, progress closure); kernel/core/proc/spawn (app closure); `bootlog --critical-path`; `svc.verify`                                                                                                                                                                                                                                                          |
| Written by                 | Claude (AI), by team decision of 2026-09-25, from first principles: no package, no pilot code, no other dsa structure. Owner R5 <owner name> studies and defends it in the viva; implementing PR #<n>                                                                                                                                                                                      |
| AI assistance              | Claude wrote the implementation, the memory record in `dag.bench.ts` and this entry from specs/08-dsa/data-structures.md §3.5/§4.4/§5 S4 and the existing contract and tests. Accepted: the CSR layout, the transpose-based dependents half, duplicate edges detected from sorted rows, the cycle walk. Added to the contract: `stats()` (§3.4 "Accounting"). See AI_USAGE.md <entry link> |

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

<!-- dsa-report:dag:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:dag:end -->

<chart: docs/evidence/dsa/dag/chart.svg>
Dev-machine figures (re-run on the lab machine): 50.6 / 83.6 / 225.8 ns per (V + E) at 10^3 / 10^4 / 10^5; 18 services 8.1 µs; app closure at 32 nodes 13.4 µs.

### Known limits and reversal

The 10^5 shape ratio is dominated by `Map` string hashing (72–79% of build time). It was 4.46 and 2.63 against the limit of 2 on the shared dev machine; the team-written CSR and Kahn part grows from 11.2 to 23.9 ns per (V + E). See dsa/src/dag/README.md "Known limits and reversal" for the options. Reversal trigger: the boot DAG above 50 µs or an app closure above 1 ms on the lab machine.
```

## Rules

1. Written from first principles. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and on 2026-09-25 the team decided that Claude would also write the implementation. `AI_USAGE.md` records both. The owner (R5) must study the code and be able to explain every function in the viva; the "How the code is organised" table and the proofs above are the study guide.
