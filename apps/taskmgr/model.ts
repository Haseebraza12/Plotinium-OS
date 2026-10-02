/**
 * Task Manager view models from system-call results (ui-design-system.md §3.8.13; PROC-08, MEM-07,
 * PRE-06). Pure functions: no clock, no I/O. apps/taskmgr/controller.ts owns the history (samples,
 * previous counters) and passes it in, so every mapping here is a unit-testable function.
 *
 * Names follow `ps` exactly (apps/coreutils/lib/procs.ts): the process name is basename(argv[0]),
 * CPU is `cpuPct` and memory is `residentBytes`, so "Task Manager rows show the same state, CPU
 * share and memory as ps within one refresh" (PROC-08) holds by construction.
 */
import type {
  AuditRecord,
  Band,
  IndexStatus,
  MemStat,
  NetStatus,
  PredictModel,
  ProcInfo,
  RetOf,
  StatFs,
} from '@plotinium/protocol';
import type {
  AiModel,
  AuditEntry,
  BudgetSegment,
  ExecutorStat,
  FrameStats,
  MemoryModel,
  MemoryProcessRow,
  PerformanceModel,
  PredictionRow,
  PredictionsModel,
  ProcessBadge,
  ProcessRow,
  ProcessSummary,
  ProcStateView,
  ReadyBand,
  RunningSlice,
  SchedulerModel,
} from '@plotinium/ui/apps/taskmgr';

import type { AppAgentBudget, SysResult } from '../src/descriptor.ts';

export const MIB = 1024 * 1024;

/** memory-and-paging.md §3.1: reclaim starts above 85 % and stops at 75 % of the budget. */
export const HIGH_WATERMARK = 0.85;
export const LOW_WATERMARK = 0.75;
/** MEM-01 default budget and the per-process soft limit when the kernel reports none. */
export const DEFAULT_BUDGET_BYTES = 256 * MIB;
export const DEFAULT_SOFT_LIMIT_BYTES = 64 * MIB;

/** processes-and-scheduling.md §3.1 defaults (Settings may change them through sysctl). */
export const DEFAULT_QUANTUM_MS: Readonly<Record<Band, number>> = {
  interactive: 5,
  normal: 10,
  background: 20,
};
export const DEFAULT_T_AGE_MS = 100;
/**
 * §3.12.4-§3.12.5 declared-bound terms: p = 39, N = 51 runnable, E = 1, Q = the largest quantum,
 * δ = 1 ms, H_kill = 400 ms, which gives 40 × 100 + 50 × 21 + 400 = 5,450 ms with the defaults.
 */
export const BOUND_P = 39;
export const BOUND_N = 51;
export const BOUND_DELTA_MS = 1;
export const BOUND_H_KILL_MS = 400;

/** predictive-prefetch.md §3.5–§3.6: θ starts at 0.40; MFU until 50 launches. */
export const PREDICT_THRESHOLD = 0.4;
export const PREDICT_COLD_TARGET = 50;

/** Samples kept for sparklines (1 per refresh). */
export const PERF_SAMPLES = 60;
export const MEM_SAMPLES = 30;

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/** basename(argv[0]), the COMMAND column of `ps`. */
export function processName(p: Pick<ProcInfo, 'argv' | 'pid'>): string {
  const argv0 = p.argv[0];
  if (argv0 === undefined || argv0 === '') return `pid ${String(p.pid)}`;
  const slash = argv0.lastIndexOf('/');
  const base = slash >= 0 ? argv0.slice(slash + 1) : argv0;
  return base === '' ? argv0 : base;
}

/**
 * The name the Task Manager shows (UI-160): `processName`, without the brackets `ps` puts around
 * a kernel thread or service ("[sched]" → "sched"). The row's `kernel`/`service` badge says what
 * it is, as in the task-manager-processes reference.
 */
