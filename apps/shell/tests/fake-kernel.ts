/**
 * Test-only fake kernel for the shell (SYS-02 tests). It runs real program generators — the shell
 * itself and small test-double programs — round robin, and implements just enough of the ABI:
 * an in-memory file tree, descriptors, pipes, one TTY with a foreground group, process groups,
 * `wait`, signals with dispositions, and `sleep` on a virtual clock.
 */
import type { SignalName, WaitStatus } from '@plotinium/protocol';
import { SIGNALS, signalExitStatus } from '@plotinium/protocol';
import type { Errno } from '@plotinium/protocol';

import type { Program, ProgramContext, SysRequest, Yield } from '../../src/_sys.ts';
import { createSysStub, SysError } from '../../src/_sys.ts';
import { Screen } from './screen.ts';

const TICK = Symbol('tick');
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Pipe {
  id: number;
  buf: number[];
}

type Desc =
  | { kind: 'file'; path: string; pos: number; flags: string }
  | { kind: 'dir'; path: string }
  | { kind: 'pipeR'; pipe: Pipe }
  | { kind: 'pipeW'; pipe: Pipe }
  | { kind: 'tty' };

export interface FsNode {
  type: 'f' | 'd';
  data: string;
  mode: number;
  ino: string;
}

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  argv: string[];
  env: Map<string, string>;
  cwd: string;
  fds: Map<number, Desc>;
  program: Program<unknown>;
  st: unknown;
  gen: Generator<Yield, number, unknown> | null;
  ctx: ProgramContext;
  state: 'run' | 'zombie' | 'reaped';
  stopped: boolean;
  blocked: SysRequest | null;
  resume: { value: unknown } | { error: SysError } | null;
  status: WaitStatus | null;
  report: WaitStatus | null;
  sigs: Map<SignalName, 'default' | 'ignore' | 'catch'>;
  sleepUntil: number | null;
}

type Handler = (p: Proc, args: never) => unknown;

const BLOCK = Symbol('block');

