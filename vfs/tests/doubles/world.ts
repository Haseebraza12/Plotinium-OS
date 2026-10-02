/**
 * TEST-ONLY fixture: an mkfs'd tree on the dsa/tree double, three users with homes, and an
 * in-memory stand-in for phase 2 (quota check, users rows, blob refcounts, undo and outbox records,
 * then `VfsTree.apply`) so planner tests can run whole ops without IndexedDB.
 */
import { GID_USERS, INO } from '@plotinium/protocol';

import { VfsError, attempt } from '../../src/errors.ts';
import type { Outcome } from '../../src/errors.ts';
import type { FsckInput } from '../../src/fsck/state.ts';
import { mkfsPlan } from '../../src/mkfs.ts';
import { prepareCommit, quotaCheck } from '../../src/ops/commit.ts';
import type { OutboxDraft } from '../../src/ops/commit.ts';
import { PlanBuilder } from '../../src/ops/plan.ts';
import type { OpCtx, Plan } from '../../src/ops/plan.ts';
import type { Cred } from '../../src/perm.ts';
import { applyDelta } from '../../src/quota/quota.ts';
import type {
  BlobRec,
  DentryRec,
  InodeRec,
  OpKind,
  TmpfsUsage,
  UndoRec,
  UserRec,
  Uuid,
} from '../../src/store/records.ts';
import { VfsTree } from '../../src/tree/vfs-tree.ts';
import { createTreeDouble } from './tree.ts';

export const ROOT: Cred = { uid: 0, gid: 0, groups: [0] };
export const ALICE: Cred = { uid: 1000, gid: GID_USERS, groups: [GID_USERS, 200] };
export const BOB: Cred = { uid: 1001, gid: GID_USERS, groups: [GID_USERS] };
export const CAROL: Cred = { uid: 1002, gid: 300, groups: [300] };

const NAMES: Record<number, string> = { 0: 'root', 1000: 'alice', 1001: 'bob', 1002: 'carol' };

