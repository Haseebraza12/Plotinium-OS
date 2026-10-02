/**
 * S8: Bloom filter with double hashing (specs/08-dsa/data-structures.md §3.5 S8, §4.8, §5 S8).
 * Extra credit when justified (Spec §10.1 note: "a Bloom filter in front of the vector index").
 *
 * Owner: R4 AI · non-owner reviewer: R2 · must be IMPLEMENTED by v0.4.0 (P4, target W10).
 * User: the ai.index content-hash fast path (rag-semantic-search.md §3.9). It covers the SHA-256
 * `contentHash` of every live chunk and lets the indexer skip the `byHash` IndexedDB lookup for
 * hashes that are certainly new. It never participates in permission decisions.
 *
 * Parameters: m = 10 · nDesign bits rounded UP to a multiple of 32; k = 7; nDesign starts at
 * 16,384 and doubles on rebuild. Positions: h1 = u32le(bytes[0..4]), h2 = u32le(bytes[4..8]) | 1
 * (forced odd), g_i = ((h1 mod m) + i·(h2 mod m)) mod m for i = 0..k−1; every intermediate stays
 * below 8m < 2^53. Layout: `bits: Uint32Array(m / 32)`, 1.25 bytes per key at design load.
 * No deletions: stale bits only cost an extra lookup; the filter is rebuilt at compaction.
 *
 * | Operation                     | Complexity    |
 * |-------------------------------|---------------|
 * | add, mayContain               | O(k) = O(1)   |
 * | rebuild                       | O(m / 32)     |
 * | bitCount, checkInvariants     | O(m / 32)     |
 *
 * False-positive rate at n = nDesign: (1 − e^{−kn/m})^k = (1 − e^{−0.7})^7 ≈ 0.0082 (Kirsch and
 * Mitzenmacher, ESA 2006, for double hashing).
 *
 * Invariants (§5 S8), each failure message names its id: BF1 after add(x), mayContain(x) is true
 * until the next rebuild; BF2 the popcount never decreases between rebuilds; BF3 mBits is a
 * multiple of 32 and ≥ 10 · nDesign. `checkInvariants()` asserts BF2 (against the last popcount it
 * saw) and BF3.
 *
 * Implementation notes (R4, written from first principles; see README.md for the proofs):
 *
 * - Why the positions are computed incrementally. g_0 = h1 mod m and g_{i+1} = (g_i + s) mod m with
 *   s = h2 mod m. Both g_i and s are below m, so g_i + s < 2m and one conditional subtraction
 *   replaces the `mod`. By induction g_i = ((h1 mod m) + i·s) mod m, exactly the spec's formula,
 *   with no multiplication and no division inside the loop, and every intermediate below 2m.
 * - Why the seven positions of one key are always distinct. m is a multiple of 32 and s is odd
 *   (h2 is odd and m is even, so h2 mod m keeps h2's parity). If g_i = g_j for 0 ≤ i < j ≤ 6 then
 *   m divides (j − i)·s; s is odd, so 32 divides j − i, which is impossible for 0 < j − i ≤ 6.
 *   Forcing h2 odd is what rules out s = 0, where all seven probes would hit one bit.
 * - Why there are no false negatives (BF1). `add` only ever ORs bits in, and only `rebuild`
 *   replaces the array, so every bit that add(x) set is still set when mayContain(x) looks.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** The interface requested by rag-semantic-search.md. */
export interface BloomFilter {
  /** O(k); needs ≥ 8 bytes (SHA-256 gives 32), else RANGE. */
  add(hashBytes: Uint8Array): void;
  /** O(k); false ⇒ certainly absent. RANGE below 8 bytes. */
  mayContain(hashBytes: Uint8Array): boolean;
  /** Clear and resize to 10 bits per key for `nDesign` (an integer ≥ 1, else RANGE); the caller re-adds live hashes. */
  rebuild(nDesign: number): void;
  /** Adds since the last rebuild (an upper bound on the members). */
  readonly count: number;
  readonly nDesign: number;
  readonly mBits: number;
  readonly k: number;
  /** (1 − e^{−k·count/m})^k. */
  expectedFpr(): number;
  stats(): DsaStats;
}

export interface BloomOptions {
  /** Design capacity: an integer ≥ 1, else RANGE. */
  nDesign: number;
  bitsPerKey?: 10;
  k?: 7;
}

