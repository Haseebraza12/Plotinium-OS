/**
 * The PROCESS loopback host: the whole kernel with its real process system (scheduler, executor
 * pool, watchdog, kill path, job control, timer heap, memory manager) over in-process executors,
 * for Node tests of the process and memory system calls (PROC-01..09, MEM-01/02/03/06).
 *
 * Unlike `loopback.ts` (a minimal slice driver for the dispatcher tests), nothing here bypasses
 * the kernel: programs are spawned through `ProcessSystem.spawnProcess` (manifest → start-up
 * closure → caps → PCB → reservation → placement → executor → `load`), dispatched by the
 * scheduler, and talk to the kernel only through `ctx.sys`.
 *
 * Time is virtual and deterministic: a `ManualClock` that moves only when a program executes
 * (`stepCostMs` per generator step) or when the harness jumps to the next kernel timer while
 * every executor is idle (`runFor`, `until`). The frame queue is pumped explicitly, so a test
 * decides how long the system runs.
 *
 * `mountFs()` adds the kernel file system on the memory store (the fs calls, the proc seams of
 * core/io: exec permission, fd inheritance, chdir) and the local advisory locks (`lock.*`), with
 * the kill path's terminate hooks, so PROC-07 can check that descriptors and locks are released.
 */
import type { AppManifestInput, Cap } from '@plotinium/protocol';

import { KernelFs } from '../core/fs/kfs.ts';
import { MemStore } from '../core/fs/mem-store.ts';
import { registerFsSyscalls } from '../core/fs/syscalls.ts';
import { provisionLocalUser } from '../core/fs/users.ts';
import type { BuildIdentity, PlatformInfo } from '../core/host.ts';
import { DEV_IDENTITY } from '../core/host.ts';
import { installProcSeams } from '../core/io/index.ts';
import type { Kernel } from '../core/kernel.ts';
import { createKernel } from '../core/kernel.ts';
import type { MemoryManager } from '../core/mm/mm.ts';
import type { MmParams } from '../core/mm/params.ts';
import { MemorySwapDevice } from '../core/mm/swap.ts';
import { LocalLocks } from '../core/net/locks.ts';
import { LEASE_TTL_MS, NetMonitor } from '../core/net/monitor.ts';
import { registerNetSyscalls } from '../core/net/syscalls.ts';
import type { PCB, ProcCred } from '../core/proc/pcb.ts';
import type { SpawnRequest } from '../core/proc/system.ts';
import { StaticUserDirectory } from '../core/proc/users.ts';
import { StaticProgramCatalog } from '../core/programs/catalog.ts';
import type { SchedParams } from '../core/sched/params.ts';
import type { Program } from '../runtime/sys.ts';
import { ManualClock } from './clock.ts';
import { InProcessExecutors } from './inproc-executors.ts';

export interface LoopbackProgram {
  readonly manifest: AppManifestInput;
  /** Absent for a `lib` manifest (start-up closure tests). */
  readonly program?: Program<unknown>;
}

export interface ProcLoopbackOptions {
  readonly programs?: readonly LoopbackProgram[];
  readonly clock?: ManualClock;
  /** `navigator.hardwareConcurrency` (RUN_TOKENS = clamp(cores − 2, 1, 6)); default 8. */
  readonly cores?: number;
  readonly identity?: BuildIdentity;
  /** SharedArrayBuffer control blocks (default true). */
  readonly sab?: boolean;
  /** Virtual CPU cost of one generator step (default 0.25 ms). */
  readonly stepCostMs?: number;
  readonly sched?: Partial<SchedParams>;
  /** Placement rule 5 (the pool may grow before the first placement); default true. */
  readonly desktopInteractive?: boolean;
  /** Start a memory manager over an in-memory swap device (default false). */
  readonly memory?: boolean | Partial<MmParams>;
  readonly users?: Iterable<readonly [number, string]>;
}

export interface SpawnAs {
  readonly argv?: readonly string[];
  /** Default the session user (uid 1001). */
  readonly cred?: ProcCred;
  readonly parent?: PCB;
  readonly setsid?: boolean;
  readonly tty?: number | null;
  readonly pgid?: number | 'new';
  readonly priority?: number;
  readonly nice?: number;
  readonly dropCaps?: readonly Cap[];
}

