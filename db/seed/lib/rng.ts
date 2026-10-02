/**
 * Deterministic randomness for the seeds (DBD-18): mulberry32 with a 32-bit seed (seed 42 for the
 * bench seed, 4242 for benchmark parameters; database.md §3.27-§3.28). Two runs with the same seed
 * produce byte-identical data.
 */
export type Rng = () => number;

/** mulberry32: a 32-bit state PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** One random byte. */
export function randByte(rng: Rng): number {
  return Math.floor(rng() * 256);
}

/** Standard normal by Box-Muller (uses two draws). */
export function normal(rng: Rng): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Exponential with the given mean. */
export function exponential(rng: Rng, mean: number): number {
  return -mean * Math.log(1 - rng());
}

/**
 * A Zipf-like sampler over ranks 1..n with exponent s (P(k) proportional to 1 / k^s), by binary
 * search over the cumulative weights: O(n) to build, O(log n) per draw. Returns a 0-based rank.
 */
export function zipfSampler(n: number, s: number): (rng: Rng) => number {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let k = 1; k <= n; k++) {
    total += 1 / k ** s;
    cdf[k - 1] = total;
  }
  return (rng) => {
    const x = rng() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((cdf[mid] ?? 0) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
