# dsa/src/zorder: S9 z-order list (renumbered 1..n)

| Field              | Value                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status             | `IMPLEMENTED = true` (2026-09-25). All gated tests pass; benchmark run on a dev machine (numbers below, to be re-run on the lab machine)                                                                                                               |
| Owner              | R3 Shell/WM                                                                                                                                                                                                                                            |
| Non-owner reviewer | R5 QA/DevOps                                                                                                                                                                                                                                           |
| Must be `true` at  | v0.2.0 (P2), target W5 (spec §3.2 gate check)                                                                                                                                                                                                          |
| Requirement IDs    | WM-02, DSA-ZORD-01                                                                                                                                                                                                                                     |
| Spec               | [specs/08-dsa/data-structures.md](../../../specs/08-dsa/data-structures.md) (S9 in §3.5, §4.9, §5, §6, §7, §8.10)                                                                                                                                      |
| Written by         | Claude Code (model Claude Opus 5.5), following the team decision of 2026-09-25, from first principles: no package, no pilot code. Disclosed in `AI_USAGE.md`. R3 studies it and must be able to explain every line in the viva (spec §3.1 rule 4, §18) |

**Mandatory location.** The compositor's stacking order (Spec §9.4, WM-02; R3's 'z-order structure' of §4.1).

**Used by.**

- `wm/compositor`: it calls `insertTop` when a window opens, `raise` on focus, `remove` on close, `topWhere` for the focus fallback, and writes `style.zIndex = windowLayerBase + z` only for the returned `ZChange`s.

**Depends on.** S6 `OpenAddressingTable<number>` (`dsa/src/hashtable`), used as the wid → slot index. The spec names it as the one structure S9 may import (§3.3, §3.5).

## Files

| File                            | What it holds                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dsa/src/zorder/index.ts`       | the interface (unchanged from the contract) and the implementation `LinkedZOrder`                                           |
| `dsa/tests/zorder.test.ts`      | the complete edge-case suite of spec §8.10 (9 tests)                                                                        |
| `dsa/tests/zorder.prop.test.ts` | the fast-check model-based property test (1,000 runs; `PLT_PROP_RUNS`, `PLT_PROP_SEED`, `PLT_PROP_PATH` to scale or replay) |
| `dsa/bench/zorder.bench.ts`     | raise + renumber at n = 10, 100 and 1,000, the n = 64 budget, the O(1) curves and bytes per window                          |

## How it works (viva notes)

### Memory layout: struct of arrays

A window lives in a **slot** `s`, an index into four parallel `Int32Array`s:

| Array      | Meaning                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `widAt[s]` | the window id held by the slot (−1 when the slot is free)                                                    |
| `prev[s]`  | the slot directly **below** `s`, or NIL (−1) at the bottom                                                   |
| `next[s]`  | the slot directly **above** `s`, or NIL at the top. A free slot reuses `next` to point at the next free slot |
| `z[s]`     | the position of `s` counted from the bottom, 1..n. A free slot has `z = 0`                                   |

`head` is the bottom slot and `tail` the top slot. `index` (S6) maps wid → slot. Freed slots go on a free chain and are reused before the arrays grow. When no slot is free, the four arrays double.

```
 bottom                                                   top
 head ─► [s2 | wid 20 | z 1] ⇄ [s0 | wid 30 | z 2] ⇄ [s1 | wid 10 | z 3] ◄─ tail
 index (S6): 20 → s2, 30 → s0, 10 → s1
