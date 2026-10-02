/**
 * op.result construction and the persisted-outcome rule (offline-and-sync.md §3.10, §4.4; INV-S11),
 * the server Lamport clock (§3.5), and the base check for structural ops (§3.12.3).
 */
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { OpResult, sha256Hex } from '@plotinium/protocol';

import { VfsError, type Locked, type OpContext } from '../../vfs/types.ts';
import { baseOf, checkBase, subtreeDigest, withBaseCheck } from './base-check.ts';
import {
  asVfsError,
  LamportClock,
  resultFromError,
  resultFromOutcome,
  retry,
  retryAfterFor,
} from './outcome.ts';
import { uid7 } from './tests/fake-db.ts';

const OP = uid7(0x9400, 1);
const INO = uid7(2, 1);
const check = (r: OpResult): OpResult => v.parse(OpResult, r);

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('OFF-02 op.result shapes (§3.10, §4.4)', () => {
  it('OFF-02 applied and conflict results carry the stored reply fields', () => {
    const applied = check(
      resultFromOutcome(
        OP,
        {
          kind: 'applied',
          status: 'applied',
          result: {
            versions: [{ ino: INO, version: 3, mtime: 5, ctime: 6 }],
            ownerSeqs: [{ ownerUid: 1, seq: 4 }],
            commitTime: '2026-11-14T06:00:00.000Z',
            lamport: 9,
          },
          effects: {},
          owners: [1],
        },
        2,
      ),
    );
    expect(applied).toEqual({
      opId: OP,
      status: 'applied',
      duplicate: false,
      lamport: 9,
      versions: [{ ino: INO, version: 3, mtime: 5, ctime: 6 }],
      ownerSeqs: [{ ownerUid: 1, seq: 4 }],
      commitTime: '2026-11-14T06:00:00.000Z',
    });
    const conflict = check(
      resultFromOutcome(
        OP,
        {
          kind: 'conflict',
          status: 'conflict',
          errno: 'EBUSY',
          result: {
            keptAs: { ino: INO, parentIno: INO, name: 'a (conflict from x, 2026-11-14)' },
            reason: 'stale-fence',
          },
          effects: {},
          owners: [],
        },
        2,
      ),
    );
    expect(conflict).toMatchObject({
      status: 'conflict',
      errno: 'EBUSY',
      reason: 'stale-fence',
      lamport: 2,
    });
  });

  it('OFF-02 a duplicate returns the stored status and errno with duplicate: true; malformed stored fields are ignored one by one', () => {
    const r = check(
      resultFromOutcome(
        OP,
        {
          kind: 'duplicate',
          status: 'rejected',
          errno: 'EACCES',
          result: { errno: 'EACCES', reason: 'not_kebab', constraint: 'x', lamport: 4 },
        },
        7,
      ),
    );
    expect(r).toEqual({
      opId: OP,
      status: 'rejected',
      duplicate: true,
      errno: 'EACCES',
      lamport: 4,
    });
    const pruned = check(
      resultFromOutcome(
        OP,
        { kind: 'duplicate', status: 'applied', errno: null, result: { pruned: true } },
        7,
      ),
    );
    expect(pruned).toMatchObject({ status: 'applied', duplicate: true, pruned: true, lamport: 7 });
    const lost = check(
      resultFromOutcome(
        OP,
        { kind: 'duplicate', status: 'conflict', errno: null, result: null },
        7,
      ),
    );
    expect(lost).toMatchObject({ status: 'applied', pruned: true }); // re-read by snapshot (§3.10)
  });

  it('OFF-02 deterministic failures are rejected (persisted), transient ones retry with retryAfterMs', () => {
    expect(check(resultFromError(OP, new VfsError('EACCES'), 1))).toEqual({
      opId: OP,
      status: 'rejected',
      duplicate: false,
      errno: 'EACCES',
      lamport: 1,
    });
    expect(
      check(resultFromError(OP, new VfsError('EAGAIN', { reason: 'stale-version' }), 1)),
    ).toMatchObject({ status: 'rejected', reason: 'stale-version' });
    expect(
      check(resultFromError(OP, new VfsError('EIO', { reason: 'injected' }), 1)),
    ).toMatchObject({ status: 'rejected', errno: 'EIO' });
    const keep = check(
      resultFromError(
        OP,
        new VfsError('EACCES', { keptAs: { ino: INO, parentIno: INO, name: 'x' } }),
        1,
      ),
    );
    expect(keep.keptAs).toEqual({ ino: INO, parentIno: INO, name: 'x' });
    expect(
      check(resultFromError(OP, new VfsError('EBUSY', { reason: 'lock-timeout' }), 1)),
    ).toMatchObject({ status: 'retry', retryAfterMs: 500 });
    expect(check(resultFromError(OP, new VfsError('ETIMEDOUT'), 1))).toMatchObject({
      status: 'retry',
      retryAfterMs: 1_000,
    });
    expect(check(resultFromError(OP, new VfsError('EIO', { reason: 'server' }), 1))).toMatchObject({
      status: 'retry',
      retryAfterMs: 2_000,
    });
  });

  it('OFF-02 a rejection that was not recorded is never sent as rejected (INV-S11)', () => {
    expect(
      check(resultFromError(OP, new VfsError('EACCES'), 1, { persisted: false })),
    ).toMatchObject({ status: 'retry', errno: 'EIO', reason: 'server' });
  });

  it('OFF-02 retry clamps retryAfterMs and drops unregistrable reasons; unexpected throws are transient EIO', () => {
    expect(retry(OP, 'EAGAIN', 'Bad Reason', 1, 9e9)).toEqual({
      opId: OP,
      status: 'retry',
      duplicate: false,
      errno: 'EAGAIN',
      retryAfterMs: 600_000,
      lamport: 1,
    });
    expect(retryAfterFor('EAGAIN', 'blob-missing')).toBe(0);
    expect(retryAfterFor('EACCES', 'principal')).toBe(1_000);
    expect(retryAfterFor('EAGAIN', undefined)).toBe(500);
    expect(asVfsError(new Error('boom'))).toMatchObject({ errno: 'EIO' });
    const e = new VfsError('ENOENT');
    expect(asVfsError(e)).toBe(e);
  });

  it('OFF-02 the server Lamport clock is max(L, received) + 1 per applied op and never goes back', () => {
    const l = new LamportClock();
    expect(l.tick(10)).toBe(11);
    expect(l.tick(3)).toBe(12);
    expect(l.observe(5)).toBe(12);
    expect(l.observe(40)).toBe(40);
    expect(l.value).toBe(40);
  });
});

