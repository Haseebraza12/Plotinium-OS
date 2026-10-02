/**
 * Applying the server's final result of an op on the client (offline-and-sync.md §3.10–§3.12;
 * virtual-file-system.md §3.14.3–§3.14.5, §3.15). Every builder here is the synchronous body of ONE
 * IndexedDB transaction that also deletes (or rewrites) the outbox record and advances the feed
 * cursors, so there is no "acked but not applied" state on disk (§3.4, INV-S1, INV-S5).
 *
 * - applied / duplicate: authoritative versions, blob pins released, quota mirror confirmed.
 * - conflict: a content write keeps the server's file (our pre-image is restored and re-fetched)
 *   and adds our bytes as the conflicted copy `keptAs`; a create/copy whose name was taken moves
 *   our entry to the `keptAs` name.
 * - rejected: the op and every dependent op are reverted from their undo records in reverse commit
 *   order (the cascade of §3.12.4 / VFS §3.14.4); content is never discarded: the server's salvage
 *   copy (`keptAs`) is created locally, or the op is parked with a local "not synced" copy in the
 *   principal's `~/lost+found`.
 */
import { deriveIno } from '@plotinium/protocol';
import type { Errno, FeedCursor } from '@plotinium/protocol';

import { conflictName, isoDate } from '../names.ts';
import type {
  DentryRec,
  InodeRec,
  MetaRec,
  OutboxRec,
  UndoRec,
  UserRec,
} from '../store/records.ts';
import type { TxHandle } from '../store/store.ts';
import { mergeLamportInTx } from './lamport.ts';
import { isContentBearing, singleContent } from './outbox.ts';
import { BlobDeltas, UserDeltas, WriteLog, readAll, runSteps } from './txn.ts';
import type { Step } from './txn.ts';
import type { SyncKeptAs, OpResultBody } from './types.ts';

/** The meta key of an owner's feed cursor (VFS §4.2 `resume:<ownerUid>`). */
export function cursorKey(ownerUid: number): string {
  return `resume:${ownerUid}`;
}

/** A cursor value as stored: `{seq, updatedAt}` (offline-and-sync.md §4.8), or a bare number. */
export function cursorSeq(v: MetaRec | undefined): number {
  const raw = v?.v;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && raw !== null && 'seq' in raw && typeof raw.seq === 'number')
    return raw.seq;
  return 0;
}

export interface TxContext {
  readonly now: number;
  /** OS time zone for local conflicted-copy dates (VFS §3.15.2). */
  readonly timeZone: string;
  /** Cursor writes that ride along (planned by the FeedTracker). */
  readonly cursors: readonly FeedCursor[];
  /** A received Lamport value to merge, or null. */
  readonly lamport: number | null;
}

/** What a result transaction changed, besides the rows in `log`. */
export interface ResultOutput {
  readonly log: WriteLog;
  /** Inodes whose authoritative server state must be re-read (a snapshot of their directory). */
  readonly refetch: Set<string>;
  /** Records rewritten in place (parked, reverted), by opId. */
  readonly rewritten: Map<string, OutboxRec>;
  /** Records deleted, by opId. */
  readonly deleted: Set<string>;
  /** The rejected op was parked on this device. */
  parked: boolean;
}

export function newOutput(t: TxHandle): ResultOutput {
  return {
    log: new WriteLog(t),
    refetch: new Set(),
    rewritten: new Map(),
    deleted: new Set(),
    parked: false,
  };
}

/** Cursor and Lamport writes (INV-S5: in the same transaction as what they acknowledge). */
export function writeMeta(t: TxHandle, ctx: TxContext): void {
  for (const c of ctx.cursors)
    t.put('meta', {
      k: cursorKey(c.ownerUid),
      v: { seq: c.seq, updatedAt: new Date(ctx.now).toISOString() },
    });
  if (ctx.lamport !== null) mergeLamportInTx(t, ctx.lamport);
}

function delRecord(t: TxHandle, rec: OutboxRec, out: ResultOutput): void {
  if (rec.seq !== undefined) t.del('outbox', rec.seq);
  out.deleted.add(rec.opId);
}

function putRecord(t: TxHandle, rec: OutboxRec, out: ResultOutput): void {
  t.put('outbox', rec);
  out.rewritten.set(rec.opId, rec);
}

/** Release the outbox pins of a record (the blobs it had to upload, VFS §3.13.4). */
function releaseOutboxPins(rec: OutboxRec, blobs: BlobDeltas, uploaded: boolean): void {
  for (const sha of rec.blobs) {
    blobs.add(sha, -1);
    if (uploaded) blobs.markUploaded(sha, true);
  }
}

