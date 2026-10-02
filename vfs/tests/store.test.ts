import { INO, WELL_KNOWN_DIRS } from '@plotinium/protocol';
import type { BatchOp } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOf, contentOfText } from '../src/content.ts';
import { FaultHook, faultOpOf } from '../src/fault.ts';
import { checksumOf, fsck, applyRepair } from '../src/fsck/fsck.ts';
import { applyMkfs, clearTmpfs, mkfsPlan, seedUpgrade } from '../src/mkfs.ts';
import type { SeedEntry } from '../src/mkfs.ts';
import { planChmod, planChown } from '../src/ops/attr.ts';
import { planBatch } from '../src/ops/batch.ts';
import { prepareCommit } from '../src/ops/commit.ts';
import type { Commit } from '../src/ops/commit.ts';
import { forRemove } from '../src/ops/common.ts';
import { planCopy } from '../src/ops/copy.ts';
import { planMkdir } from '../src/ops/create.ts';
import { PlanBuilder } from '../src/ops/plan.ts';
import type { Plan } from '../src/ops/plan.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRemoveTree } from '../src/ops/unlink.ts';
import { planWriteFile } from '../src/ops/write.ts';
import { applyCommit, commitScope } from '../src/store/apply.ts';
import { IdbStore, openDevice, toVfsError } from '../src/store/idb-store.ts';
import { DirLoader } from '../src/store/load.ts';
import type {
  BlobRec,
  DentryRec,
  InodeRec,
  MetaRec,
  OutboxRec,
  UndoRec,
  UserRec,
} from '../src/store/records.ts';
import { STORES } from '../src/store/schema.ts';
import { dirBounds } from '../src/store/store.ts';
import type { AnyStoreName, KeyBounds, ReadStore, VfsTxnHook } from '../src/store/store.ts';
import { VfsTree } from '../src/tree/vfs-tree.ts';
import { VfsError } from '../src/errors.ts';
import type { FakeDatabase } from './doubles/fake-idb.ts';
import { FakeFactory, fakeEnv } from './doubles/fake-idb.ts';
import { createTreeDouble } from './doubles/tree.ts';
import { ALICE, ROOT as ROOT_CRED, World, ok, testIno } from './doubles/world.ts';

type ROOT = typeof ROOT_CRED;

const EPOCH = 7;

async function device(): Promise<{ store: IdbStore; db: FakeDatabase; factory: FakeFactory }> {
  const factory = new FakeFactory();
  const idb = await openDevice(factory as unknown as IDBFactory);
  const db = factory.databases.get('plotinium');
  if (db === undefined) throw new Error('no database');
  expect(idb as unknown).toBe(db);
  return { store: new IdbStore(idb, fakeEnv), db, factory };
}

/** A device whose store holds exactly the world's rows. */
async function seeded(w: World): Promise<{ store: IdbStore; db: FakeDatabase }> {
  const { store, db } = await device();
  const snap = w.tree.snapshot();
  await store.tx(STORES, 'strict', (t) => {
    for (const n of snap.inodes) t.put('inodes', n);
    for (const d of snap.dentries) t.put('dentries', d);
    for (const u of w.tree.users.values()) t.put('users', u);
    for (const b of w.blobs.values()) t.put('blobs', b);
    t.put('meta', { k: 'fencingEpoch', v: EPOCH });
    t.put('meta', { k: 'tmpfsUsage', v: w.tmpfs });
  });
  return { store, db };
}

function commitOf(
  w: World,
  cred: ROOT,
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

function rows(db: FakeDatabase): { inodes: InodeRec[]; dentries: DentryRec[] } {
  return { inodes: db.dump<InodeRec>('inodes'), dentries: db.dump<DentryRec>('dentries') };
}

async function errnoOfTx(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof VfsError
      ? `${e.errno}${e.detail === undefined ? '' : `:${e.detail}`}`
      : String(e);
  }
}

