/**
 * Signals (syscall-abi.md §3.9 and §4.8, ABI-09). Numbers follow Linux x86-64; a process ended by
 * signal n exits with status 128 + n. The ABI-09 conformance test compares this table with §4.8.
 */
import * as v from 'valibot';

import { SIGNAL_EXIT_BASE } from './limits.ts';

export type SignalAction = 'terminate' | 'ignore' | 'stop' | 'continue';

export interface SignalInfo {
  readonly number: number;
  readonly defaultAction: SignalAction;
  /** SIGKILL and SIGSTOP can be neither caught nor ignored (EINVAL from `sig.action`). */
  readonly catchable: boolean;
}

export const SIGNALS = {
  SIGHUP: { number: 1, defaultAction: 'terminate', catchable: true },
  SIGINT: { number: 2, defaultAction: 'terminate', catchable: true },
  SIGQUIT: { number: 3, defaultAction: 'terminate', catchable: true },
  SIGKILL: { number: 9, defaultAction: 'terminate', catchable: false },
  SIGUSR1: { number: 10, defaultAction: 'terminate', catchable: true },
  SIGUSR2: { number: 12, defaultAction: 'terminate', catchable: true },
  SIGPIPE: { number: 13, defaultAction: 'terminate', catchable: true },
  SIGTERM: { number: 15, defaultAction: 'terminate', catchable: true },
  SIGCHLD: { number: 17, defaultAction: 'ignore', catchable: true },
  SIGCONT: { number: 18, defaultAction: 'continue', catchable: true },
  SIGSTOP: { number: 19, defaultAction: 'stop', catchable: false },
  SIGTSTP: { number: 20, defaultAction: 'stop', catchable: true },
  SIGTTIN: { number: 21, defaultAction: 'stop', catchable: true },
  SIGTTOU: { number: 22, defaultAction: 'stop', catchable: true },
  SIGWINCH: { number: 28, defaultAction: 'ignore', catchable: true },
} as const satisfies Record<string, SignalInfo>;

export type SignalName = keyof typeof SIGNALS;

export const SIGNAL_NAMES = Object.keys(SIGNALS) as SignalName[];

export const SignalName = v.picklist(SIGNAL_NAMES);

export function signalNumber(name: SignalName): number {
  return SIGNALS[name].number;
}

export function signalFromNumber(n: number): SignalName | undefined {
  return SIGNAL_NAMES.find((name) => SIGNALS[name].number === n);
}

/** Exit status of a process terminated by `name` (for example 137 for SIGKILL). */
export function signalExitStatus(name: SignalName): number {
  return SIGNAL_EXIT_BASE + SIGNALS[name].number;
}

/**
 * Bit mask of a signal in a `pendingSigs` word (bit n = signal n, as in the PCB's
 * `pendingSignals`, processes-and-scheduling.md §4.1). All signal numbers are below 32.
 */
export function signalBit(name: SignalName): number {
  return (1 << SIGNALS[name].number) >>> 0;
}
