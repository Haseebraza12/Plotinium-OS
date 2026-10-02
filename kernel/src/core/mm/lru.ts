/**
 * The global page LRU with three segments (specs/03-kernel/memory-and-paging.md §3.5, MEM-02,
 * KMM-04), built on the team-written `dsa/lru` (S5, specs/08-dsa/data-structures.md §4.5).
 *
 *   MRU end → [ HOT … ] ─ [ COLD … ] ─ [ SPEC … ] → LRU end (evicted first)
 *
 * dsa/lru is one hash map + doubly linked list with O(1) put, putAtLru, touch, moveToLru, evict,
 * delete, pin and unpin (C16: its owner implements it; this file only uses its interface). The
 * victim order across segments is the pager's policy (data-structures.md S5 "Demotion"), so each
 * segment is its own `LRU` instance and `evict` asks SPEC, then COLD, then HOT. Every operation
 * is a constant number of O(1) dsa/lru calls, so touch and evict stay O(1) (MEM-02).
 *
 * Pinned entries are unlinked by dsa/lru itself, so `evict` returns "the least recently used
 * unpinned entry" without scanning (INV-M3). Speculative pages enter SPEC with `putAtLru`
 * (DSA-LRU-02: speculative insertion at the LRU end), which also sets dsa/lru's speculative flag.
 */
import { LruCache } from '@plotinium/dsa';
import type { LRU } from '@plotinium/dsa';

import type { LruSeg } from './types.ts';

/** Pages per process in the key space: key = pid · 2^20 + pageId (< 2^35, an exact double). */
export const PAGE_KEY_SPAN = 2 ** 20;

export function pageKey(pid: number, pageId: number): number {
  return pid * PAGE_KEY_SPAN + pageId;
}

export function splitPageKey(key: number): { pid: number; pageId: number } {
  const pid = Math.floor(key / PAGE_KEY_SPAN);
  return { pid, pageId: key - pid * PAGE_KEY_SPAN };
}

/** Creates one unbounded LRU per segment. Tests pass a double; production uses dsa/lru. */
export type LruFactory<V> = (seg: LruSeg) => LRU<number, V>;

export const SEGMENTS: readonly LruSeg[] = ['HOT', 'COLD', 'SPEC'];
/** Eviction order (§3.5.3): speculative, then minimised or over-soft-limit, then HOT. */
const VICTIM_ORDER: readonly LruSeg[] = ['SPEC', 'COLD', 'HOT'];

export class PageLru<V> {
  private readonly lists: Readonly<Record<LruSeg, LRU<number, V>>>;

  constructor(factory: LruFactory<V> = () => new LruCache<number, V>()) {
    this.lists = { HOT: factory('HOT'), COLD: factory('COLD'), SPEC: factory('SPEC') };
  }

  /** The segment that holds `key`, or undefined. O(1): at most three hash lookups. */
  segmentOf(key: number): LruSeg | undefined {
    for (const seg of SEGMENTS) if (this.lists[seg].has(key)) return seg;
    return undefined;
  }

  has(key: number): boolean {
    return this.segmentOf(key) !== undefined;
  }

  /** Insert at the head of `seg` (SPEC: at its LRU end, DSA-LRU-02). Re-inserting moves it. */
  insert(key: number, value: V, seg: LruSeg): void {
    const cur = this.segmentOf(key);
    if (cur !== undefined && cur !== seg) this.lists[cur].delete(key);
    if (seg === 'SPEC') this.lists.SPEC.putAtLru(key, value);
    else this.lists[seg].put(key, value);
  }

  /** Move to the head of its own segment; false when absent. A pinned entry keeps its place. */
  touch(key: number): boolean {
    const seg = this.segmentOf(key);
    return seg !== undefined && this.lists[seg].touch(key);
  }

  /** Change segment, inserting at the head of the new one; keeps the pinned state. */
  move(key: number, to: LruSeg): boolean {
    const from = this.segmentOf(key);
    if (from === undefined) return false;
    if (from === to) return true;
    const list = this.lists[from];
    const value = list.peek(key) as V;
    const pinned = list.isPinned(key);
    list.delete(key);
    this.insert(key, value, to);
    if (pinned) this.lists[to].pin(key);
    return true;
  }

  /** Unlink and forget (page freed, paged out, or busy with I/O). */
  remove(key: number): boolean {
    const seg = this.segmentOf(key);
    return seg !== undefined && this.lists[seg].delete(key);
  }

  /** Pin: the entry leaves the recency list until `unpin` (dsa/lru semantics). */
  pin(key: number): boolean {
    const seg = this.segmentOf(key);
    if (seg === undefined) return false;
    if (!this.lists[seg].isPinned(key)) this.lists[seg].pin(key);
    return true;
  }

  /** Unpin: the entry re-enters its segment at the MRU end. */
  unpin(key: number): boolean {
    const seg = this.segmentOf(key);
    if (seg === undefined) return false;
    if (this.lists[seg].isPinned(key)) this.lists[seg].unpin(key);
    return true;
  }

  isPinned(key: number): boolean {
    const seg = this.segmentOf(key);
    return seg !== undefined && this.lists[seg].isPinned(key);
  }

  /** The victim: the LRU unpinned entry of SPEC, else COLD, else HOT; removed from the list. */
  evict(): { key: number; value: V; seg: LruSeg } | undefined {
    for (const seg of VICTIM_ORDER) {
      const hit = this.lists[seg].evict();
      if (hit) return { key: hit[0], value: hit[1], seg };
    }
    return undefined;
  }

  /** The key `evict` would return, without removing it. */
  peekVictim(): number | undefined {
    for (const seg of VICTIM_ORDER) {
      const k = this.lists[seg].peekLru();
      if (k !== undefined) return k;
    }
    return undefined;
  }

  /** Entries in the list, pinned included. */
  get size(): number {
    return this.lists.HOT.size + this.lists.COLD.size + this.lists.SPEC.size;
  }

  /** Unpinned entries (the ones `evict` can return). */
  get evictableSize(): number {
    return (
      this.lists.HOT.evictableSize + this.lists.COLD.evictableSize + this.lists.SPEC.evictableSize
    );
  }

  segmentSize(seg: LruSeg): number {
    return this.lists[seg].size;
  }

  /** Evictable keys in global order, MRU end first (HOT, COLD, SPEC). O(n); for tests and pmap. */
  keysMruToLru(): number[] {
    const out: number[] = [];
    for (const seg of SEGMENTS) for (const k of this.lists[seg].keysMruToLru()) out.push(k);
    return out;
  }
}
