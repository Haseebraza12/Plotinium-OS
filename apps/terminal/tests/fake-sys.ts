/**
 * Test-only fake of the kernel side of the Terminal: an in-memory file system and identity behind
 * a promise `call(name, args)`, the shape of a view port's system-call client. Everything a
 * terminal session needs from the kernel besides processes and TTYs (which the process host runs)
 * goes through here, so the SYS-02 session exercises the real shell and coreutils.
 */
import type { DirEntry, Errno, Stat } from '@plotinium/protocol';
import { SysError } from '@plotinium/kernel/sys';

interface Node {
  ino: string;
  type: 'f' | 'd';
  mode: number;
  uid: number;
  gid: number;
  data: Uint8Array;
  children: Map<string, string>;
  mtime: number;
  version: number;
}

interface OpenFile {
  ino: string;
  pos: number;
  flags: string;
}

const enc = new TextEncoder();

function fail(errno: Errno, message?: string): never {
  throw new SysError(errno, message);
}

function rec(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

export class FakeSys {
  readonly nodes = new Map<string, Node>();
  readonly calls: string[] = [];
  /** Extra kernel calls for a test (for example `ai.agent.submit`); they win over the built-ins. */
  readonly handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  readonly uid = 1000;
  readonly gid = 1000;
  readonly user = 'demo';
  readonly home = '/home/demo';
  private seq = 0;
  private readonly files = new Map<number, OpenFile>();
  private nextFd = 3;
  private readonly root: string;

  constructor() {
    this.root = this.alloc('d', 0o755, 0);
    this.mkdirs('/bin', 0);
    this.mkdirs('/tmp', 0).mode = 0o777;
    this.mkdirs('/root', 0).mode = 0o700;
    this.mkdirs(this.home, this.uid);
    this.addFile(`${this.home}/notes.md`, '# notes\n');
    this.addFile(`${this.home}/todo.txt`, 'one\ntwo\n');
  }

  private alloc(type: 'f' | 'd', mode: number, uid: number): string {
    this.seq += 1;
    const ino = `0192f0c1-7c2e-7a51-9d6f-${this.seq.toString(16).padStart(12, '0')}`;
    this.nodes.set(ino, {
      ino,
      type,
      mode,
      uid,
      gid: uid,
      data: new Uint8Array(),
      children: new Map(),
      mtime: Date.UTC(2026, 8, 26, 9, 0, 0),
      version: 1,
    });
    return ino;
  }

  private node(ino: string): Node {
    const n = this.nodes.get(ino);
    if (n === undefined) fail('ENOENT');
    return n;
  }

  private lookup(path: string): Node | undefined {
    if (!path.startsWith('/')) fail('EINVAL', `relative path ${path}`);
    let cur = this.node(this.root);
    for (const part of path.split('/').filter((x) => x !== '' && x !== '.')) {
      if (cur.type !== 'd') fail('ENOTDIR');
      const next = cur.children.get(part);
      if (next === undefined) return undefined;
      cur = this.node(next);
    }
    return cur;
  }

  private parentOf(path: string): { dir: Node; name: string } {
    const parts = path.split('/').filter((x) => x !== '');
    const name = parts.pop() ?? '';
    const dir = this.lookup(`/${parts.join('/')}`);
    if (dir === undefined) fail('ENOENT');
    if (dir.type !== 'd') fail('ENOTDIR');
    return { dir, name };
  }

  mkdirs(path: string, uid: number): Node {
    let cur = this.node(this.root);
    for (const part of path.split('/').filter((x) => x !== '')) {
      let next = cur.children.get(part);
      if (next === undefined) {
        next = this.alloc('d', 0o755, uid);
        cur.children.set(part, next);
      }
      cur = this.node(next);
    }
    return cur;
  }

  addFile(path: string, text: string): Node {
    const { dir, name } = this.parentOf(path);
    const ino = this.alloc('f', 0o644, this.uid);
    dir.children.set(name, ino);
    const n = this.node(ino);
    n.data = enc.encode(text);
    return n;
  }

  text(path: string): string | undefined {
    const n = this.lookup(path);
    return n === undefined ? undefined : new TextDecoder().decode(n.data);
  }

  private stat(n: Node): Stat {
    return {
      ino: n.ino,
      type: n.type,
      mode: n.mode,
      uid: n.uid,
      gid: n.gid,
      size: n.data.byteLength,
      nlink: n.type === 'd' ? 2 : 1,
      atime: n.mtime,
      mtime: n.mtime,
      ctime: n.mtime,
      version: n.version,
      blob: null,
      target: null,
    };
  }

  /** The view port's `sys.call`. */
  call = (name: string, args: unknown): Promise<unknown> => {
    this.calls.push(name);
    try {
      return Promise.resolve(this.handle(name, rec(args)));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };

  private handle(name: string, a: Record<string, unknown>): unknown {
    const extra = this.handlers.get(name);
    if (extra !== undefined) return extra(a);
    const path = typeof a['path'] === 'string' ? a['path'] : '';
    switch (name) {
      case 'proc.cred':
        return {
          uid: this.uid,
          gid: this.gid,
          groups: [this.gid],
          user: this.user,
          groupNames: [this.user],
          home: this.home,
          ruid: this.uid,
        };
      case 'uname':
        return {
          sysname: 'Plotinium',
          version: '0.3.0',
          build: 'abcdef0',
          buildDate: '2026-09-26',
          codename: null,
          browser: { brand: 'Chrome', major: 140 },
          cores: 8,
          uid: this.uid,
          user: this.user,
        };
      case 'time.now':
        return {
          epochMs: Date.UTC(2026, 8, 26, 9, 0, 0),
          monotonicMs: 1,
          tz: 'UTC',
          tzOffsetMin: 0,
        };
      case 'users.list':
        return {
          users: [
            { uid: this.uid, name: this.user, gid: this.gid, home: this.home, groups: [this.gid] },
          ],
          groups: [{ gid: this.gid, name: this.user }],
        };
      case 'stat':
      case 'lstat': {
        const n = this.lookup(path);
        if (n === undefined) fail('ENOENT');
        return this.stat(n);
      }
      case 'readdir': {
        const n = this.lookup(path);
        if (n === undefined) fail('ENOENT');
        if (n.type !== 'd') fail('ENOTDIR');
        const entries: DirEntry[] = [...n.children.entries()]
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([entry, ino]) => {
            const child = this.node(ino);
            const base = { name: entry, ino, type: child.type };
            return a['plus'] === true ? { ...base, stat: this.stat(child) } : base;
          });
        return { entries, dirVersion: 1 };
      }
      case 'mkdir': {
        if (a['parents'] === true) {
          this.mkdirs(path, this.uid);
          return {
            ino: this.lookup(path)?.ino,
            created: 1,
            opId: this.lookup(path)?.ino,
            sync: 'applied',
          };
        }
        const { dir, name: base } = this.parentOf(path);
        if (dir.children.has(base)) fail('EEXIST');
        const ino = this.alloc('d', 0o755, this.uid);
        dir.children.set(base, ino);
        return { ino, created: 1, opId: ino, sync: 'applied' };
      }
      case 'open': {
        const flags = typeof a['flags'] === 'string' ? a['flags'] : 'r';
        let n = this.lookup(path);
        if (n === undefined) {
          if (a['create'] !== true) fail('ENOENT');
          n = this.addFile(path, '');
        } else if (a['excl'] === true && a['create'] === true) fail('EEXIST');
        if (n.type === 'd' && flags !== 'r') fail('EISDIR');
        if (a['trunc'] === true) n.data = new Uint8Array();
        const fd = this.nextFd++;
        this.files.set(fd, { ino: n.ino, pos: flags === 'a' ? n.data.byteLength : 0, flags });
        return { fd, ino: n.ino, type: n.type, version: n.version, size: n.data.byteLength };
      }
      case 'read': {
        const f = this.files.get(Number(a['fd']));
        if (f === undefined) fail('EBADF');
        const n = this.node(f.ino);
        const len = Number(a['len']);
        const out = n.data.slice(f.pos, f.pos + len);
        f.pos += out.byteLength;
        return out.buffer;
      }
      case 'write': {
        const f = this.files.get(Number(a['fd']));
        if (f === undefined) fail('EBADF');
        const data = a['data'];
        if (!(data instanceof ArrayBuffer)) fail('EINVAL');
        const n = this.node(f.ino);
        const bytes = new Uint8Array(data);
        const start = f.flags === 'a' ? n.data.byteLength : f.pos;
        const next = new Uint8Array(Math.max(n.data.byteLength, start + bytes.byteLength));
        next.set(n.data);
        next.set(bytes, start);
        n.data = next;
        n.version += 1;
        f.pos = start + bytes.byteLength;
        return { bytes: bytes.byteLength, version: n.version, sync: 'applied' };
      }
      case 'close':
        if (!this.files.delete(Number(a['fd']))) fail('EBADF');
        return {};
      case 'truncate': {
        const n = this.lookup(path);
        if (n === undefined) fail('ENOENT');
        n.data = n.data.slice(0, Number(a['size']));
        return { version: n.version, sync: 'applied' };
      }
      case 'unlink': {
        const { dir, name: base } = this.parentOf(path);
        if (!dir.children.delete(base)) fail('ENOENT');
        return { removed: 1, bytes: 0, sync: 'applied' };
      }
      default:
        return fail('ENOSYS', `${name} is not in the fake`);
    }
  }
}
