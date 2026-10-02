/**
 * The common program shell of the demo programs (processes-and-scheduling.md §3.5, KPS-03):
 * `init(argv)` parses the options (flags come from the man front matter, SHL-12) into plain,
 * serialisable state; `*run` prints usage errors (status 2) and `--help`, registers the signals
 * the program catches, and turns a closed pipe into status 141.
 *
 * Programs use @plotinium/kernel/sys (the executor's `ctx`), the only kernel module apps may
 * import (SYS-01). Caught signals are appended to `st.caught` by the synchronous hook; the program
 * consumes them at its next yield point, so the state stays serialisable and restart-safe.
 */
import type { Errno, SignalName } from '@plotinium/protocol';
import { signalExitStatus, strerror } from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { CommandSpec, ParsedArgs } from '../../coreutils/lib/argspec.ts';
import { parseArgs, UsageError } from '../../coreutils/lib/argspec.ts';
import { DEMO_ARGSPEC } from './argspec.gen.ts';

export { UsageError };
export type { ParsedArgs };

export type DemoName = keyof typeof DEMO_ARGSPEC;

export function specOf(name: DemoName): CommandSpec {
  return DEMO_ARGSPEC[name];
}

/** Parses `args` (argv without argv[0]) with the command's man-page flags. */
export function parseFor(name: DemoName, args: readonly string[]): ParsedArgs {
  return parseArgs(name, specOf(name), args);
}

export function usageText(name: DemoName, message: string): string {
  const first = message.startsWith(`${name}: `) ? message : `${name}: ${message}`;
  return [first, `Usage: ${specOf(name).synopsis}`, `Try 'man ${name}'.`, ''].join('\n');
}

export function helpText(name: DemoName): string {
  const spec = specOf(name);
  const lines = [`Usage: ${spec.synopsis}`, `${name} — ${spec.summary}`];
  if (spec.flags.length > 0) {
    lines.push('', 'Options:');
    const labels = spec.flags.map((flag) => {
      const names = [flag.short, flag.long].filter((n): n is string => n !== null).join(', ');
      const arg = flag.arg === null ? '' : ` ${flag.arg}`;
      return `${flag.short === null ? '    ' : ''}${names}${arg}`;
    });
    const width = Math.max(...labels.map((l) => l.length));
    spec.flags.forEach((flag, i) => {
      lines.push(`  ${(labels[i] ?? '').padEnd(width)}  ${flag.desc ?? ''}`.trimEnd());
    });
  }
  lines.push('', `See 'man ${name}' for details.`, '');
  return lines.join('\n');
}

// -----------------------------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------------------------

/**
 * Terminal texts of shell-and-terminal.md §3.13; they differ from protocol's `strerror` for EBUSY
 * and ETIMEDOUT (the shell spec is normative for what a terminal shows).
 */
const TERMINAL_TEXT: Partial<Record<Errno, string>> = {
  EBUSY: 'Resource busy',
  ETIMEDOUT: 'Timed out',
};

export function errnoText(errno: Errno): string {
  return TERMINAL_TEXT[errno] ?? strerror(errno);
}

/** `detail.reason` of a failed call, when the kernel gave one. */
export function reasonOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('detail' in e)) return undefined;
  const detail: unknown = e.detail;
  if (typeof detail !== 'object' || detail === null || !('reason' in detail)) return undefined;
  const reason: unknown = detail.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** Terminal text of a failed system call, with ` (reason)`; rethrows anything else. */
export function errText(e: unknown): string {
  const errno = errnoOf(e);
  if (errno === undefined) throw e;
  const reason = reasonOf(e);
  return reason === undefined ? errnoText(errno) : `${errnoText(errno)} (${reason})`;
}

// -----------------------------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  const b = encoder.encode(text);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Thrown when stdout or stderr has no reader any more; the program ends with 141. */
export class PipeClosed extends Error {
  constructor() {
    super('pipe closed');
    this.name = 'PipeClosed';
  }
}

/** Unbuffered stdout and stderr for a demo program (they print a few lines each). */
export class Out {
  readonly name: DemoName;
  readonly ctx: ProgramContext;
  private readonly ttys = new Map<number, boolean>();

  constructor(name: DemoName, ctx: ProgramContext) {
    this.name = name;
    this.ctx = ctx;
  }

