/**
 * The file-system system calls (syscall-abi.md §4.4.2; virtual-file-system.md §3.9, §3.10, §3.12).
 *
 * Each handler takes the caller from the port (C3), resolves its paths, checks permissions through
 * the vfs planners (vfs/perm, the whole §3.6.2 matrix, repeated in phase 1 after stage 5), runs the
 * vfs planner and applies the plan through the store adapter (`KernelFs.mutate`: one transaction,
 * then the tree, then the events). Errors leave as KernelErrors of the closed errno set.
 *
 * Descriptors (§3.9, C4 as refined by syscall-abi.md §4.4.2): `open` snapshots the content;
 * `write` buffers into the description's session (EDQUOT beyond the owner's headroom poisons it) and
 * commits the session as ONE transaction per call, based on `expectedVersion` or the version this
 * fd last saw; a stale base never overwrites: the content becomes a conflicted copy and the call
 * succeeds with `conflict.keptAs` (VFS-10). `close` removes a file its own poisoned open created.
 */
import type { ArgsOf, CallName, Quota, RetOf, Stat } from '@plotinium/protocol';
import type { BatchPlan, InodeRec, OpenFile, ReadCtx, Uuid, Via } from '@plotinium/vfs';
import {
  EMPTY_CONTENT,
  WriteSession,
  checkOpen,
  contentOf,
  entryPath,
  forCreate,
  fromModeChange,
  isSynthIno,
  locate,
  planBatch,
  planChmod,
  planChown,
  planContentWrite,
  planCopy,
  planCreateFile,
  planLink,
  planMkdir,
  planRename,
  planRmdir,
  planSymlink,
  planTruncate,
  planUnlink,
  planUtimes,
  planWriteFile,
  quotaReport,
  readdir as vfsReaddir,
  readlink as vfsReadlink,
  statPath,
  toStat,
  VfsError,
} from '@plotinium/vfs';
import type { FsView, PlanBuilder } from '@plotinium/vfs';

import type { Caller } from '../ipc/ports.ts';
import { chunkSource, resized, toArrayBuffer } from './content.ts';
import type { ErrCtx } from './errno.ts';
import { fsError, toKernelError } from './errno.ts';
import type { DescState } from './fds.ts';
import type { FsActor, KernelFs, Mutated } from './kfs.ts';
import { actorOf } from './kfs.ts';

type Ret<C extends CallName> = RetOf<C> | Promise<RetOf<C>>;

/** Run `fn`, mapping whatever it throws to a KernelError (sync or async). */
function guarded<T>(err: ErrCtx, fn: () => T | Promise<T>): T | Promise<T> {
  try {
    const r = fn();
    if (r instanceof Promise) return r.catch((e: unknown) => Promise.reject(toKernelError(e, err)));
    return r;
  } catch (e) {
    throw toKernelError(e, err);
  }
}

/** The entry a node was reached through (for conflicted copies and write events). */
function viaOf(view: FsView, n: InodeRec, path: string): Via | null {
  if (n.type === 'd') {
    const d = view.dirEntry(n.ino);
    return d === undefined ? null : { parent: d.parent, name: d.name };
  }
  const links = view.links(n.ino);
  const l = links.find((x) => entryPath(view, x.parent, x.name) === path) ?? links[0];
  return l === undefined ? null : { parent: l.parent, name: l.name };
}

function mutation(r: Mutated<unknown>): { opId: Uuid; sync: 'applied' | 'pending' } {
  return { opId: r.opId, sync: r.sync };
}

export class FsHandlers {
  readonly fs: KernelFs;

  constructor(fs: KernelFs) {
    this.fs = fs;
  }

  private readCtx(actor: FsActor): ReadCtx {
    return { view: this.fs.tree, cred: actor.cred, cwd: this.fs.cwdOf(actor) };
  }

  /** A stat with a synthesised file's fresh snapshot size and time (§3.3.5). */
  private statOf(n: InodeRec): Stat {
    const st = toStat(n);
    if (!isSynthIno(n.ino)) return st;
    const bytes = this.fs.synthContent(n.ino);
    return { ...st, size: bytes?.byteLength ?? 0, mtime: this.fs.now() };
  }

