import { INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOf, contentOfText } from '../src/content.ts';
import { TMPFS_MAX_BYTES, TMPFS_MAX_INODES } from '../src/limits.ts';
import { planChown } from '../src/ops/attr.ts';
import { quotaCheck } from '../src/ops/commit.ts';
import { forRemove } from '../src/ops/common.ts';
import { planCopy } from '../src/ops/copy.ts';
import { planMkdir } from '../src/ops/create.ts';
import { planLink } from '../src/ops/link.ts';
import { planRemoveTree, planUnlink } from '../src/ops/unlink.ts';
import { planWriteFile } from '../src/ops/write.ts';
import {
  DeltaSet,
  applyDelta,
  exceeds,
  fastFail,
  quotaReport,
  recomputeUsed,
  tmpfsCharge,
  tmpfsExceeds,
  userCharge,
} from '../src/quota/quota.ts';
import type { InodeRec, UndoRec, UserRec } from '../src/store/records.ts';
import { ALICE, BOB, ROOT, World, errnoOf, ok } from './doubles/world.ts';

const file = (over: Partial<InodeRec> = {}): InodeRec => ({
  ino: 'x',
  fs: 'root',
  type: 'f',
  mode: 0o644,
  uid: 1000,
  gid: 100,
  size: 10,
  nlink: 1,
  version: 1,
  atime: 0,
  mtime: 0,
  ctime: 0,
  btime: 0,
  blob: 'b',
  target: null,
  ...over,
});

