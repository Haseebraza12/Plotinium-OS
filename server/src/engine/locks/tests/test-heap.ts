/**
 * TEST-ONLY stand-in for dsa/heap's IndexedMinHeap (C16, spec §10.2: the real structure is written
 * by R1 from first principles; product code never replaces it). Linear scans over a Map: correct,
 * trivially reviewable, and far too slow for production, which is the point.
 */
import type { DsaStats, IndexedMinHeap } from '@plotinium/dsa';

export class TestHeap implements IndexedMinHeap {
  readonly #keys = new Map<number, number>();
  /** Insertion order breaks ties, like a stable heap would not guarantee: tests never rely on it. */
  readonly #order = new Map<number, number>();
  #seq = 0;

  push(handle: number, key: number): void {
    if (this.#keys.has(handle)) throw new Error(`DUPLICATE handle ${handle}`);
    if (!Number.isFinite(key) || !Number.isInteger(handle) || handle < 0)
      throw new RangeError('RANGE');
    this.#keys.set(handle, key);
    this.#order.set(handle, this.#seq++);
  }

  #min(): number | undefined {
    let best: number | undefined;
    for (const [h, k] of this.#keys) {
      if (best === undefined) {
        best = h;
        continue;
      }
      const bk = this.#keys.get(best) ?? Infinity;
      if (k < bk || (k === bk && (this.#order.get(h) ?? 0) < (this.#order.get(best) ?? 0)))
        best = h;
    }
    return best;
  }

  pop(): number | undefined {
    const h = this.#min();
    if (h !== undefined) this.remove(h);
    return h;
  }

  peek(): number | undefined {
    return this.#min();
  }

  peekKey(): number | undefined {
    const h = this.#min();
    return h === undefined ? undefined : this.#keys.get(h);
  }

  changePriority(handle: number, key: number): boolean {
    if (!this.#keys.has(handle)) return false;
    if (!Number.isFinite(key)) throw new RangeError('RANGE');
    this.#keys.set(handle, key);
    return true;
  }

  remove(handle: number): boolean {
    this.#order.delete(handle);
    return this.#keys.delete(handle);
  }

  replaceTop(handle: number, key: number): number | undefined {
    const top = this.pop();
    this.push(handle, key);
    return top;
  }

  has(handle: number): boolean {
    return this.#keys.has(handle);
  }

  keyOf(handle: number): number | undefined {
    return this.#keys.get(handle);
  }

  get size(): number {
    return this.#keys.size;
  }

  clear(): void {
    this.#keys.clear();
    this.#order.clear();
  }

  stats(): DsaStats {
    return { size: this.#keys.size, capacity: this.#keys.size, bytesAllocated: 0, bytesUsed: 0 };
  }

  checkInvariants(): void {
    for (const k of this.#keys.values()) if (!Number.isFinite(k)) throw new Error('H4');
  }
}

export const testHeapFactory = (): IndexedMinHeap => new TestHeap();
