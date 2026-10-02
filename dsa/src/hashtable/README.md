# dsa/src/hashtable: S6 open-addressing hash table

| Field              | Value                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Status             | `IMPLEMENTED = true` (2026-09-25): implementation, edge-case tests, property tests and benchmark all green   |
| Owner              | R1 Kernel                                                                                                    |
| Non-owner reviewer | R3 Shell/WM                                                                                                  |
| Must be `true` at  | v0.2.0 (P2), target W6 (spec §3.2 gate check)                                                                |
| Requirement IDs    | PROC-01, WM-01, DSA-HASH-01, DSA-GEN-09                                                                      |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S6 in §3.5, §4.6, §5, §7, §8.7) |

**Mandatory location.** The process table pid → PCB (PROC-01) and the window registry wid → WinRec (WM-01): the distinction-credit hash table of Spec §10.2.

**Used by.**

- `kernel/core/proc` (PidTable)
- `wm/compositor` (window registry)
- `dsa/zorder` (wid → slot)

## Files

| File                               | What it holds                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/hashtable/index.ts`       | the interface and the `OpenAddressingTable<V>` implementation (one file, about 450 lines, half of them comments)                                                                       |
| `dsa/tests/hashtable.test.ts`      | the edge-case suite of spec §8.7 (14 tests), plus 3 tests for behaviour the implementation adds: fail-fast iteration, rejected `undefined` values and capacities, `stats()` accounting |
| `dsa/tests/hashtable.prop.test.ts` | fast-check differential test against `Map` (1,000 runs of up to 200 operations, invariants after every step) and a seeded 200,000-operation run                                        |
| `dsa/bench/hashtable.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertion of spec §7.2 and the `Map` baseline                                                                                |

## How it works (for the viva)

**Layout (struct of arrays).** `keys: Int32Array(cap)`, where −1 means EMPTY, and `vals: (V | undefined)[]` of the same length. The scalar fields are `size`, `cap` (a power of two, at least 8), `mask = cap − 1` and `shift = 32 − log2(cap)`. Slot `j` holds the pair `(keys[j], vals[j])`. Keys are 0..2^31−1, so −1 can never be a real key.

**Hash.** `h(k) = Math.imul(k, 0x9E3779B1) >>> shift`. `Math.imul` gives the low 32 bits of `k · 2654435761`, where 2654435761 ≈ 2^32/φ and is odd. `>>> shift` keeps the top `log2(cap)` bits, which are a slot in `0..cap−1`. The top bits of the product depend on every bit of `k`, so consecutive pids spread over the table instead of forming one long run. With sequential pids 1..32,768 the longest probe is at most 2 (the test checks this). JavaScript takes shift counts mod 32, so `cap = 1` would give a shift of 32, which acts as a shift of 0. A minimum capacity of 8 keeps the shift at 29 or less.

**Lookup (`get`, `has`).** Start at `h(k)` and step `i = (i + 1) & mask` (linear probing, wrapping from the last slot to 0). Stop at `k` (found) or at the first EMPTY slot (absent). Stopping at EMPTY is correct because of **HT1**: every slot between a key's home and its actual slot is occupied. The loop always ends, because **HT3** keeps `size ≤ cap/2`, so at least half of the slots are EMPTY.

**Insert (`set`).** Probe as in lookup. If `k` is found, replace its value in place. Otherwise the probe stopped at an EMPTY slot. If this insert would push the load above ½, first double the capacity: every key is re-inserted with the new shift, and then the free slot is searched for again. Setting a value to `undefined` throws `INVALID`, because `undefined` marks an empty slot (**HT5**).

**Delete: backward shift, no tombstones.** Empty the key's slot `i` (the "hole"), then scan the rest of the cluster `j = i+1, i+2, …` up to the first EMPTY slot. For each key found at `j`, with home `h`:

