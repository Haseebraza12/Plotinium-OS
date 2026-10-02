/**
 * Remote apply (virtual-file-system.md §3.17.1; offline-and-sync.md §3.8.4 client rule 2, §3.8.5).
 *
 * One transaction per feed entry (or snapshot page) applies every change whose version is newer
 * than the local one and that no local op touches, and advances the owner's cursor (INV-S5).
 * Applying is idempotent: the same op may arrive through two owners' feeds, and a snapshot page may
 * overlap the feed. Per change:
 * - skip (and defer) anything that touches an inode or directory of a local op still pending, sent,
 *   reverted or parked: that op's own result brings the server state;
 * - upsert: apply to a known inode when the remote version is greater, or equal with a ctime not
 *   older; a new inode only in a mirrored directory; never lower a version;
 * - entries are added or removed only in mirrored directories; an inode moved out of view, or
 *   unlinked with no local entry left, is forgotten with its locally stored subtree (a cache
 *   eviction, no undo, no outbox op).
 */
import type { Change } from '@plotinium/protocol';

import type { DentryRec, InodeRec } from '../store/records.ts';
import type { TxHandle } from '../store/store.ts';
import type { TxContext } from './results.ts';
import { writeMeta } from './results.ts';
import { BlobDeltas, WriteLog, readAll, runSteps } from './txn.ts';
import type { Step } from './txn.ts';
import type { SnapshotRow } from './types.ts';

/** Rows below a directory, read before the transaction (a transaction cannot list a directory). */
export interface SubtreeRows {
  readonly inodes: readonly InodeRec[];
  readonly dentries: readonly DentryRec[];
}

export interface RemoteContext {
  /** Inodes and directories touched by local ops that are not final yet. */
  readonly touched: ReadonlySet<string>;
  /** Owners this device mirrors (a new directory of such an owner starts complete). */
  readonly mirroredOwners: ReadonlySet<number>;
  /** Descendants of directories the changes remove, keyed by the directory's ino. */
  readonly subtrees: ReadonlyMap<string, SubtreeRows>;
  /** Snapshot pages: directories whose complete entry set the page lists (mir = 1). */
  readonly completeDir?: (row: InodeRec) => boolean;
}

export interface RemoteOutput {
  readonly log: WriteLog;
  /** Changes skipped because a local op touches them; re-applied after that op's result. */
  readonly deferred: Change[];
  /** Directories to re-read with a snapshot (`refetch.dirs` of an entry over 200 changes). */
  readonly refetch: Set<string>;
  /** Inodes this transaction wrote. */
  readonly seen: Set<string>;
}

/** Whether a change touches something a local op still owns. */
export function touchesLocal(
  c: Change,
  touched: ReadonlySet<string>,
  subtrees?: ReadonlyMap<string, SubtreeRows>,
): boolean {
  if (touched.has(c.ino)) return true;
  if (c.parentIno !== undefined && touched.has(c.parentIno)) return true;
  if (c.fromParentIno !== undefined && touched.has(c.fromParentIno)) return true;
  const sub = subtrees?.get(c.ino);
  return sub !== undefined && sub.inodes.some((n) => touched.has(n.ino));
}

/** The local row a remote upsert produces. */
export function mergeRow(
  local: InodeRec | undefined,
  c: Change,
  now: number,
  mirroredOwners: ReadonlySet<number>,
): InodeRec | null {
  const type = c.type ?? local?.type;
  if (type === undefined) return null;
  const uid = c.uid ?? local?.uid ?? 0;
  const row: InodeRec = {
    ino: c.ino,
    fs: 'root',
    type,
    mode: c.mode ?? local?.mode ?? (type === 'd' ? 0o755 : 0o644),
    uid,
    gid: c.gid ?? local?.gid ?? 0,
    size: c.size ?? local?.size ?? 0,
    nlink: c.nlink ?? local?.nlink ?? (type === 'd' ? 2 : 1),
    version: c.version,
    atime: local?.atime ?? c.mtime ?? now,
    mtime: c.mtime ?? local?.mtime ?? now,
    ctime: c.ctime ?? local?.ctime ?? now,
    btime: local?.btime ?? c.ctime ?? now,
    // The server includes `blob` only when the receiver may read the inode (SYN-18).
    blob: type === 'f' ? (c.blob ?? null) : null,
    target: type === 'l' ? (c.symlinkTarget ?? local?.target ?? null) : null,
  };
  if (type === 'd') row.mir = local?.mir ?? (c.version <= 1 && mirroredOwners.has(uid) ? 1 : 0);
  return row;
}

