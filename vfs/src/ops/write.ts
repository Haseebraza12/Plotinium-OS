/**
 * Content writes: the commit of a write session (`close`, `fsync`), `truncate` and `writeFile`
 * (virtual-file-system.md §3.9.3, §3.15). A write whose base version is no longer the committed
 * version never overwrites: the writer's content becomes a conflicted copy next to the file, or in
 * the writer's `~/lost+found`, and the call succeeds with `conflict.keptAs` (VFS-10).
 */
import { INO, deriveIno } from '@plotinium/protocol';

import type { Content } from '../content.ts';
import { NotLoaded, fail } from '../errors.ts';
import { conflictName } from '../names.ts';
import { W, X, checkOpen, createMode, may } from '../perm.ts';
import { isSynthIno } from '../quota/quota.ts';
import type { InodeRec, Uuid } from '../store/records.ts';
import { entryPath } from '../view.ts';
import {
  checkNotBusy,
  checkNotSynth,
  checkWritable,
  forCreate,
  inodeOf,
  locate,
  orFail,
} from './common.ts';
import { insertNode } from './create.ts';
import type { PlanBuilder } from './plan.ts';

export interface KeptAs {
  readonly ino: Uuid;
  readonly path: string;
}

export interface WriteResult {
  readonly ino: Uuid;
  readonly version: number;
  readonly conflict?: { readonly keptAs: KeptAs };
}

/** The entry a description reached its file through (`pathAtOpen`), used for copies and events. */
export interface Via {
  readonly parent: Uuid;
  readonly name: string;
}

/** The writer's `~/lost+found`, created on demand (0700, owned by the writer, §3.15.4). */
function lostFound(b: PlanBuilder): InodeRec {
  const uid = b.ctx.cred.uid;
  const homeIno = uid === 0 ? INO.ROOT_HOME : b.view.user(uid)?.homeIno;
  const home = homeIno === undefined ? undefined : b.view.inode(homeIno);
  if (home === undefined) return fail('EACCES');
  const c = b.view.child(home.ino, 'lost+found');
  if (c === 'NOT_LOADED') throw new NotLoaded(home.ino);
  if (typeof c === 'object' && c !== null) return c.type === 'd' ? c : fail('EEXIST');
  return insertNode(b, home, 'lost+found', { type: 'd', mode: 0o700 });
}

/**
 * Keep `content` as a conflicted copy of `orig` (§3.15.3, §3.15.4): next to the original when the
 * writer has w+x there, otherwise in `~/lost+found`. The copy's ino is derived from the op and the
 * original, as the server derives it (offline-and-sync.md §3.3.2).
 */
export function keepConflictedCopy(
  b: PlanBuilder,
  orig: { ino: Uuid; name: string; parent: Uuid | null },
  content: Content,
): KeptAs {
  const { cred } = b.ctx;
  const origParent = orig.parent === null ? undefined : b.view.inode(orig.parent);
  const dir = origParent !== undefined && may(cred, origParent, W | X) ? origParent : lostFound(b);
  const taken = (candidate: string): boolean => {
    const c = b.view.child(dir.ino, candidate);
    if (c === 'NOT_LOADED') throw new NotLoaded(dir.ino);
    return c !== null && c !== 'EAGAIN';
  };
  const name = conflictName(orig.name, b.ctx.username(cred.uid), b.ctx.date, taken);
  const rec = insertNode(b, dir, name, {
    type: 'f',
    mode: createMode('f', undefined, b.ctx.umask),
    content,
    ino: deriveIno(b.ctx.opId, orig.ino),
  });
  const keptAs = { ino: rec.ino, path: entryPath(b.view, dir.ino, name) };
  const origPath =
    origParent === undefined ? keptAs.path : entryPath(b.view, origParent.ino, orig.name);
  b.emit({
    topic: 'vfs.conflict',
    data: {
      ino: orig.ino,
      parent: origParent?.ino ?? dir.ino,
      path: origPath,
      keptAs: { ...keptAs, parent: dir.ino },
      by: b.ctx.username(cred.uid),
      source: 'local',
    },
  });
  return keptAs;
}

/**
 * Commit `content` to file `ino` against `baseVersion` (the version at open, or `expectedVersion`).
 * Permission was checked when the description was opened (POSIX); a file unlinked meanwhile keeps
 * the content as a conflicted copy (§3.9.3 rule 7).
 */
