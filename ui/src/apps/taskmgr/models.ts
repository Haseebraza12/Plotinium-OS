/**
 * Task Manager view models (ui-implementation-guide.md §4.5; ui-design-system.md §3.8.13).
 * The Task Manager process (apps/taskmgr) builds these from `proc.list`, `mem.stat`,
 * `ai.predict` and the frame meter, coalesced to at most one patch per frame keyed by pid
 * (DSN-19). The views only render them and emit intents; they never call the kernel (SYS-01).
 */
import type { AuditOutcome, Band, PState, SignalName } from '@plotinium/protocol';

/** The kernel's process states plus the job-control STOPPED view (SIGSTOP). */
export type ProcStateView = PState | 'STOPPED';

export type ProcessBadge = 'background' | 'speculative' | 'service' | 'kernel';

export type TaskManagerTab = 'processes' | 'memory' | 'scheduler' | 'ai';

/** The signals the End Process control can send. */
export type ProcessSignal = Extract<SignalName, 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT'>;

export interface ProcessRow {
  pid: number;
  name: string;
  user: string;
  state: ProcStateView;
  /** Why a BLOCKED process waits ("awaiting llm", "io", "lease wait"). */
  reason?: string;
  /** Static priority 0 (highest) … 39 and nice −20 … 19; PRI shows clamp(priority + nice). */
  priority: number;
  nice: number;
  /** 0 … 100 (per executor share). */
  cpu: number;
  residentBytes: number;
  /** Bytes paged out (shown for SUSPENDED rows: "0 B (38 MB swapped)"). */
  swappedBytes: number;
  /** Page faults per second. */
  faults: number;
  /** Executor index, or undefined when not resident. */
  executor?: number;
  badges: readonly ProcessBadge[];
  /** Kernel services and pid 1 cannot be ended ("System process: cannot end"). */
  protected?: boolean;
}

export interface ProcessSummary {
  processes: number;
  /** Executors running now (one card each in the performance strip). */
  executors: number;
  /** The pool's ceiling when more executors could start on demand ("1 of 11 executors"). */
  executorsMax?: number;
  load: number;
  uptimeMs: number;
}

export interface ExecutorStat {
  id: number;
  /** Current CPU percent 0 … 100. */
  cpu: number;
  /** Last samples, oldest first (60 at 1 sample/s). */
  samples: readonly number[];
  /** What runs there ("sched, vfs, init"). */
  runs: string;
  /** The executor crashed and is restarting. */
  lost?: boolean;
}

export interface FrameStats {
  /** p95 frame time in ms (PROC-05 budget 16.7). */
  p95Ms: number;
  /** Frame-time histogram bucket counts, shortest first (0-4 ms, 4-8 ms, …; the last is open). */
  histogram: readonly number[];
  /** Width of one histogram bucket in ms (default 4). */
  bucketMs?: number;
  /** Long animation frames in the window. */
  longFrames: number;
}

export interface PerformanceModel {
  executors: readonly ExecutorStat[];
  frame: FrameStats;
  memory: { usedBytes: number; totalBytes: number; segments?: readonly number[] };
  faultsPerSecond: number;
}

// ---------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------

export type BudgetSegmentKind = 'kernel' | 'apps' | 'model' | 'vectors' | 'speculative';

export interface BudgetSegment {
  kind: BudgetSegmentKind;
  label: string;
  bytes: number;
  /** Tag shown in the legend and the tooltip ("evictable", "first to evict"). */
  tag?: string;
  /** Tooltip detail ("evict = terminate · page-in = reload"). */
  detail?: string;
}

export interface MemoryStats {
  faults: number;
  faultsPerSecond: number;
  majorFaults: number;
  faultSamples: readonly number[];
  hitRatio: number;
  /** Hit-ratio change against 5 minutes ago, in percentage points. */
  hitRatioDelta: number;
  hitSamples: readonly number[];
  pagedOutBytes: number;
  pagedOutPages: number;
  pagedOutSamples: readonly number[];
  pagedInBytes: number;
  pageInP95Ms: number;
  pagedInSamples: readonly number[];
}

