/**
 * Pure text and number helpers for the shell chrome. Visible strings follow the exact tray
 * wording of specs/05-wm/window-manager.md §3.11; spoken strings expand them for assistive
 * technology. Nothing here reads a clock: callers pass `now` (epoch ms).
 */
import type { MemoryView, NetView, SvcView } from './types.ts';

/** Whole seconds until `at`, never negative (countdowns redraw at most once per second). */
export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The exact tray text for connectivity (OFF-04). */
export function connectivityText(net: NetView, now: number): string {
  switch (net.state) {
    case 'LIVE':
      return 'Online';
    case 'SYNCING':
      return `Syncing ${net.ops} ${plural(net.ops, 'op', 'ops')}`;
    case 'RECONNECTING':
      return `Reconnecting in ${secondsUntil(net.retryAt, now)} s`;
    case 'OFFLINE':
      return `Offline · ${net.queued} queued`;
    case 'AUTH_REQUIRED':
      return 'Sign in to sync';
    case 'UNAVAILABLE':
      return net.queued > 0 ? `Sync unavailable · ${net.queued} queued` : 'Sync unavailable';
  }
}

/** Secondary line under the connectivity title (Control Centre tile). */
export function connectivityDetail(net: NetView, lastSyncTime: string | undefined): string {
  const last = lastSyncTime === undefined ? '' : ` · last sync ${lastSyncTime}`;
  switch (net.state) {
    case 'LIVE':
      return `All changes synced${last}`;
    case 'SYNCING':
      return `Sending changes to the server${last}`;
    case 'RECONNECTING':
      return `Server unreachable${last}`;
    case 'OFFLINE':
      return `Changes are kept on this device${last}`;
    case 'AUTH_REQUIRED':
      return `${net.queued} ${plural(net.queued, 'change', 'changes')} waiting${last}`;
    case 'UNAVAILABLE':
      return `${capitalise(net.reason)} · changes stay on this device${last}`;
  }
}

function capitalise(text: string): string {
  return text === '' ? 'Sync service not running' : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The short line under the connectivity title in the Control Centre tile, where there is room
 * for about two words per line; the tile's accessible name keeps `connectivityDetail`.
 */
export function connectivityShort(net: NetView, lastSyncTime: string | undefined): string {
  switch (net.state) {
    case 'LIVE':
      return lastSyncTime === undefined ? 'All changes synced' : `Synced at ${lastSyncTime}`;
    case 'SYNCING':
      return 'Sending changes';
    case 'RECONNECTING':
      return 'Server unreachable';
    case 'OFFLINE':
      return 'Kept on this device';
    case 'AUTH_REQUIRED':
      return `${net.queued} ${plural(net.queued, 'change', 'changes')} waiting`;
    case 'UNAVAILABLE':
      // The title already says "Sync unavailable": "sync client not linked" → "Client not linked"
      // keeps the line short enough for the tile (UI-151).
      return net.reason === ''
        ? 'Service not running'
        : capitalise(net.reason.replace(/^sync\s+(?=\S)/iu, ''));
  }
}

/** The accessible name of the connectivity status item; the meaning is never colour alone. */
export function connectivitySpoken(net: NetView, now: number): string {
  if (net.state === 'LIVE') return 'Sync: Online, all changes synced';
  if (net.state === 'UNAVAILABLE')
    return `Sync: ${connectivityText(net, now)}, ${net.reason === '' ? 'sync service not running' : net.reason}`;
  return `Sync: ${connectivityText(net, now)}`;
}

export type MemoryLevel = 'normal' | 'warning' | 'critical';

/** Warning at >= 85% (the reclaim threshold, C13), critical at >= 95% (window-manager.md §3.11). */
export function memoryLevel(memory: MemoryView): MemoryLevel {
  if (memory.budgetMb <= 0) return 'critical';
  const ratio = memory.usedMb / memory.budgetMb;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.85) return 'warning';
  return 'normal';
}

