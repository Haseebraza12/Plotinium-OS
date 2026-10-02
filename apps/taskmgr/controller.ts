/**
 * The Task Manager's live model (ui-design-system.md §3.8.13; PROC-08, MEM-07, PRE-06).
 *
 * Framework-free so it is testable against a fake system-call client: the view (view.tsx) drives
 * `start()`/`stop()`, feeds kernel event batches to `onEvents`, and renders every `snapshot()`.
 *
 * One refresh per second (the view's "Updated every 1 s"): `proc.list` (all pages), `mem.stat` and
 * `uptime`; every fifth refresh also `ai.predict`, `ai.index.status`, `ai.agent.log`, `statfs`,
 * `net.status` and `sysctl.get`. `proc.*` events bring the next refresh forward (at most 4 per
 * second). A call that answers ENOSYS or EPERM is not asked again for 30 s, and the panel it
 * feeds shows that state instead of stale or invented numbers.
 *
 * End Process sends `kill` and Renice sends `setpriority`: both are the app process's calls
 * (origin E), routed by the host (apps/src/descriptor.ts `AppSys`). A refusal is reported to the
 * user as a notification with the errno text, never swallowed.
 */
import type {
  ArgsIn,
  AuditRecord,
  Band,
  CallName,
  IndexStatus,
  KEvent,
  MemStat,
  NetStatus,
  ProcInfo,
  RetOf,
  SignalName,
  StatFs,
} from '@plotinium/protocol';
import type {
  AiModel,
  MemoryModel,
  PerformanceModel,
  PredictionsModel,
  ProcessRow,
  ProcessSummary,
  SchedulerModel,
} from '@plotinium/ui/apps/taskmgr';

import type { AppAgentBudget, AppFrameStats, AppSys, SysResult } from '../src/descriptor.ts';
import { trySys } from '../src/descriptor.ts';
import {
  DEFAULT_BUDGET_BYTES,
  DEFAULT_QUANTUM_MS,
  DEFAULT_SOFT_LIMIT_BYTES,
  DEFAULT_T_AGE_MS,
  EMPTY_FRAMES,
  EMPTY_MEMORY_HISTORY,
  executorLoad,
  executorsOf,
  faultRate,
  MEM_SAMPLES,
  type MemoryHistory,
  MIB,
  PERF_SAMPLES,
  type ProcSample,
  runnableCount,
  toAiModel,
  toMemoryModel,
  toPerformanceModel,
  toPredictionsModel,
  toProcessRow,
  toSchedulerModel,
  toSummary,
} from './model.ts';

export const REFRESH_MS = 1_000;
/** Slow facets (predictions, index, audit, storage, network, sysctl) every N refreshes. */
export const SLOW_EVERY = 5;
/** A call refused with ENOSYS/EPERM is not retried for this long. */
export const UNAVAILABLE_BACKOFF_MS = 30_000;
/** Earliest follow-up refresh after a `proc.*` event. */
export const EVENT_REFRESH_MS = 250;
const LATENCY_RING = 256;
/** 5 minutes of 1 s samples. */
const HIT_DELTA_SAMPLES = 300;
const RATE_WINDOW_MS = 5_000;

/** The topics the view subscribes to for this controller. */
export const TASKMGR_TOPICS: readonly string[] = [
  'proc.*',
  'mem.fault',
  'mem.evict',
  'mem.pressure',
  'ai.predict',
  'ai.index.progress',
];

export type ProcessSignal = Extract<SignalName, 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT'>;

export interface TaskManagerSnapshot {
  readonly processes: readonly ProcessRow[];
  readonly summary: ProcessSummary;
  readonly performance: PerformanceModel;
  readonly memory: MemoryModel;
  readonly predictions: PredictionsModel;
  readonly scheduler: SchedulerModel;
  readonly ai: AiModel;
  readonly isRoot: boolean;
  readonly pendingPid?: number;
  readonly reniceError?: string;
  readonly loading: boolean;
  readonly stale?: string;
  /** The last user-visible outcome of an action ("Sent SIGTERM to burn (pid 301)"). */
  readonly notice?: { readonly level: 'info' | 'error'; readonly text: string };
}

