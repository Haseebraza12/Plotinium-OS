/**
 * Creating names: `mkdir` (with `parents`), `symlink`, `open` with `create`, `writeFile` of a new
 * name, and the rows shared with `copy` and conflicted copies (virtual-file-system.md §3.10, §3.12.2,
 * §3.7.1). A create needs w+x on the parent (§3.6.2); the mode is masked by the umask; the owner is
 * the caller's effective uid and primary gid.
 */
import type { Content } from '../content.ts';
import { EMPTY_CONTENT } from '../content.ts';
import { VfsError, fail } from '../errors.ts';
import { isAbsolute, splitPath, utf8Length, validatePath, validateSymlinkTarget } from '../path.ts';
import { checkCreate, createMode } from '../perm.ts';
import type { InodeRec, InodeType, Uuid } from '../store/records.ts';
import { entryPath } from '../view.ts';
import { checkWritable, forCreate, fsOfChild, locate, orFail } from './common.ts';
import type { PlanBuilder } from './plan.ts';

export interface NewNodeSpec {
  readonly type: InodeType;
  readonly mode: number;
  /** New bytes (hashed in phase 1); the blob is created if the store lacks it. */
  readonly content?: Content;
  /** An existing blob to reference instead (copies share content: no bytes are copied). */
  readonly blob?: { readonly sha: string; readonly size: number };
  /** False when the caller sends one op for the whole call (`copy`). */
  readonly wire?: boolean;
  readonly target?: string;
  readonly ino?: Uuid;
  readonly uid?: number;
  readonly gid?: number;
  readonly mtime?: number;
}

/**
 * Insert a new inode named `name` in `parent` with all its rows and side effects: the dentry, the
 * parent's version/nlink/times, the quota or tmpfs charge, the blob reference, the event and the
 * outbox member. Callers have already checked permissions and that the name is free.
 */
export function insertNode(
  b: PlanBuilder,
  parent: InodeRec,
  name: string,
  spec: NewNodeSpec,
): InodeRec {
  const { now, cred } = b.ctx;
  const fs = fsOfChild(parent);
  const content =
    spec.type !== 'f'
      ? null
      : (spec.content ??
        (spec.blob === undefined
          ? EMPTY_CONTENT
          : { sha: spec.blob.sha, size: spec.blob.size, chunkShas: [], chunks: [] }));
  const target = spec.type === 'l' ? (spec.target ?? '') : null;
  const rec: InodeRec = {
    ino: spec.ino ?? b.ctx.newIno(),
    fs,
    type: spec.type,
    mode: spec.mode,
    uid: spec.uid ?? cred.uid,
    gid: spec.gid ?? cred.gid,
    size: content?.size ?? (target === null ? 0 : utf8Length(target)),
    nlink: spec.type === 'd' ? 2 : 1,
    version: 1,
    atime: now,
    mtime: spec.mtime ?? now,
    ctime: now,
    btime: now,
    blob: content?.sha ?? null,
    target,
    ...(spec.type === 'd' ? { mir: 1 as const } : {}),
  };
  b.addInode(rec);
  b.addDentry({ parent: parent.ino, name, ino: rec.ino, dtype: rec.type });
  b.dirChanged(parent.ino, rec.type === 'd' ? 1 : 0);
  b.charge(rec, 1);
  if (content !== null) {
    if (spec.blob !== undefined && spec.content === undefined) b.refBlob(content.sha, 1);
    else b.refContent(content);
  }
  const path = entryPath(b.view, parent.ino, name);
  b.notes.creates.push(path);
  b.emit({
    topic: 'vfs.create',
    data: {
      items: [
        {
          ino: rec.ino,
          parent: parent.ino,
          name,
          type: rec.type,
          mode: rec.mode,
          uid: rec.uid,
          gid: rec.gid,
          size: rec.size,
          version: rec.version,
        },
      ],
    },
  });
  if (spec.wire === false) return rec;
  b.wire(
    {
      kind: 'create',
      parentIno: parent.ino,
      name,
      ino: rec.ino,
      type: rec.type,
      mode: rec.mode,
      ...(content === null ? {} : { blob: content.sha, size: content.size }),
      ...(target === null ? {} : { symlinkTarget: target }),
      mtime: rec.mtime,
    },
    fs,
    content === null ? [] : [content.sha],
  );
  return rec;
}

