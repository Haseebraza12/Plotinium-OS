import { INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { checkAll } from '../src/fsck/check.ts';
import { checksumOf, fsck } from '../src/fsck/fsck.ts';
import type { FsckInput } from '../src/fsck/state.ts';
import { FsState } from '../src/fsck/state.ts';
import { planMkdir, planSymlink } from '../src/ops/create.ts';
import { planLink } from '../src/ops/link.ts';
import { planWriteFile } from '../src/ops/write.ts';
import type { DentryRec, InodeRec } from '../src/store/records.ts';
import { ALICE, HOME, ROOT, World, ok, testIno } from './doubles/world.ts';

function world(): World {
  const w = new World();
  ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/docs/deep', undefined, true)));
  ok(
    w.run(ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/docs/a.md', contentOfText('alpha', 0)),
    ),
  );
  ok(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/docs/a.md', '/home/alice/a-link')));
  ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'docs', '/home/alice/l')));
  ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/tmp/scratch', contentOfText('tmp', 0))));
  ok(w.run(ROOT, 'create', (b) => planMkdir(b, '/tmp/t')));
  return w;
}

const dir = (ino: string, over: Partial<InodeRec> = {}): InodeRec => ({
  ino,
  fs: 'root',
  type: 'd',
  mode: 0o755,
  uid: 4242,
  gid: 4242,
  size: 0,
  nlink: 2,
  version: 1,
  atime: 0,
  mtime: 0,
  ctime: 0,
  btime: 0,
  blob: null,
  target: null,
  mir: 1,
  ...over,
});

const failing = (input: FsckInput, complete = true): string[] =>
  fsck(input, { complete })
    .report.invariants.filter((i) => !i.ok)
    .map((i) => i.id);

type Corruption = [
  id: string,
  corrupt: (x: { inodes: InodeRec[]; dentries: DentryRec[] } & FsckInput) => FsckInput,
];

const CORRUPTIONS: Corruption[] = [
  ['I1', (x) => ({ ...x, inodes: [...x.inodes, dir(testIno(0xdead))] })],
  [
    'I2',
    (x) => ({
      ...x,
      inodes: [...x.inodes, dir(testIno(0xbeef), { nlink: 2 })],
      dentries: [
        ...x.dentries,
        { parent: testIno(0xf00), name: 'lost', ino: testIno(0xbeef), dtype: 'd' },
      ],
    }),
  ],
  [
    'I3',
    (x) => ({
      ...x,
      dentries: [...x.dentries, { parent: INO.MNT, name: 'ghost', ino: testIno(0x60), dtype: 'f' }],
    }),
  ],
  [
    'I4',
    (x) => ({ ...x, inodes: x.inodes.map((n) => (n.ino === INO.USR ? { ...n, nlink: 9 } : n)) }),
  ],
  [
    'I5',
    (x) => ({
      ...x,
      inodes: [...x.inodes, dir(testIno(0xc1), { nlink: 3 }), dir(testIno(0xc2), { nlink: 3 })],
      dentries: [
        ...x.dentries,
        { parent: testIno(0xc1), name: 'c2', ino: testIno(0xc2), dtype: 'd' },
        { parent: testIno(0xc2), name: 'c1', ino: testIno(0xc1), dtype: 'd' },
      ],
    }),
  ],
  [
    'I6',
    (x) => ({
      ...x,
      users: (x.users ?? []).map((u) =>
        u.uid === ALICE.uid ? { ...u, usedBytes: u.usedBytes + 7 } : u,
      ),
    }),
  ],
  [
    'I7',
    (x) => ({ ...x, blobs: (x.blobs ?? []).map((b) => ({ ...b, refcount: b.refcount + 1 })) }),
  ],
  [
    'I8',
    (x) => ({
      ...x,
      inodes: x.inodes.map((n) => (n.ino === HOME.alice ? { ...n, mode: 0o7777 } : n)),
    }),
  ],
  [
    'I8',
    (x) => ({
      ...x,
      dentries: x.dentries.map((d) => (d.ino === HOME.carol ? { ...d, name: 'e\u0301' } : d)),
    }),
  ],
  [
    'I9',
    (x) => ({
      ...x,
      inodes: x.inodes.filter((n) => n.ino !== INO.MNT),
      dentries: x.dentries.filter((d) => d.ino !== INO.MNT),
    }),
  ],
  ['I10', (x) => ({ ...x, undo: (x.undo ?? []).slice(1) })],
  [
    'I11',
    (x) => ({
      ...x,
      inodes: x.inodes.map((n) => (n.ino === HOME.carol ? { ...n, fs: 'tmp' } : n)),
    }),
  ],
  [
    'I11',
    (x) => ({
      ...x,
      inodes: x.inodes.map((n) => (n.fs === 'tmp' ? { ...n, fs: 'root', uid: 4242 } : n)),
    }),
  ],
  [
    'I12',
    (x) => ({
      ...x,
      inodes: [...x.inodes, dir(testIno(0x12), { type: 'd' })],
      dentries: [
        ...x.dentries,
        { parent: INO.SYSTEM, name: 'release', ino: testIno(0x12), dtype: 'd' },
      ],
    }),
  ],
];

