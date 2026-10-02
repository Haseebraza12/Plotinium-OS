import { describe, expect, it } from 'vitest';

import { files20, toRows } from '../fixtures/trees.ts';

import {
  sameState,
  subtreeChecksum,
  takeSnapshot,
  type BlobRow,
  type DentryRow,
  type InodeRow,
  type QuotaRow,
  type StoreRows,
} from './oracle.ts';

type MutableRows = Omit<StoreRows, 'inodes' | 'dentries' | 'blobs' | 'quota'> & {
  inodes: InodeRow[];
  dentries: DentryRow[];
  blobs: BlobRow[];
  quota: QuotaRow[];
};

/** A fresh, sound copy of the 20-file fixture (22 inodes: fs root, tree root, 20 files). */
function sound(): MutableRows {
  const rows = toRows(files20());
  return {
    ...rows,
    inodes: rows.inodes.map((i) => ({ ...i })),
    dentries: rows.dentries.map((d) => ({ ...d })),
    blobs: rows.blobs.map((b) => ({ ...b })),
    quota: rows.quota.map((q) => ({ ...q })),
  };
}

function firstFile(rows: MutableRows): string {
  const f = rows.inodes.find((i) => i.type === 'f');
  if (f === undefined) throw new Error('fixture has no file');
  return f.ino;
}

describe('TST-09 fault-injection oracle', () => {
  it('TST-09 a sound fixture has empty probe sets and compares equal to itself', () => {
    const snap = takeSnapshot(sound());
    expect(snap.orphans).toEqual([]);
    expect(snap.parentless).toEqual([]);
    expect(snap.refcountMismatches).toEqual([]);
    expect(snap.nlinkMismatches).toEqual([]);
    expect(snap.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(sameState(snap, takeSnapshot(sound()))).toEqual({ ok: true, diffs: [] });
  });

  it('TST-09 an inode whose only dentry was deleted is reported as an orphan', () => {
    const rows = sound();
    const victim = firstFile(rows);
    const broken = { ...rows, dentries: rows.dentries.filter((d) => d.ino !== victim) };
    const after = takeSnapshot(broken);
    expect(after.orphans).toEqual([victim]);
    expect(sameState(takeSnapshot(rows), after).diffs).toContain(`orphans: ${victim}`);
  });

  it('TST-09 the file-system root is never an orphan although it has no dentry', () => {
    const rows = sound();
    expect(rows.dentries.some((d) => d.ino === rows.fsRoot)).toBe(false);
    expect(takeSnapshot(rows).orphans).not.toContain(rows.fsRoot);
  });

  it('TST-09 a dentry whose parent inode is missing is reported as parentless', () => {
    const rows = sound();
    rows.dentries.push({ parent: 'ghost', name: 'lost.txt', ino: firstFile(rows), dType: 'f' });
    expect(takeSnapshot(rows).parentless).toEqual(['ghost/lost.txt']);
  });

  it('TST-09 a blob refcount that differs from its referencing inodes is reported', () => {
    const rows = sound();
    const blob = rows.blobs[0];
    if (blob === undefined) throw new Error('fixture has no blob');
    blob.refcount = 2;
    expect(takeSnapshot(rows).refcountMismatches).toEqual([blob.blob]);
  });

  it('TST-09 a wrong nlink on a file and on a directory is reported', () => {
    const rows = sound();
    const file = rows.inodes.find((i) => i.type === 'f');
    const dir = rows.inodes.find((i) => i.ino === rows.subtreeRoot);
    if (file === undefined || dir === undefined) throw new Error('fixture shape changed');
    file.nlink = 2;
    dir.nlink = 5;
    expect(takeSnapshot(rows).nlinkMismatches.sort()).toEqual([file.ino, dir.ino].sort());
  });

  it('TST-09 a changed mode, size or name changes the subtree checksum', () => {
    const base = subtreeChecksum(sound());
    const mode = sound();
    const f = mode.inodes.find((i) => i.type === 'f');
    if (f === undefined) throw new Error('fixture has no file');
    f.mode = 0o600;
    expect(subtreeChecksum(mode)).not.toBe(base);

    const renamed = sound();
    const d = renamed.dentries.find((x) => x.dType === 'f');
    if (d === undefined) throw new Error('fixture has no file dentry');
    d.name = 'renamed.txt';
    expect(subtreeChecksum(renamed)).not.toBe(base);
  });

  it('TST-09 rows outside the subtree do not change the subtree checksum', () => {
    const rows = sound();
    const base = subtreeChecksum(rows);
    rows.inodes.push({
      ino: 'elsewhere',
      type: 'f',
      mode: 0o644,
      uid: 0,
      gid: 0,
      size: 1,
      nlink: 1,
      version: 1,
      blob: null,
    });
    rows.dentries.push({ parent: rows.fsRoot, name: 'elsewhere', ino: 'elsewhere', dType: 'f' });
    expect(subtreeChecksum(rows)).toBe(base);
  });

  it('TST-09 a directory cycle is hashed once and does not hang the walk', () => {
    const rows = sound();
    rows.dentries.push({
      parent: rows.subtreeRoot,
      name: 'loop',
      ino: rows.subtreeRoot,
      dType: 'd',
    });
    expect(subtreeChecksum(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TST-09 a dentry naming a missing inode is hashed as missing', () => {
    const rows = sound();
    rows.dentries.push({ parent: rows.subtreeRoot, name: 'dangling', ino: 'nowhere', dType: 'f' });
    expect(subtreeChecksum(rows)).not.toBe(subtreeChecksum(sound()));
  });

  it('TST-09 quota, queue and fsck differences are each reported', () => {
    const before = takeSnapshot(sound());
    const rows = sound();
    const q = rows.quota[0];
    if (q === undefined) throw new Error('fixture has no quota row');
    q.usedBytes -= 1;
    const after = takeSnapshot({ ...rows, outboxLen: 1, undoLen: 2, fsckClean: false });
    const { ok, diffs } = sameState(before, after);
    expect(ok).toBe(false);
    expect(diffs).toEqual([
      `quota of uid ${q.uid} changed`,
      'outbox length changed',
      'undo length changed',
      'fsck not clean',
    ]);
  });

  it('TST-09 a uid that appears only after the operation is a quota change', () => {
    const before = takeSnapshot(sound());
    const rows = sound();
    rows.quota.push({ uid: 1001, usedBytes: 0, usedInodes: 1 });
    expect(sameState(before, takeSnapshot(rows)).diffs).toEqual(['quota of uid 1001 changed']);
  });

  it('TST-09 a changed checksum alone fails the comparison', () => {
    const before = takeSnapshot(sound());
    const after = { ...before, checksum: '0'.repeat(64) };
    expect(sameState(before, after)).toEqual({ ok: false, diffs: ['checksum changed'] });
  });
});
