/**
 * `shutdown [-h | -r] [now | +MIN | HH:MM] [MESSAGE]` and `shutdown -c` (shell-and-terminal.md
 * §3.14.41, BOOT-12). The kernel runs the orderly sequence and prints its progress.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import type { Io } from '../lib/io.ts';
import { extCall } from '../lib/sys.ts';
import type { SysGen } from '../lib/sys.ts';

export type When =
  | { readonly kind: 'now' }
  | { readonly kind: 'in'; readonly minutes: number }
  | { readonly kind: 'at'; readonly hh: number; readonly mm: number };

export interface ShutdownOpts {
  readonly reboot: boolean;
  readonly cancel: boolean;
  readonly when: When;
  readonly message: string;
}

/** The maximum delay the `shutdown` and `reboot` calls accept (one hour). */
const MAX_DELAY_MS = 3_600_000;

export function parseWhen(text: string | undefined): When | null {
  if (text === undefined || text === 'now') return { kind: 'now' };
  const plus = /^\+(\d+)$/.exec(text);
  if (plus !== null) return { kind: 'in', minutes: Number(plus[1]) };
  const at = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (at !== null && Number(at[1]) < 24 && Number(at[2]) < 60)
    return { kind: 'at', hh: Number(at[1]), mm: Number(at[2]) };
  return null;
}

/** Milliseconds from `nowMs` until the time, the next occurrence for HH:MM in local time. */
export function delayMs(when: When, nowMs: number, tzOffsetMin: number): number {
  if (when.kind === 'now') return 0;
  if (when.kind === 'in') return when.minutes * 60_000;
  const local = new Date(nowMs + tzOffsetMin * 60_000);
  const target =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), when.hh, when.mm) -
    tzOffsetMin * 60_000;
  return target > nowMs ? target - nowMs : target + 86_400_000 - nowMs;
}

function* schedule(io: Io, reboot: boolean, delay: number): SysGen<void> {
  if (reboot) yield* io.sys.call('reboot', { delayMs: delay });
  else yield* io.sys.call('shutdown', { delayMs: delay });
}

export default defineCommand<ShutdownOpts>({
  name: 'shutdown',
  parse(args) {
    const p = parseFor('shutdown', args);
    if (p.has('h') && p.has('r')) throw new UsageError('-h and -r are mutually exclusive');
    const [first, ...rest] = p.operands;
    const when = parseWhen(first);
    const words = when === null || first === undefined ? p.operands : rest;
    return {
      reboot: p.has('r'),
      cancel: p.has('c'),
      when: when ?? { kind: 'now' },
      message: words.join(' '),
    };
  },
  *run(io, opts) {
    try {
      if (opts.cancel) {
        yield* extCall(io.sys, 'shutdown.cancel', {});
        return 0;
      }
      const now = yield* io.sys.call('time.now', {});
      const delay = delayMs(opts.when, now.epochMs, now.tzOffsetMin);
      if (delay > MAX_DELAY_MS) {
        yield* io.error('the delay may be at most 60 minutes');
        return 1;
      }
      if (delay > 0) {
        const minutes = Math.round(delay / 60_000);
        const notice = `Plotinium is going down for ${opts.reboot ? 'reboot' : 'halt'} in ${minutes} minute${minutes === 1 ? '' : 's'}`;
        yield* io.line(opts.message === '' ? notice : `${notice}: ${opts.message}`);
        yield* io.flush();
      }
      yield* schedule(io, opts.reboot, delay);
      return 0;
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
  },
});