/**
 * Invert one op from its undo record (VFS §3.14.4 step 3): delete what it created, restore the
 * pre-images, give back its quota, release the undo pins, delete the undo record. Blob references
 * follow the rows: every current row that goes away drops one reference, every restored pre-image
 * adds one.
 */
export function revertStep(
  t: TxHandle,
  undo: UndoRec,
  out: ResultOutput,
  blobs: BlobDeltas,
  users: UserDeltas,
): Step {
  return (next) => {
    const createdKeys = undo.created.dentries.map(([p, n]) => [p, n] as IDBValidKey);
    readAll<DentryRec>(t, 'dentries', createdKeys, (createdDentries) => {
      const inoKeys = [...undo.created.inodes, ...undo.pre.inodes.map((i) => i.ino)];
      readAll<InodeRec>(t, 'inodes', inoKeys, (current) => {
        for (const d of createdDentries) if (d !== undefined) out.log.delDentry(d);
        undo.created.inodes.forEach((ino, i) => {
          const cur = current[i];
          if (cur === undefined) return;
          blobs.add(cur.blob, -1);
          out.log.delInode(ino);
        });
        const off = undo.created.inodes.length;
        undo.pre.inodes.forEach((pre, i) => {
          const cur = current[off + i];
          blobs.add(cur?.blob, -1);
          blobs.add(pre.blob, 1, pre.size);
          out.log.putInode(pre, cur === undefined);
        });
        for (const d of undo.pre.dentries) out.log.putDentry(d);
        for (const u of undo.users) users.add(u.uid, -u.dBytes, -u.dInodes);
        for (const pin of undo.pins) blobs.add(pin, -1);
        t.del('undo', undo.opId);
        next();
      });
    });
  };
}

export interface CopySpec {
  /** Where the copy lives; the directory may be missing locally (a server-created `~/lost+found`). */
  readonly keptAs: SyncKeptAs;
  readonly blob: string;
  readonly size: number;
  readonly mtime: number;
  /** The file the bytes were meant for (its mode is copied). */
  readonly origIno: string;
  readonly principal: number;
  /** Authoritative version from `op.result.versions`, if the server sent one. */
  readonly version?: { readonly version: number; readonly mtime?: number; readonly ctime?: number };
}

function newDir(ino: string, uid: number, gid: number, now: number): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'd',
    mode: 0o700,
    uid,
    gid,
    size: 0,
    nlink: 2,
    version: 1,
    atime: now,
    mtime: now,
    ctime: now,
    btime: now,
    blob: null,
    target: null,
    mir: 1,
  };
}

/**
 * Make `~/lost+found` of `user` exist locally with id `ino` (VFS §3.15.4: created on demand, 0700,
 * owned by the user). Calls `then(dirIno)` with the directory to use, or null when the home is not
 * on this device (the copy then arrives with the re-fetch).
 */
function ensureLostFound(
  t: TxHandle,
  user: UserRec | undefined,
  ino: string,
  now: number,
  out: ResultOutput,
  then: (dir: string | null) => void,
): void {
  const home = user?.homeIno;
  if (user === undefined || home === undefined) {
    then(null);
    return;
  }
  t.get<DentryRec>('dentries', [home, 'lost+found'], undefined, (existing) => {
    if (existing !== undefined) {
      then(existing.ino);
      return;
    }
    t.get<InodeRec>('inodes', home, undefined, (homeRec) => {
      if (homeRec === undefined) {
        then(null);
        return;
      }
      out.log.putInode(newDir(ino, user.uid, user.gid, now), true);
      out.log.putDentry({ parent: home, name: 'lost+found', ino, dtype: 'd' });
      out.log.putInode({ ...homeRec, nlink: homeRec.nlink + 1, mtime: now, ctime: now });
      then(ino);
    });
  });
}

/**
 * The conflicted or salvaged copy the server kept (`keptAs`), created locally with our own blob
 * (no download: VFS §3.15.2). Idempotent: an existing copy row is left as it is.
 */
