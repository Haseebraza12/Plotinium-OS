# dsa/src/ringbuffer: S7 ring buffer

| Field              | Value                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | `IMPLEMENTED = true` (2026-09-25). 14 edge-case tests and 2 property tests pass; benchmark shape and budgets pass on a dev machine (re-run on the lab machine before the final defence) |
| Owner              | R5 QA/DevOps                                                                                                                                                                            |
| Non-owner reviewer | R1 Kernel                                                                                                                                                                               |
| Must be `true` at  | v0.2.0 (P2), target W5 (spec §3.2 gate check)                                                                                                                                           |
| Requirement IDs    | DSA-RING-01                                                                                                                                                                             |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S7 in §3.5, §4.7, §5, §6, §7.2, §8.8)                                                                      |

**Mandatory location.** Extra credit (Spec §10.1 note): the kernel log. Also the telemetry ring, the frame meter and pipes.

**Used by.**

- `kernel/core/klog` (8,192, overwrite)
- `ai/predictor` telemetry ring (4,096, mirrored with `slotOf`)
- `wm/frame-meter` (Float64Ring of 1,024)
- `kernel/core/ipc` pipes (ByteRing, 64 KiB, reject)

## Files

| File                                | What it holds                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/ringbuffer/index.ts`       | the implementation: `RingIndex` (shared index arithmetic, internal), `RingBuffer<T>`, `Float64Ring`, `ByteRingBuffer`                                                                                 |
| `dsa/tests/ringbuffer.test.ts`      | the edge-case suite of spec §8.8 (12 tests) plus 2 added with the implementation (Float64Ring API parity, percentile rounding)                                                                        |
| `dsa/tests/ringbuffer.prop.test.ts` | fast-check properties: the array/bytes model test of §8.8, plus a Float64Ring-vs-RingBuffer differential test (1,000 runs each; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay) |
| `dsa/bench/ringbuffer.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2                                                                                                                     |

## How to verify

```bash
pnpm exec tsc -p dsa/tsconfig.json --noEmit
pnpm exec vitest run --project dsa dsa/tests/ringbuffer.test.ts dsa/tests/ringbuffer.prop.test.ts
PLT_PROP_RUNS=10000 pnpm exec vitest run --project dsa dsa/tests/ringbuffer.prop.test.ts   # nightly scale
pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/ringbuffer.bench.ts
PLT_BENCH_OUT=docs/evidence/dsa pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/ringbuffer.bench.ts   # §7.3 JSON lines
pnpm exec eslint dsa/src/ringbuffer dsa/tests dsa/bench --max-warnings 0
```

The benchmark project is called `dsa (bench)`, not `dsa`: `--project dsa` finds no benchmark.

## How it works (read this first for the viva)

A ring is a fixed array plus two numbers: `head`, the physical slot of the oldest element, and `count`. Logical index `i` (0 = oldest) lives at physical slot `(head + i) & mask`, where `mask = capacity − 1`. Because the capacity is a power of two (2^k), `mask` is k one-bits, and `x & mask` keeps the low k bits of x, which is `x mod capacity`. It is one AND instruction instead of a division.

```
capacity 8, head = 6, count = 5             logical:  0  1  2  3  4
physical slot:  0  1  2  3  4  5  6  7      physical: 6  7  0  1  2
contents:       c  d  e  .  .  .  a  b      ((6 + i) & 7)
                         ^ next push goes to (head + count) & mask = 11 & 7 = 3
```

- **push, not full.** Write at `(head + count) & mask`, then `count++`.
- **push, full, overwrite mode.** `(head + count) & mask = (head + capacity) & mask = head`, so the new element goes where the oldest was. Then `head = (head + 1) & mask` (the next-oldest becomes the oldest) and `dropped++`. `count` stays at `capacity`.
- **push, full, reject mode.** `push` throws `FULL`; `tryPush` returns `false`. Nothing changes.
- **shift.** Read at `head`, write `undefined` into the slot (so the GC can reclaim the element), `head = (head + 1) & mask`, `count--`.
- **at(i) / slotOf(i).** Range check `0 ≤ i < count`, integer, then `(head + i) & mask`.

`head` is masked on every advance, so it stays in `0..capacity−1` however often the ring wraps (the edge-case test wraps a capacity-8 ring 10^6 times). An unmasked counter would grow towards 2^53 and lose precision.

**Code layout.** `RingIndex` (internal, not exported) owns `head`, `count`, `dropped` and the mode and does all index arithmetic (`claimSlot`, `takeOldestSlot`, `slotAt`). `RingBuffer<T>` (a `T[]`) and `Float64Ring` (a `Float64Array`) only own storage: `push` is "ask the index for a slot, then store into it". The arithmetic and its invariants are therefore written and proved once. `ByteRingBuffer` is separate because it moves runs of bytes, not single elements: `write`/`read` split the run into at most two `Uint8Array.set` copies, before and after the physical end of the buffer. A drained pipe resets `head` to 0 so the next write is a single copy.

