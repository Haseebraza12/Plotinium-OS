/**
 * The service implementation contract (boot-and-services.md §4.2 and §4.3).
 *
 * The service manager runs inside the kernel worker. Timers come from the kernel timer heap
 * (`KernelTimers`), never from `setTimeout`, so a timeout can never move boot progress (BOOT-02,
 * SVC-03, SVC-10).
 */
import type { ServiceManifest, ServiceName } from '@plotinium/protocol';

export type BootProfile = 'normal' | 'safe' | 'recovery';

export type ServiceState =
  | 'pending'
  | 'blocked'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'failed'
  | 'retry-wait'
  | 'skipped'
  | 'stopping'
  | 'stopped';

export type StartResult =
  | { readonly status: 'running' }
  | { readonly status: 'degraded'; readonly reason: string; readonly selfHeals: boolean };

/** The kernel timer heap as services see it (processes-and-scheduling.md §3.8, KPS-13). */
export interface KernelTimers {
  /** Fire `fire` at `deadlineMs` (kernel clock). Returns a handle. */
  at(deadlineMs: number, fire: () => void, priority?: number): number;
  cancel(handle: number): boolean;
  /** Milliseconds since t0, monotonic. */
  now(): number;
}

export type LogLevel = 'info' | 'warn' | 'degraded' | 'fail';

export interface ServiceContext {
  readonly name: ServiceName;
  readonly profile: BootProfile;
  readonly pid: number;
  readonly timers: KernelTimers;
  /** Aborted on timeout or shutdown. */
  readonly signal: AbortSignal;
  log(level: LogLevel, msg: string): void;
  /** Boot-screen current-service line; never moves the bar. */
  label(text: string): void;
  /** Only if `manifest.userWait`: pauses the timeout clock while `p` is pending. */
  userWait<T>(p: Promise<T>): Promise<T>;
  /**
   * Pauses the timeout clock while the service's own CODE downloads (`p`: a worker script and its
   * imports), so `timeoutMs` measures the work, not the network (ARC-08, UI-032). Not user wait:
   * it counts in the boot time. Bounded by `CODE_WAIT_MAX_MS` (× the timeout scale): after that the
   * start fails with `timeout: code not loaded`.
   */
  codeWait<T>(p: Promise<T>): Promise<T>;
  degraded(reason: string): void;
  recovered(): void;
  /** §5.3 schedule; records the attempt. */
  backoff(): { attempt: number; delayMs: number; retryAt: number };
  depState(dep: ServiceName): ServiceState;
  onDependencyRecovered(cb: (dep: ServiceName) => void): void;
}

export interface ServiceImpl {
  /** Rejects = failure. */
  start(ctx: ServiceContext): Promise<StartResult>;
  stop(ctx: ServiceContext, reason: 'shutdown' | 'restart' | 'retry'): Promise<void>;
}

/** V9 checks manifest names against this. */
export type ServiceRegistry = ReadonlyMap<ServiceName, ServiceImpl>;

/** Returned by `svc.status` (§4.3). Times are ms since t0. */
export interface ServiceStatus {
  readonly name: ServiceName;
  readonly pid: number | null;
  readonly level: number;
  readonly critical: boolean;
  readonly weight: number;
  readonly state: ServiceState;
  readonly reason: string | null;
  readonly attempts: number;
  readonly nextRetryAt: number | null;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
  /** Member of A, the ancestor closure of the boot target (§5.5). */
  readonly inBootTarget: boolean;
}

/** A manifest together with the file it came from (V2 compares them). */
export interface ManifestFile {
  readonly file: string;
  readonly json: unknown;
}

export type { ServiceManifest, ServiceName };
