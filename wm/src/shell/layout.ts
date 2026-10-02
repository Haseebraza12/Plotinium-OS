/**
 * Session layout persistence and restore (window-manager.md §3.15, §4.6; WM-06, WMD-16). Pure
 * helpers: snapshot the compositor model into a `SessionLayout`, plan a restore for the current
 * work area, and a trailing debounce with injected timers.
 */
import type { Limits, PersistedWindow, Rect, WinModel } from '../compositor/index.ts';
import { clampRect, DEFAULT_LIMITS, snapRect } from '../compositor/index.ts';
import type { LayoutWindow, SessionLayout } from './env.ts';

export const PERSIST_DEBOUNCE_MS = 500;

export interface SnapshotInput {
  /** Windows bottom to top (compositor.model.windows()). */
  readonly windows: readonly WinModel[];
  readonly argv: (wid: number) => readonly string[];
  readonly osSessionId: string;
  readonly uid: number;
  readonly now: number;
  readonly viewport: { w: number; h: number; dpr: number };
  /**
   * A window as it is saved (compositor.model.persisted): a window compact mode maximised is
   * saved as the user left it (§3.6). Default: the window's own fields.
   */
  readonly persisted?: (w: WinModel) => PersistedWindow;
}

export function snapshotLayout(i: SnapshotInput): SessionLayout {
  return {
    v: 1,
    osSessionId: i.osSessionId,
    uid: i.uid,
    savedAt: i.now,
    viewport: { ...i.viewport },
    windows: i.windows.map((w): LayoutWindow => {
      const p: PersistedWindow = i.persisted?.(w) ?? {
        rect: { x: w.x, y: w.y, w: w.w, h: w.h },
        restoreRect: w.restoreRect,
        state: w.state,
        prevState: w.prevState,
        snap: w.snap,
      };
      return {
        app: w.app,
        argv: [...i.argv(w.wid)],
        title: w.title,
        rect: { ...p.rect },
        restoreRect: p.restoreRect === null ? null : { ...p.restoreRect },
        state: p.state,
        prevState: p.prevState,
        snap: p.snap,
        z: w.z,
        focused: w.focused,
        proc: null,
      };
    }),
  };
}

function scaleRect(r: Rect, fx: number, fy: number): Rect {
  return {
    x: Math.round(r.x * fx),
    y: Math.round(r.y * fy),
    w: Math.round(r.w * fx),
    h: Math.round(r.h * fy),
  };
}

/**
 * The windows to recreate, in ascending saved z (so inserting each at the top reproduces the
 * saved order), with `normal` rectangles scaled to the new viewport and clamped (§3.15 rule 3).
 * Maximised and snapped windows are recomputed from the work area when they are applied.
 */
export function restorePlan(
  layout: SessionLayout,
  viewport: { w: number; h: number },
  work: Rect,
  limits: Limits = DEFAULT_LIMITS,
): LayoutWindow[] {
  const fx = layout.viewport.w > 0 ? viewport.w / layout.viewport.w : 1;
  const fy = layout.viewport.h > 0 ? viewport.h / layout.viewport.h : 1;
  const same = fx === 1 && fy === 1;
  return [...layout.windows]
    .sort((a, b) => a.z - b.z)
    .map((w) => {
      const rect = same ? { ...w.rect } : scaleRect(w.rect, fx, fy);
      const restoreRect =
        w.restoreRect === null
          ? null
          : same
            ? { ...w.restoreRect }
            : scaleRect(w.restoreRect, fx, fy);
      const base = w.state === 'normal' && w.snap === null ? rect : (restoreRect ?? rect);
      return {
        ...w,
        rect: clampRect(base, limits, work),
        restoreRect: restoreRect === null ? null : clampRect(restoreRect, limits, work),
      };
    });
}

/** The rectangle a restored window ends up in once its state is applied. */
export function restoredRect(w: LayoutWindow, work: Rect): Rect {
  if (w.state === 'maximised' || (w.state === 'minimised' && w.prevState === 'maximised'))
    return { ...work };
  if (w.snap !== null) return snapRect(w.snap, work);
  return { ...w.rect };
}

/** The saved window that should end up focused (§3.15 rule 5). */
export function focusTarget(plan: readonly LayoutWindow[]): number {
  const saved = plan.findIndex((w) => w.focused && w.state !== 'minimised');
  if (saved >= 0) return saved;
  for (let i = plan.length - 1; i >= 0; i--) if (plan[i]?.state !== 'minimised') return i;
  return -1;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** A trailing debounce: `schedule()` many times, `fn` runs once `ms` after the last call. */
export class Debounce {
  private handle: unknown = null;
  private readonly fn: () => void;
  private readonly ms: number;
  private readonly timers: Timers;

  constructor(fn: () => void, ms: number, timers: Timers) {
    this.fn = fn;
    this.ms = ms;
    this.timers = timers;
  }

  get pending(): boolean {
    return this.handle !== null;
  }

  schedule(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.fn();
    }, this.ms);
  }

  /** Run now if pending (shutdown, pagehide). */
  flush(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
    this.fn();
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
}
