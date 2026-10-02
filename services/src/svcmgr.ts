/**
 * The service manager `svcmgr` (boot-and-services.md §3.3–§3.6, §4.2, §5.2; SVC-01..SVC-04,
 * BOOT-03, BOOT-04, BOOT-07, BOOT-08, BOOT-11, BOOT-12).
 *
 * - build: validate V1–V9, then order and level the DAG (V10; `dsa/dag`, or the marked fallback);
 * - start: completion-driven Kahn: a service starts the moment its last requirement settles,
 *   with no barrier between levels; each start races `timeoutMs` on the kernel timer heap;
 * - a failed critical service halts the boot (recovery screen); a failed non-critical one goes
 *   FAILED → RETRY-WAIT with jittered exponential back-off; `start-degraded` dependents start as
 *   DEGRADED while a requirement is degraded;
 * - every transition is timed and reported (bootlog lines, `svc.*` events, progress);
 * - stop: the same algorithm on the reversed DAG, each stop raced against `stopTimeoutMs`.
 * No `setTimeout` anywhere: all timing is `KernelTimers`.
 */
import { BOOT_TARGET } from '@plotinium/protocol';

import { backoffDelay, seededRandom } from './backoff.ts';
import type { DagPlan } from './levels.ts';
import { DependencyCycle, FALLBACK_WARNING, planLevels } from './levels.ts';
import type { BootTarget } from './progress.ts';
import { targetClosure } from './progress.ts';
import type {
  BootProfile,
  KernelTimers,
  LogLevel,
  ManifestFile,
  ServiceContext,
  ServiceManifest,
  ServiceName,
  ServiceRegistry,
  ServiceState,
  ServiceStatus,
  StartResult,
} from './types.ts';
import type { Rule } from './validate.ts';
import { validateManifests } from './validate.ts';

/** The longest a service's code may take to download under `ctx.codeWait` (before scaling). */
export const CODE_WAIT_MAX_MS = 30_000;

export interface SvcEvent {
  readonly name: ServiceName;
  readonly state: ServiceState;
  /** ms since t0. */
  readonly at: number;
  readonly critical: boolean;
  readonly reason?: string;
  readonly label?: string;
  readonly retryAt?: number;
}

export interface BootLogLine {
  /** ms since t0. */
  readonly t: number;
  readonly sub: string;
  readonly level: LogLevel | 'panic';
  readonly msg: string;
}

export interface SvcPanic {
  readonly kind: 'cycle' | 'manifest' | 'critical';
  readonly text: string;
  readonly cycle?: readonly ServiceName[];
  readonly rule?: Rule;
  readonly file?: string;
  readonly service?: ServiceName;
}

export interface ServiceManagerOptions {
  readonly profile: BootProfile;
  readonly files: readonly ManifestFile[];
  readonly source: 'volume' | 'builtin';
  readonly registry: ServiceRegistry;
  readonly timers: KernelTimers;
  /** Back-off PRNG seed, per boot (tests fix it). */
  readonly seed?: number;
  /** Use dsa/dag (default: its IMPLEMENTED flag). */
  readonly useDag?: boolean;
  /**
   * Multiplies every start and stop timeout. 1 in release builds; the dev server passes a larger
   * value because it transforms each module on first request, which no manifest budgets for.
   */
  readonly timeoutScale?: number;
  /** A PCB for a starting service (kind `service`, ppid 1, uid 0); returns its pid. */
  readonly pidFor?: (m: ServiceManifest) => number;
  readonly onEvent?: (ev: SvcEvent) => void;
  readonly onLog?: (line: BootLogLine) => void;
  readonly onPanic?: (p: SvcPanic) => void;
  /** Stage 4 is over: nothing is starting and nothing pending can start. */
  readonly onSettled?: () => void;
}

export interface BuildOk {
  readonly ok: true;
  readonly plan: DagPlan;
  readonly target: BootTarget;
  /** Weights of A (the ancestor closure of the target) from the manifests in use. */
  readonly weights: Readonly<Record<ServiceName, number>>;
}

