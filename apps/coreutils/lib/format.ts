/** Output formatting shared by the commands (shell-and-terminal.md §3.13). */
import type { InodeType } from '@plotinium/protocol';

const RWX = ['r', 'w', 'x'] as const;

/** The nine permission bits plus `t`/`T` for the sticky bit, e.g. `rwxr-x--T`. */
export function permString(mode: number): string {
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 0; bit < 3; bit++) {
      out += (mode >> (shift + 2 - bit)) & 1 ? RWX[bit] : '-';
    }
  }
  if ((mode & 0o1000) !== 0) {
    out = out.slice(0, 8) + (out.endsWith('x') ? 't' : 'T');
  }
  return out;
}

export function typeChar(type: InodeType): string {
  return type === 'd' ? 'd' : type === 'l' ? 'l' : '-';
}

export function modeString(type: InodeType, mode: number): string {
  return typeChar(type) + permString(mode);
}

export function octal(mode: number, width = 4): string {
  return (mode & 0o7777).toString(8).padStart(width, '0');
}

/** Base 1024 with K M G T, one decimal below 10 (`4.0K`, `18M`, `1.9G`). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const units = ['K', 'M', 'G', 'T'] as const;
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  // Rounding up may reach 1024 of a unit (1023.99M): that is 1.0 of the next one, as GNU prints
  // it, so `df -h` never shows `1024M` beside `1.0G` (UI-159).
  const next = units[units.indexOf(unit as (typeof units)[number]) + 1];
  if (Math.ceil(value) >= 1024 && next !== undefined) return `1.0${next}`;
  const tenths = Math.ceil(value * 10) / 10;
  if (tenths < 10) return `${tenths.toFixed(1)}${unit}`;
  return `${Math.ceil(value)}${unit}`;
}

/** MiB with one decimal and an `M` suffix (`free`, `top`). */
export function mib(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)}M`;
}

/** `1,204` */
export function thousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock parts of an epoch ms for a fixed UTC offset in minutes. */
function parts(epochMs: number, offsetMin: number): Date {
  return new Date(epochMs + offsetMin * 60_000);
}

/** `YYYY-MM-DD HH:MM` */
export function dateTime(epochMs: number, offsetMin: number): string {
  const d = parts(epochMs, offsetMin);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** `HH:MM:SS` */
export function clock(epochMs: number, offsetMin: number): string {
  const d = parts(epochMs, offsetMin);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** `HH:MM:SS.mmm` */
export function clockMs(epochMs: number, offsetMin: number): string {
  const d = parts(epochMs, offsetMin);
  return `${clock(epochMs, offsetMin)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

/** `+0500` */
export function offsetString(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`;
}

/** `YYYY-MM-DD HH:MM:SS.mmm +0500` (stat). */
export function fullTime(epochMs: number, offsetMin: number): string {
  const d = parts(epochMs, offsetMin);
  return `${dateTime(epochMs, offsetMin)}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} ${offsetString(offsetMin)}`;
}

// C0, DEL and C1 controls plus the bidirectional controls (SHL-13).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Names printed to a terminal have control and bidi characters replaced by `?` (SHL-13). */
export function escapeName(name: string, tty: boolean): string {
  return tty ? name.replace(UNSAFE, '?') : name;
}

export function padLeft(s: string | number, width: number): string {
  return String(s).padStart(width);
}

export function padRight(s: string | number, width: number): string {
  return String(s).padEnd(width);
}

/**
 * Aligns rows of cells into columns separated by `gap` spaces; `right` lists right-aligned columns
 * and `min` gives minimum column widths.
 */
export function table(
  rows: readonly (readonly string[])[],
  right: ReadonlySet<number> = new Set(),
  gap = 1,
  min: readonly number[] = [],
): string[] {
  const widths: number[] = [...min];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const w = widths[i] ?? 0;
        const last = i === row.length - 1;
        if (right.has(i)) return cell.padStart(w);
        return last ? cell : cell.padEnd(w);
      })
      .join(' '.repeat(gap)),
  );
}

/** `12 min`, `2:05`, `3 days, 2:05` (uptime and top). */
export function upString(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const hm = hours > 0 ? `${hours}:${two(mins)}` : `${mins} min`;
  if (days === 0) return hm;
  return `${days} day${days === 1 ? '' : 's'}, ${hm}`;
}

/** `up 12 minutes`, `up 1 day, 2 hours, 5 minutes` (uptime -p). */
export function prettyUp(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const units: [number, string][] = [
    [Math.floor(totalMin / 1440), 'day'],
    [Math.floor((totalMin % 1440) / 60), 'hour'],
    [totalMin % 60, 'minute'],
  ];
  const shown = units.filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`);
  return `up ${shown.length === 0 ? '0 minutes' : shown.join(', ')}`;
}

/** CPU time as `MM:SS.cc` with minutes unbounded (`1:02.31`, top TIME+). */
export function cpuPlus(ms: number): string {
  const totalCs = Math.floor(ms / 10);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  return `${mins}:${two(secs)}.${two(totalCs % 100)}`;
}

/** CPU time as `HH:MM:SS` (ps TIME). */
export function cpuTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Kernel-command sizes (processes-and-scheduling.md §3.18): `0B`, `512B`, `82.2K`, `2.1M`, `2.0G`. */
export function binSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ['K', 'M', 'G', 'T'] as const;
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i] ?? 'T'}`;
}

/** Elapsed time as `H:MM:SS` (top's uptime). */
export function hms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Code-point order (C.UTF-8 collation, C7); `<` on strings compares UTF-16 units instead. */
export function byCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const d = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

/** `1 directory` / `3 directories`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