/** Bits per key at design load (rag-semantic-search.md §3.9). */
const BITS_PER_KEY = 10;
/** Hash functions per key: k = 7 ≈ (m/n)·ln 2 = 6.93, the FPR-optimal integer for 10 bits per key. */
const K = 7;
/** Hash bytes the positions are derived from: two little-endian u32s. */
const MIN_HASH_BYTES = 8;
/**
 * Largest accepted nDesign. It keeps m ≤ 2^32 bits (a 512 MiB bit array), so every bit position
 * fits in an unsigned 32-bit integer and the word index can be taken with `pos >>> 5`. It is far
 * above anything the indexer builds (16,384 doubling), and it keeps the spec's 8m < 2^53 bound.
 */
const MAX_N_DESIGN = Math.floor(2 ** 32 / BITS_PER_KEY);

/** m for a design capacity: 10 bits per key rounded UP to a whole number of 32-bit words (BF3). */
function bitsFor(nDesign: number): number {
  return Math.ceil((nDesign * BITS_PER_KEY) / 32) * 32;
}

/** RANGE unless `nDesign` is an integer in [1, MAX_N_DESIGN] (NaN and fractions included). */
function checkNDesign(nDesign: number): void {
  if (!Number.isInteger(nDesign) || nDesign < 1 || nDesign > MAX_N_DESIGN) {
    throw new DsaError(
      'RANGE',
      `bloom: nDesign must be an integer in [1, ${MAX_N_DESIGN}], got ${nDesign}`,
    );
  }
}

/** RANGE unless the hash has at least 8 bytes (only bytes 0..7 are read). */
function checkHash(hashBytes: Uint8Array): void {
  if (hashBytes.length < MIN_HASH_BYTES) {
    throw new DsaError(
      'RANGE',
      `bloom: a hash needs at least ${MIN_HASH_BYTES} bytes, got ${hashBytes.length}`,
    );
  }
}

/**
 * Little-endian u32 at `offset`, as a non-negative number in [0, 2^32). The caller has checked the
 * length, so the `?? 0` fallbacks never fire; they only satisfy noUncheckedIndexedAccess.
 */
function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * a mod m for integers 0 ≤ a < 2^32 and 1 ≤ m ≤ 2^32: the same value as `a % m`, but computed as
 * a − ⌊a / m⌋·m. V8 evaluates `%` on values that do not fit an int32 (half of all u32 hashes)
 * with a slow floating-point remainder call; one division and a floor are much cheaper (about 25%
 * of add's time on the dev machine). It is exact: with a = q·m + r (0 ≤ r < m), the correctly
 * rounded a / m lies in [q, q + 1), because its rounding error is at most (a / m)·2^−53 < 2^−21 / m,
 * less than the gap (m − r) / m ≥ 1 / m below q + 1. So the floor is q, and q·m ≤ a < 2^32 and
 * a − q·m are exact integers in a double.
 */
function modU32(a: number, m: number): number {
  return a - Math.floor(a / m) * m;
}

/** Set bits of one 32-bit word (SWAR popcount: pairs, nibbles, bytes, then a byte sum). */
function popcount32(word: number): number {
  let x = word - ((word >>> 1) & 0x55555555); // each 2-bit field holds the count of its 2 bits
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); // each 4-bit field holds the count of its 4 bits
  x = (x + (x >>> 4)) & 0x0f0f0f0f; // each byte holds the count of its 8 bits
  return Math.imul(x, 0x01010101) >>> 24; // the top byte of x · 0x01010101 is the sum of the 4 bytes
}

export class DoubleHashBloom implements BloomFilter {
  /** The bit array: bit `pos` lives in word `pos >>> 5` at bit `pos & 31`. Length m / 32. */
  #bits: Uint32Array;
  /** m, the number of bits; always bits.length · 32. */
  #m: number;
  #nDesign: number;
  /** Adds since the last rebuild (duplicates included). */
  #count = 0;
  /** The popcount checkInvariants() saw last; BF2 says the next one is never smaller. */
  #lastPopcount = 0;

  constructor(opts: BloomOptions) {
    // bitsPerKey and k are fixed by rag-semantic-search.md §3.9; the literal types say so. They are
    // read as `unknown` so that a caller that bypasses the types gets RANGE, not a different filter.
    const { bitsPerKey = BITS_PER_KEY, k = K }: { bitsPerKey?: unknown; k?: unknown } = opts;
    if (bitsPerKey !== BITS_PER_KEY) {
      throw new DsaError(
        'RANGE',
        `bloom: bitsPerKey is fixed at ${BITS_PER_KEY}, got ${String(bitsPerKey)}`,
      );
    }
    if (k !== K) throw new DsaError('RANGE', `bloom: k is fixed at ${K}, got ${String(k)}`);
    checkNDesign(opts.nDesign);
    this.#nDesign = opts.nDesign;
    this.#m = bitsFor(opts.nDesign);
    this.#bits = new Uint32Array(this.#m / 32); // zero-filled by the platform
  }