export interface ProcLoopback {
  readonly kernel: Kernel;
  readonly clock: ManualClock;
  readonly executors: InProcessExecutors;
  readonly catalog: StaticProgramCatalog;
  readonly swap: MemorySwapDevice | null;
  readonly mm: MemoryManager | null;
  /** The harness's spawner: a parked `login` process of uid 1001 (children stay zombies until reaped). */
  readonly session: PCB;
  readonly user: ProcCred;
  /** Spawn through the real spawn path; resolves once the child is READY (the frames are pumped). */
  spawn(name: string, as?: SpawnAs): Promise<PCB>;
  /** Deliver frames until the queue is empty and every promise has settled. */
  pump(): Promise<void>;
  /** Run for `ms` of kernel time (executing programs, then jumping to the next timer). */
  runFor(ms: number): Promise<void>;
  /** Run until `pred()` holds; false when `maxMs` of kernel time passed first. */
  until(pred: () => boolean, maxMs?: number): Promise<boolean>;
  /** Kill path and table leak checks (INV-P7). */
  checkInvariants(): void;
  /**
   * Mount the kernel file system (memory store, standalone) with alice (1001) and bob (1002)
   * provisioned, register the fs and `lock.*` calls, and install the proc seams. Idempotent.
   */
  mountFs(): Promise<LoopbackFs>;
}

export interface LoopbackFs {
  readonly fs: KernelFs;
  readonly locks: LocalLocks;
}

const ALICE: ProcCred = Object.freeze({
  uid: 1001,
  gid: 1001,
  groups: Object.freeze([]),
  ruid: 1001,
});

const macrotask: () => Promise<void> = (() => {
  const immediate = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
  return immediate === undefined
    ? () => new Promise<void>((r) => setTimeout(r, 0))
    : () => new Promise<void>((r) => immediate(r));
})();