export function displayName(p: Pick<ProcInfo, 'argv' | 'pid'>): string {
  const name = processName(p);
  const bracketed = /^\[(.+)\]$/u.exec(name);
  return bracketed?.[1] ?? name;
}

/**
 * A kernel service record: `ps` brackets its name ("[ai.indexer]"). A daemon service also runs a
 * program with the bare name ("ai.indexer", on an executor), so both rows read "ai.indexer" once
 * the brackets are gone (UI-160); the record keeps its `service` badge to tell them apart.
 */
export function isServiceRecord(p: Pick<ProcInfo, 'argv' | 'pid'>): boolean {
  return p.pid !== 1 && /^\[.+\]$/u.test(processName(p));
}

/**
 * The live process whose display name is `name`. The program that does the work ("ai.indexer",
 * on an executor) wins over the kernel's service record ("[ai.indexer]"), which is found only
 * when no program runs (UI-132).
 */
export function findProcess(procs: readonly ProcInfo[], name: string): ProcInfo | undefined {
  let record: ProcInfo | undefined;
  for (const p of procs) {
    if (p.state === 'TERMINATED' || displayName(p) !== name) continue;
    if (!isServiceRecord(p)) return p;
    record ??= p;
  }
  return record;
}

/** clamp(priority + nice, 0, 39): the PRI column. */
export function basePriority(priority: number, nice: number): number {
  return Math.min(39, Math.max(0, priority + nice));
}

/** interactive 0–9, normal 10–29, background 30–39 (processes-and-scheduling.md §3.9.2). */
export function bandOf(base: number): Band {
  if (base <= 9) return 'interactive';
  if (base <= 29) return 'normal';
  return 'background';
}

/** `ps` shows a job-control stop as STP: BLOCKED waiting for SIGCONT. */
export function stateView(p: Pick<ProcInfo, 'state' | 'waitingOn'>): ProcStateView {
  if (p.state === 'BLOCKED' && p.waitingOn === 'sigcont') return 'STOPPED';
  return p.state;
}

/**
 * Reasons in words for the kernel's `waitingOn` channels (kernel/src/core/proc/pcb.ts
 * `WaitReason`). A kernel service parked on `svc:<name>` is waiting for requests: idle (UI-160).
 */
const WAIT_TEXT: Readonly<Record<string, string>> = {
  'net:llm': 'awaiting llm',
  llm: 'awaiting llm',
  ai: 'awaiting ai',
  mem: 'memory',
  page: 'page-in',
  sleep: 'sleeping',
  wait: 'wait',
  io: 'io',
  lease: 'lease wait',
  lock: 'lease wait',
  tty: 'terminal input',
  'tty:in': 'terminal input',
  pipe: 'pipe',
  events: 'events',
  svc: 'idle',
};

/** The pill's reason: why a BLOCKED process waits, or "paged out" for SUSPENDED. */
export function stateReason(p: Pick<ProcInfo, 'state' | 'waitingOn'>): string | undefined {
  if (p.state === 'SUSPENDED') return 'paged out';
  if (p.state !== 'BLOCKED' || p.waitingOn === null || p.waitingOn === 'sigcont') return undefined;
  const w = p.waitingOn;
  return WAIT_TEXT[w] ?? WAIT_TEXT[w.split(':')[0] ?? ''] ?? w;
}

export function isSpeculative(p: Pick<ProcInfo, 'speculative' | 'argv' | 'pid'>): boolean {
  return p.speculative || processName(p).startsWith('prefetch:');
}

/**
 * Row badges (docs/design/stitch/task-manager-processes): `kernel` for init, `service` for a
 * system process, `speculative` for a prefetch job, `background` for base priority 30–39. A
 * background system program (ai.indexer) shows only `background`, as in the reference; its
 * kernel service record ("[ai.indexer]") keeps `service` as well, so the two rows differ.
 */
