/**
 * The ONLY writer of window geometry and z-index (window-manager.md §3.2 R-GEO, §3.5, WMD-01,
 * WMD-04, I-WM4): dirty windows are collected and written in exactly one requestAnimationFrame
 * batch per frame, with `translate3d` for position. Nothing here reads layout.
 */
import { px } from './geometry.ts';
import type { WinModel } from './types.ts';
import { DIRTY } from './types.ts';

/** The part of an element's style the flush writes. */
export interface StyleTarget {
  readonly style: { transform: string; width: string; height: string; zIndex: string };
}

export interface Surfaces {
  /** The window frame element. */
  readonly el: StyleTarget;
  /** The content box (frozen during a live resize). */
  readonly content: StyleTarget;
}

export interface FlushStats {
  flushes: number;
  lastMs: number;
  maxMs: number;
  totalMs: number;
}

export type FrameRequest = (cb: () => void) => unknown;

export class Flusher {
  private readonly surfaces = new Map<number, Surfaces>();
  private readonly dirtySet = new Set<WinModel>();
  private pending = false;
  private readonly raf: FrameRequest;
  private readonly dpr: () => number;
  private readonly clock: () => number;
  /** WMD-20 accumulator: no PerformanceMeasure per frame. */
  readonly stats: FlushStats = { flushes: 0, lastMs: 0, maxMs: 0, totalMs: 0 };

  constructor(raf: FrameRequest, dpr: () => number = () => 1, clock: () => number = () => 0) {
    this.raf = raf;
    this.dpr = dpr;
    this.clock = clock;
  }

  attach(wid: number, s: Surfaces): void {
    this.surfaces.set(wid, s);
  }

  detach(wid: number): void {
    this.surfaces.delete(wid);
  }

  get dirtyCount(): number {
    return this.dirtySet.size;
  }

  /** Queue `w` for the next frame; at most one frame request is outstanding. */
  schedule(w: WinModel): void {
    this.dirtySet.add(w);
    if (this.pending) return;
    this.pending = true;
    this.raf(() => {
      this.flush();
    });
  }

  flush(): void {
    this.pending = false;
    const t0 = this.clock();
    const dpr = this.dpr();
    for (const w of this.dirtySet) {
      const s = this.surfaces.get(w.wid);
      if (!s) continue;
      const bits = w.dirtyBits;
      const st = s.el.style;
      if (bits & DIRTY.POS)
        st.transform = `translate3d(${String(px(w.x, dpr))}px, ${String(px(w.y, dpr))}px, 0)`;
      if (bits & DIRTY.SIZE) {
        st.width = `${String(w.w)}px`;
        st.height = `${String(w.h)}px`;
      }
      if (bits & DIRTY.Z) st.zIndex = String(w.z);
      if (bits & DIRTY.CONTENT) {
        s.content.style.width = `${String(w.cw)}px`;
        s.content.style.height = `${String(w.ch)}px`;
      }
      w.dirtyBits = 0;
    }
    this.dirtySet.clear();
    const ms = this.clock() - t0;
    this.stats.flushes++;
    this.stats.lastMs = ms;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
  }
}
