/** Signal names and numbers as `kill` accepts and lists them (processes-and-scheduling.md §3.18.4). */
import type { SignalName } from '@plotinium/protocol';
import { SIGNAL_EXIT_BASE, SIGNALS, signalFromNumber } from '@plotinium/protocol';

/** The `kill -l` list, in the order and spacing of §3.18.4. */
export const KILL_LIST: readonly SignalName[] = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
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

export function killList(): string {
  return KILL_LIST.map((name) => `${SIGNALS[name].number}) ${name}`).join('  ');
}

function isSignalName(name: string): name is SignalName {
  return Object.hasOwn(SIGNALS, name);
}

/** `TERM`, `SIGTERM`, `term`, `15` → `SIGTERM`; `0` → 0 (existence check); else undefined. */
export function parseSignal(text: string): SignalName | 0 | undefined {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n === 0) return 0;
    return signalFromNumber(n);
  }
  const upper = text.toUpperCase();
  const name = upper.startsWith('SIG') ? upper : `SIG${upper}`;
  return isSignalName(name) ? name : undefined;
}

/**
 * `kill -l ARG`: a number or exit status prints the name without SIG (`137` → `KILL`), a name
 * prints its number; undefined when neither.
 */
export function translateSignal(text: string): string | undefined {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    const sig = signalFromNumber(n > SIGNAL_EXIT_BASE ? n - SIGNAL_EXIT_BASE : n);
    return sig?.slice(3);
  }
  const sig = parseSignal(text);
  return sig === undefined || sig === 0 ? undefined : String(SIGNALS[sig].number);
}
