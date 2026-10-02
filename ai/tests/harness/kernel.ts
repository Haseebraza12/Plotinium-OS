/**
 * A small simulated kernel for the AI integration tests: an in-memory file system with POSIX
 * permissions (structurally the kernel's `KernelFs`), an event bus, a virtual clock with timers,
 * the kernel's real `HookRegistry`, a handler registry, and a PROGRAM DRIVER that runs the ai/
 * programs' generators and answers their system calls: the file calls from the in-memory tree,
 * the `ai.*` calls through the handlers `installAi` registered.
 *
 * Test-only. It favours obviousness over fidelity: no scheduler (a program runs until it blocks
 * on a condition the test controls), and the bus delivers every event to every matching
 * subscriber (the `sys.subscribe` path scope is applied here).
 */
import { HookRegistry } from '@plotinium/kernel/hooks';
import type { ErrDetail, Errno, EventData, KEvent, Topic } from '@plotinium/protocol';
import { INO, uuidv7 } from '@plotinium/protocol';

import type { EmbedTimers, EmbedWorkerLike } from '../../src/kernel/embed-service.ts';
import type { MayFn } from '../../src/kernel/fs-view.ts';
import type { AiInstallation } from '../../src/kernel/install.ts';
import type {
  AiLinkContextLike,
  FsActorLike,
  KernelFsLike,
  TreeEntryLike,
  TreeInodeLike,
} from '../../src/kernel/link.ts';
import { createAiLink, type AiLinkDeps } from '../../src/kernel/link.ts';
import type {
  AiBus,
  AiCallImpl,
  AiCaller,
  AiPcb,
  AiSubscription,
  HandlerTarget,
} from '../../src/kernel/types.ts';
import type { FromEmbedWorker, ToEmbedWorker } from '../../src/embed/protocol.ts';
import type { AiProgram, AiProgramContext, SysGen, Yield } from '../../src/programs/model.ts';
import type { CallName } from '@plotinium/protocol';

// ---------------------------------------------------------------------------------------------
// Errors, clock, timers
// ---------------------------------------------------------------------------------------------

/** The kernel's `KernelError` shape (errno + detail), as the dispatcher and `SysError` carry it. */
export class TestKernelError extends Error {
  readonly errno: Errno;
  readonly detail: ErrDetail | undefined;

  constructor(errno: Errno, detail?: ErrDetail, message?: string) {
    super(message ?? errno);
    this.name = 'KernelError';
    this.errno = errno;
    this.detail = detail;
  }
}

export const makeError = (errno: Errno, detail?: ErrDetail, message?: string): Error =>
  new TestKernelError(errno, detail, message);

/** Virtual time: `advance` runs every due timer in deadline order. */
export class VirtualClock implements EmbedTimers {
  t = 0;
  readonly epoch0 = Date.UTC(2026, 8, 26, 9, 0, 0);
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  epochMs(): number {
    return this.epoch0 + this.t;
  }

  set(fn: () => void, ms: number): number {
    const h = this.next++;
    this.timers.set(h, { at: this.t + Math.max(0, ms), fn });
    return h;
  }

