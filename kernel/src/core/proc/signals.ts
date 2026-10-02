/**
 * Signal semantics (processes-and-scheduling.md §3.17.1, KPS-09; syscall-abi.md §3.9, §4.8):
 * dispositions, default actions and the pending-signal word. Pure: the process system applies
 * the resulting action (kill path, stop, continue, deliver at the next dispatch).
 */
import type { SigDisposition, SignalName } from '@plotinium/protocol';
import { SIGNALS, signalBit, signalFromNumber, signalNumber } from '@plotinium/protocol';

import type { PCB } from './pcb.ts';

/** PCB `sigDisposition[n]` values. */
export const DISP_DEFAULT = 0;
export const DISP_IGNORE = 1;
export const DISP_CATCH = 2;

export const STOP_SIGNALS: readonly SignalName[] = ['SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU'];

const STOP_MASK = STOP_SIGNALS.reduce((m, s) => (m | signalBit(s)) >>> 0, 0);

export function dispositionOf(pcb: PCB, sig: SignalName): SigDisposition {
  const d = pcb.sigDisposition[signalNumber(sig)] ?? DISP_DEFAULT;
  return d === DISP_CATCH ? 'catch' : d === DISP_IGNORE ? 'ignore' : 'default';
}

/** `sig.action`: returns the previous disposition. SIGKILL/SIGSTOP are rejected by the schema. */
export function setDisposition(pcb: PCB, sig: SignalName, action: SigDisposition): SigDisposition {
  const old = dispositionOf(pcb, sig);
  pcb.sigDisposition[signalNumber(sig)] =
    action === 'catch' ? DISP_CATCH : action === 'ignore' ? DISP_IGNORE : DISP_DEFAULT;
  return old;
}

/**
 * What sending `sig` to `pcb` does now (§3.17.1):
 * - `kill`      SIGKILL, or an uncaught terminating signal: the kill path, exit 128 + n;
 * - `stop`      SIGSTOP, or an uncaught SIGTSTP/SIGTTIN/SIGTTOU: stop (BLOCKED `sigcont`);
 * - `continue`  SIGCONT (always continues; a caught SIGCONT also runs the hook);
 * - `catch`     set the pending bit, delivered through `signal()` at the next dispatch;
 * - `ignore`    nothing.
 */
export type SignalAction = 'kill' | 'stop' | 'continue' | 'catch' | 'ignore';

export function actionFor(pcb: PCB, sig: SignalName): SignalAction {
  if (sig === 'SIGKILL') return 'kill';
  if (sig === 'SIGSTOP') return 'stop';
  if (sig === 'SIGCONT') return 'continue';
  const disp = dispositionOf(pcb, sig);
  if (disp === 'ignore') return 'ignore';
  if (disp === 'catch') return 'catch';
  switch (SIGNALS[sig].defaultAction) {
    case 'terminate':
      return 'kill';
    case 'stop':
      return 'stop';
    case 'ignore':
      return 'ignore';
  }
}

export function setPending(pcb: PCB, sig: SignalName): void {
  pcb.pendingSignals = (pcb.pendingSignals | signalBit(sig)) >>> 0;
}

/** SIGCONT discards pending stop signals (§3.17.1). */
export function clearPendingStops(pcb: PCB): void {
  pcb.pendingSignals = (pcb.pendingSignals & ~STOP_MASK) >>> 0;
}

/**
 * The caught signals to deliver with a dispatch or resume frame; they are cleared from the PCB
 * (a signal is delivered once). Bits of signals no longer caught are dropped.
 */
export function takeDeliverable(pcb: PCB): number {
  let out = 0;
  let bits = pcb.pendingSignals;
  for (let n = 1; bits !== 0 && n < 32; n++) {
    const bit = (1 << n) >>> 0;
    if ((bits & bit) === 0) continue;
    bits = (bits & ~bit) >>> 0;
    const sig = signalFromNumber(n);
    if (sig !== undefined && dispositionOf(pcb, sig) === 'catch') out = (out | bit) >>> 0;
  }
  pcb.pendingSignals = 0;
  return out;
}

/** Exit status of a process killed by `sig` (128 + n). */
export function signalExit(sig: SignalName): number {
  return 128 + signalNumber(sig);
}