## `DSA.md` entry (spec §3.6)

Copy this into `DSA.md`. The benchmark table between the markers is regenerated by `tools/dsa-report.ts` (not yet in the repo). The figures below are **dev-machine numbers and must be re-run on the lab machine**.

```markdown
## S7 Ring buffer

| Field                      | Value                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | `dsa/src/ringbuffer/index.ts` (`RingBuffer<T>`, `Float64Ring`, `ByteRingBuffer`; internal `RingIndex`)                                                                                                                                                                                                                        |
| Owner / non-owner reviewer | R5 QA/DevOps / R1 Kernel                                                                                                                                                                                                                                                                                                      |
| Mandatory location (§10.1) | Extra credit (Spec §10.1 note): the kernel log. Also the telemetry ring, the frame meter and pipes.                                                                                                                                                                                                                           |
| Used by                    | kernel/core/klog (8,192, overwrite); ai/predictor telemetry ring (4,096, mirrored with `slotOf`); wm/frame-meter (Float64Ring of 1,024); kernel/core/ipc pipes (ByteRing, 64 KiB, reject)                                                                                                                                     |
| Written by                 | Claude Code (Anthropic, Claude Opus 5.5) on 2026-09-25, following the team decision of 2026-09-25 that Claude writes the dsa/ structures with disclosure in AI_USAGE.md; written from first principles (no package, no pilot code, no other dsa structure). R5 studies and defends it in the viva. Implementing PR #<to fill> |
| AI assistance              | Asked: implement S7 against the contract, tests and spec, and record the benchmark. Accepted: the whole implementation, 3 added tests, the benchmark fix. The team records what it later changes or rejects in AI_USAGE.md (entry <to fill>).                                                                                 |

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
  <chart: docs/evidence/dsa/ringbuffer/chart.svg>

### Known limits and reversal

- Capacity is fixed at construction and must be a power of two up to 2^30 (all four users already use powers of two). A ring never grows; a longer klog history means a bigger ring at boot.
- `RingBuffer<T>` returns `undefined` both for "empty" and for a stored `undefined`. Check `size` when `T` can be `undefined` (klog and telemetry push objects).
- Iteration reads the live ring. Pushing or shifting inside a `for … of` loop changes what comes next, so take `toArray()` first.
- `percentile` sorts a copy on every call (27 µs at 1,024 values on the dev machine), which is fine for a HUD refreshed a few times a second. **Reversal trigger:** if the frame meter needs a percentile every frame, keep a fixed-bucket histogram updated in `push` (O(1) per push, O(buckets) per query).
- `ByteRingBuffer` never overwrites; a full pipe returns 0 accepted bytes and the kernel blocks the writer.
- **Reversal trigger:** if klog must retain by bytes rather than entries (very uneven message sizes), store length-prefixed records in a `ByteRingBuffer` and evict whole records.
```

## Changes to the test and benchmark files (with the implementation)

No existing assertion was changed or removed.

1. `dsa/bench/ringbuffer.bench.ts`: the two timed loops read `BATCH` from a local constant set outside the timed closure. Under Vitest's module runner, every read of an imported binding is a getter call. Vitest printed "accessed module export getters too many times", and the getter cost about 25 ns per iteration, 4 to 5 times the ring operation itself (30 ns reported against 5 to 7 ns in plain Node). That constant overhead also flattened the curve's shape. The shape limits (≤ 2) and budgets are unchanged.
2. `dsa/tests/ringbuffer.prop.test.ts`: both properties get an explicit timeout, `PROP_TIMEOUT_MS = 10 s + 30 ms × PLT_PROP_RUNS`. The spec's nightly 10,000 runs take about 25 s, so they always failed Vitest's 5 s default. 1,000 runs under coverage took 4.6 s, close to that default. Almost all of that time is fast-check generation and deep `toEqual`; the ring's own share is about 24 ms per 1,000 runs. Added property (2) above.
3. `dsa/tests/ringbuffer.test.ts`: 2 added tests (above).
4. All four files were formatted with the repository's Prettier config.

## Rules

1. No npm package and no pilot code may stand in for the structure, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item. This one uses only `../_shared/errors.ts`.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec, and on 2026-09-25 the implementation was written by Claude under the team's decision. `AI_USAGE.md` must record both. The owner records what they change and why (spec §3.1 rule 5).
5. Still to do outside this folder (not done here, because this change touches only S7 files): add `dsa` to `GATED_PACKAGES` in `vitest.config.ts` (the first structure to flip does this); update the S7 row and section of `DSA.md` from this entry; add the AI_USAGE.md entry; commit a lab benchmark run under `docs/evidence/dsa/ringbuffer/`.