  // -- descriptors ---------------------------------------------------------------------------

  open(caller: Caller, a: ArgsOf<'open'>): Promise<RetOf<'open'>> {
    const err: ErrCtx = { call: 'open', path: a.path };
    return Promise.resolve(guarded(err, () => this.doOpen(caller, a, err)));
  }

  private async doOpen(caller: Caller, a: ArgsOf<'open'>, err: ErrCtx): Promise<RetOf<'open'>> {
    const fs = this.fs;
    const actor = actorOf(caller.pcb);
    const p = fs.abs(actor, a.path);
    const read = a.flags === 'r' || a.flags === 'rw';
    const write = a.flags !== 'r';
    const trunc = a.trunc === true;
    let created = false;
    if (a.create === true) {
      const r = await fs.mutate(
        actor,
        'create',
        `open ${p}`,
        (b) => planCreateFile(b, p, { mode: a.mode, excl: a.excl === true }),
        { err },
      );
      created = r.value.created;
    }
    const res = await fs.resolvePath(actor, p, { follow: a.follow }, err);
    const node = res.node ?? fsFail('ENOENT', err);
    if (node.type === 'l') throw fsError('ELOOP', undefined, err);
    if (node.type === 'd' && (write || trunc)) throw fsError('EISDIR', undefined, err);
    const synth = isSynthIno(node.ino);
    if (synth && (write || trunc)) throw fsError('EPERM', 'synthesised', err);
    if (!created) {
      const c = checkOpen(actor.cred, node, read, write || trunc);
      if (c !== null) throw fsError(c, undefined, err);
    }
    if ((write || trunc) && fs.isBusy(node.ino, actor.pid)) throw fsError('EBUSY', 'lease', err);
    let cur = node;
    if (trunc && node.type === 'f' && node.size > 0 && !created) {
      const via = viaOf(fs.tree, node, res.path);
      await fs.mutate(
        actor,
        'write',
        `truncate ${p}`,
        (b) => planContentWrite(b, node.ino, EMPTY_CONTENT, node.version, via),
        { err },
      );
      cur = fs.tree.inode(node.ino) ?? node;
    }
    let snapBlob = cur.type === 'f' ? cur.blob : null;
    let snapSize = cur.type === 'f' ? cur.size : 0;
    let parts: Uint8Array[] | null = cur.type === 'd' ? [] : null;
    if (synth) {
      const snap = fs.synthSnapshot(fs.synthContent(cur.ino) ?? new Uint8Array(0));
      snapBlob = snap.sha;
      snapSize = snap.size;
      parts = snap.parts;
    }
    const state: DescState = { rec: cur, parts, sessionBlob: cur.blob, synth };
    const fd = fs.fds.open(
      caller.pcb,
      {
        ino: cur.ino,
        fs: cur.fs,
        type: cur.type,
        flags: {
          read,
          write,
          append: a.flags === 'a',
          create: a.create === true,
          excl: a.excl === true,
          noFollow: !a.follow,
          mode: a.mode,
        },
        snapshotBlob: snapBlob,
        snapshotSize: snapSize,
        versionAtOpen: cur.version,
        createdByOpen: created,
        pathAtOpen: res.path,
        via: viaOf(fs.tree, cur, res.path),
      },
      state,
    );
    return { fd, ino: cur.ino, type: cur.type, version: cur.version, size: snapSize };
  }

  /** Load a description's snapshot chunks (before its first read or write). */
  private async ensureParts(f: OpenFile, st: DescState): Promise<void> {
    if (st.parts !== null) return;
    st.parts = f.snapshotBlob === null ? [] : await this.fs.content.load(f.snapshotBlob);
  }

  read(caller: Caller, a: ArgsOf<'read'>): Ret<'read'> {
    const err: ErrCtx = { call: 'read' };
    return guarded(err, () => {
      const pid = caller.pcb.pid;
      const f = this.fs.fds.get(pid, a.fd);
      if (f.type === 'd') throw fsError('EISDIR', undefined, err);
      if (f.flags.read !== true) throw fsError('EBADF', undefined, err);
      const st = this.fs.fds.state(f);
      const take = (): ArrayBuffer =>
        toArrayBuffer(
          this.fs.fds.oft.read(pid, a.fd, a.len, chunkSource(st.parts ?? []), a.offset),
        );
      if (f.session !== null || st.parts !== null) return take();
      return this.ensureParts(f, st).then(take);
    });
  }

