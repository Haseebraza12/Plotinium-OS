# dsa/src/heap: S3 binary min-heap with index map

| Field              | Value                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | `IMPLEMENTED = true` (2026-09-25). The full edge-case and property suites pass, and the benchmark passes its shape assertions on a dev machine. The numbers must be re-run on the lab machine |
| Owner              | R1 Kernel                                                                                                                                                                                     |
| Non-owner reviewer | R3 Shell/WM                                                                                                                                                                                   |
| Must be `true` at  | v0.2.0 (P2), target W3 (spec §3.2 gate check)                                                                                                                                                 |
| Requirement IDs    | PROC-02, DSA-HEAP-01…02                                                                                                                                                                       |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S3 in §3.5, §4, §5, §8)                                                                                          |

**Mandatory location.** The scheduler ready queue (Spec §9.1, §10.1 heap row; PROC-02), keyed by `effPrio · 2^32 + seq`.

**Used by.**

- `kernel/core/sched` (ready heap, timer heap)
- `ai/search` (bounded top-k)
- `ai/indexer` (work queue)
- `server/locks` (lease expiry)

## Files

| File                             | What it holds                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/heap/index.ts`          | the public contract: `IMPLEMENTED`, the interfaces `IndexedMinHeap`, `PriorityQueue<T>` and `BoundedTopK`, `HeapCorruption`, and the re-exports of the three classes |
| `dsa/src/heap/binary-heap.ts`    | `BinaryHeap`: the typed-array heap, the hole-moving sifts, growth, `stats()`, `checkInvariants()` (H1–H4) and `debugCorrupt()`                                       |
| `dsa/src/heap/priority-queue.ts` | `HeapPriorityQueue<T>`: the §10.3 generic facade (item → handle `Map` plus a free-handle stack)                                                                      |
| `dsa/src/heap/bounded-top-k.ts`  | `BoundedTopKHeap`: the k largest scores in a min-heap of k slots, using `replaceTop`                                                                                 |
| `dsa/tests/heap.test.ts`         | the complete edge-case suite of spec §8 (empty, one element, duplicates, removal of the root or head, and the rest)                                                  |
| `dsa/tests/heap.prop.test.ts`    | fast-check model-based and differential property tests (1,000 runs; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay)                            |
| `dsa/bench/heap.bench.ts`        | the micro-benchmark at 10^3, 10^4 and 10^5 (plus n = 256) with the shape assertions of spec §7.2 and the sorted-array baseline                                       |

## How it works (read this before the viva)

**Layout.** The heap is a complete binary tree stored implicitly in arrays. Position `i` has its parent at `(i − 1) >> 1` and its children at `2i + 1` and `2i + 2`. Three parallel typed arrays hold it (struct of arrays, spec §3.4):

| Array                | Indexed by    | Holds                                                             | Bytes |
| -------------------- | ------------- | ----------------------------------------------------------------- | ----- |
| `keys: Float64Array` | heap position | the key at that position                                          | 8     |
| `hnd: Int32Array`    | heap position | the handle at that position                                       | 4     |
| `pos: Int32Array`    | handle        | the handle's heap position, or −1 when absent (the **index map**) | 4     |

`keys` and `hnd` grow by doubling when a push finds them full. `pos` is sized to the handle space and doubles until the largest handle fits; new slots are filled with −1. Arrays never shrink (spec §3.4).

**Hole-moving sifts (spec §5 S3).** A swap-based sift writes both entries at every level. Here the moving entry `(handle, key)` stays in local variables and only the hole moves.

- `siftUp(i, handle, key)`: while the parent's key is strictly greater than `key`, copy the parent down into the hole (key, handle and `pos[parentHandle] = i`) and move the hole to the parent. Then write the entry once where the hole stopped.
- `siftDown(i, handle, key)`: while `i` is not a leaf (`i < ⌊n / 2⌋`), pick the smaller child. If its key is strictly smaller than `key`, copy the child up into the hole and move the hole down. Then write the entry once.

**Operations.**

- `push(h, k)`: validate (`RANGE`, `DUPLICATE`), grow if needed, open a hole at position `n`, sift up.
- `pop()`: take the root's handle and set its `pos` to −1. Move the last leaf into the hole at the root and sift it down.
- `changePriority(h, k)`: `i = pos[h]` in O(1). Sift up if the key decreased, down if it increased, and just store it if it is equal.
- `remove(h)`: move the last leaf into `pos[h]`. It came from another subtree, so it may be smaller than its new parent (sift up) or larger than its new children (sift down). It cannot be both, because the parent is ≤ both old children.
- `replaceTop(h, k)`: pop and push in one sift-down from the root. The popped handle itself may be pushed back. On an empty heap it behaves as `push`.
- `peek`, `peekKey`, `has`, `keyOf`: array reads. A typed array returns `undefined` for a negative, fractional or out-of-range index, so an invalid handle simply reads as absent.
- `clear()`: resets only the `pos` slots of the handles present, O(n), not O(handle space).

**HeapPriorityQueue&lt;T&gt;.** Items map to dense handles through `Map<T, number>`, and `items[handle]` maps back. Popped handles go on a free stack and are reused first, so handles stay below the peak queue length and `pos` stays small. `changePriority` is a `Map` lookup (O(1) expected) plus `BinaryHeap.changePriority` (O(log n)).

**BoundedTopKHeap.** A min-heap of at most k entries. Its root is the smallest score kept, which is the admission threshold once the heap is full. `offer` pushes while `size < k`. After that, it calls `replaceTop` only when the score is **strictly** greater than the root, and otherwise rejects. The heap's handles are slots 0..k−1, and `ids: Float64Array` maps each slot to the caller's candidate id, so memory is O(k) however large the ids are. `drainDescending` pops in ascending order and fills the result from the back.

## Operations and complexity

| Operation                           | Complexity            | Proof sketch                                                             | Proving test                                                                     | Proving benchmark                   |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------- |
| push, pop                           | O(log n)              | one sift along a root-to-leaf path of a complete tree of height ⌊log₂ n⌋ | `DSA-HEAP-01 ascending, descending and random inputs pop in ascending key order` | `heap.bench.ts` pop+push vs n       |
| changePriority                      | O(log n)              | `pos[h]` finds the entry in O(1); one sift up or down                    | `PROC-02 decreasing a leaf's key to the minimum …`                               | `heap.bench.ts` changePriority vs n |
| remove                              | O(log n)              | move the last entry into the hole; sift up or down                       | `DSA-HEAP-02 remove of the root, the last element, a middle element …`           | `heap.bench.ts` remove+push         |
| replaceTop                          | O(log n)              | overwrite the root; one sift down                                        | `DSA-HEAP-02 replaceTop on an empty heap behaves as push`                        | –                                   |
| peek, peekKey, has, keyOf           | O(1)                  | array reads                                                              | `DSA-HEAP-01 pop, peek and peekKey on an empty heap …`                           | –                                   |
| BoundedTopK.offer / drainDescending | O(log k) / O(k log k) | a min-heap of at most k entries                                          | `DSA-HEAP-02 BoundedTopK …`                                                      | –                                   |

