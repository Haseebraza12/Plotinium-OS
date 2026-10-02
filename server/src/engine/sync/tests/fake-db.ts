/**
 * TEST-ONLY fake transaction layer for the sync engine (OFF-02 exactly-once, VFS-09, VFS-10).
 *
 * One in-memory "database" with copy-on-write transactions: `begin` clones the committed state,
 * runs the body against the clone and swaps it in on success (rollback = drop the clone). It
 * implements every port the engine uses (vfsTxn's TxSteps, the feed statement, the content-write
 * SQL, the feed reader, the directory context and the OS-session registry) with the semantics that
 * matter for the proofs: op_log's primary key (L0), gap-free per-owner feed numbers, the quota
 * CHECK, blob refcounts, lock rows and the dentries primary key.
 *
 * Fault hooks model the §8 property test: a transient failure before COMMIT (nothing persists), a
 * "server killed after COMMIT" (the commit stays, the reply is lost) and serialization failures.
 */
import type { Errno, OpSubmit } from '@plotinium/protocol';

import type { TxSteps } from '../../../vfs/tx.ts';
import type {
  ArmedFault,
  BodyResult,
  InodeRow,
  Ino,
  OpContext,
  StoredOp,
  Uid,
  VfsError,
} from '../../../vfs/types.ts';
import type { LeaseState } from '../../locks/fencing.ts';
import type {
  ContentSql,
  DirStamp,
  FileContent,
  Location,
  NewFile,
  PermRow,
  Stamp,
} from '../content-write.ts';
import type { FeedReader, FeedRow, OwnerHead } from '../feed.ts';
import type { OsSessionStore } from '../feed-reader.ts';
import type { FeedSql, FeedWrite } from '../feed-steps.ts';
import type { DirContext, DirContextSource, DirNode } from '../visibility.ts';

export interface OpLogRow {
  opId: string;
  uid: number;
  osSessionId: string;
  cseq: number;
  lamport: number;
  call: string;
  status: 'pending' | 'applied' | 'conflict' | 'rejected';
  errno: Errno | null;
  result: unknown;
  effects: unknown;
}

export interface UserRow {
  uid: number;
  username: string;
  primaryGid: number;
  groups: number[];
  feedSeq: number;
  purgedSeq: number;
  usedBytes: number;
  usedInodes: number;
  quotaBytes: number;
}

