/**
 * Test-only doubles for the team-written dsa/ structures (C16) and for the kernel services that
 * ai/ receives by injection. They favour obviousness over speed: sorted arrays, not heaps. They
 * are never imported by production code.
 */
import type { BoundedTopK, IndexedMinHeap, Ring } from '../src/util/deps.ts';
import type { Cred } from '../src/util/cred.ts';

/** BoundedTopK double: a sorted array; admission once full is strictly `score > min`. */
export function sortedTopK(k: number): BoundedTopK {
  let items: Array<{ handle: number; score: number }> = [];
  return {
    k,
    get size() {
      return items.length;
    },
    offer(handle, score) {
      if (items.length < k) {
        items.push({ handle, score });
        items.sort((a, b) => a.score - b.score);
        return true;
      }
      const min = items[0];
      if (min === undefined || !(score > min.score)) return false;
      items[0] = { handle, score };
      items.sort((a, b) => a.score - b.score);
      return true;
    },
    minScore() {
      return items.length < k ? undefined : items[0]?.score;
    },
    drainDescending() {
      const out = [...items].reverse();
      items = [];
      return out;
    },
  };
}

/** IndexedMinHeap double: a Map plus a linear minimum scan (ties by handle). */
export function mapMinHeap(): IndexedMinHeap {
  const keys = new Map<number, number>();
  const min = (): number | undefined => {
    let best: number | undefined;
    for (const [h, k] of keys) {
      const bk = best === undefined ? undefined : keys.get(best);
      if (bk === undefined || k < bk || (k === bk && h < (best ?? 0))) best = h;
    }
    return best;
  };
  return {
    push(handle, key) {
      if (keys.has(handle)) throw new Error('DUPLICATE');
      keys.set(handle, key);
    },
    pop() {
      const h = min();
      if (h !== undefined) keys.delete(h);
      return h;
    },
    peek: min,
    changePriority(handle, key) {
      if (!keys.has(handle)) return false;
      keys.set(handle, key);
      return true;
    },
    remove(handle) {
      return keys.delete(handle);
    },
    has(handle) {
      return keys.has(handle);
    },
    keyOf(handle) {
      return keys.get(handle);
    },
    get size() {
      return keys.size;
    },
  };
}

/** Ring double: an array that drops its oldest entry when full. */
export function arrayRing<T>(capacity: number): Ring<T> {
  let items: T[] = [];
  return {
    capacity,
    get size() {
      return items.length;
    },
    push(x) {
      items.push(x);
      if (items.length > capacity) items = items.slice(items.length - capacity);
    },
    at(i) {
      return items[i];
    },
    clear() {
      items = [];
    },
    toArray() {
      return [...items];
    },
  };
}

export { posixOracle } from '../eval/fixtures/perm.ts';

export function cred(uid: number, gid = 100, groups: number[] = []): Cred {
  return { uid, gid, groups };
}

/** A deterministic unit vector in 384 dims from a seed (for index tests). */
export function unitVector(seed: number, dims = 384): Float32Array<ArrayBuffer> {
  const v = new Float32Array(dims);
  let s = seed >>> 0 || 1;
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    const x = s / 0x1_0000_0000 - 0.5;
    v[i] = x;
    norm += x * x;
  }
  const n = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}