/** Newer by the remote-apply rule (VFS §3.17.1): greater version, or equal with ctime not older. */
export function isNewer(local: InodeRec, c: Change): boolean {
  if (c.version > local.version) return true;
  return (
    c.version === local.version &&
    c.ctime !== undefined &&
    c.ctime >= local.ctime &&
    c.ctime !== local.ctime
  );
}

function forgetSubtree(
  root: string,
  sub: SubtreeRows | undefined,
  out: RemoteOutput,
  blobs: BlobDeltas,
): void {
  if (sub === undefined) return;
  for (const d of sub.dentries) out.log.delDentry(d);
  for (const n of sub.inodes) {
    if (n.ino === root) continue;
    blobs.add(n.blob, -1);
    out.log.delInode(n.ino);
  }
}

/** Remove `ino` (and its subtree) when no local entry names it any more. */
function forgetIfUnlinked(
  t: TxHandle,
  ino: string,
  ctx: RemoteContext,
  out: RemoteOutput,
  blobs: BlobDeltas,
  next: () => void,
): void {
  t.getAllByIndex<DentryRec>('dentries', 'by_ino', ino, (links) => {
    if (links.length > 0) {
      next();
      return;
    }
    t.get<InodeRec>('inodes', ino, undefined, (cur) => {
      if (cur !== undefined) {
        forgetSubtree(ino, ctx.subtrees.get(ino), out, blobs);
        blobs.add(cur.blob, -1);
        out.log.delInode(ino);
      }
      next();
    });
  });
}

function upsertStep(
  t: TxHandle,
  c: Change,
  ctx: RemoteContext,
  tx: TxContext,
  out: RemoteOutput,
  blobs: BlobDeltas,
): Step {
  return (next) => {
    const keys: string[] = c.parentIno === undefined ? [c.ino] : [c.ino, c.parentIno];
    readAll<InodeRec>(t, 'inodes', keys, ([local, parent]) => {
      const parentOk =
        parent !== undefined && (parent.mir === 1 || ctx.completeDir?.(parent) === true);
      if (local === undefined && !parentOk) {
        next(); // not mirrored here: a later ensureMirrored reads it
        return;
      }
      const apply = local === undefined || isNewer(local, c);
      let type = local?.type ?? c.type;
      if (apply) {
        const row = mergeRow(local, c, tx.now, ctx.mirroredOwners);
        if (row === null) {
          next();
          return;
        }
        if (row.type === 'd' && ctx.completeDir?.(row) === true) row.mir = 1;
        type = row.type;
        if (local?.blob !== row.blob) {
          blobs.add(local?.blob, -1);
          blobs.add(row.blob, 1, row.size);
        }
        out.log.putInode(row, local === undefined);
        out.seen.add(c.ino);
      } else {
        out.seen.add(c.ino);
      }
      if (c.parentIno === undefined || c.name === undefined || !parentOk || type === undefined) {
        next();
        return;
      }
      const parentIno = c.parentIno;
      const name = c.name;
      const dtype = type;
      t.get<DentryRec>('dentries', [parentIno, name], undefined, (existing) => {
        if (existing?.ino !== c.ino) {
          if (existing !== undefined) out.log.delDentry(existing);
          out.log.putDentry({ parent: parentIno, name, ino: c.ino, dtype });
        }
        next();
      });
    });
  };
}

function unlinkStep(
  t: TxHandle,
  c: Change,
  ctx: RemoteContext,
  out: RemoteOutput,
  blobs: BlobDeltas,
): Step {
  return (next) => {
    if (c.parentIno === undefined || c.name === undefined) {
      forgetIfUnlinked(t, c.ino, ctx, out, blobs, next);
      return;
    }
    t.get<DentryRec>('dentries', [c.parentIno, c.name], undefined, (d) => {
      if (d?.ino === c.ino) out.log.delDentry(d);
      forgetIfUnlinked(t, c.ino, ctx, out, blobs, next);
    });
  };
}

