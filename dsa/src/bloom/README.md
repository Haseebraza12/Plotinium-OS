# dsa/src/bloom: S8 Bloom filter (double hashing)

| Field              | Value                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | `IMPLEMENTED = true` (2026-09-25): the full edge-case and property suites pass, and the benchmark shape assertions pass                                                                                        |
| Owner              | R4 AI                                                                                                                                                                                                          |
| Non-owner reviewer | R2 VFS/DB                                                                                                                                                                                                      |
| Must be `true` at  | v0.4.0 (P4), target W10 (spec §3.2 gate check)                                                                                                                                                                 |
| Requirement IDs    | DSA-BLOOM-01                                                                                                                                                                                                   |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S8 in §3.5, §4.8, §5, §7.2, §8.9); parameters fixed in [rag-semantic-search.md §3.9](../../../specs/10-ai/rag-semantic-search.md) |

**Mandatory location.** Extra credit (Spec §10.1 note): a Bloom filter in front of the vector index's content-hash lookup.

**Used by.**

- kernel `ai.index.lookup` fast path (rag-semantic-search.md §3.9)

**Authorship.** The team decided on 2026-09-25 that Claude writes the `dsa/` structures, and the work is disclosed in `AI_USAGE.md`. The owner (R4) studies this implementation and must be able to explain it in the viva. It uses no npm package, no pilot code and no other `dsa/` structure. The proofs below are the ones to learn.

## Files

| File                           | What it holds                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `dsa/src/bloom/index.ts`       | the whole structure: `DoubleHashBloom`, plus the helpers `u32le`, `modU32` and `popcount32`                   |
| `dsa/tests/bloom.test.ts`      | the edge-case suite of spec §8.9 (7 tests)                                                                    |
| `dsa/tests/bloom.prop.test.ts` | fast-check property test (no false negatives, BF2, count) and the measured false-positive rate test (2 tests) |
| `dsa/bench/bloom.bench.ts`     | the micro-benchmark at 10^3, 10^4 and 10^5 with the shape assertions of spec §7.2, plus bytes per key         |

## How it works

**Sizing.** `m = ⌈10 · nDesign / 32⌉ · 32` bits, stored as `bits: Uint32Array(m / 32)`, and `k = 7`. The rag spec fixes 10 bits per key and k = 7, which gives a false-positive rate of `(1 − e^{−0.7})^7 ≈ 0.82%` at design load. The optimal integer k for 10 bits per key is `(m/n)·ln 2 ≈ 6.93`, so 7. `nDesign` starts at 16,384 in the indexer and doubles on each rebuild.

**Positions (double hashing).** A SHA-256 is already uniform, so the filter hashes nothing itself. It reads two little-endian u32s from the first 8 bytes:

```
h1 = u32le(bytes[0..4])
h2 = u32le(bytes[4..8]) | 1              (forced odd)
g_i = ((h1 mod m) + i · (h2 mod m)) mod m,  i = 0..6
```

The code computes `g_i` incrementally: `pos = h1 mod m`, `step = h2 mod m`, then `pos += step; if (pos >= m) pos -= m`. Both terms are below m, so their sum is below 2m and one subtraction replaces the `mod`. By induction this equals the formula above, with no multiplication or division in the loop, and every intermediate stays below 2m. Bit `pos` lives in word `pos >>> 5` at bit `pos & 31`.

**`h mod m` without `%`.** V8 computes `%` on a number that does not fit an int32 (half of all u32 hashes) with a slow floating-point remainder call. `modU32(a, m) = a − ⌊a/m⌋·m` returns the same value, and on the dev machine it took about 25% off `add`. It is exact for `a < 2^32`: the rounding error of `a/m` is below `2^−21/m`, which is less than the gap `1/m` to the next integer, so the floor is the true quotient. A randomized check of 5·10^6 values against `%` (including values next to multiples of m) found no mismatch.

**`mayContain`** walks the same 7 positions and returns `false` at the first clear bit.

**`rebuild(nDesign)`** checks its argument first, so a `RANGE` error leaves the filter untouched. It then allocates a new zeroed array, or clears the current one in place when m does not change, and resets `count` and the BF2 reference popcount.

**`bitCount()`** is a SWAR popcount per 32-bit word (pairs, nibbles, bytes, then one `Math.imul` sums the four byte counts).

### Proof sketches