```text
if ((j − h) & mask) ≥ ((j − i) & mask)   // the hole lies on the probe path [h, j)
    move keys[j]/vals[j] into the hole; slot j becomes the new hole
```

The `& mask` distances are measured forwards around the ring, so a cluster that wraps from slot `cap−1` to slot 0 needs no special case (the wrap test covers this). A key whose home comes after the hole stays where it is, because its path does not pass through the hole. Every key therefore keeps an unbroken run to its home (HT1), so lookups need no tombstones and probe paths never get longer with churn. Afterwards, if `size < cap/8` and `cap > 8`, the table is halved.

**Hysteresis.** The table grows when the load would pass ½ and shrinks when it drops below ⅛. After either resize the load is about ¼, so Θ(cap) operations must pass before the next resize. This stops a workload that alternates insert and delete at a boundary from resizing on every operation.

**Iteration is fail-fast (implementation decision).** `forEach` and `keys()` walk slots 0..cap−1. A delete during the walk can shift a key that has not been visited into a slot the walk has already passed, and a resize rebuilds both arrays. Either would make the walk skip or repeat keys, so inserting or deleting a key, or calling `clear`, during a walk makes the walk throw `INVALID`. Replacing the value of an existing key is allowed. To remove keys while walking (for example, reaping zombie processes), collect the keys first.

**`checkInvariants()`.** Checks HT4 (the capacity shape, and that `shift`, `mask` and the array lengths agree with it), then HT5 and HT3 in one slot scan, then HT1 and HT2 together. For each key it walks the probe path from the home slot to the key's slot. Every slot on that path must be occupied (HT1), and none may already hold the same key (HT2). Two copies of one key share a home, so the walk to the later copy always passes the earlier one, and no auxiliary `Set` is needed.

## Operations and complexity

α = size/cap ≤ ½ is the load factor.

| Operation                   | Complexity              | Proof sketch                                                                                                                                                                                                              | Proving test                                                              | Proving benchmark                         |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| get, has                    | O(1) expected           | ≈ ½(1 + 1/(1−α)) ≤ 1.5 probes on a hit and ≈ ½(1 + 1/(1−α)²) ≤ 2.5 on a miss at α ≤ ½ (Knuth, TAOCP vol. 3 §6.4). Measured mean probe lengths agree (table below)                                                         | `DSA-HASH-01 200,000 random … operations match Map …` (property)          | `hashtable.bench.ts` mixed vs Map         |
| set                         | O(1) amortised expected | one probe as above. Doubling costs O(cap), but ≥ cap/4 inserts happened since the last resize, so each insert pays O(1) (a geometric series)                                                                              | `DSA-HASH-01 inserting past load 0.5 doubles capacity …`                  | `hashtable.bench.ts` mixed get/set/delete |
| delete                      | O(1) expected           | one probe, then the backward-shift scan, which stops at the end of the cluster. The expected cluster length is O(1) at α ≤ ½. A shrink costs O(cap), paid for by the Θ(cap) operations since the last resize (hysteresis) | `DSA-HASH-01 deleting the head, middle and tail of a colliding cluster …` | `hashtable.bench.ts` mixed get/set/delete |
| forEach, keys, clear        | O(capacity)             | slot scan                                                                                                                                                                                                                 | `DSA-HASH-01 clear empties the table and forEach visits every key once`   | –                                         |
| probeStats, checkInvariants | O(capacity) expected    | slot scan, plus one probe-path walk per key (O(1) expected each)                                                                                                                                                          | `PROC-01 sequential pids 1..32,768 …`, property test                      | –                                         |

**Measured probe lengths** (the `probeStats()` definition: slots examined by a successful lookup), dev machine:

| n    | cap     | α     | sequential keys 1..n: mean / max | random keys: mean / max | Knuth ½(1 + 1/(1−α)) |
| ---- | ------- | ----- | -------------------------------- | ----------------------- | -------------------- |
| 10^3 | 2,048   | 0.488 | 1.001 / 2                        | 1.419 / 11              | 1.48                 |
| 10^4 | 32,768  | 0.305 | 1.000 / 1                        | 1.213 / 10              | 1.22                 |
| 10^5 | 262,144 | 0.381 | 1.146 / 2                        | 1.308 / 16              | 1.31                 |

With random keys the measured mean matches the uniform-hashing prediction. With sequential pids, Fibonacci hashing does better than random: the three-distance theorem spreads k·φ⁻¹ mod 1 almost evenly.

## Invariants (`checkInvariants()`; each failure message names its id)

1. HT1 reachability: every slot from `h(k)` to the slot of k is occupied
2. HT2 keys are unique
3. HT3 `size` equals the occupied slots and `size ≤ cap/2`
4. HT4 `cap` is a power of two ≥ 8 with `shift = 32 − log2(cap)`
5. HT5 `vals[j] === undefined` iff `keys[j] === −1`

## Errors

| Case                                                                        | Error                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| key that is negative, fractional, NaN, ±∞ or ≥ 2^31 (get, has, set, delete) | `DsaError('RANGE')` (spec §6.0)                                 |
| `set(k, undefined)`                                                         | `DsaError('INVALID')`: `undefined` marks an empty slot (HT5)    |
| `initialCapacity` > 2^30, NaN or ∞                                          | `DsaError('RANGE')` (smaller and negative values round up to 8) |
| insert or delete during `forEach` / `keys()`                                | `DsaError('INVALID')` from the iteration (fail-fast)            |

## Benchmark results (dev machine; must be re-run on the lab machine)

> **These figures come from a developer laptop while other build agents were running on it:** AMD Ryzen 5 7530U, Linux 7.0.0, Node v24.13.1 (V8 13.6), `runner: dev`, seed 42, 2026-09-25. Re-run them on the lab-spec machine before the final defence and commit the JSON (`PLT_BENCH_RUNNER=lab PLT_BENCH_OUT=docs/evidence/dsa`).

Command:

```bash
NODE_OPTIONS=--expose-gc PLT_BENCH_OUT=docs/evidence/dsa \
  pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/hashtable.bench.ts
```

Workload (§7.1 S6): 50% get / 25% set / 25% delete over a pool of 2n keys with n resident, batches of 1,000 operations. Each figure below is the median of three harness runs.

**Mixed get/set/delete, ns/op (mean / p50 / p95)**

| n    | table, sequential   | Map, sequential     | table, random       | Map, random         |
| ---- | ------------------- | ------------------- | ------------------- | ------------------- |
| 10^3 | 61.5 / 48.4 / 87.9  | 68.5 / 60.5 / 100.1 | 61.5 / 55.7 / 99.5  | 66.0 / 58.0 / 103.0 |
| 10^4 | 81.3 / 70.6 / 109.9 | 73.6 / 65.6 / 107.2 | 64.5 / 56.4 / 99.8  | 73.6 / 72.1 / 116.8 |
| 10^5 | 65.4 / 55.9 / 100.5 | 60.9 / 57.5 / 90.8  | 62.0 / 58.0 / 103.8 | 66.9 / 58.1 / 106.4 |

**Complexity curve (shape assertion t(10^5)/t(10^3) ≤ 2, §7.2).** The curve is flat, as expected for O(1).

- Sequential: ratios 1.17, 1.11 and 0.73 over the three runs.
- Random: ratios 1.01, 0.99 and 0.98.

All six pass.

**Budgets (§7.2).**

- Mean ≤ 0.3 µs: pass, at 55–90 ns in every cell.
- Not slower than `Map` by more than 1.5×: pass, at 0.7–1.4× in two of the three runs. One noisy run had a mean ratio of 1.5–2.3× on random keys, while its p50 values were equal to Map's. This budget is soft and recorded, not asserted.