function moveStep(
  t: TxHandle,
  c: Change,
  ctx: RemoteContext,
  tx: TxContext,
  out: RemoteOutput,
  blobs: BlobDeltas,
): Step {
  return (next) => {
    const drop = (then: () => void): void => {
      if (c.fromParentIno === undefined || c.fromName === undefined) {
        then();
        return;
      }
      t.get<DentryRec>('dentries', [c.fromParentIno, c.fromName], undefined, (d) => {
        if (d?.ino === c.ino) out.log.delDentry(d);
        then();
      });
    };
    drop(() => {
      readAll<InodeRec>(
        t,
        'inodes',
        c.parentIno === undefined ? [c.ino] : [c.ino, c.parentIno],
        ([local, parent]) => {
          const inView =
            parent !== undefined &&
            parent.mir === 1 &&
            c.name !== undefined &&
            c.parentIno !== undefined;
          const type = local?.type ?? c.type;
          if (!inView || type === undefined || c.parentIno === undefined || c.name === undefined) {
            forgetIfUnlinked(t, c.ino, ctx, out, blobs, next); // moved out of view
            return;
          }
          const parentIno = c.parentIno;
          const name = c.name;
          if (local !== undefined && isNewer(local, c)) {
            const row = mergeRow(local, c, tx.now, ctx.mirroredOwners);
            if (row !== null) out.log.putInode(row);
          }
          t.get<DentryRec>('dentries', [parentIno, name], undefined, (existing) => {
            if (existing?.ino !== c.ino) {
              if (existing !== undefined) out.log.delDentry(existing);
              out.log.putDentry({ parent: parentIno, name, ino: c.ino, dtype: type });
            }
            if (local === undefined) out.refetch.add(parentIno); // the row itself is not local yet
            next();
          });
        },
      );
    });
  };
}

/**
 * Build the transaction of one feed entry's changes (or a snapshot page, or deferred changes being
 * re-applied). `tx.cursors` advances the owner's cursor in the same transaction.
 */
export function buildRemote(
  t: TxHandle,
  changes: readonly Change[],
  ctx: RemoteContext,
  tx: TxContext,
): RemoteOutput {
  const out: RemoteOutput = {
    log: new WriteLog(t),
    deferred: [],
    refetch: new Set(),
    seen: new Set(),
  };
  const blobs = new BlobDeltas();
  const steps: Step[] = [];
  for (const c of changes) {
    if (touchesLocal(c, ctx.touched, ctx.subtrees)) {
      out.deferred.push(c);
      continue;
    }
    if (c.kind === 'upsert') steps.push(upsertStep(t, c, ctx, tx, out, blobs));
    else if (c.kind === 'unlink') steps.push(unlinkStep(t, c, ctx, out, blobs));
    else steps.push(moveStep(t, c, ctx, tx, out, blobs));
  }
  runSteps(steps, () => {
    blobs.flush(t, tx.now);
    writeMeta(t, tx);
  });
  return out;
}

/** A snapshot row as an upsert change (backend-api.md §4.2 → offline-and-sync.md §4.2 `Change`). */
export function rowToChange(r: SnapshotRow): Change {
  return {
    kind: 'upsert',
    ino: r.ino,
    version: r.version,
    ...(r.parentIno === null ? {} : { parentIno: r.parentIno }),
    ...(r.name === null ? {} : { name: r.name }),
    type: r.type,
    mode: r.mode,
    uid: r.uid,
    gid: r.gid,
    size: r.size,
    nlink: r.nlink,
    ...(r.blob === undefined ? {} : { blob: r.blob }),
    ...(r.symlinkTarget === undefined ? {} : { symlinkTarget: r.symlinkTarget }),
    mtime: r.mtime,
    ctime: r.ctime,
  };
}

/** Inodes a set of changes may remove together with their subtree (read before the transaction). */
export function subtreeRoots(
  changes: readonly Change[],
  localType: (ino: string) => 'f' | 'd' | 'l' | undefined,
): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === 'upsert') continue;
    if (c.subtree === true || localType(c.ino) === 'd') out.push(c.ino);
  }
  return out;
}
