/**
 * Pure formatters and geometry for the Task Manager (every function is unit-tested). Sizes use
 * binary units, written "MB" and "GB" as `free` does (memory-and-paging.md conventions: the
 * spec's 256 MB budget is 256 MiB), so one unit label is used everywhere.
 */
import type { Band } from '@plotinium/protocol';

import type { ProcessRow, ProcStateView } from './models.ts';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

const grouped = new Intl.NumberFormat('en-GB');

/** "0 B", "812 KB", "12.4 MB", "184.0 MB", "1.2 GB". */
export function formatBytes(bytes: number, digits = 1): string {
  const n = Math.max(0, bytes);
  if (n < KIB) return `${Math.round(n)} B`;
  if (n < MIB) return `${Math.round(n / KIB)} KB`;
  if (n < GIB) return `${(n / MIB).toFixed(digits)} MB`;
  return `${(n / GIB).toFixed(digits)} GB`;
}

/** Whole megabytes when exact ("256 MB"), else one decimal ("198.4 MB"). */
export function formatMB(bytes: number): string {
  const mb = bytes / MIB;
  return Number.isInteger(mb) ? `${grouped.format(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Number without unit for "231 / 256 MB". */
export function mbNumber(bytes: number): string {
  const mb = bytes / MIB;
  return Number.isInteger(mb) ? grouped.format(mb) : mb.toFixed(1);
}

export function formatCount(n: number): string {
  return grouped.format(Math.round(n));
}

/** "98.0", "0.3": one decimal, never negative. */
export function formatCpu(cpu: number): string {
  return Math.max(0, cpu).toFixed(1);
}

/** "2h 14m", "14m 03s", "42s". */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** "450 ms", "5,450 ms" (tabular, grouped). */
export function formatMs(ms: number): string {
  return `${grouped.format(Math.round(ms))} ms`;
}

/** "4.02 s" for waits of a second or more, else "380 ms". */
export function formatWait(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Signed nice: "+12", "-20", "0". */
export function formatNice(nice: number): string {
  return nice > 0 ? `+${nice}` : String(nice);
}

/** "$3.20". */
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The PRI column: clamp(priority + nice, 0, 39) (processes-and-scheduling.md §3.9.1). */
export function basePriority(priority: number, nice: number): number {
  return Math.min(39, Math.max(0, priority + nice));
}

/** Band of a base priority: interactive 0-9, normal 10-29, background 30-39. */
export function bandOf(base: number): Band {
  if (base <= 9) return 'interactive';
  if (base <= 29) return 'normal';
  return 'background';
}

export interface BoundParams {
  /** Base priority of the waiting process (worst case 39). */
  p: number;
  tAgeMs: number;
  /** Runnable processes. */
  n: number;
  /** Parallelism available to predecessors (1 for the declared bound). */
  e: number;
  qMs: number;
  deltaMs: number;
  hKillMs: number;
}

/**
 * The declared PROC-04 bound: W(P) ≤ (p + 1)·T_age + ⌈(N − 1)/E⌉·(Q + δ) + H_kill
 * (processes-and-scheduling.md §3.12.4). Defaults give 5,450 ms.
 */
export function agingBound(b: BoundParams): number {
  const e = Math.max(1, b.e);
  return (
    (b.p + 1) * b.tAgeMs + Math.ceil(Math.max(0, b.n - 1) / e) * (b.qMs + b.deltaMs) + b.hKillMs
  );
}

/** Frame-time status against the 16.7 ms budget (PROC-05): ok, warn up to 33 ms, bad above. */
export function frameTone(p95Ms: number): 'ok' | 'warn' | 'bad' {
  if (p95Ms <= 16.7) return 'ok';
  if (p95Ms <= 33) return 'warn';
  return 'bad';
}

/** Word form of a state for pills and accessible names. */
export function stateLabel(state: ProcStateView): string {
  return state.charAt(0) + state.slice(1).toLowerCase();
}

/** "Blocked, awaiting llm": the pill's accessible name includes the reason. */
export function stateName(row: Pick<ProcessRow, 'state' | 'reason'>): string {
  const base = stateLabel(row.state);
  return row.reason === undefined || row.reason === '' ? base : `${base}, ${row.reason}`;
}

/** End Process is refused for pid 1, kernel services and rows the kernel marks protected. */
export function canEnd(row: Pick<ProcessRow, 'pid' | 'badges' | 'protected'> | undefined): boolean {
  if (row === undefined) return false;
  return row.pid !== 1 && row.protected !== true && !row.badges.includes('kernel');
}

/** Case-insensitive filter over name, pid and user. */
export function matchesQuery(
  row: Pick<ProcessRow, 'pid' | 'name' | 'user'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return (
    row.name.toLowerCase().includes(q) ||
    String(row.pid).startsWith(q) ||
    row.user.toLowerCase().includes(q)
  );
}

export interface SparkGeometry {
  /** SVG path of the line. */
  line: string;
  /** Closed path of the area under the line. */
  area: string;
  /** Horizontal distance between two samples. */
  step: number;
}

/**
 * Builds a sparkline path in a width × height box. Values are clamped to [0, max]; y grows
 * downwards with a 1 px inset so the stroke is never clipped. O(n), no layout reads.
 */
export function sparkPath(
  values: readonly number[],
  width: number,
  height: number,
  max = 100,
): SparkGeometry {
  const count = values.length;
  if (count === 0) return { line: '', area: '', step: 0 };
  const top = 1;
  const bottom = height - 1;
  const span = Math.max(1e-9, max);
  const step = count > 1 ? width / (count - 1) : width;
  const points = values.map((v, i) => {
    const ratio = Math.min(1, Math.max(0, v / span));
    const x = count > 1 ? i * step : width;
    const y = bottom - ratio * (bottom - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = count > 1 ? 0 : width;
  const line = `M${points.join('L')}`;
  const area = `${line}L${width.toFixed(1)},${height}L${first.toFixed(1)},${height}Z`;
  return { line, area, step };
}

/** Trend word for accessible sparkline summaries: compares the last value with the first. */
export function trendOf(values: readonly number[]): 'rising' | 'falling' | 'steady' {
  if (values.length < 2) return 'steady';
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const delta = last - first;
  const scale = Math.max(1, Math.abs(first), Math.abs(last));
  if (Math.abs(delta) / scale < 0.05) return 'steady';
  return delta > 0 ? 'rising' : 'falling';
}

/** Ratio in 0..1 of a part over a whole, safe for a zero whole. */
export function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}
