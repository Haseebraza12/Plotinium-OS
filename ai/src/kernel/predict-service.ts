/**
 * Subsystem C in the kernel: the telemetry tap and per-uid rings, the published predictions, the
 * pre-fetch policy behind `SchedulerHints`, and residency hints (predictive-prefetch.md §3.1–§3.8;
 * PRE-01, PRE-04, PRE-05, PRE-06; AIN-C1..C4).
 *
 * - SEES: the tap reads the kernel's own `wm.*` events (a first window of a process is an app
 *   launch, `wm.focus` coalesced to one per second and only on change, the last window closing is
 *   `close`). Events hold app ids and times only (I-C6). Launches of `prefetch:*` jobs never
 *   reach the tap: those jobs open no window (I-C2).
 * - ACTS: `ai.predictor` (an executor process) reads the ring with `ai.telemetry.read`, learns,
 *   and publishes with `ai.predict.publish`; this service stores the set, emits `ai.predict`, and
 *   runs the policy.
 * - SCHEDULED: the policy spawns `prefetch:<app>` at PRI 39 through the injected `spawnPrefetch`,
 *   only when `decidePrefetch` says so (idle ≥ 2 s, confidence ≥ θ, free memory, one job).
 * - INFORMS: `residencyHint()` names the top-1 app for 60 s after a confident publish.
 * Nothing leaves the device (PRE-05): opt-in is recorded locally and reported `synced: false`
 * until the server consent route is wired.
 */
import { RingBuffer } from '@plotinium/dsa/ringbuffer';
import type { KEvent, Prediction, PredictModel, TelemetryEvent } from '@plotinium/protocol';
import { TELEMETRY_RING_SIZE } from '@plotinium/protocol';

import {
  HINT_MS,
  type PrefetchDecision,
  type PrefetchInputs,
  THETA_DEFAULT,
  decidePrefetch,
} from '../predictor/prefetch.ts';
import { TelemetryRing, makeEvent } from '../predictor/telemetry.ts';
import type { RingFactory } from '../util/deps.ts';

export const FOCUS_COALESCE_MS = 1_000;

export const dsaRing: RingFactory = <T>(capacity: number) => new RingBuffer<T>(capacity);

export interface TelemetryDeps {
  now(): number;
  epochMs(): number;
  /** Local UTC offset in minutes at `epochMs` (east positive). */
  tzOffsetMin(epochMs: number): number;
  /** The login uid of a process (the tap records per login uid, I-C7). */
  uidOf(pid: number): number | undefined;
  osSessionId(): string;
  readonly ring?: RingFactory;
}

interface UidState {
  ring: TelemetryRing;
  seq: number;
  session: string;
  sessionPos: number;
  prev: string | null;
  lastFocus: { app: string; at: number } | null;
  windows: Map<string, number>;
  optIn: boolean;
}

export class TelemetryService {
  private readonly deps: TelemetryDeps;
  private readonly uids = new Map<number, UidState>();
  private readonly launchedPids = new Set<number>();
  private readonly waiters = new Set<() => void>();

  constructor(deps: TelemetryDeps) {
    this.deps = deps;
  }

  private state(uid: number): UidState {
    let s = this.uids.get(uid);
    if (s === undefined) {
      s = {
        ring: new TelemetryRing(this.deps.ring ?? dsaRing, TELEMETRY_RING_SIZE),
        seq: 0,
        session: '',
        sessionPos: 0,
        prev: null,
        lastFocus: null,
        windows: new Map(),
        optIn: false,
      };
      this.uids.set(uid, s);
    }
    return s;
  }

  private record(
    uid: number,
    kind: 'launch' | 'focus' | 'close',
    app: string,
    origin: 'user' | 'restore',
  ): boolean {
    const s = this.state(uid);
    const session = this.deps.osSessionId();
    if (session !== s.session) {
      s.session = session;
      s.sessionPos = 0;
      s.prev = null;
    }
    const ts = Math.floor(this.deps.epochMs());
    if (kind === 'launch') s.sessionPos++;
    const e = makeEvent({
      seq: ++s.seq,
      ts,
      tzOffsetMin: this.deps.tzOffsetMin(ts),
      kind,
      app,
      prev: s.prev,
      sessionPos: Math.max(1, s.sessionPos),
      origin,
      osSessionId: session,
    });
    const stored = s.ring.record(e);
    if (stored && kind === 'launch') s.prev = app;
    if (stored) for (const w of [...this.waiters]) w();
    return stored;
  }

