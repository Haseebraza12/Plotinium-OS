/**
 * An in-memory kernel double for the Files and Editor tests: a small POSIX-like tree with owners,
 * modes, versions, VFS-10 conflicted copies, S/X leases and an optional `ai.semsearch`. It
 * answers the promise client shape a view gets (`AppViewContext.sys`), one instance per user
 * over a shared world, so two users can contend for a lock or race a save.
 *
 * It follows the kernel's rules closely enough for the app logic (EEXIST, EACCES, EXDEV out of
 * /tmp, ENOTEMPTY, noReplace, expectedVersion) and no further.
 */
import type { ArgsIn, CallName, Errno, RetOf, SemsearchResult, Stat } from '@plotinium/protocol';
import { SysError } from '@plotinium/kernel/sys';

export interface FakeUser {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  readonly home: string;
}

interface Node {
  ino: string;
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  ctime: number;
  version: number;
  data: Uint8Array;
  target: string | null;
  children: Map<string, string>;
  fs: 'root' | 'tmp';
}

interface Lease {
  leaseId: string;
  ino: string;
  holder: FakeUser;
  mode: 'S' | 'X';
  expiresAt: number;
}

interface OpenFile {
  ino: string;
  pos: number;
}

export type SemsearchImpl =
  'enosys' | ((q: string, scope: string, mode: string) => SemsearchResult);

const enc = new TextEncoder();
const dec = new TextDecoder();

function fail(errno: Errno, message?: string): never {
  throw new SysError(errno, message);
}

/** The shared world: the tree, leases, clock and call log. */
export class FakeWorld {
  readonly nodes = new Map<string, Node>();
  readonly leases = new Map<string, Lease>();
  readonly users: FakeUser[] = [];
  readonly calls: { user: string; call: string; args: unknown }[] = [];
  now = Date.UTC(2026, 8, 26, 9, 30, 0);
  semsearch: SemsearchImpl = 'enosys';
  /** What `ai.index.status` reports (0: an index that holds nothing yet). */
  indexedFiles = 42;
  quotaBytes: number | null = 100 * 1_048_576;
  private seq = 0;
  readonly root: Node;

  constructor() {
    this.root = this.mkNode('d', 0o755, 0, 0);
    this.nodes.set(this.root.ino, this.root);
    this.mkdirAbs('/home', 0o755, 0, 0);
    this.mkdirAbs('/tmp', 0o1777, 0, 0).fs = 'tmp';
  }

  newId(): string {
    this.seq += 1;
    return `01900000-0000-7000-8000-${this.seq.toString(16).padStart(12, '0')}`;
  }

  private mkNode(type: Node['type'], mode: number, uid: number, gid: number): Node {
    return {
      ino: this.newId(),
      type,
      mode,
      uid,
      gid,
      mtime: this.now,
      ctime: this.now,
      version: 1,
      data: new Uint8Array(0),
      target: null,
      children: new Map(),
      fs: 'root',
    };
  }

  addUser(name: string, uid: number): FakeUser {
    const user = { uid, gid: uid, name, home: `/home/${name}` };
    this.users.push(user);
    this.mkdirAbs(user.home, 0o755, uid, uid);
    return user;
  }

