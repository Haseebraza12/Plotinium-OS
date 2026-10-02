/**
 * Pure model helpers for the Files app (ui-design-system.md §3.8.11; VFS-07): mapping `readdir`
 * and `stat` results to the rows the views show, the permission check that enables menu items,
 * unique names for Trash and paste, `chmod` mode parsing, navigation history, sidebar places,
 * and the keyword-search scoring used when semantic search is unavailable (RAG-06).
 *
 * No system calls and no DOM: everything here is unit-tested in Node.
 */
import type { InodeType, Stat } from '@plotinium/protocol';

import { join, splitExtension } from './path.ts';

// ---------------------------------------------------------------------------------------------
// Identity and rows
// ---------------------------------------------------------------------------------------------

/** Who the app runs as (`proc.cred`). */
export interface Who {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly user: string;
  readonly home: string;
}

export type EntryKind = 'file' | 'dir' | 'symlink';

/** A lease on a file as the Files views show it (ui `FileLock`). */
export interface EntryLock {
  holder: string;
  since: number;
  mine?: boolean;
  stale?: boolean;
}

/**
 * One row of the listing. The field names and types match `FileEntry` of
 * `@plotinium/ui/apps/files`, so a row is passed to the views unchanged.
 */
export interface EntryView {
  id: string;
  name: string;
  path: string;
  type: EntryKind;
  mode: number;
  size: number;
  mtime: number;
  ctime?: number;
  owner: string;
  uid?: number;
  group?: string;
  version?: number;
  lock?: EntryLock;
  sync?: 'pending' | 'conflict';
  readable?: boolean;
  writable?: boolean;
  cut?: boolean;
  target?: string;
}

export function kindOf(type: InodeType): EntryKind {
  switch (type) {
    case 'f':
      return 'file';
    case 'd':
      return 'dir';
    case 'l':
      return 'symlink';
  }
}

export interface Access {
  readonly r: boolean;
  readonly w: boolean;
  readonly x: boolean;
}

/**
 * The rwx bits that apply to `who` (owner, then group, then others; root passes r and w, and x
 * when any x bit is set), as vfs/perm.ts decides them. Used only to enable menu items: the
 * kernel checks again at stage 5.
 */
export function accessFor(stat: Pick<Stat, 'mode' | 'uid' | 'gid'>, who: Who): Access {
  const mode = stat.mode;
  if (who.uid === 0) return { r: true, w: true, x: (mode & 0o111) !== 0 };
  let bits: number;
  if (stat.uid === who.uid) bits = (mode >> 6) & 0o7;
  else if (stat.gid === who.gid || who.groups.includes(stat.gid)) bits = (mode >> 3) & 0o7;
  else bits = mode & 0o7;
  return { r: (bits & 4) !== 0, w: (bits & 2) !== 0, x: (bits & 1) !== 0 };
}

/** `alice`, or `uid 1004` when the name is unknown. */
export function ownerName(uid: number, names: ReadonlyMap<number, string>): string {
  return names.get(uid) ?? `uid ${String(uid)}`;
}

/** A listing row from a directory entry and its `lstat` (symlinks are shown, not followed). */
export function toEntry(
  dir: string,
  name: string,
  stat: Stat,
  who: Who,
  names: ReadonlyMap<number, string>,
  groupNames: ReadonlyMap<number, string> = new Map(),
): EntryView {
  const access = accessFor(stat, who);
  const entry: EntryView = {
    id: stat.ino,
    name,
    path: join(dir, name),
    type: kindOf(stat.type),
    mode: stat.mode & 0o7777,
    size: stat.size,
    mtime: stat.mtime,
    ctime: stat.btime ?? stat.ctime,
    owner: ownerName(stat.uid, names),
    uid: stat.uid,
    version: stat.version,
    readable: access.r,
    writable: access.w,
  };
  const group = groupNames.get(stat.gid);
  if (group !== undefined) entry.group = group;
  if (stat.target !== null) entry.target = stat.target;
  return entry;
}