  /** Writes all of `text` to `fd`, continuing after short writes. */
  *write(fd: number, text: string): SysGen<void> {
    if (text.length === 0) return;
    let data = bytesOf(text);
    while (data.byteLength > 0) {
      let wrote: number;
      try {
        wrote = (yield* this.ctx.sys.write({ fd, data })).bytes;
      } catch (e) {
        if (errnoOf(e) === 'EPIPE') throw new PipeClosed();
        throw e;
      }
      if (wrote >= data.byteLength || wrote === 0) return;
      data = data.slice(wrote);
    }
  }

  /** One line on stdout. */
  *line(text: string): SysGen<void> {
    yield* this.write(1, `${text}\n`);
  }

  /** `<name>: <message>` on stderr. */
  *error(message: string): SysGen<void> {
    yield* this.write(2, `${this.name}: ${message}\n`);
  }

  /** True when `fd` is a terminal; cached for the life of the process (not part of the state). */
  *isTty(fd: number): SysGen<boolean> {
    const known = this.ttys.get(fd);
    if (known !== undefined) return known;
    let tty = false;
    try {
      tty = (yield* this.ctx.sys.isatty({ fd })).tty;
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
    this.ttys.set(fd, tty);
    return tty;
  }
}

// -----------------------------------------------------------------------------------------------
// Program shell
// -----------------------------------------------------------------------------------------------

export interface DemoState<O, W> {
  readonly argv: readonly string[];
  readonly opts: O | null;
  readonly usage: string | null;
  readonly help: boolean;
  /** Program-specific state, built from the options in `init`; null after a usage error. */
  readonly w: W | null;
  /** Caught signals not yet handled, in arrival order: the hook appends, `run` consumes. */
  readonly caught: SignalName[];
}

export interface DemoDef<O, W> {
  readonly name: DemoName;
  readonly checkpointable?: boolean;
  /** Turns argv without argv[0] into options; throws UsageError. */
  parse(args: readonly string[]): O;
  /** The initial program state for these options (plain data only). */
  start(opts: O): W;
  run(ctx: ProgramContext, out: Out, opts: O, w: W, st: DemoState<O, W>): SysGen<number>;
  /** Signals delivered to the hook instead of their default action. */
  readonly catches?: readonly SignalName[];
}

/** Takes the next caught signal off the queue (null when none is pending). */
export function takeSignal(st: { readonly caught: SignalName[] }): SignalName | null {
  return st.caught.shift() ?? null;
}

/** Exit status of a program that ends because of caught signal `sig` (130, 143, …). */
export function statusFor(sig: SignalName): number {
  return signalExitStatus(sig);
}

export function defineDemo<O, W>(def: DemoDef<O, W>): Program<DemoState<O, W>> {
  const catches = new Set<SignalName>(def.catches ?? []);
  const program: Program<DemoState<O, W>> = {
    checkpointable: def.checkpointable ?? false,

    init(argv: readonly string[]): DemoState<O, W> {
      const args = argv.slice(1);
      const base = { argv: [...argv], caught: [] as SignalName[] };
      const dashDash = args.indexOf('--');
      if (args.slice(0, dashDash === -1 ? args.length : dashDash).includes('--help')) {
        return { ...base, opts: null, usage: null, help: true, w: null };
      }
      try {
        const opts = def.parse(args);
        return { ...base, opts, usage: null, help: false, w: def.start(opts) };
      } catch (e) {
        if (e instanceof UsageError)
          return { ...base, opts: null, usage: e.message, help: false, w: null };
        throw e;
      }
    },

    *run(ctx: ProgramContext, st: DemoState<O, W>): SysGen<number> {
      const out = new Out(def.name, ctx);
      try {
        if (st.help) {
          yield* out.write(1, helpText(def.name));
          return 0;
        }
        if (st.usage !== null || st.opts === null || st.w === null) {
          yield* out.write(2, usageText(def.name, st.usage ?? 'missing operand'));
          return 2;
        }
        // Re-issued after every restart: setting a disposition twice is harmless.
        for (const sig of catches) {
          try {
            yield* ctx.sys.call('sig.action', { sig, action: 'catch' });
          } catch (e) {
            if (errnoOf(e) === undefined) throw e;
          }
        }
        return yield* def.run(ctx, out, st.opts, st.w, st);
      } catch (e) {
        if (e instanceof PipeClosed || errnoOf(e) === 'EPIPE') return 141;
        throw e;
      }
    },

    signal(_ctx: ProgramContext, st: DemoState<O, W>, sig: SignalName): void {
      if (catches.has(sig)) st.caught.push(sig);
    },
  };
  return program;
}

// -----------------------------------------------------------------------------------------------
// Option values
// -----------------------------------------------------------------------------------------------

/** An integer option in [min, max]; throws UsageError with the command's wording. */
export function intOption(
  name: DemoName,
  flag: string,
  raw: string,
  min: number,
  max: number,
): number {
  const n = /^[+-]?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(
      `${name}: invalid ${flag} '${raw}' (an integer from ${String(min)} to ${String(max)})`,
    );
  }
  return n;
}