describe('fsck (VFS-11)', () => {
  it('VFS-11 fsck is clean after mkfs and after a mixed workload', () => {
    const w = world();
    const input = w.fsckInput();
    expect(failing(input)).toEqual([]);
    expect(failing(input, false)).toEqual([]);
    const r = fsck(input, { complete: true });
    expect(r.report.exitCode).toBe(0);
    expect(r.report.checked.inodes).toBe(input.inodes.length);
    expect(r.diff).toBeNull();
  });

  it('VFS-11 fsck detects and repairs each of I1 to I12 on corrupted fixtures', () => {
    const base = world().fsckInput() as FsckInput & { inodes: InodeRec[]; dentries: DentryRec[] };
    for (const [id, corrupt] of CORRUPTIONS) {
      const bad = corrupt({ ...base, inodes: [...base.inodes], dentries: [...base.dentries] });
      expect(failing(bad), id).toContain(id);
      const fixed = fsck(bad, { repair: true, complete: true, now: 1 });
      expect(fixed.report.exitCode, id).toBe(2);
      expect(
        fixed.report.repaired?.map((r) => r.id),
        id,
      ).toContain(id);
      expect(
        fixed.report.invariants.filter((i) => !i.ok).map((i) => i.id),
        id,
      ).toEqual([]);
      if (fixed.repairedState === null) throw new Error(id);
      expect(
        checkAll(fixed.repairedState, { complete: true }).every((i) => i.ok),
        id,
      ).toBe(true);
    }
  });

  it('VFS-11 repairs reattach orphans under /lost+found with their #ino12 name', () => {
    const base = world().fsckInput();
    const orphan = testIno(0xdead);
    const r = fsck(
      { ...base, inodes: [...base.inodes, dir(orphan)] },
      { repair: true, complete: true, now: 1 },
    );
    const put = r.diff?.dentriesPut.find((d) => d.ino === orphan);
    expect(put).toEqual({
      parent: INO.LOST_FOUND,
      name: `#${orphan.replaceAll('-', '').slice(0, 12)}`,
      ino: orphan,
      dtype: 'd',
    });
    expect(r.diff?.meta).toContainEqual({ k: 'fsckDirty', v: true });
    // A tmpfs orphan is simply deleted.
    const t = fsck(
      { ...base, inodes: [...base.inodes, dir(testIno(0xa7), { fs: 'tmp' })] },
      { repair: true, complete: true, now: 1 },
    );
    expect(t.diff?.inodesDel).toContain(testIno(0xa7));
  });

  it('VFS-11 duplicate entries (I13) and memory drift (I14) are reported', () => {
    const base = world().fsckInput();
    const dup = base.dentries[0];
    if (dup === undefined) throw new Error('no dentry');
    expect(failing({ ...base, dentries: [...base.dentries, dup] })).toContain('I13');
    const memory = { dentries: base.dentries.filter((d) => d.parent === INO.SYSTEM).slice(1) };
    expect(failing({ ...base, memory })).toContain('I14');
    expect(
      failing({
        ...base,
        memory: { dentries: base.dentries.filter((d) => d.parent === INO.SYSTEM) },
      }),
    ).toEqual([]);
  });

  it('VFS-11 client rules: nlink may exceed the local links of an unmirrored directory; I6 follows the undo records', () => {
    const w = world();
    const input = w.fsckInput();
    const partial = {
      ...input,
      inodes: input.inodes.map((n) =>
        n.ino === INO.USR ? { ...n, mir: 0 as const, nlink: 5 } : n,
      ),
    };
    expect(failing(partial, false)).toEqual([]);
    expect(failing(partial, true)).toContain('I4');
    const drift = {
      ...input,
      users: (input.users ?? []).map((u) =>
        u.uid === ALICE.uid ? { ...u, serverUsedBytes: u.serverUsedBytes + 1 } : u,
      ),
    };
    expect(failing(drift, false)).toContain('I6');
    const fixed = fsck(drift, { repair: true, now: 1 });
    expect(fixed.report.invariants.find((i) => i.id === 'I6')?.ok).toBe(true);
  });

  it('VFS-11 fsck --checksum is stable and changes with metadata', () => {
    const w = world();
    const input = w.fsckInput();
    const sum = checksumOf(input);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(
      checksumOf({ inodes: [...input.inodes].reverse(), dentries: [...input.dentries].reverse() }),
    ).toBe(sum);
    const home = w.user(ALICE.uid).homeIno ?? '';
    const sub = checksumOf(input, home);
    expect(sub).not.toBe(sum);
    const touched = {
      ...input,
      inodes: input.inodes.map((n) => (n.ino === home ? { ...n, mode: 0o711 } : n)),
    };
    expect(checksumOf(touched)).not.toBe(sum);
    // Times and tmpfs rows are not part of the checksum.
    const times = {
      ...input,
      inodes: input.inodes.map((n) => ({ ...n, mtime: n.mtime + 1, atime: 5 })),
    };
    expect(checksumOf(times)).toBe(sum);
    expect(() => checksumOf(input, testIno(0x404))).toThrow('no inode');
  });

  it('VFS-11 the state copy indexes valid entries and reachability', () => {
    const s = new FsState(world().fsckInput());
    const { reached, belowTmp } = s.reach();
    expect(reached.has(INO.ROOT)).toBe(true);
    expect([...belowTmp].every((ino) => s.inodes.get(ino)?.fs === 'tmp')).toBe(true);
    expect(new FsState({ inodes: [], dentries: [] }).reach().reached.size).toBe(0);
  });
});