/** Deterministic UUIDv7-shaped ids, sorted after the well-known ones. */
export function testIno(n: number): Uuid {
  return `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const HOME = {
  alice: testIno(0xa11ce),
  bob: testIno(0xb0b),
  carol: testIno(0xca401),
  shared: testIno(0x5a4ed),
};

export interface WorldOpts {
  readonly quotaBytes?: number;
  readonly quotaInodes?: number;
}

function dir(ino: Uuid, uid: number, gid: number, mode: number): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'd',
    mode,
    uid,
    gid,
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
  };
}

export class World {
  readonly tree: VfsTree;
  readonly undo: UndoRec[] = [];
  readonly outbox: OutboxDraft[] = [];
  readonly blobs = new Map<string, BlobRec>();
  tmpfs: TmpfsUsage = { bytes: 0, inodes: 0 };
  clock = 1_800_000_000_000;
  private seq = 1;

  constructor(opts: WorldOpts = {}) {
    const mk = mkfsPlan({ buildTime: 0, deviceId: testIno(1) });
    const inodes = new Map<Uuid, InodeRec>(mk.inodes.map((r) => [r.ino, { ...r, mir: 1 }]));
    const dentries: DentryRec[] = [...mk.dentries];
    const homes: [string, Uuid, Cred, number][] = [
      ['alice', HOME.alice, ALICE, 0o700],
      ['bob', HOME.bob, BOB, 0o700],
      ['carol', HOME.carol, CAROL, 0o755],
      ['shared', HOME.shared, { uid: 1000, gid: 200, groups: [200] }, 0o770],
    ];
    for (const [name, ino, cred, mode] of homes) {
      inodes.set(ino, dir(ino, cred.uid, cred.gid, mode));
      dentries.push({ parent: INO.HOME, name, ino, dtype: 'd' });
    }
    const home = inodes.get(INO.HOME);
    if (home !== undefined) inodes.set(INO.HOME, { ...home, nlink: home.nlink + homes.length });
    const root = inodes.get(INO.ROOT);
    if (root === undefined) throw new Error('no root');
    this.tree = new VfsTree(createTreeDouble(INO.ROOT, root));
    this.tree.online = true;
    const byParent = new Map<Uuid, DentryRec[]>();
    for (const d of dentries) byParent.set(d.parent, [...(byParent.get(d.parent) ?? []), d]);
    const queue = [INO.ROOT];
    while (queue.length > 0) {
      const d = queue.shift() as Uuid;
      const ents = byParent.get(d) ?? [];
      this.tree.load(
        d,
        ents,
        ents.map((e) => inodes.get(e.ino)),
      );
      for (const e of ents) if (e.dtype === 'd') queue.push(e.ino);
    }
    const qb = opts.quotaBytes ?? 1_000_000;
    const qi = opts.quotaInodes ?? 1_000;
    for (const u of mk.users) this.tree.users.set(u.uid, u);
    for (const [name, ino, cred] of homes) {
      if (name === 'shared') continue;
      this.tree.users.set(cred.uid, {
        uid: cred.uid,
        username: name,
        gid: cred.gid,
        groups: [...cred.groups],
        kind: 'user',
        quotaBytes: qb,
        quotaInodes: qi,
        serverUsedBytes: 0,
        serverUsedInodes: cred.uid === 1000 ? 2 : 1,
        usedBytes: 0,
        usedInodes: cred.uid === 1000 ? 2 : 1,
        homeIno: ino,
      });
    }
  }

  newIno = (): Uuid => testIno(0x100000 + this.seq++);

  ctx(cred: Cred, over: Partial<OpCtx> = {}): OpCtx {
    return {
      cred,
      cwd: INO.ROOT,
      umask: 0o022,
      now: ++this.clock,
      opId: testIno(0x900000 + this.seq++),
      newIno: this.newIno,
      username: (uid) => NAMES[uid] ?? String(uid),
      date: '2026-11-14',
      ...over,
    };
  }

  /** Plan only (nothing committed). */
  plan<T>(
    cred: Cred,
    call: OpKind,
    fn: (b: PlanBuilder) => T,
    over: Partial<OpCtx> = {},
  ): { plan: Plan; value: T } {
    const b = new PlanBuilder(this.tree, this.ctx(cred, over));
    const value = fn(b);
    return { plan: b.build(call, call), value };
  }

  /** Plan and commit, as the kernel would; errors come back as values. */
  run<T>(
    cred: Cred,
    call: OpKind,
    fn: (b: PlanBuilder) => T,
    over: Partial<OpCtx> = {},
  ): Outcome<T> {
    return attempt(() => {
      const ctx = this.ctx(cred, over);
      const b = new PlanBuilder(this.tree, ctx);
      const value = fn(b);
      this.commit(b.build(call, call), ctx.opId, cred.uid);
      return value;
    });
  }

  /** The in-memory phase 2: all or nothing. */
  commit(plan: Plan, opId: Uuid, principal: number): void {
    const q = quotaCheck(plan, (uid) => this.tree.user(uid), this.tmpfs);
    if (q !== null) throw new VfsError(q);
    const c = prepareCommit(plan, {
      opId,
      osSessionId: testIno(2),
      principal,
      now: this.clock,
      awaitSync: false,
    });
    if (plan.synced) {
      for (const d of plan.quota) {
        const u = this.tree.user(d.uid);
        if (u !== undefined) this.tree.users.set(d.uid, applyDelta(u, d));
      }
    }
    this.tmpfs = {
      bytes: this.tmpfs.bytes + plan.tmpfs.bytes,
      inodes: this.tmpfs.inodes + plan.tmpfs.inodes,
    };
    for (const u of plan.blobs) {
      const cur = this.blobs.get(u.sha) ?? u.record;
      if (cur === undefined) throw new Error(`no blob ${u.sha}`);
      this.blobs.set(u.sha, { ...cur, refcount: cur.refcount + u.delta });
    }
    this.tree.apply(plan.writes);
    if (c.undo !== null) this.undo.push(c.undo);
    if (c.outbox !== null) this.outbox.push(c.outbox);
  }

  user(uid: number): UserRec {
    const u = this.tree.user(uid);
    if (u === undefined) throw new Error(`no user ${uid}`);
    return u;
  }

  fsckInput(): FsckInput {
    const snap = this.tree.snapshot();
    return {
      ...snap,
      users: [...this.tree.users.values()],
      blobs: [...this.blobs.values()],
      undo: this.undo,
      outbox: this.outbox.map((o, i) => ({ ...o, cseq: i + 1, lamport: i + 1 })),
      tmpfsUsage: this.tmpfs,
    };
  }
}

/** Unwrap an Outcome in tests. */
export function ok<T>(o: Outcome<T>): T {
  if (o.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.value;
}

/** The errno of a failed Outcome (or 'ok'). */
export function errnoOf(o: Outcome<unknown>): string {
  return o.ok === true ? 'ok' : o.ok === 'load' ? 'load' : o.errno;
}
