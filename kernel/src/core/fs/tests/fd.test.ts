/**
 * Descriptors through the syscall layer: the fd table integration (pcb.fdTable and the vfs
 * open-file table), per-call commits of write sessions, quota enforcement with poisoning (VFS-06),
 * local conflicts (VFS-10) and the kill path (PROC-07).
 */
import type { Stat } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { MemStore } from '../mem-store.ts';
import { UID, boot, bytes, snapshot, text } from './harness.ts';

interface Opened {
  fd: number;
  ino: string;
  type: string;
  version: number;
  size: number;
}

interface Written {
  bytes: number;
  version?: number;
  opId?: string;
  sync?: string;
  conflict?: { keptAs: { ino: string; path: string } };
}

describe('descriptors', () => {
  it('VFS-07 open allocates the lowest free fd, mirrors it in the PCB and close frees it', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('abc') });
    const a = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    const b = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect([a.fd, b.fd]).toEqual([0, 1]);
    expect(a).toMatchObject({ type: 'f', size: 3, version: 1 });
    expect([...w.alice.pcb.fdTable.keys()]).toEqual([0, 1]);
    await w.alice.ok('close', { fd: 0 });
    expect(w.alice.pcb.fdTable.has(0)).toBe(false);
    expect((await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' })).fd).toBe(0);
    expect(await w.alice.errno('close', { fd: 7 })).toBe('EBADF');
  });

  it('VFS-07 a new file fd never takes a number held by a pipe or TTY end', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('abc') });
    w.alice.pcb.fdTable.set(0, -1); // fd 0 held by another kind of descriptor (a TTY)
    w.alice.pcb.fdTable.set(1, -2);
    const a = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect(a.fd).toBe(2);
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: 2, len: 10 }))).toBe('abc');
  });

  it('VFS-07 read, write, seek, append and fstat follow the descriptor offset', async () => {
    const w = await boot();
    const { fd } = await w.alice.ok<Opened>('open', {
      path: '/home/alice/f',
      flags: 'rw',
      create: true,
    });
    const wr = await w.alice.ok<Written>('write', { fd, data: bytes('hello world') });
    expect(wr).toMatchObject({ bytes: 11, version: 2, sync: 'pending' });
    expect(await w.alice.ok('seek', { fd, offset: 6, whence: 'set' })).toEqual({ offset: 6 });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd, len: 5 }))).toBe('world');
    expect((await w.alice.ok<ArrayBuffer>('read', { fd, len: 5 })).byteLength).toBe(0);
    await w.alice.ok('write', { fd, data: bytes('HELLO'), offset: 0 });
    expect((await w.alice.ok<Stat>('fstat', { fd })).size).toBe(11);
    await w.alice.ok('close', { fd });
    const app = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'a' });
    await w.alice.ok('write', { fd: app.fd, data: bytes('!') });
    await w.alice.ok('close', { fd: app.fd });
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 100 }))).toBe(
      'HELLO world!',
    );
  });

  it('VFS-07 descriptor access modes: EBADF, EISDIR and O_EXCL', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('abc') });
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect(await w.alice.errno('write', { fd: r.fd, data: bytes('x') })).toBe('EBADF');
    const d = await w.alice.ok<Opened>('open', { path: '/home/alice', flags: 'r' });
    expect(d.type).toBe('d');
    expect(await w.alice.errno('read', { fd: d.fd, len: 10 })).toBe('EISDIR');
    expect(await w.alice.errno('seek', { fd: d.fd, offset: 0, whence: 'set' })).toBe('EINVAL');
    expect(await w.alice.errno('open', { path: '/home/alice', flags: 'w' })).toBe('EISDIR');
    expect(
      await w.alice.errno('open', { path: '/home/alice/f', flags: 'w', create: true, excl: true }),
    ).toBe('EEXIST');
    expect(await w.alice.errno('open', { path: '/home/alice/nope', flags: 'r' })).toBe('ENOENT');
  });

  it('VFS-07 open with trunc empties the file and truncate by path or fd resizes it', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('0123456789') });
    await w.alice.ok('truncate', { path: '/home/alice/f', size: 4 });
    expect((await w.alice.ok<Stat>('stat', { path: '/home/alice/f' })).size).toBe(4);
    await w.alice.ok('truncate', { path: '/home/alice/f', size: 6 });
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect([
      ...new Uint8Array(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 10 })),
    ]).toEqual([48, 49, 50, 51, 0, 0]);
    const t = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'w', trunc: true });
    expect(t.size).toBe(0);
    await w.alice.ok('write', { fd: t.fd, data: bytes('xyz') });
    await w.alice.ok('truncate', { fd: t.fd, size: 1 });
    expect((await w.alice.ok<Stat>('stat', { path: '/home/alice/f' })).size).toBe(1);
    expect(await w.alice.errno('truncate', { path: '/home/alice', size: 0 })).toBe('EISDIR');
  });

  it('VFS-07 content written before a remount is read back from the store, chunk by chunk', async () => {
    const store = new MemStore();
    const w1 = await boot({ store });
    const big = new Uint8Array(2_500_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await w1.alice.ok('writeFile', { path: '/home/alice/keep.txt', data: bytes('persisted') });
    await w1.alice.ok('writeFile', { path: '/home/alice/big.bin', data: big.slice().buffer });
    const w2 = await boot({ store });
    expect(w2.fs.content.size).toBe(0);
    const r = await w2.alice.ok<Opened>('open', { path: '/home/alice/keep.txt', flags: 'r' });
    expect(text(await w2.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 100 }))).toBe('persisted');
    const b = await w2.alice.ok<Opened>('open', { path: '/home/alice/big.bin', flags: 'r' });
    expect(b.size).toBe(big.length);
    const got = new Uint8Array(big.length);
    let off = 0;
    for (;;) {
      const chunk = new Uint8Array(
        await w2.alice.ok<ArrayBuffer>('read', { fd: b.fd, len: 16_777_216 }),
      );
      if (chunk.byteLength === 0) break;
      expect(chunk.byteLength).toBeLessThanOrEqual(1_048_576);
      got.set(chunk, off);
      off += chunk.byteLength;
    }
    expect(off).toBe(big.length);
    let mismatches = 0;
    for (let i = 0; i < big.length; i++) if (got[i] !== big[i]) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('VFS-05 a synthesised file opens read-only with a generated snapshot', async () => {
    const w = await boot();
    const r = await w.alice.ok<Opened>('open', { path: '/system/release', flags: 'r' });
    expect(r.size).toBeGreaterThan(0);
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 4096 }))).toContain(
      'NAME=Plotinium',
    );
    // alice fails the w bit (EACCES, stage 5); root passes it and meets the synthesised rule (EPERM).
    expect(await w.alice.errno('open', { path: '/system/release', flags: 'rw' })).toBe('EACCES');
    expect(await w.root.errno('open', { path: '/system/release', flags: 'rw' })).toBe('EPERM');
    expect(await w.root.errno('truncate', { path: '/system/release', size: 0 })).toBe('EPERM');
  });

  it('VFS-07 EMFILE when the process has 256 open descriptors', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('') });
    for (let i = 0; i < 256; i++) await w.alice.ok('open', { path: '/home/alice/f', flags: 'r' });
    expect(await w.alice.errno('open', { path: '/home/alice/f', flags: 'r' })).toBe('EMFILE');
  });

  it('PROC-07 kill closes every fd of the process', async () => {
    const w = await boot();
    const p = w.spawn(UID.alice);
    await p.ok('open', { path: '/home/alice/a', flags: 'w', create: true });
    await p.ok('open', { path: '/home/alice/b', flags: 'w', create: true });
    expect(w.fs.fds.list().filter((x) => x.pid === p.pcb.pid)).toHaveLength(2);
    w.kernel.procs.terminate(p.pcb, 'signal:9', { code: 137, reason: 'signal' });
    expect(w.fs.fds.list().filter((x) => x.pid === p.pcb.pid)).toHaveLength(0);
    expect(p.pcb.fdTable.size).toBe(0);
  });
});

