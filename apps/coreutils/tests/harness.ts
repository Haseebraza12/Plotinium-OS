/**
 * Test-only kernel for the coreutils: drives a program's generator, answers its system calls from
 * `FakeFs` and per-test handlers, and collects stdout and stderr. A handler may throw a `SysError`,
 * which is thrown into the program exactly as the executor runtime does.
 */
import type { ModeChange, SignalName } from '@plotinium/protocol';

import type {
  AnyCallName,
  CallArgs,
  CallRet,
  Program,
  ProgramContext,
  Sys,
  SysGen,
} from '../lib/sys.ts';
import { decodeText, encodeText, SysError } from '../lib/sys.ts';
import { FakeFs } from './fakefs.ts';

export type Handler = (args: never, k: FakeKernel) => unknown;

interface OpenFile {
  ino: string;
  pos: number;
  write: boolean;
  append: boolean;
}

export interface RunResult {
  readonly status: number;
  readonly out: string;
  readonly err: string;
  readonly calls: readonly { call: string; args: unknown }[];
}

export interface RunOptions {
  readonly cwd?: string;
  readonly stdin?: string;
  readonly tty?: boolean;
  readonly env?: Record<string, string>;
  /** Signals delivered to the program's hook before it runs (as if caught mid-run). */
  readonly signals?: readonly SignalName[];
}

export class FakeKernel {
  readonly fs = new FakeFs();
  readonly handlers = new Map<string, Handler>();
  calls: { call: string; args: unknown }[] = [];
  out = '';
  err = '';
  stdin = '';
  tty = false;
  cwd = '/';
  pid = 300;
  private fds = new Map<number, OpenFile>();
  private nextFd = 3;

  /** Registers (or replaces) a handler for one call. */
  on<C extends AnyCallName>(name: C, fn: (args: CallArgs<C>, k: FakeKernel) => CallRet<C>): this;
  on(name: string, fn: (args: never, k: FakeKernel) => unknown): this;
  on(name: string, fn: Handler): this {
    this.handlers.set(name, fn);
    return this;
  }

  /** Makes a call fail with an errno (optionally with msg and detail). */
  fail(
    name: string,
    errno: SysError['errno'],
    extra: { msg?: string; detail?: Record<string, unknown> } = {},
  ): this {
    return this.on(name, () => {
      throw Object.assign(
        new SysError(errno, extra.msg),
        extra.detail === undefined ? {} : { detail: extra.detail },
        extra.msg === undefined ? {} : { msg: extra.msg },
      );
    });
  }

  countCalls(name: string): number {
    return this.calls.filter((c) => c.call === name).length;
  }

  argsOf(name: string): unknown[] {
    return this.calls.filter((c) => c.call === name).map((c) => c.args);
  }

  dispatch(call: string, args: unknown): unknown {
    this.calls.push({ call, args });
    const custom = this.handlers.get(call);
    if (custom !== undefined) return custom(args as never, this);
    const builtin = this.builtins[call];
    if (builtin === undefined) throw new SysError('ENOSYS');
    return builtin(args as never);
  }

  run<St>(program: Program<St>, argv: readonly string[], options: RunOptions = {}): RunResult {
    this.calls = [];
    this.out = '';
    this.err = '';
    if (options.stdin !== undefined) this.stdin = options.stdin;
    this.tty = options.tty ?? false;
    if (options.cwd !== undefined) this.cwd = options.cwd;
    const sys: Sys = {
      *call<C extends AnyCallName>(name: C, args: CallArgs<C>): SysGen<CallRet<C>> {
        const reply = yield { call: name, args };
        return reply as CallRet<C>;
      },
    };
    const env = new Map(
      Object.entries({ HOME: '/home/alice', USER: 'alice', PATH: '/bin', ...options.env }),
    );
    const tick = Symbol('tick');
    const ctx: ProgramContext = {
      pid: this.pid,
      ppid: 200,
      pgid: this.pid,
      sid: 200,
      uid: this.fs.cred.uid,
      gid: this.fs.cred.gid,
      argv,
      env,
      cwd: this.cwd,
      tty: this.tty ? 1 : null,
      restored: 'no',
      sys,
      tick,
      now: () => this.fs.clock,
    };
    const st = program.init(argv);
    for (const sig of options.signals ?? []) program.signal?.(ctx, st, sig);
    const gen = program.run(ctx, st);
    let next = gen.next();
    let steps = 0;
    while (next.done !== true) {
      steps += 1;
      if (steps > 1_000_000) throw new Error('program did not finish');
      const req = next.value;
      if (typeof req === 'symbol') {
        next = gen.next();
        continue;
      }
      let reply: unknown;
      try {
        reply = this.dispatch(req.call, req.args);
      } catch (e) {
        next = gen.throw(e);
        continue;
      }
      next = gen.next(reply);
    }
    return { status: next.value, out: this.out, err: this.err, calls: this.calls };
  }

