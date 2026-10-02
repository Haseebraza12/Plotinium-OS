# dsa/src/lru: S5 LRU (hash map + doubly linked list)

| Field              | Value                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Status             | `IMPLEMENTED = true` (2026-09-25): implementation, edge-case tests, property test and benchmark all run |
| Owner              | R1 Kernel                                                                                               |
| Non-owner reviewer | R5 QA/DevOps                                                                                            |
| Must be `true` at  | v0.3.0 (P3), target W10 (spec §3.2 gate check)                                                          |
| Requirement IDs    | MEM-02, DSA-LRU-01…02                                                                                   |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S5 in §3.5, §4, §5, §8)    |

**Mandatory location.** The LRU pager (Spec §9.2, §10.1 LRU row; MEM-02), plus the VFS inode cache and the server's rate-limit keys (bounded mode).

**Used by.**

- `kernel/core/mm` (pager, unbounded mode: it evicts explicitly because a page must reach swap before it is dropped)
- `vfs/tree` (inode cache, bounded mode)
- `server/ratelimit.ts` (key bound, bounded mode)

## Files

| File                         | What it holds                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/lru/index.ts`       | the interface and the implementation (`LruCache`), one file of about 540 lines, commented at every invariant                |
| `dsa/tests/lru.test.ts`      | the complete edge-case suite of spec §8.6 (18 tests)                                                                        |
| `dsa/tests/lru.prop.test.ts` | the fast-check model-based property test (1,000 runs; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay) |
| `dsa/bench/lru.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2                                           |

## How to run

```bash
pnpm exec vitest run --project dsa dsa/tests/lru.test.ts dsa/tests/lru.prop.test.ts
PLT_PROP_RUNS=10000 pnpm exec vitest run --project dsa dsa/tests/lru.prop.test.ts        # nightly depth
NODE_OPTIONS=--expose-gc pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/lru.bench.ts
PLT_BENCH_SIZES=1000,10000 ...                                                               # PR sizes (§7.2)
PLT_BENCH_OUT=docs/evidence/dsa ...                                                          # append §7.3 JSON lines
```

Benchmarks run in the `dsa (bench)` project; `--project dsa` selects the unit project only and makes `vitest bench` fail with "No projects matched". `--expose-gc` is needed for the _measured_ bytes/entry, which is `null` without it.

## `DSA.md` entry (spec §3.6)

The entry below is filled in. Copy it into `DSA.md`; `tools/dsa-report.ts` regenerates the benchmark table between the markers from the committed JSON lines.

```markdown
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

<!-- dsa-report:lru:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:lru:end -->

<chart: docs/evidence/dsa/lru/chart.svg>

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
```

## Rules

1. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item. The implementation was written by Claude Code under the team's disclosed 2026-09-25 decision (AI_USAGE.md §5), which conflicts with the wording of spec §10.2 until the instructor rules on it.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and on 2026-09-25 the team decided that Claude would also write the implementation. `AI_USAGE.md` records both. The owner records what they changed and why (spec §3.1 rule 5), and must be able to explain every invariant in the viva.
5. Still to do in the implementing PR (outside `dsa/src/lru/`, so not done here): copy the entry above into `DSA.md`; commit a lab-machine benchmark JSON run to `docs/evidence/dsa/lru/`; add `dsa` to `GATED_PACKAGES` in `vitest.config.ts` if no other structure has done it yet; add the AI_USAGE.md entry; request R5's review.