describe('schema and opening (PVFS-01)', () => {
  it('PVFS-01 migration 001 creates every store and index, dentries keyed by [parent, name]', async () => {
    const { db } = await device();
    expect(db.objectStoreNames).toEqual([...STORES].sort());
    expect(db.data('dentries').keyPath).toEqual(['parent', 'name']);
    expect([...db.data('dentries').indexes.keys()]).toEqual(['by_ino']);
    expect([...db.data('inodes').indexes.keys()]).toEqual(['by_uid_mtime', 'by_fs']);
    expect(db.data('outbox').autoIncrement).toBe(true);
    expect(db.data('outbox').indexes.get('by_op')?.unique).toBe(true);
    expect(db.data('users').indexes.get('by_name')?.unique).toBe(true);
    expect(db.version).toBe(1);
  });

  it('PVFS-01 a stored version newer than the code is EIO (the recovery screen)', async () => {
    const { factory } = await device();
    const db = factory.databases.get('plotinium');
    if (db !== undefined) db.version = 9;
    const r = await errnoOfTx(openDevice(factory as unknown as IDBFactory));
    expect(r).toBe('EIO:storage');
    expect(toVfsError(new DOMException('x', 'QuotaExceededError')).detail).toBe('device-full');
    expect(toVfsError(new DOMException('x', 'TransactionInactiveError')).detail).toBe('abort');
    expect(toVfsError(new VfsError('EPERM')).errno).toBe('EPERM');
  });
});

