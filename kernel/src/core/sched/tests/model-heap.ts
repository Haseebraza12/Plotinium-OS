/**
 * TEST-ONLY double for `dsa/heap` (IndexedMinHeap), used while the team's BinaryHeap is still
 * IMPLEMENTED = false (C16, spec §10.2). It is deliberately NOT a heap: a Map of handle → key with
 * a linear scan for the minimum (O(n) peek and pop). Production code never imports it; the
 * scheduler receives it through `createHeap` in tests only.
 *
 * Ties are broken by the smaller handle so runs are deterministic (the real heap does not break
 * ties; the scheduler's keys are unique and the timer heap sorts due entries itself).
 */
import type { DsaStats } from '@plotinium/dsa';
import type { IndexedMinHeap } from '@plotinium/dsa/heap';

export class ModelHeap implements IndexedMinHeap {
  private readonly entries = new Map<number, number>();
  /** Call counters for PROC-02 assertions (for example "renice calls changeKey once"). */
  readonly calls = { push: 0, pop: 0, changePriority: 0, remove: 0 };

  push(handle: number, key: number): void {
    if (!Number.isInteger(handle) || handle < 0 || !Number.isFinite(key))
      throw new RangeError('RANGE');
    if (this.entries.has(handle)) throw new Error('DUPLICATE');
    this.calls.push++;
    this.entries.set(handle, key);
  }

  pop(): number | undefined {
    const h = this.peek();
    if (h !== undefined) {
      this.calls.pop++;
      this.entries.delete(h);
    }
    return h;
  }

  peek(): number | undefined {
    let best: number | undefined;
    let bestKey = Number.POSITIVE_INFINITY;
    for (const [h, k] of this.entries) {
      if (k < bestKey || (k === bestKey && best !== undefined && h < best)) {
        best = h;
        bestKey = k;
      }
    }
    return best;
  }

  peekKey(): number | undefined {
    const h = this.peek();
    return h === undefined ? undefined : this.entries.get(h);
  }

  changePriority(handle: number, key: number): boolean {
    if (!Number.isFinite(key)) throw new RangeError('RANGE');
    if (!this.entries.has(handle)) return false;
    this.calls.changePriority++;
    this.entries.set(handle, key);
    return true;
  }

  remove(handle: number): boolean {
    const had = this.entries.delete(handle);
    if (had) this.calls.remove++;
    return had;
  }

  replaceTop(handle: number, key: number): number | undefined {
    const top = this.pop();
    this.push(handle, key);
    return top;
  }

  has(handle: number): boolean {
    return this.entries.has(handle);
  }

  keyOf(handle: number): number | undefined {
    return this.entries.get(handle);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): DsaStats {
    return {
      size: this.entries.size,
      capacity: this.entries.size,
      bytesAllocated: 0,
      bytesUsed: 0,
    };
  }

  checkInvariants(): void {
    for (const k of this.entries.values())
      if (!Number.isFinite(k)) throw new Error('H4 key not finite');
  }

  /** Handles in key order (test assertions only). */
  sorted(): number[] {
    return [...this.entries.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([h]) => h);
  }
}

/** Factory with the `HeapFactory` signature that also remembers the heaps it built. */
export function modelHeapFactory(): {
  create: (capacity: number) => ModelHeap;
  built: ModelHeap[];
} {
  const built: ModelHeap[] = [];
  return {
    built,
    create: () => {
      const h = new ModelHeap();
      built.push(h);
      return h;
    },
  };
}
