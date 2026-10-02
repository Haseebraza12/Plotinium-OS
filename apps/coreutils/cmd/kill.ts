/**
 * `kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID... | kill -l [NUM | SIGNAL]`
 * (processes-and-scheduling.md §3.18.4). The first dash argument is the signal; after it, a
 * negative number is a process group. `%JOB` needs the shell's job table (the builtin).
 */
import type { SignalName } from '@plotinium/protocol';
import { PID_MAX } from '@plotinium/protocol';

import { defineCommand, UsageError } from '../lib/command.ts';
import { describe, errnoText } from '../lib/errors.ts';
import { killList, parseSignal, translateSignal } from '../lib/signals.ts';

export type KillOpts =
  | { readonly mode: 'list'; readonly arg: string | null }
  | { readonly mode: 'send'; readonly sig: SignalName | 0; readonly targets: readonly string[] }
  | { readonly mode: 'bad-signal'; readonly text: string };

export function parseKill(args: readonly string[]): KillOpts {
  let sig: SignalName | 0 | null = null;
  const targets: string[] = [];
  let i = 0;
  const signal = (text: string): SignalName | 0 | undefined => parseSignal(text);
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      targets.push(...args.slice(i + 1));
      break;
    }
    if (a === '-l' || a === '-L') return { mode: 'list', arg: args[i + 1] ?? null };
    if (sig === null && (a === '-s' || a === '-n')) {
      const v = args[i + 1];
      if (v === undefined) throw new UsageError(`option requires an argument -- '${a.slice(1)}'`);
      const parsed = signal(v);
      if (parsed === undefined) return { mode: 'bad-signal', text: v };
      sig = parsed;
      i += 2;
      continue;
    }
    if (sig === null && targets.length === 0 && a.startsWith('-') && a.length > 1) {
      const parsed = signal(a.slice(1));
      if (parsed === undefined) return { mode: 'bad-signal', text: a.slice(1) };
      sig = parsed;
      i += 1;
      continue;
    }
    targets.push(a);
    i += 1;
  }
  if (targets.length === 0) throw new UsageError('not enough arguments');
  return { mode: 'send', sig: sig ?? 'SIGTERM', targets };
}

export default defineCommand<KillOpts>({
  name: 'kill',
  parse: parseKill,
  *run(io, opts) {
    if (opts.mode === 'bad-signal') {
      yield* io.error(`invalid signal '${opts.text}'`);
      return 2;
    }
    if (opts.mode === 'list') {
      if (opts.arg === null) {
        yield* io.line(killList());
        return 0;
      }
      const text = translateSignal(opts.arg);
      if (text === undefined) {
        yield* io.error(`invalid signal '${opts.arg}'`);
        return 2;
      }
      yield* io.line(text);
      return 0;
    }
    let status = 0;
    for (const target of opts.targets) {
      if (target.startsWith('%')) {
        yield* io.error(`${target}: no such job`);
        status = 1;
        continue;
      }
      const pid = Number(target);
      if (!Number.isInteger(pid) || target.trim() === '') {
        yield* io.error(`failed to parse argument: '${target}'`);
        status = 1;
        continue;
      }
      // Beyond PID_MAX no process or group can exist: that is ESRCH, although the kernel's
      // argument check would answer EINVAL for the out-of-range number (UI-159).
      if (Math.abs(pid) > PID_MAX) {
        yield* io.error(`(${pid}) - ${errnoText('ESRCH')}`);
        status = 1;
        continue;
      }
      try {
        yield* io.sys.call('kill', { pid, sig: opts.sig });
      } catch (e) {
        yield* io.error(`(${pid}) - ${describe(e)}`);
        status = 1;
      }
    }
    return status;
  },
});
