/**
 * S5 LRU: edge cases (specs/08-dsa/data-structures.md §8.6). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { IMPLEMENTED, LruCache } from '../src/lru/index.ts';
import { expectDsaError } from './helpers.ts';

/** A cache filled with keys in order, so the last key is the MRU head and the first the tail. */
function filled(keys: readonly string[], opts?: { capacity?: number }): LruCache<string, number> {
  const cache = new LruCache<string, number>(opts);
  keys.forEach((k, i) => cache.put(k, i));
  return cache;
}

const order = (cache: LruCache<string, number>): string[] => [...cache.keysMruToLru()];

describe.runIf(IMPLEMENTED)('dsa/lru (S5)', () => {
  it('DSA-LRU-01 get, evict and peekLru on an empty cache return undefined', () => {
    const cache = new LruCache<string, number>();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.evict()).toBeUndefined();
    expect(cache.peekLru()).toBeUndefined();
    expect(cache.has('a')).toBe(false);
    expect(cache.delete('a')).toBe(false);
    expect(cache.touch('a')).toBe(false);
    expect(cache.moveToLru('a')).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.evictableSize).toBe(0);
    expect(cache.capacity).toBeUndefined();
    expect(order(cache)).toEqual([]);
    cache.checkInvariants();
  });

  it('DSA-LRU-01 one entry can be put, read and evicted, leaving the cache empty', () => {
    const cache = new LruCache<string, number>();
    expect(cache.put('a', 1)).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.peekLru()).toBe('a');
    expect(cache.evict()).toEqual(['a', 1]);
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
    expect(cache.evict()).toBeUndefined();
    cache.checkInvariants();
  });

  it('DSA-LRU-01 putting an existing key updates the value and recency without changing size', () => {
    const cache = filled(['a', 'b', 'c']);
    expect(cache.put('a', 10)).toBeUndefined();
    expect(cache.size).toBe(3);
    expect(cache.peek('a')).toBe(10);
    expect(order(cache)).toEqual(['a', 'c', 'b']);
    cache.checkInvariants();
  });

  it('MEM-02 get moves an entry to the MRU end and evict returns the least recently used', () => {
    const cache = filled(['a', 'b', 'c']);
    expect(order(cache)).toEqual(['c', 'b', 'a']);
    expect(cache.get('a')).toBe(0);
    expect(order(cache)).toEqual(['a', 'c', 'b']);
    expect(cache.peek('b')).toBe(1); // peek does not reorder
    expect(cache.evict()).toEqual(['b', 1]);
    expect(cache.touch('c')).toBe(true);
    expect(cache.evict()).toEqual(['a', 0]);
    expect(cache.evict()).toEqual(['c', 2]);
    cache.checkInvariants();
  });

  it('DSA-LRU-01 deleting the MRU head, the LRU tail and a middle entry keeps the list consistent', () => {
    const cache = filled(['a', 'b', 'c', 'd', 'e']);
    expect(cache.delete('e')).toBe(true); // head
    cache.checkInvariants();
    expect(cache.delete('a')).toBe(true); // tail
    cache.checkInvariants();
    expect(cache.delete('c')).toBe(true); // middle
    cache.checkInvariants();
    expect(order(cache)).toEqual(['d', 'b']);
    expect(cache.peekLru()).toBe('b');
    expect(cache.size).toBe(2);
    expect(cache.delete('c')).toBe(false);
  });

  it('MEM-02 a pinned entry is never evicted and evict returns undefined when all are pinned', () => {
    const cache = filled(['a', 'b', 'c']);
    cache.pin('a');
    expect(cache.isPinned('a')).toBe(true);
    expect(cache.evictableSize).toBe(2);
    expect(order(cache)).toEqual(['c', 'b']);
    expect(cache.evict()).toEqual(['b', 1]);
    expect(cache.evict()).toEqual(['c', 2]);
    expect(cache.evict()).toBeUndefined();
    expect(cache.peekLru()).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(0);
    cache.checkInvariants();
  });

  it('DSA-LRU-01 a bounded cache whose entries are all pinned throws FULL on put', () => {
    const cache = filled(['a', 'b'], { capacity: 2 });
    expect(cache.capacity).toBe(2);
    cache.pin('a');
    cache.pin('b');
    expectDsaError(() => cache.put('c', 3), 'FULL');
    expectDsaError(() => cache.putAtLru('c', 3), 'FULL');
    expect(cache.size).toBe(2);
    expect(cache.has('c')).toBe(false);
    expect(cache.put('a', 7)).toBeUndefined(); // an update needs no room
    cache.checkInvariants();
  });

  it('DSA-LRU-01 pin twice then unpin once keeps the entry pinned', () => {
    const cache = filled(['a', 'b']);
    cache.pin('a');
    cache.pin('a');
    cache.unpin('a');
    expect(cache.isPinned('a')).toBe(true);
    expect(cache.evict()).toEqual(['b', 1]);
    expect(cache.evict()).toBeUndefined();
    cache.unpin('a');
    expect(cache.isPinned('a')).toBe(false);
    expect(cache.evict()).toEqual(['a', 0]);
  });

  it('DSA-LRU-01 the last unpin relinks the entry at the MRU end', () => {
    const cache = filled(['a', 'b', 'c']);
    cache.pin('a');
    cache.put('d', 3);
    cache.unpin('a');
    expect(order(cache)).toEqual(['a', 'd', 'c', 'b']);
    cache.checkInvariants();
  });

  it('DSA-LRU-01 get of a pinned entry does not reorder the other entries', () => {
    const cache = filled(['a', 'b', 'c', 'd']);
    cache.pin('b');
    const before = order(cache);
    expect(cache.get('b')).toBe(1);
    expect(cache.touch('b')).toBe(true);
    expect(order(cache)).toEqual(before);
    expect(order(cache)).toEqual(['d', 'c', 'a']);
    cache.checkInvariants();
  });

  it('DSA-LRU-01 pin of an absent key throws NOT_FOUND and unpin of an unpinned key throws INVALID', () => {
    const cache = filled(['a']);
    expectDsaError(() => cache.pin('zz'), 'NOT_FOUND');
    expectDsaError(() => cache.unpin('zz'), 'NOT_FOUND');
    expectDsaError(() => cache.unpin('a'), 'INVALID');
    expect(cache.isPinned('zz')).toBe(false);
    cache.checkInvariants();
  });

  it('DSA-LRU-02 putAtLru entries are evicted before older normal entries', () => {
    const cache = filled(['a', 'b']);
    expect(cache.putAtLru('s', 9)).toBeUndefined();
    expect(cache.isSpeculative('s')).toBe(true);
    expect(cache.isSpeculative('a')).toBe(false);
    expect(order(cache)).toEqual(['b', 'a', 's']);
    expect(cache.peekLru()).toBe('s');
    expect(cache.evict()).toEqual(['s', 9]);
    expect(cache.evict()).toEqual(['a', 0]);

    // Bounded: a speculative insertion into a full cache evicts the LRU entry first.
    const bounded = filled(['x', 'y'], { capacity: 2 });
    expect(bounded.putAtLru('p', 5)).toEqual(['x', 0]);
    expect(order(bounded)).toEqual(['y', 'p']);
    bounded.checkInvariants();
  });

  it('DSA-LRU-02 a hit on a speculative entry promotes it and clears the flag', () => {
    const cache = filled(['a', 'b']);
    cache.putAtLru('s', 9);
    expect(cache.get('s')).toBe(9);
    expect(cache.isSpeculative('s')).toBe(false);
    expect(order(cache)).toEqual(['s', 'b', 'a']);
    cache.putAtLru('t', 8);
    expect(cache.touch('t')).toBe(true);
    expect(cache.isSpeculative('t')).toBe(false);
    cache.putAtLru('u', 7);
    cache.put('u', 6); // a normal put of a speculative key also promotes it
    expect(cache.isSpeculative('u')).toBe(false);
    expect(order(cache)).toEqual(['u', 't', 's', 'b', 'a']);
    cache.checkInvariants();
  });

  it('DSA-LRU-02 moveToLru makes an entry the next eviction', () => {
    const cache = filled(['a', 'b', 'c']);
    expect(cache.moveToLru('c')).toBe(true);
    expect(cache.peekLru()).toBe('c');
    expect(order(cache)).toEqual(['b', 'a', 'c']);
    expect(cache.evict()).toEqual(['c', 2]);
    cache.pin('b');
    expect(cache.moveToLru('b')).toBe(true); // pinned: present, but not in the list
    expect(cache.peekLru()).toBe('a');
    cache.checkInvariants();
  });

  it('DSA-LRU-01 a bounded put on a full cache returns the evicted LRU entry', () => {
    const cache = filled(['a', 'b', 'c'], { capacity: 3 });
    cache.get('a');
    expect(cache.put('d', 3)).toEqual(['b', 1]);
    expect(cache.size).toBe(3);
    expect(order(cache)).toEqual(['d', 'a', 'c']);
    cache.pin('c');
    expect(cache.put('e', 4)).toEqual(['a', 0]); // skips the pinned tail
    expectDsaError(() => new LruCache<string, number>({ capacity: 0 }), 'RANGE');
    expectDsaError(() => new LruCache<string, number>({ capacity: 1.5 }), 'RANGE');
    cache.checkInvariants();
  });

  it('DSA-LRU-01 slot arrays grow across doubling and delete churn reuses slots', () => {
    const cache = new LruCache<number, number>({ initialSlots: 2 });
    for (let i = 0; i < 1_000; i++) cache.put(i, i * 2);
    expect(cache.size).toBe(1_000);
    for (let i = 0; i < 1_000; i++) expect(cache.peek(i)).toBe(i * 2);
    const grown = cache.stats().capacity;
    expect(grown).toBeGreaterThanOrEqual(1_000);
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 500; i++) cache.delete(round * 1_000 + i);
      for (let i = 0; i < 500; i++) cache.put((round + 1) * 1_000 + i, i);
      cache.checkInvariants();
    }
    expect(cache.size).toBe(1_000);
    expect(cache.stats().capacity).toBe(grown);
  });

  it('DSA-LRU-01 number and string keys work, and -0 and +0 are the same key', () => {
    const mixed = new LruCache<number | string, string>();
    mixed.put(1, 'one');
    mixed.put('1', 'string one');
    mixed.put(0, 'zero');
    expect(mixed.size).toBe(3);
    expect(mixed.get(1)).toBe('one');
    expect(mixed.get('1')).toBe('string one');
    expect(mixed.get(-0)).toBe('zero');
    mixed.put(-0, 'negative zero');
    expect(mixed.size).toBe(3);
    expect(mixed.get(0)).toBe('negative zero');
    mixed.checkInvariants();
  });

  it('DSA-LRU-01 checkInvariants detects a pinned slot that is still linked', () => {
    const cache = filled(['a', 'b']);
    cache.checkInvariants();
    cache.debugCorrupt('pinned-linked');
    expect(() => cache.checkInvariants()).toThrow(/L2/);
  });
});