describe('VFS-10 structural ops: base versions and subtree digests (§3.3.1, §3.12.3)', () => {
  const versions = new Map([
    ['a', 1],
    ['b', 4],
  ]);

  it('VFS-10 a matching base passes and a changed version is rejected EAGAIN stale-version (stale-plan for a batch)', () => {
    expect(() =>
      checkBase(
        { kind: 'versions', entries: [{ ino: 'a', version: 1 }] },
        (i) => versions.get(i),
        'structural',
      ),
    ).not.toThrow();
    const bad = { kind: 'versions' as const, entries: [{ ino: 'b', version: 3 }] };
    expect(thrown(() => checkBase(bad, (i) => versions.get(i), 'structural'))).toMatchObject({
      errno: 'EAGAIN',
      detail: { reason: 'stale-version' },
    });
    expect(thrown(() => checkBase(bad, (i) => versions.get(i), 'batch'))).toMatchObject({
      detail: { reason: 'stale-plan' },
    });
    expect(() =>
      checkBase(
        { kind: 'versions', entries: [{ ino: 'gone', version: 1 }] },
        (i) => versions.get(i),
        'structural',
      ),
    ).toThrow(VfsError);
  });

  it('VFS-10 the subtree digest is SHA-256 over sorted "<ino>:<version>\\n" lines, each inode once', () => {
    const d = subtreeDigest([
      { ino: 'b', version: 4 },
      { ino: 'a', version: 1 },
      { ino: 'a', version: 1 },
    ]);
    expect(d).toBe(sha256Hex('a:1\nb:4\n'));
    const subtree = () => [...versions].map(([ino, version]) => ({ ino, version }));
    expect(() =>
      checkBase(
        { kind: 'digest', rootIno: 'a', digest: d },
        () => undefined,
        'structural',
        subtree,
      ),
    ).not.toThrow();
    expect(() =>
      checkBase(
        { kind: 'digest', rootIno: 'a', digest: sha256Hex('x') },
        () => undefined,
        'structural',
        subtree,
      ),
    ).toThrow(VfsError);
    expect(
      thrown(() =>
        checkBase({ kind: 'digest', rootIno: 'a', digest: d }, () => undefined, 'structural'),
      ),
    ).toMatchObject({ errno: 'EINVAL' });
  });

  it('VFS-10 withBaseCheck rejects a stale structural op before the handler body runs (nothing changes)', async () => {
    const calls: string[] = [];
    const inner = {
      plan: () =>
        Promise.resolve({ owners: [], renameLock: false, dirs: [], files: [], subtreeRoots: [] }),
      recheck: () => {
        calls.push('inner-recheck');
        return Promise.resolve();
      },
      body: () =>
        Promise.resolve({ status: 'applied' as const, result: null, effects: null, owners: [] }),
    };
    const wrapped = withBaseCheck(inner, 'structural', (locked) => [...locked.rows.values()]);
    const locked: Locked = {
      plan: { owners: [], renameLock: false, dirs: [], files: [], subtreeRoots: [] },
      rows: new Map([
        ['a', { ino: 'a', type: 'f', mode: 0o644, uid: 1, gid: 1, version: 2, lock_fence: 0 }],
      ]),
    };
    const ctx = (base: OpContext['base']): OpContext => ({
      opId: OP,
      principal: { uid: 1, realUid: 1, gids: [1] },
      osSessionId: OP,
      cseq: 1,
      lamport: 1,
      call: 'unlink',
      args: null,
      ...(base === undefined ? {} : { base }),
      signal: new AbortController().signal,
    });
    await expect(
      wrapped.recheck(null, ctx({ kind: 'versions', value: [{ ino: 'a', version: 1 }] }), locked),
    ).rejects.toMatchObject({ errno: 'EAGAIN' });
    expect(calls).toEqual([]);
    await wrapped.recheck(
      null,
      ctx({ kind: 'versions', value: [{ ino: 'a', version: 2 }] }),
      locked,
    );
    await wrapped.recheck(null, ctx(undefined), locked);
    await wrapped.recheck(
      null,
      ctx({ kind: 'digest', value: { rootIno: 'a', digest: sha256Hex('a:2\n') } }),
      locked,
    );
    expect(calls).toEqual(['inner-recheck', 'inner-recheck', 'inner-recheck']);
    expect(await wrapped.plan(null, [])).toMatchObject({ renameLock: false });
    expect(await wrapped.body(null, locked)).toMatchObject({ status: 'applied' });
    expect(baseOf(ctx({ kind: 'digest', value: null }))).toBeUndefined();
    expect(baseOf(ctx({ kind: 'versions', value: 'junk' }))).toEqual({
      kind: 'versions',
      entries: [],
    });
    const withReplan = withBaseCheck(
      { ...inner, replan: () => Promise.resolve({ dirs: [], owners: [] }) },
      'batch',
    );
    expect(await withReplan.replan?.(null, locked)).toEqual({ dirs: [], owners: [] });
  });
});
