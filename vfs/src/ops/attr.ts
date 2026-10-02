/**
 * Metadata: `chmod [-R]`, `chown [-R]` (root only) and `utimes` (virtual-file-system.md §3.6.2,
 * §3.12.6). `chmod` always follows a final symlink (a symlink has no mode of its own); `chmod -R`
 * skips symlinks inside the tree; `chown` follows unless `noFollow`, and `chown -R` changes a
 * symlink's own owner without following it (GNU `-P`). A changed mode, uid or gid bumps the version;
 * times do not (§3.2). Nothing changes unless every inode passes (first failure is the errno).
 */
import { subtreeDigest } from '../digest.ts';
import { fail } from '../errors.ts';
import { BULK_MAX_NODES } from '../limits.ts';
import {
  R,
  X,
  applyModeSpec,
  checkChmod,
  checkChown,
  checkUtimes,
  may,
  toWireMode,
} from '../perm.ts';
import type { ModeSpec } from '../perm.ts';
import type { InodeRec, Uuid } from '../store/records.ts';
import { dirPath, entryPath } from '../view.ts';
import { checkNotBusy, checkNotSynth, checkWritable, entriesOf, locate, orFail } from './common.ts';
import type { PlanBuilder } from './plan.ts';

interface Found {
  readonly node: InodeRec;
  readonly path: string;
  readonly parent: Uuid;
}

function find(b: PlanBuilder, path: string, follow: boolean): Found {
  const r = locate(b, path, { follow });
  const node = r.node ?? fail('ENOENT');
  const parent =
    node.type === 'd'
      ? (b.view.dirEntry(node.ino)?.parent ?? node.ino)
      : (b.view.links(node.ino)[0]?.parent ?? b.view.rootIno);
  return { node, path: r.path, parent };
}

/**
 * Every inode of a subtree once, pre-order, without following symlinks; enumerating a directory
 * needs r+x on it (EACCES), as `chmod -R` and `chown -R` require (§3.6.2).
 */
function subtreeOf(b: PlanBuilder, root: InodeRec): { node: InodeRec; path: string }[] {
  const out: { node: InodeRec; path: string }[] = [];
  const seen = new Set<Uuid>();
  const stack: { node: InodeRec; path: string }[] = [
    { node: root, path: root.type === 'd' ? dirPath(b.view, root.ino) : '' },
  ];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined || seen.has(top.node.ino)) continue;
    seen.add(top.node.ino);
    out.push(top);
    if (out.length > BULK_MAX_NODES) fail('EINVAL', 'too-large');
    if (top.node.type !== 'd') continue;
    orFail(may(b.ctx.cred, top.node, R | X) ? null : 'EACCES');
    for (const e of entriesOf(b, top.node.ino)) {
      const child = b.view.inode(e.ino) ?? fail('ENOENT');
      stack.push({ node: child, path: entryPath(b.view, top.node.ino, e.name) });
    }
  }
  return out;
}

export interface ChangedResult {
  readonly changed: number;
}

/** `chmod(path, spec, recursive)`: owner or root on every affected inode (EPERM). */
export function planChmod(
  b: PlanBuilder,
  path: string,
  spec: ModeSpec,
  recursive = false,
): ChangedResult {
  checkWritable(b);
  const f = find(b, path, true);
  const { cred, umask } = b.ctx;
  const all = recursive
    ? subtreeOf(b, f.node).filter((x) => x.node.type !== 'l')
    : [{ node: f.node, path: f.path }];
  for (const { node } of all) {
    checkNotSynth(node);
    orFail(checkChmod(cred, node));
    checkNotBusy(b, node);
  }
  const items: { ino: Uuid; mode: number; version: number }[] = [];
  for (const { node, path: p } of all) {
    const mode = applyModeSpec(spec, node.mode, node.type === 'd', umask);
    if (mode === node.mode) continue;
    const next = { ...node, mode, ctime: b.ctx.now, version: b.bump(node) };
    b.putInode(next);
    items.push({ ino: node.ino, mode, version: next.version });
    b.notes.chmods.push({ path: p, from: node.mode, to: mode });
  }
  if (items.length === 0) return { changed: 0 };
  b.emit({
    topic: 'vfs.chmod',
    data: { root: f.node.ino, rootParent: f.parent, recursive, items },
  });
  b.wire({ kind: 'chmod', ino: f.node.ino, change: toWireMode(spec, umask), recursive }, f.node.fs);
  b.setBase(
    recursive
      ? { kind: 'digest', rootIno: f.node.ino, digest: subtreeDigest(all.map((x) => x.node)) }
      : { kind: 'versions', entries: [{ ino: f.node.ino, version: f.node.version }] },
  );
  return { changed: items.length };
}

