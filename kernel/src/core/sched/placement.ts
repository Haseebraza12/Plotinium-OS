/**
 * Executor pool and placement rules (specs/03-kernel/processes-and-scheduling.md §3.7.1, §3.13,
 * §3.14; KPS-05, KPS-06; syscall-abi.md §3.2.1 placement invariant ARC-05).
 *
 * The pool is a model of the executor workers: which index is alive, which isolation key it is
 * bound to, who is resident, and whether it still accepts residents. It decides; the kernel host
 * performs the worker operations (spawn, bind, terminate) that a decision names.
 *
 * Rules applied in order when a process is admitted, paged in, restored or migrated (§3.14):
 *   1. Isolation (MUST): only executors bound to the process's key, or the unbound spare.
 *   2. Exclusive (MUST): an executor hosting an `exclusive` process accepts no other; an exclusive
 *      process needs an empty executor.
 *   3. Focused process: see `focus()`.
 *   4. Least loaded: fewest runnable residents, then fewest residents, then lowest index.
 *   5. Grow: if the chosen executor already has a runnable resident, fewer than MAX_EXECUTORS
 *      exist and desktop-interactive has passed, use a new executor for the key instead.
 *   6. Exhausted: no executor of the key and all MAX_EXECUTORS bound → terminate an empty bound
 *      executor of another key and use a fresh one; none empty → EAGAIN `executors-exhausted`.
 *   7. Sleepers: any number of BLOCKED residents may share an executor (PROC-09).
 *
 * An executor is bound to one key when its first process is placed and never re-bound (§3.7.1):
 * reuse of an index for another key always goes through terminate + a fresh worker (`generation`).
 */
import { EXEC_IDLE_REAP_MS, MAX_EXECUTORS, OVERRUNS_BEFORE_EXCLUSIVE } from './params.ts';
import type { ExecutorInfo, SchedulableProcess } from './types.ts';

export type ExecutorState = 'absent' | 'spare' | 'bound';

export interface ExecutorSlot {
  readonly index: number;
  state: ExecutorState;
  /** Isolation key once bound; null for absent and spare executors. */
  isolation: string | null;
  readonly residents: Set<number>;
  /** Hosts an exclusive process: accepts no other resident (rule 2). */
  exclusive: boolean;
  /** Stopped accepting new residents (non-checkpointable second overrunner, rule 2). */
  closed: boolean;
  /** Incremented every time a new worker occupies this index (a fresh realm). */
  generation: number;
  spawnedAt: number;
  terminations: number;
  /** When the last resident left (for EXEC_IDLE_REAP_MS), or null while occupied. */
  emptySince: number | null;
}

export interface PlacementRequest {
  readonly pid: number;
  readonly isolation: string;
  readonly exclusive: boolean;
  /** Executor to leave out (the source of a migration). */
  readonly exclude?: number;
}

export type PlacementDecision =
  | { readonly kind: 'existing'; readonly index: number }
  | { readonly kind: 'bind-spare'; readonly index: number }
  | { readonly kind: 'spawn'; readonly index: number }
  | { readonly kind: 'recycle'; readonly index: number; readonly evicted: string }
  | { readonly kind: 'fail'; readonly errno: 'EAGAIN'; readonly reason: 'executors-exhausted' };

/** What the second overrun of a process leads to (§3.14 rule 2). */
export type OverrunAction =
  | { readonly kind: 'none' }
  /** Already alone on its executor: the executor is now exclusive. */
  | { readonly kind: 'isolated-in-place'; readonly index: number }
  /** Checkpointable: migrate to `to` at its next yield point (then call `move`). */
  | { readonly kind: 'migrate'; readonly from: number; readonly to: PlacementDecision }
  /** Non-checkpointable (or nowhere to go): stays; its executor accepts no new residents. */
  | { readonly kind: 'closed'; readonly index: number };

export type FocusAction =
  | { readonly kind: 'stay' }
  | { readonly kind: 'migrate'; readonly from: number; readonly to: PlacementDecision };

export interface PoolOptions {
  readonly maxExecutors?: number;
  /** READY or RUNNING (runnable residents count for rules 4 and 5). */
  readonly isRunnable: (pid: number) => boolean;
}

export class ExecutorPool {
  private readonly all: ExecutorSlot[] = [];
  private readonly home = new Map<number, number>();
  private readonly isRunnable: (pid: number) => boolean;
  readonly maxExecutors: number;