export function badgesOf(p: ProcInfo): ProcessBadge[] {
  const badges: ProcessBadge[] = [];
  const speculative = isSpeculative(p);
  const background = !speculative && basePriority(p.priority, p.nice) >= 30;
  if (p.pid === 1) badges.push('kernel');
  else if (p.class === 'system' && (!background || isServiceRecord(p))) badges.push('service');
  if (speculative) badges.push('speculative');
  if (background) badges.push('background');
  return badges;
}

/** Per-pid counters from the previous refresh (for rates). */
export interface ProcSample {
  readonly faults: number;
  readonly at: number;
}

/** Faults per second since the previous sample (0 on the first). */
export function faultRate(
  p: Pick<ProcInfo, 'faults'>,
  prev: ProcSample | undefined,
  now: number,
): number {
  if (prev === undefined) return 0;
  const dt = (now - prev.at) / 1000;
  if (dt <= 0) return 0;
  return Math.max(0, (p.faults - prev.faults) / dt);
}

export function toProcessRow(p: ProcInfo, prev: ProcSample | undefined, now: number): ProcessRow {
  const reason = stateReason(p);
  const row: ProcessRow = {
    pid: p.pid,
    name: displayName(p),
    user: p.user,
    state: stateView(p),
    priority: p.priority,
    nice: p.nice,
    cpu: Math.min(100, Math.max(0, p.cpuPct)),
    residentBytes: p.residentBytes,
    swappedBytes: p.swappedBytes,
    faults: Math.round(faultRate(p, prev, now) * 10) / 10,
    badges: badgesOf(p),
  };
  if (reason !== undefined) row.reason = reason;
  if (p.executor !== null && p.state !== 'SUSPENDED') row.executor = p.executor;
  if (p.pid === 1 || p.class === 'system') row.protected = true;
  return row;
}

/** Distinct executor indices of resident processes, ascending. */
export function executorsOf(procs: readonly ProcInfo[]): number[] {
  const set = new Set<number>();
  for (const p of procs) if (p.executor !== null && p.state !== 'SUSPENDED') set.add(p.executor);
  return [...set].sort((a, b) => a - b);
}

export function runnableCount(procs: readonly ProcInfo[]): number {
  return procs.filter((p) => p.state === 'READY' || p.state === 'RUNNING').length;
}

/**
 * The summary line (UI-138): `executors` counts the executors that hold a process now (the cards
 * of the performance strip), `executorsMax` the pool's ceiling (hardware threads − 1), because
 * the kernel starts executors on demand.
 */
export function toSummary(
  procs: readonly ProcInfo[],
  load: number,
  uptimeMs: number,
  executorsMax: number,
): ProcessSummary {
  const running = executorsOf(procs).length;
  const summary: ProcessSummary = {
    processes: procs.filter((p) => p.state !== 'TERMINATED').length,
    executors: running,
    load: Math.round(load * 100) / 100,
    uptimeMs,
  };
  if (executorsMax > running) summary.executorsMax = executorsMax;
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------

/** CPU share per executor now: the sum of its residents' CPU, capped at 100. */
export function executorLoad(
  procs: readonly ProcInfo[],
): Map<number, { cpu: number; names: string[] }> {
  const out = new Map<number, { cpu: number; names: string[] }>();
  for (const p of procs) {
    if (p.executor === null || p.state === 'SUSPENDED' || p.state === 'TERMINATED') continue;
    const cur = out.get(p.executor) ?? { cpu: 0, names: [] };
    cur.cpu = Math.min(100, cur.cpu + Math.max(0, p.cpuPct));
    const name = displayName(p);
    cur.names.push(p.state === 'BLOCKED' ? `${name} (blocked)` : name);
    out.set(p.executor, cur);
  }
  return out;
}

export function toExecutorStats(
  procs: readonly ProcInfo[],
  history: ReadonlyMap<number, readonly number[]>,
): ExecutorStat[] {
  const load = executorLoad(procs);
  const ids = [...new Set([...load.keys(), ...history.keys()])].sort((a, b) => a - b);
  return ids.map((id) => {
    const cur = load.get(id);
    const names = cur?.names ?? [];
    return {
      id,
      cpu: Math.round((cur?.cpu ?? 0) * 10) / 10,
      samples: history.get(id) ?? [],
      runs:
        names.length === 0
          ? 'idle'
          : names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : ''),
    };
  });
}