export function createProcLoopback(opts: ProcLoopbackOptions = {}): ProcLoopback {
  const clock = opts.clock ?? new ManualClock();
  const programs = new Map<string, Program<unknown>>();
  const catalog = new StaticProgramCatalog();
  for (const p of opts.programs ?? []) {
    if (!catalog.add(p.manifest))
      throw new Error(
        `invalid test manifest ${String(p.manifest.name)}: ${JSON.stringify(catalog.problems)}`,
      );
    const entry = typeof p.manifest.entry === 'string' ? p.manifest.entry : p.manifest.name;
    if (p.program !== undefined && typeof entry === 'string') programs.set(entry, p.program);
  }
  const executors = new InProcessExecutors({
    now: () => clock.now(),
    advance: (ms) => {
      clock.advance(ms);
    },
    stepCostMs: opts.stepCostMs ?? 0.25,
    programs: (entry) => programs.get(entry),
    ...(opts.sab === undefined ? {} : { sab: opts.sab }),
  });
  const platform: PlatformInfo = {
    browser: { brand: 'Chrome', major: 154 },
    cores: opts.cores ?? 8,
    crossOriginIsolated: opts.sab ?? true,
  };
  const kernel = createKernel({
    host: { clock, identity: opts.identity ?? DEV_IDENTITY, platform },
    users: new StaticUserDirectory(
      opts.users ?? [
        [1001, 'alice'],
        [1002, 'bob'],
      ],
    ),
    executors,
    programs: catalog,
    desktopInteractive: opts.desktopInteractive ?? true,
    ...(opts.sched === undefined ? {} : { sched: opts.sched }),
  });
  const { timers } = kernel;

  let swap: MemorySwapDevice | null = null;
  let mm: MemoryManager | null = null;
  if (opts.memory !== undefined && opts.memory !== false) {
    swap = new MemorySwapDevice({ now: () => clock.now() });
    mm = kernel.startMemory({
      device: swap,
      ...(opts.memory === true ? {} : { params: opts.memory }),
    });
  }

  const session = kernel.procs.create({
    ppid: 1,
    kind: 'service',
    cls: 'user',
    name: 'login',
    argv: ['[login]'],
    cred: ALICE,
    cwdPath: '/home/alice',
  });
  session.pgid = session.pid;
  session.sid = session.pid;
  session.sessionLeader = true;
  kernel.procs.park(session, 'svc:login');

  const runDue = (): void => {
    timers.runDue(clock.now());
  };

  /** Deliver frames until idle or `stop()`; the queue is FIFO and promises settle in between. */
  const drain = async (stop: () => boolean): Promise<boolean> => {
    for (let n = 0; ; n++) {
      if (stop()) return true;
      if (executors.deliverOne()) {
        runDue();
        await Promise.resolve();
        if (n % 256 === 255) await macrotask();
        continue;
      }
      // Queue empty: let every promise chain (async handlers, spawn continuations) settle.
      await macrotask();
      runDue();
      if (executors.pending === 0) return stop();
    }
  };

  const pump = async (): Promise<void> => {
    await drain(() => false);
  };

  const until = async (pred: () => boolean, maxMs = 60_000): Promise<boolean> => {
    const end = clock.now() + maxMs;
    for (;;) {
      if (await drain(() => pred() || clock.now() >= end)) {
        if (pred()) return true;
        if (clock.now() >= end) return false;
      }
      // Idle: jump to the next kernel timer (or the end).
      const next = timers.nextDeadline();
      const target = next === null ? end : Math.min(Math.max(next, clock.now()), end);
      if (target > clock.now()) clock.advance(target - clock.now());
      runDue();
    }
  };

  const runFor = async (ms: number): Promise<void> => {
    const end = clock.now() + ms;
    await until(() => clock.now() >= end, ms);
  };

  const spawn = async (name: string, as: SpawnAs = {}): Promise<PCB> => {
    const req: SpawnRequest = {
      parent: as.parent ?? session,
      name,
      argv: as.argv ?? [name],
      cred: as.cred ?? as.parent?.cred ?? ALICE,
      ...(as.setsid === undefined ? {} : { setsid: as.setsid }),
      ...(as.tty === undefined ? {} : { tty: as.tty }),
      ...(as.pgid === undefined ? {} : { pgid: as.pgid }),
      ...(as.priority === undefined ? {} : { priority: as.priority }),
      ...(as.nice === undefined ? {} : { nice: as.nice }),
      ...(as.dropCaps === undefined ? {} : { dropCaps: as.dropCaps }),
    };
    let out: PCB | null = null;
    let err: unknown = null;
    let settled = false;
    kernel.proc.spawnProcess(req).then(
      (p) => {
        out = p;
        settled = true;
      },
      (e: unknown) => {
        err = e;
        settled = true;
      },
    );
    await drain(() => settled);
    if (!settled) await until(() => settled, 10_000);
    if (out === null) throw err instanceof Error ? err : new Error(String(err));
    return out;
  };

  let mounted: Promise<LoopbackFs> | null = null;
  const mountFs = (): Promise<LoopbackFs> => {
    mounted ??= (async (): Promise<LoopbackFs> => {
      const after = (ms: number, fn: () => void): (() => void) => {
        const id = timers.arm(clock.now() + Math.max(0, ms), () => fn(), { label: 'loopback' });
        return () => {
          timers.cancel(id);
        };
      };
      const locks = new LocalLocks({ after });
      const fs = new KernelFs({
        store: new MemStore(),
        bus: kernel.bus,
        clock,
        procs: kernel.procs,
        identity: kernel.host.identity,
        osSessionId: () => kernel.osSessionId,
        busy: (ino) => locks.holders(ino).some((l) => l.mode === 'X'),
      });
      await fs.mount({ standalone: true });
      registerFsSyscalls(kernel.handlers, fs);
      for (const [uid, username] of [
        [1001, 'alice'],
        [1002, 'bob'],
      ] as const) {
        if (fs.tree.user(uid) === undefined) await provisionLocalUser(fs, { uid, username });
      }
      installProcSeams(kernel, fs, () => null);
      registerNetSyscalls(kernel.handlers, {
        monitor: new NetMonitor(kernel.bus),
        locks,
        fs: () => fs,
        sync: () => null,
        lockEngine: () => null,
        holder: (uid) => `${kernel.users.nameOf(uid)}@loopback`,
        epochMs: () => clock.epochMs(),
        after,
        leaseTtlMs: LEASE_TTL_MS,
      });
      // The kill path's lock step (PROC-07), as core/io installs it.
      kernel.procs.onTerminate((pcb) => {
        locks.releaseAll(pcb.pid);
      });
      return { fs, locks };
    })();
    return mounted;
  };

  return {
    kernel,
    clock,
    executors,
    catalog,
    swap,
    mm,
    session,
    user: ALICE,
    spawn,
    pump,
    runFor,
    until,
    checkInvariants: () => {
      kernel.proc.checkInvariants();
      mm?.checkInvariants();
    },
    mountFs,
  };
}
