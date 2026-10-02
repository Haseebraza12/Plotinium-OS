/**
 * Dock magnification (visual-language-macos.md §3.7.3, "Dock icon"): each icon scales by a
 * cosine fall-off of its distance to the pointer, over +-`range` icon widths, up to `max`.
 * Icons scale from their bottom centre, and every slot is shifted sideways so the magnified
 * row stays contiguous and grows evenly about the dock's centre. The caller caches the slot
 * centres once at pointerenter (R-READ) and writes the result once per animation frame, so
 * nothing reads layout during pointermove. Transform only.
 */
export interface DockSlot {
  /** Horizontal centre of the slot in viewport px, measured before any magnification. */
  centre: number;
  /** Separators keep scale 1 but still move with their neighbours. */
  magnify: boolean;
}

export interface Magnification {
  /** Per slot: scale, 1..max. */
  scales: number[];
  /** Per slot: horizontal shift in px (translateX). */
  shifts: number[];
  /** Total extra width in px; the dock background stretches by this much (scaleX). */
  extra: number;
}

export const DOCK_MAX_SCALE = 1.5;
export const DOCK_RANGE = 2.5;

/** Scale for one icon at `distance` icon widths from the pointer. */
export function falloff(distance: number, max = DOCK_MAX_SCALE, range = DOCK_RANGE): number {
  const d = Math.abs(distance);
  if (d >= range) return 1;
  return 1 + (max - 1) * ((Math.cos((Math.PI * d) / range) + 1) / 2);
}

export function magnify(
  pointerX: number,
  slots: readonly DockSlot[],
  iconSize: number,
  max = DOCK_MAX_SCALE,
  range = DOCK_RANGE,
): Magnification {
  const scales = slots.map((slot) =>
    slot.magnify && iconSize > 0 ? falloff((pointerX - slot.centre) / iconSize, max, range) : 1,
  );
  const grow = scales.map((s) => (s - 1) * iconSize);
  const extra = grow.reduce((sum, g) => sum + g, 0);
  const shifts: number[] = [];
  let before = 0;
  for (const g of grow) {
    shifts.push(before + g / 2 - extra / 2);
    before += g;
  }
  return { scales, shifts, extra };
}

/** The resting state: every slot at scale 1, no shift. */
export function restingMagnification(count: number): Magnification {
  return {
    scales: Array.from({ length: count }, () => 1),
    shifts: Array.from({ length: count }, () => 0),
    extra: 0,
  };
}