  /** Creates a folder (and missing parents) without permission checks. */
  mkdirAbs(path: string, mode = 0o755, uid = 0, gid = 0): Node {
    let node = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      const id = node.children.get(part);
      if (id === undefined) {
        const child = this.mkNode('d', mode, uid, gid);
        child.fs = node.fs;
        this.nodes.set(child.ino, child);
        node.children.set(part, child.ino);
        node = child;
      } else node = this.nodes.get(id) ?? fail('EIO');
    }
    return node;
  }

  /** Creates a file without permission checks. */
  writeAbs(path: string, text: string, owner: FakeUser | undefined, mode = 0o644): Node {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop() ?? fail('EINVAL');
    const dir = this.mkdirAbs(`/${parts.join('/')}`);
    const existingId = dir.children.get(name);
    const node =
      existingId === undefined
        ? this.mkNode('f', mode, owner?.uid ?? 0, owner?.gid ?? 0)
        : (this.nodes.get(existingId) ?? fail('EIO'));
    if (existingId !== undefined) node.version += 1;
    node.data = enc.encode(text);
    node.mtime = this.now;
    node.fs = dir.fs;
    this.nodes.set(node.ino, node);
    dir.children.set(name, node.ino);
    return node;
  }

  symlinkAbs(path: string, target: string, owner: FakeUser): Node {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop() ?? fail('EINVAL');
    const dir = this.mkdirAbs(`/${parts.join('/')}`);
    const node = this.mkNode('l', 0o777, owner.uid, owner.gid);
    node.target = target;
    this.nodes.set(node.ino, node);
    dir.children.set(name, node.ino);
    return node;
  }

  node(path: string): Node | undefined {
    try {
      return this.resolve(path, true, undefined).node;
    } catch {
      return undefined;
    }
  }

  text(path: string): string | undefined {
    const n = this.node(path);
    return n === undefined ? undefined : dec.decode(n.data);
  }

  names(path: string): string[] {
    return [...(this.node(path)?.children.keys() ?? [])].sort();
  }

  /** Resolves `path`; `follow` follows a final symlink. Checks x on every folder for `who`. */
  resolve(
    path: string,
    follow: boolean,
    who: FakeUser | undefined,
    depth = 0,
  ): { node: Node; parent: Node; name: string } {
    if (depth > 40) fail('ELOOP');
    const parts = path.split('/').filter(Boolean);
    let node = this.root;
    let parent = this.root;
    let name = '/';
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? '';
      if (node.type !== 'd') fail('ENOTDIR');
      if (who !== undefined && !this.can(node, who, 1)) fail('EACCES');
      const id = node.children.get(part);
      if (id === undefined) fail('ENOENT');
      const child = this.nodes.get(id) ?? fail('EIO');
      const last = i === parts.length - 1;
      if (child.type === 'l' && (!last || follow)) {
        const base = `/${parts.slice(0, i).join('/')}`;
        const target = (child.target ?? '').startsWith('/')
          ? (child.target ?? '')
          : `${base}/${child.target ?? ''}`;
        const rest = parts.slice(i + 1).join('/');
        return this.resolve(rest === '' ? target : `${target}/${rest}`, follow, who, depth + 1);
      }
      parent = node;
      name = part;
      node = child;
    }
    return { node, parent, name };
  }

  /** rwx check: 4 read, 2 write, 1 execute. */
  can(node: Node, who: FakeUser, bit: number): boolean {
    if (who.uid === 0) return bit !== 1 || node.type === 'd' || (node.mode & 0o111) !== 0;
    const shift = node.uid === who.uid ? 6 : node.gid === who.gid ? 3 : 0;
    return ((node.mode >> shift) & bit) !== 0;
  }

  stat(node: Node): Stat {
    return {
      ino: node.ino,
      type: node.type,
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      size: node.type === 'l' ? (node.target ?? '').length : node.data.byteLength,
      nlink: 1,
      atime: node.mtime,
      mtime: node.mtime,
      ctime: node.ctime,
      version: node.version,
      blob: null,
      target: node.target,
      fs: node.fs,
    };
  }

  client(user: FakeUser): FakeSys {
    return new FakeSys(this, user);
  }

  /** The leases of another user on `ino` that forbid `who` from writing. */
  foreignX(ino: string, who: FakeUser): Lease | undefined {
    return [...this.leases.values()].find(
      (l) => l.ino === ino && l.mode === 'X' && l.holder.uid !== who.uid && l.expiresAt > this.now,
    );
  }
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One user's promise client (what `AppViewContext.sys` looks like to an app). */
export class FakeSys {
  private readonly fds = new Map<number, OpenFile>();
  private nextFd = 3;
  readonly user: FakeUser;
  private readonly world: FakeWorld;
  /** Calls that should fail with an errno, for fault tests. */
  readonly faults = new Map<string, Errno>();