export interface MkdirResult {
  readonly ino: Uuid;
  /** Directories created (0 with `parents` when everything existed). */
  readonly created: number;
}

/** `mkdir` (§3.10): EEXIST when the name is taken (also `.`, `..`, `/`). */
export function planMkdir(
  b: PlanBuilder,
  path: string,
  mode?: number,
  parents = false,
): MkdirResult {
  checkWritable(b);
  if (parents) return mkdirParents(b, path, mode);
  const t = forCreate(b, path);
  if (t.node !== null) fail('EEXIST');
  orFail(checkCreate(b.ctx.cred, t.parent));
  const rec = insertNode(b, t.parent, t.name, {
    type: 'd',
    mode: createMode('d', mode, b.ctx.umask),
  });
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: rec.ino, created: 1 };
}

/**
 * `mkdir -p` (§3.12.2): every missing component in one op. Each prefix is resolved against the
 * overlay, so a level created a moment ago is found by the next one (and `a/../b` works).
 */
function mkdirParents(b: PlanBuilder, path: string, mode: number | undefined): MkdirResult {
  const v = validatePath(path);
  if (!v.ok) return fail(v.errno);
  const comps = splitPath(v.value);
  let last: Uuid = b.view.rootIno;
  let created = 0;
  for (let k = 1; k <= comps.length; k++) {
    const prefix = (isAbsolute(v.value) ? '/' : '') + comps.slice(0, k).join('/');
    const final = k === comps.length;
    let node: InodeRec | null;
    try {
      node = locate(b, prefix, { follow: true }).node;
    } catch (e) {
      if (!(e instanceof VfsError) || e.errno !== 'ENOENT') throw e;
      node = null;
    }
    if (node === null) {
      const t = forCreate(b, prefix);
      if (t.node !== null) fail('EEXIST'); // a dangling symlink occupies the name
      orFail(checkCreate(b.ctx.cred, t.parent));
      const m = final
        ? createMode('d', mode, b.ctx.umask)
        : createMode('d', undefined, b.ctx.umask) | 0o300;
      last = insertNode(b, t.parent, t.name, { type: 'd', mode: m }).ino;
      created++;
      continue;
    }
    if (node.type !== 'd') fail(final ? 'EEXIST' : 'ENOTDIR');
    last = node.ino;
  }
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: last, created };
}

/** `symlink(target, path)` (§3.7.1): the target is stored verbatim and may dangle. */
export function planSymlink(b: PlanBuilder, target: string, path: string): { ino: Uuid } {
  checkWritable(b);
  const tv = validateSymlinkTarget(target);
  if (!tv.ok) return fail(tv.errno);
  const t = forCreate(b, path);
  if (t.node !== null) fail('EEXIST');
  orFail(checkCreate(b.ctx.cred, t.parent));
  const rec = insertNode(b, t.parent, t.name, {
    type: 'l',
    mode: createMode('l', undefined, b.ctx.umask),
    target: tv.value,
  });
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: rec.ino };
}

export interface CreateFileResult {
  readonly ino: Uuid;
  readonly created: boolean;
  readonly version: number;
}

/**
 * `open` with `create` (§3.9.3 rule 8: the empty file is committed at once) and `writeFile` of a new
 * name. With `excl` a final symlink counts as existing (EEXIST); without it, an existing name is
 * returned untouched (`created: false`) and the caller opens it. A create through a dangling symlink
 * is refused with ENOENT (Plotinium simplification; Linux creates the link's target).
 */
export function planCreateFile(
  b: PlanBuilder,
  path: string,
  opts: { mode?: number; excl?: boolean; content?: Content } = {},
): CreateFileResult {
  checkWritable(b);
  const t = forCreate(b, path);
  if (t.node !== null) {
    if (opts.excl === true) fail('EEXIST');
    const target = t.node.type === 'l' ? locate(b, path, { follow: true }).node : t.node;
    if (target === null) return fail('ENOENT');
    if (target.type === 'd') fail('EISDIR');
    return { ino: target.ino, created: false, version: target.version };
  }
  orFail(checkCreate(b.ctx.cred, t.parent));
  const rec = insertNode(b, t.parent, t.name, {
    type: 'f',
    mode: createMode('f', opts.mode, b.ctx.umask),
    ...(opts.content === undefined ? {} : { content: opts.content }),
  });
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: rec.ino, created: true, version: rec.version };
}
