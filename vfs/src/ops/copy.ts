/**
 * `copy` / `cp [-r]` (virtual-file-system.md §3.12.3). The source is resolved without following a
 * final symlink when recursive (GNU `cp -r` is `-P`), with following otherwise. A new inode per
 * copied name shares its blob with the source (refcount + 1, no bytes copied). Merge rules at an
 * existing target: directory into directory merges; file onto file overwrites in place (the target
 * keeps its ino; `noClobber` skips it); file onto directory is EISDIR and directory onto file is
 * ENOTDIR for the whole op. A target inside the source subtree is EINVAL.
 *
 * New ids are `deriveIno(opId, srcIno)` so the server creates the same inodes from one `copy` op
 * (offline-and-sync.md §3.3.2); a second link of one source inode chains from the previous id.
 */
import { deriveIno } from '@plotinium/protocol';

import { subtreeDigest } from '../digest.ts';
import { NotLoaded, VfsError, fail } from '../errors.ts';
import { BULK_MAX_NODES } from '../limits.ts';
import { compareCodePoints } from '../names.ts';
import { splitPath, validatePath } from '../path.ts';
import { checkCopySource, checkCreate, checkOpen, checkRemove } from '../perm.ts';
import type { InodeRec, Uuid } from '../store/records.ts';
import { entryPath, isWithin } from '../view.ts';
import {
  checkNotBusy,
  checkNotSynth,
  checkWritable,
  entriesOf,
  forCreate,
  fsOfChild,
  locate,
  orFail,
} from './common.ts';
import { insertNode } from './create.ts';
import type { PlanBuilder } from './plan.ts';
import { dropLink } from './unlink.ts';

export interface CopyOpts {
  readonly recursive?: boolean;
  readonly noClobber?: boolean;
  readonly preserve?: boolean;
}

export interface CopyResult {
  readonly created: number;
  readonly bytes: number;
  readonly overwritten: readonly string[];
  readonly skipped: readonly string[];
}

interface CopyState {
  readonly b: PlanBuilder;
  readonly opts: CopyOpts;
  /** One `copy` op for the whole call (both sides synced); otherwise one create per node. */
  readonly oneOp: boolean;
  readonly derived: Map<Uuid, Uuid>;
  readonly overwritten: string[];
  readonly skipped: string[];
  created: number;
  bytes: number;
}

function childOf(b: PlanBuilder, dir: InodeRec, name: string): InodeRec | null {
  const c = b.view.child(dir.ino, name);
  if (c === 'NOT_LOADED') throw new NotLoaded(dir.ino);
  if (c === 'EAGAIN') return fail('EAGAIN', 'not-mirrored-offline');
  return c;
}

function newIno(st: CopyState, src: InodeRec): Uuid {
  const prev = st.derived.get(src.ino);
  const ino = deriveIno(st.b.ctx.opId, prev ?? src.ino);
  st.derived.set(src.ino, ino);
  return ino;
}

function modeOf(st: CopyState, src: InodeRec): number {
  if (src.type === 'l') return 0o777;
  return st.opts.preserve === true ? src.mode : src.mode & 0o777 & ~st.b.ctx.umask;
}

function createCopy(st: CopyState, src: InodeRec, parent: InodeRec, name: string): void {
  const { b, opts } = st;
  orFail(checkCreate(b.ctx.cred, parent));
  orFail(checkCopySource(b.ctx.cred, src));
  if (++st.created > BULK_MAX_NODES) fail('EINVAL', 'too-large');
  const owner =
    opts.preserve === true && b.ctx.cred.uid === 0 ? { uid: src.uid, gid: src.gid } : {};
  const rec = insertNode(b, parent, name, {
    type: src.type,
    mode: modeOf(st, src),
    ino: newIno(st, src),
    ...owner,
    ...(opts.preserve === true ? { mtime: src.mtime } : {}),
    ...(src.type === 'f' && src.blob !== null ? { blob: { sha: src.blob, size: src.size } } : {}),
    ...(src.type === 'l' && src.target !== null ? { target: src.target } : {}),
    wire: !st.oneOp,
  });
  st.bytes += src.type === 'd' ? 0 : src.size;
  if (src.type === 'd') {
    for (const e of sortedEntries(b, src)) copyInto(st, sourceOf(st, e.ino), rec, e.name);
  }
}

function sortedEntries(b: PlanBuilder, dir: InodeRec): { name: string; ino: Uuid }[] {
  return [...entriesOf(b, dir.ino)].sort((x, y) => compareCodePoints(x.name, y.name));
}

/**
 * Source nodes come from the overlay, so a `batch` copy sees the ops before it; the copy cannot
 * reach its own new inodes because a target inside the source is refused (EINVAL).
 */
function sourceOf(st: CopyState, ino: Uuid): InodeRec {
  return st.b.view.inode(ino) ?? fail('ENOENT');
}