**Tight-loop cross-check.** The harness adds about 30–40 ns/op of overhead that is the same for both structures. So the same workload was also timed without the harness: 10^6 operations, best of 7, run straight under `node`.

| n    | table, sequential | Map, sequential | table, random | Map, random |
| ---- | ----------------- | --------------- | ------------- | ----------- |
| 10^3 | 17.6              | 25.4            | 23.5          | 28.5        |
| 10^4 | 22.1              | 32.4            | 26.8          | 38.4        |
| 10^5 | 27.8              | 48.7            | 45.5          | 82.4        |

- The table takes 0.55–0.83× as long as `Map`.
- The rise from 10^4 to 10^5 on random keys is a memory-hierarchy effect, not an algorithmic one. The probe count stays at about 1.3 (see above), but the table at 10^5 is 3 MB, larger than L2. `Map` rises more steeply (2.9×).

**Memory, bytes per entry (excluding the value objects; budget ≤ 48)**

| n    | cap     | measured (`--expose-gc`) | allocated (`stats()`) | used (`stats()`) |
| ---- | ------- | ------------------------ | --------------------- | ---------------- |
| 10^3 | 2,048   | 24.97                    | 24.58                 | 12.00            |
| 10^4 | 32,768  | 40.69                    | 39.32                 | 12.00            |
| 10^5 | 262,144 | 31.47                    | 31.46                 | 12.00            |

- Each slot costs 12 B: a 4 B Int32Array key and an 8 B array element pointer, since Node's V8 has no pointer compression.
- Allocated bytes per entry are therefore 12 · cap / n. That is between 24 and 48, depending on where n falls between two doublings. At n = cap/4 + 1, just after a doubling, it reaches its worst case of just under 48.
- The measured figure matches the allocated one.
- An earlier draft filled `vals` with `push()`. That over-allocates the JS array's backing store by up to 1.5×: 41.4 B/entry measured against 31.5 allocated at 10^5. `new Array(cap).fill(undefined)` sizes it exactly.

## `DSA.md` entry (spec §3.6)

Copy this into `DSA.md`. The benchmark table between the markers is generated by `tools/dsa-report.ts` from the committed JSON.

```markdown
## S6 Open-addressing hash table

| Field                      | Value                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/hashtable/index.ts` (single file)                                                                                                                                                                                                                                                   |
| Owner / non-owner reviewer | R1 Kernel / R3 Shell/WM                                                                                                                                                                                                                                                                      |
| Mandatory location (§10.1) | The process table pid → PCB (PROC-01) and the window registry wid → WinRec (WM-01): the distinction-credit hash table of Spec §10.2.                                                                                                                                                         |
| Used by                    | kernel/core/proc (PidTable); wm/compositor (window registry); dsa/zorder (wid → slot)                                                                                                                                                                                                        |
| Written by                 | Implemented by Claude (AI) from first principles on 2026-09-25, following the team decision of that date. No npm package, no pilot code and no other dsa structure was used. R1 (<owner name>) studied it and defends it at the viva; implementing PR #…                                     |
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

<!-- dsa-report:hashtable:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:hashtable:end -->

<chart: docs/evidence/dsa/hashtable/chart.svg>

### Known limits and reversal

- Keys must be int32 handles in 0..2^31−1. Other key types belong in a `Map`.
- Iteration is fail-fast: there is no delete-while-iterating.
- Capacity is at most 2^30 slots.
- Tables pre-sized with `initialCapacity` shrink on their first delete while below ⅛ load.
- Reversal trigger: if a lab-machine run shows mixed operations slower than `Map` by more than 1.5× at any size, or a max probe above 32 on the real pid/wid workload, revert the process table to `Map` and keep S6 for the window registry only.
```

## Rules

1. Written from first principles. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and the implementation was written by Claude on 2026-09-25 by team decision. `AI_USAGE.md` records this, and the owner records what they changed and why (spec §3.1 rule 5).
