/**
 * Writes under leases and fencing tokens (offline-and-sync.md §3.14.4; database.md §3.13), and the
 * lease-expiry index over the dsa/heap interface (§5.6).
 */
import { describe, expect, it } from 'vitest';

import { HEAP_IMPLEMENTED } from '@plotinium/dsa';

import { defaultHeapFactory, ExpiryIndex, EXPIRY_INDEX_KIND } from './expiry-index.ts';
import { checkWriteLeases, type LeaseState } from './fencing.ts';
import { compatible } from './store.ts';
import { testHeapFactory } from './tests/test-heap.ts';

const INO = 'file-1';
const lease = (o: Partial<LeaseState>): LeaseState => ({
  ino: INO,
  osSessionId: 'os-a',
  mode: 'X',
  fence: 41,
  live: true,
  ...o,
});

describe('VFS-09 writes under leases (§3.14.4)', () => {
  const base = {
    osSessionId: 'os-a',
    fences: [],
    targets: [{ ino: INO, lockFence: 0 }],
    leases: [],
    bulk: false,
  };

  it('VFS-09 with no lease rows the write is allowed (the version CAS still applies)', () => {
    expect(checkWriteLeases(base)).toEqual({ ok: true });
  });

  it('VFS-09 a live lease of another OS session makes a write EBUSY lease, and a bulk op EBUSY subtree-busy', () => {
    const leases = [lease({ osSessionId: 'os-b', mode: 'S' })];
    expect(checkWriteLeases({ ...base, leases })).toEqual({
      ok: false,
      errno: 'EBUSY',
      reason: 'lease',
      ino: INO,
    });
    expect(checkWriteLeases({ ...base, leases, bulk: true })).toMatchObject({
      reason: 'subtree-busy',
    });
  });

  it('VFS-09 an expired lease of another session no longer blocks', () => {
    expect(
      checkWriteLeases({ ...base, leases: [lease({ osSessionId: 'os-b', live: false })] }),
    ).toEqual({ ok: true });
  });

  it('VFS-09 the holder of X writing with its fence is allowed, and so is a sole S holder', () => {
    expect(
      checkWriteLeases({
        ...base,
        fences: [{ ino: INO, fence: 41 }],
        targets: [{ ino: INO, lockFence: 41 }],
        leases: [lease({})],
      }),
    ).toEqual({ ok: true });
    expect(checkWriteLeases({ ...base, leases: [lease({ mode: 'S' })] })).toEqual({ ok: true });
  });

  it('VFS-09 a stale fence gives EBUSY stale-fence: below inodes.lock_fence, or its own lease gone or expired', () => {
    // alice's frozen tab wakes with fence 41; bob was granted X with fence 42 meanwhile.
    const zombie = {
      ...base,
      fences: [{ ino: INO, fence: 41 }],
      targets: [{ ino: INO, lockFence: 42 }],
      leases: [lease({ osSessionId: 'os-b', fence: 42 })],
    };
    expect(checkWriteLeases(zombie)).toEqual({
      ok: false,
      errno: 'EBUSY',
      reason: 'stale-fence',
      ino: INO,
    });
    const expired = {
      ...base,
      fences: [{ ino: INO, fence: 41 }],
      targets: [{ ino: INO, lockFence: 41 }],
      leases: [lease({ live: false })],
    };
    expect(checkWriteLeases(expired)).toMatchObject({ reason: 'stale-fence' });
    const gone = {
      ...base,
      fences: [{ ino: INO, fence: 41 }],
      targets: [{ ino: INO, lockFence: 41 }],
    };
    expect(checkWriteLeases(gone)).toMatchObject({ reason: 'stale-fence' });
  });

  it('VFS-09 the first failing target decides and rows of other inodes are ignored', () => {
    const r = checkWriteLeases({
      ...base,
      targets: [
        { ino: 'a', lockFence: 0 },
        { ino: 'b', lockFence: 0 },
      ],
      leases: [
        lease({ ino: 'b', osSessionId: 'os-z' }),
        lease({ ino: 'zzz', osSessionId: 'os-z' }),
      ],
    });
    expect(r).toEqual({ ok: false, errno: 'EBUSY', reason: 'lease', ino: 'b' });
  });

  it('VFS-09 compatibility is many S or exactly one X (INV-S6)', () => {
    expect(compatible('S', [])).toBe(true);
    expect(compatible('X', [])).toBe(true);
    expect(compatible('S', [{ mode: 'S' }, { mode: 'S' }])).toBe(true);
    expect(compatible('X', [{ mode: 'S' }])).toBe(false);
    expect(compatible('S', [{ mode: 'X' }])).toBe(false);
  });
});

describe('VFS-09 lease-expiry index over dsa/heap (§5.6)', () => {
  for (const [label, factory] of [
    ['the dsa/heap interface (test double)', testHeapFactory],
    ['the Map stand-in while dsa/heap is pending', null],
  ] as const) {
    it(`VFS-09 pops due entries earliest first, renews in place and forgets removed ones on ${label}`, () => {
      const idx = new ExpiryIndex(factory);
      expect(idx.kind).toBe(factory === null ? 'scan' : 'heap');
      idx.upsert('a', 300);
      idx.upsert('b', 100);
      idx.upsert('c', 200);
      expect(idx.peekDeadline()).toBe(100);
      idx.upsert('b', 400); // renewal = changePriority
      expect(idx.popDue(250)).toEqual([{ id: 'c', deadline: 200 }]);
      expect(idx.size).toBe(2);
      expect(idx.remove('a')).toBe(true);
      expect(idx.remove('a')).toBe(false);
      idx.upsert('d', 50); // reuses a freed handle on the heap
      expect(idx.popDue(1_000).map((d) => d.id)).toEqual(['d', 'b']);
      expect(idx.peekDeadline()).toBeUndefined();
      idx.upsert('e', 1);
      expect(idx.has('e')).toBe(true);
      idx.clear();
      expect(idx.size).toBe(0);
      expect(idx.has('e')).toBe(false);
    });
  }

  it('VFS-09 production uses dsa/heap once it is implemented and the Map stand-in until then', () => {
    expect(EXPIRY_INDEX_KIND).toBe(HEAP_IMPLEMENTED ? 'dsa/heap' : 'Map, dsa/heap pending');
    expect(new ExpiryIndex().kind).toBe(HEAP_IMPLEMENTED ? 'heap' : 'scan');
    expect(defaultHeapFactory === null).toBe(!HEAP_IMPLEMENTED);
  });
});