  clear(h: number): void {
    this.timers.delete(h);
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers)
        if (e[1].at <= end && (due === undefined || e[1].at < due[1].at)) due = e;
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

/** Let queued promise callbacks run (the fake worker answers asynchronously). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------------------------

interface Sub extends AiSubscription {
  readonly patterns: readonly string[];
  readonly onReady: ((sub: AiSubscription) => void) | undefined;
  readonly filter: (ev: KEvent) => boolean;
  queue: KEvent[];
  closed: boolean;
}

function topicMatches(pattern: string, topic: string): boolean {
  return pattern === topic || (pattern.endsWith('.*') && topic.startsWith(pattern.slice(0, -1)));
}

export class FakeBus implements AiBus {
  readonly published: KEvent[] = [];
  private readonly subs: Sub[] = [];
  private readonly seqs = new Map<string, number>();
  private readonly clock: VirtualClock;

  constructor(clock: VirtualClock) {
    this.clock = clock;
  }

  publish<T extends Topic>(topic: T, data: EventData[T]): unknown {
    const seq = (this.seqs.get(topic) ?? 0) + 1;
    this.seqs.set(topic, seq);
    const ev = { topic, seq, t: Math.floor(this.clock.epochMs()), data } as unknown as KEvent;
    this.published.push(ev);
    for (const s of this.subs) {
      if (s.closed || !s.patterns.some((p) => topicMatches(p, topic)) || !s.filter(ev)) continue;
      const wasEmpty = s.queue.length === 0;
      s.queue.push(ev);
      if (wasEmpty) s.onReady?.(s);
    }
    return ev;
  }

  subscribe(
    patterns: readonly string[],
    opts: {
      readonly onReady?: (sub: AiSubscription) => void;
      readonly filter?: (ev: KEvent) => boolean;
    },
  ): Sub {
    const sub: Sub = {
      patterns: [...patterns],
      onReady: opts.onReady,
      filter: opts.filter ?? (() => true),
      queue: [],
      closed: false,
      take(max = 1_024) {
        const events = this.queue.slice(0, max);
        this.queue = this.queue.slice(max);
        return { events, dropped: 0 };
      },
    };
    this.subs.push(sub);
    return sub;
  }

  topics(topic: Topic): KEvent[] {
    return this.published.filter((e) => e.topic === topic);
  }
}

// ---------------------------------------------------------------------------------------------
// In-memory file system (structurally the kernel's KernelFs)
// ---------------------------------------------------------------------------------------------

export interface MemNode extends TreeInodeLike {
  ino: string;
  type: 'f' | 'd' | 'l';
  uid: number;
  gid: number;
  mode: number;
  version: number;
  size: number;
  mtime: number;
  target: string | null;
  parent: string | null;
  name: string;
  children?: Map<string, string>;
  data: Uint8Array;
}

/** POSIX `may` exactly as vfs/src/perm.ts (r = 4, w = 2, x = 1). */
export const posixMay: MayFn = (cred, n, want) => {
  if (cred.uid === 0) return (want & 1) === 0 || n.type === 'd' || (n.mode & 0o111) !== 0;
  const shift = cred.uid === n.uid ? 6 : cred.gid === n.gid || cred.groups.includes(n.gid) ? 3 : 0;
  return ((n.mode >> shift) & 7 & want) === want;
};

const enc = new TextEncoder();

export interface UserSpec {
  readonly uid: number;
  readonly name: string;
  readonly gid?: number;
}

export class MemFs implements KernelFsLike {
  readonly mounted = true;
  readonly events = { permEpoch: 0 };
  readonly nodes = new Map<string, MemNode>();
  readonly rootIno: string;
  readonly users = new Map<number, string>([[0, 'root']]);
  readonly tree = this;
  private readonly bus: FakeBus;
  private readonly clock: VirtualClock;

  constructor(bus: FakeBus, clock: VirtualClock, users: readonly UserSpec[] = []) {
    this.bus = bus;
    this.clock = clock;
    // The kernel's well-known inode ids (protocol INO): `/`, `/home` and `/bin` are shared dirs.
    const root = this.makeNode('d', 0, 0, 0o755, null, '', INO.ROOT);
    this.rootIno = root.ino;
    this.makeNode('d', 0, 0, 0o755, root.ino, 'home', INO.HOME);
    this.makeNode('d', 0, 0, 0o755, root.ino, 'bin', INO.BIN);
    this.makeNode('d', 0, 0, 0o1777, root.ino, 'tmp', INO.TMP);
    for (const u of users) {
      this.users.set(u.uid, u.name);
      this.mkdir(`/home/${u.name}`, u.uid, u.gid ?? 100, 0o700);
    }
  }

  private makeNode(
    type: 'f' | 'd' | 'l',
    uid: number,
    gid: number,
    mode: number,
    parent: string | null,
    name: string,
    ino: string = uuidv7(),
  ): MemNode {
    const n: MemNode = {
      ino,
      type,
      uid,
      gid,
      mode,
      version: 1,
      size: 0,
      mtime: Math.floor(this.clock.epochMs()),
      target: null,
      parent,
      name,
      data: new Uint8Array(0),
      ...(type === 'd' ? { children: new Map<string, string>() } : {}),
    };
    this.nodes.set(n.ino, n);
    if (parent !== null) this.nodes.get(parent)?.children?.set(name, n.ino);
    return n;
  }

  // -- KernelTreeLike --------------------------------------------------------------------------

  inode(ino: string): MemNode | undefined {
    return this.nodes.get(ino);
  }