export interface SwapTier {
  name: string;
  usedBytes: number;
  capacityBytes: number;
  online?: boolean;
}

export interface MemoryProcessRow {
  pid: number;
  name: string;
  user: string;
  residentBytes: number;
  swappedLocalBytes: number;
  swappedRemoteBytes: number;
  faults: number;
  pinned: boolean;
  /** Kernel processes and the focused window's process are always resident. */
  pinLocked?: boolean;
  /** Pin request in flight. */
  pinPending?: boolean;
  tag?: 'evictable' | 'speculative' | 'suspended';
  /** Over the per-process soft limit (shows "!"). */
  overSoftLimit?: boolean;
  /** Priority note shown after the name ("pri 32"). */
  note?: string;
}

export interface PredictionRow {
  app: 'files' | 'terminal' | 'editor' | 'task-manager' | 'settings' | 'search';
  label: string;
  /** 0 … 1. */
  confidence: number;
  prefetched?: boolean;
}

export interface PredictionsModel {
  state: 'ready' | 'off' | 'cold' | 'crashed';
  model: string;
  rows: readonly PredictionRow[];
  reason: string;
  threshold: number;
  launches: number;
  /** Launches needed before the model replaces the MFU fallback. */
  coldTarget: number;
  speculativeBytes: number;
  expiresIn: string;
  adoptedBytes: number;
  wastedBytes: number;
}

export interface MemoryModel {
  budgetBytes: number;
  lowWatermark: number;
  highWatermark: number;
  segments: readonly BudgetSegment[];
  /** Longest continuous over-budget interval (ms), 0 when never over. */
  overBudgetMs: number;
  reclaiming: boolean;
  reclaimedBytes: number;
  stats: MemoryStats;
  swap: readonly SwapTier[];
  swapNote: string;
  processes: readonly MemoryProcessRow[];
  totalProcesses: number;
  softLimitBytes: number;
  thrashingGuard: boolean;
  /** Set when the accounting worker stopped answering. */
  staleSince?: string;
  /** Why the Pin switches cannot work yet (no kernel call); they are disabled with this reason. */
  pinUnavailable?: string;
  /** Why Reclaim now cannot work yet; the button is disabled with this reason. */
  reclaimUnavailable?: string;
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

export interface ReadyEntry {
  pid: number;
  name: string;
  /** Base priority clamp(priority + nice). */
  base: number;
  /** Current effective priority after aging. */
  effPrio: number;
  waitedMs: number;
}

export interface ReadyBand {
  band: Band;
  quantumMs: number;
  entries: readonly ReadyEntry[];
}

export interface RunningSlice {
  executor: number;
  pid?: number;
  name?: string;
  band?: Band;
  /** Time used of the current quantum. */
  usedMs?: number;
  quantumMs?: number;
}

export interface SchedulerModel {
  bands: readonly ReadyBand[];
  running: readonly RunningSlice[];
  runTokens: { used: number; total: number };
  dispatchesPerSecond: number;
  preemptionsPerSecond: number;
  /** Aging interval T_age in ms. */
  tAgeMs: number;
  /** The worst-case parameters of the declared bound (processes-and-scheduling.md §3.12). */
  bound: { p: number; n: number; e: number; qMs: number; deltaMs: number; hKillMs: number };
  /** Longest measured READY wait. */
  maxWaitMs: number;
  /** Background band paused by the interactive hint. */
  interactivePause: boolean;
}

// ---------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  /** Epoch ms. */
  at: number;
  actor: 'user' | 'agent' | 'system';
  call: string;
  summary: string;
  outcome: AuditOutcome;
  pid: number;
}

export interface AiModel {
  indexer: {
    state: 'indexing' | 'idle' | 'paused' | 'error' | 'off';
    indexed: number;
    total: number;
    pid: number;
    priority: number;
    chunksPerSecond: number;
    model: string;
    error?: string;
  };
  agent: {
    provider: string;
    status: 'connected' | 'degraded' | 'offline' | 'signed-out';
    usedCents: number;
    capCents: number;
    resetsOn: string;
    requestsToday: number;
    requireConfirm: boolean;
  };
  audit: readonly AuditEntry[];
}