export type BuildResult = BuildOk | { readonly ok: false; readonly panic: SvcPanic };

interface Svc {
  readonly m: ServiceManifest;
  state: ServiceState;
  reason: string | null;
  level: number;
  attempts: number;
  nextRetryAt: number | null;
  startedAt: number | null;
  readyAt: number | null;
  userWaitMs: number;
  pid: number | null;
  timer: number | null;
  retryTimer: number | null;
  deadline: number | null;
  abort: AbortController;
  /** DEGRADED because a requirement is degraded (auto-upgrades), not by the service itself. */
  inheritedDegrade: boolean;
  readonly recoveredCbs: ((dep: ServiceName) => void)[];
  generation: number;
}

const DONE_STATES: ReadonlySet<ServiceState> = new Set(['running', 'degraded']);

export class ServiceManager {
  private readonly opts: ServiceManagerOptions;
  private readonly svcs = new Map<ServiceName, Svc>();
  private readonly dependents = new Map<ServiceName, ServiceName[]>();
  private readonly rand: () => number;
  private plan: DagPlan | null = null;
  private halted = false;
  private settledFired = false;
  private inBoot = new Set<ServiceName>();

  constructor(opts: ServiceManagerOptions) {
    this.opts = opts;
    this.rand = seededRandom(opts.seed ?? 0x5eed);
  }

  private now(): number {
    return this.opts.timers.now();
  }

  private log(sub: string, level: BootLogLine['level'], msg: string): void {
    this.opts.onLog?.({ t: this.now(), sub, level, msg });
  }

  get target(): BootTarget {
    return this.opts.profile === 'recovery' ? 'recovery' : 'desktop';
  }

  /** Validate (V1–V10), level, and prepare the start state. Panics are returned, not thrown. */
  build(): BuildResult {
    const implemented = new Set(this.opts.registry.keys());
    const v = validateManifests(this.opts.files, implemented);
    if (!v.ok) {
      const panic: SvcPanic = {
        kind: 'manifest',
        text: v.error.text,
        rule: v.error.rule,
        file: v.error.file,
      };
      this.log('svc', 'panic', panic.text);
      this.opts.onPanic?.(panic);
      return { ok: false, panic };
    }
    const manifests = v.manifests;
    const edges = manifests.reduce((n, m) => n + m.requires.length, 0);
    let plan: DagPlan;
    try {
      plan = planLevels(manifests, this.opts.useDag);
    } catch (e) {
      if (!(e instanceof DependencyCycle)) throw e;
      const panic: SvcPanic = { kind: 'cycle', text: e.message, cycle: e.cycle, rule: 'V10' };
      this.log(
        'svc',
        'info',
        `${String(manifests.length)} manifests (${this.opts.source}) · ${String(edges)} edges`,
      );
      this.log('svc', 'panic', panic.text);
      this.opts.onPanic?.(panic);
      return { ok: false, panic };
    }
    if (plan.source === 'fallback') this.log('svc', 'warn', FALLBACK_WARNING);
    this.log(
      'svc',
      'info',
      `${String(manifests.length)} manifests (${this.opts.source}) · ${String(plan.edges)} edges · acyclic · ${String(plan.levels.length)} levels`,
    );
    this.plan = plan;
    this.inBoot = targetClosure(manifests, this.target);
    const byName = new Map(manifests.map((m) => [m.name, m] as const));
    for (const name of plan.order) {
      const m = byName.get(name);
      if (!m) continue;
      this.svcs.set(name, {
        m,
        state: 'pending',
        reason: null,
        level: plan.levelOf.get(name) ?? 0,
        attempts: 0,
        nextRetryAt: null,
        startedAt: null,
        readyAt: null,
        userWaitMs: 0,
        pid: null,
        timer: null,
        retryTimer: null,
        deadline: null,
        abort: new AbortController(),
        inheritedDegrade: false,
        recoveredCbs: [],
        generation: 0,
      });
      for (const dep of m.requires) {
        const list = this.dependents.get(dep) ?? [];
        list.push(name);
        this.dependents.set(dep, list);
      }
    }
    this.applyProfile();
    const weights: Record<ServiceName, number> = {};
    for (const name of this.inBoot) {
      const s = this.svcs.get(name);
      if (s && s.state !== 'skipped') weights[name] = s.m.weight;
    }
    return { ok: true, plan, target: this.target, weights };
  }

