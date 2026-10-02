/**
 * Frame sampling for the frame meter HUD (window-manager.md §3.18, WMD-19). Each rAF delta is
 * quantised to whole refresh intervals (`k = max(1, round(d / T))`), where T is the median delta
 * of the first 120 frames; a frame is dropped when k ≥ 2. The last 600 intervals live in the
 * team's `dsa` ring buffer; p95 is taken once a second. Pure: the shell's rAF loop feeds it.
 */
import { Float64Ring } from '@plotinium/dsa';

import type { FrameMeterStats } from './ui.ts';

const CALIBRATION = 120;
const WINDOW = 600;

export class FrameSampler {
  private readonly ring = new Float64Ring(1024);
  private readonly calib: number[] = [];
  private period = 1000 / 60;
  private loafOurs = 0;
  private loafOther = 0;

  /** The refresh interval in ms (T). */
  get refreshMs(): number {
    return this.period;
  }

  /** Feed one rAF delta in ms. */
  sample(deltaMs: number): void {
    if (!(deltaMs > 0) || deltaMs > 1000) return; // tab was hidden
    if (this.calib.length < CALIBRATION) {
      this.calib.push(deltaMs);
      if (this.calib.length === CALIBRATION) {
        const sorted = [...this.calib].sort((a, b) => a - b);
        this.period = sorted[Math.floor(sorted.length / 2)] ?? this.period;
      }
    }
    const k = Math.max(1, Math.round(deltaMs / this.period));
    this.ring.push(k * this.period);
  }

  /** A long animation frame over 50 ms, attributed to our origin or not. */
  longFrame(ours: boolean): void {
    if (ours) this.loafOurs++;
    else this.loafOther++;
  }

  /** The last `n` quantised intervals, oldest first. */
  samples(n = 120): number[] {
    const all = this.ring.toArray();
    return all.slice(Math.max(0, all.length - Math.min(n, WINDOW)));
  }

  stats(): FrameMeterStats | undefined {
    const recent = this.samples(WINDOW);
    if (recent.length < 30) return undefined;
    const sorted = [...recent].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    const dropped = recent.filter((q) => q >= 1.5 * this.period).length;
    return {
      refreshHz: Math.round(1000 / this.period),
      p95Ms: Math.round(p95 * 10) / 10,
      droppedShare: dropped / recent.length,
      loafOurs: this.loafOurs,
      loafOther: this.loafOther,
    };
  }
}

/** `p95 16.7 ms · 60 Hz` for the Control Centre tile. */
export function frameSummary(s: FrameMeterStats | undefined): string | undefined {
  if (s === undefined) return undefined;
  return `p95 ${s.p95Ms.toFixed(1)} ms · ${String(s.refreshHz)} Hz`;
}