/** Width of one frame-time histogram bucket (the view labels the buckets with it). */
export const FRAME_BUCKET_MS = 4;

export const EMPTY_FRAMES: FrameStats = {
  p95Ms: 0,
  histogram: [],
  longFrames: 0,
  bucketMs: FRAME_BUCKET_MS,
};

/** p95 of frame durations plus a 4 ms-bucket histogram (13 buckets, the last one open). */
export function frameStats(durations: readonly number[]): FrameStats {
  if (durations.length === 0) return EMPTY_FRAMES;
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const histogram = Array.from({ length: 13 }, () => 0);
  let longFrames = 0;
  for (const d of durations) {
    const bucket = Math.min(12, Math.floor(d / FRAME_BUCKET_MS));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    if (d > 50) longFrames++;
  }
  return {
    p95Ms: Math.round((sorted[idx] ?? 0) * 10) / 10,
    histogram,
    longFrames,
    bucketMs: FRAME_BUCKET_MS,
  };
}

/** Nearest-rank p95 of latency samples (ms). */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------

export interface MemoryHistory {
  readonly faultRate: readonly number[];
  /** Hit ratio samples in percent. */
  readonly hit: readonly number[];
  /** Bytes paged out per second, as MB. */
  readonly outRate: readonly number[];
  /** Bytes paged in per second, as MB. */
  readonly inRate: readonly number[];
}

export const EMPTY_MEMORY_HISTORY: MemoryHistory = {
  faultRate: [],
  hit: [],
  outRate: [],
  inRate: [],
};

export interface MemoryFacts {
  /** `mem.stat`, or null when the call failed (the model then shows process totals). */
  readonly stat: MemStat | null;
  readonly procs: readonly ProcInfo[];
  readonly statfs: StatFs | null;
  readonly net: NetStatus | null;
  readonly history: MemoryHistory;
  readonly overBudgetMs: number;
  readonly pageInLatencies: readonly number[];
  readonly majorFaults: number;
  readonly pagesOut: number;
  /** The budget from sysctl, for the fallback when mem.stat is unavailable. */
  readonly budgetBytes: number;
  readonly softLimitBytes: number;
  readonly thrashingGuard: boolean;
  /** Hit ratio now minus 5 minutes ago, in percentage points. */
  readonly hitRatioDelta: number;
  /** Why mem.stat failed, shown in the stale banner. */
  readonly statError?: string;
}

function segment(
  kind: BudgetSegment['kind'],
  label: string,
  bytes: number,
  tag?: string,
  detail?: string,
): BudgetSegment {
  const s: BudgetSegment = { kind, label, bytes };
  if (tag !== undefined) s.tag = tag;
  if (detail !== undefined) s.detail = detail;
  return s;
}

/** Budget bar segments from `mem.stat`; zero-byte optional segments are left out. */
export function budgetSegments(stat: MemStat): BudgetSegment[] {
  const embed = stat.embed.state === 'resident' ? stat.embed.bytes : 0;
  const apps = Math.max(0, stat.accounted - stat.kernel - embed - stat.speculative);
  const out: BudgetSegment[] = [
    segment('kernel', 'Kernel', stat.kernel, undefined, 'Tables and buffers of the kernel itself'),
    segment('apps', 'Apps', apps, undefined, 'Process state and pages'),
  ];
  if (embed > 0)
    out.push(
      segment(
        'model',
        'ai.embed model',
        embed,
        'evictable',
        'evict = terminate · page-in = reload',
      ),
    );
  if (stat.speculative > 0)
    out.push(
      segment(
        'speculative',
        'Speculative',
        stat.speculative,
        'first to evict',
        'pre-fetched pages',
      ),
    );
  return out;
}

