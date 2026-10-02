/**
 * What the core syscall handlers read. Assembled once by `createKernel`.
 */
import type { EventBus } from '../events/bus.ts';
import type { BuildIdentity, KernelClock, PlatformInfo } from '../host.ts';
import type { Klog } from '../klog/klog.ts';
import type { ProcManager } from '../proc/manager.ts';
import type { UserDirectory } from '../proc/users.ts';

export interface SyscallContext {
  readonly procs: ProcManager;
  readonly klog: Klog;
  readonly bus: EventBus;
  readonly clock: KernelClock;
  readonly identity: BuildIdentity;
  readonly platform: PlatformInfo;
  readonly users: UserDirectory;
  /** Wall-clock epoch (ms) of kernel time 0, fixed at kernel creation. */
  readonly epochAtZero: number;
}
