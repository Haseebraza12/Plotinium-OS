/**
 * The animation hook API (window-manager.md §3.7; visual-language-macos.md §3.7.3). The compositor
 * decides WHEN a window minimises, restores, maximises, opens or closes and computes the start
 * frames; the chrome (ui/ `WindowFrame`, props `phase`, `genie`, `flip`, `onPhaseEnd`) draws the
 * motion with transform and opacity only and reports the end. With no hooks registered, or under
 * reduced motion, every phase ends at once and the final state applies in the next flush.
 */
import type { Rect, WindowPhase } from './types.ts';

export interface AnimationDetail {
  /** Minimise/restore target: dock-icon centre minus window centre, px. */
  readonly genie?: { readonly x: number; readonly y: number };
  /** Maximise/un-maximise FLIP start frame: the old rectangle as a transform of the new one. */
  readonly flip?: {
    readonly x: number;
    readonly y: number;
    readonly sx: number;
    readonly sy: number;
  };
  /**
   * Open: the point (viewport px) the window grows out of, the dock icon's centre when it was
   * launched from the Dock (ui-implementation-guide.md §3.5.3); otherwise 50% 60% of the frame.
   */
  readonly origin?: { readonly x: number; readonly y: number };
}

export interface AnimationHooks {
  /** Play `phase` on window `wid`; resolve when the chrome reports the phase ended. */
  play(wid: number, phase: WindowPhase, detail: AnimationDetail): Promise<void>;
}

export const NO_ANIMATION: AnimationHooks = Object.freeze({ play: () => Promise.resolve() });

/** FLIP (§3.7): the inverse transform that maps `to` back onto `from`. */
export function flipFrom(from: Rect, to: Rect): { x: number; y: number; sx: number; sy: number } {
  return {
    x: from.x - to.x,
    y: from.y - to.y,
    sx: to.w === 0 ? 1 : from.w / to.w,
    sy: to.h === 0 ? 1 : from.h / to.h,
  };
}

/** Genie target: the dock icon's centre minus the window's centre. */
export function genieTo(
  win: Rect,
  icon: { readonly x: number; readonly y: number } | null,
): { x: number; y: number } | undefined {
  if (icon === null) return undefined;
  return { x: icon.x - (win.x + win.w / 2), y: icon.y - (win.y + win.h / 2) };
}
