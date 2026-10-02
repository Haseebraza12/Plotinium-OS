/**
 * @plotinium/kernel/sys: the system-call client programs and app views use (syscall-abi.md §3.2,
 * §4.1; processes-and-scheduling.md §3.5). This subpath is the ONLY part of @plotinium/kernel that
 * apps/* may import (architecture.md §3.7, ESLint-enforced), so it imports protocol and nothing
 * else: no kernel state is reachable from here.
 *
 * Two clients:
 * - programs on executors get `ctx.sys`, generator stubs: `const st = yield* ctx.sys.stat({path})`.
 *   A stub yields `{call, args}` without an id; the executor runtime assigns the id, and resumes
 *   the generator with the value or throws a `SysError` into it (§3.5.1 rule 3);
 * - app views get `createViewSys(port)`, a promise client over their view port that sends the ABI
 *   `hello` on first use (ABI-10) and transfers ArrayBuffers of 64 KiB or more (ABI-13).
 *
 * Caller identity comes from the port, never from these messages (C3).
 */
import type {
  ArgsIn,
  CallName,
  ErrDetail,
  Errno,
  KEvent,
  RetOf,
  SignalName,
  SysRes,
} from '@plotinium/protocol';
import {
  ABI_VERSION,
  abiDigest,
  CALL_NAMES,
  isErrno,
  strerror,
  TRANSFER_THRESHOLD_BYTES,
} from '@plotinium/protocol';

// ---------------------------------------------------------------------------------------------
// Program model
// ---------------------------------------------------------------------------------------------

/** `yield ctx.tick` is a voluntary yield point (pre-emption, quantum, checkpoint). */
export const TICK: unique symbol = Symbol.for('plotinium.tick');
export type Tick = typeof TICK;

/** What a syscall stub yields; the runtime stamps the id. */
export interface SysRequest {
  readonly call: string;
  readonly args: unknown;
}

export type Yield = SysRequest | Tick;
export type SysGen<T> = Generator<Yield, T, unknown>;

/** A failed system call, thrown into the program's generator. */
export class SysError extends Error {
  readonly errno: Errno;
  readonly detail: ErrDetail | undefined;

  constructor(errno: Errno, message?: string, detail?: ErrDetail) {
    super(message ?? strerror(errno));
    this.name = 'SysError';
    this.errno = errno;
    this.detail = detail;
  }
}

/** The errno of a thrown value, or undefined when it is not a system-call failure. */
export function errnoOf(e: unknown): Errno | undefined {
  if (typeof e !== 'object' || e === null || !('errno' in e)) return undefined;
  const errno: unknown = e.errno;
  return isErrno(errno) ? errno : undefined;
}

/** One generator stub per call of the ABI registry, plus the generic `call`. */
export type SysStubs = { readonly [C in CallName]: (args: ArgsIn<C>) => SysGen<RetOf<C>> };

export interface Sys extends SysStubs {
  call<C extends CallName>(name: C, args: ArgsIn<C>): SysGen<RetOf<C>>;
}

function* stub(call: string, args: unknown): SysGen<unknown> {
  return yield { call, args };
}

/** The frozen stub object an executor hands to programs as `ctx.sys`. */
export function createSys(): Sys {
  const sys: Record<string, unknown> = {
    call: (name: string, args: unknown) => stub(name, args),
  };
  for (const name of CALL_NAMES) sys[name] = (args: unknown) => stub(name, args);
  return Object.freeze(sys) as unknown as Sys;
}

/** Page access mode of `ctx.mem.get` (memory-and-paging.md §4.2). */
export type PageMode = 'r' | 'rw';

/**
 * The page API of memory-and-paging.md §4.2 (`ctx.mem`). Pages live in the executor; `get` returns
 * the page's live buffer (a resident fast path, else a runtime-internal `mem.fault` that blocks
 * until the pager brings it back, verified). A page obtained with `'rw'` counts as dirty.
 */
export interface CtxMem {
  /** Reserve and create pages (blocks on `mem` while the budget is full). */
  alloc(req: {
    readonly kind: 'chunk' | 'logical';
    readonly size: number;
    readonly label?: string;
  }): SysGen<{ readonly pageIds: readonly number[] }>;
  get(pageId: number, mode: PageMode): SysGen<ArrayBuffer>;
  /** Free whole allocations (every page id of an `alloc`). */
  free(pageIds: readonly number[]): SysGen<{ readonly bytes: number }>;
}

/** The `ctx` a program receives (processes-and-scheduling.md §3.5.2). */
export interface ProgramContext {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly uid: number;
  readonly gid: number;
  readonly argv: readonly string[];
  readonly env: ReadonlyMap<string, string>;
  /** Path at the last dispatch. */
  readonly cwd: string;
  /** Controlling TTY number, or null. */
  readonly tty: number | null;
  /** Why `run()` was (re)entered. */
  readonly restored: 'no' | 'page-in' | 'migration' | 'session';
  readonly sys: Sys;
  readonly tick: Tick;
  /** Monotonic ms in the executor. */
  now(): number;
  /** B call `sleep`, visible to the scheduler. */
  sleep(ms: number): SysGen<void>;
  /** Absolute deadline on the executor clock: restart-safe across page-out. */
  sleepUntil(tMs: number): SysGen<void>;
  /**
   * Pageable memory (memory-and-paging.md §4.2). The executor runtime always provides it; it is
   * optional in the type so hand-built test contexts may leave it out.
   */
  readonly mem?: CtxMem;
  // TODO(R3): `display` (window-manager.md §3.13).
}