  private applyProfile(): void {
    const { profile } = this.opts;
    for (const s of this.svcs.values()) {
      const keep = profile === 'normal' || (profile === 'safe' ? s.m.safeMode : s.m.recovery);
      if (!keep) this.setState(s, 'skipped', `skipped (${profile} mode)`);
    }
  }

  /** Begin completion-driven start. Call once after a successful build. */
  start(): void {
    if (!this.plan) throw new Error('svcmgr: build() must succeed before start()');
    for (const s of this.svcs.values()) if (s.state === 'pending') this.tryStart(s);
    this.checkSettled();
  }

  private emit(s: Svc, extra: { label?: string } = {}): void {
    this.opts.onEvent?.({
      name: s.m.name,
      state: s.state,
      at: this.now(),
      critical: s.m.critical,
      ...(s.reason === null ? {} : { reason: s.reason }),
      ...(s.nextRetryAt === null || s.state !== 'retry-wait' ? {} : { retryAt: s.nextRetryAt }),
      ...extra,
    });
  }

  private setState(s: Svc, state: ServiceState, reason: string | null = null): void {
    s.state = state;
    s.reason = reason;
    this.emit(s);
  }

  private context(s: Svc): ServiceContext {
    const gen = s.generation;
    const timers = this.opts.timers;
    return {
      name: s.m.name,
      profile: this.opts.profile,
      pid: s.pid ?? 0,
      timers,
      signal: s.abort.signal,
      log: (level, msg) => {
        this.log(s.m.name, level, msg);
      },
      label: (text) => {
        this.emit(s, { label: text.slice(0, 120) });
      },
      userWait: <T>(p: Promise<T>): Promise<T> => this.userWait(s, gen, p),
      codeWait: <T>(p: Promise<T>): Promise<T> => this.codeWait(s, gen, p),
      degraded: (reason) => {
        if (s.state !== 'running') return;
        s.inheritedDegrade = false;
        this.setState(s, 'degraded', reason);
        this.log(s.m.name, 'degraded', reason);
      },
      recovered: () => {
        this.recovered(s);
      },
      backoff: () => {
        s.attempts++;
        const delayMs = backoffDelay(s.attempts, this.rand());
        s.nextRetryAt = this.now() + delayMs;
        return { attempt: s.attempts, delayMs, retryAt: s.nextRetryAt };
      },
      depState: (dep) => this.svcs.get(dep)?.state ?? 'skipped',
      onDependencyRecovered: (cb) => {
        s.recoveredCbs.push(cb);
      },
    };
  }

  private get scale(): number {
    const k = this.opts.timeoutScale ?? 1;
    return Number.isFinite(k) && k > 0 ? k : 1;
  }

  private armTimeout(s: Svc, budgetMs: number): void {
    s.deadline = this.now() + budgetMs;
    const gen = s.generation;
    s.timer = this.opts.timers.at(
      s.deadline,
      () => {
        if (s.generation === gen && s.state === 'starting')
          this.failed(s, `timeout ${String(s.m.timeoutMs * this.scale)} ms`);
      },
      s.m.priority,
    );
  }

  private cancelTimeout(s: Svc): void {
    if (s.timer !== null) this.opts.timers.cancel(s.timer);
    s.timer = null;
  }