export function addCopyStep(
  t: TxHandle,
  spec: CopySpec,
  ctx: TxContext,
  out: ResultOutput,
  blobs: BlobDeltas,
  users: UserDeltas,
): Step {
  return (next) => {
    t.get<UserRec>('users', spec.principal, undefined, (user) => {
      readAll<InodeRec>(
        t,
        'inodes',
        [spec.keptAs.parentIno, spec.keptAs.ino, spec.origIno],
        ([parent, existing, orig]) => {
          const place = (dir: string | null): void => {
            if (dir === null) {
              out.refetch.add(spec.origIno);
              next();
              return;
            }
            if (existing === undefined) {
              const rec: InodeRec = {
                ino: spec.keptAs.ino,
                fs: 'root',
                type: 'f',
                mode: orig?.mode ?? 0o644,
                uid: spec.principal,
                gid: user?.gid ?? 0,
                size: spec.size,
                nlink: 1,
                version: spec.version?.version ?? 1,
                atime: ctx.now,
                mtime: spec.version?.mtime ?? spec.mtime,
                ctime: spec.version?.ctime ?? ctx.now,
                btime: ctx.now,
                blob: spec.blob,
                target: null,
              };
              blobs.add(spec.blob, 1, spec.size);
              users.add(spec.principal, spec.size, 1);
              out.log.putInode(rec, true);
            }
            out.log.putDentry({
              parent: dir,
              name: spec.keptAs.name,
              ino: spec.keptAs.ino,
              dtype: 'f',
            });
            next();
          };
          if (parent !== undefined) place(parent.ino);
          else
            ensureLostFound(t, user, spec.keptAs.parentIno, ctx.now, out, (dir) =>
              place(dir === spec.keptAs.parentIno ? dir : null),
            );
        },
      );
    });
  };
}

/**
 * Park a content-bearing op on the device (VFS §3.14.4 step 2; offline-and-sync.md §3.12.4 step 3):
 * the record becomes `parked` (never replayed automatically) and keeps its blob pin; a single
 * write or create also leaves a local "not synced" copy in the principal's `~/lost+found`, and the
 * record's `touches` become that copy, so remote apply never overwrites it.
 */
export interface ParkReason {
  readonly errno: Errno;
  readonly reason?: string;
}

export function parkStep(
  t: TxHandle,
  rec: OutboxRec,
  ctx: TxContext,
  out: ResultOutput,
  blobs: BlobDeltas,
  why: ParkReason,
  knownName?: string,
): Step {
  return (next) => {
    const content = singleContent(rec.op);
    const finish = (touches: string[]): void => {
      const parked: OutboxRec = {
        ...rec,
        state: 'parked',
        touches,
        lastError: {
          errno: why.errno,
          ...(why.reason === undefined ? {} : { detail: why.reason }),
        },
      };
      putRecord(t, parked, out);
      next();
    };
    if (content === null) {
      finish([]);
      return;
    }
    t.get<UserRec>('users', rec.principal, undefined, (user) => {
      const lfIno = deriveIno(rec.opId, user?.homeIno ?? content.ino);
      ensureLostFound(t, user, lfIno, ctx.now, out, (dir) => {
        if (dir === null || user === undefined) {
          finish([]);
          return;
        }
        const named = (orig: string): void => {
          const tried = new Set<string>();
          const date = isoDate(ctx.now, ctx.timeZone);
          const attempt = (): void => {
            const name = conflictName(orig, user.username, date, (c) => tried.has(c));
            t.get<DentryRec>('dentries', [dir, name], undefined, (taken) => {
              if (taken !== undefined) {
                tried.add(name);
                attempt();
                return;
              }
              const copyIno = deriveIno(rec.opId, content.ino);
              t.get<InodeRec>('inodes', copyIno, undefined, (existing) => {
                if (existing === undefined) {
                  blobs.add(content.blob, 1, content.size);
                  out.log.putInode(
                    {
                      ino: copyIno,
                      fs: 'root',
                      type: 'f',
                      mode: 0o600,
                      uid: user.uid,
                      gid: user.gid,
                      size: content.size,
                      nlink: 1,
                      version: 1,
                      atime: ctx.now,
                      mtime: ctx.now,
                      ctime: ctx.now,
                      btime: ctx.now,
                      blob: content.blob,
                      target: null,
                    },
                    true,
                  );
                  out.log.putDentry({ parent: dir, name, ino: copyIno, dtype: 'f' });
                }
                finish([copyIno, dir]);
              });
            });
          };
          attempt();
        };
        const known = content.name ?? knownName;
        if (known !== undefined) named(known);
        else
          t.getAllByIndex<DentryRec>('dentries', 'by_ino', content.ino, (links) =>
            named(links[0]?.name ?? content.ino),
          );
      });
    });
  };
}

