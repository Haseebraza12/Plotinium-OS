/**
 * TEST-ONLY device: the product `IdbStore` over the vfs fake IndexedDB (vfs/tests/doubles), plus
 * seeding helpers for inodes, entries, users, blobs, undo and outbox records. The atomicity and
 * durability claims themselves are verified against real Chrome (C14); these tests check what the
 * transactions write.
 */
import { GID_USERS } from '@plotinium/protocol';
import type { Base, VfsOp } from '@plotinium/protocol';

import { IdbStore, openDevice } from '../../../store/idb-store.ts';
import type {
  BlobRec,
  DentryRec,
  InodeRec,
  OutboxRec,
  UndoRec,
  UserRec,
} from '../../../store/records.ts';
import { FakeFactory, fakeEnv } from '../../../../tests/doubles/fake-idb.ts';
import type { FakeDatabase } from '../../../../tests/doubles/fake-idb.ts';

/** Deterministic UUIDv7-shaped ids. */
export function tid(n: number): string {
  return `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A 64-hex sha for tests. */
export function sha(n: number): string {
  return n.toString(16).padStart(64, '0');
}

export const OS_SESSION = tid(0x5e55);
export const DEVICE = tid(0xde71ce);
export const HOME = { alice: tid(0xa11ce), bob: tid(0xb0b) } as const;
export const ALICE = 1000;
export const BOB = 1001;

export function dirRec(ino: string, uid: number, over: Partial<InodeRec> = {}): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'd',
    mode: 0o755,
    uid,
    gid: GID_USERS,
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
  };
}

export function fileRec(ino: string, uid: number, over: Partial<InodeRec> = {}): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'f',
    mode: 0o644,
    uid,
    gid: GID_USERS,
    size: 0,
    nlink: 1,
    version: 1,
    atime: 0,
    mtime: 0,
    ctime: 0,
    btime: 0,
    blob: null,
    target: null,
    ...over,
  };
}

export function userRec(
  uid: number,
  username: string,
  homeIno: string,
  over: Partial<UserRec> = {},
): UserRec {
  return {
    uid,
    username,
    gid: GID_USERS,
    groups: [GID_USERS],
    kind: 'user',
    quotaBytes: 1_000_000,
    quotaInodes: 1_000,
    serverUsedBytes: 0,
    serverUsedInodes: 0,
    usedBytes: 0,
    usedInodes: 0,
    homeIno,
    ...over,
  };
}

export function blobRec(s: string, refcount: number, size = 10): BlobRec {
  return { sha: s, size, chunks: [], refcount, uploaded: false };
}

export interface RecOpts {
  readonly opId: string;
  readonly cseq: number;
  readonly op: VfsOp;
  readonly base?: Base;
  readonly touches: readonly string[];
  readonly blobs?: readonly string[];
  readonly principal?: number;
  readonly state?: OutboxRec['state'];
  readonly attempts?: number;
  readonly fence?: number;
}

export function outboxRec(o: RecOpts): OutboxRec {
  return {
    opId: o.opId,
    cseq: o.cseq,
    lamport: o.cseq,
    principal: o.principal ?? ALICE,
    osSessionId: OS_SESSION,
    call: o.op.kind === 'audit.append' || o.op.kind === 'session.layout' ? 'batch' : o.op.kind,
    op: o.op,
    base: o.base ?? { kind: 'versions', entries: [] },
    blobs: [...(o.blobs ?? [])],
    touches: [...o.touches],
    ...(o.fence === undefined ? {} : { fence: o.fence }),
    awaitSync: false,
    state: o.state ?? 'pending',
    attempts: o.attempts ?? 0,
    createdAt: 1_800_000_000_000 + o.cseq,
  };
}

export function undoRec(opId: string, over: Partial<UndoRec> = {}): UndoRec {
  return {
    opId,
    state: 'open',
    pre: { inodes: [], dentries: [] },
    created: { inodes: [], dentries: [] },
    users: [],
    pins: [],
    keepAfterAck: false,
    summary: 'test',
    createdAt: 0,
    ...over,
  };
}

export interface Seed {
  readonly inodes?: readonly InodeRec[];
  readonly dentries?: readonly DentryRec[];
  readonly users?: readonly UserRec[];
  readonly blobs?: readonly BlobRec[];
  readonly undo?: readonly UndoRec[];
  readonly outbox?: readonly OutboxRec[];
  readonly meta?: readonly { k: string; v: unknown }[];
}

export class Device {
  readonly store: IdbStore;
  readonly db: FakeDatabase;

  private constructor(store: IdbStore, db: FakeDatabase) {
    this.store = store;
    this.db = db;
  }

  static async open(): Promise<Device> {
    const factory = new FakeFactory();
    const idb = await openDevice(factory as unknown as IDBFactory);
    const db = factory.databases.get('plotinium');
    if (db === undefined) throw new Error('no database');
    return new Device(new IdbStore(idb, fakeEnv), db);
  }

  async seed(s: Seed): Promise<void> {
    await this.store.tx(
      ['inodes', 'dentries', 'users', 'blobs', 'undo', 'outbox', 'meta'],
      'strict',
      (t) => {
        for (const r of s.inodes ?? []) t.put('inodes', r);
        for (const d of s.dentries ?? []) t.put('dentries', d);
        for (const u of s.users ?? []) t.put('users', u);
        for (const b of s.blobs ?? []) t.put('blobs', b);
        for (const u of s.undo ?? []) t.put('undo', u);
        for (const r of s.outbox ?? []) t.add('outbox', r);
        for (const m of s.meta ?? []) t.put('meta', m);
      },
    );
  }

  dump<T>(store: string): T[] {
    return this.db.dump<T>(store);
  }

  inode(ino: string): InodeRec | undefined {
    return this.dump<InodeRec>('inodes').find((r) => r.ino === ino);
  }

  entry(parent: string, name: string): DentryRec | undefined {
    return this.dump<DentryRec>('dentries').find((d) => d.parent === parent && d.name === name);
  }

  entriesOf(parent: string): DentryRec[] {
    return this.dump<DentryRec>('dentries').filter((d) => d.parent === parent);
  }

  blob(s: string): BlobRec | undefined {
    return this.dump<BlobRec>('blobs').find((b) => b.sha === s);
  }

  meta(k: string): unknown {
    return this.dump<{ k: string; v: unknown }>('meta').find((m) => m.k === k)?.v;
  }
}

/** alice and bob with homes under a mirrored root, as most tests need. */
export function baseSeed(): Seed {
  const root = tid(1);
  return {
    inodes: [
      dirRec(root, 0, { nlink: 4 }),
      dirRec(HOME.alice, ALICE, { mode: 0o700 }),
      dirRec(HOME.bob, BOB, { mode: 0o700 }),
    ],
    dentries: [
      { parent: root, name: 'alice', ino: HOME.alice, dtype: 'd' },
      { parent: root, name: 'bob', ino: HOME.bob, dtype: 'd' },
    ],
    users: [userRec(ALICE, 'alice', HOME.alice), userRec(BOB, 'bob', HOME.bob)],
  };
}