/** Two rows that render the same (keeps row identity across refreshes, UIG-13). */
export function sameEntry(a: EntryView, b: EntryView): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.path === b.path &&
    a.type === b.type &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.owner === b.owner &&
    a.version === b.version &&
    a.readable === b.readable &&
    a.writable === b.writable &&
    a.cut === b.cut &&
    a.target === b.target &&
    a.lock?.holder === b.lock?.holder &&
    a.lock?.mine === b.lock?.mine &&
    a.lock?.stale === b.lock?.stale &&
    a.sync === b.sync
  );
}

/** The new list, reusing the previous objects of rows that did not change. */
export function reuseRows(prev: readonly EntryView[], next: readonly EntryView[]): EntryView[] {
  const byId = new Map(prev.map((e) => [e.id, e] as const));
  return next.map((e) => {
    const old = byId.get(e.id);
    return old !== undefined && sameEntry(old, e) ? old : e;
  });
}

// ---------------------------------------------------------------------------------------------
// Names for Trash, paste and new folders
// ---------------------------------------------------------------------------------------------

/**
 * `name` if it is free, otherwise the first free `stem 2.ext`, `stem 3.ext`, … (Finder style).
 * `copy` style gives `stem copy.ext`, `stem copy 2.ext`, … for a paste into the same folder.
 */
