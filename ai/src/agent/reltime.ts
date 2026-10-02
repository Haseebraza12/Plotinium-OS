/**
 * Relative dates resolved by the kernel in the user's time zone (agentic-shell.md §3.12
 * "Expansion"; AGT-07).
 *
 * - `rolling`: `[now − count·unit, now]` ("in the last 3 days"); months step by calendar month.
 * - `calendar`: the `count` whole calendar units before the current one ("yesterday", "last
 *   week", "last month"); weeks are ISO weeks starting Monday.
 * `within` selects the interval; `olderThan` selects everything before its start.
 * The absolute interval is printed in the dry run and returned as `resolved`.
 */
import type { RelSpan } from '@plotinium/protocol';

import { isoWithOffset, localParts, tzOffsetMinutes } from './envelope.ts';

export interface Interval {
  /** Inclusive start, epoch ms (`-Infinity` for an open start). */
  from: number;
  /** Exclusive end for calendar spans, inclusive `now` for rolling spans; epoch ms. */
  to: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The UTC instant of a local wall-clock time in `tz` (two passes absorb a DST change). */
export function localToUtc(tz: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - tzOffsetMinutes(wall, tz) * 60_000;
  guess = wall - tzOffsetMinutes(guess, tz) * 60_000;
  return guess;
}

function addMonths(y: number, mo: number, delta: number): { y: number; mo: number } {
  const idx = y * 12 + (mo - 1) + delta;
  return { y: Math.floor(idx / 12), mo: (idx % 12) + 1 };
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Start of the current calendar unit containing `now`, in `tz`. */
function unitStart(
  unit: RelSpan['unit'],
  now: number,
  tz: string,
): { y: number; mo: number; d: number; h: number } {
  const p = localParts(now, tz);
  switch (unit) {
    case 'hour':
      return { y: p.year, mo: p.month, d: p.day, h: p.hour };
    case 'day':
      return { y: p.year, mo: p.month, d: p.day, h: 0 };
    case 'week': {
      // ISO weeks start on Monday: getUTCDay of the local date, 0 = Sunday.
      const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
      const back = (dow + 6) % 7;
      const monday = new Date(Date.UTC(p.year, p.month - 1, p.day) - back * DAY);
      return {
        y: monday.getUTCFullYear(),
        mo: monday.getUTCMonth() + 1,
        d: monday.getUTCDate(),
        h: 0,
      };
    }
    case 'month':
      return { y: p.year, mo: p.month, d: 1, h: 0 };
  }
}

function shiftUnits(
  start: { y: number; mo: number; d: number; h: number },
  unit: RelSpan['unit'],
  n: number,
  tz: string,
): number {
  switch (unit) {
    case 'hour':
      return localToUtc(tz, start.y, start.mo, start.d, start.h) - n * HOUR;
    case 'day': {
      const t = new Date(Date.UTC(start.y, start.mo - 1, start.d) - n * DAY);
      return localToUtc(tz, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    case 'week': {
      const t = new Date(Date.UTC(start.y, start.mo - 1, start.d) - n * 7 * DAY);
      return localToUtc(tz, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    case 'month': {
      const m = addMonths(start.y, start.mo, -n);
      return localToUtc(tz, m.y, m.mo, 1);
    }
  }
}

/** The interval a `within` span selects. */
export function resolveSpan(span: RelSpan, now: number, tz: string): Interval {
  const mode = span.mode ?? 'rolling';
  if (mode === 'rolling') {
    switch (span.unit) {
      case 'hour':
        return { from: now - span.count * HOUR, to: now };
      case 'day':
        return { from: now - span.count * DAY, to: now };
      case 'week':
        return { from: now - span.count * 7 * DAY, to: now };
      case 'month': {
        const p = localParts(now, tz);
        const m = addMonths(p.year, p.month, -span.count);
        const d = Math.min(p.day, daysInMonth(m.y, m.mo));
        return { from: localToUtc(tz, m.y, m.mo, d, p.hour, p.minute) + p.second * 1000, to: now };
      }
    }
  }
  const start = unitStart(span.unit, now, tz);
  return {
    from: shiftUnits(start, span.unit, span.count, tz),
    to: shiftUnits(start, span.unit, 0, tz),
  };
}

export type RelTimeArg = { within: RelSpan } | { olderThan: RelSpan };

/** Whether an mtime falls in the selected range. */
export function matchesRelTime(mtime: number, arg: RelTimeArg, now: number, tz: string): boolean {
  if ('within' in arg) {
    const iv = resolveSpan(arg.within, now, tz);
    const mode = arg.within.mode ?? 'rolling';
    return mtime >= iv.from && (mode === 'rolling' ? mtime <= iv.to : mtime < iv.to);
  }
  return mtime < resolveSpan(arg.olderThan, now, tz).from;
}

/** The printable interval (`resolved` in FindRet and the dry run). */
export function describeRelTime(
  arg: RelTimeArg,
  now: number,
  tz: string,
): { from: string; to: string } {
  if ('within' in arg) {
    const iv = resolveSpan(arg.within, now, tz);
    return { from: isoWithOffset(iv.from, tz), to: isoWithOffset(iv.to, tz) };
  }
  return {
    from: isoWithOffset(0, tz),
    to: isoWithOffset(resolveSpan(arg.olderThan, now, tz).from, tz),
  };
}