  constructor(opts: PoolOptions) {
    this.maxExecutors = opts.maxExecutors ?? MAX_EXECUTORS;
    if (!Number.isInteger(this.maxExecutors) || this.maxExecutors < 1) {
      throw new RangeError('maxExecutors must be an integer ≥ 1');
    }
    this.isRunnable = opts.isRunnable;
    for (let index = 0; index < this.maxExecutors; index++) {
      this.all.push({
        index,
        state: 'absent',
        isolation: null,
        residents: new Set(),
        exclusive: false,
        closed: false,
        generation: 0,
        spawnedAt: 0,
        terminations: 0,
        emptySince: null,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------------------------

  slot(index: number): ExecutorSlot {
    const s = this.all[index];
    if (s === undefined) throw new RangeError(`no executor slot ${String(index)}`);
    return s;
  }

  slots(): readonly ExecutorSlot[] {
    return this.all;
  }

  /** Executors with a live worker (bound or spare). */
  get alive(): number {
    let n = 0;
    for (const s of this.all) if (s.state !== 'absent') n++;
    return n;
  }

  get spareIndex(): number | null {
    for (const s of this.all) if (s.state === 'spare') return s.index;
    return null;
  }

  /** Home executor of a resident process. */
  homeOf(pid: number): number | null {
    return this.home.get(pid) ?? null;
  }

  runnableCount(index: number): number {
    let n = 0;
    for (const pid of this.slot(index).residents) if (this.isRunnable(pid)) n++;
    return n;
  }

  /** §4.2 ExecutorInfo rows (`sched`, `sched.info`). */
  info(runningPid: (index: number) => number | null): ExecutorInfo[] {
    return this.all
      .filter((s) => s.state !== 'absent')
      .map((s) => ({
        index: s.index,
        isolation: s.state === 'spare' ? 'spare' : (s.isolation ?? 'spare'),
        residents: s.residents.size,
        runnable: this.runnableCount(s.index),
        runningPid: runningPid(s.index),
        exclusive: s.exclusive || s.closed,
        spawnedAt: s.spawnedAt,
        terminations: s.terminations,
      }));
  }

  // -------------------------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------------------------

  /** Boot stage 3: executor #1 (index 0) starts unbound; it binds on its first placement. */
  startFirst(now: number): number {
    const s = this.slot(0);
    if (s.state === 'absent') this.occupy(s, 'spare', null, now);
    return 0;
  }

  /** Whether the kernel should start a warm unbound spare (after desktop-interactive, §3.7.1). */
  needsSpare(desktopInteractive: boolean): boolean {
    return desktopInteractive && this.spareIndex === null && this.alive < this.maxExecutors;
  }

  /** Start the spare at the lowest free index; null when the pool is full or a spare exists. */
  spawnSpare(now: number): number | null {
    if (this.spareIndex !== null) return null;
    const s = this.all.find((x) => x.state === 'absent');
    if (s === undefined) return null;
    this.occupy(s, 'spare', null, now);
    return s.index;
  }

  /**
   * Bind the spare (or an unbound executor) to a key. Throws if the executor is already bound to
   * another key: executors are never re-bound (§3.7.1, KPS-06).
   */
  bind(index: number, isolation: string): void {
    const s = this.slot(index);
    if (s.state === 'bound') {
      if (s.isolation !== isolation) {
        throw new Error(
          `executor ${String(index)} is bound to ${String(s.isolation)} and is never re-bound`,
        );
      }
      return;
    }
    if (s.state === 'absent') throw new Error(`executor ${String(index)} has no worker`);
    s.state = 'bound';
    s.isolation = isolation;
  }

  /**
   * The worker at `index` is gone (watchdog, crash, identity mismatch, reap). Returns the pids that
   * were resident; the caller restores or terminates them (§3.15.3) and clears their `worker`.
   */
  terminate(index: number): number[] {
    const s = this.slot(index);
    const residents = [...s.residents];
    for (const pid of residents) this.home.delete(pid);
    s.residents.clear();
    if (s.state !== 'absent') s.terminations++;
    s.state = 'absent';
    s.isolation = null;
    s.exclusive = false;
    s.closed = false;
    s.emptySince = null;
    return residents;
  }

  /** After a watchdog termination: a fresh executor for the same key at the same index. */
  respawn(index: number, isolation: string, now: number): void {
    const s = this.slot(index);
    if (s.state !== 'absent') throw new Error(`executor ${String(index)} is still alive`);
    this.occupy(s, 'bound', isolation, now);
  }

  /** Bound executors that have been empty for EXEC_IDLE_REAP_MS (the kernel terminates them). */
  reapable(now: number, idleMs = EXEC_IDLE_REAP_MS): number[] {
    return this.all
      .filter(
        (s) =>
          s.state === 'bound' &&
          s.residents.size === 0 &&
          s.emptySince !== null &&
          now - s.emptySince >= idleMs,
      )
      .map((s) => s.index);
  }

  // -------------------------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------------------------

  /** Decide where a process goes (rules 1, 2, 4, 5, 6). Pure: changes nothing. */
  decide(req: PlacementRequest, desktopInteractive: boolean): PlacementDecision {
    const candidates = this.all.filter((s) => this.accepts(s, req));
    if (candidates.length > 0) {
      let chosen = candidates[0];
      let chosenRunnable = chosen === undefined ? 0 : this.runnableCount(chosen.index);
      for (const s of candidates) {
        const r = this.runnableCount(s.index);
        if (
          chosen === undefined ||
          r < chosenRunnable ||
          (r === chosenRunnable && s.residents.size < chosen.residents.size)
        ) {
          chosen = s;
          chosenRunnable = r;
        }
      }
      /* v8 ignore next -- candidates is non-empty */
      if (chosen === undefined)
        return { kind: 'fail', errno: 'EAGAIN', reason: 'executors-exhausted' };
      if (chosenRunnable > 0 && desktopInteractive && this.alive < this.maxExecutors) {
        return this.growDecision();
      }
      return { kind: 'existing', index: chosen.index };
    }
    // No executor of the key accepts: isolation wins even before desktop-interactive (§3.7.1).
    const spare = this.spareIndex;
    if (spare !== null) return { kind: 'bind-spare', index: spare };
    const free = this.all.find((s) => s.state === 'absent');
    if (free !== undefined) return { kind: 'spawn', index: free.index };
    const empty = this.all.find(
      (s) => s.state === 'bound' && s.residents.size === 0 && s.index !== req.exclude,
    );
    if (empty !== undefined)
      return { kind: 'recycle', index: empty.index, evicted: empty.isolation ?? '' };
    return { kind: 'fail', errno: 'EAGAIN', reason: 'executors-exhausted' };
  }

  /** Apply a decision for `req`; returns the executor index, or null for a failed decision. */
  commit(decision: PlacementDecision, req: PlacementRequest, now: number): number | null {
    if (decision.kind === 'fail') return null;
    const s = this.slot(decision.index);
    switch (decision.kind) {
      case 'existing':
        if (s.state !== 'bound' || s.isolation !== req.isolation) {
          throw new Error(`executor ${String(s.index)} is not bound to ${req.isolation}`);
        }
        break;
      case 'bind-spare':
        this.bind(s.index, req.isolation);
        break;
      case 'spawn':
        if (s.state !== 'absent') throw new Error(`executor ${String(s.index)} is already alive`);
        this.occupy(s, 'bound', req.isolation, now);
        break;
      case 'recycle':
        if (s.residents.size > 0) throw new Error(`executor ${String(s.index)} is not empty`);
        this.terminate(s.index);
        this.occupy(s, 'bound', req.isolation, now);
        break;
    }
    const previous = this.home.get(req.pid);
    if (previous !== undefined && previous !== s.index) this.removeResident(req.pid, now);
    s.residents.add(req.pid);
    s.emptySince = null;
    this.home.set(req.pid, s.index);
    if (req.exclusive) s.exclusive = true;
    return s.index;
  }

  /** decide + commit for a PCB; sets `p.worker`. Returns the decision (check `kind`). */
  placeProcess(p: SchedulableProcess, now: number, desktopInteractive: boolean): PlacementDecision {
    const req: PlacementRequest = { pid: p.pid, isolation: p.isolation, exclusive: p.exclusive };
    const decision = this.decide(req, desktopInteractive);
    const index = this.commit(decision, req, now);
    if (index !== null) p.worker = index;
    return decision;
  }

  /** Complete a migration decided by `onOverrun` or `focus` (the checkpoint was taken). */
  move(p: SchedulableProcess, to: PlacementDecision, now: number): number | null {
    const index = this.commit(
      to,
      { pid: p.pid, isolation: p.isolation, exclusive: p.exclusive },
      now,
    );
    if (index !== null) p.worker = index;
    return index;
  }

  /** The residency slot is freed (exit, kill, page-out, migration source). */
  removeResident(pid: number, now: number): number | null {
    const index = this.home.get(pid);
    if (index === undefined) return null;
    const s = this.slot(index);
    s.residents.delete(pid);
    this.home.delete(pid);
    if (s.residents.size === 0) {
      s.emptySince = now;
      // The exclusive (or overrunning) process left: the realm may take residents of its key again.
      s.exclusive = false;
      s.closed = false;
    }
    return index;
  }

  /** `removeResident` for a PCB; clears `p.worker`. */
  evict(p: SchedulableProcess, now: number): number | null {
    const index = this.removeResident(p.pid, now);
    p.worker = null;
    return index;
  }

  // -------------------------------------------------------------------------------------------
  // Rule 2 (second overrun) and rule 3 (focus)
  // -------------------------------------------------------------------------------------------

  /**
   * Called after an overrun was counted. On the second overrun the process becomes exclusive
   * (the caller sets `p.exclusive = true` when the action is not 'none').
   */
  onOverrun(p: SchedulableProcess, desktopInteractive: boolean): OverrunAction {
    if (p.overruns < OVERRUNS_BEFORE_EXCLUSIVE) return { kind: 'none' };
    const index = this.homeOf(p.pid);
    if (index === null) return { kind: 'none' };
    const s = this.slot(index);
    if (s.exclusive) return { kind: 'none' };
    if (s.residents.size === 1) {
      s.exclusive = true;
      return { kind: 'isolated-in-place', index };
    }
    if (p.checkpointable) {
      const to = this.decide(
        { pid: p.pid, isolation: p.isolation, exclusive: true, exclude: index },
        desktopInteractive,
      );
      if (to.kind !== 'fail') return { kind: 'migrate', from: index, to };
    }
    s.closed = true;
    return { kind: 'closed', index };
  }

  /**
   * Rule 3: on focus, if the focused process shares its executor with another runnable process
   * and a less-loaded executor of the same key exists (or can be started), migrate it there at its
   * next yield point, if it is checkpointable.
   */
  focus(p: SchedulableProcess, desktopInteractive: boolean): FocusAction {
    const index = this.homeOf(p.pid);
    if (index === null || !p.checkpointable) return { kind: 'stay' };
    const here = this.runnableCount(index) - (this.isRunnable(p.pid) ? 1 : 0);
    if (here <= 0) return { kind: 'stay' };
    const req: PlacementRequest = {
      pid: p.pid,
      isolation: p.isolation,
      exclusive: false,
      exclude: index,
    };
    let best: ExecutorSlot | undefined;
    let bestRunnable = Number.POSITIVE_INFINITY;
    for (const s of this.all) {
      if (!this.accepts(s, req)) continue;
      const r = this.runnableCount(s.index);
      if (r < bestRunnable) {
        best = s;
        bestRunnable = r;
      }
    }
    if (best !== undefined && bestRunnable < here) {
      return { kind: 'migrate', from: index, to: { kind: 'existing', index: best.index } };
    }
    if (desktopInteractive && this.alive < this.maxExecutors) {
      return { kind: 'migrate', from: index, to: this.growDecision() };
    }
    return { kind: 'stay' };
  }

  // -------------------------------------------------------------------------------------------

  private accepts(s: ExecutorSlot, req: PlacementRequest): boolean {
    if (s.state !== 'bound' || s.isolation !== req.isolation) return false;
    if (s.index === req.exclude || s.exclusive || s.closed) return false;
    return !req.exclusive || s.residents.size === 0;
  }

  private growDecision(): PlacementDecision {
    const spare = this.spareIndex;
    if (spare !== null) return { kind: 'bind-spare', index: spare };
    const free = this.all.find((s) => s.state === 'absent');
    /* v8 ignore next -- callers check alive < maxExecutors, so a free index exists */
    if (free === undefined) return { kind: 'fail', errno: 'EAGAIN', reason: 'executors-exhausted' };
    return { kind: 'spawn', index: free.index };
  }

  private occupy(
    s: ExecutorSlot,
    state: 'spare' | 'bound',
    isolation: string | null,
    now: number,
  ): void {
    s.state = state;
    s.isolation = isolation;
    s.generation++;
    s.spawnedAt = now;
    s.exclusive = false;
    s.closed = false;
    s.emptySince = now;
  }
}
