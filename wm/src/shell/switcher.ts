/**
 * The window switcher's state (window-manager.md §3.9; ui-implementation-guide.md §3.5.6):
 * Alt+` walks the windows in stacking order, top first, minimised ones included; the HUD shows
 * only after the modifier has been held for 120 ms, so a quick Alt+` tap switches straight to the
 * previous window; releasing Alt commits, Escape cancels. Pure.
 */

export const SWITCHER_HOLD_MS = 120;

export interface SwitcherState {
  /** Window ids top to bottom, frozen when the switcher opens. */
  readonly order: readonly number[];
  readonly index: number;
  /** When the switcher opened (for the hold threshold). */
  readonly openedAt: number;
}

/** Open on the first Alt+` (dir 1) or Alt+Shift+` (dir -1); null with fewer than two windows. */
export function openSwitcher(
  topToBottom: readonly number[],
  dir: 1 | -1,
  now: number,
): SwitcherState | null {
  if (topToBottom.length < 2) return null;
  const index = dir === 1 ? 1 : topToBottom.length - 1;
  return { order: [...topToBottom], index, openedAt: now };
}

export function stepSwitcher(s: SwitcherState, dir: 1 | -1): SwitcherState {
  const n = s.order.length;
  return { ...s, index: (((s.index + dir) % n) + n) % n };
}

export function highlightSwitcher(s: SwitcherState, wid: number): SwitcherState {
  const i = s.order.indexOf(wid);
  return i < 0 ? s : { ...s, index: i };
}

export function selectedWid(s: SwitcherState): number | undefined {
  return s.order[s.index];
}

/** The HUD is drawn once the modifier has been held for 120 ms. */
export function switcherVisible(s: SwitcherState, now: number): boolean {
  return now - s.openedAt >= SWITCHER_HOLD_MS;
}
