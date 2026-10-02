/**
 * Random sources for nonces and ids. Production uses `crypto.getRandomValues`; tests and cassette
 * recording pass a seeded source so envelopes replay byte for byte (ai-safety-and-evaluation.md
 * §3.11 "Determinism").
 */

/** Returns a uniformly distributed integer in [0, 2^32). */
export type RandomSource = () => number;

export const cryptoRandom: RandomSource = () => {
  const out = new Uint32Array(1);
  crypto.getRandomValues(out);
  return out[0] ?? 0;
};

/**
 * mulberry32, for deterministic tests and cassettes only (never for secrets). dsa/_shared has the
 * same generator, but ai/ keeps its own three lines rather than depend on a test helper.
 */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