**Proofs.**

1. _Height._ The first `n` positions of the implicit tree form a complete binary tree, whose height is ⌊log₂ n⌋. Every iteration of `siftUp` moves the hole up one level and every iteration of `siftDown` moves it down one level. So each sift does at most ⌊log₂ n⌋ iterations of O(1) work: at most two comparisons and three array writes.
2. _Index map._ Every write that moves a handle into position `i` also writes `pos[handle] = i`, in both sift loops and in the final placement. So `pos` is always exact (H2, H3), and finding a handle is O(1). That is what makes `changePriority` and `remove` O(log n) rather than O(n) (§10.1 "change priority O(log n) with an index map").
3. _Correctness of changePriority._ Before the change H1 holds everywhere. Decreasing the key at `i` can only break H1 on the edge to its parent, because its children were already ≥ the old, larger key. Sift up fixes that edge and moves the problem only upwards. Increasing the key can only break H1 on the edges to its children, and sift down fixes it. The same argument covers `remove`: the moved leaf either decreases or increases the key at the hole relative to the entry that was there.
4. _Growth._ Doubling means n pushes copy at most 1 + 2 + 4 + … + n < 2n entries in total, so push is amortised O(1) extra on top of the O(log n) sift.
5. _BoundedTopK._ The heap never holds more than k entries, so `offer` is O(log k), N offers are O(N log k), and `drainDescending` is k pops, O(k log k). Why it keeps the k largest: at any time the heap holds the k largest scores seen so far. A new score s belongs in that set exactly when s is larger than the smallest of them, which is the root. Replacing the root keeps the invariant.
6. _Aging (PROC-04)._ Aging calls `changePriority` for the r processes due at each tick, O(r log n).

