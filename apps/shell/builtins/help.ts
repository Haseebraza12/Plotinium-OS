/**
 * `help [NAME]` (§3.14.44). The table is exact; the AI row is printed only when the AI commands
 * are installed, so the AI-off build omits it (SHL-18).
 */
import type { SysGen } from '../../src/_sys.ts';
import { errnoOf } from '../../src/_sys.ts';
import { findInPath } from '../lookup.ts';
import type { Sh } from '../state.ts';
import { err, out } from '../state.ts';
import type { BuiltinName } from './names.ts';
import { isBuiltin } from './names.ts';

export function banner(version: string): string {
  return `Plotinium ${version} shell — type 'man <command>'`;
}

const TABLE_HEAD = [
  'Builtins:   cd pwd echo export unset exit history jobs fg bg wait kill type help true false',
  'Files:      ls cd pwd mkdir rmdir touch cat echo cp mv rm ln find tree stat chmod chown du df quota grep',
  'Processes:  ps top kill nice renice jobs bg fg',
  'Memory:     free vmstat pmap',
  'System:     uname whoami id su uptime bootlog fsck lsof shutdown reboot history help man',
  'Admin:      svcctl debug swapctl complete',
];
const AI_ROW = 'AI:         ai semsearch predict';
const TABLE_TAIL = [
  'Syntax:     a | b   a > f   a >> f   a < f   a 2>&1   a ; b   a && b   a || b   a &   $VAR ${VAR}  \'x\' "x" \\x',
  'Keys:       Tab complete · ↑↓ history · Ctrl-R search · Ctrl-C interrupt · Ctrl-Z stop · Ctrl-D exit',
  'Windows:    Alt+` or Alt+J next window · Alt+W window menu · Alt+T new Terminal (Settings → Keyboard)',
];

export function helpText(version: string, ai: boolean): string {
  const rows = [banner(version), ...TABLE_HEAD, ...(ai ? [AI_ROW] : []), ...TABLE_TAIL];
  return `${rows.join('\n')}\n`;
}

const TOPICS: Readonly<Record<BuiltinName, readonly [string, string]>> = {
  cd: [
    'cd [DIR | -]',
    'Change the working directory to DIR (default $HOME); `cd -` goes to $OLDPWD.',
  ],
  pwd: ['pwd [-L | -P]', 'Print the working directory (-P physical, the default; -L $PWD).'],
  echo: [
    'echo [-n] [-e] [ARG...]',
    'Print the arguments; -n omits the newline, -e interprets escapes.',
  ],
  export: ['export [NAME[=value]...]', 'Mark variables for the environment of later commands.'],
  unset: ['unset NAME...', 'Remove shell variables.'],
  exit: ['exit [N]', 'Leave the shell with status N (default $?).'],
  history: ['history [-c] [N]', 'Show the last N commands; -c clears the history and its file.'],
  jobs: ['jobs [-l] [-p] [%JOB...]', 'List jobs; -l adds the process group, -p prints only it.'],
  fg: ['fg [%JOB]', 'Resume a job in the foreground.'],
  bg: ['bg [%JOB...]', 'Resume stopped jobs in the background.'],
  wait: ['wait [%JOB | PID]...', 'Wait for jobs to finish (all background jobs by default).'],
  kill: [
    'kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID | %JOB...',
    'Send a signal (default SIGTERM); kill -l lists the signals.',
  ],
  help: ['help [NAME]', 'Show this summary, or the synopsis of a builtin.'],
  type: ['type NAME...', 'Say whether NAME is a builtin or which program runs.'],
  true: ['true', 'Return status 0.'],
  false: ['false', 'Return status 1.'],
};

function* installed(sh: Sh, name: string): SysGen<boolean> {
  try {
    return (yield* findInPath(sh, name)) !== null;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return false;
  }
}

export function* helpBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const name = argv[1];
  if (name === undefined) {
    yield* out(sh, helpText(sh.st.version, yield* installed(sh, 'ai')));
    return 0;
  }
  if (isBuiltin(name)) {
    const [synopsis, text] = TOPICS[name];
    yield* out(sh, `${synopsis}\n    ${text}\n`);
    return 0;
  }
  if (yield* installed(sh, name)) {
    yield* out(sh, `${name}: not a builtin; see 'man ${name}'\n`);
    return 0;
  }
  yield* err(sh, `help: no help topics match '${name}'\n`);
  return 1;
}
