/**
 * Pure placement maths for floating surfaces (menus, popovers, tooltips, pop-up lists).
 * Positions are viewport coordinates for `position: fixed`; the element's own animation
 * uses transform, so placement (left/top, set once on open) never animates.
 */
export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = `${Side}-${Align}` | Side;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Position {
  x: number;
  y: number;
  side: Side;
  align: Align;
}

export function parsePlacement(placement: Placement): { side: Side; align: Align } {
  const [side, align] = placement.split('-') as [Side, Align | undefined];
  return { side, align: align ?? 'center' };
}

function alignOn(
  start: number,
  anchorLength: number,
  floatingLength: number,
  align: Align,
): number {
  if (align === 'start') return start;
  if (align === 'end') return start + anchorLength - floatingLength;
  return start + (anchorLength - floatingLength) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function place(
  anchor: Rect,
  floating: Size,
  side: Side,
  align: Align,
  offset: number,
): { x: number; y: number } {
  switch (side) {
    case 'bottom':
      return {
        x: alignOn(anchor.x, anchor.width, floating.width, align),
        y: anchor.y + anchor.height + offset,
      };
    case 'top':
      return {
        x: alignOn(anchor.x, anchor.width, floating.width, align),
        y: anchor.y - floating.height - offset,
      };
    case 'right':
      return {
        x: anchor.x + anchor.width + offset,
        y: alignOn(anchor.y, anchor.height, floating.height, align),
      };
    case 'left':
      return {
        x: anchor.x - floating.width - offset,
        y: alignOn(anchor.y, anchor.height, floating.height, align),
      };
  }
}

function fits(
  pos: { x: number; y: number },
  floating: Size,
  viewport: Size,
  margin: number,
  side: Side,
): boolean {
  if (side === 'bottom') return pos.y + floating.height <= viewport.height - margin;
  if (side === 'top') return pos.y >= margin;
  if (side === 'right') return pos.x + floating.width <= viewport.width - margin;
  return pos.x >= margin;
}

/**
 * Places `floating` next to `anchor` on the requested side, flips to the opposite side when it
 * would overflow and the other side has room, then clamps into the viewport margin.
 */
export function computePosition(
  anchor: Rect,
  floating: Size,
  placement: Placement,
  viewport: Size,
  offset = 6,
  margin = 8,
): Position {
  const parsed = parsePlacement(placement);
  let side = parsed.side;
  let pos = place(anchor, floating, side, parsed.align, offset);
  if (!fits(pos, floating, viewport, margin, side)) {
    const flipped = place(anchor, floating, OPPOSITE[side], parsed.align, offset);
    if (fits(flipped, floating, viewport, margin, OPPOSITE[side])) {
      side = OPPOSITE[side];
      pos = flipped;
    }
  }
  return {
    x: clamp(pos.x, margin, viewport.width - floating.width - margin),
    y: clamp(pos.y, margin, viewport.height - floating.height - margin),
    side,
    align: parsed.align,
  };
}

/** The transform-origin that makes a surface grow out of its anchor. */
export function originFor(position: Position): string {
  const vertical =
    position.side === 'bottom' ? 'top' : position.side === 'top' ? 'bottom' : 'center';
  const horizontal =
    position.side === 'right'
      ? 'left'
      : position.side === 'left'
        ? 'right'
        : position.align === 'end'
          ? 'right'
          : position.align === 'start'
            ? 'left'
            : 'center';
  return `${vertical} ${horizontal}`;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function viewportOf(doc: Document): Size {
  return { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
}