## Invariants (`checkInvariants()`; each failure message names its id)

1. H1 `keys[(i−1) >> 1] ≤ keys[i]` for 0 < i < size (heap order)
2. H2 `pos[hnd[i]] === i` for i < size (the index map points back). Because `pos` is a function, this also proves that the handles in the heap are distinct.
3. H3 `pos[h] === −1` for absent handles (every non-−1 slot of `pos` must point to a position that holds that handle)
4. H4 every key is finite. NaN would make every comparison false and silently break H1, so `push`, `changePriority` and `replaceTop` reject it with `RANGE`.

`checkInvariants()` throws `DsaError('INVALID', 'heap invariant Hx violated: …')`. It runs one pass over the heap (H4, H2, H1 per position), then one pass over `pos` (H3), which is O(size + handle space). The property test calls it after every operation. `debugCorrupt('index-map')` points the root's handle at position 1, which breaks H2, and the test checks that the checker reports H2.

## Why this structure

A sorted array costs O(n) per insert (the rubric's 'Developing' column); a balanced BST has the same bounds with larger constants and more code. The index map is what makes changePriority O(log n) (Spec §10.1).

## Benchmark results (dev machine)

> **Dev-machine numbers. Re-run on the lab machine before the final defence** (`PLT_BENCH_RUNNER=lab`).
> Machine: AMD Ryzen 5 7530U, Linux 7.0.0-34-generic, Node v24.13.1 (V8 13.6.233.17), `runner: dev`, seed 42, 2026-09-25.
> Command: `NODE_OPTIONS=--expose-gc pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/heap.bench.ts`.
> Timings are the mean ns per operation over batches of 1,000 operations (100 for the baseline comparison). The table shows the second of two runs; the first run agreed within 2×, and its earliest series still carried JIT warm-up.

**Time, ns/op (mean; p95 in brackets)**

| Operation                              | n = 10^3      | n = 10^4          | n = 10^5            | t(10^5)/t(10^3) (limit 3) | Shape           |
| -------------------------------------- | ------------- | ----------------- | ------------------- | ------------------------- | --------------- |
| pop+push (one pair)                    | 54.1 (78.4)   | 68.5 (82.3)       | 80.5 (107.9)        | **1.49**                  | log-shaped      |
| remove+push (one pair)                 | 60.7 (64.7)   | 81.7 (117.0)      | 90.9 (99.4)         | **1.50**                  | log-shaped      |
| changePriority (uniform new key)       | 43.6 (46.5)   | 35.1 (36.1)       | 34.5 (37.9)         | **0.79**                  | flat (see note) |
| push+pop, batch 100                    | 25.1 (27.5)   | 31.8 (32.1)       | 41.8 (57.1)         | 1.67                      | log-shaped      |
| **baseline: sorted array**, push+pop   | 174.2 (188.9) | 1,306.4 (1,653.2) | 26,764.3 (31,780.1) | **153.6**                 | linear          |
| pop+push at the scheduler size n = 256 | 52.4 (68.4)   | –                 | –                   | –                         | –               |

```
ns/op (mean)         10^3        10^4        10^5
sorted array  ────   174 ─────── 1,306 ───── 26,764   ×154: linear (memmove per splice/shift)
heap pop+push ────    54 ───────    69 ─────     81   ×1.5: log-shaped (log₂ 10^5 / log₂ 10^3 ≈ 1.67)
heap change   ────    44 ───────    35 ─────     35   flat: average case O(1), worst case O(log n)
```

- **Shape assertions pass.** All three ratios are ≤ 3 (spec §7.2). The pop+push and remove+push curves grow like log n: the ideal ratio is log₂ 10^5 / log₂ 10^3 ≈ 1.67, and we measured 1.49–1.67. The sorted-array baseline grows about 154× over the same range.
- **Absolute budget.** mean ≤ 1 µs at 10^5 (spec §7.2). Measured: 34–91 ns, about 11–29× under the budget.
- **Why changePriority is flat.** The benchmark gives a random handle a new uniform random key. In a heap, half the entries are leaves and three quarters are in the bottom two levels. A random new key therefore moves only a constant number of levels on average. Only the worst case (a leaf moved to the root) walks the full ⌊log₂ n⌋ levels, and the test `PROC-02 decreasing a leaf's key to the minimum makes it the next pop` exercises that case. The slightly higher time at 10^3 is warm-up of the first iterations.
- **Compared with the pilot** (context only; not our code, spec §7.2): object heap with a `Map` index, 570–1,453 ns per pop+push; struct-of-arrays TypeScript heap, 92–198 ns.

**Memory, bytes per entry** (handles 0..n−1, built with `new BinaryHeap(n)`)

| n    | measured Δ(heapUsed + arrayBuffers) / n | allocated (`stats()`) | used (`stats()`) |
| ---- | --------------------------------------- | --------------------- | ---------------- |
| 10^3 | 15.04                                   | 16.00                 | 16.00            |
| 10^4 | 15.96                                   | 16.00                 | 16.00            |
| 10^5 | 16.01                                   | 16.00                 | 16.00            |

This matches the 16 B/entry target (8 + 4 + 4). A heap that grows from the default capacity allocates at most 2× that right after a doubling, because the arrays never shrink.

## `DSA.md` entry (spec §3.6), filled in

Copy this into `DSA.md`. The benchmark table between the markers is normally generated by `tools/dsa-report.ts`. It is filled in here by hand from the dev run above, and must be regenerated from a lab run.

```markdown
## S3 Binary min-heap with index map

| Field                      | Value                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module                     | `dsa/src/heap/index.ts` (+ `binary-heap.ts`, `priority-queue.ts`, `bounded-top-k.ts`)                                                                                                                                                |
| Owner / non-owner reviewer | R1 Kernel / R3 Shell/WM                                                                                                                                                                                                              |
| Mandatory location (§10.1) | The scheduler ready queue (Spec §9.1, §10.1 heap row; PROC-02), keyed by `effPrio · 2^32 + seq`.                                                                                                                                     |
| Used by                    | kernel/core/sched (ready heap, timer heap); ai/search (bounded top-k); ai/indexer (work queue); server/locks (lease expiry)                                                                                                          |
| Written by                 | Implementation written by Claude (AI assistant) on 2026-09-25 under the team decision of that date, from the spec alone (no package, no pilot code). The R1 owner <name> studied it and defends it in the viva; implementing PR #<…> |
| AI assistance              | Interface, tests and benchmark drafted with AI from the spec; implementation written by AI on 2026-09-25 (team decision). The owner records what they reviewed, changed or rejected. See the AI_USAGE.md entry of 2026-09-25         |

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
<chart: docs/evidence/dsa/heap/chart.svg>

### Known limits and reversal

- **Dense handles only.** `pos` is sized to the largest handle, so one handle of 10^6 costs 4 MB. Pids, timer ids and lock slots are dense by design. Callers with sparse ids use `HeapPriorityQueue<T>` (free-handle stack) or `BoundedTopKHeap` (slots). Handles are limited to int32 (≤ 2^31 − 1).
- **No tie-breaking.** Equal keys pop in an unspecified order. The scheduler encodes FIFO order into the key (`effPrio · 2^32 + seq`, exact below 2^53), and the timer module sorts due entries itself.
- **No implicit shrink** (spec §3.4). A heap that once held many entries keeps its arrays.
- **Reversal.** If `pop+push` misses the mean ≤ 1 µs at 10^5 budget on the lab machine (the dev machine measures about 81 ns), the options in order are: a bottom-up (Floyd) sift-down, with one comparison per level on the way down; a 4-ary heap, with half the levels and better cache use; and a hand-written WASM heap (pilot: 65–128 ns). All three keep this interface.
```

## Rules

1. Written from first principles. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec. By the team decision of 2026-09-25, the implementation was also written by an AI assistant (Claude). `AI_USAGE.md` must record this, and the owner records what they reviewed, changed and why (spec §3.1 rule 5). The owner must be able to explain every line in the viva.
