/**
 * The key store behind the rate limiter's buckets (backend-api.md §3.9, SRV-09): at most 10,000
 * keys per class; evicting a key resets that key's bucket (fail-open for rarely used keys), which
 * is why classes that must hold under a key flood also have a GLOBAL bucket.
 *
 * The spec puts these keys in the team's `dsa/lru` (S5, data-structures.md §4.5), which is written
 * by R1 from first principles and still ships with IMPLEMENTED = false (C16, spec §10.2). The
 * limiter therefore codes against the small `KeyStore` interface below, a subset of `LRU<K, V>`.
 *
 * TODO(R1, C16): once dsa/lru exports IMPLEMENTED = true, construct the store with
 *   `new LruCache<string, V>({ capacity })` from '@plotinium/dsa/lru' in `createKeyStore`.
 * Until then `InsertionOrderKeyStore` bounds the key count with the insertion order of a built-in
 * Map (S12, allowed): it keeps no recency list, so it is NOT an LRU and does not stand in for S5.
 * A flooded store forgets its OLDEST-INSERTED key; for token buckets that only resets a bucket to
 * full, the same fail-open behaviour as an LRU eviction.
 */

/** What the limiter needs from dsa/lru's `LRU<string, V>` (get, put, delete, size). */
export interface KeyStore<V> {
  get(key: string): V | undefined;
  /** Inserts or updates; when the store is full, evicts one key and returns that entry. */
  put(key: string, value: V): [string, V] | undefined;
  delete(key: string): boolean;
  readonly size: number;
  readonly capacity: number | undefined;
}

/** A bounded key store over Map insertion order (see the module comment: not an LRU). */
export class InsertionOrderKeyStore<V> implements KeyStore<V> {
  readonly capacity: number;
  readonly #map = new Map<string, V>();
  #evictions = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('key store capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  put(key: string, value: V): [string, V] | undefined {
    if (this.#map.has(key) || this.#map.size < this.capacity) {
      this.#map.set(key, value);
      return undefined;
    }
    const oldest = this.#map.entries().next();
    this.#map.set(key, value);
    if (oldest.done === true) return undefined;
    this.#map.delete(oldest.value[0]);
    this.#evictions++;
    return oldest.value;
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }

  get size(): number {
    return this.#map.size;
  }

  /** How many keys were evicted because the store was full (a metric and a test hook). */
  get evictions(): number {
    return this.#evictions;
  }
}

/** The one place that chooses the store implementation (see the TODO above). */
export function createKeyStore<V>(capacity: number): KeyStore<V> {
  return new InsertionOrderKeyStore<V>(capacity);
}