function memRowFromInfo(p: ProcInfo, softLimit: number): MemoryProcessRow {
  const row: MemoryProcessRow = {
    pid: p.pid,
    name: displayName(p),
    user: p.user,
    residentBytes: p.residentBytes,
    swappedLocalBytes: p.swappedBytes,
    swappedRemoteBytes: 0,
    faults: p.faults,
    pinned: p.pid === 1,
    note: `hit ${(p.hitRatio * 100).toFixed(1)}%`,
  };
  if (p.pid === 1 || p.class === 'system') {
    row.pinLocked = true;
    row.pinned = true;
  }
  if (isSpeculative(p)) row.tag = 'speculative';
  else if (p.state === 'SUSPENDED') row.tag = 'suspended';
  if (p.residentBytes + p.swappedBytes > softLimit) row.overSoftLimit = true;
  return row;
}

/**
 * Per-process memory rows (MEM-07: faults, hit ratio, resident and swapped bytes), one per live
 * process of `proc.list`. `mem.stat` per-pid figures win where the memory manager reports the
 * pid; names and users always come from `proc.list`, and a pid only `mem.stat` knows (it exited
 * between the two calls) is left out.
 */
export function memoryRows(
  facts: Pick<MemoryFacts, 'stat' | 'procs' | 'softLimitBytes'>,
): MemoryProcessRow[] {
  const statByPid = new Map((facts.stat?.procs ?? []).map((s) => [s.pid, s]));
  const rows = facts.procs
    .filter((p) => p.state !== 'TERMINATED')
    .map((info) => {
      const s = statByPid.get(info.pid);
      if (s === undefined) return memRowFromInfo(info, facts.softLimitBytes);
      const row: MemoryProcessRow = {
        ...memRowFromInfo(info, s.softLimit),
        residentBytes: s.resident,
        swappedLocalBytes: s.swapped,
        faults: s.faults,
        note: `hit ${(s.hitRatio * 100).toFixed(1)}%`,
      };
      if (s.accounted > s.softLimit) row.overSoftLimit = true;
      else delete row.overSoftLimit;
      return row;
    });
  return rows.sort(
    (a, b) => b.residentBytes + b.swappedLocalBytes - (a.residentBytes + a.swappedLocalBytes),
  );
}