```

### The operations

- **`insertTop(w)`**: RANGE check, then DUPLICATE if S6 already has `w`. Take a slot, link it above the tail and set `z = n`. The windows below keep 1..n−1, so the result is exactly `[{w, n}]`.
- **`raise(w)`** (spec §5): look up the slot, at position `p = z[slot]`. If it is the top, return `[]`. Otherwise remember `above = next[slot]`, unlink the slot and link it at the top (a constant number of pointer writes). Then walk from `above` to the new top and assign `p, p+1, …, n`. The windows that were at `p+1..n` drop by one and the raised window gets `n`. The walk touches only those `n − p + 1` windows and reports them bottom to top.
- **`remove(w)`**: unlink the slot, free it, delete `w` from S6 and decrement n. Then walk from the old `above` and assign `p, …, n`: each window above the removed one drops by one. Removing the top reports nothing.
- **`lower(w)`**: unlink the slot and link it at the bottom. Then walk exactly `p` slots from the new bottom and assign `1..p`. The lowered window gets 1, and the `p − 1` windows that were below it move up by one. Windows above `p` keep their numbers.
- **`zOf`, `top`, `bottom`**: one S6 lookup plus one array read, or one array read.
- **`topWhere(pred)`**: walk down from the tail through `prev` until `pred` accepts. **`bottomToTop()`**: walk up from the head through `next`.

Worked example (the unit test): the stack `10, 20, 30` has z `1, 2, 3`. `raise(10)` has p = 1 and above = the slot of 20. After the relink the order is `20, 30, 10`. The walk assigns 20 → 1, 30 → 2, 10 → 3, and all three are reported. A second call, `raise(30)`, has p = 2. The walk from 10 assigns 10 → 2 and 30 → 3. Window 20 is not visited.

### Why z never grows without limit (WM-02)

Every mutator ends with the numbers equal to exactly {1..n} (invariant Z1, checked after every operation of the property test). So `z ≤ n` always holds. The test `WM-02 a million raises keep every z at most n` shows it after 10^6 raises. A naive "`z = ++counter` on focus" would pass 2^31 − 1, the 32-bit CSS `z-index` limit, after about 2·10^9 focus changes.

## Operations and complexity

p is the 1-based position of the window before the operation and n the number of windows.

| Operation             | Complexity                       | Proof sketch                                                                                                                                                                                                | Proving test                                                                                         | Proving benchmark                                                               |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| insertTop             | O(1) amortised expected          | a slot comes off the free chain or is the next fresh one; the arrays double, so over any sequence the copying is at most 2 slots per insert; one tail link; one S6 `set` (O(1) amortised expected at α ≤ ½) | `WM-02 an empty list has no top and no bottom`, `DSA-ZORD-01 inserting a wid twice throws DUPLICATE` | `insertTop+remove (top)` flat from n = 10 to 1,000                              |
| zOf, top, bottom      | O(1) (zOf: expected, through S6) | one S6 `get` and one array read; head and tail are stored                                                                                                                                                   | `WM-02 raising the only window returns no changes`                                                   | `zOf (random window)` flat                                                      |
| raise                 | O(1) relink + O(n − p) renumber  | unlink and link at the tail are constant pointer writes; the walk visits exactly the n − p windows above the old position plus the raised one                                                               | `WM-02 raising the bottom of three renumbers all three to 1..3`                                      | `raise+renumber` at n = 10, 100, 1,000 (linear); `raise (second from top)` flat |
| remove                | O(1) relink + O(n − p) renumber  | unlink + free-chain push + S6 `delete`; the walk visits the n − p windows above                                                                                                                             | `WM-02 removing the top, the bottom and a middle window renumbers the rest to 1..n`                  | `insertTop+remove (top)`                                                        |
| lower                 | O(1) relink + O(p) renumber      | link at the head; the walk visits the lowered window and the p − 1 windows that were below it                                                                                                               | `WM-02 raising the bottom of three renumbers all three to 1..3` (its last step)                      | –                                                                               |
| topWhere, bottomToTop | O(n)                             | one walk along `prev` or `next`, at most n steps                                                                                                                                                            | `DSA-ZORD-01 topWhere with no match returns undefined`                                               | –                                                                               |
| checkInvariants       | O(n + free slots)                | one walk of the list and one walk of the free chain                                                                                                                                                         | every property-test step                                                                             | –                                                                               |

**The renumbering bound is tight.** WM-02 requires the numbers to be exactly 1..n after every change. When a window moves from p to n, each of the n − p windows above it must get a new number, so any correct structure must write at least n − p numbers. Our walk writes exactly those numbers and returns exactly those changes. This is what the property test's "the returned changes equal the before/after diff" checks. The cost is therefore proportional to the size of the output, and no structure can do better.

## Invariants (`checkInvariants()`; each failure message names its id)

1. **Z1** the z numbers are exactly {1..n}, strictly increasing from bottom to top. Assertion: the k-th slot of the walk from the head has `z = k`, and the walk has exactly `size` slots.
2. **Z2** list membership equals hash-table membership. Assertion: S6 maps every listed wid to its own slot, and S6 holds exactly `size` keys. So no wid is listed twice, and the table holds no stale wid.
3. **Z3** `prev`/`next` are mutually consistent. Assertion: head and tail are NIL exactly when the list is empty, `prev` of each slot is the slot the walk came from, the walk ends at `tail` within `size` steps (so there is no cycle), and every slot handed out is either in the list or on the free chain with `z = 0`.

The messages read `dsa/zorder Z<k> violated: …`. They were checked by deliberately corrupting each field in a scratch script (not committed). The contract has no `debugCorrupt` hook for S9.

## Why this structure

Stacking changes are move-to-front operations. An array needs an O(n) splice per raise; a list relinks in O(1). Renumbering bounds z by n, where increment-on-raise would grow without limit (CSS `z-index` is 32-bit). With renumbering mandated, raise costs Θ(n − p) whatever the structure (see the tight bound above). The list keeps that cost equal to the output: nothing below p is touched, and insertTop and removing the top window are O(1). The stored `z` makes `zOf` O(1), where an array would need `indexOf`, which is O(n). Typed arrays and integer handles avoid one object per window and keep the walk cache-friendly (§3.4 "Integer handles on hot paths").

## Benchmark results (dev machine; re-run on the lab machine)

**These are dev-machine numbers.** They were measured on an AMD Ryzen 5 7530U laptop with Node v24.13.1 (V8 13.6), Linux 7.0, on 2026-09-25, while about 25 other agents were running builds and tests on the same machine. They are noisy (the spread between runs is given) and **must be re-run on the lab machine** for `DSA.md` (spec §7.1, §9.1 item 5). Each value is the median of three runs of `pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/zorder.bench.ts` (with `NODE_OPTIONS=--expose-gc`). The batch was 1,000 operations per timed call.

S9 is window-sized: the spec sizes are n = 10, 10^2, 10^3 (§7.1, "10^5 windows would be meaningless"), plus n = 64 for the budget.

### Time per operation

| op                                            | n     | mean ns | p50 ns | p95 ns | spread of the mean (3 runs)        |
| --------------------------------------------- | ----- | ------- | ------ | ------ | ---------------------------------- |
| raise + renumber (random window)              | 10    | 88      | 79     | 147    | 73–110                             |
| raise + renumber (random window)              | 100   | 733     | 653    | 1,086  | 460–819                            |
| raise + renumber (random window)              | 1,000 | 7,955   | 7,615  | 9,991  | 4,949–9,028                        |
| raise + renumber, **budget n = 64**           | 64    | 485     | 440    | 768    | 428–546 (target ≤ 2,000: **pass**) |
| insertTop + remove (top)                      | 10    | 97      | 77     | 162    | 92–153                             |
| insertTop + remove (top)                      | 100   | 96      | 82     | 144    | 85–133                             |
| insertTop + remove (top)                      | 1,000 | 100     | 87     | 164    | 76–132                             |
| zOf (random window)                           | 10    | 46      | 40     | 77     | 38–55                              |
| zOf (random window)                           | 100   | 75      | 85     | 93     | 42–89                              |
| zOf (random window)                           | 1,000 | 62      | 55     | 96     | 47–76                              |
| raise (second from top: 2 windows renumbered) | 10    | 76      | 64     | 126    | 64–80                              |
| raise (second from top: 2 windows renumbered) | 100   | 82      | 69     | 138    | 66–99                              |
| raise (second from top: 2 windows renumbered) | 1,000 | 84      | 71     | 137    | 68–86                              |

**The curves.**

- **raise + renumber is linear, as the spec says.** t(1,000)/t(10) was 68, 82 and 90 in the three runs. A random raise renumbers (n + 1)/2 windows on average: 5.5 at n = 10 and 500.5 at n = 1,000, a ratio of 91. The measured ratio is a little lower because a fixed cost (the S6 lookup and the relink) dominates at n = 10. That is about 10–18 ns per renumbered window at n = 1,000, most of it allocating the returned `ZChange` object.
- **The O(1) parts are flat.** t(1,000)/t(10) was 0.65–1.44 for insertTop + remove of the top, 1.24–1.37 for zOf and 1.06–1.10 for a raise just below the top. All are within the asserted ≤ 3×. The last curve shows that the cost of a raise depends on n − p, not on n.
- A scratch run outside Vitest, with less closure overhead, measured zOf at 9.5, 12, 14.5, 20 and 28 ns for n = 10 to 10^5. The rise at 10^5 comes from cache misses on a 3 MB table; the operation count per lookup stays constant.

### Bytes per window

_Allocated_ and _used_ come from `stats()`: 16 B of slot arrays per slot, plus S6's `bytesAllocated`/`bytesUsed`, which counts 12 B per table slot (an Int32 key and a value reference). _Measured_ is Δ(heapUsed + arrayBuffers)/n between two forced collections. The list was built from the default capacity of 16 by n `insertTop`s, as the compositor does. Sizes 10^4 and 10^5 are there only to show that the curve is flat.

| n     | allocated B/window | used B/window | measured B/window (3 runs)                 |
| ----- | ------------------ | ------------- | ------------------------------------------ |
| 10    | 64.0               | 28.0          | noise (−542 to −389; below GC granularity) |
| 100   | 51.2               | 28.0          | noise (−2,619 to 14)                       |
| 1,000 | 41.0               | 28.0          | 46.8–54.5                                  |
| 10^4  | 65.5               | 28.0          | 66.3–66.8                                  |
| 10^5  | 52.4               | 28.0          | 52.4                                       |

_Used_ is a constant 28 B per window: 16 B of slot arrays plus 12 B of S6 entry. _Allocated_ varies between about 41 and 66 B depending on where n falls between two doublings of the slot arrays (capacity ≥ n) and of the table (capacity ≥ 2n). From 10^3 upward the measured bytes agree with the allocated bytes.

### How to reproduce

```bash
pnpm exec vitest run --project dsa dsa/tests/zorder.test.ts dsa/tests/zorder.prop.test.ts
NODE_OPTIONS=--expose-gc PLT_BENCH_OUT=docs/evidence/dsa \
  pnpm exec vitest bench --run --project 'dsa (bench)' dsa/bench/zorder.bench.ts