/** Fill ratio of the memory bar, clamped to 0..1 (drawn with scaleX, never width). */
export function memoryRatio(memory: MemoryView): number {
  if (memory.budgetMb <= 0) return 1;
  return Math.min(1, Math.max(0, memory.usedMb / memory.budgetMb));
}

/**
 * The used amount without its unit when it is in MB: whole MB from 10 MB, one decimal below
 * 10 MB, and kilobytes (with their unit) below 1 MB, so a small value never rounds to "0".
 */
function usedAmount(mb: number): string {
  if (!(mb > 0)) return '0';
  if (Math.round(mb * 1024) < 1024) return `${Math.max(1, Math.round(mb * 1024))} KB`;
  return tenths(mb);
}

/** One decimal below 10 ("3.2"), whole numbers otherwise ("1", "142"); never "1.0". */
function tenths(mb: number): string {
  const t = Math.round(mb * 10) / 10;
  return t < 10 && !Number.isInteger(t) ? t.toFixed(1) : String(Math.round(mb));
}

/** "142/256 MB", "3.2/256 MB", "410 KB/256 MB" as in the menu bar. */
export function memoryText(memory: MemoryView): string {
  return `${usedAmount(memory.usedMb)}/${Math.round(memory.budgetMb)} MB`;
}

/**
 * The memory item's accessible name. It starts with the visible text (WCAG 2.5.3, label in
 * name) and adds the share in words: "142/256 MB memory used, 55 percent",
 * "410 KB/256 MB memory used, less than 1 percent".
 */
export function memorySpoken(memory: MemoryView): string {
  const ratio = memory.budgetMb > 0 ? memory.usedMb / memory.budgetMb : 1;
  const percent =
    ratio > 0 && ratio < 0.01 ? 'less than 1 percent' : `${Math.round(ratio * 100)} percent`;
  return `${memoryText(memory)} memory used, ${percent}`;
}

/**
 * Memory values: "256 MB", "1 GB", "1.5 GB" for budgets; small amounts keep their precision
 * ("3.2 MB", "410 KB") so the menu bar and Control Centre never show "0 MB" for a used amount.
 */