describe('one transaction per op (DB-02 client, OFF-02)', () => {
  it('OFF-02 every synced mutation writes rows, quota, blobs, undo and its outbox op in one transaction', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const c = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/n.txt', contentOfText('hello', 0)),
    );
    const r = await applyCommit(store, c, { epoch: EPOCH, now: 1 });
    expect(r.nodeOps).toBeGreaterThanOrEqual(2);
    w.commit(c.plan, c.outbox?.opId ?? '', ALICE.uid);
    const expected = w.tree.snapshot();
    const byIno = (a: InodeRec, b: InodeRec): number => (a.ino < b.ino ? -1 : 1);
    expect(rows(db).inodes.sort(byIno)).toEqual(expected.inodes.sort(byIno));
    expect(db.dump<UserRec>('users').find((u) => u.uid === ALICE.uid)).toEqual(w.user(ALICE.uid));
    const outbox = db.dump<OutboxRec>('outbox');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      opId: c.outbox?.opId,
      cseq: 1,
      lamport: 1,
      seq: 1,
      state: 'pending',
    });
    expect(db.dump<UndoRec>('undo')[0]?.opId).toBe(c.outbox?.opId);
    const blob = db.dump<BlobRec>('blobs').find((b) => b.sha === contentOfText('hello', 0).sha);
    expect(blob?.refcount).toBe(2); // the inode + the outbox pin
    expect(db.dump<MetaRec>('meta').find((m) => m.k === 'cseq')?.v).toBe(1);
    expect(db.durabilities.at(-1)).toBe('strict');
    const second = commitOf(w, ALICE, 'create', (b) => planMkdir(b, '/home/alice/d'));
    await applyCommit(store, second, { epoch: EPOCH, now: 2 });
    expect(db.dump<OutboxRec>('outbox').map((o) => o.cseq)).toEqual([1, 2]);
  });

  it('DB-04 client a duplicate [parent, name] add raises EEXIST and nothing is written', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const c = commitOf(w, ALICE, 'create', (b) => planMkdir(b, '/home/alice/x'));
    await store.tx(['dentries'], 'strict', (t) =>
      t.put('dentries', {
        parent: w.user(ALICE.uid).homeIno,
        name: 'x',
        ino: testIno(77),
        dtype: 'f',
      }),
    );
    const before = rows(db);
    expect(await errnoOfTx(applyCommit(store, c, { epoch: EPOCH, now: 1 }))).toBe('EEXIST');
    expect(rows(db)).toEqual(before);
    expect(db.dump<OutboxRec>('outbox')).toHaveLength(0);
  });

  it('PVFS-03 a stolen fencing epoch aborts the next readwrite transaction', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const before = rows(db);
    const c = commitOf(w, ALICE, 'create', (b) => planMkdir(b, '/home/alice/x'));
    expect(await errnoOfTx(applyCommit(store, c, { epoch: EPOCH + 1, now: 1 }))).toBe(
      'EIO:fencing',
    );
    expect(rows(db)).toEqual(before);
  });

  it('PVFS-03 a parent whose committed version moved aborts the plan with EAGAIN', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const c = commitOf(w, ALICE, 'create', (b) => planMkdir(b, '/home/alice/x'));
    const home = db.dump<InodeRec>('inodes').find((n) => n.ino === w.user(ALICE.uid).homeIno);
    await store.tx(['inodes'], 'strict', (t) => t.put('inodes', { ...home, version: 99 }));
    expect(await errnoOfTx(applyCommit(store, c, { epoch: EPOCH, now: 1 }))).toBe('EAGAIN');
  });

  it('VFS-06 two concurrent writes cannot both pass the quota check', async () => {
    const w = new World({ quotaBytes: 1000 });
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/x')));
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/y')));
    const { store, db } = await seeded(w);
    // Different parents, so only the quota rows are shared: IndexedDB serialises the two.
    const a = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/x/a', contentOf(new Uint8Array(600), 0)),
    );
    const b2 = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/y/b', contentOf(new Uint8Array(600).fill(1), 0)),
    );
    const results = await Promise.all([
      errnoOfTx(applyCommit(store, a, { epoch: EPOCH, now: 1 })),
      errnoOfTx(applyCommit(store, b2, { epoch: EPOCH, now: 1 })),
    ]);
    expect(results.sort()).toEqual(['EDQUOT', 'ok']);
    expect(db.dump<UserRec>('users').find((u) => u.uid === ALICE.uid)?.usedBytes).toBe(600);
  });

  it('VFS-06 QuotaExceededError from IndexedDB becomes EDQUOT with no partial data', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const before = rows(db);
    db.writeFault = (s) => (s === 'blob_chunks' ? 'QuotaExceededError' : null);
    const c = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/home/alice/n', contentOfText('bytes', 0)),
    );
    expect(await errnoOfTx(applyCommit(store, c, { epoch: EPOCH, now: 1 }))).toBe(
      'EDQUOT:device-full',
    );
    expect(rows(db)).toEqual(before);
    expect(db.dump<UserRec>('users')).toEqual(
      [...w.tree.users.values()].sort((x, y) => x.uid - y.uid),
    );
  });

  it('PVFS-10 tmpfs-only commits are relaxed, charge the tmpfs counters and write no outbox op', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const c = commitOf(w, ALICE, 'write', (b) =>
      planWriteFile(b, '/tmp/t', contentOfText('tmp!', 0)),
    );
    expect(c.outbox).toBeNull();
    expect(commitScope(c)).not.toContain('outbox');
    await applyCommit(store, c, { epoch: EPOCH, now: 1 });
    expect(db.durabilities.at(-1)).toBe('relaxed');
    expect(db.dump<MetaRec>('meta').find((m) => m.k === 'tmpfsUsage')?.v).toEqual({
      bytes: 4,
      inodes: 1,
    });
    expect(db.dump<OutboxRec>('outbox')).toHaveLength(0);
    const cleared = await clearTmpfs(store, 5);
    expect(cleared).toBe(1);
    expect(db.dump<InodeRec>('inodes').some((n) => n.fs === 'tmp')).toBe(false);
    expect(db.dump<DentryRec>('dentries').some((d) => d.parent === INO.TMP)).toBe(false);
    expect(db.dump<MetaRec>('meta').find((m) => m.k === 'tmpfsUsage')?.v).toEqual({
      bytes: 0,
      inodes: 0,
    });
    expect(
      db.dump<BlobRec>('blobs').find((b) => b.sha === contentOfText('tmp!', 0).sha),
    ).toMatchObject({ refcount: 0, zeroSince: 5 });
  });

  it('AGT-08 registered hooks write their rows in the same transaction', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const hook: VfsTxnHook = {
      name: 'audit',
      stores: () => ['bootlog'],
      build: (t, change) => t.put('bootlog', { bootId: change.opId, n: change.created.length }),
    };
    const c = commitOf(w, ALICE, 'create', (b) => planMkdir(b, '/home/alice/h'));
    const change = {
      opId: c.outbox?.opId ?? '',
      kind: 'create' as const,
      pid: 5,
      cred: ALICE,
      created: c.plan.created.inodes,
      changed: [],
      deleted: [],
    };
    await applyCommit(store, c, { epoch: EPOCH, now: 1, hooks: [hook], change });
    expect(db.dump<{ bootId: string; n: number }>('bootlog')).toEqual([
      { bootId: c.outbox?.opId, n: 1 },
    ]);
  });
});

