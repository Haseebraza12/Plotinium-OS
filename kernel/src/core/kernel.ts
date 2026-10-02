/**
 * The kernel's COMPOSITION ROOT: kernel init, boot stage 3 (boot-and-services.md §3.2).
 *
 * `createKernel` assembles, in order:
 *   1. the klog ring, the event bus, the lifecycle and the process table with pid 1 `init`;
 *   2. the syscall handler registry, the auditor and the dispatcher (syscall-abi.md §3.3);
 *   3. the kernel timer heap (KPS-13; the host drives it with ONE platform timer through
 *      `timers.onEarliestChange`) and the process system (`core/proc/system.ts`): scheduler,
 *      executor pool, watchdog, kill path, job control and the memory glue;
 *   4. the core syscalls (`getpid uname dmesg proc.list time.now`), then the process, memory and
 *      sysctl syscalls (`core/proc`);
 *   5. the I/O layer through `installIo(kernel, deps)` (`core/io`: the real system services,
 *      fs, windows and the compositor port, sync/locks, ai, the login channel), which registers
 *      its own syscalls over the process ones where it owns a richer version. The kernel completes
 *      the host's `io` options before the call: `timers` is the kernel timer heap as
 *      `KernelTimers` and `memory.executor` is the process system's page-frame port; `proc` stays
 *      the host's overrides only (the I/O layer's defaults already go through `kernel.proc`). The
 *      `mm` service builds the memory manager with `kernel.startMemory(opts)`, which attaches it
 *      to the process system (register/admit at spawn, onSlice, exit, suspend/resume).
 *
 * Thread-agnostic: the host passes clocks, platform facts, the build identity, the executor
 * transport and the program catalog. The kernel never imports apps: the PROGRAM REGISTRY is
 * injected — `programs` (the `/bin/<name>.json` manifests) here, and the matching
 * `ProgramLoaders` in the host's executor bundle (`runtime/executor-entry.ts`).
 */
import { uuidv7 } from '@plotinium/protocol';
import type { KernelTimers } from '@plotinium/services';

import { EventBus } from './events/bus.ts';
import { HookRegistry } from './hooks/index.ts';
import type { KernelHost } from './host.ts';
import type { AuditSink } from './ipc/audit.ts';
import { Auditor, MemoryAuditSink } from './ipc/audit.ts';
import type { DispatcherDeps } from './ipc/dispatcher.ts';
import { Dispatcher } from './ipc/dispatcher.ts';
import { HandlerRegistry } from './ipc/handlers.ts';
import type { ExecPortRec, ViewPortRec } from './ipc/ports.ts';
import { installIo } from './io/index.ts';
import type { Io, IoDeps, MemoryLink, ProcLink } from './io/types.ts';
import { ConsoleUsers } from './io/vfs.ts';
import { Klog, KLOG_SIZE, createKlogRing } from './klog/klog.ts';
import type { MemoryManager } from './mm/mm.ts';
import type { ProgramCatalog } from './programs/catalog.ts';
import { EMPTY_CATALOG } from './programs/catalog.ts';
import type { ExecutorTransport } from './proc/exec-frames.ts';
import { Lifecycle } from './proc/lifecycle.ts';
import { ProcManager } from './proc/manager.ts';
import { registerMemSyscalls } from './proc/mem-syscalls.ts';
import type { MemoryOptions } from './proc/mm-link.ts';
import { createMemoryManager, kernelMemPort } from './proc/mm-link.ts';
import type { PCB } from './proc/pcb.ts';
import { registerProcSyscalls } from './proc/syscalls.ts';
import { defineProcSysctls, registerSysctlSyscalls, SysctlTable } from './proc/sysctl.ts';
import { ProcessSystem } from './proc/system.ts';
import { createProcessTable, PROCESS_TABLE_KIND } from './proc/table.ts';
import type { UserDirectory } from './proc/users.ts';
import { StaticUserDirectory } from './proc/users.ts';
import type { SchedParams } from './sched/params.ts';
import { defaultHeapFactory } from './sched/scheduler.ts';
import { TimerHeap } from './sched/timers.ts';
import type { HeapFactory } from './sched/types.ts';
import type { SyscallContext } from './syscalls/index.ts';
import { registerCoreSyscalls } from './syscalls/index.ts';

/**
 * The host's options for the I/O layer (`installIo`). The kernel fills in what only it can build:
 * `timers` (the kernel timer heap) and `memory.executor` (the page-frame port of the process
 * system). `proc` stays the host's OVERRIDES only: the I/O layer's defaults already go through
 * `kernel.proc` (SIGTERM with the SIGKILL follow-up, the console user's launch environment, the
 * focus boost and input hints), so the kernel does not fill it in.
 */
export type KernelIoOptions = Omit<IoDeps, 'timers' | 'proc' | 'memory'> & {
  readonly timers?: KernelTimers;
  readonly proc?: ProcLink;
  readonly memory?: Omit<MemoryLink, 'executor'> & { readonly executor?: MemoryLink['executor'] };
};

