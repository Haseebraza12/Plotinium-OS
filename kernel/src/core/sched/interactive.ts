/**
 * The compositor's `interactive` hint (specs/03-kernel/processes-and-scheduling.md §3.9.4, KPS-11).
 *
 * While a pointer gesture is active the dispatcher does not dispatch a process whose current
 * effPrio ≥ 30 and pre-empts running background slices. The pause lasts at most 1,000 ms; after
 * that, background dispatch resumes for at least 1,000 ms even if the gesture continues. The
 * implementation also guarantees the stronger form "paused at most M = 1,000 ms in ANY window of
 * W = 2,000 ms", including for gestures that start and stop repeatedly:
 *
 *   - a pause may start only after the cool-down of the previous capped pause has ended;
 *   - a pause starting at s may last L(s) = min(M, sup{x : h(x) ≤ M}), where
 *     h(x) = paused(s + x − W, s) + x is the window total at s + x if the pause lasts that long;
 *   - a pause that ends because of that cap starts a cool-down of M.
 *
 * Proof sketch: h is non-decreasing (as the window start slides, old pause time leaves at rate 0
 * or 1 while the new pause adds at rate 1), so every window ending inside the pause holds ≤ M.
 * Between pauses the windowed total only falls. By induction every window of W holds at most M.
 * A continuous gesture therefore gives pause M, run M, pause M, … (the ≈ 50 % duty cycle that
 * RAG-01 expects for the indexer).
 *
 * Pure state machine over an explicit clock; `nextChangeAt` tells the scheduler when to arm a
 * kernel timer so a pause ends or starts without polling.
 */
import { INTERACTIVE_PAUSE_MAX_MS, INTERACTIVE_WINDOW_MS } from './params.ts';

interface Interval {
  readonly start: number;
  readonly end: number;
}

export class InteractiveHint {
  private active = false;
  /** Closed pause intervals that may still intersect a window (oldest first). */
  private readonly history: Interval[] = [];
  private pauseStart: number | null = null;
  private pauseCap = 0;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  private readonly maxPauseMs: number;
  private readonly windowMs: number;

  constructor(maxPauseMs = INTERACTIVE_PAUSE_MAX_MS, windowMs = INTERACTIVE_WINDOW_MS) {
    if (!(maxPauseMs > 0) || !(windowMs > maxPauseMs)) {
      throw new RangeError('interactive pause needs 0 < maxPauseMs < windowMs');
    }
    this.maxPauseMs = maxPauseMs;
    this.windowMs = windowMs;
  }

  /** Whether a pointer gesture is in progress (as last reported). */
  get gestureActive(): boolean {
    return this.active;
  }

  /** `interactive {active}` from the router (pointer-gesture start and end). */
  set(active: boolean, now: number): void {
    this.advance(now);
    this.active = active;
    this.advance(now);
  }

  /** True while background dispatch is paused. */
  isPaused(now: number): boolean {
    this.advance(now);
    return this.pauseStart !== null;
  }

  /**
   * The next moment `isPaused` can change without a new `set` call (the end of the current pause,
   * the end of a cool-down while the gesture continues, or the moment enough pause time has slid
   * out of the window), or null when nothing will change on its own.
   */
  nextChangeAt(now: number): number | null {
    this.advance(now);
    if (this.pauseStart !== null) return this.pauseStart + this.pauseCap;
    if (!this.active) return null;
    if (now < this.cooldownUntil) return this.cooldownUntil;
    // Active, no cool-down, yet no pause: the window is full and its start sits in a gap. The
    // total starts to fall when the window start reaches the next pause interval. Defensive: a
    // pause that fills the window is capped, and a capped pause always starts a cool-down.
    /* v8 ignore next 4 */
    for (const iv of this.history) {
      if (iv.start + this.windowMs > now) return iv.start + this.windowMs;
    }
    /* v8 ignore next -- a full window always contains a pause interval */
    return null;
  }

  /**
   * Paused milliseconds inside [from, to], counting an open pause up to `now` (diagnostics). Only
   * pause intervals that still intersect the window ending at `now` are remembered.
   */
  pausedWithin(from: number, to: number, now: number = to): number {
    this.advance(now);
    let total = this.pausedClosed(from, to);
    if (this.pauseStart !== null) total += overlap(this.pauseStart, now, from, to);
    return total;
  }

  private advance(now: number): void {
    // 1. Close a pause that reached its cap; a capped pause starts a cool-down.
    if (this.pauseStart !== null && now >= this.pauseStart + this.pauseCap) {
      const end = this.pauseStart + this.pauseCap;
      this.closePause(end);
      this.cooldownUntil = end + this.maxPauseMs;
    }
    // 2. Close a pause whose gesture ended.
    if (this.pauseStart !== null && !this.active) this.closePause(now);
    // 3. Open a pause if the gesture is active, the cool-down is over and the window allows it.
    if (this.pauseStart === null && this.active && now >= this.cooldownUntil) {
      const cap = this.maxLengthFrom(now);
      if (cap > 0) {
        this.pauseStart = now;
        this.pauseCap = cap;
      }
    }
    this.prune(now);
  }

  /** L(s) of the header: the longest pause from s that keeps every window within M. */
  private maxLengthFrom(s: number): number {
    const M = this.maxPauseMs;
    const W = this.windowMs;
    const h = (x: number): number => this.pausedClosed(s + x - W, s) + x;
    const points = [M];
    for (const iv of this.history) {
      for (const v of [iv.start - s + W, iv.end - s + W]) if (v > 0 && v < M) points.push(v);
    }
    points.sort((a, b) => a - b);
    let prev = 0;
    for (const p of points) {
      const hp = h(p);
      if (hp <= M) {
        prev = p;
        continue;
      }
      // h is linear with slope 0 or 1 between breakpoints and h(prev) ≤ M < h(p), so slope 1.
      // With the window already full and its start in a gap this is 0: no pause can start.
      return Math.max(0, prev + (M - h(prev)));
    }
    return M;
  }

  private closePause(end: number): void {
    /* v8 ignore next -- only called with an open pause */
    if (this.pauseStart === null) return;
    if (end > this.pauseStart) this.history.push({ start: this.pauseStart, end });
    this.pauseStart = null;
    this.pauseCap = 0;
  }

  private pausedClosed(from: number, to: number): number {
    let total = 0;
    for (const iv of this.history) total += overlap(iv.start, iv.end, from, to);
    return total;
  }

  private prune(now: number): void {
    for (let first = this.history[0]; first !== undefined; first = this.history[0]) {
      if (first.end > now - this.windowMs) break;
      this.history.shift();
    }
  }
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