export function uniqueName(
  name: string,
  taken: ReadonlySet<string>,
  style: 'number' | 'copy' = 'number',
): string {
  const { stem, ext } = splitExtension(name);
  if (style === 'number' && !taken.has(name)) return name;
  const base = style === 'copy' ? `${stem} copy` : stem;
  if (style === 'copy' && !taken.has(`${base}${ext}`)) return `${base}${ext}`;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base} ${String(n)}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${String(Date.now())}${ext}`;
}

/** Whether a name is a conflicted copy, `name (conflict from user, YYYY-MM-DD).ext` (SYN-08). */
export function isConflictedCopy(name: string): boolean {
  return /\(conflict from [^,()]+, \d{4}-\d{2}-\d{2}\)/u.test(name);
}

// ---------------------------------------------------------------------------------------------
// chmod
// ---------------------------------------------------------------------------------------------

const SYMBOLIC = /^[-dl]?([r-][w-][xsS-])([r-][w-][xsS-])([r-][w-][xtT-])$/u;

/**
 * Parses `755`, `0755`, `1777` or `rwxr-xr-x` into permission bits (0o7777 at most, no setuid or
 * setgid: the kernel refuses those in v1 with EINVAL). Undefined when the text is not a mode.
 */
export function parseMode(text: string): number | undefined {
  const t = text.trim();
  if (/^0?[0-7]{3,4}$/u.test(t)) {
    const value = Number.parseInt(t, 8);
    return (value & 0o6000) === 0 ? value : undefined;
  }
  const m = SYMBOLIC.exec(t);
  if (m === null) return undefined;
  let mode = 0;
  const triads = [m[1] ?? '', m[2] ?? '', m[3] ?? ''];
  triads.forEach((triad, i) => {
    const shift = 6 - i * 3;
    if (triad[0] === 'r') mode |= 4 << shift;
    if (triad[1] === 'w') mode |= 2 << shift;
    const x = triad[2] ?? '-';
    if (x === 'x' || x === 's' || x === 't') mode |= 1 << shift;
    if (i === 2 && (x === 't' || x === 'T')) mode |= 0o1000;
    if (i < 2 && (x === 's' || x === 'S')) mode |= i === 0 ? 0o4000 : 0o2000;
  });
  return (mode & 0o6000) === 0 ? mode : undefined;
}

/** `0755`. */
export function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export type PermWho = 'owner' | 'group' | 'others';
export type PermBit = 'r' | 'w' | 'x';

const SHIFT: Record<PermWho, number> = { owner: 6, group: 3, others: 0 };
const BIT: Record<PermBit, number> = { r: 4, w: 2, x: 1 };

export function hasBit(mode: number, who: PermWho, bit: PermBit): boolean {
  return (mode & (BIT[bit] << SHIFT[who])) !== 0;
}

export function withBit(mode: number, who: PermWho, bit: PermBit, on: boolean): number {
  const mask = BIT[bit] << SHIFT[who];
  return on ? mode | mask : mode & ~mask;
}

// ---------------------------------------------------------------------------------------------
// Navigation history
// ---------------------------------------------------------------------------------------------

export interface History {
  readonly back: readonly string[];
  readonly forward: readonly string[];
}

export const EMPTY_HISTORY: History = { back: [], forward: [] };
const HISTORY_MAX = 100;

/** Going from `from` to a new place: `from` joins Back and Forward is cleared. */
export function pushHistory(history: History, from: string): History {
  const back = [...history.back, from].slice(-HISTORY_MAX);
  return { back, forward: [] };
}

/** One step back from `current`, or undefined at the start. */
export function stepBack(
  history: History,
  current: string,
): { history: History; path: string } | undefined {
  const path = history.back.at(-1);
  if (path === undefined) return undefined;
  return {
    path,
    history: { back: history.back.slice(0, -1), forward: [current, ...history.forward] },
  };
}

/** One step forward from `current`, or undefined at the end. */
export function stepForward(
  history: History,
  current: string,
): { history: History; path: string } | undefined {
  const [path, ...rest] = history.forward;
  if (path === undefined) return undefined;
  return { path, history: { back: [...history.back, current], forward: rest } };
}

// ---------------------------------------------------------------------------------------------
// Sidebar places
// ---------------------------------------------------------------------------------------------

export type PlaceIcon =
  'home' | 'documents' | 'downloads' | 'recent' | 'trash' | 'root' | 'tmp' | 'mnt';

/** A sidebar place (ui `Place`). */
export interface PlaceView {
  id: string;
  label: string;
  icon: PlaceIcon;
  path: string;
  unmounted?: boolean;
}

export const TRASH_DIR = '.Trash';
/** Where Move to Trash records each item's original path, for Put Back (inside the Trash). */
export const TRASH_INFO_DIR = '.trashinfo';

export function trashOf(who: Who): string {
  return join(who.home, TRASH_DIR);
}

/** The Put Back record of a trashed item called `name`: `~/.Trash/.trashinfo/<name>.trashinfo`. */
export function trashInfoPath(trash: string, name: string): string {
  return join(join(trash, TRASH_INFO_DIR), `${name}.trashinfo`);
}

/** A Put Back record (freedesktop.org Trash style: `Path=` and `DeletionDate=` lines). */
export function formatTrashInfo(origin: string, deletedAt?: number): string {
  const date = deletedAt === undefined ? '' : `DeletionDate=${new Date(deletedAt).toISOString()}\n`;
  return `[Trash Info]\nPath=${origin}\n${date}`;
}

/** The original path in a Put Back record, or undefined when the text is not one. */
export function parseTrashInfo(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('Path=')) continue;
    const path = line.slice('Path='.length).trim();
    return path.startsWith('/') ? path : undefined;
  }
  return undefined;
}

/**
 * Favourites (Home, Documents, Downloads, Shared) and locations (Trash, Temporary, Root).
 * `exists` says which optional folders are present; missing optional ones are left out. Home is
 * called Home (ui-implementation-guide D-18), whatever the account's name.
 */
export function placesFor(
  who: Who,
  exists: (path: string) => boolean,
): { favourites: PlaceView[]; locations: PlaceView[] } {
  const favourites: PlaceView[] = [{ id: 'home', label: 'Home', icon: 'home', path: who.home }];
  const optional: PlaceView[] = [
    { id: 'documents', label: 'Documents', icon: 'documents', path: join(who.home, 'Documents') },
    { id: 'downloads', label: 'Downloads', icon: 'downloads', path: join(who.home, 'Downloads') },
    { id: 'shared', label: 'Shared', icon: 'mnt', path: '/home/shared' },
  ];
  for (const place of optional) if (exists(place.path)) favourites.push(place);
  const locations: PlaceView[] = [
    { id: 'trash', label: 'Trash', icon: 'trash', path: trashOf(who) },
    { id: 'tmp', label: 'Temporary', icon: 'tmp', path: '/tmp' },
    { id: 'root', label: 'Root', icon: 'root', path: '/' },
  ];
  return { favourites, locations };
}

/** The place whose folder is `path` (exact match), for the sidebar selection. */
export function placeFor(
  path: string,
  places: { favourites: readonly PlaceView[]; locations: readonly PlaceView[] },
): string | undefined {
  return [...places.favourites, ...places.locations].find((p) => p.path === path)?.id;
}

// ---------------------------------------------------------------------------------------------
// Keyword search (the RAG-06 fallback when ai.semsearch is unavailable)
// ---------------------------------------------------------------------------------------------

/** Lower-cased query words of two characters or more, without duplicates (at most 16). */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/gu, ''))
    .filter((w) => w.length >= 2);
  return [...new Set(words)].slice(0, 16);
}

/** [start, end) ranges of every term inside `text`, case-insensitive, merged and sorted. */
export function highlightRanges(text: string, terms: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Whitespace-collapsed text of at most `max` characters around the first match. */
export function snippetOf(text: string, terms: readonly string[], max = 240): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= max) return flat;
  const first = highlightRanges(flat, terms)[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - Math.floor(max / 4), flat.length - max));
  const body = flat.slice(start, start + max - 2);
  return `${start > 0 ? '…' : ''}${body}${start + max - 2 < flat.length ? '…' : ''}`.slice(0, max);
}

export interface KeywordHit {
  readonly path: string;
  readonly ino: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly score: number;
  readonly snippet: string;
  readonly uid: number;
}

/**
 * The best window of up to 3 lines for `terms` in a text file, or undefined when no term occurs.
 * The score is in (0, 1]: the share of terms found in the window, nudged by how often they occur
 * in the whole file, so files that match every word rank first.
 */
export function bestWindow(
  text: string,
  terms: readonly string[],
): { lineStart: number; lineEnd: number; score: number; snippet: string } | undefined {
  if (terms.length === 0) return undefined;
  const lines = text.split('\n');
  const lowerLines = lines.map((l) => l.toLowerCase());
  let total = 0;
  for (const l of lowerLines) for (const t of terms) if (l.includes(t)) total += 1;
  if (total === 0) return undefined;
  let best = { index: 0, found: 0 };
  lowerLines.forEach((_line, i) => {
    const window = lowerLines.slice(i, i + 3).join('\n');
    const found = terms.filter((t) => window.includes(t)).length;
    if (found > best.found) best = { index: i, found };
  });
  // Trim the window to the lines that actually carry a term.
  let start = best.index;
  let end = Math.min(lines.length - 1, best.index + 2);
  const has = (i: number): boolean => terms.some((t) => (lowerLines[i] ?? '').includes(t));
  while (start < end && !has(start)) start += 1;
  while (end > start && !has(end)) end -= 1;
  const coverage = best.found / terms.length;
  const density = Math.min(1, total / (terms.length * 4));
  const score = Math.round((0.8 * coverage + 0.2 * density) * 100) / 100;
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    score,
    snippet: snippetOf(lines.slice(start, end + 1).join(' '), terms),
  };
}

/** A name-only match score for files whose content cannot be read. */
export function nameScore(name: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = name.toLowerCase();
  const found = terms.filter((t) => lower.includes(t)).length;
  return Math.round((found / terms.length) * 0.6 * 100) / 100;
}

/** Whether bytes look like text: no NUL in the first 8 KiB (grep's binary rule). */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}