export function toMemoryModel(f: MemoryFacts): MemoryModel {
  const stat = f.stat;
  const procs = f.procs.filter((p) => p.state !== 'TERMINATED');
  const resident = procs.reduce((n, p) => n + p.residentBytes, 0);
  const swapped = procs.reduce((n, p) => n + p.swappedBytes, 0);
  const faults = procs.reduce((n, p) => n + p.faults, 0);
  const hits = procs.length === 0 ? 1 : procs.reduce((n, p) => n + p.hitRatio, 0) / procs.length;
  const budget = stat?.budget ?? f.budgetBytes;
  const accounted = stat?.accounted ?? resident;
  const localSwap = stat?.swappedLocal ?? f.statfs?.swapBytes.local ?? swapped;
  const remoteSwap = stat?.swappedRemote ?? f.statfs?.swapBytes.remote ?? 0;
  const localCap = Math.max(localSwap, f.statfs?.quotaBytes ?? 0);
  const model: MemoryModel = {
    budgetBytes: budget,
    lowWatermark: LOW_WATERMARK,
    highWatermark: HIGH_WATERMARK,
    segments:
      stat === null
        ? [segment('apps', 'Processes', resident, undefined, 'Resident process memory (proc.list)')]
        : budgetSegments(stat),
    overBudgetMs: f.overBudgetMs,
    reclaiming: accounted > budget * HIGH_WATERMARK,
    reclaimedBytes: 0,
    stats: {
      faults: stat?.faults ?? faults,
      faultsPerSecond:
        Math.round((stat?.faultsPerSec ?? f.history.faultRate.at(-1) ?? 0) * 10) / 10,
      majorFaults: f.majorFaults,
      faultSamples: f.history.faultRate,
      hitRatio: stat?.hitRatio ?? hits,
      hitRatioDelta: Math.round(f.hitRatioDelta * 10) / 10,
      hitSamples: f.history.hit,
      pagedOutBytes: stat?.bytesOut ?? swapped,
      pagedOutPages: f.pagesOut,
      pagedOutSamples: f.history.outRate,
      pagedInBytes: stat?.bytesIn ?? 0,
      pageInP95Ms: Math.round(p95(f.pageInLatencies)),
      pagedInSamples: f.history.inRate,
    },
    swap: [
      { name: 'Local (OPFS)', usedBytes: localSwap, capacityBytes: localCap },
      {
        name: 'Server',
        usedBytes: remoteSwap,
        capacityBytes: Math.max(remoteSwap, localCap),
        online: f.net === null ? false : f.net.state === 'online',
      },
    ],
    swapNote:
      f.statfs === null
        ? 'swap device statistics unavailable'
        : `write-behind to the server · ${f.statfs.persisted ? 'persistent storage' : 'storage may be evicted'}`,
    processes: memoryRows(f),
    totalProcesses: procs.length,
    softLimitBytes: stat?.procs?.[0]?.softLimit ?? f.softLimitBytes,
    thrashingGuard: f.thrashingGuard,
    // UI-146: neither call exists in syscall-abi.md yet, so the controls say so instead of
    // bouncing back (memory-and-paging.md §4.2 requests them).
    pinUnavailable: 'Pinning needs a kernel pin call, which this build does not have yet.',
    reclaimUnavailable:
      'Reclaim runs by itself above the high watermark. A manual reclaim needs the mem.pageOut call, which this build does not have yet.',
  };
  if (stat === null)
    model.staleSince = f.statError ?? 'memory manager not answering · showing process totals';
  return model;
}

// ---------------------------------------------------------------------------------------------
// Predictions (PRE-06)
// ---------------------------------------------------------------------------------------------

const PREDICTION_APPS: Readonly<Record<string, { app: PredictionRow['app']; label: string }>> = {
  files: { app: 'files', label: 'Files' },
  terminal: { app: 'terminal', label: 'Terminal' },
  editor: { app: 'editor', label: 'Editor' },
  taskmgr: { app: 'task-manager', label: 'Task Manager' },
  'task-manager': { app: 'task-manager', label: 'Task Manager' },
  settings: { app: 'settings', label: 'Settings' },
  search: { app: 'search', label: 'Search' },
};

const MODEL_LABEL: Readonly<Record<PredictModel, string>> = {
  markov2: 'Markov-2 (Witten-Bell)',
  markov1: 'Markov-1',
  'mfu-bucket': 'MFU by time bucket',
  mfu: 'MFU',
};

