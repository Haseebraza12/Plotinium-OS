/**
 * Option parsing driven by the man-page front matter (shell-and-terminal.md §3.12: one source of
 * flags for parsing, `--help`, completion and `man`). GNU conventions: combined short flags
 * (`-la`), attached or separate arguments (`-n5`, `-n 5`, `--sort=pid`, `--sort pid`), `--` ends
 * options, `-` alone is an operand. Options and operands may be interleaved unless the command
 * asks to stop at the first operand (`nice`, `su`).
 */

export interface FlagSpec {
  readonly short: string | null;
  readonly long: string | null;
  readonly arg: string | null;
  /** `--color[=WHEN]`: the argument may only be attached with `=`. */
  readonly optionalArg: boolean;
  /** The man page's one-line description, printed by `--help`. */
  readonly desc?: string;
}

export interface CommandSpec {
  readonly synopsis: string;
  readonly summary: string;
  readonly flags: readonly FlagSpec[];
}

export type ArgSpecTable = Readonly<Record<string, CommandSpec>>;

/** A usage error: the command prints it with the usage lines and exits 2 (SHL-07). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  /** Keyed by the short letter when the flag has one, else by the long name without dashes. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly operands: readonly string[];
  has(key: string): boolean;
  /** The last value given for a flag that takes an argument. */
  value(key: string): string | undefined;
  values(key: string): readonly string[];
}

export interface ParseOptions {
  readonly stopAtFirstOperand?: boolean;
}

function keyOf(flag: FlagSpec): string {
  if (flag.short !== null) return flag.short.slice(1);
  return (flag.long ?? '').slice(2);
}

function makeParsed(flags: Map<string, string[]>, operands: string[]): ParsedArgs {
  return {
    flags,
    operands,
    has: (key) => flags.has(key),
    value: (key) => flags.get(key)?.at(-1),
    values: (key) => flags.get(key) ?? [],
  };
}

function record(flags: Map<string, string[]>, flag: FlagSpec, value: string): void {
  const key = keyOf(flag);
  const list = flags.get(key) ?? [];
  list.push(value);
  flags.set(key, list);
}

function parseLong(
  cmd: string,
  spec: CommandSpec,
  arg: string,
  next: string | undefined,
  flags: Map<string, string[]>,
): number {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  const matches = spec.flags.filter((fl) => fl.long !== null && fl.long.startsWith(name));
  const exact = matches.find((fl) => fl.long === name);
  const flag = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (flag === undefined) {
    throw new UsageError(
      matches.length > 1
        ? `${cmd}: option '${name}' is ambiguous`
        : `${cmd}: unrecognized option '${arg}'`,
    );
  }
  if (flag.arg === null) {
    if (eq !== -1) throw new UsageError(`${cmd}: option '${name}' doesn't allow an argument`);
    record(flags, flag, '');
    return 0;
  }
  if (eq !== -1) {
    record(flags, flag, arg.slice(eq + 1));
    return 0;
  }
  if (flag.optionalArg) {
    record(flags, flag, '');
    return 0;
  }
  if (next === undefined) throw new UsageError(`${cmd}: option '${name}' requires an argument`);
  record(flags, flag, next);
  return 1;
}

function parseShort(
  cmd: string,
  spec: CommandSpec,
  arg: string,
  next: string | undefined,
  flags: Map<string, string[]>,
): number {
  for (let i = 1; i < arg.length; i++) {
    const ch = arg.charAt(i);
    const flag = spec.flags.find((fl) => fl.short === `-${ch}`);
    if (flag === undefined) throw new UsageError(`${cmd}: invalid option -- '${ch}'`);
    if (flag.arg === null) {
      record(flags, flag, '');
      continue;
    }
    const rest = arg.slice(i + 1);
    if (rest.length > 0) {
      record(flags, flag, rest);
      return 0;
    }
    if (next === undefined) throw new UsageError(`${cmd}: option requires an argument -- '${ch}'`);
    record(flags, flag, next);
    return 1;
  }
  return 0;
}

export function parseArgs(
  cmd: string,
  spec: CommandSpec,
  args: readonly string[],
  options: ParseOptions = {},
): ParsedArgs {
  const flags = new Map<string, string[]>();
  const operands: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    const next = args[i + 1];
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      i += 1 + parseLong(cmd, spec, arg, next, flags);
    } else if (arg.startsWith('-') && arg.length > 1) {
      i += 1 + parseShort(cmd, spec, arg, next, flags);
    } else if (options.stopAtFirstOperand === true) {
      operands.push(...args.slice(i));
      break;
    } else {
      operands.push(arg);
      i += 1;
    }
  }
  return makeParsed(flags, operands);
}
