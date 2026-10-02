import { deriveIno } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { DentryRec, InodeRec, OutboxRec, UndoRec, UserRec } from '../../store/records.ts';
import { closureOf, cursorSeq } from '../results.ts';
import { StoreSyncStorage, txContext } from '../storage.ts';
import type { OpResultBody } from '../types.ts';
import {
  ALICE,
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
  userRec,
} from './doubles/device.ts';

const NOW = Date.UTC(2027, 0, 15, 9, 30);
const B0 = sha(0xb0);
const B1 = sha(0xb1);
const B2 = sha(0xb2);

function result(opId: string, over: Partial<OpResultBody>): OpResultBody {
  return { opId, status: 'applied', duplicate: false, lamport: 200, ...over };
}

async function device(
  extra: Parameters<Device['seed']>[0],
): Promise<{ dev: Device; storage: StoreSyncStorage }> {
  const dev = await Device.open();
  const b = baseSeed();
  await dev.seed({
    inodes: [...(b.inodes ?? []), ...(extra.inodes ?? [])],
    dentries: [...(b.dentries ?? []), ...(extra.dentries ?? [])],
    users: extra.users ?? b.users ?? [],
    blobs: extra.blobs ?? [],
    undo: extra.undo ?? [],
    outbox: extra.outbox ?? [],
    meta: extra.meta ?? [],
  });
  return { dev, storage: new StoreSyncStorage(dev.store) };
}

/** Our offline edit of report.md: v7 (B0) → v8 (B1), not synced yet. */
function offlineWrite(): {
  rec: OutboxRec;
  seed: Parameters<Device['seed']>[0];
  file: string;
  opId: string;
} {
  const file = tid(0xf11e);
  const opId = tid(0x0b01);
  const pre = fileRec(file, ALICE, { version: 7, blob: B0, size: 10, mode: 0o640 });
  const cur = { ...pre, version: 8, blob: B1, size: 20, mtime: 5, ctime: 5 };
  const rec = outboxRec({
    opId,
    cseq: 1,
    op: { kind: 'write', ino: file, blob: B1, size: 20, mtime: 5 },
    base: { kind: 'versions', entries: [{ ino: file, version: 7 }] },
    touches: [file],
    blobs: [B1],
  });
  return {
    rec,
    file,
    opId,
    seed: {
      inodes: [cur],
      dentries: [{ parent: HOME.alice, name: 'report.md', ino: file, dtype: 'f' }],
      blobs: [blobRec(B0, 1), blobRec(B1, 2, 20)],
      undo: [
        undoRec(opId, {
          pre: { inodes: [pre], dentries: [] },
          users: [{ uid: ALICE, dBytes: 10, dInodes: 0 }],
          pins: [B0],
        }),
      ],
      outbox: [rec],
      users: [
        userRec(ALICE, 'alice', HOME.alice, {
          serverUsedBytes: 10,
          serverUsedInodes: 2,
          usedBytes: 20,
          usedInodes: 2,
        }),
      ],
    },
  };
}

function loaded(dev: Device, opId: string): Promise<OutboxRec> {
  const r = dev.dump<OutboxRec>('outbox').find((x) => x.opId === opId);
  return r === undefined ? Promise.reject(new Error(`no record ${opId}`)) : Promise.resolve(r);
}

