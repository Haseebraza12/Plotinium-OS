/**
 * Removing names: `unlink`, `rmdir` and `unlink {recursive}` = `rm -r` (virtual-file-system.md
 * §3.10, §3.12.1). A file or symlink inode goes when its last link goes; otherwise it survives with
 * `nlink` reduced. On the synced fs a deleted file's blob reference moves to the undo record (net
 * refcount 0), so a rejected op can be reverted with its content.
 */
import { isWellKnownDir } from '@plotinium/protocol';

import { subtreeDigest } from '../digest.ts';
import { NotLoaded, fail } from '../errors.ts';
import { BULK_MAX_NODES } from '../limits.ts';
import { checkRemove, checkSubtreeDir, stickyDenies } from '../perm.ts';
import { isSynthIno } from '../quota/quota.ts';
import type { DentryRec, InodeRec, Uuid } from '../store/records.ts';
import { entryPath } from '../view.ts';
import {
  checkNotBusy,
  checkNotSynth,
  checkNotWellKnown,
  checkWritable,
  dentry,
  entriesOf,
  forRemove,
  orFail,
} from './common.ts';
import type { Entry } from './common.ts';
import type { PlanBuilder } from './plan.ts';

export interface UnlinkResult {
  /** Inodes freed. */
  readonly removed: number;
  /** Bytes freed (sizes of freed files and symlinks). */
  readonly bytes: number;
  readonly ino: Uuid;
}

/**
 * Drop one link of a file or symlink: the dentry always, the inode when it was the last link
 * (quota released, blob unreferenced). Returns true when the inode was freed.
 */
export function dropLink(b: PlanBuilder, parent: Uuid, name: string, node: InodeRec): boolean {
  b.delDentry({ parent, name, ino: node.ino, dtype: node.type });
  const cur = b.view.inode(node.ino) ?? node;
  if (cur.nlink > 1) {
    b.putInode({ ...cur, nlink: cur.nlink - 1, ctime: b.ctx.now });
    return false;
  }
  b.delInode(node.ino);
  b.charge(cur, -1);
  if (cur.blob !== null) b.unrefBlob(cur.blob, cur.fs);
  return true;
}

/** Remove an empty directory's rows. */
export function dropDir(b: PlanBuilder, parent: Uuid, name: string, node: InodeRec): void {
  b.delDentry({ parent, name, ino: node.ino, dtype: 'd' });
  b.delInode(node.ino);
  b.charge(node, -1);
}

/** `unlink(path)` of a file or symlink; `recursive` hands directories to `rm -r`. */
export function planUnlink(b: PlanBuilder, path: string, recursive = false): UnlinkResult {
  checkWritable(b);
  const e = forRemove(b, path);
  if (e.node.type === 'd') {
    if (!recursive) fail('EISDIR');
    return planRemoveTree(b, e);
  }
  checkNotSynth(e.node);
  orFail(checkRemove(b.ctx.cred, e.parent, e.node));
  checkNotBusy(b, e.node);
  const freed = dropLink(b, e.parent.ino, e.name, e.node);
  b.dirChanged(e.parent.ino, 0);
  b.notes.deletes.push(e.path);
  b.emit({
    topic: 'vfs.unlink',
    data: {
      items: [
        {
          parent: e.parent.ino,
          name: e.name,
          ino: e.node.ino,
          type: e.node.type,
          inos: freed ? [e.node.ino] : [],
          count: freed ? 1 : 0,
        },
      ],
    },
  });
  b.wire(
    { kind: 'unlink', parentIno: e.parent.ino, name: e.name, ino: e.node.ino, recursive: false },
    e.node.fs,
  );
  b.setBase({ kind: 'versions', entries: [{ ino: e.node.ino, version: e.node.version }] });
  return { removed: freed ? 1 : 0, bytes: freed ? e.node.size : 0, ino: e.node.ino };
}

/** `rmdir(path)`: an empty directory only (ENOTEMPTY otherwise; synthesised entries count). */
export function planRmdir(b: PlanBuilder, path: string): UnlinkResult {
  checkWritable(b);
  const e = forRemove(b, path);
  if (e.node.type !== 'd') fail('ENOTDIR');
  checkNotWellKnown(e.node);
  orFail(checkRemove(b.ctx.cred, e.parent, e.node));
  checkNotBusy(b, e.node);
  if (entriesOf(b, e.node.ino).length > 0) fail('ENOTEMPTY');
  dropDir(b, e.parent.ino, e.name, e.node);
  b.dirChanged(e.parent.ino, -1);
  b.notes.deletes.push(e.path);
  b.emit({
    topic: 'vfs.unlink',
    data: {
      items: [
        {
          parent: e.parent.ino,
          name: e.name,
          ino: e.node.ino,
          type: 'd',
          inos: [e.node.ino],
          count: 1,
        },
      ],
    },
  });
  b.wire(
    { kind: 'unlink', parentIno: e.parent.ino, name: e.name, ino: e.node.ino, recursive: false },
    e.node.fs,
  );
  b.setBase({ kind: 'versions', entries: [{ ino: e.node.ino, version: e.node.version }] });
  return { removed: 1, bytes: 0, ino: e.node.ino };
}