  /** A user launch (or a session-restore relaunch, recorded but never trained on). */
  launch(uid: number, app: string, origin: 'user' | 'restore' = 'user'): boolean {
    return this.record(uid, 'launch', app, origin);
  }

  /** The kernel event tap (subscribe to `wm.*` as root and pass every event here). */
  tap(ev: KEvent): void {
    if (ev.topic !== 'wm.create' && ev.topic !== 'wm.focus' && ev.topic !== 'wm.close') return;
    const { pid, app } = ev.data;
    const uid = this.deps.uidOf(pid);
    if (uid === undefined) return;
    const s = this.state(uid);
    switch (ev.topic) {
      case 'wm.create':
        s.windows.set(app, (s.windows.get(app) ?? 0) + 1);
        if (!this.launchedPids.has(pid)) {
          this.launchedPids.add(pid);
          this.launch(uid, app);
        }
        return;
      case 'wm.focus': {
        const now = this.deps.now();
        if (
          s.lastFocus !== null &&
          (s.lastFocus.app === app || now - s.lastFocus.at < FOCUS_COALESCE_MS)
        )
          return;
        s.lastFocus = { app, at: now };
        this.record(uid, 'focus', app, 'user');
        return;
      }
      case 'wm.close': {
        const left = (s.windows.get(app) ?? 1) - 1;
        if (left > 0) {
          s.windows.set(app, left);
          return;
        }
        s.windows.delete(app);
        this.launchedPids.delete(pid);
        this.record(uid, 'close', app, 'user');
        return;
      }
    }
  }

  /** Apps with an open window for `uid` (pre-fetching an open app is pointless). */
  running(uid: number): ReadonlySet<string> {
    return new Set(this.state(uid).windows.keys());
  }

  read(uid: number, since?: number, limit?: number): { events: TelemetryEvent[]; next?: number } {
    return this.state(uid).ring.read(since ?? -1, limit ?? TELEMETRY_RING_SIZE);
  }

  clear(uid: number): number {
    const s = this.state(uid);
    s.prev = null;
    s.sessionPos = 0;
    return s.ring.clear();
  }

  exportJsonl(uid: number): string {
    return this.state(uid).ring.exportJsonl();
  }

  optIn(uid: number, on: boolean): { on: boolean; synced: boolean } {
    const s = this.state(uid);
    s.optIn = on;
    return { on, synced: false };
  }

  /** Resolves on the next recorded event (or at once when `after` is already behind). */
  onEvent(cb: () => void): () => void {
    this.waiters.add(cb);
    return () => this.waiters.delete(cb);
  }
}

// ---------------------------------------------------------------------------------------------
// Predictions and the pre-fetch policy
// ---------------------------------------------------------------------------------------------

export interface MemoryFacts {
  budgetBytes: number;
  accountedBytes: number;
  reservedBytes: number;
  reclaimRunning: boolean;
  thrashing: boolean;
}

export interface PredictDeps {
  now(): number;
  epochMs(): number;
  /** `ai.predict` event (visible to the same uid only). */
  publish(uid: number, predictions: ReadonlyArray<{ app: string; confidence: number }>): void;
  /** The login uid of the desktop session (idle evaluation), or undefined before login. */
  sessionUid(): number | undefined;
  running(uid: number): ReadonlySet<string>;
  /** Mm facts for PRE-04; undefined = unknown, and the policy then never starts a job. */
  memory?(): MemoryFacts | undefined;
  /** Declared bytes of an app (code + last state + ≤ 8 MiB of files). */
  declaredBytes?(app: string): number;
  /** Spawn `prefetch:<app>` at PRI 39 as `uid`; resolves when it exits (`wasted` if unused). */
  readonly spawnPrefetch?: (app: string, uid: number) => Promise<{ wasted: boolean }>;
  readonly safeMode?: boolean;
  readonly theta?: number;
  log?(msg: string): void;
}

interface Published {
  predictions: Prediction[];
  model: PredictModel;
  launches: number;
  updatedAt: number;
}

export class PredictService {
  private readonly deps: PredictDeps;
  private readonly sets = new Map<number, Published>();
  private enabled = true;
  private jobAlive = false;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private gesture = false;
  private interactiveBusy = false;
  private readonly wasted = new Map<string, number>();
  private hint: { app: string; until: number } | null = null;
  lastDecision: PrefetchDecision | null = null;

  constructor(deps: PredictDeps) {
    this.deps = deps;
  }