describe('client fault hook (DB-02, PVFS-08)', () => {
  function bigTree(): World {
    const w = new World({ quotaInodes: 5000 });
    const ops: BatchOp[] = [];
    for (let d = 0; d < 10; d++) {
      ops.push({ op: 'mkdir', path: `/home/alice/tree1000/d${d}`, parents: true });
      for (let f = 0; f < 99; f++)
        ops.push({ op: 'write', path: `/home/alice/tree1000/d${d}/f${f}`, text: `${d}-${f}` });
    }
    ok(w.run(ALICE, 'batch', (b) => planBatch(b, ops)));
    return w;
  }

  it('DB-02 client rm -r of 1,000 nodes aborted at the 500th inode write leaves checksum, orphan probes and quota unchanged', async () => {
    const w = bigTree();
    const { store, db } = await seeded(w);
    const sumBefore = checksumOf(rows(db));
    const usersBefore = db.dump<UserRec>('users');
    const c = commitOf(w, ALICE, 'unlink', (b) =>
      planRemoveTree(b, forRemove(b, '/home/alice/tree1000')),
    );
    expect(c.plan.nodeOps).toBe(1002);
    const hook = new FaultHook();
    hook.armFor('unlink', 500, 0);
    expect(
      await errnoOfTx(
        applyCommit(store, c, { epoch: EPOCH, now: 1, fault: hook.take('unlink', 1) }),
      ),
    ).toBe('EIO:injected');
    expect(hook.armed).toBe(false);
    expect(checksumOf(rows(db))).toBe(sumBefore);
    expect(db.dump<UserRec>('users')).toEqual(usersBefore);
    expect(
      fsck({ ...rows(db), users: db.dump<UserRec>('users') }, { complete: true }).report.exitCode,
    ).toBe(0);
    // Positive check: the same op without the fault changes exactly the expected rows.
    const done = await applyCommit(store, c, { epoch: EPOCH, now: 2 });
    expect(done.nodeOps).toBe(1002);
    expect(checksumOf(rows(db))).not.toBe(sumBefore);
    const alice = db.dump<UserRec>('users').find((u) => u.uid === ALICE.uid);
    expect(alice?.usedInodes).toBe(w.user(ALICE.uid).usedInodes - 1001);
    expect(
      fsck({ ...rows(db), users: db.dump<UserRec>('users') }, { complete: true }).report.exitCode,
    ).toBe(0);
  });

  it('DB-02 client mv aborted at its first inode write leaves the tree unchanged', async () => {
    const w = bigTree();
    const { store, db } = await seeded(w);
    const before = rows(db);
    const c = commitOf(w, ALICE, 'rename', (b) =>
      planRename(b, '/home/alice/tree1000/d1', '/home/alice/moved'),
    );
    expect(c.plan.nodeOps).toBe(3);
    expect(
      await errnoOfTx(applyCommit(store, c, { epoch: EPOCH, now: 1, fault: { after: 1 } })),
    ).toBe('EIO:injected');
    expect(rows(db)).toEqual(before);
  });

  it('DB-02 client cp -r, batch rename, chmod -R and chown -R aborted mid-way leave the tree unchanged', async () => {
    const w = bigTree();
    const { store, db } = await seeded(w);
    const renames: BatchOp[] = Array.from({ length: 500 }, (_, i) => ({
      op: 'rename',
      from: `/home/alice/tree1000/d${i % 10}/f${Math.floor(i / 10)}`,
      to: `/home/alice/tree1000/d${i % 10}/r${Math.floor(i / 10)}`,
    }));
    const cases: [string, Commit, number][] = [
      [
        'cp -r',
        commitOf(w, ALICE, 'copy', (b) =>
          planCopy(b, '/home/alice/tree1000', '/home/alice/copy', { recursive: true }),
        ),
        500,
      ],
      ['batch rename', commitOf(w, ALICE, 'batch', (b) => planBatch(b, renames)), 3],
      [
        'chmod -R',
        commitOf(w, ALICE, 'chmod', (b) =>
          planChmod(b, '/home/alice/tree1000', { kind: 'octal', bits: 0o700 }, true),
        ),
        500,
      ],
      [
        'chown -R',
        commitOf(w, ROOT_CRED, 'chown', (b) =>
          planChown(b, '/home/alice/tree1000', { uid: 1001, recursive: true }),
        ),
        500,
      ],
    ];
    const before = {
      ...rows(db),
      users: db.dump<UserRec>('users'),
      blobs: db.dump<BlobRec>('blobs'),
    };
    for (const [name, c, n] of cases) {
      expect(c.plan.nodeOps, name).toBeGreaterThanOrEqual(n);
      expect(
        await errnoOfTx(applyCommit(store, c, { epoch: EPOCH, now: 1, fault: { after: n } })),
        name,
      ).toBe('EIO:injected');
      expect(
        { ...rows(db), users: db.dump<UserRec>('users'), blobs: db.dump<BlobRec>('blobs') },
        name,
      ).toEqual(before);
    }
    // AGT-05: 500 renames are one plan, one transaction and ONE outbox op of kind batch.
    const batch = cases[1]?.[1];
    expect(batch?.plan.wire?.op.kind === 'batch' && batch.plan.wire.op.ops.length).toBe(500);
    if (batch === undefined) throw new Error('no batch');
    await applyCommit(store, batch, { epoch: EPOCH, now: 2 });
    expect(db.dump<OutboxRec>('outbox')).toHaveLength(1);
    expect(
      fsck({ ...rows(db), users: db.dump<UserRec>('users') }, { complete: true }).report.exitCode,
    ).toBe(0);
  });

  it('DB-02 client a fault beyond the node count is not reached and the op commits', async () => {
    const w = new World();
    const { store } = await seeded(w);
    const c = commitOf(w, ALICE, 'rename', (b) => planMkdir(b, '/home/alice/q'));
    const r = await applyCommit(store, c, { epoch: EPOCH, now: 1, fault: { after: 50 } });
    expect(r.faultNotReached).toBe(true);
  });

  it('DB-02 client the fault arm is one-shot, matches its op and expires after 10 minutes', () => {
    const h = new FaultHook();
    h.armFor('copy', 3, 0);
    expect(h.take('unlink', 1)).toBeUndefined();
    expect(h.take('copy', 1)).toEqual({ after: 3 });
    expect(h.take('copy', 1)).toBeUndefined();
    h.armFor('chmod', 2, 0);
    expect(h.take('chmod', 600_001)).toBeUndefined();
    expect(h.armed).toBe(false);
    expect(() => h.armFor('chmod', 0, 0)).toThrow(RangeError);
    expect(faultOpOf('rm')).toBe('unlink');
    expect(faultOpOf('mv')).toBe('rename');
    expect(faultOpOf('ls')).toBeUndefined();
  });
});

