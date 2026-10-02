/**
 * The common program shell of every command (processes-and-scheduling.md §3.5, shell spec §4.2):
 * `init(argv)` parses the options into plain, serialisable state; `*run` prints usage errors
 * (status 2), `--help` (SHL-15), runs the command and flushes stdout. A closed pipe ends the command
 * quietly with 141 (SIGPIPE), as the shell expects (§3.7.3).
 */
import type { SignalName } from '@plotinium/protocol';

import type { CommandSpec, ParsedArgs, ParseOptions } from './argspec.ts';
import { parseArgs, UsageError } from './argspec.ts';
import { ARGSPEC } from './argspec.gen.ts';
import { describe } from './errors.ts';
import { Io, PipeClosed } from './io.ts';
import type { Program, ProgramContext, SysGen } from './sys.ts';
import { errnoOf } from './sys.ts';

export type CommandName = keyof typeof ARGSPEC;

export interface CommandState<O> {
  readonly argv: readonly string[];
  readonly opts: O | null;
  readonly usage: string | null;
  readonly help: boolean;
  /** Signals the command catches, in arrival order; the signal hook appends, `run` consumes. */
  readonly caught: SignalName[];
}

export interface CommandDef<O> {
  readonly name: CommandName;
  /** Turns the operands and options (argv without argv[0]) into options; throws UsageError. */
  parse(args: readonly string[]): O;
  run(io: Io, opts: O, st: CommandState<O>): SysGen<number>;
  /** `false` for commands whose operands may legitimately be `--help` (echo). */
  readonly helpFlag?: boolean;
  /** Signals delivered to the catch hook instead of their default action. */
  readonly catches?: readonly SignalName[];
}

export function specOf(name: CommandName): CommandSpec {
  return ARGSPEC[name];
}

/** Parses with the command's man-page flags. */
export function parseFor(
  name: CommandName,
  args: readonly string[],
  options?: ParseOptions,
): ParsedArgs {
  return parseArgs(name, specOf(name), args, options);
}

/** The synopsis split into its alternative forms (`kill … | kill -l [NUM]`). */
export function synopsisForms(name: string, synopsis: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < synopsis.length; i++) {
    const c = synopsis.charAt(i);
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (depth === 0 && synopsis.startsWith(` | ${name}`, i)) {
      forms.push(synopsis.slice(start, i));
      start = i + 3;
    }
  }
  forms.push(synopsis.slice(start));
  return forms;
}

export function usageText(name: CommandName, message: string): string {
  const forms = synopsisForms(name, specOf(name).synopsis);
  const usage = forms.map((form, i) => (i === 0 ? `Usage: ${form}` : `       ${form}`));
  // The option parser's messages already carry the command name.
  const first = message.startsWith(`${name}: `) ? message : `${name}: ${message}`;
  return [first, ...usage, `Try 'man ${name}'.`, ''].join('\n');
}

export function helpText(name: CommandName): string {
  const spec = specOf(name);
  const forms = synopsisForms(name, spec.synopsis);
  const lines = forms.map((form, i) => (i === 0 ? `Usage: ${form}` : `       ${form}`));
  lines.push(`${name} — ${spec.summary}`);
  if (spec.flags.length > 0) {
    lines.push('', 'Options:');
    const labels = spec.flags.map((flag) => {
      const names = [flag.short, flag.long].filter((n): n is string => n !== null).join(', ');
      const arg = flag.arg === null ? '' : flag.optionalArg ? `[=${flag.arg}]` : ` ${flag.arg}`;
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

function wantsHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--help') return true;
  }
  return false;
}

export function defineCommand<O>(def: CommandDef<O>): Program<CommandState<O>> {
  const catches = new Set<SignalName>(def.catches ?? []);
  return {
    init(argv: readonly string[]): CommandState<O> {
      const args = argv.slice(1);
      const base = { argv: [...argv], caught: [] as SignalName[] };
      if (def.helpFlag !== false && wantsHelp(args)) {
        return { ...base, opts: null, usage: null, help: true };
      }
      try {
        return { ...base, opts: def.parse(args), usage: null, help: false };
      } catch (e) {
        if (e instanceof UsageError) return { ...base, opts: null, usage: e.message, help: false };
        throw e;
      }
    },

    *run(ctx: ProgramContext, st: CommandState<O>): SysGen<number> {
      const io = new Io(def.name, ctx);
      try {
        if (st.help) {
          yield* io.out(helpText(def.name));
          yield* io.flush();
          return 0;
        }
        if (st.usage !== null || st.opts === null) {
          yield* io.errRaw(usageText(def.name, st.usage ?? 'missing operand'));
          return 2;
        }
        if (catches.size > 0) {
          for (const sig of catches) yield* ctx.sys.call('sig.action', { sig, action: 'catch' });
        }
        const status = yield* def.run(io, st.opts, st);
        yield* io.flush();
        return status;
      } catch (e) {
        if (e instanceof PipeClosed || errnoOf(e) === 'EPIPE') return 141;
        if (e instanceof UsageError) {
          yield* io.errRaw(usageText(def.name, e.message));
          return 2;
        }
        // A failed call the command did not expect (ENOSYS from a kernel without the call, for
        // example): the usual diagnostic and status 1, never a crash (UI-054). Program errors
        // (no errno) still propagate.
        if (errnoOf(e) !== undefined) {
          try {
            yield* io.flush();
          } catch {
            // Output that cannot be delivered any more is dropped; the diagnostic still goes out.
          }
          yield* io.error(describe(e));
          return 1;
        }
        throw e;
      }
    },

    signal(_ctx: ProgramContext, st: CommandState<O>, sig: SignalName): void {
      if (catches.has(sig)) st.caught.push(sig);
    },
  };
}

export { UsageError };