/** The heap as the services' `KernelTimers` (one timer heap for the whole kernel, KPS-13). */
export function timerHeapKernelTimers(heap: TimerHeap, now: () => number): KernelTimers {
  return {
    now,
    at: (deadlineMs, fire, priority) =>
      heap.arm(Number.isFinite(deadlineMs) ? deadlineMs : now(), () => fire(), {
        label: 'svc',
        ...(priority === undefined ? {} : { priority }),
      }),
    cancel: (handle) => heap.cancel(handle),
  };
}

export interface KernelOptions {
  readonly host: KernelHost;
  /** Whether the `ai.*` syscall group exists (`__AI__`, C12). Default true. */
  readonly ai?: boolean;
  readonly users?: UserDirectory;
  readonly auditSink?: AuditSink;
  readonly klogCapacity?: number;
  readonly procLimits?: { procMax?: number; nprocPerUid?: number };
  readonly onAbiViolation?: DispatcherDeps['onAbiViolation'];
  readonly onSuspectExecutor?: DispatcherDeps['onSuspectExecutor'];
  /** The kernel timer heap; default a fresh one (the host must drive it, KPS-13). */
  readonly timers?: TimerHeap;
  /** How executors are reached; absent: every spawn fails EAGAIN `executors-exhausted`. */
  readonly executors?: ExecutorTransport | null;
  /** The `/bin/<name>.json` manifests (the injected program registry). Default: none. */
  readonly programs?: ProgramCatalog;
  /** Scheduler parameter overrides (tests). */
  readonly sched?: Partial<SchedParams>;
  /** dsa/heap factory override (tests). */
  readonly heapFactory?: HeapFactory;
  /** Placement rule 5 may grow the pool from the start (tests, the loopback host). */
  readonly desktopInteractive?: boolean;
  /**
   * The I/O layer's host dependencies. Absent: no I/O layer (the dispatcher and process tests);
   * the fs, window, sync/lock and ai syscalls then answer ENOSYS.
   */
  readonly io?: KernelIoOptions;
}

export interface Kernel {
  readonly host: KernelHost;
  readonly klog: Klog;
  readonly bus: EventBus;
  readonly procs: ProcManager;
  readonly lifecycle: Lifecycle;
  readonly handlers: HandlerRegistry;
  readonly dispatcher: Dispatcher;
  readonly hooks: HookRegistry;
  readonly users: UserDirectory;
  readonly init: PCB;
  readonly audit: Auditor;
  /** The kernel timer heap (sleep, aging, watchdog, service timeouts, KPS-13). */
  readonly timers: TimerHeap;
  /** Scheduler, executor pool, kill path, signals, job control and memory glue. */
  readonly proc: ProcessSystem;
  /** The program registry's manifests. */
  readonly programs: ProgramCatalog;
  readonly sysctl: SysctlTable;
  /** Wall-clock epoch (ms) of kernel time 0. */
  readonly epochAtZero: number;
  /** The OS session id the audit records carry (the `session` service replaces it). */
  osSessionId: string;
  /** Route a `{t:'syscall'}` frame from an executor. */
  execFrame(port: ExecPortRec, frame: { pid: unknown; sliceSeq: unknown; req: unknown }): void;
  /** Route any message from a view port. */
  viewMessage(port: ViewPortRec, msg: unknown): void;
  /** A free-text klog line at the current kernel time. */
  log(
    sub: string,
    level: 'info' | 'warn' | 'degraded' | 'fail' | 'panic',
    msg: string,
    pid?: number,
  ): void;
  /** Build and attach the memory manager (the `mm` service start). */
  startMemory(opts: MemoryOptions): MemoryManager;
  /** The kernel timer heap as the services' `KernelTimers`. */
  readonly kernelTimers: KernelTimers;
  /** The process system's desktop link (window close signals, launches, focus, input). */
  readonly procLink: ProcLink;
  /** The I/O layer (`installIo`), or null when the host passed no `io` options. */
  readonly io: Io | null;
  /** The complete I/O dependencies the kernel built from `opts.io` (null without `io`). */
  readonly ioDeps: IoDeps | null;
}

