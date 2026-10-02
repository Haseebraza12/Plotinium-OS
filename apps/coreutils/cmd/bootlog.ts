/**
 * `bootlog [--critical-path] [--services] [--list] [--boot N] [-v] [--json]`
 * (shell-and-terminal.md §3.14.38, boot-and-services.md §5.8).
 *
 * TODO(R5): protocol `bootlog` returns log lines, the critical-path service names and the total
 * only (`boot: 'current' | 'previous'`). The stage and service tables, per-service slack and
 * `--boot <seq>` need the CriticalPathRow shape of boot-and-services.md §4.7; until then timings
 * are taken from each service's first and last log line. `--list` prints the stored boot records
 * (`list: true`, boot-and-services.md §4.6, UI-135).
 */
import type { BootLogEntry, BootSummary } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { dateTime, table } from '../lib/format.ts';

export interface BootlogOpts {
  readonly criticalPath: boolean;
  readonly services: boolean;
  readonly list: boolean;
  readonly boot: 'current' | 'previous';
  readonly verbose: boolean;
  readonly json: boolean;
}

export function parseBoot(text: string | undefined): 'current' | 'previous' | null {
  if (text === undefined || text === 'current' || text === '0') return 'current';
  if (text === 'previous' || text === '-1' || text === '1') return 'previous';
  return null;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly level: string;
}

/** First and last log time of each subsystem, with its worst level. */
export function spans(entries: readonly BootLogEntry[]): Map<string, Span> {
  const out = new Map<string, Span>();
  const rank = ['info', 'warn', 'degraded', 'fail', 'panic'];
  for (const e of entries) {
    const s = out.get(e.sub);
    const level =
      s === undefined || rank.indexOf(e.level) > rank.indexOf(s.level) ? e.level : s.level;
    out.set(e.sub, { start: s?.start ?? e.t, end: e.t, level });
  }
  return out;
}

const secs = (t: number): string => t.toFixed(3);
const ms = (a: number, b: number): string => `${Math.round((b - a) * 1000)} ms`;

export function summary(boot: string, totalMs: number): string {
  return `boot · ${boot} · ${(totalMs / 1000).toFixed(3)} s to desktop-interactive`;
}

export function verboseLines(entries: readonly BootLogEntry[]): string[] {
  return entries.map((e) => `[${e.t.toFixed(3).padStart(10)}] ${e.sub}: ${e.msg}`);
}

export function criticalLines(path: readonly string[], entries: readonly BootLogEntry[]): string[] {
  const s = spans(entries);
  return path.map((name, i) => {
    const span = s.get(name);
    const gated = i === 0 ? '' : `   gated by ${path[i - 1] ?? ''}`;
    if (span === undefined) return `svc    ${name.padEnd(11)} -`;
    return `svc    ${name.padEnd(11)} ${secs(span.start)} → ${secs(span.end)}  ${ms(span.start, span.end).padStart(7)}${gated}`;
  });
}

export function serviceLines(entries: readonly BootLogEntry[]): string[] {
  const rows = [...spans(entries)].map(([name, sp]) => [
    name,
    secs(sp.start),
    secs(sp.end),
    ms(sp.start, sp.end),
    sp.level,
  ]);
  return table([['SERVICE', 'START', 'END', 'DURATION', 'STATUS'], ...rows], new Set([1, 2, 3]));
}

export function degradedLine(entries: readonly BootLogEntry[]): string | null {
  const bad = [...spans(entries)]
    .filter(([, sp]) => sp.level === 'degraded' || sp.level === 'fail')
    .map(([n]) => n);
  return bad.length === 0 ? null : `degraded: ${bad.join(', ')}`;
}

/** A stored boot's outcome in words: a boot that reached the desktop is `ok`. */
function outcomeWord(b: BootSummary): string {
  if (b.outcome === 'interactive') return 'ok';
  if (b.outcome === 'incomplete' && b.reachedLogin) return 'at login';
  return b.outcome;
}

/**
 * `bootlog --list`: one line per stored boot, newest first, as shell-and-terminal.md §3.14.38
 * shows it (`#37  2026-11-14 10:00  normal  0.73 s  ok`); the running boot is marked.
 */
export function listLines(boots: readonly BootSummary[], tzOffsetMin: number): string[] {
  if (boots.length === 0) return ['no stored boots'];
  const rows = boots.map((b) => [
    `#${String(b.seq)}`,
    dateTime(b.at, tzOffsetMin),
    b.profile,
    b.bootMs === null ? '-' : `${(b.bootMs / 1000).toFixed(2)} s`,
    `${outcomeWord(b)}${b.current ? '  (this boot)' : ''}`,
  ]);
  return table(rows, new Set([3]), 2);
}

export default defineCommand<BootlogOpts>({
  name: 'bootlog',
  parse(args) {
    const p = parseFor('bootlog', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    const boot = parseBoot(p.value('boot'));
    if (boot === null)
      throw new UsageError(
        `--boot ${p.value('boot') ?? ''}: only 'current' and 'previous' are available`,
      );
    return {
      criticalPath: p.has('critical-path'),
      services: p.has('services'),
      list: p.has('list'),
      boot,
      verbose: p.has('v'),
      json: p.has('json'),
    };
  },
  *run(io, opts) {
    try {
      if (opts.list) {
        const listed = yield* io.sys.call('bootlog', { list: true });
        const boots = listed.boots ?? [];
        if (opts.json) {
          yield* io.line(JSON.stringify(boots));
          return 0;
        }
        const tz = yield* io.tzOffset();
        yield* io.lines(listLines(boots, tz));
        return 0;
      }
      const log = yield* io.sys.call('bootlog', {
        criticalPath: opts.criticalPath,
        verbose: opts.verbose,
        boot: opts.boot,
      });
      if (opts.json) {
        yield* io.line(JSON.stringify(log));
        return 0;
      }
      yield* io.line(summary(opts.boot, log.totalMs));
      if (opts.verbose) yield* io.lines(verboseLines(log.entries));
      else if (opts.criticalPath)
        yield* io.lines(criticalLines(log.criticalPath ?? [], log.entries));
      else {
        yield* io.lines(serviceLines(log.entries));
        const degraded = degradedLine(log.entries);
        if (degraded !== null) yield* io.line(degraded);
      }
      return 0;
    } catch (e) {
      const errno = mustErrno(e);
      yield* io.error(errno === 'ENOENT' ? `no boot ${opts.boot}` : describe(e));
      return 1;
    }
  },
});
