/**
 * Selection model shared by the list and icon views (APG multi-select): click selects one,
 * Ctrl/Cmd+click toggles, Shift+click and Shift+arrows extend from the anchor, Space toggles
 * the focused item, Ctrl/Cmd+A selects everything. Pure functions over an ordered id list.
 */
export interface Selection {
  selected: ReadonlySet<string>;
  /** Where a Shift range starts. */
  anchor?: string;
  /** The item with keyboard focus (the roving tab stop). */
  focus?: string;
}

export const EMPTY_SELECTION: Selection = { selected: new Set() };

function rangeIds(order: readonly string[], from: string | undefined, to: string): string[] {
  const end = order.indexOf(to);
  const start = from === undefined ? end : order.indexOf(from);
  if (end < 0) return [];
  if (start < 0) return [to];
  const [a, b] = start <= end ? [start, end] : [end, start];
  return order.slice(a, b + 1);
}

export interface Modifiers {
  shift?: boolean;
  /** Ctrl on Linux and Windows, Cmd on macOS. */
  toggle?: boolean;
}

/** A pointer click on an item. */
export function clickSelect(
  state: Selection,
  order: readonly string[],
  id: string,
  mods: Modifiers = {},
): Selection {
  if (mods.shift === true) {
    return {
      selected: new Set(rangeIds(order, state.anchor ?? state.focus, id)),
      anchor: state.anchor ?? id,
      focus: id,
    };
  }
  if (mods.toggle === true) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id, focus: id };
  }
  return { selected: new Set([id]), anchor: id, focus: id };
}

/**
 * A click on empty space (Finder): nothing stays selected, and the roving tab stop keeps its
 * place so the keyboard carries on from where it was.
 */
export function clearSelection(state: Selection): Selection {
  return state.focus === undefined
    ? { selected: new Set() }
    : { selected: new Set(), focus: state.focus };
}

/** Selects an item for a context menu: keeps a multi-selection that already contains it. */
export function contextSelect(state: Selection, id: string): Selection {
  if (state.selected.has(id)) return { ...state, focus: id };
  return { selected: new Set([id]), anchor: id, focus: id };
}

export type NavKey =
  'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';

export function isNavKey(key: string): key is NavKey {
  return [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ].includes(key);
}

/**
 * Moves focus with a key. `columns` is 1 for the list (Left/Right do nothing) and the number
 * of icons per row in the icon view. Without modifiers the selection follows focus; Shift
 * extends from the anchor; Ctrl/Cmd moves focus only.
 */
export function keySelect(
  state: Selection,
  order: readonly string[],
  key: NavKey,
  mods: Modifiers = {},
  options: { columns?: number; page?: number } = {},
): Selection {
  if (order.length === 0) return state;
  const columns = Math.max(1, options.columns ?? 1);
  const page = Math.max(1, options.page ?? 10);
  const current = state.focus === undefined ? -1 : order.indexOf(state.focus);
  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = current < 0 ? 0 : current + columns;
      break;
    case 'ArrowUp':
      next = current < 0 ? 0 : current - columns;
      break;
    case 'ArrowRight':
      if (columns === 1) return state;
      next = current + 1;
      break;
    case 'ArrowLeft':
      if (columns === 1) return state;
      next = current - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = order.length - 1;
      break;
    case 'PageDown':
      next = current + page * columns;
      break;
    case 'PageUp':
      next = current - page * columns;
      break;
  }
  next = Math.min(order.length - 1, Math.max(0, next));
  const id = order[next];
  if (id === undefined) return state;
  if (mods.shift === true) {
    const anchor = state.anchor ?? state.focus ?? id;
    return { selected: new Set(rangeIds(order, anchor, id)), anchor, focus: id };
  }
  if (mods.toggle === true) return { ...state, focus: id };
  return { selected: new Set([id]), anchor: id, focus: id };
}

/** Space: toggles the focused item. */
export function toggleFocused(state: Selection): Selection {
  if (state.focus === undefined) return state;
  const next = new Set(state.selected);
  if (next.has(state.focus)) next.delete(state.focus);
  else next.add(state.focus);
  return { ...state, selected: next, anchor: state.focus };
}

export function selectAll(state: Selection, order: readonly string[]): Selection {
  return { ...state, selected: new Set(order), focus: state.focus ?? order[0] };
}

/** Drops ids that are no longer listed (after a refresh or a delete). */
export function pruneSelection(state: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  const selected = new Set([...state.selected].filter((id) => present.has(id)));
  return {
    selected,
    anchor: state.anchor !== undefined && present.has(state.anchor) ? state.anchor : undefined,
    focus: state.focus !== undefined && present.has(state.focus) ? state.focus : undefined,
  };
}
