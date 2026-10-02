/**
 * mulberry32, the seeded generator every Plotinium fixture uses (seed 42 by default, as db/seed does),
 * so a fixture is byte-identical across machines and runs (TST-22).
 */
export type Rng = () => number;

export const DEFAULT_SEED = 42;

export function mulberry32(seed: number = DEFAULT_SEED): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] inclusive. */
export function intIn(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('pick from an empty list');
  return item;
}