  write(caller: Caller, a: ArgsOf<'write'>): Promise<RetOf<'write'>> {
    const err: ErrCtx = { call: 'write' };
    const fs = this.fs;
    return fs.exclusive(() =>
      Promise.resolve(
        guarded(err, async () => {
          const pid = caller.pcb.pid;
          const f = fs.fds.get(pid, a.fd);
          if (f.flags.write !== true) throw fsError('EBADF', undefined, err);
          if (f.type === 'd') throw fsError('EISDIR', undefined, err);
          if (f.poisoned !== undefined) throw fsError(f.poisoned, undefined, err);
          const st = fs.fds.state(f);
          await this.ensureParts(f, st);
          const node = fs.tree.inode(f.ino);
          if (f.flags.append === true && node !== undefined && node.blob !== st.sessionBlob) {
            // Append re-bases on the current local version: the kernel serialises local appends.
            const parts = node.blob === null ? [] : await fs.content.load(node.blob);
            f.session = new WriteSession(node.size, chunkSource(parts));
            st.sessionBlob = node.blob;
            f.versionAtOpen = node.version;
          }
          const data = new Uint8Array(a.data);
          const n = fs.fds.oft.write(
            pid,
            a.fd,
            data,
            fs.headroom(node ?? st.rec),
            chunkSource(st.parts ?? []),
            a.offset,
          );
          const r = await this.commitSession(actorOf(caller.pcb), f, st, a.expectedVersion, err);
          return { bytes: n, ...r };
        }),
      ),
    );
  }

  /**
   * Commit a description's session as one op (the caller holds the mutation lock). A failed commit
   * (EDQUOT, EIO) poisons the description (§3.9.3 rule 6).
   */
  private async commitSession(
    actor: FsActor,
    f: OpenFile,
    st: DescState,
    expectedVersion: number | undefined,
    err: ErrCtx,
  ): Promise<{
    version: number;
    opId: Uuid;
    sync: 'applied' | 'pending';
    conflict?: { keptAs: { ino: Uuid; path: string } };
  }> {
    const fs = this.fs;
    const bytes = f.session?.bytes() ?? new Uint8Array(0);
    if (bytes === 'EAGAIN') throw fsError('EAGAIN', 'content-not-cached', err);
    const content = contentOf(bytes, fs.now());
    const base = expectedVersion ?? f.versionAtOpen;
    let r: Mutated<{ version: number; conflict?: { keptAs: { ino: Uuid; path: string } } }>;
    try {
      r = await fs.mutateLocked(
        actor,
        'write',
        `write ${f.pathAtOpen}`,
        (b) => planContentWrite(b, f.ino, content, base, f.via),
        { err },
      );
    } catch (e) {
      const k = toKernelError(e, err);
      if (k.errno === 'EDQUOT' || k.errno === 'EIO') f.poisoned = k.errno;
      throw k;
    }
    const v = r.value;
    if (v.conflict === undefined) {
      f.versionAtOpen = v.version;
      st.sessionBlob = content.sha;
      st.rec = fs.tree.inode(f.ino) ?? st.rec;
    }
    return {
      version: v.version,
      ...mutation(r),
      ...(v.conflict === undefined
        ? {}
        : { conflict: { keptAs: { ino: v.conflict.keptAs.ino, path: v.conflict.keptAs.path } } }),
    };
  }

  close(caller: Caller, a: ArgsOf<'close'>): Ret<'close'> {
    const err: ErrCtx = { call: 'close' };
    return guarded(err, () => {
      const closed = this.fs.fds.close(caller.pcb, a.fd);
      if (closed === null || closed.file.poisoned === undefined || !closed.file.createdByOpen) {
        return {};
      }
      return this.fs.finalise(closed, actorOf(caller.pcb)).then(() => ({}));
    });
  }

