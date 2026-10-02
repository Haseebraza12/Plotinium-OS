/**
 * Connectivity status for the taskbar (offline-and-sync.md §3.15.2; Spec: MUST, §9.5, OFF-04).
 * `syncd` publishes `net.state` (`NetStatus`, syscall-abi.md §4.4.8) on every change; the label is
 * the table of §3.15.2 so the taskbar and the accessible name agree.
 */
import { LEASE_TTL_MS } from '@plotinium/protocol';
import type { NetState, NetStatus } from '@plotinium/protocol';

import { netStateOf } from './machine.ts';
import type { SyncState } from './types.ts';

/** Failures after which "Reconnecting…" becomes "Offline · n queued (retry in s s)". */
export const OFFLINE_AFTER_FAILURES = 3;

export interface StatusInput {
  readonly state: SyncState;
  /** Unsynced ops that will be sent (pending, in flight, waiting for a blob upload, reverted). */
  readonly queued: number;
  /** Ops waiting for a sign-in of their principal (§3.8.6). */
  readonly waitingForSignIn: number;
  readonly parked: number;
  /** Consecutive connection failures (the back-off exponent n). */
  readonly failures: number;
  /** Time until the next reconnect attempt while in BACKOFF, ms. */
  readonly retryInMs: number | null;
  /** The server refused this client's protocol (`bye upgrade-required`, §3.16.3 rule 4). */
  readonly upgradeRequired: boolean;
  readonly lastAckAt: number | null;
  readonly leaseTtlMs: number | null;
  readonly serverBuild: string | null;
  /** Non-critical services degraded by sync (for example `lockd` with local locks only). */
  readonly extraDegraded?: readonly string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The label of §3.15.2, including the held-op suffixes. */
export function statusLabel(s: StatusInput): string {
  let base: string;
  if (s.upgradeRequired) {
    base = 'Restart to update required to sync';
  } else {
    switch (s.state) {
      case 'LIVE':
        base = s.queued === 0 ? 'Online' : `Syncing · ${plural(s.queued, 'op', 'ops')}`;
        break;
      case 'RESUMING':
        base = `Syncing · ${plural(s.queued, 'op', 'ops')}`;
        break;
      case 'IDLE':
      case 'CONNECTING':
      case 'HANDSHAKING':
      case 'BACKOFF':
        if (s.failures < OFFLINE_AFTER_FAILURES) base = 'Reconnecting…';
        else if (s.retryInMs !== null)
          base = `Offline · ${s.queued} queued (retry in ${Math.ceil(s.retryInMs / 1000)} s)`;
        else base = `Offline · ${s.queued} queued`;
        break;
      case 'OFFLINE':
        base = `Offline · ${s.queued} queued`;
        break;
      case 'AUTH_REQUIRED':
        base = `Sign in to sync · ${s.queued} queued`;
        break;
      case 'SUPERSEDED':
      case 'CLOSING':
      case 'CLOSED':
        base = 'Stopping';
        break;
    }
  }
  if (s.waitingForSignIn > 0) base += ` · ${s.waitingForSignIn} waiting for sign-in`;
  if (s.parked > 0) base += ` · ${s.parked} parked`;
  return base;
}

/** Degraded service names for the popover (§3.15.2): `sync` whenever it is not LIVE. */
export function degradedOf(s: StatusInput): string[] {
  const out: string[] = [];
  if (s.state !== 'LIVE') out.push('sync');
  for (const d of s.extraDegraded ?? []) if (!out.includes(d)) out.push(d);
  return out;
}

/** `NetStatus` for `net.state`; null in states that are never shown (the kernel is stopping). */
export function netStatusOf(s: StatusInput): NetStatus | null {
  const state: NetState | null = s.upgradeRequired ? 'offline' : netStateOf(s.state);
  if (state === null) return null;
  return {
    state,
    queuedOps: s.queued + s.waitingForSignIn,
    lastAckAt: s.lastAckAt,
    degraded: degradedOf(s).slice(0, 32),
    leaseTtlMs: s.leaseTtlMs ?? LEASE_TTL_MS,
    serverBuild: s.serverBuild,
  };
}

/** Structural equality of two statuses (publish only on change). */
export function sameStatus(a: NetStatus | null, b: NetStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.state === b.state &&
    a.queuedOps === b.queuedOps &&
    a.lastAckAt === b.lastAckAt &&
    a.leaseTtlMs === b.leaseTtlMs &&
    a.serverBuild === b.serverBuild &&
    a.degraded.length === b.degraded.length &&
    a.degraded.every((d, i) => d === b.degraded[i])
  );
}