/** Apply `op.result.versions` (authoritative version, mtime, ctime) to the local rows. */
function versionsStep(t: TxHandle, result: OpResultBody, out: ResultOutput): Step {
  return (next) => {
    const vs = result.pruned === true ? [] : (result.versions ?? []);
    readAll<InodeRec>(
      t,
      'inodes',
      vs.map((v) => v.ino),
      (rows) => {
        vs.forEach((v, i) => {
          const cur = rows[i];
          if (cur === undefined) return;
          out.log.putInode({
            ...cur,
            version: v.version,
            mtime: v.mtime ?? cur.mtime,
            ctime: v.ctime ?? cur.ctime,
          });
        });
        next();
      },
    );
  };
}

/** The undo record of an op, then its disposal after a final non-revert result. */
function closeUndoStep(t: TxHandle, opId: string, blobs: BlobDeltas): Step {
  return (next) => {
    t.get<UndoRec>('undo', opId, undefined, (undo) => {
      if (undo !== undefined) {
        if (undo.keepAfterAck) t.put('undo', { ...undo, state: 'committed' });
        else {
          for (const pin of undo.pins) blobs.add(pin, -1);
          t.del('undo', opId);
        }
      }
      next();
    });
  };
}

function finishSteps(
  t: TxHandle,
  ctx: TxContext,
  blobs: BlobDeltas,
  users: UserDeltas,
  finalized: ReadonlySet<string>,
): void {
  users.flush(t, ctx.now, finalized);
  blobs.flush(t, ctx.now);
  writeMeta(t, ctx);
}

/**
 * `applied` (also a duplicate of an earlier applied attempt; VFS §3.14.3). A pruned tombstone has no
 * versions: the touched inodes are re-read instead (§3.10).
 */
export function buildAck(
  t: TxHandle,
  rec: OutboxRec,
  result: OpResultBody,
  ctx: TxContext,
): ResultOutput {
  const out = newOutput(t);
  const blobs = new BlobDeltas();
  const users = new UserDeltas();
  users.setServer(result.quota);
  delRecord(t, rec, out);
  releaseOutboxPins(rec, blobs, true);
  if (result.pruned === true) for (const ino of rec.touches) out.refetch.add(ino);
  runSteps([closeUndoStep(t, rec.opId, blobs), versionsStep(t, result, out)], () =>
    finishSteps(t, ctx, blobs, users, new Set([rec.opId])),
  );
  return out;
}

/** Where a create or copy put the name the server found taken. */
function createdEntry(rec: OutboxRec): { parent: string; name: string } | null {
  if (rec.op.kind === 'create') return { parent: rec.op.parentIno, name: rec.op.name };
  if (rec.op.kind === 'copy') return { parent: rec.op.toParentIno, name: rec.op.toName };
  return null;
}

/**
 * `conflict` (§3.12.2; VFS §3.15). For a content write: restore our pre-image (the server kept its
 * own version, which is re-fetched), add our bytes as the conflicted copy, delete the record. For a
 * create or copy: our inode keeps its id and only its entry moves to the `keptAs` name.
 */
export function buildConflict(
  t: TxHandle,
  rec: OutboxRec,
  result: OpResultBody,
  keptAs: SyncKeptAs,
  ctx: TxContext,
): ResultOutput {
  const out = newOutput(t);
  const blobs = new BlobDeltas();
  const users = new UserDeltas();
  users.setServer(result.quota);
  delRecord(t, rec, out);
  releaseOutboxPins(rec, blobs, true);
  const steps: Step[] = [];
  const op = rec.op;
  if (op.kind === 'write') {
    out.refetch.add(op.ino);
    steps.push((next) => {
      t.get<UndoRec>('undo', rec.opId, undefined, (undo) => {
        if (undo === undefined) {
          next();
          return;
        }
        revertStep(t, undo, out, blobs, users)(next);
      });
    });
    const v = result.versions?.find((x) => x.ino === keptAs.ino);
    steps.push(
      addCopyStep(
        t,
        {
          keptAs,
          blob: op.blob,
          size: op.size,
          mtime: op.mtime,
          origIno: op.ino,
          principal: rec.principal,
          ...(v === undefined ? {} : { version: v }),
        },
        ctx,
        out,
        blobs,
        users,
      ),
    );
  } else {
    const at = createdEntry(rec);
    if (at !== null) {
      out.refetch.add(at.parent);
      steps.push((next) => {
        t.get<DentryRec>('dentries', [at.parent, at.name], undefined, (d) => {
          if (d !== undefined && d.ino === keptAs.ino) {
            out.log.delDentry(d);
            out.log.putDentry({
              parent: keptAs.parentIno,
              name: keptAs.name,
              ino: d.ino,
              dtype: d.dtype,
            });
          } else {
            out.refetch.add(keptAs.ino);
          }
          next();
        });
      });
    } else {
      for (const ino of rec.touches) out.refetch.add(ino);
    }
    steps.push(closeUndoStep(t, rec.opId, blobs), versionsStep(t, result, out));
  }
  runSteps(steps, () => finishSteps(t, ctx, blobs, users, new Set([rec.opId])));
  return out;
}

