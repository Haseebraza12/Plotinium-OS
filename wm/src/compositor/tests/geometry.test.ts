import { describe, expect, it } from 'vitest';

import {
  clampPosition,
  clampRect,
  DEFAULT_LIMITS,
  edgesOf,
  magnet,
  px,
  resizeRect,
  sameRect,
  snapRect,
  snapZone,
  unsnapUnderPointer,
  VISIBLE_MIN,
  workArea,
} from '../geometry.ts';
import type { ResizeEdge } from '../types.ts';

const work = workArea(1_280, 800, { top: 28, bottom: 72 });
const lim = { ...DEFAULT_LIMITS };

describe('window geometry', () => {
  it('WM-04 the work area excludes the menu bar and the dock, and maximised windows never cover the dock', () => {
    expect(work).toEqual({ x: 0, y: 28, w: 1_280, h: 700 });
    expect(workArea(100, 50)).toEqual({ x: 0, y: 0, w: 100, h: 6 });
    expect(snapRect('max', work)).toEqual(work);
  });

  it('WM-04 each of the 8 resize handles moves only its edges and never goes below minW or minH', () => {
    const start = { x: 200, y: 200, w: 600, h: 400 };
    const handles: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const h of handles) {
      const e = edgesOf(h);
      const grown = resizeRect(
        start,
        e.l ? -50 : e.r ? 50 : 0,
        e.t ? -50 : e.b ? 50 : 0,
        e,
        lim,
        work,
      );
      // Edges that do not belong to the handle stay put.
      if (!e.l) expect(grown.x).toBe(start.x);
      if (!e.t) expect(grown.y).toBe(start.y);
      if (!e.r && e.l) expect(grown.x + grown.w).toBe(start.x + start.w);
      if (!e.b && e.t) expect(grown.y + grown.h).toBe(start.y + start.h);
      // Shrinking far past the limits stops at the minimum size.
      const tiny = resizeRect(
        start,
        e.l ? 5_000 : e.r ? -5_000 : 0,
        e.t ? 5_000 : e.b ? -5_000 : 0,
        e,
        lim,
        work,
      );
      if (e.l || e.r) expect(tiny.w).toBe(lim.minW);
      if (e.t || e.b) expect(tiny.h).toBe(lim.minH);
      expect(tiny.w).toBeGreaterThanOrEqual(lim.minW);
      expect(tiny.h).toBeGreaterThanOrEqual(lim.minH);
    }
  });

  it('WM-04 resizing never moves an edge out of the work area', () => {
    const start = { x: 100, y: 100, w: 600, h: 400 };
    const big = resizeRect(start, 5_000, 5_000, edgesOf('se'), lim, work);
    expect(big.x + big.w).toBe(work.x + work.w);
    expect(big.y + big.h).toBe(work.y + work.h);
    const up = resizeRect(start, -5_000, -5_000, edgesOf('nw'), lim, work);
    expect(up.x).toBe(work.x);
    expect(up.y).toBe(work.y);
    const capped = resizeRect(start, 5_000, 0, edgesOf('e'), { ...lim, maxW: 700 }, work);
    expect(capped.w).toBe(700);
  });

  it('WM-04 a window cannot be dragged so that its title bar leaves the work area', () => {
    expect(clampPosition(-5_000, -5_000, 600, work)).toEqual({ x: -(600 - VISIBLE_MIN), y: 28 });
    expect(clampPosition(5_000, 5_000, 600, work, 40)).toEqual({
      x: 1_280 - VISIBLE_MIN,
      y: 28 + 700 - 40,
    });
    expect(clampPosition(-100, 300, 60, work)).toEqual({ x: 0, y: 300 });
    expect(clampPosition(100, 300, 600, work)).toEqual({ x: 100, y: 300 });
  });

  it('WM-04 a rectangle is clamped to its limits and the work area; a too-narrow work area keeps the left edge', () => {
    expect(clampRect({ x: 50, y: 50, w: 100, h: 100 }, lim, work)).toEqual({
      x: 50,
      y: 50,
      w: 320,
      h: 200,
    });
    expect(clampRect({ x: 0, y: 900, w: 5_000, h: 5_000 }, lim, work)).toEqual({
      x: 0,
      y: 28 + 700 - 40,
      w: 1_280,
      h: 700,
    });
    const narrow = workArea(200, 800);
    expect(clampRect({ x: 50, y: 50, w: 400, h: 300 }, lim, narrow)).toMatchObject({
      x: 0,
      w: 320,
    });
  });

  it('WM-04 snap zones: 8 px from the sides snap to halves and 8 px from the top maximises', () => {
    expect(snapZone(3, 400, work)).toBe('left');
    expect(snapZone(1_275, 400, work)).toBe('right');
    expect(snapZone(600, 30, work)).toBe('max');
    expect(snapZone(4, 30, work)).toBe('left');
    expect(snapZone(600, 400, work)).toBeNull();
    expect(snapRect('left', work)).toEqual({ x: 0, y: 28, w: 640, h: 700 });
    expect(snapRect('right', { x: 0, y: 0, w: 1_001, h: 10 })).toEqual({
      x: 500,
      y: 0,
      w: 501,
      h: 10,
    });
  });

  it('WM-04 the edge magnet pulls edges within 12 px flush to the work area', () => {
    expect(magnet({ x: 10, y: 35, w: 400, h: 300 }, work)).toEqual({ x: 0, y: 28, w: 400, h: 300 });
    expect(magnet({ x: 875, y: 420, w: 400, h: 300 }, work)).toEqual({
      x: 880,
      y: 428,
      w: 400,
      h: 300,
    });
    expect(magnet({ x: 300, y: 300, w: 400, h: 300 }, work)).toEqual({
      x: 300,
      y: 300,
      w: 400,
      h: 300,
    });
  });

  it('WM-04 unsnapping keeps the pointer at the same fraction of the title bar', () => {
    expect(unsnapUnderPointer({ x: 0, y: 0, w: 800, h: 600 }, 0.25, 500, 40, 10)).toEqual({
      x: 300,
      y: 30,
      w: 800,
      h: 600,
    });
    expect(unsnapUnderPointer({ x: 0, y: 0, w: 800, h: 600 }, 3, 500, 40, 10).x).toBe(-300);
  });

  it('WMD-04 positions are rounded to device pixels', () => {
    expect(px(10.26, 2)).toBe(10.5);
    expect(px(10.26, 1)).toBe(10);
    expect(px(10.26, 0)).toBe(10);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
  });
});