- **No false negatives (BF1).** `add(x)` ORs in the 7 bits of x. No operation other than `rebuild` clears a bit (there is no `remove`), so all 7 bits are still set when `mayContain(x)` looks, and it returns `true`.
- **Popcount is monotone (BF2).** OR can only turn bits from 0 to 1. The popcount therefore never drops between rebuilds, and it grows by at most k per add. `checkInvariants()` also asserts `popcount ≤ k · count`.
- **The 7 positions of one key are distinct.** m is a multiple of 32, and `step = h2 mod m` is odd, because h2 is odd and m is even. If `g_i = g_j` with `0 ≤ i < j ≤ 6`, then m divides `(j − i) · step`. Since step is odd, 32 must divide `j − i`, which is impossible for `0 < j − i ≤ 6`. So one add into an empty filter sets exactly 7 bits. Forcing h2 odd rules out `step = 0`, where all 7 probes would land on one bit (test `h2 is forced odd`).
- **No overflow.** `h1, h2 < 2^32`, `m ≤ 2^32` (see the limit below) and every intermediate is below `2m ≤ 2^33`. That is far below 2^53, so all of it is exact double arithmetic, and `pos < 2^32` makes `pos >>> 5` valid.
- **False-positive rate.** After n inserts, each bit is still 0 with probability `(1 − 1/m)^{kn} ≈ e^{−kn/m}`. A non-member is reported only when all k of its positions are set: `(1 − e^{−kn/m})^k`. That is 0.819% at n = nDesign (m = 10n). Kirsch and Mitzenmacher (ESA 2006) show that double hashing `h1 + i·h2` keeps this asymptotic rate of k independent hashes.

### Behaviour beyond the spec text (documented choices)

1. **Upper bound on `nDesign`.** `nDesign > 429,496,729` (⌊2^32/10⌋) is `RANGE`. This keeps `m ≤ 2^32` bits (a 512 MiB array), so a bit position always fits a u32. The indexer's real sizes (16,384 doubling) are far below it.
2. **`bitsPerKey` and `k` are fixed.** The option types are the literals `10` and `7`. A caller that bypasses the types with another value gets `RANGE`, so it can never get a silently different filter.
3. **`stats()`.** `size` = `count` (adds since the last rebuild, duplicates included), `capacity` = `nDesign`, `bytesAllocated = bytesUsed = m / 8`. A Bloom filter has no free slots: every key's bits spread over the whole array, so all of it is in use from the first add.
4. **`checkInvariants()`** throws `DsaError('INVALID', …)`, and the message starts with the invariant id (`BF2 …` or `BF3 …`). BF1 needs the member set, so the property test checks it.

## `DSA.md` entry (spec §3.6)

Everything from the next heading to the end of "Known limits and reversal" is the filled-in template. Copy it into `DSA.md` and replace the `<…>` fields, which are the PR number and the `AI_USAGE.md` link. `tools/dsa-report.ts` generates the table between the `dsa-report` markers from the lab-machine JSON.

## S8 Bloom filter (double hashing)

| Field                      | Value                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module                     | `dsa/src/bloom/index.ts` (one file: `DoubleHashBloom`, `u32le`, `modU32`, `popcount32`)                                                                                                                      |
| Owner / non-owner reviewer | R4 AI / R2 VFS/DB                                                                                                                                                                                            |
| Mandatory location (§10.1) | Extra credit (Spec §10.1 note): a Bloom filter in front of the vector index's content-hash lookup.                                                                                                           |
| Used by                    | kernel `ai.index.lookup` fast path (rag-semantic-search.md §3.9)                                                                                                                                             |
| Written by                 | Claude (AI assistant), by team decision of 2026-09-25, from first principles: no package, no pilot code, no other `dsa/` structure. R4 studies it and defends it in the viva. Implementing PR: <#…>          |
| AI assistance              | Claude wrote the implementation, this entry and the benchmark run against the pre-existing spec, interface, tests and benchmark, none of which it changed. See the `AI_USAGE.md` entry of 2026-09-25 <link>. |

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

<!-- dsa-report:bloom:start -->

| op  | n   | p50 ns | p95 ns | mean ns | bytes/entry (measured / allocated) | shape ratio (limit) |
| --- | --- | ------ | ------ | ------- | ---------------------------------- | ------------------- |

<!-- dsa-report:bloom:end -->

<chart: docs/evidence/dsa/bloom/chart.svg>

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

## Rules

1. Written from first principles. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. `AI_USAGE.md` records the AI assistance: the interface, tests and benchmark were drafted from the spec, and Claude wrote the implementation (team decision of 2026-09-25). The owner records what they changed and why (spec §3.1 rule 5).