  /** Set the k = 7 bits of `hashBytes`. O(k); only ORs bits in, which is what makes BF1 and BF2 hold. */
  add(hashBytes: Uint8Array): void {
    checkHash(hashBytes);
    const bits = this.#bits;
    const m = this.#m;
    const step = modU32((u32le(hashBytes, 4) | 1) >>> 0, m); // h2 forced odd, so step is odd and never 0
    let pos = modU32(u32le(hashBytes, 0), m); // g_0 = h1 mod m
    for (let i = 0; i < K; i++) {
      const w = pos >>> 5;
      bits[w] = (bits[w] ?? 0) | (1 << (pos & 31));
      pos += step; // g_{i+1} = (g_i + step) mod m; g_i + step < 2m, so one subtraction suffices
      if (pos >= m) pos -= m;
    }
    this.#count++;
  }

  /** True when all k bits are set. O(k), stopping at the first clear bit; false ⇒ certainly absent. */
  mayContain(hashBytes: Uint8Array): boolean {
    checkHash(hashBytes);
    const bits = this.#bits;
    const m = this.#m;
    // The same k positions as add (duplicated rather than shared: a helper would allocate a pair).
    const step = modU32((u32le(hashBytes, 4) | 1) >>> 0, m);
    let pos = modU32(u32le(hashBytes, 0), m);
    for (let i = 0; i < K; i++) {
      if (((bits[pos >>> 5] ?? 0) & (1 << (pos & 31))) === 0) return false;
      pos += step;
      if (pos >= m) pos -= m;
    }
    return true;
  }

  /**
   * Forget every hash and resize for `nDesign`. O(m / 32): a new zeroed array, or an in-place
   * clear when the size is unchanged. Validates first, so a RANGE error leaves the filter intact.
   */
  rebuild(nDesign: number): void {
    checkNDesign(nDesign);
    const m = bitsFor(nDesign);
    if (m === this.#m) this.#bits.fill(0);
    else this.#bits = new Uint32Array(m / 32);
    this.#m = m;
    this.#nDesign = nDesign;
    this.#count = 0;
    this.#lastPopcount = 0; // BF2 holds "between rebuilds": the popcount restarts at 0 here
  }

  get count(): number {
    return this.#count;
  }

  get nDesign(): number {
    return this.#nDesign;
  }

  get mBits(): number {
    return this.#m;
  }

  get k(): number {
    return K;
  }

  /** The textbook estimate (1 − e^{−k·count/m})^k for the current count; 0 when empty. O(1). */
  expectedFpr(): number {
    return (1 - Math.exp(-(K * this.#count) / this.#m)) ** K;
  }

  /**
   * size = adds since the last rebuild; capacity = nDesign (the load the 0.82% target is sized for);
   * bytesAllocated = bytesUsed = m / 8. A Bloom filter has no free slots: every key's bits are
   * spread over the whole array, so all of it is in use from the first add.
   */
  stats(): DsaStats {
    const bytes = this.#bits.byteLength;
    return { size: this.#count, capacity: this.#nDesign, bytesAllocated: bytes, bytesUsed: bytes };
  }

  /** Set bits (popcount of `bits`), O(m / 32). */
  bitCount(): number {
    const bits = this.#bits;
    let total = 0;
    for (let w = 0; w < bits.length; w++) total += popcount32(bits[w] ?? 0);
    return total;
  }

  /**
   * BF3 (size) and BF2 (popcount monotone since the last rebuild, and at most k per add). BF1 needs
   * the member set, so the property test checks it. Throws DsaError INVALID naming the invariant.
   */
  checkInvariants(): void {
    const m = this.#m;
    if (m % 32 !== 0 || m < BITS_PER_KEY * this.#nDesign || m !== this.#bits.length * 32) {
      throw new DsaError(
        'INVALID',
        `BF3 mBits ${m} must be a multiple of 32, ≥ 10 · nDesign = ${BITS_PER_KEY * this.#nDesign}, and equal 32 · ${this.#bits.length} words`,
      );
    }
    const popcount = this.bitCount();
    if (popcount < this.#lastPopcount) {
      throw new DsaError(
        'INVALID',
        `BF2 popcount fell from ${this.#lastPopcount} to ${popcount} without a rebuild`,
      );
    }
    if (popcount > K * this.#count) {
      throw new DsaError(
        'INVALID',
        `BF2 popcount ${popcount} exceeds k · count = ${K * this.#count} since the last rebuild`,
      );
    }
    this.#lastPopcount = popcount;
  }
}