export function toPredictionsModel(
  res: SysResult<RetOf<'ai.predict'>> | null,
  procs: readonly ProcInfo[],
  speculativeBytes: number,
  aiAvailable: boolean,
): PredictionsModel {
  const base: PredictionsModel = {
    state: 'off',
    model: '—',
    rows: [],
    reason: '',
    threshold: PREDICT_THRESHOLD,
    launches: 0,
    coldTarget: PREDICT_COLD_TARGET,
    speculativeBytes,
    expiresIn: '60 s',
    adoptedBytes: 0,
    wastedBytes: 0,
  };
  if (!aiAvailable || res === null) return base;
  if (!res.ok) {
    const off = res.errno === 'ENOSYS' || res.errno === 'EPERM';
    return { ...base, state: off ? 'off' : 'crashed', reason: res.message };
  }
  const live = new Set(
    procs
      .filter((p) => p.state !== 'TERMINATED')
      .map((p) => processName(p))
      .filter((n) => n.startsWith('prefetch:'))
      .map((n) => n.slice('prefetch:'.length)),
  );
  const rows: PredictionRow[] = [];
  for (const p of res.value.predictions) {
    const known = PREDICTION_APPS[p.app];
    if (known === undefined) continue;
    const row: PredictionRow = { app: known.app, label: known.label, confidence: p.confidence };
    if (live.has(p.app)) row.prefetched = true;
    rows.push(row);
  }
  const top = res.value.predictions[0];
  return {
    ...base,
    state: res.value.launches < PREDICT_COLD_TARGET ? 'cold' : 'ready',
    model: MODEL_LABEL[res.value.model],
    rows: rows.slice(0, 3),
    reason: top?.reason ?? '',
    launches: res.value.launches,
  };
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

export interface SchedFacts {
  readonly procs: readonly ProcInfo[];
  readonly quantumMs: Readonly<Record<Band, number>>;
  readonly tAgeMs: number;
  /** pid → epoch ms since which it has been READY without running. */
  readonly readySince: ReadonlyMap<number, number>;
  readonly now: number;
  readonly executors: readonly number[];
  readonly runTokens: number;
  readonly dispatchesPerSecond: number;
  readonly preemptionsPerSecond: number;
  readonly maxWaitMs: number;
}

export function toSchedulerModel(f: SchedFacts): SchedulerModel {
  const bands: Band[] = ['interactive', 'normal', 'background'];
  const ready = f.procs.filter((p) => p.state === 'READY');
  const readyBands: ReadyBand[] = bands.map((band) => ({
    band,
    quantumMs: f.quantumMs[band],
    entries: ready
      .filter((p) => bandOf(basePriority(p.priority, p.nice)) === band)
      .map((p) => ({
        pid: p.pid,
        name: displayName(p),
        base: basePriority(p.priority, p.nice),
        effPrio: p.effPrio,
        waitedMs: Math.max(0, f.now - (f.readySince.get(p.pid) ?? f.now)),
      }))
      .sort((a, b) => a.effPrio - b.effPrio || b.waitedMs - a.waitedMs),
  }));
  const running = f.procs.filter((p) => p.state === 'RUNNING' && p.executor !== null);
  const slices: RunningSlice[] = f.executors.map((executor) => {
    const p = running.find((r) => r.executor === executor);
    if (p === undefined) return { executor };
    const band = bandOf(basePriority(p.priority, p.nice));
    return { executor, pid: p.pid, name: displayName(p), band, quantumMs: f.quantumMs[band] };
  });
  const runnable = runnableCount(f.procs);
  return {
    bands: readyBands,
    running: slices,
    runTokens: { used: Math.min(running.length, f.runTokens), total: f.runTokens },
    dispatchesPerSecond: Math.round(f.dispatchesPerSecond),
    preemptionsPerSecond: Math.round(f.preemptionsPerSecond),
    tAgeMs: f.tAgeMs,
    bound: {
      p: BOUND_P,
      n: Math.max(BOUND_N, runnable),
      e: 1,
      qMs: Math.max(f.quantumMs.interactive, f.quantumMs.normal, f.quantumMs.background),
      deltaMs: BOUND_DELTA_MS,
      hKillMs: BOUND_H_KILL_MS,
    },
    maxWaitMs: f.maxWaitMs,
    interactivePause: false,
  };
}

// ---------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------

export interface AiFacts {
  readonly aiAvailable: boolean;
  readonly index: IndexStatus | null;
  readonly indexError?: string;
  readonly chunksPerSecond: number;
  readonly procs: readonly ProcInfo[];
  readonly net: NetStatus | null;
  readonly audit: readonly AuditRecord[];
  readonly requireConfirm: boolean;
  readonly now: number;
  /** The gateway's spending for this user (AppEnv.agentBudget), when the host can read it. */
  readonly budget?: AppAgentBudget | null;
}

function indexerState(s: IndexStatus['state']): AiModel['indexer']['state'] {
  switch (s) {
    case 'idle':
      return 'idle';
    case 'indexing':
      return 'indexing';
    case 'paused':
    case 'throttled':
      return 'paused';
    case 'degraded':
      return 'error';
  }
}

function agentStatus(net: NetStatus | null): AiModel['agent']['status'] {
  if (net === null) return 'offline';
  if (net.degraded.some((d) => d.startsWith('ai'))) return 'degraded';
  switch (net.state) {
    case 'online':
      return 'connected';
    case 'auth-required':
      return 'signed-out';
    case 'connecting':
    case 'resuming':
      return 'degraded';
    case 'offline':
      return 'offline';
  }
}

export function toAuditEntry(r: AuditRecord): AuditEntry {
  return {
    id: r.auditId,
    at: r.t,
    actor: r.actor,
    call: r.call,
    summary: r.argsSummary,
    outcome: r.outcome,
    pid: r.pid,
  };
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function toAiModel(f: AiFacts): AiModel {
  // Kernel services are "[ai.indexer]" in argv[0] (UI-132: this lookup used to miss, pid 0).
  const indexer = findProcess(f.procs, 'ai.indexer');
  const idx = f.index;
  const indexerModel: AiModel['indexer'] =
    !f.aiAvailable || idx === null
      ? {
          state: f.aiAvailable && f.indexError !== undefined ? 'error' : 'off',
          indexed: 0,
          total: 0,
          pid: indexer?.pid ?? 0,
          priority: indexer === undefined ? 0 : basePriority(indexer.priority, indexer.nice),
          chunksPerSecond: 0,
          model: '—',
        }
      : {
          state: indexerState(idx.state),
          indexed: idx.indexedFiles,
          total: idx.indexedFiles + idx.pending,
          pid: indexer?.pid ?? 0,
          priority: indexer === undefined ? 32 : basePriority(indexer.priority, indexer.nice),
          chunksPerSecond: Math.round(f.chunksPerSecond * 10) / 10,
          model: idx.modelKey,
        };
  const err = idx?.lastError ?? f.indexError;
  if (err !== undefined && indexerModel.state === 'error') indexerModel.error = err;
  const today = startOfDay(f.now);
  return {
    indexer: indexerModel,
    agent: {
      provider: f.budget?.provider ?? 'Plotinium server (LLM proxy)',
      status: agentStatus(f.net),
      usedCents: f.budget?.usedCents ?? 0,
      capCents: f.budget?.capCents ?? 0,
      resetsOn: f.budget?.resetsOn ?? '1st of next month',
      requestsToday: f.audit.filter((r) => r.call === 'ai.agent.plan' && r.t >= today).length,
      requireConfirm: f.requireConfirm,
    },
    audit: [...f.audit]
      .sort((a, b) => b.t - a.t)
      .slice(0, 50)
      .map(toAuditEntry),
  };
}

// ---------------------------------------------------------------------------------------------
// Performance model assembly
// ---------------------------------------------------------------------------------------------

export function toPerformanceModel(
  procs: readonly ProcInfo[],
  history: ReadonlyMap<number, readonly number[]>,
  frame: FrameStats,
  stat: MemStat | null,
  budgetBytes: number,
  faultsPerSecond: number,
): PerformanceModel {
  const resident = procs.reduce((n, p) => n + p.residentBytes, 0);
  const memory: PerformanceModel['memory'] =
    stat === null
      ? { usedBytes: resident, totalBytes: budgetBytes }
      : {
          usedBytes: stat.accounted,
          totalBytes: stat.budget,
          segments: budgetSegments(stat).map((s) => s.bytes),
        };
  return {
    executors: toExecutorStats(procs, history),
    frame,
    memory,
    faultsPerSecond: Math.round(faultsPerSecond * 10) / 10,
  };
}
