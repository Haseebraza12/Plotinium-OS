/**
 * The service implementations registered by this kernel build (V9, boot-and-services.md §3.3).
 *
 * Kernel-host services, always real: `kernel` (kernel init is done), `sched` (executor #1 started
 * through the process system and its ABI hello verified: the pool, the scheduler, the watchdog and
 * the timer heap are live), `wm` (compositor port attached) and `desktop` (the router's
 * desktop-interactive mark).
 *
 * The system services (storage, mm, vfs, login, session, auth, sync, lockd, ai.*, complete,
 * update) come from the I/O layer (`kernel.io.services`, core/io) when the kernel was built with
 * it. Without it, `mm` is still real when the host passes `memory` (the memory manager on the
 * blkio device), and every other service is an explicit PLACEHOLDER: critical placeholders report
 * RUNNING with a klog WARN naming the missing integration, and non-critical ones start DEGRADED
 * with reason `not implemented yet`, so the tray shows the truth.
 */
import type { ServiceImpl, ServiceName, StartResult } from '@plotinium/services';

import type { Kernel } from '../core/kernel.ts';
import type { MemoryOptions } from '../core/proc/mm-link.ts';

export interface ServiceHostDeps {
  readonly kernel: Kernel;
  /**
   * Legacy probe (no executor transport): spawn executor #1 and resolve once its `hello` matched
   * this build's ABI. Absent: `kernel.proc.startFirstExecutor()`.
   */
  readonly spawnFirstExecutor?: () => Promise<void>;
  /** The memory manager's devices; makes `mm` real when the I/O layer does not provide it. */
  readonly memory?: () => Promise<MemoryOptions>;
  /** Resolves when the router attached the compositor port (the wm handshake). */
  readonly compositorAttached: () => Promise<void>;
  /** Resolves at the router's `desktop.interactive`. */
  readonly desktopInteractive: () => Promise<void>;
  /** Ask the router to register the Service Worker (after interactive plus idle). */
  readonly requestSwRegister: () => void;
  /**
   * Resolves once executor 1's code has downloaded (its first message). `sched` waits on it with
   * `ctx.codeWait`, so its 500 ms budget measures the start, not the network (UI-032).
   */
  readonly executorCode?: () => Promise<void>;
}

const RUNNING: StartResult = { status: 'running' };
const stopNothing = (): Promise<void> => Promise.resolve();

function placeholder(critical: boolean, owner: string): ServiceImpl {
  return {
    start: (ctx) => {
      if (critical) {
        ctx.log('warn', `placeholder service (${owner} integration pending)`);
        return Promise.resolve(RUNNING);
      }
      return Promise.resolve({
        status: 'degraded',
        reason: 'not implemented yet',
        selfHeals: false,
      });
    },
    stop: stopNothing,
  };
}

export function createServiceRegistry(deps: ServiceHostDeps): Map<ServiceName, ServiceImpl> {
  const reg = new Map<ServiceName, ServiceImpl>();
  reg.set('kernel', { start: () => Promise.resolve(RUNNING), stop: stopNothing });
  reg.set('sched', {
    start: async (ctx) => {
      ctx.label('sched: starting executor 1');
      const { proc } = deps.kernel;
      const started =
        deps.spawnFirstExecutor !== undefined
          ? deps.spawnFirstExecutor()
          : proc.startFirstExecutor();
      const code = deps.executorCode;
      if (code !== undefined) {
        // The download of the executor bundle is network time, not sched's (ARC-08): a failed
        // start still ends the wait, and the budget then covers the ABI hello.
        await ctx.codeWait(Promise.race([code(), started.then(() => undefined)]));
      }
      await started;
      ctx.log(
        'info',
        `executor 1 alive (nested module worker, ABI verified) · pool ≤ ${String(proc.pool.maxExecutors)} executors · ${String(proc.sched.tokens.capacity)} run tokens · quantum ${String(proc.sched.params.quantumMs.normal)} ms`,
      );
      return RUNNING;
    },
    stop: stopNothing,
  });
  reg.set('wm', {
    start: async (ctx) => {
      ctx.label('wm: waiting for the compositor');
      await deps.compositorAttached();
      return RUNNING;
    },
    stop: stopNothing,
  });
  reg.set('desktop', {
    start: async (ctx) => {
      ctx.label('desktop: mounting the shell');
      await deps.desktopInteractive();
      return RUNNING;
    },
    stop: stopNothing,
  });
  reg.set('update', {
    start: () => {
      deps.requestSwRegister();
      return Promise.resolve({
        status: 'degraded',
        reason: 'not implemented yet',
        selfHeals: false,
      });
    },
    stop: stopNothing,
  });
  for (const name of ['storage', 'mm', 'vfs']) reg.set(name, placeholder(true, 'R2'));
  for (const name of ['login', 'session']) reg.set(name, placeholder(true, 'R3'));
  for (const name of ['auth', 'sync', 'lockd']) reg.set(name, placeholder(false, 'R5'));
  for (const name of ['ai.runtime', 'ai.indexer', 'ai.predictor', 'ai.agent', 'complete'])
    reg.set(name, placeholder(false, 'R4'));
  const memory = deps.memory;
  if (memory !== undefined) reg.set('mm', memoryService(deps.kernel, memory));
  // The I/O layer's real services replace the placeholders (and the host `mm`).
  const io = deps.kernel.io;
  if (io !== null) {
    for (const [name, impl] of io.services) {
      if (name === 'kernel' || name === 'sched' || name === 'wm' || name === 'desktop') continue;
      reg.set(name, impl);
    }
  }
  return reg;
}

/**
 * `mm` without the I/O layer (§3.3 "mm: budget set, swap device open"): build the memory manager
 * on the host's swap devices and attach it to the process system. The 1 s tick runs from the
 * process system's housekeeping timer.
 */
function memoryService(kernel: Kernel, memory: () => Promise<MemoryOptions>): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('mm: opening the swap device');
      const opts = await memory();
      const mm = kernel.proc.mm ?? kernel.startMemory(opts);
      const swap = opts.device.kind;
      ctx.log(
        'info',
        `memory budget ${String(Math.round(mm.budget / 1_048_576))} MiB · swap ${swap}${opts.remote === undefined ? '' : ' + remote'}`,
      );
      return RUNNING;
    },
    stop: stopNothing,
  };
}
