/**
 * Where a window minimises to and restores from (visual-language-macos.md §3.7.3; WM-04). The
 * genie keyframes scale about the window's bottom centre (transform-origin 50% 100%), so the
 * translate that lands the window in its dock icon is the icon centre minus the window's BOTTOM
 * centre (the ui WindowFrame contract), not minus its centre. Pure; the rectangles are read once
 * at animation start (R-READ).
 */
import type { Rect } from '../compositor/index.ts';

/** A DOMRect-shaped rectangle (viewport px). */
export interface BoxLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The genie offset for window `win` (viewport px) toward `icon`. Without a dock icon (an app
 * that is not in the dock, or no dock yet) the window drops straight down to the screen bottom.
 */
export function genieTarget(
  win: Rect,
  icon: BoxLike | undefined,
  viewportH: number,
): { x: number; y: number } {
  const bottomX = win.x + win.w / 2;
  const bottomY = win.y + win.h;
  if (icon === undefined) return { x: 0, y: Math.max(0, viewportH - bottomY) };
  return { x: icon.x + icon.width / 2 - bottomX, y: icon.y + icon.height / 2 - bottomY };
}

/** The FLIP start frame that maps `to` back onto `from` (origin 0 0). */
export function flipBetween(
  from: Rect,
  to: Rect,
): { x: number; y: number; sx: number; sy: number } {
  return {
    x: from.x - to.x,
    y: from.y - to.y,
    sx: to.w === 0 ? 1 : from.w / to.w,
    sy: to.h === 0 ? 1 : from.h / to.h,
  };
}

/** A window rectangle as a `BoxLike`. */
export function boxOf(r: Rect): BoxLike {
  return { x: r.x, y: r.y, width: r.w, height: r.h };
}
