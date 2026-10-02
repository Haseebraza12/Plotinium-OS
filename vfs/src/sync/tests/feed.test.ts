import type { Change, FeedCursor } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { BlobRec, InodeRec } from '../../store/records.ts';
import { FeedTracker } from '../feed.ts';
import { cursorSeq } from '../results.ts';
import { isNewer, mergeRow, rowToChange, subtreeRoots, touchesLocal } from '../remote.ts';
import { StoreSyncStorage, txContext } from '../storage.ts';
import type { VfsChangedBody } from '../types.ts';
import { FakeClock, settle } from './doubles/clock.ts';
import {
  ALICE,
  BOB,
  Device,
  HOME,
  baseSeed,
  blobRec,
  dirRec,
  fileRec,
  outboxRec,
  sha,
  tid,
  undoRec,
} from './doubles/device.ts';
import { Harness } from './doubles/harness.ts';

const SHARED = tid(0x5a4ed);
const NOW = Date.UTC(2027, 0, 15, 10);

function entry(
  ownerUid: number,
  seq: number,
  changes: Change[] = [],
  over: Partial<VfsChangedBody> = {},
): VfsChangedBody {
  return {
    ownerUid,
    seq,
    opId: tid(0xe0000 + seq),
    commitTime: new Date(NOW).toISOString(),
    lamport: 300 + seq,
    redacted: false,
    changes,
    ...over,
  };
}

function upsertFile(
  ino: string,
  version: number,
  blob: string,
  name: string,
  parent = SHARED,
): Change {
  return {
    kind: 'upsert',
    ino,
    version,
    parentIno: parent,
    name,
    type: 'f',
    mode: 0o644,
    uid: BOB,
    gid: 100,
    size: 10,
    nlink: 1,
    blob,
    mtime: version,
    ctime: version,
  };
}