describe('VFS-06 quota through descriptors', () => {
  it('VFS-06 rejects a write beyond quota with EDQUOT and no partial data', async () => {
    const w = await boot({ quotaBytes: 1_000 });
    const { fd } = await w.alice.ok<Opened>('open', {
      path: '/home/alice/f',
      flags: 'w',
      create: true,
    });
    await w.alice.ok('write', { fd, data: new ArrayBuffer(600) });
    const before = snapshot(w.store);
    expect(await w.alice.errno('write', { fd, data: new ArrayBuffer(600) })).toBe('EDQUOT');
    expect(snapshot(w.store)).toBe(before);
    expect((await w.alice.ok<Stat>('stat', { path: '/home/alice/f' })).size).toBe(600);
    // The description is poisoned: every later write fails with the same errno.
    expect(await w.alice.errno('write', { fd, data: new ArrayBuffer(1) })).toBe('EDQUOT');
    expect(await w.alice.ok('quota', {})).toMatchObject({ usedBytes: 600, usedInodes: 2 });
  });

  it('VFS-06 cat big > f over quota leaves no file f and quota unchanged', async () => {
    const w = await boot({ quotaBytes: 1_000 });
    const quota = await w.alice.ok('quota', {});
    const { fd } = await w.alice.ok<Opened>('open', {
      path: '/home/alice/f',
      flags: 'w',
      create: true,
      trunc: true,
    });
    expect(await w.alice.errno('write', { fd, data: new ArrayBuffer(2_000) })).toBe('EDQUOT');
    await w.alice.ok('close', { fd });
    expect(await w.alice.errno('stat', { path: '/home/alice/f' })).toBe('ENOENT');
    expect(await w.alice.ok('quota', {})).toEqual(quota);
  });

  it('VFS-06 writeFile beyond quota gives EDQUOT and leaves the old content', async () => {
    const w = await boot({ quotaBytes: 1_000 });
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('old') });
    expect(
      await w.alice.errno('writeFile', { path: '/home/alice/f', data: new ArrayBuffer(5_000) }),
    ).toBe('EDQUOT');
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 10 }))).toBe('old');
  });
});

