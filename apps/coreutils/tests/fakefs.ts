/**
 * Test-only in-memory file system with the path, permission and errno behaviour the coreutils rely
 * on (virtual-file-system.md §3.5-§3.6): code-point ordered directories, symlinks followed for
 * intermediate components, `x` on every ancestor, `w+x` on the parent to create or remove.
 */
import type { DirEntry, InodeType, ModeChange, Stat } from '@plotinium/protocol';

import { SysError } from '../lib/sys.ts';

export interface Inode {
  ino: string;
  type: InodeType;
  mode: number;
  uid: number;
  gid: number;
  data: Uint8Array;
  target: string;
  children: Map<string, string>;
  parent: string;
  nlink: number;
  atime: number;
  mtime: number;
  ctime: number;
  version: number;
}

export interface Cred {
  uid: number;
  gid: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class FakeFs {
  readonly inodes = new Map<string, Inode>();
  readonly root: string;
  cred: Cred = { uid: 1001, gid: 1001 };
  umask = 0o022;
  clock = Date.UTC(2026, 10, 14, 5, 12, 5, 123);
  private seq = 0;

  constructor() {
    this.root = this.alloc('d', 0o755, 0, 0);
    const root = this.node(this.root);
    root.parent = this.root;
  }

  private alloc(type: InodeType, mode: number, uid: number, gid: number): string {
    this.seq += 1;
    const ino = `0192f0c1-7c2e-7a51-9d6f-${this.seq.toString(16).padStart(12, '0')}`;
    this.inodes.set(ino, {
      ino,
      type,
      mode,
      uid,
      gid,
      data: new Uint8Array(),
      target: '',
      children: new Map(),
      parent: '',
      nlink: type === 'd' ? 2 : 1,
      atime: this.clock,
      mtime: this.clock,
      ctime: this.clock,
      version: 1,
    });
    return ino;
  }

  node(ino: string): Inode {
    const n = this.inodes.get(ino);
    if (n === undefined) throw new Error(`no inode ${ino}`);
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // Seeding (as root, no permission checks)
  // -------------------------------------------------------------------------------------------

  private seedParent(path: string): { dir: Inode; name: string } {
    const parts = path.split('/').filter((p) => p.length > 0);
    const name = parts.pop() ?? '';
    let dir = this.node(this.root);
    for (const part of parts) {
      let child = dir.children.get(part);
      if (child === undefined) {
        child = this.alloc('d', 0o755, this.cred.uid, this.cred.gid);
        this.link(dir, part, child);
      }
      dir = this.node(child);
    }
    return { dir, name };
  }

  private link(dir: Inode, name: string, ino: string): void {
    dir.children.set(name, ino);
    const child = this.node(ino);
    child.parent = dir.ino;
    if (child.type === 'd') dir.nlink += 1;
  }

  addDir(path: string, opts: Partial<Pick<Inode, 'mode' | 'uid' | 'gid' | 'mtime'>> = {}): Inode {
    const { dir, name } = this.seedParent(path);
    const existing = dir.children.get(name);
    const ino = existing ?? this.alloc('d', 0o755, this.cred.uid, this.cred.gid);
    if (existing === undefined) this.link(dir, name, ino);
    return Object.assign(this.node(ino), opts);
  }

  addFile(
    path: string,
    text: string | Uint8Array,
    opts: Partial<Pick<Inode, 'mode' | 'uid' | 'gid' | 'mtime'>> = {},
  ): Inode {
    const { dir, name } = this.seedParent(path);
    const ino = this.alloc('f', 0o644, this.cred.uid, this.cred.gid);
    this.link(dir, name, ino);
    const n = Object.assign(this.node(ino), opts);
    n.data = typeof text === 'string' ? encoder.encode(text) : text;
    return n;
  }

  addLink(path: string, target: string): Inode {
    const { dir, name } = this.seedParent(path);
    const ino = this.alloc('l', 0o777, this.cred.uid, this.cred.gid);
    this.link(dir, name, ino);
    const n = this.node(ino);
    n.target = target;
    return n;
  }

  text(path: string, cwd = '/'): string {
    return decoder.decode(this.node(this.resolve(path, cwd, true).ino).data);
  }

  exists(path: string, cwd = '/'): boolean {
    try {
      this.resolve(path, cwd, false);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Resolution and permissions
  // -------------------------------------------------------------------------------------------

  can(n: Inode, bits: number): boolean {
    if (this.cred.uid === 0) return (bits & 1) === 0 || n.type === 'd' || (n.mode & 0o111) !== 0;
    const shift = n.uid === this.cred.uid ? 6 : n.gid === this.cred.gid ? 3 : 0;
    return ((n.mode >> shift) & bits) === bits;
  }

  private need(n: Inode, bits: number): void {
    if (!this.can(n, bits)) throw new SysError('EACCES');
  }

  /** Resolves a path; `follow` applies to the last component. */
  resolve(
    path: string,
    cwd: string,
    follow: boolean,
    depth = 0,
  ): { ino: string; parent: string; name: string } {
    if (depth > 40) throw new SysError('ELOOP');
    if (path.length === 0) throw new SysError('ENOENT');
    const start = path.startsWith('/') ? this.root : this.resolve(cwd, '/', true, depth).ino;
    const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
    let cur = start;
    let parent = this.node(start).parent;
    let name = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? '';
      const dir = this.node(cur);
      if (dir.type !== 'd') throw new SysError('ENOTDIR');
      this.need(dir, 1);
      if (part === '..') {
        cur = dir.parent;
        parent = this.node(cur).parent;
        name = '';
        continue;
      }
      const child = dir.children.get(part);
      if (child === undefined) throw new SysError('ENOENT');
      const last = i === parts.length - 1;
      const n = this.node(child);
      if (n.type === 'l' && (!last || follow)) {
        const target = this.resolve(n.target, this.pathOf(dir.ino), true, depth + 1);
        cur = target.ino;
        parent = target.parent;
        name = target.name;
      } else {
        parent = cur;
        cur = child;
        name = part;
      }
    }
    return { ino: cur, parent, name };
  }

  /** The parent directory and final name for creating `path`. */
  parentOf(path: string, cwd: string): { dir: Inode; name: string } {
    const trimmed = path.replace(/\/+$/, '');
    const i = trimmed.lastIndexOf('/');
    const dirPath = i === -1 ? '.' : i === 0 ? '/' : trimmed.slice(0, i);
    const name = trimmed.slice(i + 1);
    if (name === '' || name === '.' || name === '..') throw new SysError('EINVAL');
    const dir = this.node(this.resolve(dirPath, cwd, true).ino);
    if (dir.type !== 'd') throw new SysError('ENOTDIR');
    return { dir, name };
  }

  pathOf(ino: string): string {
    const names: string[] = [];
    let cur = ino;
    while (cur !== this.root) {
      const n = this.node(cur);
      const parent = this.node(n.parent);
      const entry = [...parent.children].find(([, v]) => v === cur);
      names.unshift(entry?.[0] ?? '?');
      cur = n.parent;
    }
    return `/${names.join('/')}`;
  }

  stat(n: Inode): Stat {
    return {
      ino: n.ino,
      type: n.type,
      mode: n.mode,
      uid: n.uid,
      gid: n.gid,
      size:
        n.type === 'l' ? encoder.encode(n.target).length : n.type === 'd' ? 4096 : n.data.length,
      nlink: n.nlink,
      atime: n.atime,
      mtime: n.mtime,
      ctime: n.ctime,
      version: n.version,
      blob: null,
      target: n.type === 'l' ? n.target : null,
    };
  }

  entries(dir: Inode, plus: boolean): DirEntry[] {
    return [...dir.children.keys()].sort(cmp).map((name) => {
      const n = this.node(dir.children.get(name) ?? '');
      return { name, ino: n.ino, type: n.type, ...(plus ? { stat: this.stat(n) } : {}) };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Mutations as the current credentials
  // -------------------------------------------------------------------------------------------

  private touchNode(n: Inode): void {
    n.mtime = this.clock;
    n.ctime = this.clock;
    n.version += 1;
  }

  create(path: string, cwd: string, type: InodeType, mode: number): Inode {
    const { dir, name } = this.parentOf(path, cwd);
    this.need(dir, 3);
    if (dir.children.has(name)) throw new SysError('EEXIST');
    const ino = this.alloc(type, mode & ~this.umask & 0o7777, this.cred.uid, this.cred.gid);
    this.link(dir, name, ino);
    this.touchNode(dir);
    return this.node(ino);
  }

  mkdirp(path: string, cwd: string, mode: number): { ino: string; created: number } {
    const abs = path.startsWith('/') ? path : `${cwd}/${path}`;
    const parts = abs.split('/').filter((p) => p.length > 0);
    let cur = '/';
    let created = 0;
    let ino = this.root;
    for (const part of parts) {
      cur = cur === '/' ? `/${part}` : `${cur}/${part}`;
      try {
        const r = this.resolve(cur, '/', true);
        if (this.node(r.ino).type !== 'd') throw new SysError('ENOTDIR');
        ino = r.ino;
      } catch (e) {
        if (!(e instanceof SysError) || e.errno !== 'ENOENT') throw e;
        ino = this.create(cur, '/', 'd', mode).ino;
        created += 1;
      }
    }
    return { ino, created };
  }

  remove(path: string, cwd: string, recursive: boolean): { removed: number; bytes: number } {
    const r = this.resolve(path, cwd, false);
    if (r.ino === this.root) throw new SysError('EBUSY');
    const parent = this.node(r.parent);
    this.need(parent, 3);
    const n = this.node(r.ino);
    if (n.type === 'd' && !recursive) throw new SysError('EISDIR');
    const counted = this.count(n);
    this.detach(parent, r.name);
    return counted;
  }

  count(n: Inode): { removed: number; bytes: number } {
    let removed = 1;
    let bytes = n.type === 'f' ? n.data.length : 0;
    for (const child of n.children.values()) {
      const c = this.count(this.node(child));
      removed += c.removed;
      bytes += c.bytes;
    }
    return { removed, bytes };
  }

  detach(parent: Inode, name: string): void {
    const ino = parent.children.get(name);
    if (ino === undefined) throw new SysError('ENOENT');
    parent.children.delete(name);
    if (this.node(ino).type === 'd') parent.nlink -= 1;
    this.touchNode(parent);
  }

  applyMode(n: Inode, mode: ModeChange): void {
    const next = mode.op === 'set' ? mode.bits : (n.mode & ~mode.clear) | mode.add;
    n.mode = next & 0o7777;
    n.ctime = this.clock;
  }

  walk(n: Inode, fn: (n: Inode) => void): void {
    fn(n);
    if (n.type !== 'd') return;
    for (const child of n.children.values()) this.walk(this.node(child), fn);
  }

  copyTree(src: Inode, dir: Inode, name: string, preserve: boolean): number {
    const ino = this.alloc(
      src.type,
      preserve ? src.mode : src.mode & ~this.umask,
      this.cred.uid,
      this.cred.gid,
    );
    this.link(dir, name, ino);
    const copy = this.node(ino);
    copy.data = src.data.slice();
    copy.target = src.target;
    if (preserve) copy.mtime = src.mtime;
    let copied = 1;
    for (const [childName, child] of src.children)
      copied += this.copyTree(this.node(child), copy, childName, preserve);
    return copied;
  }
}