export interface ChownArgs {
  readonly uid?: number;
  readonly gid?: number;
  readonly recursive?: boolean;
  readonly noFollow?: boolean;
}

/** `chown`: root only (Spec §9.3); the quota charge moves to the new owner (EDQUOT, §3.8). */
export function planChown(b: PlanBuilder, path: string, args: ChownArgs): ChangedResult {
  checkWritable(b);
  if (args.uid === undefined && args.gid === undefined) fail('EINVAL');
  const f = find(b, path, args.noFollow !== true);
  const { cred } = b.ctx;
  orFail(checkChown(cred));
  if (args.uid !== undefined && b.view.user(args.uid) === undefined) fail('EINVAL');
  if (args.gid !== undefined && b.ctx.groupExists?.(args.gid) === false) fail('EINVAL');
  const recursive = args.recursive === true;
  const all = recursive ? subtreeOf(b, f.node) : [{ node: f.node, path: f.path }];
  for (const { node } of all) {
    checkNotSynth(node);
    checkNotBusy(b, node);
  }
  const items: { ino: Uuid; uid: number; gid: number; version: number }[] = [];
  for (const { node, path: p } of all) {
    const uid = args.uid ?? node.uid;
    const gid = args.gid ?? node.gid;
    if (uid === node.uid && gid === node.gid) continue;
    const next = { ...node, uid, gid, ctime: b.ctx.now, version: b.bump(node) };
    b.putInode(next);
    b.charge(node, -1);
    b.charge(next, 1);
    items.push({ ino: node.ino, uid, gid, version: next.version });
    b.notes.chowns.push({ path: p, uid, gid });
  }
  if (items.length === 0) return { changed: 0 };
  b.emit({
    topic: 'vfs.chown',
    data: { root: f.node.ino, rootParent: f.parent, recursive, items },
  });
  b.wire(
    {
      kind: 'chown',
      ino: f.node.ino,
      ...(args.uid === undefined ? {} : { uid: args.uid }),
      ...(args.gid === undefined ? {} : { gid: args.gid }),
      recursive,
      ...(args.noFollow === true ? { noFollow: true } : {}),
    },
    f.node.fs,
  );
  b.setBase(
    recursive
      ? { kind: 'digest', rootIno: f.node.ino, digest: subtreeDigest(all.map((x) => x.node)) }
      : { kind: 'versions', entries: [{ ino: f.node.ino, version: f.node.version }] },
  );
  return { changed: items.length };
}

export interface UtimesArgs {
  readonly atime?: number | 'now';
  readonly mtime?: number | 'now';
  readonly noFollow?: boolean;
}

/** `utimes`: "now" needs owner or w (EACCES); explicit times need owner or root (EPERM). */
export function planUtimes(b: PlanBuilder, path: string, args: UtimesArgs): { ino: Uuid } {
  checkWritable(b);
  const f = find(b, path, args.noFollow !== true);
  checkNotSynth(f.node);
  const explicit = typeof args.atime === 'number' || typeof args.mtime === 'number';
  orFail(checkUtimes(b.ctx.cred, f.node, explicit));
  const now = b.ctx.now;
  const mtime =
    args.mtime === undefined
      ? args.atime === undefined
        ? now
        : f.node.mtime
      : args.mtime === 'now'
        ? now
        : args.mtime;
  const atime =
    args.atime === undefined
      ? args.mtime === undefined
        ? now
        : f.node.atime
      : args.atime === 'now'
        ? now
        : args.atime;
  b.putInode({ ...f.node, mtime, atime, ctime: now });
  b.emit({ topic: 'vfs.utimes', data: { items: [{ ino: f.node.ino, mtime }] } });
  b.wire({ kind: 'utimes', ino: f.node.ino, mtime }, f.node.fs);
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: f.node.ino };
}
