/**
 * Filtering feed entries by the RECEIVER's current permissions (offline-and-sync.md §3.8.4 rule 5,
 * §5.4 filterFor; SYN-18; RAG-03 analogue).
 *
 * An entry of owner U is delivered unfiltered to connections of uid U. For every other receiver,
 * each change is visible only if the receiver has r on its parent directory and x on the parent
 * and on every ancestor up to '/'; `blob` is included only if the receiver also has r on the inode.
 * A `move` whose new place is hidden but whose old place is visible becomes an `unlink` of the old
 * entry. If every change is filtered, the entry is sent `redacted: true` with no changes, so the
 * receiver's cursor still advances. The checks use the isomorphic vfs/perm.ts against directory
 * rows the broadcaster loaded ONCE per entry (a DirContext), so the fan-out itself is synchronous.
 */
import type { Change } from '@plotinium/protocol';
import { may, R, X, type Cred, type PermSubject } from '@plotinium/vfs/perm';

import type { Ino } from '../../vfs/types.ts';

export interface DirNode {
  readonly row: PermSubject;
  /** The parent of this inode (its first dentry for a file), null for '/'. */
  readonly parent: Ino | null;
}

/** Rows of the inodes an entry touches and of all their ancestors. */
export type DirContext = ReadonlyMap<Ino, DirNode>;

/** Loads a DirContext (Kysely implementation: kyselyDirContext in feed-reader.ts). */
export interface DirContextSource {
  load(inos: readonly Ino[]): Promise<DirContext>;
}

/** The inodes whose rows (and ancestors) the filter needs for these changes. */
export function contextInos(changes: readonly Change[]): Ino[] {
  const out = new Set<Ino>();
  for (const c of changes) {
    out.add(c.ino);
    if (c.parentIno !== undefined) out.add(c.parentIno);
    if (c.fromParentIno !== undefined) out.add(c.fromParentIno);
  }
  return [...out];
}

/** r + x on `dir` and x on every ancestor (a missing row hides the change: fail closed). */
export function canSeeIn(cred: Cred, dir: Ino | undefined | null, ctx: DirContext): boolean {
  if (dir === undefined || dir === null) return false;
  const node = ctx.get(dir);
  if (node === undefined || !may(cred, node.row, R | X)) return false;
  let cursor = node.parent;
  for (let depth = 0; cursor !== null; depth++) {
    if (depth > 4096) return false;
    const up = ctx.get(cursor);
    if (up === undefined || !may(cred, up.row, X)) return false;
    cursor = up.parent;
  }
  return true;
}

function parentOf(c: Change, ctx: DirContext): Ino | null | undefined {
  return c.parentIno ?? ctx.get(c.ino)?.parent;
}

function withoutBlob(c: Change): Change {
  if (c.blob === undefined) return c;
  const { blob: _blob, ...rest } = c;
  return rest;
}

function blobVisible(cred: Cred, c: Change, ctx: DirContext): boolean {
  const row =
    c.type !== undefined && c.mode !== undefined && c.uid !== undefined && c.gid !== undefined
      ? { type: c.type, mode: c.mode, uid: c.uid, gid: c.gid }
      : ctx.get(c.ino)?.row;
  return row !== undefined && may(cred, row, R);
}

export interface Filtered {
  readonly changes: readonly Change[];
  readonly redacted: boolean;
}

/** The changes of an entry of `ownerUid` that the receiver `cred` may see. */
export function filterChanges(
  cred: Cred,
  ownerUid: number,
  changes: readonly Change[],
  ctx: DirContext,
): Filtered {
  if (cred.uid === ownerUid) return { changes, redacted: false };
  const out: Change[] = [];
  for (const c of changes) {
    const visibleHere = canSeeIn(cred, parentOf(c, ctx), ctx);
    if (visibleHere) {
      out.push(blobVisible(cred, c, ctx) ? c : withoutBlob(c));
      continue;
    }
    if (
      c.kind === 'move' &&
      c.fromParentIno !== undefined &&
      canSeeIn(cred, c.fromParentIno, ctx)
    ) {
      out.push({
        kind: 'unlink',
        ino: c.ino,
        version: c.version,
        parentIno: c.fromParentIno,
        ...(c.fromName === undefined ? {} : { name: c.fromName }),
      });
    }
  }
  return { changes: out, redacted: changes.length > 0 && out.length === 0 };
}