export function createKernel(opts: KernelOptions): Kernel {
  const { host } = opts;
  const now = (): number => host.clock.now();
  const epochAtZero = host.clock.epochMs() - host.clock.now();
  const klog = new Klog(createKlogRing(opts.klogCapacity ?? KLOG_SIZE));
  const bus = new EventBus(() => host.clock.epochMs());
  const lifecycle = new Lifecycle({ klog, bus, now });
  const procs = new ProcManager({
    table: createProcessTable(),
    lifecycle,
    now,
    ...(opts.procLimits === undefined ? {} : { limits: opts.procLimits }),
  });
  // uid → name. Without a host directory, one the VFS users mirror backs once `vfs` mounts
  // (`ConsoleUsers.bind`, done by the I/O layer): `ps`, `id`, `whoami` and the prompt then show
  // the account name instead of `u<uid>` (UI-012).
  const users = opts.users ?? new ConsoleUsers(new StaticUserDirectory());
  const handlers = new HandlerRegistry();
  const hooks = new HookRegistry();

  let osSessionId = uuidv7();
  const audit = new Auditor({
    klog,
    sink: opts.auditSink ?? new MemoryAuditSink(),
    now,
    epochMs: () => host.clock.epochMs(),
    osSessionId: () => osSessionId,
  });

  const init = procs.createInit();
  const ctx: SyscallContext = {
    procs,
    klog,
    bus,
    clock: host.clock,
    identity: host.identity,
    platform: host.platform,
    users,
    epochAtZero,
  };
  registerCoreSyscalls(handlers, ctx);

  const dispatcher = new Dispatcher({
    procs,
    handlers,
    audit,
    klog,
    now,
    ai: opts.ai ?? true,
    ...(opts.onAbiViolation === undefined ? {} : { onAbiViolation: opts.onAbiViolation }),
    ...(opts.onSuspectExecutor === undefined ? {} : { onSuspectExecutor: opts.onSuspectExecutor }),
  });

  const timers = opts.timers ?? new TimerHeap(opts.heapFactory ?? defaultHeapFactory);
  const programs = opts.programs ?? EMPTY_CATALOG;
  const proc = new ProcessSystem({
    procs,
    lifecycle,
    klog,
    bus,
    dispatcher,
    audit,
    now,
    platform: host.platform,
    timers,
    catalog: programs,
    hooks,
    osSessionId: () => osSessionId,
    transport: opts.executors ?? null,
    ...(opts.sched === undefined ? {} : { params: opts.sched }),
    ...(opts.heapFactory === undefined ? {} : { heapFactory: opts.heapFactory }),
    ...(opts.desktopInteractive === undefined
      ? {}
      : { desktopInteractive: opts.desktopInteractive }),
  });
  registerProcSyscalls(handlers, { procs, sys: proc, users, now, epochAtZero });
  registerMemSyscalls(handlers, { sys: proc, osSessionId: () => osSessionId });
  const sysctl = new SysctlTable();
  defineProcSysctls(sysctl, proc, now);
  registerSysctlSyscalls(handlers, sysctl);

  klog.line(
    now(),
    'kernel',
    'info',
    `process table ready (${PROCESS_TABLE_KIND}) · pid 1 = init · klog ${String(klog.capacity)} · executors ≤ ${String(proc.pool.maxExecutors)}, run tokens ${String(proc.sched.tokens.capacity)} · ${String(programs.names().length)} programs`,
  );

  const kernelTimers = timerHeapKernelTimers(timers, now);
  const procLink: ProcLink = {
    signal: (pid, sig) => {
      proc.signalPid(pid, sig, 0);
    },
    launch: (app, argv, user) => {
      void proc.launch(app, argv, user).catch((e: unknown) => {
        klog.line(
          now(),
          'proc',
          'warn',
          `launch ${app}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 256),
        );
      });
    },
    focus: (pid) => {
      proc.focusOwner(pid);
    },
    input: (pid) => {
      proc.onInput(pid);
    },
  };
  const ioDeps: IoDeps | null =
    opts.io === undefined
      ? null
      : {
          ...opts.io,
          timers: opts.io.timers ?? kernelTimers,
          ...(opts.io.memory === undefined
            ? {}
            : {
                memory: {
                  ...opts.io.memory,
                  executor: opts.io.memory.executor ?? kernelMemPort(proc),
                },
              }),
        };
  let io: Io | null = null;

  const kernel: Kernel = {
    host,
    klog,
    bus,
    procs,
    lifecycle,
    handlers,
    dispatcher,
    hooks,
    users,
    init,
    audit,
    timers,
    proc,
    programs,
    sysctl,
    epochAtZero,
    get osSessionId(): string {
      return osSessionId;
    },
    set osSessionId(id: string) {
      osSessionId = id;
    },
    execFrame: (port, frame) => {
      dispatcher.execFrame(port, frame);
    },
    viewMessage: (port, msg) => {
      dispatcher.viewMessage(port, msg);
    },
    log: (sub, level, msg, pid) => {
      klog.line(now(), sub, level, msg, pid);
    },
    startMemory: (mopts) => createMemoryManager(proc, { procs, bus, klog, now }, mopts),
    kernelTimers,
    procLink,
    get io(): Io | null {
      return io;
    },
    ioDeps,
  };
  if (ioDeps !== null) io = installIoLayer(kernel, ioDeps);
  return kernel;
}

/**
 * Step 5: the I/O layer (`core/io`, `installIo`): the real system services, the window table and
 * the compositor port, connectivity and locks, the file-system calls once `vfs` mounts, the proc
 * seams that need the VFS, and the router side of the login screen. A failure here is a kernel
 * bug, logged at `panic` level; the kernel still boots with the host's placeholder services.
 */
function installIoLayer(kernel: Kernel, deps: IoDeps): Io | null {
  try {
    return installIo(kernel, deps);
  } catch (e) {
    kernel.log(
      'kernel',
      'panic',
      `I/O layer failed to install: ${e instanceof Error ? e.message : String(e)}`.slice(0, 512),
    );
    return null;
  }
}