```

Nightly scale: with `PLT_PROP_RUNS=10000`, the property test takes about 20 s, so it needs `--testTimeout=120000`. It passes with that timeout. Vitest's default of 5 s times it out; the assertion itself does not fail.

## `DSA.md` entry (spec §3.6), filled

```markdown
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
<chart: docs/evidence/dsa/zorder/chart.svg>

### Known limits and reversal

- Raise is Θ(n − p) by WM-02; at the supported window counts (≤ 256) that is well under the 2 µs budget measured at n = 64. The DOM writes the compositor makes per returned change cost more than the walk.
- `lower` is O(p), the mirror image of raise.
- The arrays and the table never shrink (a desktop's window count is small and bounded); a long session that once opened thousands of windows keeps that memory until reload.
- Reversal trigger: if a profile shows z-order work above 1 ms per frame, first batch style writes; the structure itself would only change if WM-02's renumbering rule were relaxed (for example gap numbering with lazy renumbering), which the spec forbids.
```

## Rules

1. Written from first principles. No npm package and no pilot code may stand in for it, not even temporarily (spec §3.1, §10.2); importing one scores zero for the item.
2. `dsa/**/src` imports only relative modules and type-only imports from `@plotinium/protocol` (ESLint-enforced). Tests and benchmarks may also import `vitest`, `fast-check` and `node:` built-ins.
3. Test titles begin with their requirement ID (C18).
4. The interface, tests and benchmark were drafted with AI assistance from the spec. The implementation was written by Claude Code by team decision (2026-09-25). `AI_USAGE.md` records both, and the owner records what they changed and why (spec §3.1 rule 5).
