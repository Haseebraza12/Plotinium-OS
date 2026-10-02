/**
 * Pure window geometry (window-manager.md §3.5–§3.6, WM-04, WMD-06, WMD-07). No DOM, no state:
 * every function maps numbers to numbers, so the rules are unit-tested directly.
 */
import type { Edges, Limits, Rect, ResizeEdge, SnapZone } from './types.ts';

/** Pixels of the title bar that must stay horizontally visible (WMD-06). */
export const VISIBLE_MIN = 96;
/** Snap zones: pointer within 8 px of a side (halves) or the top (maximise), WMD-07. */
export const SNAP_EDGE = 8;
/** Edge magnet at drag end. */
export const MAGNET = 12;
/** A drag starts only after 4 px, so a double-click never moves a window (§3.5, §3.8). */
export const DRAG_THRESHOLD = 4;
/** Default title-bar height for the vertical clamp (the chrome may pass its own). */
export const TITLEBAR_H = 40;
/** Below this work-area width every window is shown maximised (compact mode, §3.6). */
export const COMPACT_BELOW = 800;
/** New windows cascade from this offset inside the work area, one step per window (§3.3). */
export const CASCADE_ORIGIN = 40;
export const CASCADE_STEP = 24;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  minW: 320,
  minH: 200,
  maxW: Number.POSITIVE_INFINITY,
  maxH: Number.POSITIVE_INFINITY,
});

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Device-pixel rounding so text stays crisp at fractional devicePixelRatio (§3.5). */
export function px(v: number, dpr: number): number {
  const d = dpr > 0 ? dpr : 1;
  return Math.round(v * d) / d;
}

/** The work area: the viewport minus the menu bar on top and the taskbar/dock at the bottom. */
export function workArea(
  viewportW: number,
  viewportH: number,
  insets: { top?: number; bottom?: number } = {},
): Rect {
  const top = insets.top ?? 0;
  const bottom = insets.bottom ?? 44;
  return { x: 0, y: top, w: Math.max(0, viewportW), h: Math.max(0, viewportH - top - bottom) };
}

/** Which sides a handle moves. */
export function edgesOf(handle: ResizeEdge): Edges {
  return {
    l: handle.includes('w'),
    t: handle.includes('n'),
    r: handle.includes('e'),
    b: handle.includes('s'),
  };
}

/** The window's size within its limits and the work area (min size wins when space runs out). */
export function clampSize(w: number, h: number, lim: Limits, work: Rect): { w: number; h: number } {
  return {
    w: clamp(w, lim.minW, Math.max(lim.minW, Math.min(lim.maxW, work.w))),
    h: clamp(h, lim.minH, Math.max(lim.minH, Math.min(lim.maxH, work.h))),
  };
}

/**
 * The clamp rule for a `normal` window (WMD-06): the title bar is fully inside the work area
 * vertically and at least min(96, w) px of it visible horizontally.
 */
export function clampPosition(
  x: number,
  y: number,
  w: number,
  work: Rect,
  titlebarH = TITLEBAR_H,
): { x: number; y: number } {
  const visible = Math.min(VISIBLE_MIN, w);
  const minX = work.x - (w - visible);
  const maxX = work.x + work.w - visible;
  const maxY = work.y + Math.max(0, work.h - titlebarH);
  return { x: clamp(x, minX, Math.max(minX, maxX)), y: clamp(y, work.y, maxY) };
}

/** Size then position clamp for a whole rectangle (viewport resize, restore, create). */
export function clampRect(r: Rect, lim: Limits, work: Rect, titlebarH = TITLEBAR_H): Rect {
  const size = clampSize(r.w, r.h, lim, work);
  const pos = clampPosition(r.x, r.y, size.w, work, titlebarH);
  // Wider than the work area: start at its left edge so the title bar and close button show.
  const x = work.w < lim.minW ? work.x : pos.x;
  return { x, y: pos.y, w: size.w, h: size.h };
}

/**
 * Resize from `start` by (dx, dy) on the given edges: the opposite edge stays anchored, the size
 * never goes below the minimum, and the moving edges never leave the work area.
 */