export interface FakeInode {
  ino: string;
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  version: number;
  blobId: number | null;
  lockFence: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface FakeDentry {
  parentIno: string;
  name: string;
  ino: string;
  type: 'f' | 'd' | 'l';
}

export interface FakeBlob {
  blobId: number;
  sha: string;
  size: number;
  refcount: number;
}

export interface FakeFeedRow {
  ownerUid: number;
  seq: number;
  opId: string;
  committedAt: number;
}

export interface FakeLock {
  ino: string;
  osSessionId: string;
  mode: 'S' | 'X';
  fence: number;
  expiresAt: number;
}

export interface State {
  opLog: Map<string, OpLogRow>;
  users: Map<number, UserRow>;
  inodes: Map<string, FakeInode>;
  dentries: Map<string, FakeDentry>;
  blobs: Map<string, FakeBlob>;
  feed: FakeFeedRow[];
  locks: FakeLock[];
  osSessions: Map<string, { ownerUid: number; deviceId: string | null }>;
}

export interface FakeTx {
  readonly s: State;
  readonly attempt: number;
}

const key = (parent: string, name: string): string => `${parent}\u0000${name}`;

export function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg ${code}`), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

function emptyState(): State {
  return {
    opLog: new Map(),
    users: new Map(),
    inodes: new Map(),
    dentries: new Map(),
    blobs: new Map(),
    feed: [],
    locks: [],
    osSessions: new Map(),
  };
}

export class FakeDb {
  state: State = emptyState();
  now: number;
  attempts = 0;
  #nextBlob = 1;
  /** Called at BEGIN with the attempt number; a returned error aborts the attempt before COMMIT. */
  failBegin: ((attempt: number, opId: string | null) => Error | null) | null = null;
  /** Called after a successful COMMIT; a returned error is thrown (the reply is lost). */
  failAfterCommit: ((opId: string | null) => Error | null) | null = null;
  /** recordRejection fails (database gone after the rollback). */
  failRecord = false;
  #currentOp: string | null = null;

  constructor(now = Date.UTC(2026, 10, 14, 6, 0, 0)) {
    this.now = now;
  }

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  addUser(
    uid: number,
    username: string,
    opts: { quotaBytes?: number; groups?: number[] } = {},
  ): void {
    this.state.users.set(uid, {
      uid,
      username,
      primaryGid: uid,
      groups: opts.groups ?? [],
      feedSeq: 0,
      purgedSeq: 0,
      usedBytes: 0,
      usedInodes: 0,
      quotaBytes: opts.quotaBytes ?? 1_000_000_000,
    });
  }

  addDir(ino: string, parent: string | null, name: string, uid: number, mode = 0o755): void {
    this.state.inodes.set(ino, {
      ino,
      type: 'd',
      mode,
      uid,
      gid: uid,
      size: 0,
      nlink: 2,
      version: 1,
      blobId: null,
      lockFence: 0,
      mtimeMs: this.now,
      ctimeMs: this.now,
    });
    if (parent !== null)
      this.state.dentries.set(key(parent, name), { parentIno: parent, name, ino, type: 'd' });
  }

  addFile(
    ino: string,
    parent: string,
    name: string,
    uid: number,
    opts: { mode?: number; sha?: string; size?: number } = {},
  ): void {
    const blob = opts.sha === undefined ? null : this.addBlob(opts.sha, opts.size ?? 0, 1);
    this.state.inodes.set(ino, {
      ino,
      type: 'f',
      mode: opts.mode ?? 0o644,
      uid,
      gid: uid,
      size: opts.size ?? 0,
      nlink: 1,
      version: 1,
      blobId: blob,
      lockFence: 0,
      mtimeMs: this.now,
      ctimeMs: this.now,
    });
    this.state.dentries.set(key(parent, name), { parentIno: parent, name, ino, type: 'f' });
    const u = this.state.users.get(uid);
    if (u !== undefined) {
      u.usedBytes += opts.size ?? 0;
      u.usedInodes += 1;
    }
  }

  addBlob(sha: string, size: number, refcount = 0): number {
    const existing = this.state.blobs.get(sha);
    if (existing !== undefined) {
      existing.refcount += refcount;
      return existing.blobId;
    }
    const blobId = this.#nextBlob++;
    this.state.blobs.set(sha, { blobId, sha, size, refcount });
    return blobId;
  }

  addSession(osSessionId: string, ownerUid: number, deviceId: string | null = null): void {
    this.state.osSessions.set(osSessionId, { ownerUid, deviceId });
  }

  addLock(l: FakeLock): void {
    this.state.locks.push(l);
    const inode = this.state.inodes.get(l.ino);
    if (inode !== undefined && l.mode === 'X') inode.lockFence = Math.max(inode.lockFence, l.fence);
  }

  inode(ino: string): FakeInode | undefined {
    return this.state.inodes.get(ino);
  }

  childrenOf(parent: string): FakeDentry[] {
    return [...this.state.dentries.values()].filter((d) => d.parentIno === parent);
  }

  // -------------------------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------------------------

  async #begin<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.attempts++;
    const failure = this.failBegin?.(this.attempts, this.#currentOp);
    if (failure !== undefined && failure !== null) throw failure;
    const tx: FakeTx = { s: structuredClone(this.state), attempt: this.attempts };
    const r = await fn(tx);
    this.state = tx.s; // COMMIT
    const after = this.failAfterCommit?.(this.#currentOp);
    if (after !== undefined && after !== null) throw after;
    return r;
  }

  readonly steps: TxSteps<FakeTx> = {
    begin: (fn) => this.#begin(fn),
    setLocalTimeouts: () => Promise.resolve(),
    backendPid: () => Promise.resolve(4242),
    insertOpLog: (tx, op: OpContext) => {
      this.#currentOp = op.opId;
      if (tx.s.opLog.has(op.opId)) return Promise.resolve(false);
      tx.s.opLog.set(op.opId, {
        opId: op.opId,
        uid: op.principal.uid,
        osSessionId: op.osSessionId,
        cseq: op.cseq,
        lamport: op.lamport,
        call: op.call,
        status: 'pending',
        errno: null,
        result: null,
        effects: null,
      });
      return Promise.resolve(true);
    },
    readStoredOp: (tx, opId) => Promise.resolve(stored(tx.s.opLog.get(opId))),
    lockUsers: () => Promise.resolve(),
    renameLock: () => Promise.resolve(),
    lockInodes: (tx, inos) =>
      Promise.resolve(
        inos.flatMap((ino): InodeRow[] => {
          const i = tx.s.inodes.get(ino);
          return i === undefined
            ? []
            : [
                {
                  ino: i.ino,
                  type: i.type,
                  mode: i.mode,
                  uid: i.uid,
                  gid: i.gid,
                  version: i.version,
                  lock_fence: i.lockFence,
                },
              ];
        }),
      ),
    armFault: (_tx, _f: ArmedFault) => Promise.resolve(),
    writeFeed: () => Promise.reject(new Error('the engine must use the capturing feed statement')),
    finishOpLog: (tx, opId, r: BodyResult<unknown>) => {
      const row = tx.s.opLog.get(opId);
      if (row === undefined) return Promise.reject(new Error('finish without L0'));
      row.status = r.status;
      row.errno = r.errno ?? null;
      row.result = r.result;
      row.effects = r.effects;
      return Promise.resolve();
    },
    recordRejection: (op, err: VfsError) => {
      if (this.failRecord) return Promise.reject(pgError('08006'));
      const existing = this.state.opLog.get(op.opId);
      if (existing !== undefined) return Promise.resolve(stored(existing));
      this.state.opLog.set(op.opId, {
        opId: op.opId,
        uid: op.principal.uid,
        osSessionId: op.osSessionId,
        cseq: op.cseq,
        lamport: op.lamport,
        call: op.call,
        status: 'rejected',
        errno: err.errno,
        result: { errno: err.errno, ...err.detail },
        effects: null,
      });
      return Promise.resolve(null);
    },
  };

  readonly feedSql: FeedSql<FakeTx> = {
    writeFeedReturning: (tx, owners: readonly Uid[], opId: string): Promise<FeedWrite> => {
      const cursors = [...owners]
        .sort((a, b) => a - b)
        .flatMap((uid) => {
          const u = tx.s.users.get(uid);
          if (u === undefined) return [];
          u.feedSeq += 1;
          tx.s.feed.push({ ownerUid: uid, seq: u.feedSeq, opId, committedAt: this.now });
          return [{ ownerUid: uid, seq: u.feedSeq }];
        });
      return Promise.resolve({ cursors, committedAt: this.now });
    },
  };

  readonly content: ContentSql<FakeTx> = {
    locate: (tx, ino): Promise<Location | null> => {
      const i = tx.s.inodes.get(ino);
      const d = [...tx.s.dentries.values()]
        .filter((x) => x.ino === ino)
        .sort((a, b) => (a.parentIno + a.name < b.parentIno + b.name ? -1 : 1))[0];
      const p = d === undefined ? undefined : tx.s.inodes.get(d.parentIno);
      if (i === undefined || d === undefined || p === undefined) return Promise.resolve(null);
      return Promise.resolve({
        owner: i.uid,
        parentIno: d.parentIno,
        name: d.name,
        parentOwner: p.uid,
      });
    },
    content: (tx, ino): Promise<FileContent | null> => {
      const i = tx.s.inodes.get(ino);
      return Promise.resolve(
        i === undefined ? null : { size: i.size, blobId: i.blobId, nlink: i.nlink },
      );
    },
    ancestors: (tx, dirIno): Promise<readonly PermRow[]> => {
      const out: PermRow[] = [];
      let cur: string | undefined = dirIno;
      for (let n = 0; cur !== undefined && n < 100; n++) {
        const i = tx.s.inodes.get(cur);
        if (i === undefined) break;
        out.push({ ino: i.ino, type: i.type, mode: i.mode, uid: i.uid, gid: i.gid });
        const at: string = cur;
        cur = [...tx.s.dentries.values()].find((d) => d.ino === at && d.type === 'd')?.parentIno;
      }
      return Promise.resolve(out);
    },
    credentials: (tx, uid) => {
      const u = tx.s.users.get(uid);
      return Promise.resolve(
        u === undefined
          ? null
          : { username: u.username, primaryGid: u.primaryGid, groups: u.groups },
      );
    },
    leasesOn: (tx, inos): Promise<readonly LeaseState[]> =>
      Promise.resolve(
        tx.s.locks
          .filter((l) => inos.includes(l.ino))
          .map((l) => ({
            ino: l.ino,
            osSessionId: l.osSessionId,
            mode: l.mode,
            fence: l.fence,
            live: l.expiresAt > this.now,
          })),
      ),
    homeOf: (tx, username) => {
      const home = tx.s.dentries.get(key(HOME, username));
      if (home === undefined) return Promise.resolve(null);
      const lf = tx.s.dentries.get(key(home.ino, 'lost+found'));
      return Promise.resolve({ homeIno: home.ino, lostFoundIno: lf?.ino ?? null });
    },
    txNow: () => Promise.resolve(this.now),
    takeBlob: (tx, sha) => {
      const b = tx.s.blobs.get(sha);
      if (b === undefined) return Promise.resolve(null);
      b.refcount += 1;
      return Promise.resolve({ blobId: b.blobId, size: b.size });
    },
    releaseBlob: (tx, blobId) => {
      for (const b of tx.s.blobs.values()) if (b.blobId === blobId) b.refcount -= 1;
      return Promise.resolve();
    },
    casWrite: (tx, a): Promise<Stamp | null> => {
      const i = tx.s.inodes.get(a.ino);
      if (i === undefined || i.version !== a.expectedVersion) return Promise.resolve(null);
      i.blobId = a.blobId;
      i.size = a.size;
      i.mtimeMs = a.mtimeMs;
      i.ctimeMs = this.now;
      i.version += 1;
      return Promise.resolve({ version: i.version, mtimeMs: i.mtimeMs, ctimeMs: i.ctimeMs });
    },
    addUsage: (tx, uid, bytes, inodes) => {
      const u = tx.s.users.get(uid);
      if (u === undefined) return Promise.reject(pgError('23503', 'inodes_uid_fk'));
      u.usedBytes += bytes;
      u.usedInodes += inodes;
      if (uid !== 0 && u.usedBytes > u.quotaBytes)
        return Promise.reject(pgError('23514', 'users_quota_bytes_ok'));
      return Promise.resolve();
    },
    insertFile: (tx, f: NewFile): Promise<Stamp> => {
      if (tx.s.inodes.has(f.ino)) return Promise.reject(pgError('23505', 'inodes_pkey'));
      tx.s.inodes.set(f.ino, {
        ino: f.ino,
        type: 'f',
        mode: f.mode,
        uid: f.uid,
        gid: f.gid,
        size: f.size,
        nlink: 1,
        version: 1,
        blobId: f.blobId,
        lockFence: 0,
        mtimeMs: f.mtimeMs,
        ctimeMs: this.now,
      });
      return Promise.resolve({ version: 1, mtimeMs: f.mtimeMs, ctimeMs: this.now });
    },
    link: (tx, d) => {
      const k = key(d.parentIno, d.name);
      if (tx.s.dentries.has(k)) return Promise.resolve(false);
      tx.s.dentries.set(k, { parentIno: d.parentIno, name: d.name, ino: d.ino, type: d.type });
      return Promise.resolve(true);
    },
    createDir: (tx, d): Promise<DirStamp> => {
      tx.s.inodes.set(d.ino, {
        ino: d.ino,
        type: 'd',
        mode: d.mode,
        uid: d.uid,
        gid: d.gid,
        size: 0,
        nlink: 2,
        version: 1,
        blobId: null,
        lockFence: 0,
        mtimeMs: this.now,
        ctimeMs: this.now,
      });
      return Promise.resolve({ version: 1, nlink: 2, mtimeMs: this.now, ctimeMs: this.now });
    },
    touchDir: (tx, dirIno, delta): Promise<DirStamp> => {
      const i = tx.s.inodes.get(dirIno);
      if (i === undefined) return Promise.reject(new Error('no dir'));
      i.version += 1;
      i.nlink += delta;
      i.mtimeMs = this.now;
      i.ctimeMs = this.now;
      return Promise.resolve({
        version: i.version,
        nlink: i.nlink,
        mtimeMs: this.now,
        ctimeMs: this.now,
      });
    },
  };

  readonly reader: FeedReader & DirContextSource = {
    heads: (owners): Promise<ReadonlyMap<number, OwnerHead>> => {
      const m = new Map<number, OwnerHead>();
      for (const o of owners) {
        const u = this.state.users.get(o);
        if (u !== undefined) m.set(o, { feedSeq: u.feedSeq, purgedSeq: u.purgedSeq });
      }
      return Promise.resolve(m);
    },
    page: (owner, after, limit): Promise<readonly FeedRow[]> => {
      const rows = this.state.feed
        .filter((f) => f.ownerUid === owner && f.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return Promise.resolve(
        rows.map((f) => {
          const op = this.state.opLog.get(f.opId);
          const eff = (op?.effects ?? { changes: [], dirs: [] }) as {
            changes: FeedRow['changes'];
            dirs: string[];
          };
          const lamport = (op?.result as { lamport?: number } | null)?.lamport ?? 0;
          return {
            ownerUid: f.ownerUid,
            seq: f.seq,
            opId: f.opId,
            commitTime: new Date(f.committedAt).toISOString(),
            lamport,
            changes: eff.changes,
            dirs: eff.dirs,
            purged: op === undefined,
          };
        }),
      );
    },
    load: (inos: readonly Ino[]): Promise<DirContext> => {
      const out = new Map<Ino, DirNode>();
      const todo = [...inos];
      while (todo.length > 0) {
        const ino = todo.pop();
        if (ino === undefined || out.has(ino)) continue;
        const i = this.state.inodes.get(ino);
        if (i === undefined) continue;
        const parent =
          [...this.state.dentries.values()].find((d) => d.ino === ino)?.parentIno ?? null;
        out.set(ino, { row: { type: i.type, mode: i.mode, uid: i.uid, gid: i.gid }, parent });
        if (parent !== null) todo.push(parent);
      }
      return Promise.resolve(out);
    },
  };

  readonly sessions: OsSessionStore = {
    register: (r) => {
      const existing = this.state.osSessions.get(r.osSessionId);
      if (existing !== undefined && existing.ownerUid !== r.ownerUid) return Promise.resolve(false);
      this.state.osSessions.set(r.osSessionId, { ownerUid: r.ownerUid, deviceId: r.deviceId });
      return Promise.resolve(true);
    },
    claim: (r) => {
      if (this.state.osSessions.has(r.osSessionId)) return Promise.resolve(false);
      this.state.osSessions.set(r.osSessionId, { ownerUid: r.ownerUid, deviceId: r.deviceId });
      return Promise.resolve(true);
    },
    owns: (osSessionId, uid, deviceId) => {
      const s = this.state.osSessions.get(osSessionId);
      return Promise.resolve(
        s !== undefined &&
          s.ownerUid === uid &&
          (deviceId === null || s.deviceId === null || s.deviceId === deviceId),
      );
    },
  };

  /** Feed numbers of every owner are exactly 1..feed_seq (INV-S3). */
  feedIsGapFree(): boolean {
    for (const u of this.state.users.values()) {
      const seqs = this.state.feed
        .filter((f) => f.ownerUid === u.uid)
        .map((f) => f.seq)
        .sort((a, b) => a - b);
      if (seqs.length !== u.feedSeq) return false;
      if (seqs.some((s, i) => s !== i + 1)) return false;
    }
    return true;
  }
}

export const ROOT_DIR = '00000000-0000-7000-8000-000000000001';
export const HOME = '00000000-0000-7000-8000-000000000008';

function stored(row: OpLogRow | undefined): StoredOp | null {
  if (row === undefined || row.status === 'pending') return null;
  return { uid: row.uid, status: row.status, errno: row.errno, result: row.result };
}

/** A minimal valid OpSubmit for a content write. */
export function writeOp(p: {
  opId: string;
  osSessionId: string;
  cseq: number;
  principal: number;
  ino: string;
  sha: string;
  size: number;
  baseVersion: number;
  mtime?: number;
  fences?: { ino: string; fence: number }[];
  lamport?: number;
}): OpSubmit {
  return {
    opId: p.opId,
    osSessionId: p.osSessionId,
    cseq: p.cseq,
    lamport: p.lamport ?? p.cseq,
    principal: p.principal,
    clientTime: '2026-11-14T06:00:00.000Z',
    op: {
      kind: 'write',
      ino: p.ino,
      blob: p.sha,
      size: p.size,
      mtime: p.mtime ?? Date.UTC(2026, 10, 14, 5, 0, 0),
    },
    base: { kind: 'versions', entries: [{ ino: p.ino, version: p.baseVersion }] },
    ...(p.fences === undefined ? {} : { fences: p.fences }),
  };
}

/** Deterministic UUIDv7-shaped ids for tests: prefix selects the family, n the member. */
export function uid7(prefix: number, n: number): string {
  return `0192${prefix.toString(16).padStart(4, '0')}-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A 64-hex sha256-shaped string. */
export function sha(n: number): string {
  return n.toString(16).padStart(64, '0');
}