/** A program module's default export (§3.5.1). State lives in `st`, never in module variables. */
export interface Program<St> {
  readonly checkpointable?: boolean;
  init(argv: readonly string[]): St;
  run(ctx: ProgramContext, st: St): SysGen<number | undefined>;
  /** Synchronous; may only change `st`; cannot make system calls. */
  signal?(ctx: ProgramContext, st: St, sig: SignalName): void;
}

// ---------------------------------------------------------------------------------------------
// Program registry (executor side)
// ---------------------------------------------------------------------------------------------

/**
 * A lazily imported program module: either the module namespace (with a default `Program`
 * export) or the `Program` itself. Loaders are closures such as `() => import('./cmd/ls.ts')`,
 * so no program code is evaluated before the executor has sandboxed its realm (§3.7.1).
 *
 * The kernel never imports apps (architecture.md §3.7): the host that builds the executor bundle
 * (web) composes the loaders from apps and hands them to `startExecutor({ loaders })`.
 * Structural on purpose: apps type their programs against their own `Program` shapes.
 */
export type ProgramLoader = () => Promise<unknown>;

/** Program module id (`manifest.entry`, for example `apps/coreutils/ls`) → loader. */
export type ProgramLoaders = Readonly<Record<string, ProgramLoader>>;

/** A value that has the shape of a `Program` (checked at load time, not trusted). */
export function isProgram(x: unknown): x is Program<unknown> {
  return (
    x !== null &&
    typeof x === 'object' &&
    typeof (x as { init?: unknown }).init === 'function' &&
    typeof (x as { run?: unknown }).run === 'function'
  );
}

/** The `Program` of a loaded module: its default export, or the value itself. */
export function programOf(mod: unknown): Program<unknown> | null {
  if (isProgram(mod)) return mod;
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    const d: unknown = (mod as { default?: unknown }).default;
    if (isProgram(d)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// View client
// ---------------------------------------------------------------------------------------------

export interface ViewSysOptions {
  /** Kernel event batches pushed to this view (at most one per animation frame). */
  readonly onEvents?: (batch: KEvent[]) => void;
  /** Terminal views only. */
  readonly onTtyOut?: (data: ArrayBuffer) => void;
  readonly onClose?: (reason: string) => void;
}

export interface ViewSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
  readonly closed: boolean;
}

/** Top-level ArrayBuffers at or above the transfer threshold (ABI-13, 64 KiB rule). */
export function transferList(args: unknown): ArrayBuffer[] {
  if (args === null || typeof args !== 'object') return [];
  const out: ArrayBuffer[] = [];
  for (const val of Object.values(args)) {
    if (val instanceof ArrayBuffer && val.byteLength >= TRANSFER_THRESHOLD_BYTES) out.push(val);
  }
  return out;
}

interface Pending {
  resolve(value: unknown): void;
  reject(e: unknown): void;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object';
}

/** A promise client bound to one view port. */
export function createViewSys(port: MessagePort, opts: ViewSysOptions = {}): ViewSys {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let greeted = false;
  let closed = false;

  const settle = (res: SysRes): void => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.value);
    else p.reject(new SysError(res.errno, res.msg, res.detail));
  };

  port.onmessage = (ev: MessageEvent) => {
    const msg: unknown = ev.data;
    if (!isRecord(msg)) return;
    if (msg['t'] === 'res' && isRecord(msg['res'])) settle(msg['res'] as unknown as SysRes);
    else if (msg['t'] === 'events' && Array.isArray(msg['batch']))
      opts.onEvents?.(msg['batch'] as KEvent[]);
    else if (msg['t'] === 'tty.out' && msg['data'] instanceof ArrayBuffer)
      opts.onTtyOut?.(msg['data']);
    else if (msg['t'] === 'close') {
      closed = true;
      for (const p of pending.values()) p.reject(new SysError('ESRCH', 'view port closed'));
      pending.clear();
      opts.onClose?.(typeof msg['reason'] === 'string' ? msg['reason'] : 'closed');
    }
  };

  return {
    get closed(): boolean {
      return closed;
    },
    call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
      if (closed) return Promise.reject(new SysError('ESRCH', 'view port closed'));
      if (!greeted) {
        port.postMessage({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
        greeted = true;
      }
      const id = nextId;
      nextId = nextId >= 0xffff_ffff ? 1 : nextId + 1;
      return new Promise<RetOf<C>>((resolve, reject) => {
        pending.set(id, { resolve: (v) => resolve(v as RetOf<C>), reject });
        port.postMessage({ t: 'req', req: { id, call: name, args } }, transferList(args));
      });
    },
  };
}