export function resizeRect(
  start: Rect,
  dx: number,
  dy: number,
  e: Edges,
  lim: Limits,
  work: Rect,
): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  const maxW = Math.min(lim.maxW, work.w);
  const maxH = Math.min(lim.maxH, work.h);
  if (e.l) left = clamp(start.x + dx, Math.max(work.x, right - maxW), right - lim.minW);
  if (e.r)
    right = clamp(
      right + dx,
      left + lim.minW,
      Math.max(left + lim.minW, Math.min(work.x + work.w, left + maxW)),
    );
  if (e.t) top = clamp(start.y + dy, Math.max(work.y, bottom - maxH), bottom - lim.minH);
  if (e.b)
    bottom = clamp(
      bottom + dy,
      top + lim.minH,
      Math.max(top + lim.minH, Math.min(work.y + work.h, top + maxH)),
    );
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The snap zone under the pointer (§3.6 table); sides win over the top. */
export function snapZone(pointerX: number, pointerY: number, work: Rect): SnapZone {
  if (pointerX - work.x <= SNAP_EDGE) return 'left';
  if (pointerX >= work.x + work.w - SNAP_EDGE) return 'right';
  if (pointerY - work.y <= SNAP_EDGE) return 'max';
  return null;
}

/** Target rectangle of a zone. */
export function snapRect(zone: Exclude<SnapZone, null>, work: Rect): Rect {
  const half = Math.floor(work.w / 2);
  if (zone === 'left') return { x: work.x, y: work.y, w: half, h: work.h };
  if (zone === 'right') return { x: work.x + half, y: work.y, w: work.w - half, h: work.h };
  return { ...work };
}

/**
 * The maximised rectangle for a window with these limits: the work area, but never below the
 * window's minimum size (the clamp rule of §3.6: a window wider than the work area starts at its
 * left edge and overflows to the right).
 */
export function maxRect(work: Rect, lim: Limits): Rect {
  const size = clampSize(work.w, work.h, lim, work);
  return { x: work.x, y: work.y, w: size.w, h: size.h };
}

/**
 * A snap zone's rectangle for a window with these limits (§3.6 table): the half, widened to the
 * window's minimum width when the half is narrower. A right-snapped window stays flush with the
 * right edge unless it is wider than the whole work area.
 */
export function snapRectFor(zone: Exclude<SnapZone, null>, work: Rect, lim: Limits): Rect {
  if (zone === 'max') return maxRect(work, lim);
  const half = snapRect(zone, work);
  const size = clampSize(half.w, half.h, lim, work);
  const x = zone === 'left' ? work.x : Math.max(work.x, work.x + work.w - size.w);
  return { x, y: work.y, w: size.w, h: size.h };
}

/**
 * A new window pushed inside the work area where it fits: never past the right or bottom edge
 * while there is room, and never above or left of the work area.
 */
export function fitInside(r: Rect, work: Rect): Rect {
  const x = Math.max(work.x, Math.min(r.x, work.x + work.w - r.w));
  const y = Math.max(work.y, Math.min(r.y, work.y + work.h - r.h));
  return { x, y, w: r.w, h: r.h };
}

/**
 * The k-th cascade position (k = 0, 1, …) for a new w × h window: diagonal steps down and right;
 * when the next step would push the window past the bottom of the work area, the next series
 * starts at the top again, shifted right past the previous one, so no two slots share an origin
 * until the horizontal room runs out.
 */
export function cascadeSlot(k: number, w: number, h: number, work: Rect): { x: number; y: number } {
  const rows = Math.max(1, Math.floor((work.h - CASCADE_ORIGIN - h) / CASCADE_STEP) + 1);
  const series = Math.floor(k / rows);
  const i = k % rows;
  const roomX = Math.max(0, work.w - CASCADE_ORIGIN - w);
  const dx = (i + series * rows) * CASCADE_STEP;
  return {
    x: work.x + CASCADE_ORIGIN + (roomX > 0 ? dx % (roomX + 1) : 0),
    y: work.y + CASCADE_ORIGIN + i * CASCADE_STEP,
  };
}

/** At drag end, any edge within 12 px of a work-area edge moves flush to it. */
export function magnet(r: Rect, work: Rect): Rect {
  let { x, y } = r;
  if (Math.abs(x - work.x) <= MAGNET) x = work.x;
  else if (Math.abs(x + r.w - (work.x + work.w)) <= MAGNET) x = work.x + work.w - r.w;
  if (Math.abs(y - work.y) <= MAGNET) y = work.y;
  else if (Math.abs(y + r.h - (work.y + work.h)) <= MAGNET) y = work.y + work.h - r.h;
  return { x, y, w: r.w, h: r.h };
}

/**
 * Dragging a snapped or maximised window: restore its saved size and keep the pointer at the same
 * fraction of the title bar's width (§3.6 "Unsnap under the pointer").
 */
export function unsnapUnderPointer(
  restore: Rect,
  frac: number,
  pointerX: number,
  pointerY: number,
  grabDy: number,
): Rect {
  return {
    x: pointerX - clamp(frac, 0, 1) * restore.w,
    y: pointerY - grabDy,
    w: restore.w,
    h: restore.h,
  };
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