  links(ino: string): readonly { parent: string; name: string }[] {
    const n = this.nodes.get(ino);
    return n === undefined || n.parent === null ? [] : [{ parent: n.parent, name: n.name }];
  }

  child(dir: string, name: string): MemNode | null {
    const id = this.nodes.get(dir)?.children?.get(name);
    return id === undefined ? null : (this.nodes.get(id) ?? null);
  }

  entries(dir: string): readonly TreeEntryLike[] {
    return [...(this.nodes.get(dir)?.children ?? new Map<string, string>())].map(([name, ino]) => ({
      name,
      ino,
    }));
  }

  // -- KernelFsLike ----------------------------------------------------------------------------

  userName(uid: number): string {
    return this.users.get(uid) ?? `user${String(uid)}`;
  }

  isBusy(): boolean {
    return false;
  }

  prefetchSubtree(_actor: FsActorLike, _path: string, _follow: boolean): Promise<void> {
    return Promise.resolve();
  }

  // -- paths -----------------------------------------------------------------------------------

  static split(path: string): string[] {
    return path.split('/').filter((p) => p !== '' && p !== '.');
  }

  lookup(path: string): MemNode | undefined {
    let n = this.nodes.get(this.rootIno);
    for (const part of MemFs.split(path)) {
      if (n === undefined) return undefined;
      n =
        part === '..'
          ? n.parent === null
            ? n
            : this.nodes.get(n.parent)
          : (this.child(n.ino, part) ?? undefined);
    }
    return n;
  }

  pathOf(ino: string): string {
    const parts: string[] = [];
    let n = this.nodes.get(ino);
    while (n !== undefined && n.parent !== null) {
      parts.unshift(n.name);
      n = this.nodes.get(n.parent);
    }
    return `/${parts.join('/')}`;
  }

  /** Resolve as `cred`: x on every directory walked (EACCES), ENOENT when absent. */
  resolveAs(cred: { uid: number; gid: number; groups: readonly number[] }, path: string): MemNode {
    let n = this.nodes.get(this.rootIno);
    for (const part of MemFs.split(path)) {
      if (n === undefined) throw makeError('ENOENT');
      if (n.type !== 'd') throw makeError('ENOTDIR');
      if (!posixMay(cred, n, 1)) throw makeError('EACCES');
      const next: MemNode | undefined =
        part === '..'
          ? n.parent === null
            ? n
            : this.nodes.get(n.parent)
          : (this.child(n.ino, part) ?? undefined);
      if (next === undefined) throw makeError('ENOENT');
      n = next;
    }
    if (n === undefined) throw makeError('ENOENT');
    return n;
  }

  private parentOf(path: string): { dir: MemNode; name: string } {
    const parts = MemFs.split(path);
    const name = parts.pop() ?? '';
    const dir = this.lookup(`/${parts.join('/')}`);
    if (dir === undefined || dir.type !== 'd')
      throw makeError('ENOENT', undefined, `no directory for ${path}`);
    return { dir, name };
  }

  // -- mutations (publish the vfs.* events the kernel would) -----------------------------------

  mkdir(path: string, uid: number, gid: number, mode = 0o755): MemNode {
    const { dir, name } = this.parentOf(path);
    const n = this.makeNode('d', uid, gid, mode, dir.ino, name);
    this.bus.publish('vfs.create', {
      ino: n.ino,
      parent: dir.ino,
      name,
      type: 'd',
      uid,
      version: 1,
      origin: 'local',
    });
    return n;
  }

  write(path: string, text: string, uid: number, gid = 100, mode = 0o644): MemNode {
    const bytes = enc.encode(text);
    const existing = this.lookup(path);
    if (existing !== undefined) {
      existing.data = bytes;
      existing.size = bytes.byteLength;
      existing.version++;
      existing.mtime = Math.floor(this.clock.epochMs());
      this.bus.publish('vfs.write', {
        ino: existing.ino,
        parent: existing.parent ?? this.rootIno,
        version: existing.version,
        size: existing.size,
        origin: 'local',
      });
      return existing;
    }
    const { dir, name } = this.parentOf(path);
    const n = this.makeNode('f', uid, gid, mode, dir.ino, name);
    n.data = bytes;
    n.size = bytes.byteLength;
    this.bus.publish('vfs.create', {
      ino: n.ino,
      parent: dir.ino,
      name,
      type: 'f',
      uid,
      version: 1,
      origin: 'local',
    });
    return n;
  }