  fstat(caller: Caller, a: ArgsOf<'fstat'>): Ret<'fstat'> {
    return guarded({ call: 'fstat' }, () => {
      const f = this.fs.fds.get(caller.pcb.pid, a.fd);
      const st = this.fs.fds.state(f);
      const node = this.fs.tree.inode(f.ino);
      if (st.synth) return { ...toStat(st.rec), size: f.snapshotSize };
      return node === undefined ? { ...toStat(st.rec), nlink: 0 } : toStat(node);
    });
  }

  seek(caller: Caller, a: ArgsOf<'seek'>): Ret<'seek'> {
    const err: ErrCtx = { call: 'seek' };
    return guarded(err, () => {
      const pid = caller.pcb.pid;
      const f = this.fs.fds.get(pid, a.fd);
      if (f.type !== 'f') throw fsError('EINVAL', 'not-seekable', err);
      const st = this.fs.fds.state(f);
      const size = st.synth ? f.snapshotSize : (this.fs.tree.inode(f.ino)?.size ?? f.snapshotSize);
      return { offset: this.fs.fds.oft.seek(pid, a.fd, a.offset, a.whence, size) };
    });
  }

  // -- lookups -------------------------------------------------------------------------------

  stat(caller: Caller, a: ArgsOf<'stat'>): Ret<'stat'> {
    return this.lookup(caller, 'stat', a.path, a.follow);
  }

  lstat(caller: Caller, a: ArgsOf<'lstat'>): Ret<'lstat'> {
    return this.lookup(caller, 'lstat', a.path, false);
  }

  private lookup(
    caller: Caller,
    call: 'stat' | 'lstat',
    path: string,
    follow: boolean,
  ): Stat | Promise<Stat> {
    const err: ErrCtx = { call, path };
    return guarded(err, () => {
      const actor = actorOf(caller.pcb);
      const p = this.fs.abs(actor, path);
      return this.fs.read(() => {
        const st = statPath(this.readCtx(actor), p, follow);
        const n = this.fs.tree.inode(st.ino);
        return n === undefined ? st : this.statOf(n);
      }, err);
    });
  }

  readdir(caller: Caller, a: ArgsOf<'readdir'>): Ret<'readdir'> {
    const err: ErrCtx = { call: 'readdir', path: a.path };
    return guarded(err, () => {
      const actor = actorOf(caller.pcb);
      const p = this.fs.abs(actor, a.path);
      return this.fs.read(() => {
        const page = vfsReaddir(this.readCtx(actor), p, {
          ...(a.cursor === undefined ? {} : { cursor: a.cursor }),
          ...(a.limit === undefined ? {} : { limit: a.limit }),
          ...(a.plus === undefined ? {} : { plus: a.plus }),
        });
        return {
          entries: page.entries.map((e) => ({
            name: e.name,
            ino: e.ino,
            type: e.type,
            ...(e.stat === undefined ? {} : { stat: e.stat }),
          })),
          ...(page.next === undefined ? {} : { next: page.next }),
          dirVersion: page.dirVersion,
        };
      }, err);
    });
  }

  readlink(caller: Caller, a: ArgsOf<'readlink'>): Ret<'readlink'> {
    const err: ErrCtx = { call: 'readlink', path: a.path };
    return guarded(err, () => {
      const actor = actorOf(caller.pcb);
      const p = this.fs.abs(actor, a.path);
      return this.fs.read(() => ({ target: vfsReadlink(this.readCtx(actor), p) }), err);
    });
  }

  // -- mutations -----------------------------------------------------------------------------

  private run<T>(
    caller: Caller,
    call: CallName,
    path: string,
    fn: (actor: FsActor, err: ErrCtx) => Promise<T>,
  ): Promise<T> {
    const err: ErrCtx = { call, path };
    return Promise.resolve(guarded(err, () => fn(actorOf(caller.pcb), err)));
  }