export function planContentWrite(
  b: PlanBuilder,
  ino: Uuid,
  content: Content,
  baseVersion: number,
  via: Via | null,
): WriteResult {
  checkWritable(b);
  const node = b.view.inode(ino);
  if (node === undefined) {
    const kept = keepConflictedCopy(
      b,
      { ino, name: via?.name ?? ino, parent: via?.parent ?? null },
      content,
    );
    return { ino, version: 0, conflict: { keptAs: kept } };
  }
  checkNotSynth(node);
  if (node.type === 'd') fail('EISDIR');
  checkNotBusy(b, node);
  const link = via ?? b.view.links(ino)[0] ?? null;
  if (node.version !== baseVersion) {
    const kept = keepConflictedCopy(
      b,
      { ino, name: link?.name ?? ino, parent: link?.parent ?? null },
      content,
    );
    return { ino, version: node.version, conflict: { keptAs: kept } };
  }
  b.guard(ino);
  const next: InodeRec = {
    ...node,
    blob: content.sha,
    size: content.size,
    mtime: b.ctx.now,
    ctime: b.ctx.now,
    version: b.bump(node),
  };
  b.putInode(next);
  if (!isSynthIno(node.ino)) {
    b.charge(node, -1);
    b.charge(next, 1);
  }
  b.refContent(content);
  if (node.blob !== null) b.unrefBlob(node.blob, node.fs);
  if (link !== null) b.notes.overwrites.push(entryPath(b.view, link.parent, link.name));
  b.emit({
    topic: 'vfs.write',
    data: {
      items: [
        {
          ino,
          parent: link?.parent ?? b.view.rootIno,
          version: next.version,
          size: next.size,
          blob: content.sha,
        },
      ],
    },
  });
  b.wire(
    { kind: 'write', ino, blob: content.sha, size: content.size, mtime: next.mtime },
    node.fs,
    [content.sha],
  );
  b.setBase({ kind: 'versions', entries: [{ ino, version: baseVersion }] });
  return { ino, version: next.version };
}

/** `truncate {path, size}` (§3.10): the caller builds the truncated content from the old bytes. */
export function planTruncate(b: PlanBuilder, path: string, content: Content): WriteResult {
  const node = locate(b, path, { follow: true }).node ?? fail('ENOENT');
  if (node.type === 'd') fail('EISDIR');
  checkNotSynth(node);
  orFail(checkOpen(b.ctx.cred, node, false, true));
  return planContentWrite(b, node.ino, content, node.version, b.view.links(node.ino)[0] ?? null);
}

export interface WriteFileOpts {
  readonly create?: boolean;
  readonly excl?: boolean;
  readonly mode?: number;
  readonly expectedVersion?: number;
}

/** `writeFile` (§3.10): replace the whole content in one op, or create the name with it. */
export function planWriteFile(
  b: PlanBuilder,
  path: string,
  content: Content,
  opts: WriteFileOpts = {},
): WriteResult & { created: boolean } {
  checkWritable(b);
  const t = forCreate(b, path);
  if (t.node === null) {
    if (opts.create === false) return fail('ENOENT');
    orFail(t.parent.type === 'd' ? null : 'ENOTDIR');
    const created = createNamed(b, t.parent, t.name, content, opts.mode);
    return { ino: created.ino, version: created.version, created: true };
  }
  if (opts.excl === true) fail('EEXIST');
  const node =
    t.node.type === 'l' ? (locate(b, path, { follow: true }).node ?? fail('ENOENT')) : t.node;
  if (node.type === 'd') fail('EISDIR');
  checkNotSynth(node);
  orFail(checkOpen(b.ctx.cred, node, false, true));
  const via =
    node === t.node ? { parent: t.parent.ino, name: t.name } : (b.view.links(node.ino)[0] ?? null);
  const r = planContentWrite(
    b,
    node.ino,
    content,
    opts.expectedVersion ?? inodeOf(b, node.ino).version,
    via,
  );
  return { ...r, created: false };
}

function createNamed(
  b: PlanBuilder,
  parent: InodeRec,
  name: string,
  content: Content,
  mode: number | undefined,
): InodeRec {
  const { cred, umask } = b.ctx;
  orFail(may(cred, parent, W | X) ? null : 'EACCES');
  const rec = insertNode(b, parent, name, {
    type: 'f',
    mode: createMode('f', mode, umask),
    content,
  });
  b.setBase({ kind: 'versions', entries: [] });
  return rec;
}