/** A member of a rejected op's closure (§3.12.4 step 2, VFS §3.14.4 step 1). */
export interface ClosureMember {
  readonly rec: OutboxRec;
  /** Sent at least once (possibly applied on the server): kept as `reverted` until its own result. */
  readonly everSent: boolean;
}

/**
 * The dependency closure of a rejected op `k`: every later record (not parked, not already
 * reverted) whose `touches` intersect the union of the closure so far (§5.7). O(r · s).
 */
export function closureOf(k: OutboxRec, later: readonly OutboxRec[]): OutboxRec[] {
  const touched = new Set(k.touches);
  const out: OutboxRec[] = [];
  const kSeq = k.seq ?? Number.NEGATIVE_INFINITY;
  const sorted = [...later].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const r of sorted) {
    if (r.opId === k.opId || (r.seq ?? 0) <= kSeq || r.state === 'parked' || r.state === 'reverted')
      continue;
    if (r.touches.some((x) => touched.has(x))) {
      out.push(r);
      for (const x of r.touches) touched.add(x);
    }
  }
  return out;
}

/**
 * `rejected` (§3.12.4; VFS §3.14.4). `k` is reverted with its closure in reverse commit order.
 * Content of `k` is kept: the server's salvage copy (`keptAs`) is created locally, or `k` is parked.
 * Closure members that were never sent are deleted (or parked when they carry content); members that
 * may have reached the server become `reverted` and wait for their own result.
 */