  mkdir(caller: Caller, a: ArgsOf<'mkdir'>): Promise<RetOf<'mkdir'>> {
    return this.run(caller, 'mkdir', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const r = await this.fs.mutate(
        actor,
        'create',
        `mkdir ${p}`,
        (b) => planMkdir(b, p, a.mode, a.parents === true),
        { err },
      );
      return { ino: r.value.ino, created: r.value.created, ...mutation(r) };
    });
  }

  rmdir(caller: Caller, a: ArgsOf<'rmdir'>): Promise<RetOf<'rmdir'>> {
    return this.run(caller, 'rmdir', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const r = await this.fs.mutate(actor, 'unlink', `rmdir ${p}`, (b) => planRmdir(b, p), {
        err,
      });
      return mutation(r);
    });
  }

  unlink(caller: Caller, a: ArgsOf<'unlink'>): Promise<RetOf<'unlink'>> {
    return this.run(caller, 'unlink', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const recursive = a.recursive === true;
      const r = await this.fs.mutate(
        actor,
        'unlink',
        recursive ? `rm -r ${p}` : `rm ${p}`,
        (b) => planUnlink(b, p, recursive),
        { err, ...(recursive ? { prefetch: () => this.fs.prefetchSubtree(actor, p, false) } : {}) },
      );
      return { removed: r.value.removed, bytes: r.value.bytes, ...mutation(r) };
    });
  }

  rename(caller: Caller, a: ArgsOf<'rename'>): Promise<RetOf<'rename'>> {
    return this.run(caller, 'rename', a.from, async (actor, err) => {
      const from = this.fs.abs(actor, a.from);
      const to = this.fs.abs(actor, a.to);
      const r = await this.fs.mutate(
        actor,
        'rename',
        `mv ${from} ${to}`,
        (b) => planRename(b, from, to, a.noReplace === true),
        { err },
      );
      return {
        ino: r.value.ino,
        ...(r.value.replaced === undefined ? {} : { replaced: r.value.replaced }),
        ...mutation(r),
      };
    });
  }

  symlink(caller: Caller, a: ArgsOf<'symlink'>): Promise<RetOf<'symlink'>> {
    return this.run(caller, 'symlink', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const r = await this.fs.mutate(
        actor,
        'create',
        `ln -s ${a.target} ${p}`,
        (b) => planSymlink(b, a.target, p),
        { err },
      );
      return { ino: r.value.ino, ...mutation(r) };
    });
  }

  link(caller: Caller, a: ArgsOf<'link'>): Promise<RetOf<'link'>> {
    return this.run(caller, 'link', a.path, async (actor, err) => {
      const existing = this.fs.abs(actor, a.existing);
      const p = this.fs.abs(actor, a.path);
      const r = await this.fs.mutate(
        actor,
        'link',
        `ln ${existing} ${p}`,
        (b) => planLink(b, existing, p),
        {
          err,
        },
      );
      return { ino: r.value.ino, nlink: r.value.nlink, ...mutation(r) };
    });
  }

  chmod(caller: Caller, a: ArgsOf<'chmod'>): Promise<RetOf<'chmod'>> {
    return this.run(caller, 'chmod', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const spec = fromModeChange(a.mode);
      if (spec === 'EINVAL') throw fsError('EINVAL', undefined, err);
      const recursive = a.recursive === true;
      const r = await this.fs.mutate(
        actor,
        'chmod',
        `chmod ${p}`,
        (b) => planChmod(b, p, spec, recursive),
        { err, ...(recursive ? { prefetch: () => this.fs.prefetchSubtree(actor, p, true) } : {}) },
      );
      return { changed: r.value.changed, ...mutation(r) };
    });
  }

  chown(caller: Caller, a: ArgsOf<'chown'>): Promise<RetOf<'chown'>> {
    return this.run(caller, 'chown', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const recursive = a.recursive === true;
      const r = await this.fs.mutate(
        actor,
        'chown',
        `chown ${p}`,
        (b) =>
          planChown(b, p, {
            ...(a.uid === undefined ? {} : { uid: a.uid }),
            ...(a.gid === undefined ? {} : { gid: a.gid }),
            recursive,
          }),
        { err, ...(recursive ? { prefetch: () => this.fs.prefetchSubtree(actor, p, true) } : {}) },
      );
      return { changed: r.value.changed, ...mutation(r) };
    });
  }

  utimes(caller: Caller, a: ArgsOf<'utimes'>): Promise<RetOf<'utimes'>> {
    return this.run(caller, 'utimes', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      const r = await this.fs.mutate(
        actor,
        'utimes',
        `touch ${p}`,
        (b) =>
          planUtimes(b, p, {
            ...(a.atime === undefined ? {} : { atime: a.atime }),
            ...(a.mtime === undefined ? {} : { mtime: a.mtime }),
          }),
        { err },
      );
      return mutation(r);
    });
  }

  truncate(caller: Caller, a: ArgsOf<'truncate'>): Promise<RetOf<'truncate'>> {
    const fs = this.fs;
    if (!('path' in a)) {
      const err: ErrCtx = { call: 'truncate' };
      return fs.exclusive(() =>
        Promise.resolve(
          guarded(err, async () => {
            const pid = caller.pcb.pid;
            const f = fs.fds.get(pid, a.fd);
            if (f.type === 'd') throw fsError('EISDIR', undefined, err);
            if (f.flags.write !== true) throw fsError('EBADF', undefined, err);
            if (f.poisoned !== undefined) throw fsError(f.poisoned, undefined, err);
            const st = fs.fds.state(f);
            await this.ensureParts(f, st);
            const node = fs.tree.inode(f.ino);
            fs.fds.oft.truncate(
              pid,
              a.fd,
              a.size,
              fs.headroom(node ?? st.rec),
              chunkSource(st.parts ?? []),
            );
            const r = await this.commitSession(actorOf(caller.pcb), f, st, undefined, err);
            return { version: r.version, opId: r.opId, sync: r.sync };
          }),
        ),
      );
    }
    const err: ErrCtx = { call: 'truncate', path: a.path };
    return fs.exclusive(() =>
      Promise.resolve(
        guarded(err, async () => {
          const actor = actorOf(caller.pcb);
          const p = fs.abs(actor, a.path);
          const res = await fs.resolvePath(actor, p, { follow: true }, err);
          const node = res.node ?? fsFail('ENOENT', err);
          if (node.type === 'd') throw fsError('EISDIR', undefined, err);
          if (isSynthIno(node.ino)) throw fsError('EPERM', 'synthesised', err);
          const c = checkOpen(actor.cred, node, false, true);
          if (c !== null) throw fsError(c, undefined, err);
          const old = node.blob === null ? new Uint8Array(0) : await fs.content.bytesOf(node.blob);
          const content = contentOf(resized(old, a.size), fs.now());
          const r = await fs.mutateLocked(
            actor,
            'write',
            `truncate ${p}`,
            (b) => planTruncate(b, p, content),
            {
              err,
            },
          );
          return { version: r.value.version, ...mutation(r) };
        }),
      ),
    );
  }

  writeFile(caller: Caller, a: ArgsOf<'writeFile'>): Promise<RetOf<'writeFile'>> {
    return this.run(caller, 'writeFile', a.path, async (actor, err) => {
      const p = this.fs.abs(actor, a.path);
      // Hashing is phase-1 work, outside any transaction (§3.11).
      const content = contentOf(new Uint8Array(a.data), this.fs.now());
      const r = await this.fs.mutate(
        actor,
        'write',
        `write ${p}`,
        (b) =>
          planWriteFile(b, p, content, {
            create: a.create,
            ...(a.mode === undefined ? {} : { mode: a.mode }),
            ...(a.expectedVersion === undefined ? {} : { expectedVersion: a.expectedVersion }),
          }),
        { err },
      );
      const v = r.value;
      return {
        ino: v.ino,
        version: v.version,
        bytes: content.size,
        ...mutation(r),
        ...(v.conflict === undefined
          ? {}
          : { conflict: { keptAs: { ino: v.conflict.keptAs.ino, path: v.conflict.keptAs.path } } }),
      };
    });
  }

  copy(caller: Caller, a: ArgsOf<'copy'>): Promise<RetOf<'copy'>> {
    return this.run(caller, 'copy', a.from, async (actor, err) => {
      const from = this.fs.abs(actor, a.from);
      const to = this.fs.abs(actor, a.to);
      const recursive = a.recursive === true;
      const r = await this.fs.mutate(
        actor,
        'copy',
        `cp ${recursive ? '-r ' : ''}${from} ${to}`,
        (b) => {
          if (a.noReplace === true && copyTargetExists(b, from, to)) throw new VfsError('EEXIST');
          return planCopy(b, from, to, {
            recursive,
            ...(a.preserve === undefined ? {} : { preserve: a.preserve }),
          });
        },
        {
          err,
          ...(recursive ? { prefetch: () => this.fs.prefetchSubtree(actor, from, false) } : {}),
        },
      );
      return { copied: r.value.created, bytes: r.value.bytes, ...mutation(r) };
    });
  }

  batch(caller: Caller, a: ArgsOf<'batch'>): Promise<RetOf<'batch'>> {
    return this.run(caller, 'batch', '', async (actor, err) => {
      const ops = a.ops.map((op) => absOp(this.fs, actor, op));
      const expected = a.expectedVersions.length === 0 ? undefined : a.expectedVersions;
      const r: Mutated<BatchPlan> = await this.fs.mutate(
        actor,
        'batch',
        `batch of ${String(ops.length)}`,
        (b) => planBatch(b, ops, expected),
        { err, opId: a.txnId, keepAfterAck: caller.pcb.cls === 'agent' },
      );
      const bytes = Object.values(r.value.dryRun.bytesDelta).reduce((s, d) => s + Math.abs(d), 0);
      return {
        txnId: a.txnId,
        applied: ops.length,
        inodes: r.value.dryRun.touchedInodes,
        bytes,
        undoId: r.opId,
        ...mutation(r),
      };
    });
  }

  // -- file-system information ---------------------------------------------------------------

  statfs(caller: Caller, a: ArgsOf<'statfs'>): Promise<RetOf<'statfs'>> {
    return this.run(caller, 'statfs', a.path ?? '', async (actor, err) => {
      if (a.path !== undefined)
        await this.fs.resolvePath(actor, this.fs.abs(actor, a.path), { follow: true }, err);
      const est = await this.fs.store.estimate();
      return {
        fsId: 'plotinium' as const,
        usageBytes: Math.max(0, Math.floor(est.usage)),
        quotaBytes: est.quota === null ? null : Math.max(0, Math.floor(est.quota)),
        inodes: await this.fs.inodes(),
        persisted: est.persisted,
        swapBytes: this.fs.swapBytes(),
      };
    });
  }

  quota(caller: Caller, a: ArgsOf<'quota'>): Ret<'quota'> {
    const err: ErrCtx = { call: 'quota' };
    return guarded(err, (): Quota => {
      const cred = caller.pcb.cred;
      const uid = a.uid ?? cred.uid;
      if (uid !== cred.uid && cred.uid !== 0) throw fsError('EPERM', undefined, err);
      const user = this.fs.tree.user(uid) ?? fsFail('EINVAL', err);
      return quotaReport(user, this.fs.tree.online && user.serverAt !== undefined);
    });
  }
}

