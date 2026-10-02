import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE } from '../src/limits.ts';
import { WriteSession } from '../src/oft/session.ts';
import type { ChunkSource } from '../src/oft/session.ts';
import { OpenFileTable } from '../src/oft/table.ts';
import type { NewOpenFile } from '../src/oft/table.ts';
import { testIno } from './doubles/world.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function snapshot(text: string): { size: number; source: ChunkSource } {
  const bytes = enc.encode(text);
  return { size: bytes.length, source: (i) => bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) };
}

function desc(over: Partial<NewOpenFile> = {}): NewOpenFile {
  return {
    ino: testIno(1),
    fs: 'root',
    type: 'f',
    flags: { read: true, write: true },
    snapshotBlob: 'a'.repeat(64),
    snapshotSize: 5,
    versionAtOpen: 1,
    createdByOpen: false,
    pathAtOpen: '/home/alice/f',
    via: null,
    ...over,
  };
}

const read = (s: WriteSession, pos: number, len: number): string => {
  const r = s.read(pos, len);
  if (r === 'EAGAIN') throw new Error('EAGAIN');
  return dec.decode(r);
};

describe('write sessions (PVFS-11)', () => {
  it('PVFS-11 a session reads its own writes over the snapshot and zero-fills holes', () => {
    const snap = snapshot('hello');
    const s = new WriteSession(snap.size, snap.source);
    expect(read(s, 0, 100)).toBe('hello');
    s.write(1, enc.encode('ELL'));
    expect(read(s, 0, 5)).toBe('hELLo');
    s.write(8, enc.encode('!'));
    expect(s.size).toBe(9);
    expect([...(s.read(5, 4) as Uint8Array)]).toEqual([0, 0, 0, 33]);
    s.truncate(2);
    expect(read(s, 0, 10)).toBe('hE');
    s.truncate(4);
    expect([...(s.bytes() as Uint8Array)]).toEqual([104, 69, 0, 0]);
    expect(s.dirtyBytes).toBeGreaterThan(0);
    expect(read(s, 10, 5)).toBe('');
  });

  it('PVFS-11 writes span 1 MiB chunk boundaries', () => {
    const s = new WriteSession(0, () => new Uint8Array(0), true);
    const data = new Uint8Array(CHUNK_SIZE + 10).fill(7);
    s.write(CHUNK_SIZE - 5, data);
    expect(s.size).toBe(2 * CHUNK_SIZE + 5);
    const tail = s.read(2 * CHUNK_SIZE, 10);
    expect(tail !== 'EAGAIN' && tail.length).toBe(5);
    s.truncate(CHUNK_SIZE);
    expect(s.size).toBe(CHUNK_SIZE);
  });

  it('PVFS-11 content that is not cached offline reads EAGAIN', () => {
    const s = new WriteSession(10, () => 'EAGAIN');
    expect(s.read(0, 5)).toBe('EAGAIN');
    expect(s.write(0, enc.encode('x'))).toBe('EAGAIN');
  });
});