  private async userWait<T>(s: Svc, gen: number, p: Promise<T>): Promise<T> {
    if (!s.m.userWait || s.generation !== gen) return p;
    const remaining = Math.max(0, (s.deadline ?? this.now()) - this.now());
    this.cancelTimeout(s);
    const began = this.now();
    try {
      return await p;
    } finally {
      s.userWaitMs += this.now() - began;
      if (s.generation === gen && s.state === 'starting') this.armTimeout(s, remaining);
    }
  }

  /** `ctx.codeWait` (see ServiceContext): the budget pauses; the code download has its own cap. */
  private async codeWait<T>(s: Svc, gen: number, p: Promise<T>): Promise<T> {
    if (s.generation !== gen || s.state !== 'starting') return p;
    const remaining = Math.max(0, (s.deadline ?? this.now()) - this.now());
    this.cancelTimeout(s);
    const capMs = CODE_WAIT_MAX_MS * this.scale;
    const cap = this.opts.timers.at(
      this.now() + capMs,
      () => {
        if (s.generation === gen && s.state === 'starting')
          this.failed(s, `timeout: code not loaded in ${String(Math.round(capMs / 1_000))} s`);
      },
      s.m.priority,
    );
    try {
      return await p;
    } finally {
      this.opts.timers.cancel(cap);
      if (s.generation === gen && s.state === 'starting') this.armTimeout(s, remaining);
    }
  }