function fsFail(errno: 'ENOENT' | 'EINVAL', err: ErrCtx): never {
  throw fsError(errno, undefined, err);
}

/** Whether `copy(from, to)` would land on an existing name (`noReplace` → EEXIST). */
function copyTargetExists(b: PlanBuilder, from: string, to: string): boolean {
  let into: InodeRec | null = null;
  try {
    into = locate(b, to, { follow: true }).node;
  } catch (e) {
    if (!(e instanceof VfsError) || e.errno !== 'ENOENT') throw e;
  }
  if (into?.type === 'd') {
    const src = locate(b, from, { follow: false });
    const name = src.path
      .split('/')
      .filter((c) => c !== '')
      .at(-1);
    if (name === undefined) return false;
    const c = b.view.child(into.ino, name);
    return typeof c === 'object' && c !== null;
  }
  return into !== null || forCreate(b, to).node !== null;
}

/** A batch op with its paths made absolute for the caller's cwd. */
function absOp(
  fs: KernelFs,
  actor: FsActor,
  op: ArgsOf<'batch'>['ops'][number],
): ArgsOf<'batch'>['ops'][number] {
  switch (op.op) {
    case 'rename':
    case 'copy':
      return { ...op, from: fs.abs(actor, op.from), to: fs.abs(actor, op.to) };
    case 'mkdir':
    case 'write':
    case 'unlink':
    case 'symlink':
    case 'chmod':
    case 'chown':
    case 'utimes':
      return { ...op, path: fs.abs(actor, op.path) };
  }
}