describe('quota accounting (VFS-06)', () => {
  it('VFS-06 charges one inode and the size of files and symlinks, directories 0 bytes', () => {
    expect(userCharge(file())).toEqual({ bytes: 10, inodes: 1 });
    expect(userCharge(file({ type: 'd', size: 0 }))).toEqual({ bytes: 0, inodes: 1 });
    expect(userCharge(file({ fs: 'tmp' }))).toEqual({ bytes: 0, inodes: 0 });
    expect(tmpfsCharge(file({ fs: 'tmp' }))).toEqual({ bytes: 10, inodes: 1 });
    expect(userCharge(file({ ino: INO.SYSTEM_RELEASE }))).toEqual({ bytes: 0, inodes: 0 });
    const d = new DeltaSet();
    d.charge(file(), 1);
    d.charge(file({ uid: 5 }), -1);
    d.add(7, 0, 0);
    expect(d.list()).toEqual([
      { uid: 5, dBytes: -10, dInodes: -1 },
      { uid: 1000, dBytes: 10, dInodes: 1 },
    ]);
    expect(d.get(99)).toEqual({ uid: 99, dBytes: 0, dInodes: 0 });
  });

  it('VFS-06 rejects a write beyond quota with EDQUOT and no partial data', () => {
    const w = new World({ quotaBytes: 100 });
    const before = w.tree.snapshot();
    const used = w.user(ALICE.uid);
    const big = contentOf(new Uint8Array(101), 0);
    expect(errnoOf(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/big', big)))).toBe(
      'EDQUOT',
    );
    expect(w.tree.snapshot()).toEqual(before);
    expect(w.user(ALICE.uid)).toEqual(used);
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/fits', contentOf(new Uint8Array(100), 0)),
      ),
    );
    expect(w.user(ALICE.uid).usedBytes).toBe(100);
  });

  it('VFS-06 decreases never fail even when the server lowered the quota below use', () => {
    const w = new World({ quotaBytes: 100 });
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/f', contentOf(new Uint8Array(90), 0)),
      ),
    );
    w.tree.users.set(ALICE.uid, { ...w.user(ALICE.uid), quotaBytes: 10 });
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/f', contentOf(new Uint8Array(50), 0)),
      ),
    );
    expect(
      errnoOf(
        w.run(ALICE, 'write', (b) =>
          planWriteFile(b, '/home/alice/f', contentOf(new Uint8Array(60), 0)),
        ),
      ),
    ).toBe('EDQUOT');
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/f')));
  });

  it('VFS-06 cp -r over the inode quota fails with EDQUOT and creates nothing', () => {
    const w = new World({ quotaInodes: 6 });
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/t/u', undefined, true)));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/t/u/f', contentOfText('f', 0))));
    const before = w.tree.snapshot();
    expect(
      errnoOf(
        w.run(ALICE, 'copy', (b) =>
          planCopy(b, '/home/alice/t', '/home/alice/t2', { recursive: true }),
        ),
      ),
    ).toBe('EDQUOT');
    expect(w.tree.snapshot()).toEqual(before);
  });

  it('VFS-06 root is exempt from quota', () => {
    const w = new World();
    const root: UserRec = { ...w.user(0), quotaBytes: 0, quotaInodes: 0 };
    expect(exceeds(root, { uid: 0, dBytes: 1e9, dInodes: 1e6 })).toBe(false);
    ok(
      w.run(ROOT, 'write', (b) =>
        planWriteFile(b, '/root/big', contentOf(new Uint8Array(2048), 0)),
      ),
    );
    expect(quotaReport(w.user(0), true)).toMatchObject({
      uid: 0,
      quotaBytes: null,
      quotaInodes: null,
    });
  });

  it('VFS-06 chown to a user without headroom gives EDQUOT', () => {
    const w = new World({ quotaBytes: 50 });
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/f', contentOf(new Uint8Array(40), 0)),
      ),
    );
    ok(
      w.run(BOB, 'write', (b) => planWriteFile(b, '/home/bob/g', contentOf(new Uint8Array(20), 0))),
    );
    expect(
      errnoOf(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/f', { uid: BOB.uid }))),
    ).toBe('EDQUOT');
    ok(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/home/bob/g')));
    const aliceBytes = w.user(ALICE.uid).usedBytes;
    ok(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/f', { uid: BOB.uid })));
    expect(w.user(ALICE.uid).usedBytes).toBe(aliceBytes - 40);
    expect(w.user(BOB.uid).usedBytes).toBe(40);
  });

  it('VFS-06 hard-linked inodes are charged once and released with their last link', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/d')));
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/d/f', contentOf(new Uint8Array(30), 0)),
      ),
    );
    const u = w.user(ALICE.uid);
    ok(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/d/f', '/home/alice/d/g')));
    expect(w.user(ALICE.uid)).toEqual(u);
    ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/d'))));
    expect(w.user(ALICE.uid).usedBytes).toBe(u.usedBytes - 30);
    expect(w.user(ALICE.uid).usedInodes).toBe(u.usedInodes - 2);
  });

  it('VFS-06 writing past the 64 MiB tmpfs limit gives EDQUOT', () => {
    const w = new World();
    w.tmpfs = { bytes: TMPFS_MAX_BYTES - 10, inodes: 1 };
    expect(
      errnoOf(
        w.run(ROOT, 'write', (b) => planWriteFile(b, '/tmp/f', contentOf(new Uint8Array(11), 0))),
      ),
    ).toBe('EDQUOT');
    ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/tmp/f', contentOf(new Uint8Array(10), 0))));
    expect(tmpfsExceeds({ bytes: 0, inodes: TMPFS_MAX_INODES }, { bytes: 0, inodes: 1 })).toBe(
      true,
    );
    expect(tmpfsExceeds({ bytes: TMPFS_MAX_BYTES, inodes: 0 }, { bytes: -5, inodes: -1 })).toBe(
      false,
    );
  });

  it('VFS-06 the fast fail and the users mirror agree on growth and on missing users', () => {
    const w = new World({ quotaBytes: 10 });
    const plan = w.plan(ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/f', contentOf(new Uint8Array(11), 0)),
    ).plan;
    expect(quotaCheck(plan, (uid) => w.tree.user(uid), w.tmpfs)).toBe('EDQUOT');
    expect(quotaCheck(plan, () => undefined, w.tmpfs)).toBe(null);
    expect(fastFail(() => undefined, [{ uid: 1, dBytes: 5, dInodes: 5 }])).toBe(false);
    expect(
      applyDelta(w.user(ALICE.uid), { uid: ALICE.uid, dBytes: 3, dInodes: -1 }).usedBytes,
    ).toBe(3);
  });

  it('VFS-06 quota recomputes as server-confirmed plus the unacknowledged deltas', () => {
    const w = new World();
    const u: UserRec = { ...w.user(ALICE.uid), serverUsedBytes: 100, serverUsedInodes: 3 };
    const undo = (state: UndoRec['state'], dBytes: number): UndoRec => ({
      opId: String(dBytes),
      state,
      pre: { inodes: [], dentries: [] },
      created: { inodes: [], dentries: [] },
      users: [
        { uid: ALICE.uid, dBytes, dInodes: 1 },
        { uid: BOB.uid, dBytes: 999, dInodes: 9 },
      ],
      pins: [],
      keepAfterAck: false,
      summary: '',
      createdAt: 0,
    });
    const r = recomputeUsed(u, [undo('open', 10), undo('open', -4), undo('committed', 1000)]);
    expect(r.usedBytes).toBe(106);
    expect(r.usedInodes).toBe(5);
    expect(quotaReport({ ...r, serverAt: 1 }, true).source).toBe('server');
    expect(quotaReport(r, false)).toMatchObject({ source: 'mirror', quotaBytes: r.quotaBytes });
  });
});
