/**
 * Deterministic data for the demo programs: the mulberry32 generator every Plotinium fixture uses
 * (tests/fixtures/rng.ts, TST-22), memhog's page fill pattern and its page checksum.
 *
 * A page's bytes are a pure function of (seed, child, page, generation), so a page that comes back
 * from swap can be checked against the checksum recorded when it was written, and a page whose
 * body was lost can be re-created exactly. All functions here are plain (no generators): each is
 * called for at most one 256 KiB page between two yield points (about 0.3 ms).
 */

// -----------------------------------------------------------------------------------------------
// mulberry32 (identical to tests/fixtures/rng.ts)
// -----------------------------------------------------------------------------------------------

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

/**
 * One mulberry32 step on an explicit state, for generators kept in a program's serialisable `st`
 * (a closure is not state). `mulberryStep(s)` gives the same sequence as `mulberry32(s)`.
 */
export function mulberryStep(state: number): { value: number; state: number } {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a };
}

// -----------------------------------------------------------------------------------------------
// Page fill and checksum
// -----------------------------------------------------------------------------------------------

/** 32-bit finaliser (murmur3 fmix32): spreads every input bit over the word. */
function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The non-zero xorshift32 seed of one page generation. */
export function pageSeed(seed: number, child: number, page: number, gen: number): number {
  let h = fmix32(seed ^ 0x9e3779b9);
  h = fmix32(h ^ Math.imul(child + 1, 0x27d4eb2f));
  h = fmix32(h ^ Math.imul(page + 1, 0x165667b1));
  h = fmix32(h ^ Math.imul(gen + 1, 0x61c88647));
  return h === 0 ? 0x6d2b79f5 : h;
}

export interface PageKey {
  readonly seed: number;
  readonly child: number;
  readonly page: number;
  readonly gen: number;
  /** A repeating text line instead of xorshift noise (`memhog --compressible`). */
  readonly compressible: boolean;
}

/** Streaming checksum state: two independent 32-bit lanes over little-endian words. */
class Sum {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;
  private k = 0;

  word(w: number): void {
    this.a = Math.imul(this.a ^ w, 0x01000193);
    let b = Math.imul((this.b ^ w) + this.k, 0x5bd1e995);
    b ^= b >>> 15;
    this.b = b;
    this.k = (this.k + 0x9e3779b9) >>> 0;
  }

  hex(len: number): string {
    const a = fmix32(this.a ^ len);
    const b = fmix32(this.b ^ Math.imul(len, 0x2545f491));
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** The body as 32-bit words when it can be viewed as such without copying, else null. */
function wordsOf(body: Uint8Array): Uint32Array | null {
  if (!LITTLE_ENDIAN || body.byteOffset % 4 !== 0) return null;
  return new Uint32Array(body.buffer, body.byteOffset, body.byteLength >>> 2);
}

function readWord(body: Uint8Array, i: number): number {
  return (
    ((body[i] ?? 0) |
      ((body[i + 1] ?? 0) << 8) |
      ((body[i + 2] ?? 0) << 16) |
      ((body[i + 3] ?? 0) << 24)) >>>
    0
  );
}

function writeWord(body: Uint8Array, i: number, w: number, n = 4): void {
  for (let j = 0; j < n; j++) body[i + j] = (w >>> (8 * j)) & 0xff;
}

/**
 * The checksum of a page body: 16 hex digits. The body is read as little-endian 32-bit words (a
 * zero-padded last word for a length that is not a multiple of 4) and the length is mixed in, so
 * any changed, missing or extra byte changes it.
 */
export function checksum(body: Uint8Array): string {
  const sum = new Sum();
  const words = wordsOf(body);
  const full = body.byteLength >>> 2;
  if (words !== null) {
    for (let k = 0; k < full; k++) sum.word(words[k] ?? 0);
  } else {
    for (let k = 0; k < full; k++) sum.word(readWord(body, k * 4));
  }
  const tail = body.byteLength & 3;
  if (tail !== 0) {
    let w = 0;
    for (let j = 0; j < tail; j++) w |= (body[full * 4 + j] ?? 0) << (8 * j);
    sum.word(w >>> 0);
  }
  return sum.hex(body.byteLength);
}

/** The repeating line of a compressible page, e.g. `memhog seed 42 child 3 page 17 gen 2\n`. */
export function compressibleLine(key: PageKey): string {
  return `memhog seed ${String(key.seed)} child ${String(key.child)} page ${String(key.page)} gen ${String(key.gen)}\n`;
}

/**
 * Fills `body` with the pattern of `key` and returns its checksum, computed in the same pass
 * (so it always equals `checksum(body)` afterwards).
 */
export function fillPage(body: Uint8Array, key: PageKey): string {
  const sum = new Sum();
  const full = body.byteLength >>> 2;
  const tail = body.byteLength & 3;
  if (key.compressible) {
    const line = new TextEncoder().encode(compressibleLine(key));
    for (let i = 0; i < body.byteLength; i++) body[i] = line[i % line.length] ?? 0;
    return checksum(body);
  }
  let x = pageSeed(key.seed, key.child, key.page, key.gen);
  const words = wordsOf(body);
  for (let k = 0; k < full; k++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = x >>> 0;
    if (words !== null) words[k] = w;
    else writeWord(body, k * 4, w);
    sum.word(w);
  }
  if (tail !== 0) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = x >>> 0;
    writeWord(body, full * 4, w, tail);
    let masked = 0;
    for (let j = 0; j < tail; j++) masked |= ((w >>> (8 * j)) & 0xff) << (8 * j);
    sum.word(masked >>> 0);
  }
  return sum.hex(body.byteLength);
}

/** The expected bytes of a page, as a fresh buffer (tests, and re-creating a lost body). */
export function pageBytes(len: number, key: PageKey): Uint8Array {
  const body = new Uint8Array(len);
  fillPage(body, key);
  return body;
}