describe('applied results (VFS §3.14.3)', () => {
  it('OFF-02 an applied result deletes the record and undo, applies versions, releases pins and confirms the quota mirror', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device(w.seed);
    const rec = await loaded(dev, w.opId);
    const eff = await storage.applyResult({
      kind: 'ack',
      rec,
      result: result(w.opId, {
        versions: [
          { ino: w.file, version: 8, mtime: 4, ctime: 6 },
          { ino: tid(0xdead), version: 3 },
        ],
        quota: {
          uid: ALICE,
          usedBytes: 20,
          usedInodes: 2,
          quotaBytes: 2_000_000,
          quotaInodes: 900,
        },
      }),
      ctx: txContext(NOW, 'UTC', [{ ownerUid: ALICE, seq: 12 }], 250),
    });
    expect(dev.dump('outbox')).toEqual([]);
    expect(dev.dump('undo')).toEqual([]);
    expect(dev.inode(w.file)).toMatchObject({ version: 8, mtime: 4, ctime: 6, blob: B1 });
    expect(dev.blob(B0)).toMatchObject({ refcount: 0, zeroSince: NOW });
    expect(dev.blob(B1)).toMatchObject({ refcount: 1, uploaded: true });
    expect(dev.dump<UserRec>('users').find((u) => u.uid === ALICE)).toMatchObject({
      serverUsedBytes: 20,
      usedBytes: 20,
      quotaBytes: 2_000_000,
      quotaInodes: 900,
      serverAt: NOW,
    });
    expect(cursorSeq({ k: 'x', v: dev.meta('resume:1000') })).toBe(12);
    expect(dev.meta('lamport')).toBe(250);
    expect(eff.deleted).toEqual([w.opId]);
    expect(eff.writes.map((x) => x.store)).toEqual(['inodes']);
  });

  it('AGT-10 an applied agent batch keeps its undo record as committed for ai undo', async () => {
    const w = offlineWrite();
    const seed = {
      ...w.seed,
      undo: (w.seed.undo ?? []).map((u) => ({ ...u, keepAfterAck: true })),
    };
    const { dev, storage } = await device(seed);
    await storage.applyResult({
      kind: 'ack',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { pruned: true }),
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.dump<UndoRec>('undo')).toMatchObject([{ opId: w.opId, state: 'committed' }]);
    expect(dev.blob(B0)?.refcount).toBe(1);
  });
});

describe('conflicts (§3.12.2; VFS §3.15)', () => {
  it('VFS-10 an offline content write against a newer version becomes report (conflict from alice, date).md and the server version is re-fetched', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device(w.seed);
    const keptAs = {
      ino: deriveIno(w.opId, w.file),
      parentIno: HOME.alice,
      name: 'report (conflict from alice, 2027-01-15).md',
    };
    const eff = await storage.applyResult({
      kind: 'conflict',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, {
        status: 'conflict',
        keptAs,
        versions: [{ ino: keptAs.ino, version: 1, mtime: 99 }],
      }),
      keptAs,
      ctx: txContext(NOW, 'UTC'),
    });
    // Our pre-image stands until the re-fetch brings bob's version; nothing was overwritten.
    expect(dev.inode(w.file)).toMatchObject({ version: 7, blob: B0, size: 10 });
    expect(dev.entry(HOME.alice, keptAs.name)?.ino).toBe(keptAs.ino);
    expect(dev.inode(keptAs.ino)).toMatchObject({
      blob: B1,
      size: 20,
      mode: 0o640,
      uid: ALICE,
      version: 1,
      mtime: 99,
    });
    expect(dev.blob(B0)?.refcount).toBe(1);
    expect(dev.blob(B1)?.refcount).toBe(1);
    expect(dev.dump('outbox')).toEqual([]);
    expect(dev.dump('undo')).toEqual([]);
    expect(eff.refetch).toEqual([w.file]);
    const alice = dev.dump<UserRec>('users').find((u) => u.uid === ALICE);
    expect(alice).toMatchObject({ usedBytes: 30, usedInodes: 3 });
  });

  it('VFS-10 a conflicted copy kept in a ~/lost+found the device has not seen yet creates that directory locally', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device(w.seed);
    const lf = tid(0x1f);
    const keptAs = {
      ino: tid(0xc0b1),
      parentIno: lf,
      name: 'report (conflict from alice, 2027-01-15).md',
    };
    await storage.applyResult({
      kind: 'conflict',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { status: 'conflict', keptAs, errno: 'EBUSY', reason: 'stale-fence' }),
      keptAs,
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.entry(HOME.alice, 'lost+found')?.ino).toBe(lf);
    expect(dev.inode(lf)).toMatchObject({ type: 'd', mode: 0o700, uid: ALICE });
    expect(dev.entry(lf, keptAs.name)?.ino).toBe(keptAs.ino);
    expect(dev.inode(HOME.alice)?.nlink).toBe(3);
  });

  it('VFS-10 two offline creates of the same name keep both files: ours moves to the conflicted name', async () => {
    const n = tid(0x9075);
    const opId = tid(0x0c01);
    const rec = outboxRec({
      opId,
      cseq: 1,
      op: {
        kind: 'create',
        parentIno: HOME.alice,
        name: 'notes.md',
        ino: n,
        type: 'f',
        mode: 0o644,
        mtime: 1,
      },
      touches: [n, HOME.alice],
    });
    const { dev, storage } = await device({
      inodes: [fileRec(n, ALICE)],
      dentries: [{ parent: HOME.alice, name: 'notes.md', ino: n, dtype: 'f' }],
      undo: [undoRec(opId, { created: { inodes: [n], dentries: [[HOME.alice, 'notes.md']] } })],
      outbox: [rec],
    });
    const keptAs = {
      ino: n,
      parentIno: HOME.alice,
      name: 'notes (conflict from alice, 2027-01-15).md',
    };
    const eff = await storage.applyResult({
      kind: 'conflict',
      rec: await loaded(dev, opId),
      result: result(opId, { status: 'conflict', keptAs, versions: [{ ino: n, version: 1 }] }),
      keptAs,
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.entry(HOME.alice, 'notes.md')).toBeUndefined();
    expect(dev.entry(HOME.alice, keptAs.name)?.ino).toBe(n);
    expect(dev.inode(n)).toBeDefined();
    expect(eff.refetch).toEqual([HOME.alice]);
    expect(dev.dump('undo')).toEqual([]);
  });
});