  rename(from: string, to: string): MemNode {
    const n = this.lookup(from);
    if (n === undefined || n.parent === null) throw makeError('ENOENT');
    const { dir, name } = this.parentOf(to);
    const fromParent = n.parent;
    const fromName = n.name;
    this.nodes.get(fromParent)?.children?.delete(fromName);
    dir.children?.set(name, n.ino);
    n.parent = dir.ino;
    n.name = name;
    this.events.permEpoch++;
    this.bus.publish('vfs.rename', {
      ino: n.ino,
      fromParent,
      fromName,
      toParent: dir.ino,
      toName: name,
      origin: 'local',
    });
    return n;
  }

  unlink(path: string): void {
    const n = this.lookup(path);
    if (n === undefined || n.parent === null) throw makeError('ENOENT');
    const inos: string[] = [];
    const walk = (x: MemNode): void => {
      inos.push(x.ino);
      for (const c of x.children?.values() ?? []) {
        const child = this.nodes.get(c);
        if (child !== undefined) walk(child);
      }
    };
    walk(n);
    this.nodes.get(n.parent)?.children?.delete(n.name);
    for (const ino of inos) this.nodes.delete(ino);
    this.events.permEpoch++;
    this.bus.publish('vfs.unlink', { inos, parent: n.parent, name: n.name, origin: 'local' });
  }

  chmod(path: string, mode: number): void {
    const n = this.lookup(path);
    if (n === undefined) throw makeError('ENOENT');
    n.mode = mode;
    n.version++;
    this.events.permEpoch++;
    this.bus.publish('vfs.chmod', {
      root: n.ino,
      inos: [n.ino],
      mode,
      recursive: false,
      origin: 'local',
    });
  }

  text(path: string): string | undefined {
    const n = this.lookup(path);
    return n === undefined ? undefined : new TextDecoder().decode(n.data);
  }
}

// ---------------------------------------------------------------------------------------------
// The embedding worker double (deterministic bag-of-words vectors)
// ---------------------------------------------------------------------------------------------

/** 384-d hashed bag of words, L2-normalised: related texts share words, so they score higher. */
export function bagOfWords(text: string, dims = 384): Float32Array<ArrayBuffer> {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3) continue;
    let h = 2_166_136_261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16_777_619);
    const i = (h >>> 0) % dims;
    v[i] = (v[i] ?? 0) + 1;
  }
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < dims; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

