/**
 * The pre-fetch decision function and residency hint (predictive-prefetch.md §3.5, §3.6, §3.7;
 * PRE-04). Pure: the kernel's `SchedulerHints` seam gathers the inputs and spawns
 * `prefetch:<app>` at priority 39 only when this returns `start`.
 *
 * All must hold: pre-fetch enabled, not safe mode, not cold start; the top-1 app has confidence
 * ≥ θ, is not running, has no live job and was not pre-fetched and wasted in the last 10 min; idle
 * ≥ 2 s (no input, no pointer gesture, no interactive-band process ready or running); free memory
 * `budget − accounted − reserved ≥ declaredBytes(app) + 16 MiB`, reclaim not running (accounted
 * below 85 %) and no thrashing; at most one `prefetch:*` job at a time.
 */
export const THETA_DEFAULT = 0.4;
export const IDLE_MS = 2_000;
export const HEADROOM_BYTES = 16 * 1_048_576;
export const RECLAIM_MARK = 0.85;
export const WASTE_WINDOW_MS = 10 * 60_000;
export const HINT_MS = 60_000;
export const PREFETCH_PRIORITY = 39;

export interface PrefetchInputs {
  enabled: boolean;
  safeMode: boolean;
  coldStart: boolean;
  top1: { app: string; confidence: number } | undefined;
  theta: number;
  running: ReadonlySet<string>;
  /** A `prefetch:*` job is alive (any app). */
  jobAlive: boolean;
  /** When `app` was last pre-fetched and wasted (discarded unused), if ever. */
  wastedAt(app: string): number | undefined;
  now: number;
  lastInputAt: number;
  gestureInProgress: boolean;
  interactiveBusy: boolean;
  budgetBytes: number;
  accountedBytes: number;
  reservedBytes: number;
  declaredBytes(app: string): number;
  reclaimRunning: boolean;
  thrashing: boolean;
}

export type SkipReason =
  | 'disabled'
  | 'safe mode'
  | 'cold start'
  | 'no prediction'
  | 'below θ'
  | 'running'
  | 'busy'
  | 'wasted'
  | 'not idle'
  | 'memory';

export type PrefetchDecision =
  { start: true; app: string; priority: number } | { start: false; reason: SkipReason };

export function decidePrefetch(i: PrefetchInputs): PrefetchDecision {
  const skip = (reason: SkipReason): PrefetchDecision => ({ start: false, reason });
  if (!i.enabled) return skip('disabled');
  if (i.safeMode) return skip('safe mode');
  if (i.coldStart) return skip('cold start');
  const top = i.top1;
  if (top === undefined) return skip('no prediction');
  if (top.confidence < i.theta) return skip('below θ');
  if (i.running.has(top.app)) return skip('running');
  if (i.jobAlive) return skip('busy');
  const wasted = i.wastedAt(top.app);
  if (wasted !== undefined && i.now - wasted < WASTE_WINDOW_MS) return skip('wasted');
  if (i.now - i.lastInputAt < IDLE_MS || i.gestureInProgress || i.interactiveBusy)
    return skip('not idle');
  const free = i.budgetBytes - i.accountedBytes - i.reservedBytes;
  if (
    free < i.declaredBytes(top.app) + HEADROOM_BYTES ||
    i.reclaimRunning ||
    i.thrashing ||
    i.accountedBytes >= RECLAIM_MARK * i.budgetBytes
  ) {
    return skip('memory');
  }
  return { start: true, app: top.app, priority: PREFETCH_PRIORITY };
}

/** `mem.hint({app, until})` after a publish whose top-1 confidence reaches θ (§3.6). */
export function residencyHint(
  top1: { app: string; confidence: number } | undefined,
  theta: number,
  now: number,
): { app: string; until: number } | undefined {
  return top1 !== undefined && top1.confidence >= theta
    ? { app: top1.app, until: now + HINT_MS }
    : undefined;
}

/** The stage-6 bootlog line (§3.7), e.g. `session: pre-fetch terminal (0.62), files (0.44)`. */
export function bootlogLine(
  started: ReadonlyArray<{ app: string; confidence: number }>,
  skipped?: SkipReason,
  detail?: string,
): string {
  if (started.length > 0)
    return `session: pre-fetch ${started.map((s) => `${s.app} (${s.confidence.toFixed(2)})`).join(', ')}`;
  return `session: pre-fetch skipped (${skipped ?? 'no prediction'}${detail === undefined ? '' : `: ${detail}`})`;
}