  get theta(): number {
    return this.deps.theta ?? THETA_DEFAULT;
  }

  /** Settings → Privacy "Pre-fetch applications" (on by default). */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Router input / gesture / interactive-band facts (the idle rule of §3.5 condition 3). */
  noteInput(at: number = this.deps.now()): void {
    this.lastInputAt = at;
  }

  noteActivity(facts: { gesture?: boolean; interactiveBusy?: boolean }): void {
    if (facts.gesture !== undefined) this.gesture = facts.gesture;
    if (facts.interactiveBusy !== undefined) this.interactiveBusy = facts.interactiveBusy;
  }

  /** `ai.predict.publish` from `ai.predictor` (cap ai.predict). */
  publish(
    uid: number,
    set: { predictions: Prediction[]; model: PredictModel; launches: number },
  ): void {
    const updatedAt = Math.floor(this.deps.epochMs());
    this.sets.set(uid, { ...set, updatedAt });
    this.deps.publish(
      uid,
      set.predictions.map((p) => ({ app: p.app, confidence: p.confidence })),
    );
    const top = set.predictions[0];
    this.hint =
      top !== undefined && top.confidence >= this.theta
        ? { app: top.app, until: this.deps.now() + HINT_MS }
        : this.hint;
    this.evaluate(uid);
  }

  /** `ai.predict` (any process, own uid). */
  query(uid: number, k = 3): Published {
    const s = this.sets.get(uid);
    if (s === undefined) return { predictions: [], model: 'mfu', launches: 0, updatedAt: 0 };
    return { ...s, predictions: s.predictions.slice(0, k) };
  }

  private inputs(uid: number): PrefetchInputs {
    const set = this.sets.get(uid);
    const top = set?.predictions[0];
    const mem = this.deps.memory?.();
    return {
      enabled: this.enabled && this.deps.spawnPrefetch !== undefined,
      safeMode: this.deps.safeMode ?? false,
      coldStart: set === undefined || set.model !== 'markov2',
      top1: top === undefined ? undefined : { app: top.app, confidence: top.confidence },
      theta: this.theta,
      running: this.deps.running(uid),
      jobAlive: this.jobAlive,
      wastedAt: (app) => this.wasted.get(app),
      now: this.deps.now(),
      lastInputAt: this.lastInputAt,
      gestureInProgress: this.gesture,
      interactiveBusy: this.interactiveBusy,
      // Unknown memory facts: report no free memory, so the policy skips ('memory', PRE-04).
      budgetBytes: mem?.budgetBytes ?? 0,
      accountedBytes: mem?.accountedBytes ?? 0,
      reservedBytes: mem?.reservedBytes ?? 0,
      declaredBytes: (app) => this.deps.declaredBytes?.(app) ?? 0,
      reclaimRunning: mem?.reclaimRunning ?? true,
      thrashing: mem?.thrashing ?? false,
    };
  }

  /** Run the policy for `uid`; spawns at most one `prefetch:*` job. */
  evaluate(uid: number): PrefetchDecision {
    const decision = decidePrefetch(this.inputs(uid));
    this.lastDecision = decision;
    const spawn = this.deps.spawnPrefetch;
    if (decision.start && spawn !== undefined) {
      this.jobAlive = true;
      const app = decision.app;
      this.deps.log?.(`prefetch:${app} started (PRI ${String(decision.priority)})`);
      void spawn(app, uid)
        .then((r) => {
          if (r.wasted) this.wasted.set(app, this.deps.now());
        })
        .catch(() => {
          this.wasted.set(app, this.deps.now());
        })
        .finally(() => {
          this.jobAlive = false;
        });
    }
    return decision;
  }

  // SchedulerHints (@plotinium/kernel/hooks) ------------------------------------------------

  /** The kernel's idle detector: no input for `idleMs` and no interactive work. */
  onIdle(idleMs: number): void {
    this.lastInputAt = Math.min(this.lastInputAt, this.deps.now() - idleMs);
    const uid = this.deps.sessionUid();
    if (uid !== undefined) this.evaluate(uid);
  }

  /** The app whose pages reclaim should skip once per pass, for 60 s after a confident publish. */
  residencyHint(): { app: string; ttlMs: number } | null {
    const h = this.hint;
    if (h === null) return null;
    const ttlMs = h.until - this.deps.now();
    if (ttlMs <= 0) {
      this.hint = null;
      return null;
    }
    return { app: h.app, ttlMs };
  }
}
