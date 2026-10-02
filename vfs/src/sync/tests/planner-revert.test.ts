/**
 * Compatibility with the VFS's own planners: an op planned by `PlanBuilder` and committed by
 * `applyCommit` (undo + outbox in one transaction) is reverted by syncd's rejection transaction back
 * to exactly the rows and blob references it started from (VFS §3.14.4, DB-02 client rule 5).
 */
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../../content.ts';
import { forRemove } from '../../ops/common.ts';
import { planMkdir } from '../../ops/create.ts';
import { prepareCommit } from '../../ops/commit.ts';
import type { Commit } from '../../ops/commit.ts';
import { PlanBuilder } from '../../ops/plan.ts';
import type { Plan } from '../../ops/plan.ts';
import { planRemoveTree } from '../../ops/unlink.ts';
import { planWriteFile } from '../../ops/write.ts';
import type { Cred } from '../../perm.ts';
import { applyCommit } from '../../store/apply.ts';
import type { BlobRec, DentryRec, InodeRec, OutboxRec } from '../../store/records.ts';
import { STORES } from '../../store/schema.ts';
import { StoreSyncStorage, txContext } from '../storage.ts';
import { ALICE, World, ok, testIno } from '../../../tests/doubles/world.ts';
import { Device } from './doubles/device.ts';

const EPOCH = 3;

async function seeded(w: World): Promise<Device> {
  const dev = await Device.open();
  const snap = w.tree.snapshot();
  await dev.store.tx(STORES, 'strict', (t) => {
    for (const n of snap.inodes) t.put('inodes', n);
    for (const d of snap.dentries) t.put('dentries', d);
    for (const u of w.tree.users.values()) t.put('users', u);
    for (const b of w.blobs.values()) t.put('blobs', b);
    t.put('meta', { k: 'fencingEpoch', v: EPOCH });
    t.put('meta', { k: 'tmpfsUsage', v: w.tmpfs });
  });
  return dev;
}

function commitOf(
  w: World,
  cred: Cred,
  call: Plan['call'],
  fn: (b: PlanBuilder) => unknown,
): Commit {
  const ctx = w.ctx(cred);
  const b = new PlanBuilder(w.tree, ctx);
  fn(b);
  return prepareCommit(b.build(call, call), {
    opId: ctx.opId,
    osSessionId: testIno(2),
    principal: cred.uid,
    now: ctx.now,
    awaitSync: false,
  });
}

function rows(dev: Device): {
  inodes: InodeRec[];
  dentries: DentryRec[];
  refs: [string, number][];
} {
  return {
    inodes: dev.dump<InodeRec>('inodes'),
    dentries: dev.dump<DentryRec>('dentries'),
    refs: dev.dump<BlobRec>('blobs').map((b) => [b.sha, b.refcount]),
  };
}

describe('reverting planner-made ops (VFS §3.14.4)', () => {
  it('VFS-10 a rejected rm -r planned by the VFS restores the subtree, the quota rows and the blob references exactly', async () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/old')));
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/old/sub')));
    ok(
      w.run(ALICE, 'create', (b) =>
        planWriteFile(b, '/home/alice/old/a.txt', contentOfText('alpha', 0)),
      ),
    );
    ok(
      w.run(ALICE, 'create', (b) =>
        planWriteFile(b, '/home/alice/old/sub/b.txt', contentOfText('beta!', 0)),
      ),
    );
    const dev = await seeded(w);
    const before = rows(dev);
    const users = dev.dump('users');
    const c = commitOf(w, ALICE, 'unlink', (b) =>
      planRemoveTree(b, forRemove(b, '/home/alice/old')),
    );
    await applyCommit(dev.store, c, { epoch: EPOCH, now: 10 });
    expect(rows(dev).inodes.length).toBeLessThan(before.inodes.length);
    const [rec] = dev.dump<OutboxRec>('outbox');
    if (rec === undefined) throw new Error('no outbox record');
    const storage = new StoreSyncStorage(dev.store);
    await storage.applyResult({
      kind: 'reject',
      rec,
      result: {
        opId: rec.opId,
        status: 'rejected',
        duplicate: false,
        errno: 'EAGAIN',
        reason: 'stale-version',
        lamport: 9,
      },
      members: [],
      ctx: txContext(20, 'UTC'),
    });
    const after = rows(dev);
    expect(after.inodes).toEqual(before.inodes);
    expect(after.dentries).toEqual(before.dentries);
    expect(after.refs.filter(([, n]) => n > 0)).toEqual(before.refs.filter(([, n]) => n > 0));
    expect(dev.dump('users')).toEqual(users);
    expect(dev.dump('outbox')).toEqual([]);
    expect(dev.dump('undo')).toEqual([]);
  });

  it('VFS-10 an acknowledged write planned by the VFS keeps the new content and drops the pins of the old one', async () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planWriteFile(b, '/home/alice/r.md', contentOfText('v1', 0))));
    const dev = await seeded(w);
    const c = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/r.md', contentOfText('version two', 0)),
    );
    await applyCommit(dev.store, c, { epoch: EPOCH, now: 10 });
    const [rec] = dev.dump<OutboxRec>('outbox');
    if (rec === undefined || rec.op.kind !== 'write') throw new Error('no write record');
    const newSha = contentOfText('version two', 0).sha;
    const oldSha = contentOfText('v1', 0).sha;
    const oldRefs = dev.blob(oldSha)?.refcount ?? 0;
    expect(dev.blob(newSha)?.refcount).toBe(2); // the inode and the outbox pin
    const storage = new StoreSyncStorage(dev.store);
    await storage.applyResult({
      kind: 'ack',
      rec,
      result: {
        opId: rec.opId,
        status: 'applied',
        duplicate: false,
        lamport: 9,
        versions: [{ ino: rec.op.ino, version: 2 }],
      },
      ctx: txContext(20, 'UTC'),
    });
    expect(dev.blob(newSha)).toMatchObject({ refcount: 1, uploaded: true });
    // The undo pin of the old content is released (the World's own earlier pin is not ours to drop).
    expect(dev.blob(oldSha)?.refcount).toBe(oldRefs - 1);
    expect(dev.inode(rec.op.ino)).toMatchObject({ blob: newSha, version: 2 });
    expect(dev.dump('undo')).toEqual([]);
  });
});