  private startService(s: Svc): void {
    if (this.halted || s.state === 'starting') return;
    const impl = this.opts.registry.get(s.m.name);
    if (!impl) return;
    s.generation++;
    s.abort = new AbortController();
    s.pid ??= this.opts.pidFor?.(s.m) ?? null;
    s.startedAt = this.now();
    s.nextRetryAt = null;
    this.setState(s, 'starting');
    this.armTimeout(s, s.m.timeoutMs * this.scale);
    const gen = s.generation;
    let started: Promise<StartResult>;
    try {
      started = impl.start(this.context(s));
    } catch (e) {
      started = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    started.then(
      (res) => {
        if (s.generation === gen && s.state === 'starting') this.settled(s, res);
      },
      (e: unknown) => {
        if (s.generation === gen && s.state === 'starting')
          this.failed(s, e instanceof Error ? e.message : String(e));
      },
    );
  }

  private settled(s: Svc, res: StartResult): void {
    this.cancelTimeout(s);
    s.readyAt = this.now();
    const degradedDep = s.m.requires.find((d) => this.svcs.get(d)?.state === 'degraded');
    if (res.status === 'degraded') {
      s.inheritedDegrade = false;
      this.setState(s, 'degraded', res.reason);
      this.log(s.m.name, 'degraded', res.reason);
    } else if (degradedDep !== undefined) {
      s.inheritedDegrade = true;
      this.setState(s, 'degraded', `requires ${degradedDep}`);
      this.log(s.m.name, 'degraded', `requires ${degradedDep}`);
    } else {
      this.setState(s, 'running');
      this.log(
        s.m.name,
        'info',
        `started in ${String(Math.round(s.readyAt - (s.startedAt ?? s.readyAt) - s.userWaitMs))} ms`,
      );
      // After a restart of a DEGRADED service (UI-075), dependents that only inherited it heal.
      this.healDependents(s, false);
    }
    if (s.attempts > 0 && res.status === 'running') s.attempts = 0;
    this.releaseDependents(s);
    this.checkSettled();
  }

  /**
   * Kahn's condition for `w`: every requirement has settled AND is usable (RUNNING, or DEGRADED
   * when `w` is `start-degraded`). Requirements that settled unusable (failed, retrying,
   * degraded under `wait`, skipped) block `w`; unsettled ones keep it pending.
   */
  private readiness(w: Svc): { ready: boolean; blockedBy: ServiceName[] } {
    const blockedBy: ServiceName[] = [];
    let unsettled = false;
    for (const dep of w.m.requires) {
      const st = this.svcs.get(dep)?.state ?? 'skipped';
      if (st === 'running' || (st === 'degraded' && w.m.onDegradedDependency === 'start-degraded'))
        continue;
      if (
        st === 'failed' ||
        st === 'retry-wait' ||
        st === 'degraded' ||
        st === 'skipped' ||
        st === 'stopped'
      )
        blockedBy.push(dep);
      else unsettled = true;
    }
    return { ready: !unsettled && blockedBy.length === 0, blockedBy };
  }

  private tryStart(w: Svc): void {
    if (w.state !== 'pending' && w.state !== 'blocked') return;
    const r = this.readiness(w);
    if (r.ready) {
      this.startService(w);
      return;
    }
    if (r.blockedBy.length > 0) {
      const reason = `blocked by ${r.blockedBy.join(', ')}`;
      if (w.state !== 'blocked' || w.reason !== reason) this.setState(w, 'blocked', reason);
    } else if (w.state === 'blocked') {
      this.setState(w, 'pending');
    }
  }

  /** A requirement changed state: re-evaluate each dependent that has not started. */
  private releaseDependents(s: Svc): void {
    for (const name of this.dependents.get(s.m.name) ?? []) {
      const w = this.svcs.get(name);
      if (w) this.tryStart(w);
    }
  }

  private failed(s: Svc, why: string): void {
    this.cancelTimeout(s);
    s.abort.abort();
    this.setState(s, 'failed', why);
    if (s.m.critical) {
      this.halted = true;
      const panic: SvcPanic = {
        kind: 'critical',
        text: `${s.m.name} failed: ${why}`,
        service: s.m.name,
      };
      this.log(s.m.name, 'fail', why);
      this.opts.onPanic?.(panic);
      return;
    }
    s.attempts++;
    const delay = backoffDelay(s.attempts, this.rand());
    s.nextRetryAt = this.now() + delay;
    this.log(
      s.m.name,
      'fail',
      `${why} · retry in ${(delay / 1_000).toFixed(1)} s (attempt ${String(s.attempts)})`,
    );
    this.setState(s, 'retry-wait', why);
    const gen = s.generation;
    s.retryTimer = this.opts.timers.at(s.nextRetryAt, () => {
      if (s.generation === gen && s.state === 'retry-wait') this.startService(s);
    });
    this.releaseDependents(s);
    this.checkSettled();
  }

  private recovered(s: Svc): void {
    if (s.state !== 'degraded') return;
    s.inheritedDegrade = false;
    this.setState(s, 'running');
    this.log(s.m.name, 'info', 'recovered');
    this.healDependents(s, true);
    this.releaseDependents(s);
  }

  /**
   * `s` is usable again: every dependent that was DEGRADED only through its requirements
   * recovers. `notifyAll`: every dependent hears `onDependencyRecovered` (a recovery); otherwise
   * only the healed ones (a restart that settled RUNNING, UI-075).
   */
  private healDependents(s: Svc, notifyAll: boolean): void {
    for (const name of this.dependents.get(s.m.name) ?? []) {
      const w = this.svcs.get(name);
      if (!w) continue;
      const heals =
        w.state === 'degraded' &&
        w.inheritedDegrade &&
        !w.m.requires.some((d) => this.svcs.get(d)?.state === 'degraded');
      if (notifyAll || heals) for (const cb of w.recoveredCbs) cb(s.m.name);
      if (heals) this.recovered(w);
    }
  }

  /** Recovery-screen "Retry" for a failed critical service, or `svc.restart`. */
  retry(name: ServiceName): boolean {
    const s = this.svcs.get(name);
    if (!s || (s.state !== 'failed' && s.state !== 'retry-wait')) return false;
    if (s.retryTimer !== null) this.opts.timers.cancel(s.retryTimer);
    s.retryTimer = null;
    this.halted = false;
    this.startService(s);
    return true;
  }

  /**
   * The desktop's "Retry now" (`svc.retry`, UI-075) and `svc.restart`. Always answers, with the
   * service whose state now changes:
   * - FAILED or RETRY-WAIT: started again now (`retry`);
   * - DEGRADED by its own start result: stopped with reason `retry` and started again, so its
   *   probe gets a fresh attempt (a service that cannot heal settles DEGRADED again, with its
   *   reason);
   * - DEGRADED only because a requirement is (`requires sync`): the requirement is retried;
   * - anything else (running, starting, pending, blocked, stopped, skipped): nothing to retry. Its
   *   current state is reported again, so a caller waiting for an `svc.*` event gets one.
   */
  retryNow(name: ServiceName): {
    readonly outcome: 'restarted' | 'unchanged' | 'unknown';
    readonly name: ServiceName;
  } {
    const s = this.svcs.get(name);
    if (s === undefined) return { outcome: 'unknown', name };
    if (s.state === 'failed' || s.state === 'retry-wait') {
      this.retry(name);
      return { outcome: 'restarted', name };
    }
    if (s.state === 'degraded' && s.inheritedDegrade) {
      const dep = s.m.requires.find((d) => this.svcs.get(d)?.state === 'degraded');
      if (dep !== undefined && dep !== name) return this.retryNow(dep);
    }
    if (s.state === 'degraded' && !s.inheritedDegrade && !this.halted) {
      this.restartDegraded(s);
      return { outcome: 'restarted', name };
    }
    this.emit(s);
    return { outcome: 'unchanged', name };
  }

  /** Stop a DEGRADED service (reason `retry`), then start it again once the stop settled. */
  private restartDegraded(s: Svc): void {
    const impl = this.opts.registry.get(s.m.name);
    s.abort.abort();
    const gen = ++s.generation;
    this.setState(s, 'stopping', 'retrying');
    const again = (): void => {
      if (s.generation !== gen || s.state !== 'stopping') return;
      this.opts.timers.cancel(timer);
      s.attempts = 0;
      this.startService(s);
    };
    const timer = this.opts.timers.at(
      this.now() + s.m.stopTimeoutMs * this.scale,
      again,
      s.m.priority,
    );
    if (impl === undefined) {
      again();
      return;
    }
    let p: Promise<void>;
    try {
      p = impl.stop(this.context(s), 'retry');
    } catch (e) {
      p = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    p.then(again, (e: unknown) => {
      this.log(s.m.name, 'warn', `stop failed: ${e instanceof Error ? e.message : String(e)}`);
      again();
    });
  }

  /** The router's `net.online`: network-dependent services retry at once, back-off reset. */
  netOnline(names: readonly ServiceName[] = ['auth', 'sync', 'ai.agent']): void {
    for (const name of names) {
      const s = this.svcs.get(name);
      if (s?.state !== 'retry-wait') continue;
      s.attempts = 0;
      this.retry(name);
    }
  }

  private checkSettled(): void {
    if (this.settledFired || this.halted) return;
    for (const s of this.svcs.values()) {
      if (s.state === 'starting') return;
      if ((s.state === 'pending' || s.state === 'blocked') && this.readiness(s).ready) return;
    }
    this.settledFired = true;
    this.opts.onSettled?.();
  }

  get isHalted(): boolean {
    return this.halted;
  }

  stateOf(name: ServiceName): ServiceState | undefined {
    return this.svcs.get(name)?.state;
  }

  status(): ServiceStatus[] {
    return [...this.svcs.values()].map((s) => ({
      name: s.m.name,
      pid: s.pid,
      level: s.level,
      critical: s.m.critical,
      weight: s.m.weight,
      state: s.state,
      reason: s.reason,
      attempts: s.attempts,
      nextRetryAt: s.state === 'retry-wait' ? s.nextRetryAt : null,
      startedAt: s.startedAt,
      readyAt: s.readyAt,
      inBootTarget: this.inBoot.has(s.m.name),
    }));
  }

  /** Per-service timings for the boot record (BOOT-11). */
  timings(): {
    name: ServiceName;
    level: number;
    critical: boolean;
    start: number | null;
    end: number | null;
    status: ServiceState;
    attempts: number;
    reason?: string;
    userWaitMs?: number;
  }[] {
    return [...this.svcs.values()].map((s) => ({
      name: s.m.name,
      level: s.level,
      critical: s.m.critical,
      start: s.startedAt,
      end: DONE_STATES.has(s.state) ? s.readyAt : null,
      status: s.state,
      attempts: s.attempts,
      ...(s.reason === null ? {} : { reason: s.reason }),
      ...(s.userWaitMs > 0 ? { userWaitMs: s.userWaitMs } : {}),
    }));
  }

  requiresMap(): Map<ServiceName, readonly ServiceName[]> {
    return new Map([...this.svcs.values()].map((s) => [s.m.name, s.m.requires] as const));
  }

  /**
   * Graceful stop (BOOT-12, INV-B6): reverse topological order, completion-driven: a service
   * stops once every dependent has stopped; each `stop()` races its `stopTimeoutMs`.
   */
  stop(reason: 'shutdown' | 'restart' = 'shutdown'): Promise<void> {
    const live = [...this.svcs.values()].filter(
      (s) => s.state !== 'skipped' && s.state !== 'stopped',
    );
    for (const s of live) {
      if (s.timer !== null) this.opts.timers.cancel(s.timer);
      if (s.retryTimer !== null) this.opts.timers.cancel(s.retryTimer);
      s.timer = null;
      s.retryTimer = null;
    }
    const liveNames = new Set(live.map((s) => s.m.name));
    const waitingStop = new Map<ServiceName, number>();
    for (const s of live) {
      waitingStop.set(
        s.m.name,
        (this.dependents.get(s.m.name) ?? []).filter((d) => liveNames.has(d)).length,
      );
    }
    return new Promise<void>((resolve) => {
      let remaining = live.length;
      if (remaining === 0) {
        resolve();
        return;
      }
      const finished = (s: Svc): void => {
        if (s.state === 'stopped') return;
        this.setState(s, 'stopped');
        remaining--;
        for (const dep of s.m.requires) {
          const n = (waitingStop.get(dep) ?? 0) - 1;
          waitingStop.set(dep, n);
          const d = this.svcs.get(dep);
          if (n === 0 && d && liveNames.has(dep)) stopOne(d);
        }
        if (remaining === 0) resolve();
      };
      const stopOne = (s: Svc): void => {
        this.setState(s, 'stopping');
        s.abort.abort();
        const impl = this.opts.registry.get(s.m.name);
        const gen = ++s.generation;
        const timer = this.opts.timers.at(this.now() + s.m.stopTimeoutMs * this.scale, () => {
          if (s.generation !== gen || s.state !== 'stopping') return;
          this.log(
            s.m.name,
            'warn',
            `stop timed out after ${String(s.m.stopTimeoutMs)} ms; forced`,
          );
          finished(s);
        });
        const done = (): void => {
          this.opts.timers.cancel(timer);
          if (s.generation === gen) finished(s);
        };
        if (!impl || s.state === 'failed') {
          done();
          return;
        }
        let p: Promise<void>;
        try {
          p = impl.stop(this.context(s), reason === 'shutdown' ? 'shutdown' : 'restart');
        } catch (e) {
          p = Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
        p.then(done, (e: unknown) => {
          this.log(s.m.name, 'warn', `stop failed: ${e instanceof Error ? e.message : String(e)}`);
          done();
        });
      };
      for (const s of live) if ((waitingStop.get(s.m.name) ?? 0) === 0) stopOne(s);
    });
  }
}

/** Boot target service name for a profile. */
export function bootTargetName(profile: BootProfile): ServiceName {
  return profile === 'recovery' ? 'vfs' : BOOT_TARGET;
}