describe('feed tracker (§3.8.4 client side)', () => {
  function tracker(): {
    f: FeedTracker;
    clock: FakeClock;
    gaps: [number, number][];
    acks: FeedCursor[][];
  } {
    const clock = new FakeClock();
    const gaps: [number, number][] = [];
    const acks: FeedCursor[][] = [];
    const f = new FeedTracker(clock, {
      onGap: (o, s) => gaps.push([o, s]),
      onAck: (c) => acks.push(c),
    });
    return { f, clock, gaps, acks };
  }

  it('VFS-10 entries apply per owner in strictly increasing seq: later ones wait, older ones are ignored', () => {
    const { f } = tracker();
    f.mirror(BOB, 4);
    expect(f.offer(entry(BOB, 4))).toBe('stale');
    expect(f.offer(entry(BOB, 6))).toBe('buffered');
    expect(f.offer(entry(BOB, 6))).toBe('stale');
    expect(f.nextEntry(BOB)).toBeNull();
    expect(f.offer(entry(BOB, 5))).toBe('apply');
    expect(f.ready()).toEqual([BOB]);
    expect(f.nextEntry(BOB)).toMatchObject({ entry: { seq: 5 }, cursorAfter: 5 });
    f.advance(BOB, 5);
    expect(f.nextEntry(BOB)).toMatchObject({ entry: { seq: 6 }, cursorAfter: 6 });
    f.advance(BOB, 6);
    f.advance(BOB, 2);
    expect(f.cursor(BOB)).toBe(6);
    expect(f.offer(entry(ALICE + 7, 1))).toBe('unmirrored');
    expect(f.nextEntry(ALICE + 7)).toBeNull();
  });

  it('VFS-10 a gap older than FEED_GAP_MS asks for resume from the cursor, once filled it stops', async () => {
    const { f, clock, gaps } = tracker();
    f.mirror(BOB, 0);
    f.offer(entry(BOB, 3));
    await clock.advance(1_999);
    expect(gaps).toEqual([]);
    await clock.advance(1);
    expect(gaps).toEqual([[BOB, 0]]);
    f.offer(entry(BOB, 5));
    f.offer(entry(BOB, 1));
    f.advance(BOB, 1);
    await clock.advance(2_000);
    expect(gaps).toEqual([
      [BOB, 0],
      [BOB, 1],
    ]);
    f.forget(BOB);
    expect(f.isMirrored(BOB)).toBe(false);
  });

  it('VFS-10 our own entries (op.result.ownerSeqs) advance the cursor through the same buffer', () => {
    const { f } = tracker();
    f.mirror(ALICE, 10);
    f.mirror(BOB, 3);
    const own = [
      { ownerUid: ALICE, seq: 12 },
      { ownerUid: BOB, seq: 4 },
      { ownerUid: 77, seq: 1 },
    ];
    const planned = f.planOwn(own);
    expect(planned).toEqual([{ ownerUid: BOB, seq: 4 }]);
    f.commitOwn(own, planned);
    expect(f.cursor(BOB)).toBe(4);
    expect(f.cursor(ALICE)).toBe(10);
    f.offer(entry(ALICE, 11));
    expect(f.nextEntry(ALICE)).toMatchObject({ entry: { seq: 11 }, cursorAfter: 12 });
    expect(f.planOwn([{ ownerUid: ALICE, seq: 13 }])).toEqual([]);
    f.advance(ALICE, 12);
    const p2 = f.planOwn([{ ownerUid: ALICE, seq: 13 }]);
    expect(p2).toEqual([{ ownerUid: ALICE, seq: 13 }]);
    f.commitOwn([{ ownerUid: ALICE, seq: 13 }], p2);
    expect(f.resumeCursors()).toEqual([
      { ownerUid: ALICE, fromSeq: 13 },
      { ownerUid: BOB, fromSeq: 4 },
    ]);
  });

  it('VFS-10 acks are batched: at most every 100 ms or every 64 entries', async () => {
    const { f, clock, acks } = tracker();
    f.mirror(BOB, 0);
    f.mirror(ALICE, 0);
    f.advance(BOB, 1);
    f.advance(ALICE, 2);
    expect(acks).toEqual([]);
    await clock.advance(100);
    expect(acks).toEqual([
      [
        { ownerUid: ALICE, seq: 2 },
        { ownerUid: BOB, seq: 1 },
      ],
    ]);
    for (let s = 2; s <= 65; s++) f.advance(BOB, s);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual([{ ownerUid: BOB, seq: 65 }]);
    f.reset(BOB, 100);
    f.pause();
    await clock.advance(200);
    expect(acks).toHaveLength(2);
    f.flushAck();
    f.reset(999, 5);
    expect(f.cursor(999)).toBe(5);
    f.mirror(999, 9);
    expect(f.cursor(999)).toBe(9);
  });
});

