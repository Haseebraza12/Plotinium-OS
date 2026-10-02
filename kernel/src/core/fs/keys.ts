/**
 * IndexedDB key semantics for the in-memory store adapter (virtual-file-system.md §3.13.2).
 *
 * The memory adapter must order and compare keys exactly as IndexedDB does, because the VFS relies
 * on range scans such as `dentries` from `[dir]` to `[dir, []]` (§3.13.2 `dirBounds`):
 * number < Date < string < binary < array, arrays compare element-wise, and a proper prefix sorts
 * first. Only the key kinds the Plotinium stores use are supported (numbers, strings, arrays of
 * them); anything else is a `DataError`, as IndexedDB would report.
 */
import type { KeyBounds } from '@plotinium/vfs';

export type Key = IDBValidKey;
export type KeyPath = string | readonly string[];

/** The DOMException name IndexedDB raises for an invalid key. */
export const DATA_ERROR = 'DataError';

function rank(k: Key): number {
  if (typeof k === 'number') return 0;
  if (k instanceof Date) return 1;
  if (typeof k === 'string') return 2;
  if (Array.isArray(k)) return 4;
  return 3;
}

/** IndexedDB's `cmp`: negative, zero or positive. */
export function compareKeys(a: Key, b: Key): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareKeys(a[i] as Key, b[i] as Key);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    // IndexedDB compares strings by UTF-16 code unit, which is what `<` does.
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return 0;
}

/** Whether `k` is a key IndexedDB accepts and this adapter supports. */
export function isValidKey(k: unknown): k is Key {
  if (typeof k === 'number') return !Number.isNaN(k);
  if (typeof k === 'string') return true;
  if (k instanceof Date) return !Number.isNaN(k.getTime());
  if (Array.isArray(k)) return k.every(isValidKey);
  return false;
}

/** A stable identity string for a key (equal keys, equal strings). */
export function encodeKey(k: Key): string {
  if (k instanceof Date) return `D${String(k.getTime())}`;
  if (Array.isArray(k)) return `[${k.map((x) => encodeKey(x)).join(',')}]`;
  return JSON.stringify(k);
}

/** The key of `value` at `path`, or undefined when a component is missing or not a valid key. */
export function extractKey(value: unknown, path: KeyPath): Key | undefined {
  const get = (p: string): unknown =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[p] : undefined;
  if (typeof path === 'string') {
    const v = get(path);
    return isValidKey(v) ? v : undefined;
  }
  const parts = path.map(get);
  return parts.every(isValidKey) ? parts : undefined;
}

/** Whether `k` lies within `bounds` (null: every key). */
export function inBounds(k: Key, bounds: KeyBounds | null): boolean {
  if (bounds === null) return true;
  const lo = compareKeys(k, bounds.lower);
  if (lo < 0 || (lo === 0 && bounds.lowerOpen === true)) return false;
  const hi = compareKeys(k, bounds.upper);
  return !(hi > 0 || (hi === 0 && bounds.upperOpen === true));
}