function fail(errno: Errno): never {
  throw new SysError(errno);
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function normalize(cwd: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export interface KernelOptions {
  user?: string;
  uid?: number;
  cols?: number;
  rows?: number;
  pageSize?: number;
}

export class FakeKernel {
  readonly files = new Map<string, FsNode>();
  readonly programs = new Map<string, Program<unknown>>();
  readonly procs = new Map<number, Proc>();
  readonly screen: Screen;
  readonly crashes: unknown[] = [];
  readonly calls: { pid: number; call: string; args: unknown }[] = [];
  readonly handlers = new Map<string, (args: unknown) => unknown>();
  tty = {
    input: '',
    canonical: true,
    echo: true,
    isig: true,
    cols: 80,
    rows: 24,
    fgPgid: 0,
    sid: 0,
  };
  now = 1_000_000;
  user: string;
  uid: number;
  pageSize: number;
  private nextPid = 100;
  private nextIno = 1;
  private nextPipe = 1;

  constructor(opts: KernelOptions = {}) {
    this.user = opts.user ?? 'demo';
    this.uid = opts.uid ?? 1000;
    this.tty.cols = opts.cols ?? 80;
    this.tty.rows = opts.rows ?? 24;
    this.pageSize = opts.pageSize ?? 1000;
    this.screen = new Screen(this.tty.cols);
    for (const d of ['/', '/bin', '/home', `/home/${this.user}`, '/tmp', '/root']) this.mkdir(d);
  }

  // -------------------------------------------------------------------------------------------
  // File tree
  // -------------------------------------------------------------------------------------------

  mkdir(path: string, mode = 0o755): void {
    this.files.set(normalize('/', path), {
      type: 'd',
      data: '',
      mode,
      ino: `ino-${this.nextIno++}`,
    });
  }

  writeFile(path: string, data: string, mode = 0o644): void {
    this.files.set(normalize('/', path), { type: 'f', data, mode, ino: `ino-${this.nextIno++}` });
  }

  readFile(path: string): string | undefined {
    return this.files.get(normalize('/', path))?.data;
  }

  install(name: string, program: Program<unknown>, mode = 0o755): void {
    const path = `/bin/${name}.json`;
    this.writeFile(path, `{"name":"${name}"}`, mode);
    this.programs.set(path, program);
  }

  private node(p: Proc, path: string): { abs: string; node: FsNode | undefined } {
    const abs = normalize(p.cwd, path);
    return { abs, node: this.files.get(abs) };
  }

  private parentOk(abs: string): void {
    const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
    const node = this.files.get(parent);
    if (node === undefined) fail('ENOENT');
    if (node.type !== 'd') fail('ENOTDIR');
  }

  private stat(node: FsNode): Record<string, unknown> {
    return {
      ino: node.ino,
      type: node.type,
      mode: node.mode,
      uid: this.uid,
      gid: this.uid,
      size: enc.encode(node.data).length,
      nlink: 1,
      atime: this.now,
      mtime: this.now,
      ctime: this.now,
      version: 1,
      blob: null,
      target: null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Processes
  // -------------------------------------------------------------------------------------------

  private makeProc(
    program: Program<unknown>,
    argv: string[],
    init: {
      ppid: number;
      pgid: number | undefined;
      sid: number;
      env: Map<string, string>;
      cwd: string;
      fds: Map<number, Desc>;
    },
  ): Proc {
    const pid = this.nextPid++;
    const pgid = init.pgid === undefined ? pid : init.pgid === 0 ? pid : init.pgid;
    const ctx: ProgramContext = {
      pid,
      ppid: init.ppid,
      pgid,
      sid: init.sid === 0 ? pid : init.sid,
      uid: this.uid,
      gid: this.uid,
      argv,
      env: init.env,
      cwd: init.cwd,
      tty: 1,
      restored: 'no',
      sys: createSysStub(),
      tick: TICK,
      now: () => this.now,
    };
    const proc: Proc = {
      pid,
      ppid: init.ppid,
      pgid,
      sid: ctx.sid,
      argv,
      env: init.env,
      cwd: init.cwd,
      fds: init.fds,
      program,
      st: program.init(argv),
      gen: null,
      ctx,
      state: 'run',
      stopped: false,
      blocked: null,
      resume: null,
      status: null,
      report: null,
      sigs: new Map(),
      sleepUntil: null,
    };
    this.procs.set(pid, proc);
    return proc;
  }

  /** Starts the shell (or any program) as a session leader on the TTY. */
  start(
    program: Program<unknown>,
    argv: string[],
    opts: { env?: Record<string, string>; cwd?: string; stdin?: string } = {},
  ): number {
    const env = new Map(Object.entries(opts.env ?? {}));
    const fds = new Map<number, Desc>([
      [0, { kind: 'tty' }],
      [1, { kind: 'tty' }],
      [2, { kind: 'tty' }],
    ]);
    if (opts.stdin !== undefined && opts.stdin !== 'tty') {
      const pipe: Pipe = { id: this.nextPipe++, buf: [...enc.encode(opts.stdin)] };
      fds.set(0, { kind: 'pipeR', pipe });
    }
    const p = this.makeProc(program, argv, {
      ppid: 1,
      pgid: 0,
      sid: 0,
      env,
      cwd: opts.cwd ?? `/home/${this.user}`,
      fds,
    });
    this.tty.sid = p.sid;
    this.tty.fgPgid = p.pgid;
    return p.pid;
  }

  proc(pid: number): Proc | undefined {
    return this.procs.get(pid);
  }

  /** Live processes other than the given ones, for assertions. */
  live(): Proc[] {
    return [...this.procs.values()].filter((p) => p.state === 'run');
  }

  private report(p: Proc, status: WaitStatus): void {
    p.report = status;
  }

  private exit(p: Proc, status: WaitStatus): void {
    p.state = 'zombie';
    p.status = status;
    p.fds.clear();
    p.blocked = null;
  }

  signal(pid: number, sig: SignalName): void {
    const p = this.procs.get(pid);
    if (p === undefined || p.state !== 'run') return;
    if (sig === 'SIGKILL') {
      this.exit(p, { kind: 'signaled', signal: sig, code: signalExitStatus(sig) });
      return;
    }
    const disp = p.sigs.get(sig) ?? 'default';
    if (sig === 'SIGCONT' && p.stopped) {
      p.stopped = false;
      this.report(p, { kind: 'continued' });
    }
    if (disp === 'ignore') return;
    if (disp === 'catch') {
      p.program.signal?.(p.ctx, p.st, sig);
      if (p.blocked !== null) {
        p.blocked = null;
        p.sleepUntil = null;
        p.resume = { error: new SysError('ECANCELED') };
      }
      return;
    }
    const action = SIGNALS[sig].defaultAction;
    if (action === 'terminate')
      this.exit(p, { kind: 'signaled', signal: sig, code: signalExitStatus(sig) });
    else if (action === 'stop' && !p.stopped) {
      p.stopped = true;
      this.report(p, { kind: 'stopped', signal: sig });
    }
  }

  signalGroup(pgid: number, sig: SignalName): number {
    const targets = [...this.procs.values()].filter((p) => p.pgid === pgid && p.state === 'run');
    targets.forEach((p) => this.signal(p.pid, sig));
    return targets.length;
  }

  // -------------------------------------------------------------------------------------------
  // TTY
  // -------------------------------------------------------------------------------------------

  /** Keyboard input from the Terminal view (the kernel line discipline's input path). */
  type(data: string): void {
    for (const ch of data) {
      if (this.tty.isig && ch === '\x03') {
        this.tty.input = '';
        if (this.tty.echo) this.screen.write('^C\r\n');
        this.signalGroup(this.tty.fgPgid, 'SIGINT');
      } else if (this.tty.isig && ch === '\x1a') {
        if (this.tty.echo) this.screen.write('^Z\r\n');
        this.signalGroup(this.tty.fgPgid, 'SIGTSTP');
      } else {
        const c = this.tty.canonical && ch === '\r' ? '\n' : ch;
        this.tty.input += c;
        if (this.tty.canonical && this.tty.echo) this.screen.write(c === '\n' ? '\r\n' : c);
      }
    }
  }

  private ttyRead(p: Proc, len: number): ArrayBuffer | typeof BLOCK {
    if (p.pgid !== this.tty.fgPgid) {
      this.signalGroup(p.pgid, 'SIGTTIN');
      return BLOCK;
    }
    let take: string;
    if (this.tty.canonical) {
      const nl = this.tty.input.indexOf('\n');
      if (nl < 0) return BLOCK;
      take = this.tty.input.slice(0, Math.min(nl + 1, len));
    } else {
      if (this.tty.input.length === 0) return BLOCK;
      take = this.tty.input.slice(0, len);
    }
    this.tty.input = this.tty.input.slice(take.length);
    return toBuffer(enc.encode(take));
  }

  // -------------------------------------------------------------------------------------------
  // Descriptors
  // -------------------------------------------------------------------------------------------

  private desc(p: Proc, fd: number): Desc {
    const d = p.fds.get(fd);
    if (d === undefined) fail('EBADF');
    return d;
  }

  private freeFd(p: Proc): number {
    let fd = 0;
    while (p.fds.has(fd)) fd++;
    return fd;
  }

  private endsOf(pipe: Pipe, kind: 'pipeR' | 'pipeW'): number {
    let n = 0;
    for (const q of this.procs.values()) {
      if (q.state !== 'run') continue;
      for (const d of q.fds.values()) if (d.kind === kind && d.pipe === pipe) n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // System calls
  // -------------------------------------------------------------------------------------------

  private readonly table: Record<string, Handler> = {
    spawn: (
      p,
      a: {
        path: string;
        argv: string[];
        env?: Record<string, string>;
        fds?: Record<number, number>;
        pgid?: number;
      },
    ) => {
      const { abs, node } = this.node(p, a.path);
      const program = this.programs.get(abs);
      if (node === undefined || program === undefined) fail('ENOENT');
      if ((node.mode & 0o111) === 0) fail('EACCES');
      const fds = new Map<number, Desc>();
      for (const n of [0, 1, 2]) {
        const src = a.fds?.[n] ?? n;
        const d = p.fds.get(src);
        if (d === undefined && a.fds?.[n] !== undefined) fail('EBADF');
        if (d !== undefined) fds.set(n, d);
      }
      const env = new Map(Object.entries(a.env ?? Object.fromEntries(p.env)));
      const child = this.makeProc(program, a.argv, {
        ppid: p.pid,
        pgid: a.pgid ?? p.pgid,
        sid: p.sid,
        env,
        cwd: p.cwd,
        fds,
      });
      return { pid: child.pid };
    },
    wait: (p, a: { pid: number; nohang?: boolean; untraced?: boolean; continued?: boolean }) => {
      const kids = [...this.procs.values()].filter(
        (c) =>
          c.ppid === p.pid &&
          c.state !== 'reaped' &&
          (a.pid === -1 || (a.pid > 0 ? c.pid === a.pid : c.pgid === -a.pid)),
      );
      if (kids.length === 0) fail('ESRCH');
      const zombie = kids.find((c) => c.state === 'zombie');
      if (zombie !== undefined && zombie.status !== null) {
        zombie.state = 'reaped';
        return { pid: zombie.pid, status: zombie.status };
      }
      const rep = kids.find(
        (c) =>
          c.report !== null &&
          ((c.report.kind === 'stopped' && a.untraced === true) ||
            (c.report.kind === 'continued' && a.continued === true)),
      );
      if (rep !== undefined && rep.report !== null) {
        const status = rep.report;
        rep.report = null;
        return { pid: rep.pid, status };
      }
      return a.nohang === true ? { pid: 0 } : BLOCK;
    },
    kill: (p, a: { pid: number; sig: SignalName | 0 }) => {
      if (a.pid === 1) fail('EPERM');
      const pgid = a.pid < 0 ? -a.pid : a.pid === 0 ? p.pgid : null;
      const targets = [...this.procs.values()].filter(
        (q) => q.state === 'run' && (pgid === null ? q.pid === a.pid : q.pgid === pgid),
      );
      if (targets.length === 0) fail('ESRCH');
      if (a.sig !== 0) {
        const sig = a.sig;
        targets.forEach((q) => this.signal(q.pid, sig));
      }
      return { delivered: a.sig === 0 ? 0 : targets.length };
    },
    getpid: (p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid }),
    'proc.cred': () => ({
      uid: this.uid,
      gid: this.uid,
      groups: [],
      user: this.uid === 0 ? 'root' : this.user,
      groupNames: [],
      home: this.uid === 0 ? '/root' : `/home/${this.user}`,
      ruid: this.uid,
    }),
    getcwd: (p) => {
      const node = this.files.get(p.cwd);
      if (node === undefined) fail('ENOENT');
      return { path: p.cwd, ino: node.ino };
    },
    chdir: (p, a: { path: string }) => {
      const { abs, node } = this.node(p, a.path);
      if (node === undefined) fail('ENOENT');
      if (node.type !== 'd') fail('ENOTDIR');
      if ((node.mode & 0o111) === 0) fail('EACCES');
      p.cwd = abs;
      return { path: abs, ino: node.ino };
    },
    'sig.action': (p, a: { sig: SignalName; action: 'default' | 'ignore' | 'catch' }) => {
      const old = p.sigs.get(a.sig) ?? 'default';
      p.sigs.set(a.sig, a.action);
      return { old };
    },
    open: (
      p,
      a: { path: string; flags: string; create?: boolean; trunc?: boolean; mode?: number },
    ) => {
      const { abs } = this.node(p, a.path);
      let node = this.files.get(abs);
      if (node === undefined) {
        if (a.create !== true) fail('ENOENT');
        this.parentOk(abs);
        node = {
          type: 'f',
          data: '',
          mode: a.mode ?? 0o666 & ~0o022,
          ino: `ino-${this.nextIno++}`,
        };
        this.files.set(abs, node);
      } else if (node.type === 'd') {
        if (a.flags !== 'r') fail('EISDIR');
        const fd = this.freeFd(p);
        p.fds.set(fd, { kind: 'dir', path: abs });
        return { fd, ino: node.ino, type: 'd', version: 1, size: 0 };
      } else {
        const need = a.flags === 'r' ? 0o444 : 0o222;
        if ((node.mode & need) === 0) fail('EACCES');
        if (a.trunc === true) node.data = '';
      }
      const fd = this.freeFd(p);
      p.fds.set(fd, { kind: 'file', path: abs, pos: 0, flags: a.flags });
      return { fd, ino: node.ino, type: 'f', version: 1, size: node.data.length };
    },
    read: (p, a: { fd: number; len: number }) => {
      const d = this.desc(p, a.fd);
      if (d.kind === 'tty') return this.ttyRead(p, a.len);
      if (d.kind === 'dir') fail('EISDIR');
      if (d.kind === 'pipeW') fail('EBADF');
      if (d.kind === 'pipeR') {
        if (d.pipe.buf.length === 0)
          return this.endsOf(d.pipe, 'pipeW') === 0 ? new ArrayBuffer(0) : BLOCK;
        return toBuffer(Uint8Array.from(d.pipe.buf.splice(0, a.len)));
      }
      const bytes = enc.encode(this.files.get(d.path)?.data ?? '');
      const out = bytes.slice(d.pos, d.pos + a.len);
      d.pos += out.length;
      return toBuffer(out);
    },
    write: (p, a: { fd: number; data: ArrayBuffer }) => {
      const d = this.desc(p, a.fd);
      const bytes = new Uint8Array(a.data);
      if (d.kind === 'tty') {
        this.screen.write(dec.decode(bytes).replace(/\r?\n/g, '\r\n'));
      } else if (d.kind === 'pipeW') {
        if (this.endsOf(d.pipe, 'pipeR') === 0) {
          this.signal(p.pid, 'SIGPIPE');
          fail('EPIPE');
        }
        d.pipe.buf.push(...bytes);
      } else if (d.kind === 'file' && d.flags !== 'r') {
        const node = this.files.get(d.path);
        if (node === undefined) fail('ENOENT');
        const text = dec.decode(bytes);
        if (d.flags === 'a') node.data += text;
        else {
          node.data = node.data.slice(0, d.pos) + text + node.data.slice(d.pos + text.length);
          d.pos += text.length;
        }
      } else {
        fail('EBADF');
      }
      return { bytes: bytes.length };
    },
    close: (p, a: { fd: number }) => {
      this.desc(p, a.fd);
      p.fds.delete(a.fd);
      return {};
    },
    dup: (p, a: { fd: number }) => {
      const d = this.desc(p, a.fd);
      const fd = this.freeFd(p);
      p.fds.set(fd, d);
      return { fd };
    },
    dup2: (p, a: { fd: number; to: number }) => {
      const d = this.desc(p, a.fd);
      p.fds.set(a.to, d);
      return { fd: a.to };
    },
    pipe: (p) => {
      const pipe: Pipe = { id: this.nextPipe++, buf: [] };
      const r = this.freeFd(p);
      p.fds.set(r, { kind: 'pipeR', pipe });
      const w = this.freeFd(p);
      p.fds.set(w, { kind: 'pipeW', pipe });
      return { r, w };
    },
    isatty: (p, a: { fd: number }) => ({ tty: this.desc(p, a.fd).kind === 'tty' }),
    stat: (p, a: { path: string }) => {
      const { node } = this.node(p, a.path);
      if (node === undefined) fail('ENOENT');
      return this.stat(node);
    },
    lstat: (p, a: { path: string }) => {
      const { node } = this.node(p, a.path);
      if (node === undefined) fail('ENOENT');
      return this.stat(node);
    },
    readdir: (p, a: { path: string; cursor?: string }) => {
      const { abs, node } = this.node(p, a.path);
      if (node === undefined) fail('ENOENT');
      if (node.type !== 'd') fail('ENOTDIR');
      if ((node.mode & 0o444) === 0) fail('EACCES');
      const prefix = abs === '/' ? '/' : `${abs}/`;
      const names = [...this.files.entries()]
        .filter(
          ([path]) =>
            path !== abs && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
        )
        .map(([path, n]) => ({ name: path.slice(prefix.length), ino: n.ino, type: n.type }))
        .sort((x, y) => (x.name < y.name ? -1 : 1));
      const start = Number(a.cursor ?? '0');
      const page = names.slice(start, start + this.pageSize);
      const next = start + this.pageSize < names.length ? String(start + this.pageSize) : undefined;
      return next === undefined
        ? { entries: page, dirVersion: 1 }
        : { entries: page, next, dirVersion: 1 };
    },
    truncate: (p, a: { path: string; size: number }) => {
      const { node } = this.node(p, a.path);
      if (node === undefined) fail('ENOENT');
      node.data = node.data.slice(0, a.size);
      return { version: 2 };
    },
    tcsetpgrp: (p, a: { fd: number; pgid: number }) => {
      if (this.desc(p, a.fd).kind !== 'tty') fail('ENOTTY');
      this.tty.fgPgid = a.pgid;
      return {};
    },
    tcgetpgrp: (p, a: { fd: number }) => {
      if (this.desc(p, a.fd).kind !== 'tty') fail('ENOTTY');
      return { pgid: this.tty.fgPgid };
    },
    'tty.getattr': (p, a: { fd: number }) => {
      if (this.desc(p, a.fd).kind !== 'tty') fail('ENOTTY');
      const t = this.tty;
      return {
        n: 1,
        canonical: t.canonical,
        echo: t.echo,
        isig: t.isig,
        altScreen: false,
        cols: t.cols,
        rows: t.rows,
        fgPgid: t.fgPgid,
        sid: t.sid,
      };
    },
    'tty.setattr': (p, a: { fd: number; canonical?: boolean; echo?: boolean; isig?: boolean }) => {
      if (this.desc(p, a.fd).kind !== 'tty') fail('ENOTTY');
      if (a.canonical !== undefined) this.tty.canonical = a.canonical;
      if (a.echo !== undefined) this.tty.echo = a.echo;
      if (a.isig !== undefined) this.tty.isig = a.isig;
      return {};
    },
    'time.now': () => ({
      epochMs: this.now,
      monotonicMs: this.now,
      tz: 'Asia/Karachi',
      tzOffsetMin: 300,
    }),
    uname: () => ({ sysname: 'Plotinium', version: '0.3.0' }),
    'users.list': () => ({
      users: [
        { uid: this.uid, name: this.user, gid: this.uid, home: `/home/${this.user}`, groups: [] },
        { uid: 1001, name: 'bob', gid: 1001, home: '/home/bob', groups: [] },
      ],
      groups: [],
    }),
    sleep: (p, a: { ms: number }) => {
      p.sleepUntil ??= this.now + a.ms;
      if (this.now < p.sleepUntil) return BLOCK;
      p.sleepUntil = null;
      return { sleptMs: a.ms };
    },
  };

  private handle(p: Proc, req: SysRequest, retry: boolean): unknown {
    if (!retry) this.calls.push({ pid: p.pid, call: req.call, args: req.args });
    const custom = this.handlers.get(req.call);
    if (custom !== undefined) return custom(req.args);
    const h = this.table[req.call];
    if (h === undefined) fail('ENOSYS');
    return h(p, req.args as never);
  }

  /** Issues (or retries) a call; returns false when the process has to keep waiting. */
  private issue(p: Proc, req: SysRequest, retry: boolean): boolean {
    try {
      const res = this.handle(p, req, retry);
      if (res === BLOCK) {
        p.blocked = req;
        return false;
      }
      p.resume = { value: res };
    } catch (e) {
      if (!(e instanceof SysError)) throw e;
      p.resume = { error: e };
    }
    p.blocked = null;
    return true;
  }

  /** Retries the call a process is blocked on, or runs its generator to its next call. */
  private step(p: Proc): boolean {
    if (p.state !== 'run' || p.stopped) return false;
    if (p.blocked !== null && !this.issue(p, p.blocked, true)) return false;
    const gen = (p.gen ??= p.program.run(p.ctx, p.st));
    const resume = p.resume;
    p.resume = null;
    let r: IteratorResult<Yield, number>;
    try {
      r = resume !== null && 'error' in resume ? gen.throw(resume.error) : gen.next(resume?.value);
    } catch (e) {
      this.crashes.push(e);
      this.exit(p, { kind: 'exited', code: 1 });
      return true;
    }
    if (p.state !== 'run') return true;
    if (r.done === true) {
      this.exit(p, { kind: 'exited', code: r.value });
      return true;
    }
    if (typeof r.value !== 'symbol') this.issue(p, r.value, false);
    return true;
  }

  /** Runs every process until nothing can make progress. */
  run(maxSteps = 200_000): void {
    for (let i = 0; i < maxSteps; i++) {
      let progress = false;
      for (const p of [...this.procs.values()]) if (this.step(p)) progress = true;
      if (!progress) return;
    }
    throw new Error('fake kernel: step limit reached');
  }

  /** Advances the virtual clock and runs. */
  advance(ms: number): void {
    this.now += ms;
    this.run();
  }

  /** Types input and runs until everything is blocked again. */
  send(data: string): void {
    this.type(data);
    this.run();
  }

  /**
   * Simulates a page-out and page-in of a blocked process: its state goes through a structured
   * clone and `run` is re-entered from the top (processes-and-scheduling.md §3.5.1 rule 4).
   */
  checkpointRestore(pid: number): void {
    const p = this.procs.get(pid);
    if (p === undefined || p.blocked === null) throw new Error('restore needs a blocked process');
    p.st = structuredClone(p.st);
    p.gen = p.program.run({ ...p.ctx, restored: 'page-in' }, p.st);
    p.blocked = null;
    p.resume = null;
  }

  exitStatus(pid: number): WaitStatus | null {
    return this.procs.get(pid)?.status ?? null;
  }

  callsOf(name: string): unknown[] {
    return this.calls.filter((c) => c.call === name).map((c) => c.args);
  }
}