describe('remote apply rules (VFS §3.17.1)', () => {
  async function device(): Promise<{ dev: Device; storage: StoreSyncStorage }> {
    const dev = await Device.open();
    const b = baseSeed();
    await dev.seed({
      ...b,
      inodes: [
        ...(b.inodes ?? []),
        dirRec(SHARED, BOB, { mode: 0o775 }),
        dirRec(tid(0x0f0), BOB, { mir: 0 }),
        fileRec(tid(0xf1), BOB, { version: 5, blob: sha(1), ctime: 50 }),
      ],
      dentries: [
        ...(b.dentries ?? []),
        { parent: HOME.bob, name: 'shared', ino: SHARED, dtype: 'd' },
        { parent: SHARED, name: 'cold', ino: tid(0x0f0), dtype: 'd' },
        { parent: SHARED, name: 'f1', ino: tid(0xf1), dtype: 'f' },
      ],
      blobs: [blobRec(sha(1), 1)],
    });
    return { dev, storage: new StoreSyncStorage(dev.store) };
  }
  const req = (touched: string[] = []) => ({
    touched: new Set(touched),
    mirroredOwners: new Set([0, ALICE, BOB]),
  });

  it('VFS-10 a new file in a mirrored directory is created with a content record fetched on first read', async () => {
    const { dev, storage } = await device();
    const eff = await storage.applyChanges(
      [
        upsertFile(tid(0xf2), 1, sha(2), 'new.md'),
        upsertFile(tid(0xf3), 1, sha(3), 'x', tid(0x0f0)),
      ],
      req(),
      txContext(NOW, 'UTC', [{ ownerUid: BOB, seq: 3 }], 400),
    );
    expect(dev.entry(SHARED, 'new.md')?.ino).toBe(tid(0xf2));
    expect(dev.inode(tid(0xf2))).toMatchObject({ version: 1, blob: sha(2), uid: BOB });
    expect(dev.blob(sha(2))).toMatchObject({ chunks: null, refcount: 1, uploaded: true });
    expect(dev.inode(tid(0xf3))).toBeUndefined(); // parent not mirrored
    expect(cursorSeq({ k: '', v: dev.meta('resume:1001') })).toBe(3);
    expect(dev.meta('lamport')).toBe(400);
    expect(eff.seen.has(tid(0xf2))).toBe(true);
  });

  it('VFS-10 versions only move forward: a stale change is ignored, a newer one swaps the content', async () => {
    const { dev, storage } = await device();
    await storage.applyChanges(
      [upsertFile(tid(0xf1), 4, sha(9), 'f1')],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.inode(tid(0xf1))).toMatchObject({ version: 5, blob: sha(1) });
    await storage.applyChanges(
      [upsertFile(tid(0xf1), 6, sha(6), 'f1')],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.inode(tid(0xf1))).toMatchObject({ version: 6, blob: sha(6) });
    expect(dev.blob(sha(1))?.refcount).toBe(0);
    expect(dev.blob(sha(6))?.refcount).toBe(1);
    const cur = dev.inode(tid(0xf1)) as InodeRec;
    expect(isNewer(cur, { kind: 'upsert', ino: cur.ino, version: 6, ctime: cur.ctime + 1 })).toBe(
      true,
    );
    expect(isNewer(cur, { kind: 'upsert', ino: cur.ino, version: 6, ctime: cur.ctime })).toBe(
      false,
    );
    expect(isNewer(cur, { kind: 'upsert', ino: cur.ino, version: 6 })).toBe(false);
  });

  it('VFS-10 changes touching a pending local op are deferred, never applied over it', async () => {
    const { dev, storage } = await device();
    const c = upsertFile(tid(0xf1), 9, sha(9), 'f1');
    const eff = await storage.applyChanges([c], req([tid(0xf1)]), txContext(NOW, 'UTC'));
    expect(eff.deferred).toEqual([c]);
    expect(dev.inode(tid(0xf1))?.version).toBe(5);
    expect(
      touchesLocal(
        { kind: 'move', ino: tid(1), version: 1, fromParentIno: SHARED },
        new Set([SHARED]),
      ),
    ).toBe(true);
    expect(
      touchesLocal(
        { kind: 'unlink', ino: tid(1), version: 1, parentIno: SHARED },
        new Set([SHARED]),
      ),
    ).toBe(true);
  });

  it('VFS-10 an unlinked directory takes its locally stored subtree with it; a hard-linked file survives', async () => {
    const { dev, storage } = await device();
    const d = tid(0xd0);
    const inner = tid(0xd1);
    await dev.seed({
      inodes: [
        dirRec(d, BOB),
        fileRec(inner, BOB, { blob: sha(4) }),
        fileRec(tid(0xf5), BOB, { nlink: 2 }),
      ],
      dentries: [
        { parent: SHARED, name: 'd', ino: d, dtype: 'd' },
        { parent: d, name: 'inner', ino: inner, dtype: 'f' },
        { parent: SHARED, name: 'h1', ino: tid(0xf5), dtype: 'f' },
        { parent: HOME.bob, name: 'h2', ino: tid(0xf5), dtype: 'f' },
      ],
      blobs: [blobRec(sha(4), 1)],
    });
    await storage.applyChanges(
      [
        { kind: 'unlink', ino: d, version: 2, parentIno: SHARED, name: 'd', subtree: true },
        { kind: 'unlink', ino: tid(0xf5), version: 2, parentIno: SHARED, name: 'h1' },
        { kind: 'unlink', ino: tid(0xabc), version: 1 },
      ],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.inode(d)).toBeUndefined();
    expect(dev.inode(inner)).toBeUndefined();
    expect(dev.entriesOf(d)).toEqual([]);
    expect(dev.blob(sha(4))?.refcount).toBe(0);
    expect(dev.entry(SHARED, 'h1')).toBeUndefined();
    expect(dev.inode(tid(0xf5))).toBeDefined();
  });

  it('VFS-10 a move inside mirrored directories moves the entry; a move out of view forgets the inode', async () => {
    const { dev, storage } = await device();
    await storage.applyChanges(
      [
        {
          kind: 'move',
          ino: tid(0xf1),
          version: 5,
          fromParentIno: SHARED,
          fromName: 'f1',
          parentIno: HOME.bob,
          name: 'moved',
        },
      ],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.entry(SHARED, 'f1')).toBeUndefined();
    expect(dev.entry(HOME.bob, 'moved')?.ino).toBe(tid(0xf1));
    const eff = await storage.applyChanges(
      [
        {
          kind: 'move',
          ino: tid(0xf1),
          version: 5,
          fromParentIno: HOME.bob,
          fromName: 'moved',
          parentIno: tid(0x0f0),
          name: 'gone',
        },
      ],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.inode(tid(0xf1))).toBeUndefined();
    expect(eff.writes.some((w) => w.store === 'inodes' && w.op === 'del')).toBe(true);
    const e2 = await storage.applyChanges(
      [{ kind: 'move', ino: tid(0xf9), version: 1, parentIno: SHARED, name: 'arrived', type: 'f' }],
      req(),
      txContext(NOW, 'UTC'),
    );
    expect(dev.entry(SHARED, 'arrived')?.ino).toBe(tid(0xf9));
    expect(e2.refetch).toEqual([SHARED]);
  });

  it('VFS-10 snapshot rows become upserts and mark complete directories mirrored', async () => {
    const { dev, storage } = await device();
    const row = {
      parentIno: SHARED,
      name: 'snapdir',
      ino: tid(0xdd),
      type: 'd' as const,
      mode: 0o755,
      uid: BOB,
      gid: 100,
      size: 0,
      nlink: 2,
      version: 3,
      mtime: 1,
      ctime: 1,
      btime: 1,
    };
    const rootRow = {
      parentIno: null,
      name: null,
      ino: tid(1),
      type: 'd' as const,
      mode: 0o755,
      uid: 0,
      gid: 0,
      size: 0,
      nlink: 4,
      version: 9,
      mtime: 1,
      ctime: 1,
      btime: 1,
      blob: sha(7),
      symlinkTarget: 'x',
    };
    expect(rowToChange(rootRow)).toMatchObject({
      kind: 'upsert',
      ino: tid(1),
      version: 9,
      blob: sha(7),
      symlinkTarget: 'x',
    });
    expect(rowToChange(rootRow).parentIno).toBeUndefined();
    await storage.applyChanges(
      [rowToChange(row), rowToChange(rootRow)],
      { ...req(), completeDir: (r) => r.uid === BOB },
      txContext(NOW, 'UTC'),
    );
    expect(dev.inode(tid(0xdd))).toMatchObject({ type: 'd', mir: 1, version: 3 });
    expect(dev.inode(tid(1))?.version).toBe(9);
    expect(dev.inode(tid(0x0f0))?.mir).toBe(0);
  });

  it('VFS-10 merged rows keep device-local fields and default what the server leaves out', () => {
    const local = fileRec(tid(1), BOB, { atime: 77, btime: 5, blob: sha(1) });
    expect(
      mergeRow(local, { kind: 'upsert', ino: tid(1), version: 2 }, NOW, new Set()),
    ).toMatchObject({ atime: 77, btime: 5, blob: null, version: 2 });
    expect(
      mergeRow(undefined, { kind: 'upsert', ino: tid(2), version: 1 }, NOW, new Set()),
    ).toBeNull();
    expect(
      mergeRow(
        undefined,
        { kind: 'upsert', ino: tid(3), version: 1, type: 'd', uid: BOB },
        NOW,
        new Set([BOB]),
      ),
    ).toMatchObject({ mir: 1, mode: 0o755, nlink: 2 });
    expect(
      mergeRow(
        undefined,
        { kind: 'upsert', ino: tid(3), version: 4, type: 'd', uid: BOB },
        NOW,
        new Set([BOB]),
      )?.mir,
    ).toBe(0);
    expect(
      mergeRow(
        undefined,
        { kind: 'upsert', ino: tid(4), version: 1, type: 'l', symlinkTarget: '/x' },
        NOW,
        new Set(),
      ),
    ).toMatchObject({ target: '/x', mode: 0o644 });
    expect(
      subtreeRoots(
        [
          { kind: 'unlink', ino: tid(5), version: 1 },
          { kind: 'move', ino: tid(6), version: 1 },
          { kind: 'upsert', ino: tid(7), version: 1 },
        ],
        (i) => (i === tid(6) ? 'd' : undefined),
      ),
    ).toEqual([tid(6)]);
  });
});

