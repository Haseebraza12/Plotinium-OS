/**
 * The store adapters and the errno mapping: the memory adapter keeps the IndexedDB semantics the VFS
 * relies on (one all-or-nothing transaction, request order, ConstraintError, fault hook, key order),
 * the adapter selection falls back to memory when IndexedDB is unavailable, and every lower-layer
 * failure reaches callers as an errno of the master table (syscall-abi.md §4.9).
 */
import { ERRNO_NAMES } from '@plotinium/protocol';
import type { DentryRec, InodeRec, MetaRec } from '@plotinium/vfs';
import { VfsError, dirBounds } from '@plotinium/vfs';
import { describe, expect, it } from 'vitest';

import { KernelError } from '../../errors.ts';
import { fsError, reasonOf, toKernelError } from '../errno.ts';
import { MemStore } from '../mem-store.ts';
import { createFsStore } from '../store.ts';

function inode(ino: string, over: Partial<InodeRec> = {}): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'f',
    mode: 0o644,
    uid: 1000,
    gid: 100,
    size: 0,
    nlink: 1,
    version: 1,
    atime: 0,
    mtime: 0,
    ctime: 0,
    btime: 0,
    blob: null,
    target: null,
    ...over,
  };
}

const ino = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

async function errnoOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof VfsError
      ? `${e.errno}${e.detail === undefined ? '' : `:${e.detail}`}`
      : 'other';
  }
}

describe('DB-02 memory store transactions', () => {
  it('DB-02 an injected fault after N inode writes rolls back every write of the transaction', async () => {
    const s = new MemStore();
    const r = s.tx(
      ['inodes', 'meta'],
      'strict',
      (t) => {
        t.put('meta', { k: 'x', v: 1 });
        for (let i = 1; i <= 3; i++) t.put('inodes', inode(ino(i)));
      },
      { label: 'test', fault: { after: 2 } },
    );
    expect(await errnoOf(r)).toBe('EIO:injected');
    expect(s.count('inodes')).toBe(0);
    expect(s.count('meta')).toBe(0);
    const ok = await s.tx(['inodes'], 'strict', (t) => t.put('inodes', inode(ino(9))), {
      label: 'test',
      fault: { after: 5 },
    });
    expect(ok).toEqual({ nodeOps: 1, faultNotReached: true });
  });

  it('DB-02 add of an existing key or a unique-index clash aborts with EEXIST and changes nothing', async () => {
    const s = new MemStore();
    await s.tx(['inodes'], 'strict', (t) => t.add('inodes', inode(ino(1))));
    expect(
      await errnoOf(
        s.tx(['inodes'], 'strict', (t) => {
          t.put('inodes', inode(ino(2)));
          t.add('inodes', inode(ino(1)));
        }),
      ),
    ).toBe('EEXIST');
    expect(s.count('inodes')).toBe(1);
    await s.tx(['users'], 'strict', (t) => t.add('users', { uid: 1, username: 'a' }));
    expect(
      await errnoOf(s.tx(['users'], 'strict', (t) => t.add('users', { uid: 2, username: 'a' }))),
    ).toBe('EEXIST');
  });

  it('DB-02 request callbacks run in order, a check aborts, and a store outside the scope is EIO', async () => {
    const s = new MemStore();
    const order: string[] = [];
    await s.tx(['meta'], 'relaxed', (t) => {
      t.put('meta', { k: 'a', v: 1 });
      t.get<MetaRec>('meta', 'a', undefined, (v) => {
        order.push(`get a=${String(v?.v)}`);
        t.put('meta', { k: 'b', v: 2 });
      });
      t.put('meta', { k: 'c', v: 3 });
    });
    expect(order).toEqual(['get a=1']);
    expect(s.dump<MetaRec>('meta').map((m) => m.k)).toEqual(['a', 'b', 'c']);
    expect(await errnoOf(s.tx(['meta'], 'strict', (t) => t.get('meta', 'a', () => 'EAGAIN')))).toBe(
      'EAGAIN',
    );
    expect(await errnoOf(s.tx(['meta'], 'strict', (t) => t.put('inodes', inode(ino(1)))))).toBe(
      'EIO:storage',
    );
    expect(s.durabilities).toEqual(['relaxed', 'strict', 'strict']);
  });

  it('DB-02 adjustUsers enforces the quota inside the transaction and root is exempt', async () => {
    const s = new MemStore();
    const user = {
      uid: 1000,
      username: 'alice',
      quotaBytes: 10,
      quotaInodes: 5,
      usedBytes: 8,
      usedInodes: 1,
    };
    await s.tx(['users'], 'strict', (t) => {
      t.put('users', user);
      t.put('users', { ...user, uid: 0, username: 'root' });
    });
    expect(await errnoOf(s.tx(['users'], 'strict', (t) => t.adjustUsers(1000, 5, 0)))).toBe(
      'EDQUOT',
    );
    await s.tx(['users'], 'strict', (t) => t.adjustUsers(0, 5_000, 10));
    expect(await s.get('users', 0)).toMatchObject({ usedBytes: 5_008 });
  });

  it('VFS-01 keys order like IndexedDB keys and a directory scan returns only its entries', async () => {
    const s = new MemStore();
    const a = ino(0xa);
    const b = ino(0xb);
    await s.tx(['dentries'], 'strict', (t) => {
      for (const [parent, name] of [
        [b, 'z'],
        [a, 'b'],
        [a, 'a'],
        [b, 'a'],
        [a, '\u{1F600}'],
      ] as const) {
        t.add('dentries', { parent, name, ino: ino(name.length), dtype: 'f' } satisfies DentryRec);
      }
    });
    const inA: string[] = [];
    await s.scan<DentryRec>('dentries', dirBounds(a), (d) => inA.push(d.name));
    expect(inA).toEqual(['a', 'b', '\u{1F600}']);
    expect(await s.getByIndex('dentries', 'by_ino', ino(1))).toHaveLength(4);
    await s.tx(['outbox'], 'strict', (t) => {
      t.add('outbox', { opId: ino(1), osSessionId: ino(2), cseq: 1, state: 'pending' });
      t.add('outbox', { opId: ino(3), osSessionId: ino(2), cseq: 2, state: 'pending' });
    });
    expect(s.dump<{ seq: number }>('outbox').map((o) => o.seq)).toEqual([1, 2]);
  });

  it('DB-02 values are cloned in and out, so a caller never aliases a stored row', async () => {
    const s = new MemStore();
    const rec = inode(ino(1));
    await s.tx(['inodes'], 'strict', (t) => t.put('inodes', rec));
    rec.size = 99;
    const got = await s.get<InodeRec>('inodes', ino(1));
    expect(got?.size).toBe(0);
    if (got !== undefined) got.size = 5;
    expect((await s.get<InodeRec>('inodes', ino(1)))?.size).toBe(0);
  });
});