describe('VFS-10 local conflicts', () => {
  it('VFS-10 two local writers of one file produce a local conflicted copy and overwrite nothing', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/doc.txt', data: bytes('v1') });
    const a = await w.alice.ok<Opened>('open', {
      path: '/home/alice/doc.txt',
      flags: 'w',
      trunc: false,
    });
    const b = await w.alice.ok<Opened>('open', { path: '/home/alice/doc.txt', flags: 'w' });
    const first = await w.alice.ok<Written>('write', { fd: a.fd, data: bytes('from A') });
    expect(first.conflict).toBeUndefined();
    const second = await w.alice.ok<Written>('write', { fd: b.fd, data: bytes('from B') });
    expect(second.conflict?.keptAs.path).toBe(
      '/home/alice/doc (conflict from alice, 2026-09-25).txt',
    );
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/doc.txt', flags: 'r' });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 100 }))).toBe('from A');
    const k = await w.alice.ok<Opened>('open', {
      path: second.conflict?.keptAs.path ?? '',
      flags: 'r',
    });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: k.fd, len: 100 }))).toBe('from B');
  });

  it('VFS-10 a write on a stale expectedVersion returns conflict.keptAs and overwrites nothing', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('one') });
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('two') });
    const res = await w.alice.ok<Written & { version: number }>('writeFile', {
      path: '/home/alice/f',
      data: bytes('stale'),
      expectedVersion: 1,
    });
    expect(res.conflict?.keptAs.path).toBe('/home/alice/f (conflict from alice, 2026-09-25)');
    const r = await w.alice.ok<Opened>('open', { path: '/home/alice/f', flags: 'r' });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 100 }))).toBe('two');
  });

  it('VFS-10 a file deleted while open keeps its session content as a conflicted copy', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/gone.md', data: bytes('draft') });
    const { fd } = await w.alice.ok<Opened>('open', { path: '/home/alice/gone.md', flags: 'w' });
    await w.alice.ok('unlink', { path: '/home/alice/gone.md' });
    const res = await w.alice.ok<Written>('write', { fd, data: bytes('saved') });
    const kept = res.conflict?.keptAs.path ?? '';
    expect(kept).toBe('/home/alice/gone (conflict from alice, 2026-09-25).md');
    const r = await w.alice.ok<Opened>('open', { path: kept, flags: 'r' });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd: r.fd, len: 100 }))).toBe('saved');
  });
});
