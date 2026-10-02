/**
 * The open-file table and per-process fd tables (virtual-file-system.md §3.9, Spec §9.1/§10.1).
 *
 * - `open` allocates the lowest free fd (POSIX); EMFILE at 256 fds per process or 4,096 entries in
 *   the device's table.
 * - `dup`, `dup2` and inheritance through `spawn` share one entry by refcount, hence one offset.
 * - `close` drops a reference; at 0 the entry is returned so the kernel finalises its session
 *   (commit, or discard if poisoned). `kill` closes every fd of the process the same way.
 * - Writes go to the session; a write past the owner's headroom fails with EDQUOT and poisons the
 *   description, so nothing from it is ever committed (§3.9.3 rule 6).
 */
import type { Errno } from '@plotinium/protocol';

import { VfsError, fail } from '../errors.ts';
import { OFT_MAX, OPEN_MAX, READ_MAX_BYTES } from '../limits.ts';
import type { FsId, InodeType, Sha256Hex, Uuid } from '../store/records.ts';
import { WriteSession } from './session.ts';
import type { ChunkSource } from './session.ts';

export interface OpenFlags {
  readonly read?: boolean;
  readonly write?: boolean;
  readonly create?: boolean;
  readonly excl?: boolean;
  readonly trunc?: boolean;
  readonly append?: boolean;
  readonly directory?: boolean;
  readonly noFollow?: boolean;
  readonly mode?: number;
  readonly expectedVersion?: number;
}

export interface OpenFile {
  readonly id: number;
  readonly ino: Uuid;
  readonly fs: FsId;
  readonly type: InodeType;
  readonly flags: OpenFlags;
  offset: number;
  refcount: number;
  /** Content read by this description (the snapshot at open). */
  readonly snapshotBlob: Sha256Hex | null;
  readonly snapshotSize: number;
  versionAtOpen: number;
  readonly expectedVersion?: number;
  session: WriteSession | null;
  poisoned?: Errno;
  readonly createdByOpen: boolean;
  leaseId?: string;
  fence?: number;
  /** For lsof, the dcache pin and conflicted copies: the entry the file was opened through. */
  readonly pathAtOpen: string;
  readonly via: { readonly parent: Uuid; readonly name: string } | null;
}

export type NewOpenFile = Omit<OpenFile, 'id' | 'offset' | 'refcount' | 'session' | 'poisoned'>;

export type Whence = 'set' | 'cur' | 'end';

export class OpenFileTable {
  private readonly entries = new Map<number, OpenFile>();
  private readonly procs = new Map<number, Map<number, number>>();
  private nextId = 1;
  private readonly perProcess: number;
  private readonly device: number;

  constructor(limits: { perProcess?: number; device?: number } = {}) {
    this.perProcess = limits.perProcess ?? OPEN_MAX;
    this.device = limits.device ?? OFT_MAX;
  }

  private fdTable(pid: number): Map<number, number> {
    let t = this.procs.get(pid);
    if (t === undefined) {
      t = new Map();
      this.procs.set(pid, t);
    }
    return t;
  }

  private lowestFree(t: Map<number, number>): number {
    for (let fd = 0; ; fd++) if (!t.has(fd)) return fd;
  }

  /** Allocate a description and the lowest free fd for it. */
  open(pid: number, desc: NewOpenFile, baseForTrunc?: ChunkSource): number {
    const t = this.fdTable(pid);
    if (t.size >= this.perProcess || this.entries.size >= this.device) fail('EMFILE');
    const id = this.nextId++;
    const f: OpenFile = { ...desc, id, offset: 0, refcount: 1, session: null };
    if (desc.flags.trunc === true && desc.flags.write === true)
      f.session = new WriteSession(0, baseForTrunc ?? (() => new Uint8Array(0)), true);
    this.entries.set(id, f);
    const fd = this.lowestFree(t);
    t.set(fd, id);
    return fd;
  }

  get(pid: number, fd: number): OpenFile {
    const id = this.procs.get(pid)?.get(fd);
    const f = id === undefined ? undefined : this.entries.get(id);
    return f ?? fail('EBADF');
  }

  fds(pid: number): number[] {
    return [...(this.procs.get(pid)?.keys() ?? [])].sort((a, b) => a - b);
  }

  dup(pid: number, fd: number): number {
    const f = this.get(pid, fd);
    const t = this.fdTable(pid);
    if (t.size >= this.perProcess) fail('EMFILE');
    const nfd = this.lowestFree(t);
    t.set(nfd, f.id);
    f.refcount++;
    return nfd;
  }

  /** `dup2`: `newFd` is closed first if open; the returned entry (if any) must be finalised. */
  dup2(pid: number, fd: number, newFd: number): { fd: number; closed: OpenFile | null } {
    const f = this.get(pid, fd);
    if (fd === newFd) return { fd, closed: null };
    const t = this.fdTable(pid);
    const closed = t.has(newFd) ? this.close(pid, newFd) : null;
    t.set(newFd, f.id);
    f.refcount++;
    return { fd: newFd, closed };
  }

