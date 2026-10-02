/**
 * `help [NAME]` (shell-and-terminal.md §3.14.44): the banner, builtins, command groups, syntax and
 * keys. The AI row is shown only when the AI commands are installed (SHL-18, AI-off build).
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import type { Io } from '../lib/io.ts';
import type { SysGen } from '../lib/sys.ts';

export interface HelpOpts {
  readonly name: string | null;
}

export const BUILTINS: Readonly<Record<string, readonly [synopsis: string, text: string]>> = {
  cd: [
    'cd [DIR | -]',
    'Change the working directory to DIR (default $HOME); - returns to $OLDPWD and prints it.',
  ],
  pwd: ['pwd [-L | -P]', 'Print the working directory.'],
  echo: [
    'echo [-n] [-e] [ARG...]',
    'Print the arguments separated by single spaces; -n omits the newline, -e interprets escapes.',
  ],
  export: [
    'export NAME[=VALUE]...',
    'Export shell variables to the environment of later commands.',
  ],
  unset: ['unset NAME...', 'Remove shell variables.'],
  exit: ['exit [N]', 'Leave the shell with status N; with stopped jobs, warn once first.'],
  history: [
    'history [-c] [N]',
    'Show the last N commands, numbered; -c clears the list, the file and the completions.',
  ],
  jobs: [
    'jobs [-l] [-p] [%JOB...]',
    'List jobs; -l adds the process group, -p prints process groups only.',
  ],
  fg: ['fg [%JOB]', 'Bring a job to the foreground and wait for it.'],
  bg: ['bg [%JOB...]', 'Resume stopped jobs in the background.'],
  wait: [
    'wait [%JOB | PID]...',
    'Wait for jobs or processes to finish; Ctrl-C interrupts the wait.',
  ],
  kill: [
    'kill [-s SIGNAL | -SIGNAL | -n NUM] PID | %JOB...',
    'Send a signal (default SIGTERM); kill -l lists the signals.',
  ],
  type: ['type NAME...', 'Tell whether each NAME is a shell builtin or a program in $PATH.'],
  help: ['help [NAME]', 'Show the shell summary, or the synopsis of a builtin.'],
  true: ['true', 'Return status 0.'],
  false: ['false', 'Return status 1.'],
};

export const AI_COMMANDS = ['ai', 'semsearch', 'predict'] as const;

export function helpLines(version: string, withAi: boolean): string[] {
  const banner =
    version === ''
      ? "Plotinium shell — type 'man <command>'"
      : `Plotinium ${version} shell — type 'man <command>'`;
  return [
    banner,
    'Builtins:   cd pwd echo export unset exit history jobs fg bg wait kill type help true false',
    'Files:      ls cd pwd mkdir rmdir touch cat echo cp mv rm ln find tree stat chmod chown du df quota grep',
    'Processes:  ps top kill nice renice jobs bg fg',
    'Memory:     free vmstat pmap',
    'System:     uname whoami id su uptime bootlog fsck lsof shutdown reboot history help man',
    'Admin:      svcctl debug swapctl complete',
    ...(withAi ? ['AI:         ai semsearch predict'] : []),
    'Syntax:     a | b   a > f   a >> f   a < f   a 2>&1   a ; b   a && b   a || b   a &   $VAR ${VAR}  \'x\' "x" \\x',
    'Keys:       Tab complete · ↑↓ history · Ctrl-R search · Ctrl-C interrupt · Ctrl-Z stop · Ctrl-D exit',
    'Windows:    Alt+` or Alt+J next window · Alt+W window menu · Alt+T new Terminal (Settings → Keyboard)',
  ];
}

function* installed(io: Io, name: string): SysGen<boolean> {
  try {
    yield* io.sys.call('stat', { path: `/bin/${name}.json` });
    return true;
  } catch {
    return false;
  }
}

export default defineCommand<HelpOpts>({
  name: 'help',
  parse(args) {
    const p = parseFor('help', args);
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    return { name: p.operands[0] ?? null };
  },
  *run(io, opts) {
    if (opts.name !== null) {
      const builtin = BUILTINS[opts.name];
      if (builtin !== undefined) {
        yield* io.lines([`${opts.name}: ${builtin[0]}`, `    ${builtin[1]}`]);
        return 0;
      }
      if (yield* installed(io, opts.name)) {
        yield* io.line(`${opts.name} is a program; see 'man ${opts.name}'.`);
        return 0;
      }
      yield* io.error(`no help topics match '${opts.name}'`);
      return 1;
    }
    let version: string;
    try {
      version = (yield* io.sys.call('uname', {})).version;
    } catch {
      version = '';
    }
    let withAi = false;
    for (const name of AI_COMMANDS) {
      if (yield* installed(io, name)) {
        withAi = true;
        break;
      }
    }
    yield* io.lines(helpLines(version, withAi));
    return 0;
  },
});
