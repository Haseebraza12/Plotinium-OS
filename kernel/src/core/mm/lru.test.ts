/**
 * The segmented global LRU over the dsa/lru interface (memory-and-paging.md §3.5; MEM-02, KMM-04).
 * dsa/lru is IMPLEMENTED = false (C16), so these tests use the test-only ListLru double; the same
 * suite runs against the real LruCache once its owner flips the flag.
 */
import { IMPLEMENTED as LRU_READY, LruCache } from '@plotinium/dsa/lru';
import { describe, expect, it } from 'vitest';

import { ListLru } from './fixtures/doubles.ts';
import { PAGE_KEY_SPAN, PageLru, pageKey, splitPageKey } from './lru.ts';
import type { LruFactory } from './lru.ts';

const factories: Array<[string, LruFactory<string>]> = [
  ['ListLru double', () => new ListLru<number, string>()],
];
if (LRU_READY) factories.push(['dsa/lru', () => new LruCache<number, string>()]);

describe('page keys', () => {
  it('MEM-02 the global key pid · 2^20 + pageId is exact and splits back', () => {
    const key = pageKey(32_767, PAGE_KEY_SPAN - 1);
    expect(key).toBeLessThan(2 ** 35);
    expect(Number.isSafeInteger(key)).toBe(true);
    expect(splitPageKey(key)).toEqual({ pid: 32_767, pageId: PAGE_KEY_SPAN - 1 });
    expect(splitPageKey(pageKey(7, 0))).toEqual({ pid: 7, pageId: 0 });
  });
});

describe.each(factories)('PageLru over %s', (_name, factory) => {
  const fresh = (): PageLru<string> => new PageLru<string>(factory);

  it('MEM-02 eviction order is speculative, then minimised or over-soft-limit, then least recently used', () => {
    const lru = fresh();
    lru.insert(1, 'hot-old', 'HOT');
    lru.insert(2, 'hot-new', 'HOT');
    lru.insert(3, 'cold', 'COLD');
    lru.insert(4, 'spec', 'SPEC');
    expect(lru.peekVictim()).toBe(4);
    expect(lru.evict()).toEqual({ key: 4, value: 'spec', seg: 'SPEC' });
    expect(lru.evict()).toEqual({ key: 3, value: 'cold', seg: 'COLD' });
    expect(lru.evict()).toEqual({ key: 1, value: 'hot-old', seg: 'HOT' });
    expect(lru.evict()?.key).toBe(2);
    expect(lru.evict()).toBeUndefined();
    expect(lru.peekVictim()).toBeUndefined();
  });

  it('MEM-02 touch moves a page to the MRU end of its own segment', () => {
    const lru = fresh();
    for (const k of [1, 2, 3]) lru.insert(k, `v${k}`, 'HOT');
    expect(lru.touch(1)).toBe(true);
    expect(lru.touch(99)).toBe(false);
    expect(lru.keysMruToLru()).toEqual([1, 3, 2]);
    expect(lru.evict()?.key).toBe(2);
  });

  it('MEM-02 pinned pages are never returned by evict and unpin relinks at the MRU end', () => {
    const lru = fresh();
    lru.insert(1, 'a', 'HOT');
    lru.insert(2, 'b', 'HOT');
    lru.insert(3, 'c', 'COLD');
    expect(lru.pin(1)).toBe(true);
    expect(lru.pin(1)).toBe(true); // idempotent at the pager level
    expect(lru.pin(3)).toBe(true);
    expect(lru.isPinned(1)).toBe(true);
    expect(lru.evictableSize).toBe(1);
    expect(lru.size).toBe(3);
    expect(lru.evict()?.key).toBe(2);
    expect(lru.evict()).toBeUndefined();
    expect(lru.unpin(1)).toBe(true);
    expect(lru.unpin(1)).toBe(true);
    expect(lru.evict()?.key).toBe(1);
    expect(lru.pin(42)).toBe(false);
    expect(lru.unpin(42)).toBe(false);
    expect(lru.isPinned(42)).toBe(false);
  });

  it('MEM-02 move changes segment and keeps the pinned state; remove forgets the page', () => {
    const lru = fresh();
    lru.insert(1, 'a', 'HOT');
    lru.insert(2, 'b', 'HOT');
    lru.pin(1);
    expect(lru.move(1, 'COLD')).toBe(true);
    expect(lru.segmentOf(1)).toBe('COLD');
    expect(lru.isPinned(1)).toBe(true);
    expect(lru.move(2, 'HOT')).toBe(true);
    expect(lru.move(9, 'HOT')).toBe(false);
    expect(lru.move(2, 'COLD')).toBe(true);
    expect(lru.segmentSize('COLD')).toBe(2);
    expect(lru.evict()?.key).toBe(2);
    expect(lru.remove(1)).toBe(true);
    expect(lru.remove(1)).toBe(false);
    expect(lru.has(1)).toBe(false);
    lru.insert(5, 'x', 'HOT');
    lru.insert(5, 'x', 'SPEC'); // re-insert into another segment moves it
    expect(lru.segmentOf(5)).toBe('SPEC');
    expect(lru.size).toBe(1);
  });

  it('MEM-02 lru edge cases: evict on empty, single entry, pin the only entry, unpin into an empty segment', () => {
    const lru = fresh();
    expect(lru.evict()).toBeUndefined();
    lru.insert(1, 'only', 'COLD');
    lru.pin(1);
    expect(lru.evict()).toBeUndefined();
    lru.unpin(1);
    expect(lru.keysMruToLru()).toEqual([1]);
    expect(lru.evict()?.value).toBe('only');
    expect(lru.size).toBe(0);
  });
});