  // -------------------------------------------------------------------------------------------
  // Built-in handlers (files and descriptors)
  // -------------------------------------------------------------------------------------------

  private file(fd: number): OpenFile {
    const f = this.fds.get(fd);
    if (f === undefined) throw new SysError('EBADF');
    return f;
  }

  private readonly builtins: Record<string, (args: never) => unknown> = {
    isatty: (a: { fd: number }) => ({ tty: this.tty && a.fd <= 2, ...(this.tty ? { n: 1 } : {}) }),
    'tty.getattr': (a: { fd: number }) => {
      if (!this.tty || a.fd > 2) throw new SysError('ENOTTY');
      return {
        n: 1,
        canonical: true,
        echo: true,
        isig: true,
        altScreen: false,
        cols: 80,
        rows: 24,
        fgPgid: this.pid,
        sid: 200,
      };
    },
    'time.now': () => ({
      epochMs: this.fs.clock,
      monotonicMs: 1000,
      tz: 'Asia/Karachi',
      tzOffsetMin: 300,
    }),
    umask: (a: { mask?: number }) => {
      const old = this.fs.umask;
      if (a.mask !== undefined) this.fs.umask = a.mask;
      return { old };
    },
    getcwd: () => {
      const r = this.fs.resolve(this.cwd, '/', true);
      return { path: this.fs.pathOf(r.ino), ino: r.ino };
    },
    'sig.action': () => ({ old: 'default' }),
    'users.list': () => ({
      users: [
        { uid: 0, name: 'root', gid: 0, home: '/root', groups: [0] },
        { uid: 1001, name: 'alice', gid: 1001, home: '/home/alice', groups: [1001, 100, 1002] },
        { uid: 1002, name: 'bob', gid: 1002, home: '/home/bob', groups: [1002, 100] },
      ],
      groups: [
        { gid: 0, name: 'root' },
        { gid: 100, name: 'users' },
        { gid: 1001, name: 'alice' },
        { gid: 1002, name: 'team' },
      ],
    }),
    stat: (a: { path: string; follow?: boolean }) =>
      this.fs.stat(this.fs.node(this.fs.resolve(a.path, this.cwd, a.follow !== false).ino)),
    lstat: (a: { path: string }) =>
      this.fs.stat(this.fs.node(this.fs.resolve(a.path, this.cwd, false).ino)),
    readlink: (a: { path: string }) => {
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, false).ino);
      if (n.type !== 'l') throw new SysError('EINVAL');
      return { target: n.target };
    },
    open: (a: {
      path: string;
      flags: 'r' | 'w' | 'rw' | 'a';
      create?: boolean;
      trunc?: boolean;
      excl?: boolean;
      mode?: number;
    }) => {
      let ino: string;
      try {
        ino = this.fs.resolve(a.path, this.cwd, true).ino;
        if (a.excl === true && a.create === true) throw new SysError('EEXIST');
      } catch (e) {
        if (!(e instanceof SysError) || e.errno !== 'ENOENT' || a.create !== true) throw e;
        ino = this.fs.create(a.path, this.cwd, 'f', a.mode ?? 0o666).ino;
      }
      const n = this.fs.node(ino);
      if (n.type === 'd') throw new SysError('EISDIR');
      const write = a.flags !== 'r';
      if ((a.flags === 'r' || a.flags === 'rw') && !this.fs.can(n, 4)) throw new SysError('EACCES');
      if (write && !this.fs.can(n, 2)) throw new SysError('EACCES');
      if (a.trunc === true) n.data = new Uint8Array();
      const fd = this.nextFd++;
      this.fds.set(fd, { ino, pos: 0, write, append: a.flags === 'a' });
      return { fd, ino, type: n.type, version: n.version, size: n.data.length };
    },
    read: (a: { fd: number; len: number }) => {
      if (a.fd === 0) {
        const bytes = encodeText(this.stdin);
        const chunk = bytes.slice(0, a.len);
        this.stdin = decodeText(bytes.slice(a.len));
        return chunk;
      }
      const f = this.file(a.fd);
      const n = this.fs.node(f.ino);
      const chunk = n.data.slice(f.pos, f.pos + a.len);
      f.pos += chunk.length;
      return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    },
    write: (a: { fd: number; data: ArrayBuffer }) => {
      const text = decodeText(a.data);
      if (a.fd === 1) this.out += text;
      else if (a.fd === 2) this.err += text;
      else {
        const f = this.file(a.fd);
        const n = this.fs.node(f.ino);
        const bytes = new Uint8Array(a.data);
        const start = f.append ? n.data.length : f.pos;
        const next = new Uint8Array(Math.max(n.data.length, start + bytes.length));
        next.set(n.data);
        next.set(bytes, start);
        n.data = next;
        f.pos = start + bytes.length;
      }
      return { bytes: a.data.byteLength };
    },
    close: (a: { fd: number }) => {
      this.file(a.fd);
      this.fds.delete(a.fd);
      return {};
    },
    readdir: (a: { path: string; plus?: boolean; cursor?: string; limit?: number }) => {
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, true).ino);
      if (n.type !== 'd') throw new SysError('ENOTDIR');
      if (!this.fs.can(n, 4)) throw new SysError('EACCES');
      const all = this.fs.entries(n, a.plus === true);
      const start = Number(a.cursor ?? '0');
      const limit = a.limit ?? 1000;
      const entries = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : undefined;
      return { entries, dirVersion: n.version, ...(next === undefined ? {} : { next }) };
    },
    mkdir: (a: { path: string; mode?: number; parents?: boolean }) => {
      if (a.parents === true) {
        const r = this.fs.mkdirp(a.path, this.cwd, a.mode ?? 0o777);
        return { ino: r.ino, created: r.created, opId: r.ino, sync: 'applied' };
      }
      const n = this.fs.create(a.path, this.cwd, 'd', a.mode ?? 0o777);
      return { ino: n.ino, created: 1, opId: n.ino, sync: 'applied' };
    },
    rmdir: (a: { path: string }) => {
      const r = this.fs.resolve(a.path, this.cwd, false);
      const n = this.fs.node(r.ino);
      if (n.type !== 'd') throw new SysError('ENOTDIR');
      if (n.children.size > 0) throw new SysError('ENOTEMPTY');
      this.fs.remove(a.path, this.cwd, true);
      return { opId: n.ino, sync: 'applied' };
    },
    unlink: (a: { path: string; recursive?: boolean }) => {
      const r = this.fs.remove(a.path, this.cwd, a.recursive === true);
      return { ...r, opId: this.fs.root, sync: 'applied' };
    },
    rename: (a: { from: string; to: string; noReplace?: boolean }) => {
      const src = this.fs.resolve(a.from, this.cwd, false);
      const from = this.fs.node(src.parent);
      const { dir, name } = this.fs.parentOf(a.to, this.cwd);
      if (
        this.fs.pathOf(dir.ino).startsWith(this.fs.pathOf(src.ino)) &&
        this.fs.node(src.ino).type === 'd'
      ) {
        throw new SysError('EINVAL');
      }
      const existing = dir.children.get(name);
      if (existing !== undefined) {
        if (a.noReplace === true) throw new SysError('EEXIST');
        const e = this.fs.node(existing);
        if (e.type === 'd' && this.fs.node(src.ino).type !== 'd') throw new SysError('EISDIR');
        if (e.type === 'd' && e.children.size > 0) throw new SysError('ENOTEMPTY');
        this.fs.detach(dir, name);
      }
      this.fs.detach(from, src.name);
      dir.children.set(name, src.ino);
      this.fs.node(src.ino).parent = dir.ino;
      return { ino: src.ino, opId: src.ino, sync: 'applied' };
    },
    symlink: (a: { target: string; path: string }) => {
      const n = this.fs.create(a.path, this.cwd, 'l', 0o777);
      n.mode = 0o777;
      n.target = a.target;
      return { ino: n.ino, opId: n.ino, sync: 'applied' };
    },
    link: () => {
      throw new SysError('ENOSYS');
    },
    chmod: (a: { path: string; mode: ModeChange; recursive?: boolean }) => {
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, true).ino);
      let changed = 0;
      const apply = (x: typeof n): void => {
        if (x.type === 'l') return;
        if (this.fs.cred.uid !== 0 && x.uid !== this.fs.cred.uid) throw new SysError('EPERM');
        this.fs.applyMode(x, a.mode);
        changed += 1;
      };
      if (a.recursive === true) this.fs.walk(n, apply);
      else apply(n);
      return { changed, opId: n.ino, sync: 'applied' };
    },
    chown: (a: { path: string; uid?: number; gid?: number; recursive?: boolean }) => {
      if (this.fs.cred.uid !== 0) throw new SysError('EPERM');
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, false).ino);
      let changed = 0;
      const apply = (x: typeof n): void => {
        if (a.uid !== undefined) x.uid = a.uid;
        if (a.gid !== undefined) x.gid = a.gid;
        changed += 1;
      };
      if (a.recursive === true) this.fs.walk(n, apply);
      else apply(n);
      return { changed, opId: n.ino, sync: 'applied' };
    },
    utimes: (a: { path: string; atime?: number | 'now'; mtime?: number | 'now' }) => {
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, true).ino);
      if (a.atime !== undefined) n.atime = a.atime === 'now' ? this.fs.clock : a.atime;
      if (a.mtime !== undefined) n.mtime = a.mtime === 'now' ? this.fs.clock : a.mtime;
      return { opId: n.ino, sync: 'applied' };
    },
    copy: (a: {
      from: string;
      to: string;
      recursive?: boolean;
      noReplace?: boolean;
      preserve?: boolean;
    }) => {
      const src = this.fs.node(this.fs.resolve(a.from, this.cwd, true).ino);
      if (src.type === 'd' && a.recursive !== true) throw new SysError('EISDIR');
      const { dir, name } = this.fs.parentOf(a.to, this.cwd);
      if (this.fs.pathOf(dir.ino).startsWith(this.fs.pathOf(src.ino)) && src.type === 'd')
        throw new SysError('EINVAL');
      const existing = dir.children.get(name);
      if (existing !== undefined) {
        if (a.noReplace === true) throw new SysError('EEXIST');
        const e = this.fs.node(existing);
        if (!this.fs.can(e, 2)) throw new SysError('EACCES');
        this.fs.detach(dir, name);
      }
      const copied = this.fs.copyTree(src, dir, name, a.preserve === true);
      return { copied, bytes: this.fs.count(src).bytes, opId: src.ino, sync: 'applied' };
    },
    find: (a: {
      path: string;
      maxDepth?: number;
      cursor?: string;
      limit?: number;
      plus?: boolean;
      name?: string;
      type?: string;
    }) => {
      const r = this.fs.resolve(a.path, this.cwd, true);
      const base = a.path.replace(/\/+$/, '') || '/';
      const paths: string[] = [];
      const entries: ReturnType<FakeFs['entries']> = [];
      let denied = 0;
      const visit = (ino: string, prefix: string, depth: number): void => {
        const dir = this.fs.node(ino);
        if (dir.type !== 'd' || (a.maxDepth !== undefined && depth >= a.maxDepth)) return;
        if (!this.fs.can(dir, 5)) {
          denied += 1;
          return;
        }
        for (const e of this.fs.entries(dir, true)) {
          const p = prefix === '/' ? `/${e.name}` : `${prefix}/${e.name}`;
          const typeOk = a.type === undefined || e.type === a.type;
          if (typeOk) {
            paths.push(p);
            entries.push(e);
          }
          visit(e.ino, p, depth + 1);
        }
      };
      visit(r.ino, base, 0);
      const start = Number(a.cursor ?? '0');
      const limit = a.limit ?? 1000;
      const next = start + limit < paths.length ? String(start + limit) : undefined;
      return {
        paths: paths.slice(start, start + limit),
        ...(a.plus === true ? { entries: entries.slice(start, start + limit) } : {}),
        denied,
        truncated: false,
        ...(next === undefined ? {} : { next }),
      };
    },
    du: (a: { path: string; maxDepth?: number }) => {
      const n = this.fs.node(this.fs.resolve(a.path, this.cwd, true).ino);
      const total = this.fs.count(n);
      const children = [...n.children].map(([name, ino]) => {
        const c = this.fs.count(this.fs.node(ino));
        return { name, bytes: c.bytes, inodes: c.removed };
      });
      return {
        bytes: total.bytes,
        inodes: total.removed,
        denied: 0,
        ...(a.maxDepth === 0 ? {} : { children }),
      };
    },
  };
}

/** A kernel with a home directory for alice and her cwd set to it. */
export function kernel(): FakeKernel {
  const k = new FakeKernel();
  k.fs.addDir('/home/alice');
  k.cwd = '/home/alice';
  return k;
}