describe('reads, scans and lazy loading (PVFS-14, VFS-01)', () => {
  it('PVFS-14 scans read at most 500 keys per transaction and cover the whole range', async () => {
    const { store, db } = await device();
    const dir = testIno(5);
    await store.tx(['dentries'], 'relaxed', (t) => {
      for (let i = 0; i < 1203; i++)
        t.put('dentries', {
          parent: dir,
          name: `n${String(i).padStart(4, '0')}`,
          ino: testIno(1000 + i),
          dtype: 'f',
        });
      t.put('dentries', { parent: testIno(6), name: 'other', ino: testIno(9), dtype: 'f' });
    });
    const txBefore = db.durabilities.length;
    const seen: DentryRec[] = [];
    await store.scan<DentryRec>('dentries', dirBounds(dir), (d) => seen.push(d));
    expect(seen).toHaveLength(1203);
    expect(db.durabilities.length - txBefore).toBe(3);
    const all: DentryRec[] = [];
    await store.scan<DentryRec>('dentries', null, (d) => all.push(d), { chunk: 1000 });
    expect(all).toHaveLength(1204);
    const many = await store.getMany<DentryRec>('dentries', [
      [dir, 'n0000'],
      [dir, 'zz'],
      [dir, 'n1202'],
    ]);
    expect(many.map((d) => d?.name)).toEqual(['n0000', undefined, 'n1202']);
    expect(await store.getByIndex<DentryRec>('dentries', 'by_ino', testIno(9))).toHaveLength(1);
    expect((await store.get<DentryRec>('dentries', [dir, 'n0001']))?.ino).toBe(testIno(1001));
  });

  it('VFS-01 a directory loads lazily, once, however many callers ask at the same time', async () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/a/b', undefined, true)));
    const { store } = await seeded(w);
    const rootRec = w.tree.inode(INO.ROOT);
    if (rootRec === undefined) throw new Error('root');
    const fresh = new VfsTree(createTreeDouble(INO.ROOT, rootRec));
    const events: string[] = [];
    let scans = 0;
    const counting: ReadStore = {
      get: <T>(s: AnyStoreName, k: IDBValidKey) => store.get<T>(s, k),
      getMany: <T>(s: AnyStoreName, k: readonly IDBValidKey[]) => store.getMany<T>(s, k),
      getByIndex: <T>(s: AnyStoreName, i: string, k: IDBValidKey) => store.getByIndex<T>(s, i, k),
      scan: <T>(
        s: AnyStoreName,
        bounds: KeyBounds | null,
        each: (v: T) => void,
        o?: { chunk?: number },
      ) => {
        scans++;
        return store.scan<T>(s, bounds, each, o);
      },
    };
    const loader = new DirLoader(counting, fresh, {
      onLoaded: (e) => events.push(e.topic),
      now: () => 1,
    });
    await Promise.all([loader.ensureLoaded(INO.ROOT), loader.ensureLoaded(INO.ROOT)]);
    expect(scans).toBe(1);
    expect(fresh.child(INO.ROOT, 'home')).not.toBeNull();
    await loader.ensureLoadedSubtree(INO.HOME);
    const alice = fresh.child(w.user(ALICE.uid).homeIno ?? '', 'a');
    expect(typeof alice === 'object' && alice?.type).toBe('d');
    expect(events.every((t) => t === 'vfs.load')).toBe(true);
    await loader.ensureLoaded(INO.SYSTEM);
    expect(fresh.child(INO.SYSTEM, 'release')).toMatchObject({ ino: INO.SYSTEM_RELEASE });
  });
});