  constructor(world: FakeWorld, user: FakeUser) {
    this.world = world;
    this.user = user;
  }

  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
    this.world.calls.push({ user: this.user.name, call: name, args });
    try {
      const fault = this.faults.get(name);
      if (fault !== undefined) fail(fault);
      return Promise.resolve(
        this.handle(name, args as unknown as Record<string, unknown>) as RetOf<C>,
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private mutation(): { opId: string; sync: 'applied' } {
    return { opId: this.world.newId(), sync: 'applied' };
  }

  private str(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string') fail('EINVAL', `${key} missing`);
    return v;
  }

  /** The parent folder of a new name, checked for w and x. */
  private parentFor(path: string): { dir: Node; name: string } {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop() ?? fail('EINVAL');
    const { node: dir } = this.world.resolve(`/${parts.join('/')}`, true, this.user);
    if (dir.type !== 'd') fail('ENOTDIR');
    if (!this.world.can(dir, this.user, 2) || !this.world.can(dir, this.user, 1)) fail('EACCES');
    return { dir, name };
  }

  private cloneTree(src: Node, fsKind: Node['fs']): Node {
    const copy: Node = {
      ...src,
      ino: this.world.newId(),
      uid: this.user.uid,
      gid: this.user.gid,
      version: 1,
      mtime: this.world.now,
      data: src.data.slice(),
      children: new Map(),
      fs: fsKind,
    };
    this.world.nodes.set(copy.ino, copy);
    for (const [n, id] of src.children) {
      const child = this.world.nodes.get(id);
      if (child !== undefined) copy.children.set(n, this.cloneTree(child, fsKind).ino);
    }
    return copy;
  }

  private handle(name: string, a: Record<string, unknown>): unknown {
    const w = this.world;
    switch (name) {
      case 'proc.cred':
        return {
          uid: this.user.uid,
          gid: this.user.gid,
          groups: [this.user.gid],
          user: this.user.name,
          groupNames: [this.user.name],
          home: this.user.home,
          ruid: this.user.uid,
        };
      case 'users.list':
        return {
          users: w.users.map((u) => ({
            uid: u.uid,
            name: u.name,
            gid: u.gid,
            home: u.home,
            groups: [u.gid],
          })),
        };
      case 'time.now':
        return { epochMs: w.now, monoMs: w.now };
      case 'stat':
      case 'lstat': {
        const { node } = w.resolve(
          this.str(a, 'path'),
          name === 'stat' && a['follow'] !== false,
          this.user,
        );
        return w.stat(node);
      }
      case 'readdir': {
        const { node } = w.resolve(this.str(a, 'path'), true, this.user);
        if (node.type !== 'd') fail('ENOTDIR');
        if (!w.can(node, this.user, 4)) fail('EACCES');
        const all = [...node.children.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
        const start = typeof a['cursor'] === 'string' ? Number(a['cursor']) : 0;
        const limit = typeof a['limit'] === 'number' ? a['limit'] : 1000;
        const slice = all.slice(start, start + limit);
        const entries = slice.map(([n, id]) => {
          const child = w.nodes.get(id) ?? fail('EIO');
          return {
            name: n,
            ino: id,
            type: child.type,
            ...(a['plus'] === true ? { stat: w.stat(child) } : {}),
          };
        });
        return {
          entries,
          dirVersion: node.version,
          ...(start + limit < all.length ? { next: String(start + limit) } : {}),
        };
      }
      case 'mkdir': {
        const { dir, name: n } = this.parentFor(this.str(a, 'path'));
        if (dir.children.has(n)) fail('EEXIST');
        const node = w.mkdirAbs(
          this.str(a, 'path'),
          (typeof a['mode'] === 'number' ? a['mode'] : 0o777) & ~0o022,
          this.user.uid,
          this.user.gid,
        );
        dir.version += 1;
        return { ino: node.ino, created: 1, ...this.mutation() };
      }
      case 'rename': {
        const from = this.str(a, 'from');
        const to = this.str(a, 'to');
        const src = this.parentFor(from);
        const id = src.dir.children.get(src.name) ?? fail('ENOENT');
        const node = w.nodes.get(id) ?? fail('EIO');
        const dst = this.parentFor(to);
        if (dst.dir.fs !== node.fs) fail('EXDEV');
        if (dst.dir.children.has(dst.name)) {
          if (a['noReplace'] === true) fail('EEXIST');
        }
        if (w.foreignX(id, this.user) !== undefined) fail('EBUSY');
        src.dir.children.delete(src.name);
        dst.dir.children.set(dst.name, id);
        src.dir.version += 1;
        dst.dir.version += 1;
        return { ino: id, ...this.mutation() };
      }
      case 'copy': {
        const { node: src } = w.resolve(this.str(a, 'from'), true, this.user);
        if (!w.can(src, this.user, 4)) fail('EACCES');
        if (src.type === 'd' && a['recursive'] !== true) fail('EISDIR');
        const dst = this.parentFor(this.str(a, 'to'));
        if (dst.dir.children.has(dst.name)) fail('EEXIST');
        const copy = this.cloneTree(src, dst.dir.fs);
        dst.dir.children.set(dst.name, copy.ino);
        dst.dir.version += 1;
        return { copied: 1, bytes: src.data.byteLength, ...this.mutation() };
      }
      case 'unlink':
      case 'rmdir': {
        const { dir, name: n } = this.parentFor(this.str(a, 'path'));
        const id = dir.children.get(n) ?? fail('ENOENT');
        const node = w.nodes.get(id) ?? fail('EIO');
        if (node.type === 'd' && name === 'unlink' && a['recursive'] !== true) fail('EISDIR');
        if (node.type === 'd' && name === 'rmdir' && node.children.size > 0) fail('ENOTEMPTY');
        if (w.foreignX(id, this.user) !== undefined) fail('EBUSY');
        dir.children.delete(n);
        dir.version += 1;
        return { removed: 1, bytes: node.data.byteLength, ...this.mutation() };
      }
      case 'chmod': {
        const { node } = w.resolve(this.str(a, 'path'), true, this.user);
        if (this.user.uid !== 0 && node.uid !== this.user.uid) fail('EPERM');
        const mode = a['mode'] as
          { op: 'set'; bits: number } | { op: 'delta'; add: number; clear: number };
        node.mode = mode.op === 'set' ? mode.bits : (node.mode | mode.add) & ~mode.clear;
        node.ctime = w.now;
        return { changed: 1, ...this.mutation() };
      }
      case 'open': {
        const path = this.str(a, 'path');
        const flags = this.str(a, 'flags');
        let node: Node;
        try {
          node = w.resolve(path, true, this.user).node;
          if (a['excl'] === true) fail('EEXIST');
        } catch (e) {
          if (!(e instanceof SysError) || e.errno !== 'ENOENT' || a['create'] !== true) throw e;
          const { dir, name: n } = this.parentFor(path);
          node = w.writeAbs(path, '', this.user, 0o644);
          dir.children.set(n, node.ino);
          dir.version += 1;
        }
        if (flags === 'r' && !w.can(node, this.user, 4)) fail('EACCES');
        if (flags !== 'r' && !w.can(node, this.user, 2)) fail('EACCES');
        const fd = this.nextFd++;
        this.fds.set(fd, { ino: node.ino, pos: 0 });
        return {
          fd,
          ino: node.ino,
          type: node.type,
          version: node.version,
          size: node.data.byteLength,
        };
      }
      case 'read': {
        const f = this.fds.get(a['fd'] as number) ?? fail('EBADF');
        const node = w.nodes.get(f.ino) ?? fail('EIO');
        const len = a['len'] as number;
        const chunk = node.data.slice(f.pos, f.pos + len);
        f.pos += chunk.byteLength;
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      }
      case 'close':
        if (!this.fds.delete(a['fd'] as number)) fail('EBADF');
        return {};
      case 'writeFile': {
        const path = this.str(a, 'path');
        const data = new Uint8Array(a['data'] as ArrayBuffer);
        let target: { node: Node; parent: Node; name: string } | undefined;
        try {
          target = w.resolve(path, true, this.user);
        } catch (e) {
          if (!(e instanceof SysError) || e.errno !== 'ENOENT' || a['create'] === false) throw e;
        }
        if (target === undefined) {
          const { dir, name: n } = this.parentFor(path);
          const node = w.writeAbs(path, dec.decode(data), this.user);
          dir.children.set(n, node.ino);
          dir.version += 1;
          return {
            ino: node.ino,
            version: node.version,
            bytes: data.byteLength,
            ...this.mutation(),
          };
        }
        const node = target.node;
        if (!w.can(node, this.user, 2)) fail('EACCES');
        if (w.foreignX(node.ino, this.user) !== undefined) fail('EBUSY');
        const quota = w.quotaBytes;
        if (quota !== null && data.byteLength > quota) fail('EDQUOT');
        const expected = a['expectedVersion'];
        if (typeof expected === 'number' && expected !== node.version) {
          // VFS-10: the stale content becomes a conflicted copy; the original is untouched.
          const dot = target.name.lastIndexOf('.');
          const stem = dot > 0 ? target.name.slice(0, dot) : target.name;
          const ext = dot > 0 ? target.name.slice(dot) : '';
          const copyName = `${stem} (conflict from ${this.user.name}, ${isoDay(w.now)})${ext}`;
          const dirPath = path.slice(0, path.lastIndexOf('/')) || '/';
          const copyPath = `${dirPath === '/' ? '' : dirPath}/${copyName}`;
          const copy = w.writeAbs(copyPath, dec.decode(data), this.user);
          target.parent.version += 1;
          return {
            ino: node.ino,
            version: node.version,
            bytes: data.byteLength,
            ...this.mutation(),
            conflict: { keptAs: { ino: copy.ino, path: copyPath } },
          };
        }
        node.data = data;
        node.version += 1;
        node.mtime = w.now;
        return { ino: node.ino, version: node.version, bytes: data.byteLength, ...this.mutation() };
      }
      case 'quota': {
        let used = 0;
        for (const n of w.nodes.values()) if (n.uid === this.user.uid) used += n.data.byteLength;
        return {
          uid: this.user.uid,
          usedBytes: used,
          quotaBytes: w.quotaBytes,
          usedInodes: 0,
          quotaInodes: null,
          source: 'mirror',
        };
      }
      case 'statfs':
        return {
          fsId: 'plotinium',
          usageBytes: 0,
          quotaBytes: null,
          inodes: w.nodes.size,
          persisted: true,
          swapBytes: { local: 0, remote: 0 },
        };
      case 'lock.acquire': {
        const { node } = w.resolve(this.str(a, 'path'), true, this.user);
        if (!w.can(node, this.user, 2)) fail('EACCES');
        if (w.foreignX(node.ino, this.user) !== undefined) fail('EBUSY');
        const lease: Lease = {
          leaseId: w.newId(),
          ino: node.ino,
          holder: this.user,
          mode: 'X',
          expiresAt: w.now + 30_000,
        };
        w.leases.set(lease.leaseId, lease);
        return { leaseId: lease.leaseId, fence: 7, expiresAt: lease.expiresAt, scope: 'server' };
      }
      case 'lock.release':
        if (!w.leases.delete(this.str(a, 'leaseId'))) fail('ENOENT');
        return {};
      case 'lock.status': {
        const path = this.str(a, 'path');
        const { node } = w.resolve(path, true, this.user);
        const holders = [...w.leases.values()]
          .filter((l) => l.ino === node.ino && l.expiresAt > w.now)
          .map((l) => ({
            path,
            holder: `${l.holder.name}@lab-pc`,
            mode: l.mode,
            expiresAt: l.expiresAt,
            scope: 'server' as const,
          }));
        return { holders, queued: 0 };
      }
      case 'ai.semsearch': {
        const impl = w.semsearch;
        if (impl === 'enosys') fail('ENOSYS');
        return impl(
          this.str(a, 'q'),
          typeof a['scope'] === 'string' ? a['scope'] : '/',
          typeof a['mode'] === 'string' ? a['mode'] : 'auto',
        );
      }
      case 'ai.search.focus':
      case 'window.setTitle':
        return {};
      case 'ai.index.status':
        if (w.semsearch === 'enosys') fail('ENOSYS');
        return {
          state: 'idle',
          pending: 0,
          indexedFiles: w.indexedFiles,
          chunks: 99,
          modelKey: 'mdbr-leaf-ir-q8@4262131b-384',
          modelState: 'ready',
        };
      default:
        return fail('ENOSYS', `${name}: not in the fake`);
    }
  }
}

/** A world with alice (1001) and bob (1002), each with a home folder and some files. */
export function demoWorld(): { world: FakeWorld; alice: FakeSys; bob: FakeSys; root: FakeSys } {
  const world = new FakeWorld();
  const a = world.addUser('alice', 1001);
  const b = world.addUser('bob', 1002);
  world.users.unshift({ uid: 0, gid: 0, name: 'root', home: '/root' });
  world.mkdirAbs('/home/alice/Documents', 0o755, a.uid, a.gid);
  world.mkdirAbs('/home/alice/notes', 0o755, a.uid, a.gid);
  world.writeAbs('/home/alice/Documents/report.md', '# Report\n\nKernel scheduling notes.\n', a);
  world.writeAbs(
    '/home/alice/notes/week6-standup.md',
    '# Week 6\n\nWe discussed the LRU pager and page faults.\nNext: swap tiers.\n',
    a,
  );
  world.writeAbs('/home/alice/notes/.hidden', 'secret', a);
  world.mkdirAbs('/home/shared', 0o777, 0, 0);
  world.writeAbs('/home/shared/plan.md', '# Plan\n\n- ship\n', a, 0o666);
  world.writeAbs('/home/bob/private.txt', 'bob only', b, 0o600);
  const rootUser = world.users[0] ?? fail('EIO');
  return { world, alice: world.client(a), bob: world.client(b), root: world.client(rootUser) };
}