export function formatMb(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`;
  }
  if (mb > 0 && Math.round(mb * 1024) < 1024) return `${Math.max(1, Math.round(mb * 1024))} KB`;
  return `${mb > 0 ? tenths(mb) : String(Math.round(mb))} MB`;
}

/** Bytes as "3.1" MB with one decimal, for "Restoring… 3.1 / 5.0 MB" (window-manager.md §3.12). */
export function bytesAsMb(bytes: number): string {
  return (Math.max(0, bytes) / (1024 * 1024)).toFixed(1);
}

export interface ServiceSummary {
  total: number;
  healthy: number;
  /** Degraded, failed or blocked. */
  degraded: number;
  starting: number;
}

export function serviceSummary(services: readonly SvcView[]): ServiceSummary {
  let degraded = 0;
  let starting = 0;
  for (const svc of services) {
    if (svc.state === 'starting') starting++;
    else if (svc.state !== 'running') degraded++;
  }
  return {
    total: services.length,
    healthy: services.length - degraded - starting,
    degraded,
    starting,
  };
}

/** Menu-bar text of the degraded-services item; undefined hides the item (healthy). */
export function serviceIndicatorText(summary: ServiceSummary): string | undefined {
  if (summary.degraded > 0) return `${summary.degraded} degraded`;
  if (summary.starting > 0) return `starting (${summary.starting})`;
  return undefined;
}

/** One service row, in the tray wording of window-manager.md §3.11. */
export function serviceRowText(svc: SvcView, now: number): string {
  switch (svc.state) {
    case 'running':
      return `${svc.name} — running`;
    case 'starting':
      return `${svc.name} — starting`;
    case 'blocked':
      return `${svc.name} — blocked by ${svc.blockedBy ?? 'a dependency'}`;
    case 'failed':
      return `${svc.name} — failed${svc.reason === undefined ? '' : ` · ${svc.reason}`}`;
    case 'degraded': {
      const reason = svc.reason === undefined ? '' : ` · ${svc.reason}`;
      const retry =
        svc.nextRetryAt === undefined
          ? ''
          : ` · retry in ${secondsUntil(svc.nextRetryAt, now)} s (attempt ${svc.attempts})`;
      return `${svc.name} — degraded${reason}${retry}`;
    }
  }
}

export interface ClockText {
  /** "Thu 24 Sep" */
  date: string;
  /** "10:42" */
  time: string;
  /** "Thursday 24 September, 10:42" */
  spoken: string;
}

export interface ClockOptions {
  /** BCP 47 locale for the names; default en-US names in day-month order, as designed. */
  locale?: string;
  /** IANA time zone; default the system zone. */
  timeZone?: string;
  /** 12-hour time with AM/PM ("9:05 AM"); default 24-hour ("09:05"), the Settings default. */
  hour12?: boolean;
}

function parts(
  at: number,
  options: Intl.DateTimeFormatOptions,
  clock: ClockOptions,
): Map<Intl.DateTimeFormatPartTypes, string> {
  const format = new Intl.DateTimeFormat(clock.locale ?? 'en-US', {
    ...options,
    timeZone: clock.timeZone,
  });
  return new Map(format.formatToParts(at).map((p) => [p.type, p.value]));
}

/** The hour and minute fields for the clock's cycle (h23 by default, h12 with a day period). */
function timeOptions(clock: ClockOptions): Intl.DateTimeFormatOptions {
  return clock.hour12 === true
    ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
}

function timeText(p: Map<Intl.DateTimeFormatPartTypes, string>, clock: ClockOptions): string {
  const time = `${p.get('hour') ?? ''}:${p.get('minute') ?? ''}`;
  return clock.hour12 === true ? `${time} ${p.get('dayPeriod') ?? ''}`.trimEnd() : time;
}

/**
 * The menu-bar clock: "Thu 24 Sep 10:42" (24-hour, no seconds; redrawn each minute), or
 * "Thu 24 Sep 9:05 AM" when `hour12` is set (Settings › General › 24-hour time off).
 */
export function formatClock(now: number, clock: ClockOptions = {}): ClockText {
  const short = parts(
    now,
    { weekday: 'short', day: 'numeric', month: 'short', ...timeOptions(clock) },
    clock,
  );
  const long = parts(now, { weekday: 'long', day: 'numeric', month: 'long' }, clock);
  const time = timeText(short, clock);
  return {
    date: `${short.get('weekday') ?? ''} ${short.get('day') ?? ''} ${short.get('month') ?? ''}`,
    time,
    spoken: `${long.get('weekday') ?? ''} ${long.get('day') ?? ''} ${long.get('month') ?? ''}, ${time}`,
  };
}

/** "10:41" (or "10:41 AM" in 12-hour mode) for "last sync 10:41". */
export function formatTimeOfDay(at: number, clock: ClockOptions = {}): string {
  return timeText(parts(at, timeOptions(clock), clock), clock);
}

export interface RelativeTime {
  /** "now", "2m ago", "3h ago", "2d ago" */
  short: string;
  /** "just now", "2 minutes ago" */
  spoken: string;
}

/** Notification times, relative to `now`. */
export function relativeTime(at: number, now: number): RelativeTime {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return { short: 'now', spoken: 'just now' };
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60)
    return {
      short: `${minutes}m ago`,
      spoken: `${minutes} ${plural(minutes, 'minute', 'minutes')} ago`,
    };
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return { short: `${hours}h ago`, spoken: `${hours} ${plural(hours, 'hour', 'hours')} ago` };
  const days = Math.floor(hours / 24);
  return { short: `${days}d ago`, spoken: `${days} ${plural(days, 'day', 'days')} ago` };
}

/** Badge text: counts above 99 read "99+". */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, Math.floor(count)));
}
