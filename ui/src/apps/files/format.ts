/**
 * Pure formatting and ordering for the Files views: sizes, dates, symbolic modes and their
 * spoken form, kinds, sorting (folders first) and quota levels.
 */
import type { FileEntry, FileSort, Quota, SortKey } from './types.ts';

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** `24 KB`, `1.8 MB`, `640 KB`, `12 bytes` (base 1024, one decimal below 10). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/u, '') : String(Math.round(value));
  return `${text} ${UNITS[unit] ?? 'TB'}`;
}

/** Folders show `--` in the Size column. */
export function entrySize(entry: FileEntry): string {
  return entry.type === 'dir' ? '--' : formatSize(entry.size);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `Today, 09:18`, `Yesterday, 17:40`, else `22 Sep 2026` (local time). */
export function formatDate(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}`;
}

/** `2 min ago`, `just now`, `3 h ago`, else the date. */
export function formatAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(ms, now);
}

const TYPE_CHAR = { file: '-', dir: 'd', symlink: 'l' } as const;

/** `-rw-r--r--`, `drwxr-xr-x`, `-rwsr-xr-x`, `drwxrwxrwt`. */
export function modeString(type: FileEntry['type'], mode: number): string {
  const bit = (mask: number, char: string): string => ((mode & mask) !== 0 ? char : '-');
  const exec = (x: number, special: number, on: string, off: string): string => {
    const hasX = (mode & x) !== 0;
    if ((mode & special) === 0) return hasX ? 'x' : '-';
    return hasX ? on : off;
  };
  return [
    TYPE_CHAR[type],
    bit(0o400, 'r'),
    bit(0o200, 'w'),
    exec(0o100, 0o4000, 's', 'S'),
    bit(0o040, 'r'),
    bit(0o020, 'w'),
    exec(0o010, 0o2000, 's', 'S'),
    bit(0o004, 'r'),
    bit(0o002, 'w'),
    exec(0o001, 0o1000, 't', 'T'),
  ].join('');
}

/** The permission part only (`rwxr-x---`), as the inspector shows it. */
export function permissionString(mode: number): string {
  return modeString('file', mode).slice(1);
}

/** `owner read write, group read, others read` (files-light notes: the mode spelled out). */
export function spokenMode(mode: number): string {
  const part = (shift: number): string => {
    const bits = (mode >> shift) & 0o7;
    const words = [
      (bits & 4) !== 0 ? 'read' : '',
      (bits & 2) !== 0 ? 'write' : '',
      (bits & 1) !== 0 ? 'execute' : '',
    ].filter(Boolean);
    return words.length === 0 ? 'no access' : words.join(' ');
  };
  return `owner ${part(6)}, group ${part(3)}, others ${part(0)}`;
}

const KINDS: Readonly<Record<string, string>> = {
  md: 'Markdown',
  markdown: 'Markdown',
  txt: 'Plain Text',
  log: 'Log File',
  pdf: 'PDF Document',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  json: 'JSON',
  png: 'PNG Image',
  jpg: 'JPEG Image',
  jpeg: 'JPEG Image',
  gif: 'GIF Image',
  webp: 'WebP Image',
  svg: 'SVG Image',
  sh: 'Shell Script',
  zip: 'ZIP Archive',
  tar: 'Tar Archive',
  gz: 'Gzip Archive',
  csv: 'CSV Document',
  html: 'HTML Document',
  css: 'CSS Stylesheet',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** `Folder`, `Markdown`, `PDF Document`, `Alias`, or `Document` for unknown types. */
export function kindLabel(entry: Pick<FileEntry, 'type' | 'name' | 'kind'>): string {
  if (entry.kind !== undefined) return entry.kind;
  if (entry.type === 'dir') return 'Folder';
  if (entry.type === 'symlink') return 'Alias';
  return KINDS[extensionOf(entry.name)] ?? 'Document';
}

export type IconKind =
  'folder' | 'text' | 'code' | 'image' | 'pdf' | 'archive' | 'script' | 'json' | 'link' | 'other';

/** Which glyph a row shows. */
export function iconKind(entry: Pick<FileEntry, 'type' | 'name'>): IconKind {
  if (entry.type === 'dir') return 'folder';
  if (entry.type === 'symlink') return 'link';
  const ext = extensionOf(entry.name);
  if (['md', 'markdown', 'txt', 'log', 'csv'].includes(ext)) return 'text';
  if (['ts', 'tsx', 'js', 'mjs', 'css', 'html'].includes(ext)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'tar', 'gz'].includes(ext)) return 'archive';
  if (ext === 'sh') return 'script';
  if (ext === 'json') return 'json';
  return 'other';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareBy(key: SortKey, a: FileEntry, b: FileEntry): number {
  switch (key) {
    case 'name':
      return collator.compare(a.name, b.name);
    case 'modified':
      return a.mtime - b.mtime;
    case 'size':
      return (a.type === 'dir' ? -1 : a.size) - (b.type === 'dir' ? -1 : b.size);
    case 'kind':
      return collator.compare(kindLabel(a), kindLabel(b));
    case 'permissions':
      return (a.mode & 0o7777) - (b.mode & 0o7777);
  }
}

/**
 * Sorted copy: folders first in either direction (ui-design-system.md §3.8.11), then the key,
 * then the name, then code-point order, so the result is total and stable.
 */
export function sortEntries(entries: readonly FileEntry[], sort: FileSort): FileEntry[] {
  const sign = sort.direction === 'ascending' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const dirs = Number(b.type === 'dir') - Number(a.type === 'dir');
    if (dirs !== 0) return dirs;
    const primary = compareBy(sort.key, a, b) * sign;
    if (primary !== 0) return primary;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export type QuotaLevel = 'normal' | 'warning' | 'danger';

/** Warning at 80 %, danger at 95 % (files notes). */
export function quotaLevel(quota: Quota): QuotaLevel {
  const ratio = quota.total <= 0 ? 1 : quota.used / quota.total;
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'normal';
}

/** `1.2 GB of 2 GB`. */
export function quotaText(quota: Quota): string {
  return `${formatSize(quota.used)} of ${formatSize(quota.total)}`;
}

/** Citation as the spec renders it: `notes/week6-standup.md:42-51` (one line: `:42`). */
export function citation(path: string, lineStart: number, lineEnd: number): string {
  return lineEnd > lineStart ? `${path}:${lineStart}-${lineEnd}` : `${path}:${lineStart}`;
}

/** Splits text into plain and highlighted runs (text nodes only, DSN-09). */
export function highlightRuns(
  text: string,
  ranges: readonly (readonly [number, number])[] = [],
): { text: string; mark: boolean }[] {
  const sorted = [...ranges]
    .map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const runs: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [start, end] of sorted) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) runs.push({ text: text.slice(at, from), mark: false });
    runs.push({ text: text.slice(from, end), mark: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), mark: false });
  return runs;
}
