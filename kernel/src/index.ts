/**
 * @plotinium/kernel: the kernel (architecture.md §3.3.1; C2). Exactly one kernel worker per origin
 * owns the process table, the dispatcher, the event bus, klog and the service manager; the core
 * (`src/core`) is thread-agnostic and the hosts (`src/host`) bind it to a worker, the main-thread
 * router or the Node loopback.
 *
 * Subpaths: `@plotinium/kernel/sys` (the only kernel module apps may import), `/hooks` (the AI
 * seams, for ai/), `/host/main` (the router, for web/), `/host/worker` (the worker entry),
 * `/host/loopback` (tests). Primary owner: R1 Kernel.
 */
export const PACKAGE_NAME = '@plotinium/kernel';

export { createKernel } from './core/kernel.ts';
export type { Kernel, KernelOptions } from './core/kernel.ts';
export { DEV_IDENTITY, detectBrowser, normaliseCores } from './core/host.ts';
export type {
  BrowserBrand,
  BuildIdentity,
  KernelClock,
  KernelHost,
  PlatformInfo,
} from './core/host.ts';
export { KernelBug, KernelError } from './core/errors.ts';
export { EventBus, Subscription, SUBSCRIPTION_QUEUE_MAX } from './core/events/bus.ts';
export type { SubscriberCred, VisibilityHook } from './core/events/bus.ts';
export { FrameBatcher } from './core/events/batch.ts';
export { Klog, KLOG_SIZE } from './core/klog/klog.ts';
export type { KlogInput, KlogLevel, KlogRecord } from './core/klog/records.ts';
export { formatBootLine, toKlogEntry } from './core/klog/format.ts';
export { Dispatcher, VIEW_BACKLOG_MAX } from './core/ipc/dispatcher.ts';
export { HandlerRegistry, NO_REPLY } from './core/ipc/handlers.ts';
export type { CallImpl } from './core/ipc/handlers.ts';
export { execPort, viewPort } from './core/ipc/ports.ts';
export type { Caller, ExecPortRec, ViewPortRec } from './core/ipc/ports.ts';
export { Auditor, MemoryAuditSink } from './core/ipc/audit.ts';
export type { AuditSink } from './core/ipc/audit.ts';
export { EDGES, isAllowedEdge, Lifecycle } from './core/proc/lifecycle.ts';
export type { TransitionReason } from './core/proc/lifecycle.ts';
export { ProcManager } from './core/proc/manager.ts';
export { createPcb } from './core/proc/pcb.ts';
export type { ExitReason, PCB, ProcCred, ProcKind, WaitReason } from './core/proc/pcb.ts';
export { createProcessTable } from './core/proc/table.ts';
export type { ProcessTable } from './core/proc/table.ts';
export { INIT_PID, PidAllocator } from './core/proc/pid.ts';
export { StaticUserDirectory } from './core/proc/users.ts';
export type { UserDirectory } from './core/proc/users.ts';
export { ExecutorRuntime } from './runtime/executor.ts';
export type { DispatchFrame, LoadRequest, SliceReport } from './runtime/executor.ts';

// The process system, the program registry (injected by the composing host) and the executor
// transports (processes-and-scheduling.md §3.6–§3.17; the kernel-proc wiring).
export { ProcessSystem, capsForSpawn, toKernelError } from './core/proc/system.ts';
export type { ProcHooks, ServiceHealth, SpawnRequest } from './core/proc/system.ts';
export type {
  ExecutorToKernel,
  ExecutorTransport,
  KernelToExecutor,
} from './core/proc/exec-frames.ts';
export { JobControl } from './core/proc/jobs.ts';
export { SysctlTable } from './core/proc/sysctl.ts';
export { createMemoryManager, kernelMemPort } from './core/proc/mm-link.ts';
export type { MemoryOptions } from './core/proc/mm-link.ts';
export {
  BIN_DIR,
  EMPTY_CATALOG,
  manifestNameOf,
  manifestPath,
  StaticProgramCatalog,
  startupClosure,
} from './core/programs/index.ts';
export type { ProgramCatalog, StartupPlan } from './core/programs/index.ts';
export { timerHeapKernelTimers } from './core/kernel.ts';
export type { KernelIoOptions } from './core/kernel.ts';
export { TimerHeap } from './core/sched/timers.ts';
export type { ProgramLoader, ProgramLoaders } from './runtime/sys.ts';
// Memory manager and blkio (the mm agent's request).
export * from './core/mm/index.ts';
export * from './blkio/index.ts';
// The composing host (web's kernel worker): the ONE permission function (for the AI link's file
// view) and the first-boot seed helpers (branding files served at /branding/).
export { may } from '@plotinium/vfs';
export { BRANDING_FILES, fetchSeed } from './core/io/seed.ts';
export type { SeedSource } from './core/io/seed.ts';
