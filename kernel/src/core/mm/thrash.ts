/**
 * Thrashing guard (specs/03-kernel/memory-and-paging.md §3.14, KMM-11).
 *
 * Spec §9.2: "If the page-fault rate stays above a threshold, the OS refuses to start new heavy
 * processes and tells the user, in the spirit of the working-set model."
 *
 * The system major-fault rate is counted in 1 s buckets. ON after THRASH_SECONDS (5) consecutive
 * seconds above THRASH_ON (20 faults/s); OFF after 5 consecutive seconds below THRASH_OFF
 * (10 faults/s). Only the two streak counters and the open bucket are kept, so the guard is O(1)
 * per fault and per second with no history buffer.
 */

export interface ThrashParams {
  readonly thrashOnRate: number;
  readonly thrashOffRate: number;
  readonly thrashSeconds: number;
}

export type ThrashListener = (on: boolean, at: number, rate: number) => void;

const SECOND = 1_000;

export class ThrashingGuard {
  private bucketStart: number;
  private count = 0;
  private lastRate = 0;
  private onStreak = 0;
  private offStreak = 0;
  private active = false;
  private episodes = 0;
  private totalFaults = 0;

  private readonly params: ThrashParams;
  private readonly listener: ThrashListener;

  constructor(params: ThrashParams, now: number, listener: ThrashListener = () => undefined) {
    this.params = params;
    this.listener = listener;
    this.bucketStart = now;
  }

  /** Count one major fault at time `now`. */
  recordFault(now: number): void {
    this.roll(now);
    this.count++;
    this.totalFaults++;
  }

  /** Close every complete 1 s bucket up to `now` (call at least once per second). */
  tick(now: number): void {
    this.roll(now);
  }

  /** Whether the guard is on at `now`. */
  isOn(now: number): boolean {
    this.roll(now);
    return this.active;
  }

  /** Major faults counted in the last complete second. */
  faultsPerSec(now: number): number {
    this.roll(now);
    return this.lastRate;
  }

  /** Number of ON episodes since boot (the desktop notice is shown once per episode). */
  get episodeCount(): number {
    return this.episodes;
  }

  get faults(): number {
    return this.totalFaults;
  }

  private roll(now: number): void {
    // After a long idle gap the verdict is the same as after `thrashSeconds` empty buckets.
    const maxBuckets = this.params.thrashSeconds + 1;
    let closed = 0;
    while (now - this.bucketStart >= SECOND) {
      if (closed >= maxBuckets) {
        this.bucketStart += Math.floor((now - this.bucketStart) / SECOND) * SECOND;
        break;
      }
      this.close(this.count, this.bucketStart + SECOND);
      this.count = 0;
      this.bucketStart += SECOND;
      closed++;
    }
  }

  private close(rate: number, at: number): void {
    this.lastRate = rate;
    this.onStreak = rate > this.params.thrashOnRate ? this.onStreak + 1 : 0;
    this.offStreak = rate < this.params.thrashOffRate ? this.offStreak + 1 : 0;
    if (!this.active && this.onStreak >= this.params.thrashSeconds) {
      this.active = true;
      this.episodes++;
      this.offStreak = 0;
      this.listener(true, at, rate);
    } else if (this.active && this.offStreak >= this.params.thrashSeconds) {
      this.active = false;
      this.onStreak = 0;
      this.listener(false, at, rate);
    }
  }
}
