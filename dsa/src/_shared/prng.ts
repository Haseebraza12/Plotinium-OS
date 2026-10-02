/**
 * mulberry32: the seeded 32-bit PRNG used by every dsa/ test and benchmark workload
 * (specs/08-dsa/data-structures.md §4.0 and §7.1, fixed seed 42). Tests and benchmarks only; never
 * used for anything security-relevant.
 */

/** A generator of floats in [0, 1) that is fully determined by `seed`. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An integer in [0, n) from a mulberry32 generator. */
export function randomInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}