describe('per-owner resume end to end (§3.8, SYN-05)', () => {
  const sharedSeed = {
    inodes: [dirRec(SHARED, BOB, { mode: 0o775 })],
    dentries: [{ parent: HOME.bob, name: 'shared', ino: SHARED, dtype: 'd' as const }],
    meta: [{ k: 'resume:1001', v: { seq: 0, updatedAt: '' } }],
  };

  it("VFS-10 bob edits /home/shared while alice is offline; after resume her copy converges and the cursor is at bob's head", async () => {
    const h = await Harness.create({ seed: sharedSeed });
    h.server.feeds.set(BOB, [
      entry(BOB, 1, [upsertFile(tid(0xa1), 1, sha(0xa1), 'plan.md')]),
      entry(BOB, 2, [upsertFile(tid(0xa1), 2, sha(0xa2), 'plan.md')]),
      entry(BOB, 3, [upsertFile(tid(0xa3), 1, sha(0xa3), 'tmp.md')]),
      entry(BOB, 4, [
        { kind: 'unlink', ino: tid(0xa3), version: 2, parentIno: SHARED, name: 'tmp.md' },
      ]),
      entry(BOB, 5, [], { redacted: true }),
    ]);
    await h.live();
    expect(h.syncd.state).toBe('LIVE');
    expect(h.dev.inode(tid(0xa1))).toMatchObject({ version: 2, blob: sha(0xa2) });
    expect(h.dev.entry(SHARED, 'tmp.md')).toBeUndefined();
    expect(h.dev.inode(tid(0xa3))).toBeUndefined();
    expect(cursorSeq({ k: '', v: h.dev.meta('resume:1001') })).toBe(5);
    await h.clock.advance(150); // acks go at most every 100 ms
    const acked = h.server.framesOf('ack').flatMap((a) => a.cursors);
    expect(acked).toContainEqual({ ownerUid: BOB, seq: 5 });
    expect(h.effects.some((e) => e.kind === 'remote')).toBe(true);
  });

  it('VFS-10 live entries arriving out of order are applied in seq order, and a gap that is never filled triggers resume', async () => {
    const h = await Harness.create({ seed: sharedSeed });
    await h.live();
    h.server.last.push('vfs.changed', entry(BOB, 2, [upsertFile(tid(0xb2), 1, sha(0xb2), 'two')]));
    await settle();
    expect(h.dev.inode(tid(0xb2))).toBeUndefined();
    h.server.last.push('vfs.changed', entry(BOB, 1, [upsertFile(tid(0xb1), 1, sha(0xb1), 'one')]));
    await settle();
    expect(h.dev.inode(tid(0xb1))).toBeDefined();
    expect(h.dev.inode(tid(0xb2))).toBeDefined();
    h.server.last.push('vfs.changed', entry(BOB, 4, [upsertFile(tid(0xb4), 1, sha(0xb4), 'four')]));
    await settle();
    await h.clock.advance(2_100);
    expect(h.server.framesOf('resume')).toContainEqual({
      cursors: [{ ownerUid: BOB, fromSeq: 2 }],
    });
  });

  it("VFS-10 a remote change to a file with a pending local write waits for that write's result, then applies", async () => {
    const f = tid(0xc1);
    const opId = tid(0xc0);
    const pre = fileRec(f, BOB, { version: 7, blob: sha(1), mode: 0o666 });
    const h = await Harness.create({
      seed: {
        ...sharedSeed,
        inodes: [...sharedSeed.inodes, { ...pre, version: 8, blob: sha(2) }],
        dentries: [
          ...sharedSeed.dentries,
          { parent: SHARED, name: 'report.md', ino: f, dtype: 'f' },
        ],
        blobs: [blobRec(sha(1), 1), { ...blobRec(sha(2), 2), uploaded: true }],
        undo: [undoRec(opId, { pre: { inodes: [pre], dentries: [] }, pins: [sha(1)] })],
        outbox: [
          outboxRec({
            opId,
            cseq: 1,
            op: { kind: 'write', ino: f, blob: sha(2), size: 10, mtime: 5 },
            base: { kind: 'versions', entries: [{ ino: f, version: 7 }] },
            touches: [f],
            blobs: [sha(2)],
          }),
        ],
      },
    });
    // A scripted server: frames are received, every answer below is pushed by hand.
    h.server.mute = true;
    h.syncd.connect();
    await settle();
    // bob's version 9 arrives before our write's result: it must not overwrite the pending edit.
    h.server.last.push('hello.ok', {
      proto: 1,
      osSessionId: tid(0x5e55),
      server: { name: 'Plotinium', version: '1.0.0', build: 'abc1234', date: '2027-01-15' },
      serverTime: new Date(h.clock.now()).toISOString(),
      lamport: 1,
      auth: { uid: ALICE, username: 'alice', gids: [100], kind: 'user', suGrants: [] },
      limits: {
        maxPayload: 65_536,
        opEnvelopeMax: 61_440,
        maxBatch: 32,
        creditWindow: 16,
        feedWindow: 256,
        maxLeases: 256,
        maxWatches: 256,
      },
      timers: { leaseTtlMs: 15_000, hbMs: 5_000, deadManMs: 25_000 },
      owners: [],
      keptLeases: [],
      lostLeases: [],
    });
    h.server.last.push('vfs.changed', entry(BOB, 1, [upsertFile(f, 9, sha(9), 'report.md')]));
    await settle();
    expect(h.dev.inode(f)).toMatchObject({ version: 8, blob: sha(2) });
    const keptAs = {
      ino: tid(0xcc),
      parentIno: SHARED,
      name: 'report (conflict from alice, 2027-01-15).md',
    };
    h.server.last.push('op.result', {
      opId,
      status: 'conflict',
      duplicate: false,
      keptAs,
      lamport: 500,
    });
    await settle();
    expect(h.dev.inode(f)).toMatchObject({ version: 9, blob: sha(9) });
    expect(h.dev.entry(SHARED, keptAs.name)?.ino).toBe(keptAs.ino);
    expect(h.dev.blob(sha(2))?.refcount).toBe(1);
    expect(h.notices.find((n) => n.type === 'conflict')).toMatchObject({ opId, ino: f, keptAs });
  });

  it('VFS-10 snapshot.required pages through the snapshot, applies it, then resumes from its head', async () => {
    const h = await Harness.create({ seed: sharedSeed });
    h.server.snapshotOwners.add(BOB);
    const url = `/api/sync/snapshot?scope=owner&owner=${BOB}`;
    const row = (ino: string, name: string, version: number) => ({
      parentIno: SHARED,
      name,
      ino,
      type: 'f' as const,
      mode: 0o644,
      uid: BOB,
      gid: 100,
      size: 3,
      nlink: 1,
      version,
      blob: sha(0xd0),
      mtime: 1,
      ctime: 1,
      btime: 1,
    });
    h.server.snapshots.set(url, [
      { owners: [{ ownerUid: BOB, headSeq: 7 }], rows: [row(tid(0xd1), 'a', 3)], complete: false },
      { rows: [row(tid(0xd2), 'b', 1)], complete: true },
    ]);
    h.server.feeds.set(BOB, [entry(BOB, 8, [upsertFile(tid(0xd3), 1, sha(0xd3), 'c')])]);
    await h.live();
    expect(h.syncd.state).toBe('LIVE');
    expect(h.dev.entry(SHARED, 'a')?.ino).toBe(tid(0xd1));
    expect(h.dev.entry(SHARED, 'b')?.ino).toBe(tid(0xd2));
    expect(h.dev.entry(SHARED, 'c')?.ino).toBe(tid(0xd3));
    expect(h.server.framesOf('resume')).toContainEqual({
      cursors: [{ ownerUid: BOB, fromSeq: 7 }],
    });
    expect(cursorSeq({ k: '', v: h.dev.meta('resume:1001') })).toBe(8);
    expect(h.dev.dump<BlobRec>('blobs').find((b) => b.sha === sha(0xd0))?.refcount).toBe(2);
  });

  it('VFS-10 an entry that changed over 200 inodes re-reads the listed directories with a snapshot', async () => {
    const h = await Harness.create({ seed: sharedSeed });
    const url = `/api/sync/snapshot?scope=dir&ino=${SHARED}`;
    h.server.snapshots.set(url, [
      {
        rows: [
          {
            parentIno: SHARED,
            name: 'big',
            ino: tid(0xe1),
            type: 'd',
            mode: 0o755,
            uid: BOB,
            gid: 100,
            size: 0,
            nlink: 2,
            version: 1,
            mtime: 1,
            ctime: 1,
            btime: 1,
          },
        ],
        complete: true,
      },
    ]);
    await h.live();
    h.server.last.push('vfs.changed', entry(BOB, 1, [], { refetch: { dirs: [SHARED] } }));
    await h.clock.advance(100);
    expect(h.dev.entry(SHARED, 'big')?.ino).toBe(tid(0xe1));
    expect(h.notices.some((n) => n.type === 'refetch')).toBe(true);
  });

  it('VFS-10 entries of an owner this device does not mirror apply only to inodes it has', async () => {
    const h = await Harness.create({
      seed: {
        inodes: [fileRec(tid(0xf7), 2000, { version: 1 })],
        dentries: [{ parent: HOME.alice, name: 'x', ino: tid(0xf7), dtype: 'f' }],
      },
    });
    await h.live();
    h.server.last.push(
      'vfs.changed',
      entry(2000, 40, [
        {
          kind: 'upsert',
          ino: tid(0xf7),
          version: 3,
          type: 'f',
          uid: 2000,
          size: 1,
          mtime: 3,
          ctime: 3,
        },
      ]),
    );
    await settle();
    expect(h.dev.inode(tid(0xf7))?.version).toBe(3);
    h.syncd.mirrorOwner(2000, 40);
    h.syncd.mirrorOwner(2000, 41);
    await settle();
    expect(h.server.framesOf('resume')).toContainEqual({
      cursors: [{ ownerUid: 2000, fromSeq: 40 }],
    });
    expect(cursorSeq({ k: '', v: h.dev.meta('resume:2000') })).toBe(40);
  });
});