/** Overwrite an existing regular file in place with the source's content (§3.12.3 table). */
function overwrite(
  st: CopyState,
  src: InodeRec,
  parent: InodeRec,
  name: string,
  dst: InodeRec,
): void {
  const { b } = st;
  checkNotSynth(dst);
  orFail(checkOpen(b.ctx.cred, dst, false, true));
  checkNotBusy(b, dst);
  const next = {
    ...dst,
    blob: src.blob,
    size: src.size,
    mtime: b.ctx.now,
    ctime: b.ctx.now,
    version: b.bump(dst),
  };
  b.putInode(next);
  b.charge(dst, -1);
  b.charge(next, 1);
  if (src.blob !== null) b.refBlob(src.blob, 1);
  if (dst.blob !== null) b.unrefBlob(dst.blob, dst.fs);
  st.overwritten.push(entryPath(b.view, parent.ino, name));
  b.notes.overwrites.push(entryPath(b.view, parent.ino, name));
  b.emit({
    topic: 'vfs.write',
    data: {
      items: [
        {
          ino: dst.ino,
          parent: parent.ino,
          version: next.version,
          size: next.size,
          blob: src.blob ?? '',
        },
      ],
    },
  });
  if (!st.oneOp && src.blob !== null) {
    b.wire(
      { kind: 'write', ino: dst.ino, blob: src.blob, size: src.size, mtime: next.mtime },
      dst.fs,
      [src.blob],
    );
  }
}

function copyInto(st: CopyState, src: InodeRec, parent: InodeRec, name: string): void {
  const { b } = st;
  const dst = childOf(b, parent, name);
  if (dst === null) {
    createCopy(st, src, parent, name);
    return;
  }
  if (src.type === 'd') {
    if (dst.type !== 'd') fail('ENOTDIR');
    orFail(checkCopySource(b.ctx.cred, src));
    orFail(checkCreate(b.ctx.cred, dst));
    for (const e of sortedEntries(b, src)) copyInto(st, sourceOf(st, e.ino), dst, e.name);
    return;
  }
  if (dst.type === 'd') fail('EISDIR');
  if (st.opts.noClobber === true) {
    st.skipped.push(entryPath(b.view, parent.ino, name));
    return;
  }
  orFail(checkCopySource(b.ctx.cred, src));
  if (src.type === 'f' && dst.type === 'f') {
    overwrite(st, src, parent, name, dst);
    return;
  }
  // A symlink on either side: the entry is replaced (unlink, then a fresh copy under the name).
  checkNotSynth(dst);
  orFail(checkRemove(b.ctx.cred, parent, dst));
  checkNotBusy(b, dst);
  st.overwritten.push(entryPath(b.view, parent.ino, name));
  b.notes.overwrites.push(entryPath(b.view, parent.ino, name));
  dropLink(b, parent.ino, name, dst);
  createCopy(st, src, parent, name);
}

/** Every inode of the source subtree, for the digest base (each once). */
function subtree(b: PlanBuilder, root: InodeRec): InodeRec[] {
  const out = new Map<Uuid, InodeRec>();
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined || out.has(n.ino)) continue;
    out.set(n.ino, n);
    if (n.type === 'd')
      for (const e of entriesOf(b, n.ino)) stack.push(b.view.inode(e.ino) ?? fail('ENOENT'));
  }
  return [...out.values()];
}

export function planCopy(
  b: PlanBuilder,
  from: string,
  to: string,
  opts: CopyOpts = {},
): CopyResult {
  checkWritable(b);
  const recursive = opts.recursive === true;
  const r = locate(b, from, { follow: !recursive });
  const src = r.node ?? fail('ENOENT');
  if (src.type === 'd' && !recursive) fail('EISDIR');
  const v = validatePath(from);
  const lexical = v.ok ? splitPath(v.value).at(-1) : undefined;
  const srcName =
    lexical === undefined || lexical === '.' || lexical === '..'
      ? splitPath(r.path).at(-1)
      : lexical;
  if (srcName === undefined) return fail('EINVAL'); // copying '/'

  let parent: InodeRec;
  let name: string;
  let into: InodeRec | null = null;
  try {
    into = locate(b, to, { follow: true }).node;
  } catch (e) {
    if (!(e instanceof VfsError) || e.errno !== 'ENOENT') throw e;
  }
  if (into !== null && into.type === 'd') {
    parent = into;
    name = srcName;
  } else {
    const t = forCreate(b, to);
    parent = t.parent;
    name = t.name;
  }
  if (src.type === 'd' && isWithin(b.view, parent.ino, src.ino)) fail('EINVAL');

  const oneOp = src.fs === 'root' && fsOfChild(parent) === 'root';
  const st: CopyState = {
    b,
    opts,
    oneOp,
    derived: new Map(),
    overwritten: [],
    skipped: [],
    created: 0,
    bytes: 0,
  };
  copyInto(st, src, parent, name);

  if (oneOp) {
    b.wire(
      {
        kind: 'copy',
        srcIno: src.ino,
        toParentIno: parent.ino,
        toName: name,
        recursive,
        ...(opts.preserve === true ? { preserve: true } : {}),
      },
      'root',
    );
  }
  b.setBase(
    src.type === 'd'
      ? { kind: 'digest', rootIno: src.ino, digest: subtreeDigest(subtree(b, src)) }
      : { kind: 'versions', entries: [{ ino: src.ino, version: src.version }] },
  );
  return { created: st.created, bytes: st.bytes, overwritten: st.overwritten, skipped: st.skipped };
}