export function buildReject(
  t: TxHandle,
  k: OutboxRec,
  members: readonly ClosureMember[],
  result: OpResultBody,
  ctx: TxContext,
): ResultOutput {
  const out = newOutput(t);
  const blobs = new BlobDeltas();
  const users = new UserDeltas();
  users.setServer(result.quota);
  const all = [k, ...members.map((m) => m.rec)];
  const reason: ParkReason = {
    errno: result.errno ?? 'EIO',
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
  const keptAs = result.keptAs;
  const content = singleContent(k.op);
  readAll<UndoRec>(
    t,
    'undo',
    all.map((r) => r.opId),
    (undos) => {
      const steps: Step[] = [];
      // 0. Names of written files, read before the reverts move them (parked copies are named after them).
      const names = new Map<string, string>();
      steps.push((next) => {
        const writes = all
          .filter((r) => r.op.kind === 'write')
          .map((r) => (r.op.kind === 'write' ? r.op.ino : ''));
        let left = writes.length;
        if (left === 0) {
          next();
          return;
        }
        for (const ino of writes) {
          t.getAllByIndex<DentryRec>('dentries', 'by_ino', ino, (links) => {
            const first = links[0];
            if (first !== undefined) names.set(ino, first.name);
            left--;
            if (left === 0) next();
          });
        }
      });
      // 1. Revert in reverse commit order (the latest dependent first).
      const withUndo = all
        .map((rec, i) => ({ rec, undo: undos[i] }))
        .filter((x): x is { rec: OutboxRec; undo: UndoRec } => x.undo !== undefined)
        .sort((a, b) => (b.rec.seq ?? 0) - (a.rec.seq ?? 0));
      for (const x of withUndo) steps.push(revertStep(t, x.undo, out, blobs, users));
      // 2. Keep k's content.
      if (keptAs !== undefined && content !== null) {
        steps.push(
          addCopyStep(
            t,
            {
              keptAs,
              blob: content.blob,
              size: content.size,
              mtime: ctx.now,
              origIno: content.ino,
              principal: k.principal,
            },
            ctx,
            out,
            blobs,
            users,
          ),
        );
        steps.push((next) => {
          delRecord(t, k, out);
          releaseOutboxPins(k, blobs, true);
          next();
        });
      } else if (keptAs === undefined && isContentBearing(k.op)) {
        out.parked = true;
        steps.push(
          parkStep(
            t,
            k,
            ctx,
            out,
            blobs,
            reason,
            content === null ? undefined : names.get(content.ino),
          ),
        );
      } else {
        if (keptAs !== undefined) out.refetch.add(keptAs.ino);
        steps.push((next) => {
          delRecord(t, k, out);
          releaseOutboxPins(k, blobs, false);
          next();
        });
      }
      // 3. The rest of the closure.
      for (const m of members) {
        if (m.everSent) {
          steps.push((next) => {
            putRecord(t, { ...m.rec, state: 'reverted' }, out);
            next();
          });
        } else if (isContentBearing(m.rec.op)) {
          const c = singleContent(m.rec.op);
          steps.push(
            parkStep(
              t,
              m.rec,
              ctx,
              out,
              blobs,
              { errno: reason.errno, reason: 'cascade' },
              c === null ? undefined : names.get(c.ino),
            ),
          );
        } else {
          steps.push((next) => {
            delRecord(t, m.rec, out);
            releaseOutboxPins(m.rec, blobs, false);
            next();
          });
        }
      }
      runSteps(steps, () => finishSteps(t, ctx, blobs, users, new Set(all.map((r) => r.opId))));
    },
  );
  return out;
}

/**
 * The own result of a record that was already reverted by an earlier cascade (VFS §3.14.4 step 3):
 * `rejected` deletes it (or parks it when it carries content and the server kept nothing);
 * `conflict` creates the kept copy; an unexpected `applied` re-reads the touched inodes (the server
 * is the authority, Spec §8 boundary 3).
 */
export function buildRevertedResult(
  t: TxHandle,
  rec: OutboxRec,
  result: OpResultBody,
  ctx: TxContext,
): ResultOutput {
  const out = newOutput(t);
  const blobs = new BlobDeltas();
  const users = new UserDeltas();
  users.setServer(result.quota);
  const steps: Step[] = [];
  const content = singleContent(rec.op);
  const keptAs = result.keptAs;
  if (result.status === 'rejected' && keptAs === undefined && isContentBearing(rec.op)) {
    out.parked = true;
    steps.push(
      parkStep(t, rec, ctx, out, blobs, {
        errno: result.errno ?? 'EIO',
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      }),
    );
  } else {
    if (keptAs !== undefined && content !== null) {
      steps.push(
        addCopyStep(
          t,
          {
            keptAs,
            blob: content.blob,
            size: content.size,
            mtime: ctx.now,
            origIno: content.ino,
            principal: rec.principal,
          },
          ctx,
          out,
          blobs,
          users,
        ),
      );
    } else if (
      keptAs !== undefined ||
      result.status === 'applied' ||
      result.status === 'conflict'
    ) {
      for (const ino of rec.touches) out.refetch.add(ino);
    }
    steps.push((next) => {
      delRecord(t, rec, out);
      releaseOutboxPins(rec, blobs, result.status !== 'rejected');
      next();
    });
  }
  runSteps(steps, () => finishSteps(t, ctx, blobs, users, new Set([rec.opId])));
  return out;
}

/**
 * Cancel an op that was never sent (§3.13.3 last rule, AGT-09): revert it locally, with its
 * closure, and delete the records in one transaction; nothing reaches the server.
 */
export function buildLocalCancel(
  t: TxHandle,
  k: OutboxRec,
  members: readonly ClosureMember[],
  ctx: TxContext,
): ResultOutput {
  const out = newOutput(t);
  const blobs = new BlobDeltas();
  const users = new UserDeltas();
  const all = [k, ...members.map((m) => m.rec)];
  readAll<UndoRec>(
    t,
    'undo',
    all.map((r) => r.opId),
    (undos) => {
      const steps: Step[] = [];
      const withUndo = all
        .map((rec, i) => ({ rec, undo: undos[i] }))
        .filter((x): x is { rec: OutboxRec; undo: UndoRec } => x.undo !== undefined)
        .sort((a, b) => (b.rec.seq ?? 0) - (a.rec.seq ?? 0));
      for (const x of withUndo) steps.push(revertStep(t, x.undo, out, blobs, users));
      for (const r of all) {
        const m = members.find((x) => x.rec.opId === r.opId);
        steps.push((next) => {
          if (m?.everSent === true) putRecord(t, { ...r, state: 'reverted' }, out);
          else {
            delRecord(t, r, out);
            releaseOutboxPins(r, blobs, false);
          }
          next();
        });
      }
      runSteps(steps, () => finishSteps(t, ctx, blobs, users, new Set(all.map((r) => r.opId))));
    },
  );
  return out;
}
