/**
 * File descriptors of regular files and directories (virtual-file-system.md §3.9; syscall-abi.md
 * §4.4.2, §4.4.3).
 *
 * The device-wide open-file table and the write sessions are the vfs `OpenFileTable` (lowest free
 * fd, EMFILE at 256 per process or 4,096 per device, shared descriptions for `dup`/`dup2`/`spawn`,
 * close-to-open sessions, poisoning). This module keeps the PCB's `fdTable` (fd → description id)
 * in step with it, so `proc.info`, `lsof` and the kill path see one table per process:
 *
 * - every fd this module hands out is also in `pcb.fdTable`;
 * - an fd that `pcb.fdTable` holds but the open-file table does not is owned by another kind of
 *   descriptor (a pipe or TTY end); a new file fd never takes it (the file's fd moves to the lowest
 *   number free in both tables);
 * - `closeAll` is the kill path's step 3: every description whose last reference went is returned
 *   for finalisation.
 *
 * Per-description kernel state (the snapshot's chunks, the inode record at open) lives in
 * `DescState`, keyed by the description id.
 */
import { FD_TABLE_SIZE } from '@plotinium/protocol';
import type { InodeRec, NewOpenFile, OpenFile, Sha256Hex } from '@plotinium/vfs';
import { OpenFileTable, fail } from '@plotinium/vfs';

import type { PCB } from '../proc/pcb.ts';

export interface DescState {
  /** The inode as it was at open (fstat of a file unlinked while open). */
  rec: InodeRec;
  /** The snapshot's chunks once loaded (null: not loaded yet). */
  parts: Uint8Array[] | null;
  /** The blob the session's content was last committed as (append re-basing). */
  sessionBlob: Sha256Hex | null;
  /** A synthesised file: content generated at open, never committed. */
  readonly synth: boolean;
}

export interface Closed {
  readonly file: OpenFile;
  readonly state: DescState;
}

type FdPcb = Pick<PCB, 'pid' | 'fdTable'>;

export class FileDescriptors {
  readonly oft: OpenFileTable;
  private readonly states = new Map<number, DescState>();

  constructor(limits: { perProcess?: number; device?: number } = {}) {
    this.oft = new OpenFileTable(limits);
  }

  /** The lowest fd free in both the PCB's table and the open-file table. */
  private lowestFree(pcb: FdPcb): number {
    const mine = new Set(this.oft.fds(pcb.pid));
    for (let fd = 0; fd < FD_TABLE_SIZE; fd++) if (!pcb.fdTable.has(fd) && !mine.has(fd)) return fd;
    return fail('EMFILE');
  }

  /** Open a description and return its fd (EMFILE when a table is full). */
  open(pcb: FdPcb, desc: NewOpenFile, state: DescState): number {
    let fd = this.oft.open(pcb.pid, desc);
    const f = this.oft.get(pcb.pid, fd);
    if (pcb.fdTable.has(fd)) {
      // The number belongs to a pipe or TTY end: move the file to the lowest number free in both.
      let to: number;
      try {
        to = this.lowestFree(pcb);
      } catch (e) {
        this.oft.close(pcb.pid, fd);
        throw e;
      }
      this.oft.dup2(pcb.pid, fd, to);
      this.oft.close(pcb.pid, fd);
      fd = to;
    }
    pcb.fdTable.set(fd, f.id);
    this.states.set(f.id, state);
    return fd;
  }

  /** The description behind `fd` of `pid` (EBADF). */
  get(pid: number, fd: number): OpenFile {
    return this.oft.get(pid, fd);
  }

  state(f: OpenFile): DescState {
    return this.states.get(f.id) ?? fail('EBADF');
  }

  has(pid: number, fd: number): boolean {
    return this.oft.fds(pid).includes(fd);
  }

  /** Close one fd; the description when its last reference went (to finalise). */
  close(pcb: FdPcb, fd: number): Closed | null {
    const file = this.oft.close(pcb.pid, fd);
    pcb.fdTable.delete(fd);
    return file === null ? null : this.release(file);
  }

  /** Kill path: every file fd of the process; the descriptions to finalise. */
  closeAll(pcb: FdPcb): Closed[] {
    const fds = this.oft.fds(pcb.pid);
    const files = this.oft.closeAll(pcb.pid);
    for (const fd of fds) pcb.fdTable.delete(fd);
    return files.map((f) => this.release(f));
  }

  /** `dup`: the lowest free fd sharing the description (and its offset). */
  dup(pcb: FdPcb, fd: number): number {
    const f = this.oft.get(pcb.pid, fd);
    let nfd = this.oft.dup(pcb.pid, fd);
    if (pcb.fdTable.has(nfd)) {
      const to = this.lowestFree(pcb);
      this.oft.dup2(pcb.pid, nfd, to);
      this.oft.close(pcb.pid, nfd);
      nfd = to;
    }
    pcb.fdTable.set(nfd, f.id);
    return nfd;
  }

  /** `dup2`: `to` now shares `fd`'s description; a file previously at `to` may need finalising. */
  dup2(pcb: FdPcb, fd: number, to: number): Closed | null {
    const f = this.oft.get(pcb.pid, fd);
    const r = this.oft.dup2(pcb.pid, fd, to);
    pcb.fdTable.set(to, f.id);
    return r.closed === null ? null : this.release(r.closed);
  }

  /** `spawn`: the child shares the parent's file descriptions (all, or the listed fds). */
  inherit(parent: FdPcb, child: FdPcb, fds?: readonly number[]): void {
    const list = (fds ?? this.oft.fds(parent.pid)).filter((fd) => this.has(parent.pid, fd));
    this.oft.inherit(parent.pid, child.pid, list);
    for (const fd of list) child.fdTable.set(fd, this.oft.get(parent.pid, fd).id);
  }

  /** Blobs open descriptions still read: blob GC must keep them (§3.9.5). */
  openBlobPins(): Set<Sha256Hex> {
    return this.oft.openBlobPins();
  }

  /** Open descriptions (lsof). */
  list(): { pid: number; fd: number; file: OpenFile }[] {
    return this.oft.list();
  }

  private release(file: OpenFile): Closed {
    const state = this.states.get(file.id);
    this.states.delete(file.id);
    return {
      file,
      state: state ?? { rec: placeholder(file), parts: null, sessionBlob: null, synth: false },
    };
  }
}

function placeholder(f: OpenFile): InodeRec {
  return {
    ino: f.ino,
    fs: f.fs,
    type: f.type,
    mode: 0,
    uid: 0,
    gid: 0,
    size: f.snapshotSize,
    nlink: 0,
    version: f.versionAtOpen,
    atime: 0,
    mtime: 0,
    ctime: 0,
    btime: 0,
    blob: f.snapshotBlob,
    target: null,
  };
}
