/**
 * Resolution and checks shared by the planners (virtual-file-system.md §3.5, §3.6.2, §3.3.5).
 *
 * Every planner re-resolves its paths against the plan's overlay (phase 1 under the intent locks),
 * so the checks see the current tree, and a directory that is not in memory surfaces as `NotLoaded`.
 */
import { INO, isWellKnownDir } from '@plotinium/protocol';

import { NotLoaded, VfsError, fail } from '../errors.ts';
import { resolve } from '../path.ts';
import type { ResolveOpts } from '../path.ts';
import type { Check } from '../perm.ts';
import { isSynthIno } from '../quota/quota.ts';
import type { DentryRec, FsId, InodeRec, Uuid, VfsDetail } from '../store/records.ts';
import { cwdNode, viewSource } from '../view.ts';
import type { PlanBuilder } from './plan.ts';
import { childFs } from './plan.ts';

export interface Located {
  readonly node: InodeRec | null;
  readonly parent: InodeRec | null;
  readonly name: string | null;
  /** Canonical absolute path (symlinks resolved). */
  readonly path: string;
}

export interface Entry {
  readonly node: InodeRec;
  readonly parent: InodeRec;
  readonly name: string;
  readonly path: string;
}

export function locate(b: PlanBuilder, path: string, opts: ResolveOpts): Located {
  const r = resolve(viewSource(b.view), b.ctx.cred, cwdNode(b.view, b.ctx.cwd), path, opts);
  if (r.kind === 'load') throw new NotLoaded(r.dir.ino);
  if (r.kind === 'err') throw new VfsError(r.errno, r.detail as VfsDetail | undefined);
  return r;
}

/** An existing node (follows the final symlink when `follow`). */
export function existing(b: PlanBuilder, path: string, follow: boolean): InodeRec {
  const r = locate(b, path, { follow });
  return r.node ?? fail('ENOENT');
}

/** The parent and name for creating `path`; `node` is whatever occupies the name now. */
export function forCreate(
  b: PlanBuilder,
  path: string,
): Located & { parent: InodeRec; name: string } {
  const r = locate(b, path, { follow: false, parent: 'create' });
  if (r.parent === null || r.name === null) return fail('EEXIST');
  return { ...r, parent: r.parent, name: r.name };
}

/** An existing entry to remove or rename (the final symlink is not followed). */
export function forRemove(b: PlanBuilder, path: string): Entry {
  const r = locate(b, path, { follow: false, parent: 'remove' });
  if (r.parent === null || r.name === null) return fail('EBUSY');
  if (r.node === null) return fail('ENOENT');
  return { node: r.node, parent: r.parent, name: r.name, path: r.path };
}

/** The slot a rename lands on: parent and name, occupied or not ('.'/'..' are EINVAL, '/' EBUSY). */
export function forTarget(
  b: PlanBuilder,
  path: string,
): Located & { parent: InodeRec; name: string } {
  const r = locate(b, path, { follow: false, parent: 'remove' });
  if (r.parent === null || r.name === null) return fail('EBUSY');
  return { ...r, parent: r.parent, name: r.name };
}

export function checkWritable(b: PlanBuilder): void {
  if (b.ctx.readOnly === true) fail('EPERM', 'ro-mount');
}

/** Any mutation of a synthesised file is EPERM for every uid, root included (§3.3.5). */
export function checkNotSynth(n: InodeRec): void {
  if (isSynthIno(n.ino)) fail('EPERM', 'synthesised');
}

/** Well-known directories cannot be removed or renamed by anyone (EBUSY, §3.3.5). */
export function checkNotWellKnown(n: InodeRec): void {
  if (n.ino === INO.ROOT || isWellKnownDir(n.ino)) fail('EBUSY', 'well-known');
}

/** A lease or lock held by another session or process (§3.16.3). */
export function checkNotBusy(b: PlanBuilder, n: InodeRec): void {
  if (b.ctx.busy?.(n.ino) === true) fail('EBUSY', 'lease');
}

/** Throw a permission check's errno (perm.ts returns null when allowed). */
export function orFail(check: Check): void {
  if (check !== null) fail(check);
}

/** Entries of a loaded directory, or `NotLoaded` / EAGAIN (unmirrored, offline: §3.17.2). */
export function entriesOf(b: PlanBuilder, dir: Uuid): readonly DentryRec[] {
  const e = b.view.entries(dir);
  if (e === 'NOT_LOADED') throw new NotLoaded(dir);
  if (e === 'EAGAIN') return fail('EAGAIN', 'not-mirrored-offline');
  return e;
}

export function fsOfChild(parent: InodeRec): FsId {
  return childFs(parent, INO.TMP);
}

export function inodeOf(b: PlanBuilder, ino: Uuid): InodeRec {
  return b.view.inode(ino) ?? fail('ENOENT');
}

/** The dentry naming `n` under `parent` (the entry a planner reached it through). */
export function dentry(parent: InodeRec, name: string, n: InodeRec): DentryRec {
  return { parent: parent.ino, name, ino: n.ino, dtype: n.type };
}
