/**
 * Index maths for roving focus in menus, listboxes, sidebars, tabs and grids. Disabled items
 * are skipped; `wrap` decides whether the ends connect (menus wrap, grids do not).
 */
export function stepIndex(
  current: number,
  delta: 1 | -1,
  count: number,
  isDisabled: (index: number) => boolean,
  wrap: boolean,
): number {
  if (count === 0) return -1;
  let index = current;
  for (let tries = 0; tries < count; tries++) {
    index += delta;
    if (index < 0 || index >= count) {
      if (!wrap) return current;
      index = (index + count) % count;
    }
    if (!isDisabled(index)) return index;
  }
  return current;
}

export function firstEnabled(count: number, isDisabled: (index: number) => boolean): number {
  for (let i = 0; i < count; i++) if (!isDisabled(i)) return i;
  return -1;
}

export function lastEnabled(count: number, isDisabled: (index: number) => boolean): number {
  for (let i = count - 1; i >= 0; i--) if (!isDisabled(i)) return i;
  return -1;
}

/**
 * Type-ahead (APG menu and listbox): printable keys typed within `timeoutMs` build a prefix;
 * the next enabled item whose label starts with it (case-insensitive) wins. Repeating one
 * letter cycles through the items that start with it.
 */
export function createTypeahead(timeoutMs = 600): (key: string, now: number) => string {
  let buffer = '';
  let last = Number.NEGATIVE_INFINITY;
  return (key, now) => {
    buffer = now - last > timeoutMs ? key : buffer + key;
    last = now;
    return buffer;
  };
}

export function isPrintableKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

export function matchTypeahead(
  labels: readonly string[],
  query: string,
  current: number,
  isDisabled: (index: number) => boolean,
): number {
  const count = labels.length;
  if (count === 0 || query === '') return -1;
  const needle = query.toLocaleLowerCase();
  const repeated = needle.length > 1 && [...needle].every((ch) => ch === needle[0]);
  const prefix = repeated ? needle.slice(0, 1) : needle;
  // A fresh single-letter (or repeated-letter) search starts after the current item.
  const startOffset = prefix.length === 1 ? 1 : 0;
  for (let step = 0; step < count; step++) {
    const index = (Math.max(current, 0) + startOffset + step) % count;
    const label = labels[index];
    if (label !== undefined && !isDisabled(index) && label.toLocaleLowerCase().startsWith(prefix))
      return index;
  }
  return -1;
}
