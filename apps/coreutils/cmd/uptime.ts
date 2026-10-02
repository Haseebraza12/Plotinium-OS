/** `uptime [-p] [-s]` (shell-and-terminal.md §3.14.37). */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { clock, dateTime, prettyUp, upString } from '../lib/format.ts';

export interface UptimeOpts {
  readonly mode: 'default' | 'pretty' | 'since';
}

export function uptimeLine(
  nowMs: number,
  tz: number,
  up: { uptimeMs: number; users: number; load: readonly number[] },
): string {
  const users = `${up.users} user${up.users === 1 ? '' : 's'}`;
  const load = up.load.map((l) => l.toFixed(2)).join(', ');
  return ` ${clock(nowMs, tz)} up ${upString(up.uptimeMs)},  ${users},  load average: ${load}`;
}

export default defineCommand<UptimeOpts>({
  name: 'uptime',
  parse(args) {
    const p = parseFor('uptime', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    return { mode: p.has('p') ? 'pretty' : p.has('s') ? 'since' : 'default' };
  },
  *run(io, opts) {
    try {
      const up = yield* io.sys.call('uptime', {});
      const now = yield* io.sys.call('time.now', {});
      if (opts.mode === 'pretty') yield* io.line(prettyUp(up.uptimeMs));
      else if (opts.mode === 'since') {
        const secs = String(
          Math.floor((up.bootAt + now.tzOffsetMin * 60_000) / 1000) % 60,
        ).padStart(2, '0');
        yield* io.line(`${dateTime(up.bootAt, now.tzOffsetMin)}:${secs}`);
      } else yield* io.line(uptimeLine(now.epochMs, now.tzOffsetMin, up));
      return 0;
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
  },
});
