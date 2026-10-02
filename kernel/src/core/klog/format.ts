/**
 * Rendering of klog records: `dmesg` entries (protocol `KlogEntry`) and the verbose boot-log line
 * `[ssss.mmm] subsystem: message` of boot-and-services.md §3.7 (BOOT-05).
 */
import type { KlogEntry } from '@plotinium/protocol';

import type { KlogInput, KlogRecord } from './records.ts';
import { levelOf } from './records.ts';

const MSG_MAX = 1_024;
const SUB_MAX = 32;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Subsystem column of a record. */
export function subOf(rec: KlogInput): string {
  switch (rec.kind) {
    case 'line':
      return rec.sub;
    case 'proc':
      return 'proc';
    case 'trace':
      return 'trace';
    case 'mem':
      return 'mm';
  }
}

/** Message text of a record, without the subsystem prefix. */
export function messageOf(rec: KlogInput): string {
  switch (rec.kind) {
    case 'line':
      return rec.msg;
    case 'proc': {
      const edge =
        rec.from === null
          ? `${rec.to ?? '?'}`
          : rec.from === rec.to
            ? `${rec.from} (waiting on ${rec.waitingOn ?? '-'})`
            : `${rec.from} → ${rec.to ?? '(reaped)'}`;
      const extra = [
        rec.by === undefined ? '' : ` by ${String(rec.by)}`,
        rec.exitCode === undefined ? '' : ` exit ${String(rec.exitCode)}`,
        rec.detail === undefined ? '' : ` · ${rec.detail}`,
      ].join('');
      return `pid ${String(rec.pid)} ${edge} (${rec.reason})${extra}`;
    }
    case 'trace':
      return `pid ${String(rec.pid)} uid ${String(rec.uid)} ${rec.call} → ${rec.errno ?? 'ok'} ${String(Math.round(rec.us))} µs`;
    case 'mem': {
      const parts = [rec.ev];
      if (rec.pid !== undefined) parts.push(`pid ${String(rec.pid)}`);
      if (rec.pageId !== undefined) parts.push(`page ${String(rec.pageId)}`);
      if (rec.bytes !== undefined) parts.push(`${String(rec.bytes)} B`);
      if (rec.ms !== undefined) parts.push(`${rec.ms.toFixed(1)} ms`);
      if (rec.detail !== undefined) parts.push(rec.detail);
      return parts.join(' · ');
    }
  }
}

function pidOf(rec: KlogInput): number | undefined {
  if (rec.kind === 'line' || rec.kind === 'mem') return rec.pid;
  return rec.pid > 0 ? rec.pid : undefined;
}

/**
 * A record as `dmesg` returns it. `epochAtZero` is the wall-clock epoch (ms) of kernel time 0, so
 * the entry carries an epoch timestamp.
 */
export function toKlogEntry(rec: KlogRecord, epochAtZero: number): KlogEntry {
  const entry: KlogEntry = {
    seq: rec.seq,
    t: Math.max(0, Math.floor(epochAtZero + rec.t)),
    sub: clip(subOf(rec), SUB_MAX),
    level: levelOf(rec),
    msg: clip(messageOf(rec), MSG_MAX),
  };
  const pid = pidOf(rec);
  if (pid !== undefined && pid > 0) entry.pid = pid;
  return entry;
}

/** Text prefix per level, so colour is never the only signal (BOOT-05). */
const PREFIX: Readonly<Record<string, string>> = {
  warn: 'WARN ',
  degraded: 'DEGRADED ',
  fail: 'FAIL ',
  panic: 'KERNEL PANIC: ',
};

/** `[ssss.mmm] sub: msg` with `t` in seconds since boot t0. */
export function formatBootLine(tSeconds: number, sub: string, level: string, msg: string): string {
  const stamp = tSeconds.toFixed(3).padStart(9, ' ');
  return `[${stamp}] ${sub}: ${PREFIX[level] ?? ''}${msg}`;
}