describe('mkfs (VFS-02)', () => {
  it('VFS-02 mkfs creates the standard hierarchy with the specified owners and modes, once, with no outbox op', async () => {
    const { store, db } = await device();
    const seed: SeedEntry[] = [
      {
        path: '/usr/share/man/1',
        ino: testIno(0x1000),
        type: 'd',
        mode: 0o755,
        uid: 0,
        gid: 0,
        sha256: null,
        size: 0,
        seedVersion: 1,
        priorSha256: [],
      },
      {
        path: '/usr/share/man/1/ls.md',
        ino: testIno(0x1001),
        type: 'f',
        mode: 0o644,
        uid: 0,
        gid: 0,
        sha256: 'a'.repeat(64),
        size: 3,
        seedVersion: 2,
        priorSha256: ['b'.repeat(64)],
        chunks: ['c'.repeat(64)],
      },
    ];
    const plan = mkfsPlan({ buildTime: 42, deviceId: testIno(3), seed, seedHash: 'd'.repeat(64) });
    expect(await applyMkfs(store, plan)).toBe(true);
    expect(await applyMkfs(store, plan)).toBe(false);
    const inodes = db.dump<InodeRec>('inodes');
    for (const d of WELL_KNOWN_DIRS) {
      const n = inodes.find((x) => x.ino === d.ino);
      expect(n, d.path).toMatchObject({
        type: 'd',
        mode: d.mode,
        uid: 0,
        gid: 0,
        version: 1,
        mtime: 42,
      });
    }
    expect(inodes.find((x) => x.ino === INO.ROOT)?.nlink).toBe(2 + 8);
    expect(inodes.find((x) => x.ino === INO.HOME)?.mir).toBe(0);
    expect(inodes.find((x) => x.ino === testIno(0x1001))).toMatchObject({
      version: 2,
      blob: 'a'.repeat(64),
    });
    expect(db.dump<OutboxRec>('outbox')).toHaveLength(0);
    expect(db.dump<MetaRec>('meta').find((m) => m.k === 'mkfsDone')?.v).toBe(true);
    const report = fsck(
      {
        inodes,
        dentries: db.dump<DentryRec>('dentries'),
        users: db.dump<UserRec>('users'),
        blobs: db.dump<BlobRec>('blobs'),
      },
      { complete: true },
    );
    expect(report.report.invariants.filter((i) => !i.ok)).toEqual([]);
    const up = seedUpgrade(
      (ino) => inodes.find((x) => x.ino === ino),
      [
        {
          ...seed[1],
          seedVersion: 3,
          sha256: 'e'.repeat(64),
          priorSha256: ['a'.repeat(64)],
        } as SeedEntry,
        { ...seed[1], ino: testIno(0x1002), path: '/usr/share/man/1/cp.md' } as SeedEntry,
      ],
    );
    expect(up.replace).toHaveLength(1);
    expect(up.create).toHaveLength(1);
    const kept = seedUpgrade(
      (ino) => inodes.find((x) => x.ino === ino),
      [{ ...seed[1], seedVersion: 3, priorSha256: [] } as SeedEntry],
    );
    expect(kept.kept).toEqual(['seed: kept local edit of /usr/share/man/1/ls.md']);
    expect(() =>
      mkfsPlan({
        buildTime: 0,
        deviceId: testIno(3),
        seed: [{ ...seed[1], path: '/nope/x' } as SeedEntry],
      }),
    ).toThrow('no parent');
  });

  it('VFS-11 fsck --repair writes its diff in one local transaction', async () => {
    const w = new World();
    const { store, db } = await seeded(w);
    const home = w.user(ALICE.uid).homeIno ?? '';
    await store.tx(['dentries'], 'strict', (t) => t.del('dentries', [INO.HOME, 'alice']));
    const broken = fsck(
      { ...rows(db), users: db.dump<UserRec>('users') },
      { repair: true, complete: true, now: 9 },
    );
    expect(broken.report.exitCode).toBe(2);
    if (broken.diff === null) throw new Error('no diff');
    await applyRepair(store, broken.diff);
    const again = fsck({ ...rows(db), users: db.dump<UserRec>('users') }, { complete: true });
    expect(again.report.exitCode).toBe(0);
    expect(db.dump<DentryRec>('dentries').find((d) => d.ino === home)?.parent).toBe(INO.LOST_FOUND);
    expect(db.dump<MetaRec>('meta').find((m) => m.k === 'fsckDirty')?.v).toBe(true);
  });
});