export interface TaskManagerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TaskManagerDeps {
  readonly sys: AppSys;
  readonly timers: TaskManagerTimers;
  readonly aiAvailable: boolean;
  /** Frame statistics (wm/src/frame-meter or the view's own sampler). */
  readonly frames?: () => AppFrameStats | null;
  /** The agent confirmation preference (Settings > Privacy & AI). */
  readonly requireConfirm?: () => boolean;
  /** Post user-visible outcomes as desktop notifications (`notify.post`). Default true. */
  readonly notify?: boolean;
  /** The AI agent's spending (AppEnv.agentBudget); read on the slow cadence. */
  readonly agentBudget?: () => Promise<AppAgentBudget | null>;
}

type Listener = (snap: TaskManagerSnapshot) => void;

/** A usable sysctl number: the kernel reports 0 for `mm.*` while the memory manager is down. */
function isSysctlNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function push(ring: number[], value: number, max: number): number[] {
  const next = [...ring, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

export class TaskManagerController {
  private readonly deps: TaskManagerDeps;
  private readonly listeners = new Set<Listener>();
  private readonly blockedUntil = new Map<CallName, number>();

  private procs: ProcInfo[] = [];
  private procError: string | undefined;
  private lastProcOk = 0;
  private prevProc = new Map<number, ProcSample>();
  private rows: ProcessRow[] = [];
  private stat: MemStat | null = null;
  private statError: string | undefined;
  private prevStat: { at: number; bytesIn: number; bytesOut: number; faults: number } | null = null;
  private statfs: StatFs | null = null;
  private net: NetStatus | null = null;
  private predict: SysResult<RetOf<'ai.predict'>> | null = null;
  private index: IndexStatus | null = null;
  private indexError: string | undefined;
  private prevIndex: { at: number; chunks: number } | null = null;
  private chunksPerSecond = 0;
  private audit: AuditRecord[] = [];
  private budget: AppAgentBudget | null = null;
  private sysctl: Readonly<Record<string, string | number | boolean>> = {};
  private uptimeMs = 0;
  private load1: number | null = null;
  private loadEma = 0;
  private cores = 0;
  private isRoot = false;
  private execHistory = new Map<number, number[]>();
  private memHistory: MemoryHistory = EMPTY_MEMORY_HISTORY;
  /** Hit-ratio samples over the last 5 minutes, for the delta against 5 minutes ago. */
  private hitLong: number[] = [];
  private faultRates: number[] = [];
  private readySince = new Map<number, number>();
  private maxWaitMs = 0;
  private dispatches: number[] = [];
  private preemptions: number[] = [];
  private latencies: number[] = [];
  private majorFaults = 0;
  private pagesOut = 0;
  private thrashingGuard = false;
  private overBudgetSince: number | null = null;
  private overBudgetMs = 0;
  private pendingPid: number | undefined;
  private reniceError: string | undefined;
  private notice: TaskManagerSnapshot['notice'];
  private loading = true;
  private refreshes = 0;
  /** An event asked for the slow facets (predictions) on the next refresh. */
  private slowDue = false;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private paused = false;
  private running = false;
  private snap: TaskManagerSnapshot;

  constructor(deps: TaskManagerDeps) {
    this.deps = deps;
    this.snap = this.build();
  }

  // -------------------------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------------------------

  snapshot(): TaskManagerSnapshot {
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Poll every REFRESH_MS until `stop()`; pausing keeps the last snapshot (WCAG 2.2.2). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && this.running) {
      this.clearTimer();
      void this.tick();
    }
  }

  /** One refresh (fast facets, plus the slow ones every SLOW_EVERY refreshes). */
  refresh(): Promise<void> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Kernel event batches pushed to the view. */
  onEvents(batch: readonly KEvent[]): void {
    const now = this.deps.timers.now();
    let soon = false;
    // Only the topics below matter here; the rest of the KEvent union is ignored.
    for (const ev of batch) {
      if (ev.topic === 'proc.state') {
        const d = ev.data;
        if (d.to === 'RUNNING' && d.from === 'READY') this.dispatches.push(now);
        if (d.from === 'RUNNING' && d.to === 'READY') this.preemptions.push(now);
        if (d.to === 'READY') {
          if (!this.readySince.has(d.pid)) this.readySince.set(d.pid, now);
        } else if (d.from === 'READY') {
          const since = this.readySince.get(d.pid);
          if (since !== undefined) this.maxWaitMs = Math.max(this.maxWaitMs, now - since);
          this.readySince.delete(d.pid);
        }
        soon = true;
      } else if (ev.topic === 'proc.spawn' || ev.topic === 'proc.exit') {
        soon = true;
      } else if (ev.topic === 'mem.fault') {
        this.latencies = push(this.latencies, ev.data.ms, LATENCY_RING);
        if (ev.data.tier === 'remote') this.majorFaults++;
      } else if (ev.topic === 'mem.evict') {
        if (ev.data.to !== 'drop') this.pagesOut++;
      } else if (ev.topic === 'mem.pressure') {
        this.thrashingGuard = ev.data.level === 'blocked';
      } else if (ev.topic === 'ai.predict') {
        this.slowDue = true;
        soon = true;
      }
    }
    this.trimRates(now);
    if (soon && this.running && !this.paused) this.bringForward();
  }

  /** End Process / Kill / Suspend (SIGSTOP) / Resume (SIGCONT). */
  async signal(pid: number, sig: ProcessSignal): Promise<boolean> {
    const name = this.rows.find((r) => r.pid === pid)?.name ?? `pid ${String(pid)}`;
    this.pendingPid = pid;
    this.emit();
    const res = await trySys(this.deps.sys, 'kill', { pid, sig });
    this.pendingPid = undefined;
    if (res.ok) {
      await this.say('info', `Sent ${sig} to ${name} (pid ${String(pid)})`, false);
      await this.refresh();
      return true;
    }
    await this.say(
      'error',
      `Could not send ${sig} to ${name} (pid ${String(pid)}): ${res.message}`,
      true,
    );
    return false;
  }

  /** Renice: `setpriority({pid, nice})`; raising priority (negative nice) needs root. */
  async renice(pid: number, nice: number): Promise<boolean> {
    this.reniceError = undefined;
    const res = await trySys(this.deps.sys, 'setpriority', { pid, nice });
    if (!res.ok) {
      this.reniceError =
        res.errno === 'EPERM' || res.errno === 'EACCES'
          ? 'Only root can raise priority (negative nice).'
          : `Renice failed: ${res.message}`;
      this.emit();
      return false;
    }
    await this.say('info', `pid ${String(pid)} now has nice ${String(res.value.nice)}`, false);
    await this.refresh();
    return true;
  }

  /** Manual reclaim has no system call yet (memory-and-paging.md requests mem.pageOut). */
  async reclaim(): Promise<void> {
    await this.say(
      'info',
      'Reclaim runs by itself above 85% of the budget. A manual reclaim needs the mem.pageOut call, which this kernel does not provide yet.',
      true,
    );
  }

  /** Pinning has no system call yet (memory-and-paging.md §4.2). */
  async pin(pid: number, pinned: boolean): Promise<void> {
    await this.say(
      'info',
      `Cannot ${pinned ? 'pin' : 'unpin'} pid ${String(pid)}: the kernel has no pin call yet.`,
      true,
    );
  }

  /** The Memory tab's "Restart predictor" (service restart is root-only, `svc.restart`). */
  async restartPredictor(): Promise<void> {
    const res = await trySys(this.deps.sys, 'svc.restart', { name: 'ai.predictor' });
    if (res.ok) {
      await this.say('info', 'Restarting ai.predictor', false);
      this.slowDue = true;
      await this.refresh();
      return;
    }
    await this.say('error', `Could not restart ai.predictor: ${res.message}`, true);
  }

  dismissNotice(): void {
    this.notice = undefined;
    this.emit();
  }

  // -------------------------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (!this.paused) await this.refresh();
    if (!this.running) return;
    this.clearTimer();
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, REFRESH_MS);
  }

  private bringForward(): void {
    if (this.inFlight !== null) return;
    this.clearTimer();
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, EVENT_REFRESH_MS);
  }

  /** Call unless it was refused recently; a refusal (ENOSYS, EPERM) blocks it for a while. */
  private async call<C extends CallName>(
    name: C,
    args: ArgsIn<C>,
  ): Promise<SysResult<RetOf<C>> | null> {
    const now = this.deps.timers.now();
    const until = this.blockedUntil.get(name);
    if (until !== undefined && now < until) return null;
    const res = await trySys(this.deps.sys, name, args);
    if (!res.ok && (res.errno === 'ENOSYS' || res.errno === 'EPERM'))
      this.blockedUntil.set(name, now + UNAVAILABLE_BACKOFF_MS);
    return res;
  }

  private async listAll(): Promise<SysResult<ProcInfo[]>> {
    const all: ProcInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const res = await trySys(this.deps.sys, 'proc.list', cursor === undefined ? {} : { cursor });
      if (!res.ok) return res;
      all.push(...res.value.procs);
      cursor = res.value.next;
      if (cursor === undefined) break;
    }
    return { ok: true, value: all };
  }

  private async doRefresh(): Promise<void> {
    const first = this.refreshes === 0;
    const slow = first || this.slowDue || this.refreshes % SLOW_EVERY === 0;
    this.slowDue = false;
    this.refreshes++;
    const { aiAvailable } = this.deps;

    const [procs, stat, up, cred, uname] = await Promise.all([
      this.listAll(),
      this.call('mem.stat', {}),
      this.call('uptime', {}),
      first ? this.call('proc.cred', {}) : Promise.resolve(null),
      first ? this.call('uname', {}) : Promise.resolve(null),
    ]);
    const [predict, index, agentLog, statfs, net, sysctl, budget] = slow
      ? await Promise.all([
          aiAvailable ? this.call('ai.predict', { k: 3 }) : Promise.resolve(null),
          aiAvailable ? this.call('ai.index.status', {}) : Promise.resolve(null),
          aiAvailable ? this.call('ai.agent.log', { limit: 50 }) : Promise.resolve(null),
          this.call('statfs', {}),
          this.call('net.status', {}),
          this.call('sysctl.get', {}),
          aiAvailable && this.deps.agentBudget !== undefined
            ? this.deps.agentBudget().catch(() => null)
            : Promise.resolve(null),
        ])
      : [undefined, undefined, undefined, undefined, undefined, undefined, undefined];

    const now = this.deps.timers.now();
    if (cred?.ok === true) this.isRoot = cred.value.uid === 0;
    if (uname?.ok === true) this.cores = uname.value.cores;
    if (up?.ok === true) {
      this.uptimeMs = up.value.uptimeMs;
      this.load1 = up.value.load[0];
    }

    if (procs.ok) {
      this.ingestProcs(procs.value, now);
      this.procError = undefined;
      this.lastProcOk = now;
    } else {
      this.procError = procs.message;
    }

    if (stat !== null) {
      if (stat.ok) {
        this.ingestStat(stat.value, now);
        this.statError = undefined;
      } else {
        this.stat = null;
        this.statError = `mem.stat: ${stat.message} · showing process totals`;
        this.ingestProcTotals(now);
      }
    } else if (this.stat === null) {
      this.ingestProcTotals(now);
    }

    if (predict !== undefined) this.predict = predict;
    if (index !== undefined && index !== null) {
      if (index.ok) {
        const chunks = index.value.chunks;
        if (this.prevIndex !== null && now > this.prevIndex.at)
          this.chunksPerSecond = Math.max(
            0,
            ((chunks - this.prevIndex.chunks) * 1000) / (now - this.prevIndex.at),
          );
        this.prevIndex = { at: now, chunks };
        this.index = index.value;
        this.indexError = undefined;
      } else {
        this.index = null;
        this.indexError = index.message;
      }
    }
    if (agentLog?.ok === true) this.audit = agentLog.value.records;
    if (statfs?.ok === true) this.statfs = statfs.value;
    if (net?.ok === true) this.net = net.value;
    if (sysctl?.ok === true) this.sysctl = sysctl.value.values;
    if (budget !== undefined && budget !== null) this.budget = budget;

    this.loading = false;
    this.emit();
  }

  private ingestProcs(procs: ProcInfo[], now: number): void {
    const next = new Map<number, ProcSample>();
    this.rows = procs.map((p) => toProcessRow(p, this.prevProc.get(p.pid), now));
    const rates = procs.map((p) => faultRate(p, this.prevProc.get(p.pid), now));
    for (const p of procs) next.set(p.pid, { faults: p.faults, at: now });
    this.prevProc = next;
    this.procs = procs;
    this.faultRates = rates;

    // READY waits: the event stream is exact; polling covers views without events.
    const ready = new Set<number>();
    for (const p of procs) {
      if (p.state !== 'READY') continue;
      ready.add(p.pid);
      if (!this.readySince.has(p.pid)) this.readySince.set(p.pid, now);
    }
    for (const [pid, since] of this.readySince) {
      if (ready.has(pid)) this.maxWaitMs = Math.max(this.maxWaitMs, now - since);
      else this.readySince.delete(pid);
    }

    const load = executorLoad(procs);
    const ids = new Set([...this.execHistory.keys(), ...load.keys()]);
    const hist = new Map<number, number[]>();
    for (const id of ids)
      hist.set(id, push(this.execHistory.get(id) ?? [], load.get(id)?.cpu ?? 0, PERF_SAMPLES));
    this.execHistory = hist;

    // Load average fallback: a 1-minute EMA of runnable processes, sampled each refresh.
    const alpha = 1 - Math.exp(-REFRESH_MS / 60_000);
    this.loadEma += alpha * (runnableCount(procs) - this.loadEma);
  }

  private ingestStat(stat: MemStat, now: number): void {
    const prev = this.prevStat;
    const dt = prev === null ? 0 : (now - prev.at) / 1000;
    const inRate =
      dt > 0 && prev !== null ? Math.max(0, stat.bytesIn - prev.bytesIn) / dt / MIB : 0;
    const outRate =
      dt > 0 && prev !== null ? Math.max(0, stat.bytesOut - prev.bytesOut) / dt / MIB : 0;
    this.memHistory = {
      faultRate: push([...this.memHistory.faultRate], stat.faultsPerSec, MEM_SAMPLES),
      hit: push([...this.memHistory.hit], stat.hitRatio * 100, MEM_SAMPLES),
      outRate: push([...this.memHistory.outRate], outRate, MEM_SAMPLES),
      inRate: push([...this.memHistory.inRate], inRate, MEM_SAMPLES),
    };
    this.hitLong = push(this.hitLong, stat.hitRatio * 100, HIT_DELTA_SAMPLES);
    this.prevStat = {
      at: now,
      bytesIn: stat.bytesIn,
      bytesOut: stat.bytesOut,
      faults: stat.faults,
    };
    this.stat = stat;
    this.trackBudget(stat.accounted, stat.budget, now);
  }

  /** Without mem.stat the charts follow the process totals from proc.list. */
  private ingestProcTotals(now: number): void {
    const fps = this.faultRates.reduce((n, r) => n + r, 0);
    const live = this.procs.filter((p) => p.state !== 'TERMINATED');
    const hit =
      live.length === 0 ? 100 : (live.reduce((n, p) => n + p.hitRatio, 0) / live.length) * 100;
    this.memHistory = {
      faultRate: push([...this.memHistory.faultRate], fps, MEM_SAMPLES),
      hit: push([...this.memHistory.hit], hit, MEM_SAMPLES),
      outRate: push([...this.memHistory.outRate], 0, MEM_SAMPLES),
      inRate: push([...this.memHistory.inRate], 0, MEM_SAMPLES),
    };
    this.hitLong = push(this.hitLong, hit, HIT_DELTA_SAMPLES);
    const resident = live.reduce((n, p) => n + p.residentBytes, 0);
    this.trackBudget(resident, this.budgetBytes(), now);
  }

  private trackBudget(accounted: number, budget: number, now: number): void {
    if (accounted > budget) {
      this.overBudgetSince ??= now;
      this.overBudgetMs = Math.max(this.overBudgetMs, now - this.overBudgetSince);
    } else {
      this.overBudgetSince = null;
    }
  }

  private trimRates(now: number): void {
    const from = now - RATE_WINDOW_MS;
    this.dispatches = this.dispatches.filter((t) => t >= from);
    this.preemptions = this.preemptions.filter((t) => t >= from);
  }

  // -------------------------------------------------------------------------------------------
  // Model assembly
  // -------------------------------------------------------------------------------------------

  private sysctlNumber(keys: readonly string[], scale: number, fallback: number): number {
    for (const key of keys) {
      const v = this.sysctl[key];
      if (isSysctlNumber(v)) return v * scale;
    }
    return fallback;
  }

  private budgetBytes(): number {
    return this.sysctlNumber(
      ['mm.budget'],
      1,
      this.sysctlNumber(['mm.budgetMB'], MIB, DEFAULT_BUDGET_BYTES),
    );
  }

  private quantum(): Record<Band, number> {
    const q = (band: Band): number =>
      this.sysctlNumber(
        [`sched.quantum.${band}`, `sched.quantumMs.${band}`],
        1,
        DEFAULT_QUANTUM_MS[band],
      );
    return { interactive: q('interactive'), normal: q('normal'), background: q('background') };
  }

  private frames(): AppFrameStats {
    return this.deps.frames?.() ?? EMPTY_FRAMES;
  }

  private build(): TaskManagerSnapshot {
    const now = this.deps.timers.now();
    const procs = this.procs;
    const executors = executorsOf(procs);
    // The pool's ceiling (hardware threads − 1); executors start on demand, so fewer may run.
    const executorsMax = Math.max(executors.length, this.cores > 1 ? this.cores - 1 : 0);
    const fps = this.stat?.faultsPerSec ?? this.faultRates.reduce((n, r) => n + r, 0);
    const budget = this.stat?.budget ?? this.budgetBytes();
    const memory = toMemoryModel({
      stat: this.stat,
      procs,
      statfs: this.statfs,
      net: this.net,
      history: this.memHistory,
      overBudgetMs: this.overBudgetMs,
      pageInLatencies: this.latencies,
      majorFaults: this.majorFaults,
      pagesOut: this.pagesOut,
      budgetBytes: budget,
      softLimitBytes: this.sysctlNumber(
        ['mm.softLimit'],
        1,
        this.sysctlNumber(['mm.softLimitMB'], MIB, DEFAULT_SOFT_LIMIT_BYTES),
      ),
      thrashingGuard: this.thrashingGuard,
      hitRatioDelta: (this.hitLong.at(-1) ?? 0) - (this.hitLong[0] ?? 0),
      ...(this.statError === undefined ? {} : { statError: this.statError }),
    });
    const windowS = RATE_WINDOW_MS / 1000;
    const snap: {
      -readonly [K in keyof TaskManagerSnapshot]: TaskManagerSnapshot[K];
    } = {
      processes: this.rows,
      summary: toSummary(procs, this.load1 ?? this.loadEma, this.uptimeMs, executorsMax),
      performance: toPerformanceModel(
        procs,
        this.execHistory,
        this.frames(),
        this.stat,
        budget,
        fps,
      ),
      memory,
      predictions: toPredictionsModel(
        this.predict,
        procs,
        this.stat?.speculative ?? 0,
        this.deps.aiAvailable,
      ),
      scheduler: toSchedulerModel({
        procs,
        quantumMs: this.quantum(),
        tAgeMs: this.sysctlNumber(['sched.tAge', 'sched.tAgeMs'], 1, DEFAULT_T_AGE_MS),
        readySince: this.readySince,
        now,
        executors,
        runTokens: Math.max(1, executorsMax),
        dispatchesPerSecond: this.dispatches.length / windowS,
        preemptionsPerSecond: this.preemptions.length / windowS,
        maxWaitMs: this.maxWaitMs,
      }),
      ai: toAiModel({
        aiAvailable: this.deps.aiAvailable,
        index: this.index,
        ...(this.indexError === undefined ? {} : { indexError: this.indexError }),
        chunksPerSecond: this.chunksPerSecond,
        procs,
        net: this.net,
        audit: this.audit,
        requireConfirm: this.deps.requireConfirm?.() ?? true,
        now,
        budget: this.budget,
      }),
      isRoot: this.isRoot,
      loading: this.loading,
    };
    if (this.pendingPid !== undefined) snap.pendingPid = this.pendingPid;
    if (this.reniceError !== undefined) snap.reniceError = this.reniceError;
    if (this.notice !== undefined) snap.notice = this.notice;
    if (this.procError !== undefined) {
      const age = this.lastProcOk === 0 ? null : Math.round((now - this.lastProcOk) / 1000);
      snap.stale =
        age === null
          ? `Cannot list processes: ${this.procError}`
          : `Kernel not responding · last update ${String(age)} s ago`;
    }
    return snap;
  }

  private emit(): void {
    this.snap = this.build();
    for (const fn of this.listeners) fn(this.snap);
  }

  private async say(level: 'info' | 'error', text: string, notify: boolean): Promise<void> {
    this.notice = { level, text };
    this.emit();
    if (!notify || this.deps.notify === false) return;
    await trySys(this.deps.sys, 'notify.post', {
      title: 'Task Manager',
      body: text.slice(0, 1_024),
      level: level === 'error' ? 'error' : 'info',
    });
  }
}
