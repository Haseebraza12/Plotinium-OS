/**
 * `free [-h | -b | -k | -m | -g] [-s SECS] [-c COUNT] [--json]` (memory-and-paging.md §3.17.1):
 * `used + reserved + free = total` (the budget); the kernel line is reported but not charged.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import type { MemStatX, Unit } from '../lib/mem.ts';
import { freeBytes, unitSize } from '../lib/mem.ts';

export interface FreeOpts {
  readonly unit: Unit;
  readonly intervalMs: number | null;
  readonly count: number | null;
  readonly json: boolean;
}

const WIDTHS = [7, 11, 11, 11, 11, 11, 10, 11] as const;

function row(cells: readonly string[], note = ''): string {
  const body = cells
    .map((c, i) => (i === 0 ? c.padEnd(WIDTHS[0]) : c.padStart(WIDTHS[i] ?? 11)))
    .join('');
  return note === '' ? body : `${body}   ${note}`;
}

export function freeLines(m: MemStatX, unit: Unit): string[] {
  const u = (n: number | undefined): string => unitSize(n, unit);
  const localFree = m.localCap === undefined ? undefined : Math.max(0, m.localCap - m.swappedLocal);
  const pending =
    m.uploadPending === undefined
      ? ''
      : `: ${m.uploadPending} pending, ${m.uploadFailed ?? 0} failed`;
  return [
    row(['', 'total', 'used', 'free', 'reserved', 'pinned', 'specul.', 'avail']),
    row([
      'Mem:',
      u(m.budget),
      u(m.accounted),
      u(freeBytes(m)),
      u(m.reservedWaiting),
      u(m.pinned),
      u(m.speculative),
      u(m.avail),
    ]),
    row(['Swap-L:', u(m.localCap), u(m.swappedLocal), u(localFree)], `device ${m.device ?? '-'}`),
    row(['Swap-R:', '-', u(m.swappedRemote), '-'], `write-behind${pending}`),
    row(['Kernel:', '-', u(m.kernel), '-'], 'not charged'),
  ];
}

export default defineCommand<FreeOpts>({
  name: 'free',
  parse(args) {
    const p = parseFor('free', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    const units = (['b', 'k', 'm', 'g', 'h'] as const).filter((f) => p.has(f));
    if (units.length > 1) throw new UsageError('choose one of -h, -b, -k, -m and -g');
    const s = p.value('s');
    const c = p.value('c');
    const secs = s === undefined ? null : Number(s);
    const count = c === undefined ? null : Number(c);
    if (secs !== null && (!Number.isFinite(secs) || secs <= 0))
      throw new UsageError(`seconds argument '${s ?? ''}' failed`);
    if (count !== null && (!Number.isInteger(count) || count < 1))
      throw new UsageError(`count argument '${c ?? ''}' failed`);
    return {
      unit: units[0] ?? 'h',
      intervalMs: secs === null ? (count === null ? null : 1000) : Math.round(secs * 1000),
      count: secs === null && count === null ? 1 : count,
      json: p.has('json'),
    };
  },
  *run(io, opts) {
    for (let i = 0; opts.count === null || i < opts.count; i++) {
      if (i > 0) {
        yield* io.line();
        yield* io.flush();
        try {
          yield* io.sys.call('sleep', { ms: opts.intervalMs ?? 1000 });
        } catch (e) {
          if (mustErrno(e) === 'ECANCELED') return 0;
          throw e;
        }
      }
      try {
        const m: MemStatX = yield* io.sys.call('mem.stat', {});
        if (opts.json) yield* io.line(JSON.stringify(m));
        else yield* io.lines(freeLines(m, opts.unit));
      } catch (e) {
        yield* io.error(describe(e));
        return 1;
      }
    }
    return 0;
  },
});