  /** A child inherits (shares) the parent's descriptions (spawn). */
  inherit(parent: number, child: number, fds?: readonly number[]): void {
    const pt = this.procs.get(parent);
    if (pt === undefined) return;
    const ct = this.fdTable(child);
    for (const fd of fds ?? pt.keys()) {
      const id = pt.get(fd);
      const f = id === undefined ? undefined : this.entries.get(id);
      if (f === undefined) continue;
      ct.set(fd, f.id);
      f.refcount++;
    }
  }

  /** Close one fd; returns the description when its last reference went (to finalise). */
  close(pid: number, fd: number): OpenFile | null {
    const f = this.get(pid, fd);
    this.procs.get(pid)?.delete(fd);
    f.refcount--;
    if (f.refcount > 0) return null;
    this.entries.delete(f.id);
    return f;
  }

  /** `kill` path: every fd of the process; returns the descriptions to finalise. */
  closeAll(pid: number): OpenFile[] {
    const out: OpenFile[] = [];
    for (const fd of this.fds(pid)) {
      const f = this.close(pid, fd);
      if (f !== null) out.push(f);
    }
    this.procs.delete(pid);
    return out;
  }

  /** `lseek`: a negative result is EINVAL; seeking past the end is allowed. */
  seek(pid: number, fd: number, offset: number, whence: Whence, currentSize: number): number {
    const f = this.get(pid, fd);
    const base =
      whence === 'set' ? 0 : whence === 'cur' ? f.offset : (f.session?.size ?? currentSize);
    const next = base + offset;
    if (next < 0 || !Number.isSafeInteger(next)) fail('EINVAL');
    f.offset = next;
    return next;
  }

  /**
   * Buffer a write in the session. `headroom` is the largest size the file may reach (the owner's
   * remaining quota plus the committed size; tmpfs: its remaining space); beyond it the write fails
   * with EDQUOT and poisons the description.
   */
  write(
    pid: number,
    fd: number,
    data: Uint8Array,
    headroom: number,
    base: ChunkSource,
    pos?: number,
  ): number {
    const f = this.get(pid, fd);
    if (f.flags.write !== true) fail('EBADF');
    if (f.type === 'd') fail('EISDIR');
    if (f.poisoned !== undefined) fail(f.poisoned);
    f.session ??= new WriteSession(f.snapshotSize, base);
    const at = f.flags.append === true ? f.session.size : (pos ?? f.offset);
    if (at + data.length > headroom && at + data.length > f.session.size)
      return this.poison(f, 'EDQUOT');
    if (f.session.write(at, data) === 'EAGAIN') return this.poison(f, 'EAGAIN');
    if (pos === undefined) f.offset = at + data.length;
    return data.length;
  }

  read(pid: number, fd: number, len: number, base: ChunkSource, pos?: number): Uint8Array {
    const f = this.get(pid, fd);
    if (f.type === 'd') fail('EISDIR');
    if (f.flags.read !== true) fail('EBADF');
    const n = Math.min(len, READ_MAX_BYTES);
    const at = pos ?? f.offset;
    const src = f.session ?? new WriteSession(f.snapshotSize, base);
    const bytes = src.read(at, n);
    if (bytes === 'EAGAIN') return fail('EAGAIN', 'content-not-cached');
    if (pos === undefined) f.offset = at + bytes.length;
    return bytes;
  }

  /** `truncate(fd, size)`: starts or shortens the session (w needed); EDQUOT poisons as a write does. */
  truncate(pid: number, fd: number, size: number, headroom: number, base: ChunkSource): void {
    const f = this.get(pid, fd);
    if (f.flags.write !== true) fail('EBADF');
    if (f.poisoned !== undefined) fail(f.poisoned);
    if (size < 0) fail('EINVAL');
    f.session ??= new WriteSession(f.snapshotSize, base);
    if (size > headroom && size > f.session.size) {
      this.poison(f, 'EDQUOT');
      return;
    }
    f.session.truncate(size);
  }

  private poison(f: OpenFile, errno: Errno): never {
    f.poisoned = errno;
    throw new VfsError(errno);
  }

  /** Blobs that open descriptions still read: GC never collects them (§3.9.5). */
  openBlobPins(): Set<Sha256Hex> {
    const pins = new Set<Sha256Hex>();
    for (const f of this.entries.values()) if (f.snapshotBlob !== null) pins.add(f.snapshotBlob);
    return pins;
  }

  /** `lsof`: every (pid, fd, description). */
  list(): { pid: number; fd: number; file: OpenFile }[] {
    const out: { pid: number; fd: number; file: OpenFile }[] = [];
    for (const [pid, t] of this.procs) {
      for (const [fd, id] of t) {
        const file = this.entries.get(id);
        if (file !== undefined) out.push({ pid, fd, file });
      }
    }
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}