describe('rejections (§3.12.4; VFS §3.14.4)', () => {
  /** alice's offline `rm -r ~/old` (old/ with a.txt, b.txt and sub/). */
  function offlineRmR(): {
    seed: Parameters<Device['seed']>[0];
    opId: string;
    old: string;
    pre: InodeRec[];
    preD: DentryRec[];
  } {
    const old = tid(0x01d);
    const a = tid(0xa);
    const b = tid(0xb);
    const sub = tid(0x5b);
    const opId = tid(0x0d01);
    const homePre = dirRec(HOME.alice, ALICE, { mode: 0o700, nlink: 3, version: 4 });
    const pre = [
      dirRec(old, ALICE, { nlink: 3 }),
      fileRec(a, ALICE, { blob: B1, size: 20 }),
      fileRec(b, ALICE, { blob: B2, size: 5 }),
      dirRec(sub, ALICE),
      homePre,
    ];
    const preD: DentryRec[] = [
      { parent: HOME.alice, name: 'old', ino: old, dtype: 'd' },
      { parent: old, name: 'a.txt', ino: a, dtype: 'f' },
      { parent: old, name: 'b.txt', ino: b, dtype: 'f' },
      { parent: old, name: 'sub', ino: sub, dtype: 'd' },
    ];
    const rec = outboxRec({
      opId,
      cseq: 1,
      op: { kind: 'unlink', parentIno: HOME.alice, name: 'old', ino: old, recursive: true },
      base: { kind: 'digest', rootIno: old, digest: sha(0xd) },
      touches: [old, a, b, sub, HOME.alice],
    });
    return {
      opId,
      old,
      pre,
      preD,
      seed: {
        inodes: [{ ...homePre, version: 5, nlink: 2 }],
        blobs: [blobRec(B1, 1, 20), blobRec(B2, 1, 5)],
        undo: [
          undoRec(opId, {
            pre: { inodes: pre, dentries: preD },
            users: [{ uid: ALICE, dBytes: -25, dInodes: -4 }],
            pins: [B1, B2],
          }),
        ],
        outbox: [rec],
        users: [userRec(ALICE, 'alice', HOME.alice, { usedBytes: 0, usedInodes: 1 })],
      },
    };
  }

  it('VFS-10 an offline rm -r of a subtree that changed meanwhile is rejected stale-version and reverted locally', async () => {
    const t = offlineRmR();
    const { dev, storage } = await device(t.seed);
    const eff = await storage.applyResult({
      kind: 'reject',
      rec: await loaded(dev, t.opId),
      result: result(t.opId, { status: 'rejected', errno: 'EAGAIN', reason: 'stale-version' }),
      members: [],
      ctx: txContext(NOW, 'UTC'),
    });
    for (const r of t.pre) expect(dev.inode(r.ino)).toEqual(r);
    for (const d of t.preD) expect(dev.entry(d.parent, d.name)).toEqual(d);
    expect(dev.blob(B1)?.refcount).toBe(1);
    expect(dev.blob(B2)?.refcount).toBe(1);
    expect(dev.dump('outbox')).toEqual([]);
    expect(dev.dump('undo')).toEqual([]);
    expect(dev.dump<UserRec>('users').find((u) => u.uid === ALICE)).toMatchObject({
      usedBytes: 25,
      usedInodes: 5,
    });
    expect(eff.parked).toBe(false);
    expect(eff.deleted).toEqual([t.opId]);
  });

  it('VFS-10 a rejected offline write keeps its content in ~/lost+found (EACCES, salvaged by the server)', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device(w.seed);
    const lf = tid(0x1f2);
    const keptAs = {
      ino: deriveIno(w.opId, w.file),
      parentIno: lf,
      name: 'report (conflict from alice, 2027-01-15).md',
    };
    const eff = await storage.applyResult({
      kind: 'reject',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { status: 'rejected', errno: 'EACCES', keptAs }),
      members: [],
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.inode(w.file)).toMatchObject({ version: 7, blob: B0 });
    expect(dev.entry(lf, keptAs.name)?.ino).toBe(keptAs.ino);
    expect(dev.inode(keptAs.ino)).toMatchObject({ blob: B1, size: 20 });
    expect(dev.blob(B1)?.refcount).toBe(1);
    expect(dev.blob(B0)?.refcount).toBe(1);
    expect(dev.dump('outbox')).toEqual([]);
    expect(eff.parked).toBe(false);
  });

  it('VFS-10 an offline write rejected EDQUOT is parked locally in ~/lost+found and not deleted', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device(w.seed);
    const eff = await storage.applyResult({
      kind: 'reject',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { status: 'rejected', errno: 'EDQUOT' }),
      members: [],
      ctx: txContext(NOW, 'UTC'),
    });
    const lf = dev.entry(HOME.alice, 'lost+found');
    expect(lf).toBeDefined();
    const name = 'report (conflict from alice, 2027-01-15).md';
    const copy = dev.entry(lf?.ino ?? '', name);
    expect(copy?.ino).toBe(deriveIno(w.opId, w.file));
    expect(dev.inode(copy?.ino ?? '')).toMatchObject({ blob: B1, size: 20, mode: 0o600 });
    expect(dev.inode(w.file)).toMatchObject({ version: 7, blob: B0 });
    const [parked] = dev.dump<OutboxRec>('outbox');
    expect(parked).toMatchObject({
      opId: w.opId,
      state: 'parked',
      touches: [copy?.ino, lf?.ino],
      lastError: { errno: 'EDQUOT' },
    });
    // The outbox pin stays with the parked record, plus the copy's own reference.
    expect(dev.blob(B1)?.refcount).toBe(2);
    expect(eff.parked).toBe(true);
    expect(eff.rewritten.map((r) => r.state)).toEqual(['parked']);
  });

  it('VFS-10 parked copies take the next free conflicted name', async () => {
    const w = offlineWrite();
    const lf = tid(0x1f3);
    const name = 'report (conflict from alice, 2027-01-15).md';
    const seed = {
      ...w.seed,
      inodes: [
        ...(w.seed.inodes ?? []),
        dirRec(lf, ALICE, { mode: 0o700 }),
        fileRec(tid(0x77), ALICE),
      ],
      dentries: [
        ...(w.seed.dentries ?? []),
        { parent: HOME.alice, name: 'lost+found', ino: lf, dtype: 'd' as const },
        { parent: lf, name, ino: tid(0x77), dtype: 'f' as const },
      ],
    };
    const { dev, storage } = await device(seed);
    await storage.applyResult({
      kind: 'reject',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { status: 'rejected', errno: 'EDQUOT' }),
      members: [],
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.entry(lf, 'report (conflict from alice, 2027-01-15) 2.md')?.ino).toBe(
      deriveIno(w.opId, w.file),
    );
  });

  it('VFS-10 a rejection cascades to dependent ops in reverse order: unsent ones are deleted or parked, sent ones become reverted', async () => {
    const d = tid(0xd1);
    const f = tid(0xf1);
    const g = tid(0xf2);
    const k = outboxRec({
      opId: tid(0x1),
      cseq: 1,
      op: {
        kind: 'create',
        parentIno: HOME.alice,
        name: 'proj',
        ino: d,
        type: 'd',
        mode: 0o755,
        mtime: 0,
      },
      touches: [d, HOME.alice],
    });
    const m1 = outboxRec({
      opId: tid(0x2),
      cseq: 2,
      op: {
        kind: 'create',
        parentIno: d,
        name: 'plan.md',
        ino: f,
        type: 'f',
        mode: 0o644,
        blob: B1,
        size: 20,
        mtime: 0,
      },
      touches: [f, d],
      blobs: [B1],
    });
    const m2 = outboxRec({
      opId: tid(0x3),
      cseq: 3,
      op: { kind: 'chmod', ino: f, change: { absolute: 0o600 }, recursive: false },
      touches: [f],
    });
    const m3 = outboxRec({
      opId: tid(0x4),
      cseq: 4,
      op: { kind: 'create', parentIno: d, name: 'x', ino: g, type: 'f', mode: 0o644, mtime: 0 },
      touches: [g, d],
      attempts: 1,
    });
    const other = outboxRec({
      opId: tid(0x5),
      cseq: 5,
      op: { kind: 'utimes', ino: tid(0x999), mtime: 1 },
      touches: [tid(0x999)],
    });
    const fRec = fileRec(f, ALICE, { blob: B1, size: 20 });
    const { dev, storage } = await device({
      inodes: [
        dirRec(d, ALICE),
        { ...fRec, mode: 0o600, version: 2 },
        fileRec(g, ALICE),
        { ...dirRec(HOME.alice, ALICE), version: 2, nlink: 3 },
      ],
      dentries: [
        { parent: HOME.alice, name: 'proj', ino: d, dtype: 'd' },
        { parent: d, name: 'plan.md', ino: f, dtype: 'f' },
        { parent: d, name: 'x', ino: g, dtype: 'f' },
      ],
      blobs: [blobRec(B1, 2, 20)],
      undo: [
        undoRec(k.opId, {
          created: { inodes: [d], dentries: [[HOME.alice, 'proj']] },
          pre: { inodes: [dirRec(HOME.alice, ALICE)], dentries: [] },
        }),
        undoRec(m1.opId, {
          created: { inodes: [f], dentries: [[d, 'plan.md']] },
          pre: { inodes: [{ ...dirRec(d, ALICE) }], dentries: [] },
        }),
        undoRec(m2.opId, { pre: { inodes: [fRec], dentries: [] } }),
        undoRec(m3.opId, { created: { inodes: [g], dentries: [[d, 'x']] } }),
      ],
      outbox: [k, m1, m2, m3, other],
    });
    const recs = dev.dump<OutboxRec>('outbox');
    const kRec = recs[0];
    if (kRec === undefined) throw new Error('no k');
    const closure = closureOf(kRec, recs);
    expect(closure.map((r) => r.opId)).toEqual([m1.opId, m2.opId, m3.opId]);
    const members = closure.map((rec) => ({ rec, everSent: rec.attempts > 0 }));
    const eff = await storage.applyResult({
      kind: 'reject',
      rec: kRec,
      result: result(k.opId, { status: 'rejected', errno: 'EACCES' }),
      members,
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.inode(d)).toBeUndefined();
    expect(dev.inode(f)).toBeUndefined();
    expect(dev.inode(g)).toBeUndefined();
    expect(dev.entry(HOME.alice, 'proj')).toBeUndefined();
    expect(dev.inode(HOME.alice)?.version).toBe(1);
    const left = dev.dump<OutboxRec>('outbox');
    expect(left.map((r) => [r.opId, r.state])).toEqual([
      [m1.opId, 'parked'],
      [m3.opId, 'reverted'],
      [other.opId, 'pending'],
    ]);
    expect(dev.dump<UndoRec>('undo')).toEqual([]);
    expect(new Set(eff.deleted)).toEqual(new Set([k.opId, m2.opId]));
    // m1's bytes survive as a parked copy in ~/lost+found.
    const lf = dev.entry(HOME.alice, 'lost+found');
    expect(dev.entry(lf?.ino ?? '', 'plan (conflict from alice, 2027-01-15).md')).toBeDefined();
    expect(dev.blob(B1)?.refcount).toBe(2);
  });

  it('VFS-10 the own result of a reverted op deletes it, parks content, or re-fetches after an unexpected apply', async () => {
    const g = tid(0xf3);
    const r1 = outboxRec({
      opId: tid(0x11),
      cseq: 1,
      op: {
        kind: 'create',
        parentIno: HOME.alice,
        name: 'x',
        ino: g,
        type: 'f',
        mode: 0o644,
        mtime: 0,
      },
      touches: [g, HOME.alice],
      state: 'reverted',
    });
    const w = offlineWrite();
    const r2 = { ...w.rec, cseq: 2, state: 'reverted' as const };
    const r3 = outboxRec({
      opId: tid(0x13),
      cseq: 3,
      op: { kind: 'utimes', ino: g, mtime: 3 },
      touches: [g],
      state: 'reverted',
    });
    const { dev, storage } = await device({
      ...w.seed,
      undo: [],
      outbox: [r1, r2, r3],
      inodes: [{ ...fileRec(w.file, ALICE), version: 7, blob: B0 }],
      blobs: [blobRec(B0, 1), blobRec(B1, 1, 20)],
    });
    const e1 = await storage.applyResult({
      kind: 'reverted',
      rec: await loaded(dev, r1.opId),
      result: result(r1.opId, { status: 'rejected', errno: 'ENOENT' }),
      ctx: txContext(NOW, 'UTC'),
    });
    expect(e1.deleted).toEqual([r1.opId]);
    const e2 = await storage.applyResult({
      kind: 'reverted',
      rec: await loaded(dev, r2.opId),
      result: result(r2.opId, { status: 'rejected', errno: 'EDQUOT' }),
      ctx: txContext(NOW, 'UTC'),
    });
    expect(e2.parked).toBe(true);
    const e3 = await storage.applyResult({
      kind: 'reverted',
      rec: await loaded(dev, r3.opId),
      result: result(r3.opId, { status: 'applied' }),
      ctx: txContext(NOW, 'UTC'),
    });
    expect(e3.refetch).toEqual([g]);
    expect(dev.dump<OutboxRec>('outbox').map((r) => r.state)).toEqual(['parked']);
  });

  it('VFS-10 a reverted content op that the server kept as a conflicted copy gets that copy locally', async () => {
    const w = offlineWrite();
    const r = { ...w.rec, state: 'reverted' as const };
    const { dev, storage } = await device({
      ...w.seed,
      undo: [],
      outbox: [r],
      inodes: [{ ...fileRec(w.file, ALICE), version: 7, blob: B0 }],
      blobs: [blobRec(B0, 1), blobRec(B1, 1, 20)],
    });
    const keptAs = {
      ino: tid(0xcc),
      parentIno: HOME.alice,
      name: 'report (conflict from alice, 2027-01-15).md',
    };
    await storage.applyResult({
      kind: 'reverted',
      rec: await loaded(dev, w.opId),
      result: result(w.opId, { status: 'conflict', keptAs }),
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.entry(HOME.alice, keptAs.name)?.ino).toBe(keptAs.ino);
    expect(dev.blob(B1)?.refcount).toBe(1);
    expect(dev.dump('outbox')).toEqual([]);
  });

  it('AGT-09 a killed op that never left is reverted locally with its dependants and nothing reaches the server', async () => {
    const t = offlineWrite();
    const later = outboxRec({
      opId: tid(0x77),
      cseq: 2,
      op: { kind: 'utimes', ino: t.file, mtime: 9 },
      touches: [t.file],
      attempts: 1,
    });
    const { dev, storage } = await device({ ...t.seed, outbox: [t.rec, later] });
    const recs = dev.dump<OutboxRec>('outbox');
    const [k, m] = recs;
    if (k === undefined || m === undefined) throw new Error('records');
    const eff = await storage.applyResult({
      kind: 'cancel',
      rec: k,
      members: [{ rec: m, everSent: true }],
      ctx: txContext(NOW, 'UTC'),
    });
    expect(dev.inode(t.file)).toMatchObject({ version: 7, blob: B0 });
    expect(dev.dump<OutboxRec>('outbox').map((r) => [r.opId, r.state])).toEqual([
      [later.opId, 'reverted'],
    ]);
    expect(dev.blob(B1)?.refcount).toBe(0);
    expect(eff.deleted).toEqual([t.opId]);
  });

  it('VFS-10 discarding a parked op deletes it and releases its pin', async () => {
    const w = offlineWrite();
    const { dev, storage } = await device({ ...w.seed, outbox: [{ ...w.rec, state: 'parked' }] });
    await storage.discardParked(await loaded(dev, w.opId), NOW);
    expect(dev.dump('outbox')).toEqual([]);
    expect(dev.blob(B1)?.refcount).toBe(1);
  });
});
