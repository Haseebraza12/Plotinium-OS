/**
 * `kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID | %JOB...` and `kill -l [NUM]` (§3.14.24).
 * `%n` resolves through the job table; SIGTERM or SIGHUP to a stopped job is followed by SIGCONT
 * so the signal takes effect.
 */
import type { SignalName } from '@plotinium/protocol';
import {
  PID_MAX,
  SIGNAL_EXIT_BASE,
  SIGNALS,
  SIGNAL_NAMES,
  signalFromNumber,
} from '@plotinium/protocol';

import type { SysGen } from '../../src/_sys.ts';
import { errText } from '../../src/_sys.ts';
import { resolveJobSpec } from '../jobs.ts';
import type { Sh } from '../state.ts';
import { err, out } from '../state.ts';

/** The twelve signals `kill -l` lists (§3.14.24, exact). */
const LISTED: readonly SignalName[] = [
  'SIGHUP',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGTERM',
  'SIGCHLD',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGWINCH',
];

export const KILL_LIST = LISTED.map((s) => `${SIGNALS[s].number}) ${s}`).join(' ');

const USAGE = 'kill: usage: kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID | %JOB...\n';

type Sig = SignalName | 0;

/** A signal by name (with or without `SIG`, any case) or by number; null when invalid. */
export function parseSignal(spec: string): Sig | null {
  if (/^[0-9]+$/.test(spec)) {
    const n = Number(spec);
    if (n === 0) return 0;
    return signalFromNumber(n) ?? null;
  }
  const up = spec.toUpperCase();
  const name = up.startsWith('SIG') ? up : `SIG${up}`;
  return (SIGNAL_NAMES as readonly string[]).includes(name) ? (name as SignalName) : null;
}

/** `kill -l NUM`: the name without `SIG`; an exit status above 128 names its signal. */
function listOne(spec: string): string | null {
  if (!/^[0-9]+$/.test(spec)) {
    const s = parseSignal(spec);
    return s === null || s === 0 ? null : String(SIGNALS[s].number);
  }
  const n = Number(spec);
  const s = signalFromNumber(n > SIGNAL_EXIT_BASE ? n - SIGNAL_EXIT_BASE : n);
  return s === undefined ? null : s.slice(3);
}

interface Parsed {
  sig: Sig;
  operands: string[];
}

function parseArgs(args: readonly string[]): Parsed | { invalid: string } | 'usage' {
  let sig: Sig = 'SIGTERM';
  let i = 0;
  const first = args[0];
  if (first === '-s' || first === '-n') {
    const spec = args[1];
    if (spec === undefined) return 'usage';
    const s = parseSignal(spec);
    if (s === null) return { invalid: spec };
    sig = s;
    i = 2;
  } else if (first !== undefined && first.length > 1 && first.startsWith('-') && first !== '--') {
    // `-SIGNAL` or `-NUM`; a process group needs `kill -- -312` or `kill -TERM -312`.
    const s = parseSignal(first.slice(1));
    if (s === null) return { invalid: first.slice(1) };
    sig = s;
    i = 1;
  }
  if (args[i] === '--') i++;
  return { sig, operands: args.slice(i) };
}

export function* killBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const args = argv.slice(1);
  if (args[0] === '-l' || args[0] === '-L') {
    if (args.length === 1) {
      yield* out(sh, `${KILL_LIST}\n`);
      return 0;
    }
    const names = args.slice(1).map(listOne);
    if (names.some((n) => n === null)) {
      yield* err(sh, `kill: invalid signal '${args[1] ?? ''}'\n`);
      return 2;
    }
    yield* out(sh, names.map((n) => `${n ?? ''}\n`).join(''));
    return 0;
  }
  const parsed = parseArgs(args);
  if (parsed === 'usage' || ('operands' in parsed && parsed.operands.length === 0)) {
    yield* err(sh, USAGE);
    return 2;
  }
  if ('invalid' in parsed) {
    yield* err(sh, `kill: invalid signal '${parsed.invalid}'\n`);
    return 2;
  }
  let status = 0;
  for (const op of parsed.operands) {
    const ok = yield* killOne(sh, op, parsed.sig);
    if (!ok) status = 1;
  }
  return status;
}

function* send(sh: Sh, pid: number, sig: Sig): SysGen<string | null> {
  // No process or group can have a number beyond PID_MAX: "No such process", not the
  // "Invalid argument" of the kernel's range check (UI-159).
  if (Math.abs(pid) > PID_MAX) return `kill: (${pid}) - No such process\n`;
  try {
    yield* sh.sys.call('kill', { pid, sig });
    return null;
  } catch (e) {
    return `kill: (${pid}) - ${errText(e)}\n`;
  }
}

/** The kill targets of an operand: one pid or group, or a job's pids without job control. */
function targets(sh: Sh, op: string): { pids: number[]; stopped: boolean } | string {
  if (op.startsWith('%')) {
    const r = resolveJobSpec(sh.st.jobs, op, 'kill');
    if (!r.ok) return `${r.message}\n`;
    // Without job control the job shares the shell's group, so its processes are signalled one
    // by one instead of the group.
    const pids = r.job.pgid === sh.st.pgid ? r.job.pids : [-r.job.pgid];
    return { pids, stopped: r.job.state === 'stopped' };
  }
  if (/^-?[0-9]+$/.test(op)) return { pids: [Number(op)], stopped: false };
  return `kill: ${op}: arguments must be process or job IDs\n`;
}

function* killOne(sh: Sh, op: string, sig: Sig): SysGen<boolean> {
  const t = targets(sh, op);
  if (typeof t === 'string') {
    yield* err(sh, t);
    return false;
  }
  let ok = true;
  for (const pid of t.pids) {
    const failure = yield* send(sh, pid, sig);
    if (failure !== null) {
      yield* err(sh, failure);
      ok = false;
    } else if (t.stopped && (sig === 'SIGTERM' || sig === 'SIGHUP')) {
      yield* send(sh, pid, 'SIGCONT');
    }
  }
  return ok;
}