describe('open-file table (PVFS-11)', () => {
  it('PVFS-11 open allocates the lowest free fd and EMFILE bounds processes and the device', () => {
    const t = new OpenFileTable({ perProcess: 3, device: 4 });
    expect(t.open(1, desc())).toBe(0);
    expect(t.open(1, desc())).toBe(1);
    t.close(1, 0);
    expect(t.open(1, desc())).toBe(0);
    expect(t.open(1, desc())).toBe(2);
    expect(() => t.open(1, desc())).toThrow('EMFILE');
    expect(t.open(2, desc())).toBe(0);
    expect(() => t.open(2, desc())).toThrow('EMFILE');
    expect(() => t.get(1, 9)).toThrow('EBADF');
    expect(t.size).toBe(4);
  });

  it('PVFS-11 dup, dup2 and inherited fds share one description and offset', () => {
    const t = new OpenFileTable();
    const snap = snapshot('abcdef');
    const fd = t.open(1, desc({ snapshotSize: 6 }));
    const d = t.dup(1, fd);
    expect(dec.decode(t.read(1, fd, 2, snap.source))).toBe('ab');
    expect(dec.decode(t.read(1, d, 2, snap.source))).toBe('cd');
    expect(dec.decode(t.read(1, d, 2, snap.source, 0))).toBe('ab');
    t.inherit(1, 2);
    expect(dec.decode(t.read(2, fd, 1, snap.source))).toBe('e');
    const moved = t.dup2(1, fd, 7);
    expect(moved).toEqual({ fd: 7, closed: null });
    expect(t.dup2(1, 7, 7).fd).toBe(7);
    const other = t.open(1, desc());
    const replaced = t.dup2(1, fd, other);
    expect(replaced.closed?.id).toBeDefined();
    expect(t.close(1, fd)).toBeNull();
    expect(t.list().length).toBeGreaterThan(0);
    const finals = [...t.closeAll(1), ...t.closeAll(2)];
    expect(finals).toHaveLength(1);
    expect(t.size).toBe(0);
    t.inherit(99, 100);
  });

  it('PVFS-11 lseek rejects a negative result and allows seeking past the end', () => {
    const t = new OpenFileTable();
    const fd = t.open(1, desc());
    expect(t.seek(1, fd, 10, 'set', 5)).toBe(10);
    expect(t.seek(1, fd, -3, 'cur', 5)).toBe(7);
    expect(t.seek(1, fd, 0, 'end', 5)).toBe(5);
    expect(() => t.seek(1, fd, -6, 'end', 5)).toThrow('EINVAL');
  });

  it('PVFS-11 a poisoned write session commits nothing and every later write fails the same way', () => {
    const t = new OpenFileTable();
    const snap = snapshot('hello');
    const fd = t.open(1, desc({ flags: { write: true, trunc: true } }));
    expect(t.write(1, fd, enc.encode('abc'), 100, snap.source)).toBe(3);
    expect(() => t.write(1, fd, new Uint8Array(200), 100, snap.source)).toThrow('EDQUOT');
    expect(() => t.write(1, fd, enc.encode('x'), 1e9, snap.source)).toThrow('EDQUOT');
    const f = t.close(1, fd);
    expect(f?.poisoned).toBe('EDQUOT');
    expect(f?.session?.size).toBe(3);
  });

  it('PVFS-11 append writes at the end, read-only descriptions refuse writes, directories refuse reads', () => {
    const t = new OpenFileTable();
    const snap = snapshot('hello');
    const fd = t.open(1, desc({ flags: { read: true, write: true, append: true } }));
    t.write(1, fd, enc.encode('!'), 100, snap.source);
    t.write(1, fd, enc.encode('?'), 100, snap.source, 0);
    expect(dec.decode(t.read(1, fd, 10, snap.source, 0))).toBe('hello!?');
    const ro = t.open(1, desc({ flags: { read: true } }));
    expect(() => t.write(1, ro, enc.encode('x'), 100, snap.source)).toThrow('EBADF');
    expect(() => t.truncate(1, ro, 0, 100, snap.source)).toThrow('EBADF');
    const wo = t.open(1, desc({ flags: { write: true } }));
    expect(() => t.read(1, wo, 1, snap.source)).toThrow('EBADF');
    const dir = t.open(1, desc({ type: 'd', flags: { read: true, directory: true } }));
    expect(() => t.read(1, dir, 1, snap.source)).toThrow('EISDIR');
    const off = t.open(1, desc({ flags: { read: true } }));
    expect(() => t.read(1, off, 1, () => 'EAGAIN')).toThrow('EAGAIN');
    expect(t.openBlobPins().size).toBe(1);
  });

  it('PVFS-11 truncate through an fd starts the session and respects the headroom', () => {
    const t = new OpenFileTable();
    const snap = snapshot('hello');
    const fd = t.open(1, desc());
    t.truncate(1, fd, 2, 100, snap.source);
    expect(dec.decode(t.read(1, fd, 10, snap.source, 0))).toBe('he');
    expect(() => t.truncate(1, fd, -1, 100, snap.source)).toThrow('EINVAL');
    expect(() => t.truncate(1, fd, 500, 100, snap.source)).toThrow('EDQUOT');
    expect(() => t.truncate(1, fd, 1, 100, snap.source)).toThrow('EDQUOT');
  });
});