describe('store adapter selection', () => {
  it('OFF-01 without IndexedDB the file system runs on the memory adapter', async () => {
    const r = await createFsStore({ indexedDB: null });
    expect(r.store.kind).toBe('memory');
    expect(r.fallback).toBe('IndexedDB unavailable');
    expect((await createFsStore({ forceMemory: true })).store.kind).toBe('memory');
  });

  it('OFF-01 an IndexedDB that fails to open falls back to memory with the reason', async () => {
    const failing = {
      open: () => {
        const req: { onerror: (() => void) | null; error: { name: string; message: string } } = {
          onerror: null,
          error: { name: 'UnknownError', message: 'blocked' },
        };
        setTimeout(() => req.onerror?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    const r = await createFsStore({ indexedDB: failing });
    expect(r.store.kind).toBe('memory');
    expect(r.fallback).toContain('IndexedDB failed to open');
  });
});

describe('ABI-05 errno mapping', () => {
  it('ABI-05 VFS and store failures map to master-table errnos with registered reasons', () => {
    const cases: [unknown, string, string | undefined][] = [
      [new VfsError('EIO', 'fencing'), 'EIO', 'storage'],
      [new VfsError('EIO', 'injected'), 'EIO', 'injected'],
      [new VfsError('EAGAIN', 'not-mirrored-offline'), 'EAGAIN', 'offline'],
      [new VfsError('EPERM', 'synthesised'), 'EPERM', 'system-path'],
      [new VfsError('EBUSY', 'lease'), 'EBUSY', 'lease'],
      [{ name: 'QuotaExceededError' }, 'EDQUOT', 'device-full'],
      [{ name: 'ConstraintError' }, 'EEXIST', undefined],
      [{ name: 'UnknownError' }, 'EIO', 'storage'],
      [{ name: 'TransactionInactiveError' }, 'EIO', 'abort'],
    ];
    for (const [input, errno, reason] of cases) {
      const k = toKernelError(input);
      expect(k).toBeInstanceOf(KernelError);
      expect(ERRNO_NAMES).toContain(k.errno);
      expect(k.errno).toBe(errno);
      expect(k.detail?.reason).toBe(reason);
    }
  });

  it('ABI-05 an EPERM without detail gets the reason its call implies and a batch failure its op index', () => {
    expect(reasonOf('EPERM', undefined, 'chmod')).toBe('owner');
    expect(reasonOf('EPERM', undefined, 'chown')).toBe('root-only');
    expect(reasonOf('EPERM', undefined, 'unlink')).toBe('sticky');
    expect(toKernelError(new VfsError('ENOENT', undefined, 3), { call: 'batch' }).detail).toEqual({
      step: 3,
    });
    expect(fsError('EACCES', undefined, { path: '/home/bob' }).detail).toEqual({
      path: '/home/bob',
    });
    expect(fsError('EACCES', undefined, { path: 'x'.repeat(5_000) }).detail).toBeUndefined();
  });

  it('ABI-12 an unexpected error is not disguised as an errno (the dispatcher logs it and answers EIO)', () => {
    expect(() => toKernelError(new TypeError('bug'))).toThrow(TypeError);
  });
});