interface Visit {
  readonly parent: InodeRec;
  readonly name: string;
  readonly node: InodeRec;
}

/**
 * The subtree of `root` in post-order (children before their directory), never following symlinks,
 * with the permission checks of §3.6.2: r+w+x on every directory, the sticky rule inside sticky
 * directories. Iterative: a deep tree cannot overflow the stack.
 */
function collectPostOrder(b: PlanBuilder, root: Visit): Visit[] {
  const { cred } = b.ctx;
  const out: Visit[] = [];
  const stack: { v: Visit; expanded: boolean }[] = [{ v: root, expanded: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    if (top.expanded || top.v.node.type !== 'd') {
      stack.pop();
      out.push(top.v);
      if (out.length > BULK_MAX_NODES) fail('EINVAL', 'too-large');
      continue;
    }
    top.expanded = true;
    const dir = top.v.node;
    checkNotWellKnown(dir);
    orFail(checkSubtreeDir(cred, dir));
    for (const d of entriesOf(b, dir.ino)) {
      const child = b.view.inode(d.ino);
      if (child === undefined) throw new NotLoaded(dir.ino);
      if (isSynthIno(child.ino)) fail('EPERM', 'synthesised');
      if (isWellKnownDir(child.ino)) fail('EBUSY', 'well-known');
      if (stickyDenies(cred, dir, child)) fail('EPERM', 'sticky');
      checkNotBusy(b, child);
      stack.push({ v: { parent: dir, name: d.name, node: child }, expanded: false });
    }
  }
  return out;
}

/** `rm -r` (§3.12.1): one op, dentry then inode per node in post-order. */
export function planRemoveTree(b: PlanBuilder, e: Entry): UnlinkResult {
  checkNotWellKnown(e.node);
  orFail(checkRemove(b.ctx.cred, e.parent, e.node));
  checkNotBusy(b, e.node);
  const order = collectPostOrder(b, { parent: e.parent, name: e.name, node: e.node });
  const inodes = new Map<Uuid, InodeRec>();
  const removedLinks = new Map<Uuid, number>();
  for (const v of order) {
    inodes.set(v.node.ino, v.node);
    removedLinks.set(v.node.ino, (removedLinks.get(v.node.ino) ?? 0) + 1);
  }
  const digest = subtreeDigest(inodes.values());
  const seen = new Map<Uuid, number>();
  const freed: Uuid[] = [];
  let bytes = 0;
  for (const v of order) {
    const d: DentryRec = dentry(v.parent, v.name, v.node);
    b.delDentry(d);
    if (v.node.type === 'd') {
      b.delInode(v.node.ino);
      b.charge(v.node, -1);
      freed.push(v.node.ino);
      continue;
    }
    const n = (seen.get(v.node.ino) ?? 0) + 1;
    seen.set(v.node.ino, n);
    if (n === v.node.nlink) {
      b.delInode(v.node.ino);
      b.charge(v.node, -1);
      if (v.node.blob !== null) b.unrefBlob(v.node.blob, v.node.fs);
      freed.push(v.node.ino);
      bytes += v.node.size;
    }
  }
  // Hard-linked inodes with links outside the subtree survive with nlink reduced.
  for (const [ino, count] of removedLinks) {
    const n = inodes.get(ino);
    if (n === undefined || n.type === 'd' || count >= n.nlink) continue;
    b.putInode({ ...n, nlink: n.nlink - count, ctime: b.ctx.now });
  }
  b.dirChanged(e.parent.ino, -1);
  b.notes.deletes.push(e.path);
  for (const v of order)
    if (v !== order[order.length - 1])
      b.notes.deletes.push(entryPath(b.base, v.parent.ino, v.name));
  b.emit({
    topic: 'vfs.unlink',
    data: {
      items: [
        {
          parent: e.parent.ino,
          name: e.name,
          ino: e.node.ino,
          type: 'd',
          inos: freed,
          count: freed.length,
        },
      ],
    },
  });
  b.wire(
    { kind: 'unlink', parentIno: e.parent.ino, name: e.name, ino: e.node.ino, recursive: true },
    e.node.fs,
  );
  b.setBase({ kind: 'digest', rootIno: e.node.ino, digest });
  return { removed: freed.length, bytes, ino: e.node.ino };
}