export class FakeEmbedWorker implements EmbedWorkerLike {
  onmessage: ((ev: { readonly data: FromEmbedWorker }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly received: ToEmbedWorker[] = [];
  terminated = false;
  /** Hold `load` until `finishLoad()` (tests of the loading window). */
  holdLoad = false;
  failLoad = false;
  private pendingLoad = false;

  postMessage(msg: ToEmbedWorker): void {
    this.received.push(msg);
    if (msg.t === 'load') {
      if (this.holdLoad) {
        this.pendingLoad = true;
        return;
      }
      void Promise.resolve().then(() => {
        this.finishLoad();
      });
      return;
    }
    const text = msg.header === '' ? msg.text : `${msg.header}\n${msg.text}`;
    void Promise.resolve().then(() => {
      if (this.terminated) return;
      this.onmessage?.({
        data: { t: 'vector', id: msg.id, vector: bagOfWords(text), truncated: false, ms: 4 },
      });
    });
  }

  finishLoad(): void {
    this.pendingLoad = false;
    if (this.terminated) return;
    if (this.failLoad) {
      this.onmessage?.({ data: { t: 'error', errno: 'EIO', message: 'no weights' } });
      return;
    }
    this.onmessage?.({ data: { t: 'progress', loadedBytes: 50, totalBytes: 100 } });
    this.onmessage?.({ data: { t: 'ready', modelKey: 'test', threads: 1 } });
  }

  get loadPending(): boolean {
    return this.pendingLoad;
  }

  terminate(): void {
    this.terminated = true;
  }
}

// ---------------------------------------------------------------------------------------------
// The OS: kernel pieces + installAi through createAiLink
// ---------------------------------------------------------------------------------------------

export class Handlers implements HandlerTarget {
  readonly impls = new Map<string, AiCallImpl<CallName>>();

  register<C extends CallName>(name: C, impl: AiCallImpl<C>): void {
    this.impls.set(name, impl);
  }
}

export interface TestOsOptions {
  readonly users?: readonly UserSpec[];
  /** Absent: no embedding model (keyword only). */
  readonly embed?: boolean;
  readonly hybrid?: boolean;
  readonly fetch?: AiLinkDeps['fetch'];
  readonly deps?: Partial<AiLinkDeps>;
  readonly sessionUid?: number;
}

export class TestOs {
  readonly clock = new VirtualClock();
  readonly bus = new FakeBus(this.clock);
  readonly hooks = new HookRegistry();
  readonly handlers = new Handlers();
  readonly fs: MemFs;
  readonly workers: FakeEmbedWorker[] = [];
  readonly klog: string[] = [];
  readonly ai: AiInstallation;
  readonly ctx: AiLinkContextLike;
  sessionUid: number | undefined;
  online = true;

  constructor(opts: TestOsOptions = {}) {
    this.fs = new MemFs(
      this.bus,
      this.clock,
      opts.users ?? [
        { uid: 1000, name: 'alice' },
        { uid: 1001, name: 'bob' },
      ],
    );
    this.sessionUid = opts.sessionUid;
    this.ctx = {
      hooks: this.hooks,
      fs: () => this.fs,
      sessionUid: () => this.sessionUid,
      osSessionId: () => '01890000-0000-7000-8000-000000000001',
      online: () => this.online,
    };
    const factory = createAiLink({
      kernel: {
        handlers: this.handlers,
        bus: this.bus,
        makeError,
        now: () => this.clock.now(),
        epochMs: () => this.clock.epochMs(),
        log: (level, msg) => this.klog.push(`${level} ${msg}`),
      },
      may: posixMay,
      timers: this.clock,
      hybrid: opts.hybrid ?? false,
      uidOf: (pid) => this.uids.get(pid),
      tzOffsetMin: () => 300,
      timeZone: () => 'Asia/Karachi',
      userName: (uid) => this.fs.userName(uid),
      ...(opts.embed === true
        ? {
            embed: {
              spawn: () => {
                const w = new FakeEmbedWorker();
                this.workers.push(w);
                return w;
              },
              threads: 1,
            },
          }
        : {}),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...opts.deps,
    });
    this.ai = factory(this.ctx);
  }

  /** pid → login uid (the telemetry tap). */
  readonly uids = new Map<number, number>();

  async startServices(...names: Array<keyof AiInstallation['services']>): Promise<void> {
    const signal = new AbortController().signal;
    for (const n of names)
      await this.ai.services[n].start({
        signal,
        log: (level, msg) => this.klog.push(`${level} ${n}: ${msg}`),
        label: () => undefined,
      });
  }

  pcb(uid: number, opts: Partial<AiPcb> = {}): AiPcb {
    const pid = opts.pid ?? 100 + uid;
    this.uids.set(pid, opts.cred?.ruid ?? uid);
    return {
      pid,
      pgid: pid,
      sid: pid,
      name: 'test',
      cls: 'user',
      tty: null,
      cwdPath: uid === 0 ? '/root' : `/home/${this.fs.userName(uid)}`,
      cred: { uid, gid: 100, groups: [100], ruid: uid },
      ...opts,
    };
  }

  /** Call a registered ai.* handler as `pcb` (what the dispatcher's stage 7 does). */
  async call<C extends CallName>(pcb: AiPcb, name: C, args: unknown): Promise<unknown> {
    const impl = this.handlers.impls.get(name);
    if (impl === undefined) throw makeError('ENOSYS');
    const caller: AiCaller = { pcb, origin: 'E', wid: null };
    return impl.handle(caller, args as never);
  }
}

// ---------------------------------------------------------------------------------------------
// The program driver
// ---------------------------------------------------------------------------------------------

export interface Proc {
  readonly pcb: AiPcb;
  readonly calls: Array<{ call: string; args: unknown }>;
  readonly stdout: string[];
  readonly stderr: string[];
  stdin: string[];
  exit: number | undefined;
  priority: { priority?: number; nice?: number };
  subscriptions: Map<number, Sub>;
}

type CallHandler = (proc: Proc, args: unknown) => unknown;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

const TICK = Symbol.for('plotinium.tick');

function* sysCall(call: string, args: unknown): SysGen<unknown> {
  return yield { call, args };
}

/**
 * Runs one program as a process of the TestOs. System calls are answered by `extra` (per test),
 * then the built-in file calls, then the registered `ai.*` handlers.
 */
export class ProgramRunner<St> {
  readonly proc: Proc;
  private readonly gen: SysGen<number | undefined>;
  private readonly os: TestOs;
  private readonly extra: Readonly<Record<string, CallHandler>>;
  private fds = new Map<number, { node: MemNode; off: number }>();
  private nextFd = 3;
  private resume: { value?: unknown; error?: unknown } = {};
  /** The last system call and its errno (undefined when it succeeded). */
  last: { call: string; args: unknown; errno: Errno | undefined } | undefined;
  readonly state: St;

  constructor(
    os: TestOs,
    program: AiProgram<St>,
    argv: readonly string[],
    pcb: AiPcb,
    extra: Readonly<Record<string, CallHandler>> = {},
  ) {
    this.os = os;
    this.extra = extra;
    this.proc = {
      pcb,
      calls: [],
      stdout: [],
      stderr: [],
      stdin: [],
      exit: undefined,
      priority: {},
      subscriptions: new Map(),
    };
    const sys = {
      call: (name: string, args: unknown) => sysCall(name, args),
    } as AiProgramContext['sys'];
    const ctx: AiProgramContext = {
      pid: pcb.pid,
      uid: pcb.cred.uid,
      gid: pcb.cred.gid,
      argv,
      env: new Map(),
      cwd: pcb.cwdPath,
      tty: pcb.tty,
      sys,
      tick: TICK,
      now: () => os.clock.now(),
      sleep: (ms: number) => sysCall('sleep', { ms }) as SysGen<void>,
    };
    this.state = program.init(argv);
    this.gen = program.run(ctx, this.state);
  }

  get exited(): boolean {
    return this.proc.exit !== undefined;
  }

  count(call: string): number {
    return this.proc.calls.filter((c) => c.call === call).length;
  }

  /**
   * Step the program until it exits, `until()` holds, or `maxCalls` system calls were made.
   * Returns the exit status (undefined while it is still running).
   */
  async run(opts: { until?: () => boolean; maxCalls?: number } = {}): Promise<number | undefined> {
    const max = opts.maxCalls ?? 10_000;
    let made = 0;
    while (!this.exited) {
      const r =
        this.resume.error !== undefined
          ? this.gen.throw(this.resume.error)
          : this.gen.next(this.resume.value);
      this.resume = {};
      if (r.done === true) {
        this.proc.exit = r.value ?? 0;
        break;
      }
      const y: Yield = r.value;
      if (typeof y === 'symbol') continue;
      made++;
      this.proc.calls.push({ call: y.call, args: y.args });
      try {
        this.resume = { value: await this.dispatch(y.call, y.args) };
        this.last = { call: y.call, args: y.args, errno: undefined };
      } catch (e) {
        this.resume = { error: e };
        this.last = {
          call: y.call,
          args: y.args,
          errno: e instanceof TestKernelError ? e.errno : 'EIO',
        };
      }
      await settle();
      if (opts.until?.() === true || made >= max) break;
    }
    return this.proc.exit;
  }

  private async dispatch(call: string, args: unknown): Promise<unknown> {
    const a = isRecord(args) ? args : {};
    const handler = this.extra[call];
    if (handler !== undefined) return handler(this.proc, args);
    const fs = this.os.fs;
    const { pcb } = this.proc;
    const cred = pcb.cred;
    switch (call) {
      case 'proc.cred':
        return {
          uid: cred.uid,
          gid: cred.gid,
          groups: [...cred.groups],
          user: fs.userName(cred.uid),
          groupNames: [],
          home: cred.uid === 0 ? '/root' : `/home/${fs.userName(cred.uid)}`,
          ruid: cred.ruid,
        };
      case 'setpriority':
        this.proc.priority = {
          ...(typeof a['priority'] === 'number' ? { priority: a['priority'] } : {}),
          ...(typeof a['nice'] === 'number' ? { nice: a['nice'] } : {}),
        };
        return { priority: a['priority'], nice: a['nice'] };
      case 'time.now':
        return {
          epochMs: this.os.clock.epochMs(),
          monotonicMs: this.os.clock.now(),
          tz: 'Asia/Karachi',
          tzOffsetMin: 300,
        };
      case 'sleep':
        this.os.clock.advance(typeof a['ms'] === 'number' ? a['ms'] : 0);
        await settle();
        return {};
      case 'stat': {
        const n = fs.resolveAs(cred, String(a['path']));
        return { ...n, nlink: 1, atime: n.mtime, ctime: n.mtime, blob: null };
      }
      case 'readdir': {
        const dir = fs.resolveAs(cred, String(a['path']));
        if (dir.type !== 'd') throw makeError('ENOTDIR');
        if (!posixMay(cred, dir, 4)) throw makeError('EACCES');
        const all = [...(dir.children ?? new Map<string, string>())].map(([name, ino]) => {
          const n = fs.inode(ino);
          return {
            name,
            ino,
            type: n?.type ?? 'f',
            ...(a['plus'] === true && n !== undefined
              ? { stat: { ...n, nlink: 1, atime: n.mtime, ctime: n.mtime, blob: null } }
              : {}),
          };
        });
        const start = typeof a['cursor'] === 'string' ? Number(a['cursor']) : 0;
        const limit = typeof a['limit'] === 'number' ? a['limit'] : 1_000;
        const page = all.slice(start, start + limit);
        return {
          entries: page,
          dirVersion: dir.version,
          ...(start + limit < all.length ? { next: String(start + limit) } : {}),
        };
      }
      case 'open': {
        const n = fs.resolveAs(cred, String(a['path']));
        if (!posixMay(cred, n, 4)) throw makeError('EACCES');
        const fd = this.nextFd++;
        this.fds.set(fd, { node: n, off: 0 });
        return { fd };
      }
      case 'read': {
        const fd = Number(a['fd']);
        if (fd === 0) {
          const line = this.proc.stdin.shift();
          return line === undefined ? new ArrayBuffer(0) : enc.encode(`${line}\n`).buffer;
        }
        const f = this.fds.get(fd);
        if (f === undefined) throw makeError('EBADF');
        const len = Number(a['len']);
        const chunk = f.node.data.slice(f.off, f.off + len);
        f.off += chunk.byteLength;
        return chunk.buffer;
      }
      case 'close':
        this.fds.delete(Number(a['fd']));
        return {};
      case 'write': {
        const text = new TextDecoder().decode(new Uint8Array(a['data'] as ArrayBuffer));
        (Number(a['fd']) === 2 ? this.proc.stderr : this.proc.stdout).push(text);
        return { written: text.length };
      }
      case 'sys.subscribe': {
        const topics = (a['topics'] as string[] | undefined) ?? [];
        const scope = typeof a['path'] === 'string' ? fs.lookup(a['path']) : undefined;
        const under = (ino: string): boolean => {
          let n = fs.inode(ino);
          while (n !== undefined) {
            if (scope === undefined || n.ino === scope.ino) return true;
            n = n.parent === null ? undefined : fs.inode(n.parent);
          }
          return false;
        };
        const sub = this.os.bus.subscribe(topics, {
          filter: (ev) => {
            const d: unknown = ev.data;
            if (!isRecord(d)) return true;
            const parent = d['parent'] ?? d['toParent'] ?? d['root'];
            return (
              typeof parent !== 'string' ||
              under(parent) ||
              (typeof d['fromParent'] === 'string' && under(d['fromParent']))
            );
          },
        });
        const fd = this.nextFd++;
        this.proc.subscriptions.set(fd, sub);
        return { fd };
      }
      case 'sys.events': {
        const sub = this.proc.subscriptions.get(Number(a['fd']));
        if (sub === undefined) throw makeError('EBADF');
        const max = typeof a['max'] === 'number' ? a['max'] : 64;
        if (sub.queue.length === 0) {
          const timeout = typeof a['timeoutMs'] === 'number' ? a['timeoutMs'] : 0;
          if (timeout > 0) {
            this.os.clock.advance(timeout);
            await settle();
          }
          if (sub.queue.length === 0) throw makeError('ETIMEDOUT');
        }
        return sub.take(max);
      }
      default: {
        if (!call.startsWith('ai.')) throw makeError('ENOSYS', undefined, `harness: ${call}`);
        return this.os.call(pcb, call as CallName, args);
      }
    }
  }
}