/** A decimal option in [min, max]. */
export function numberOption(
  name: DemoName,
  flag: string,
  raw: string,
  min: number,
  max: number,
): number {
  const n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(
      `${name}: invalid ${flag} '${raw}' (a number from ${String(min)} to ${String(max)})`,
    );
  }
  return n;
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  B: 1,
  K: 1_024,
  M: 1_048_576,
  G: 1_073_741_824,
};

/**
 * A size such as `512M`, `50K`, `1.5G` or `4096` (binary units, K = 1,024 bytes, as the process
 * and memory commands print them). `KiB`, `MB` and the like are accepted as the same unit.
 */
export function parseSize(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGkmg]?)(?:i?[Bb])?$/.exec(raw.trim());
  if (m === null) return null;
  const unit = SIZE_UNITS[(m[2] ?? '').toUpperCase()] ?? 1;
  const bytes = Math.round(Number(m[1]) * unit);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function sizeOption(
  name: DemoName,
  flag: string,
  raw: string,
  min: number,
  max: number,
): number {
  const bytes = parseSize(raw);
  if (bytes === null || bytes < min || bytes > max) {
    throw new UsageError(
      `${name}: invalid ${flag} '${raw}' (a size from ${binSize(min)} to ${binSize(max)}, e.g. 512M)`,
    );
  }
  return bytes;
}

// -----------------------------------------------------------------------------------------------
// Formatting (processes-and-scheduling.md §3.18: binary units with one decimal)
// -----------------------------------------------------------------------------------------------

/** `0B`, `512B`, `82.2K`, `512.0M`, `2.0G`. */
export function binSize(bytes: number): string {
  if (bytes < 1024) return `${String(Math.round(bytes))}B`;
  const units = ['K', 'M', 'G', 'T'] as const;
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i] ?? 'T'}`;
}

/** `1,204`. */
export function thousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Seconds with one decimal: `12.4 s`. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Local wall-clock time `HH:MM:SS.mmm` for an epoch time and a UTC offset in minutes. */
export function clockMs(epochMs: number, offsetMin: number): string {
  const d = new Date(epochMs + offsetMin * 60_000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

/** `/a/b/c` → `/a/b`, `c` → `.`. */
export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return trimmed.slice(0, cut);
}

export function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** `$HOME`, or `/home/<user>` from `$USER`, or `/`. */
export function homeOf(ctx: ProgramContext): string {
  const home = ctx.env.get('HOME');
  if (home !== undefined && home !== '') return home;
  const user = ctx.env.get('USER');
  return user !== undefined && user !== '' ? `/home/${user}` : '/';
}

/** Current wall-clock time from the kernel (`time.now`), stable across executors. */
export function* epochNow(ctx: ProgramContext): SysGen<{ epochMs: number; tzOffsetMin: number }> {
  const t = yield* ctx.sys.call('time.now', {});
  return { epochMs: t.epochMs, tzOffsetMin: t.tzOffsetMin };
}

/**
 * Sleeps `ms` on the kernel timer. A caught signal cancels the sleep (ECANCELED, reason
 * `signal`): that is not an error here, the caller looks at `st.caught` next.
 */
export function* nap(ctx: ProgramContext, ms: number): SysGen<void> {
  try {
    yield* ctx.sleep(Math.max(0, ms));
  } catch (e) {
    if (errnoOf(e) !== 'ECANCELED') throw e;
  }
}
