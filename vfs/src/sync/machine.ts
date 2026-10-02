/**
 * The `syncd` connection state machine (offline-and-sync.md §3.7; C6, SYN-10) as a pure transition
 * function, so every edge of the diagram is unit-testable; `Syncd` performs the side effects of
 * entering a state. HANDSHAKING is the "hello" state (socket open, `hello` sent, no `hello.ok` yet).
 */
import { CLOSE_CODES } from '@plotinium/protocol';
import type { NetState } from '@plotinium/protocol';

import type { SyncState } from './types.ts';

export type SyncEvent =
  /** Service start (first CONNECTING happens after desktop-interactive, §3.7 rule 9). */
  | { readonly type: 'connect'; readonly online: boolean }
  | { readonly type: 'open' }
  | { readonly type: 'hello.ok' }
  /** Every owner resumed and the sendable outbox drained. */
  | { readonly type: 'resumed' }
  /**
   * The socket closed. `beforeOpen` with `unauthorised` (GET /api/auth/me answered 401) is a
   * failed upgrade that needs a new sign-in (§3.7 rule 5).
   */
  | {
      readonly type: 'close';
      readonly code: number;
      readonly beforeOpen: boolean;
      readonly unauthorised?: boolean;
    }
  /** No `hello.ok` within 5 s, or the dead-man timer fired (§3.7 rule 2). */
  | { readonly type: 'timeout' }
  | { readonly type: 'offline' }
  | { readonly type: 'online' }
  | { readonly type: 'visible' }
  /** The back-off timer fired. */
  | { readonly type: 'timer' }
  | { readonly type: 'probe-ok' }
  | { readonly type: 'signed-in' }
  /** shutdown, reboot, logout (§3.7 rule 8). */
  | { readonly type: 'shutdown' }
  /** `bye` sent and the socket closed. */
  | { readonly type: 'closed' };

const CONNECTED: ReadonlySet<SyncState> = new Set(['HANDSHAKING', 'RESUMING', 'LIVE']);
const TERMINAL: ReadonlySet<SyncState> = new Set(['SUPERSEDED', 'CLOSED']);

/** Close of an open connection (HANDSHAKING, RESUMING, LIVE): §3.7 and the table of §4.5. */
function afterClose(code: number): SyncState {
  if (code === CLOSE_CODES.AUTH_REQUIRED.code) return 'AUTH_REQUIRED';
  if (code === CLOSE_CODES.SUPERSEDED.code) return 'SUPERSEDED';
  return 'BACKOFF';
}

/** The next state; the same state when the event does not apply (no edge in §3.7). */
export function transition(s: SyncState, e: SyncEvent): SyncState {
  if (TERMINAL.has(s)) return s;
  if (s === 'CLOSING') return e.type === 'closed' || e.type === 'close' ? 'CLOSED' : s;
  if (e.type === 'shutdown') return CONNECTED.has(s) ? 'CLOSING' : 'CLOSED';
  // Fast offline signal (rule 3): any state except CLOSING, CLOSED, SUPERSEDED.
  if (e.type === 'offline') return 'OFFLINE';
  switch (s) {
    case 'IDLE':
      return e.type === 'connect' ? (e.online ? 'CONNECTING' : 'OFFLINE') : s;
    case 'OFFLINE':
      return e.type === 'online' || e.type === 'visible' || e.type === 'probe-ok'
        ? 'CONNECTING'
        : s;
    case 'CONNECTING':
      if (e.type === 'open') return 'HANDSHAKING';
      if (e.type === 'close')
        return e.beforeOpen && e.unauthorised === true ? 'AUTH_REQUIRED' : 'BACKOFF';
      if (e.type === 'timeout') return 'BACKOFF';
      return s;
    case 'HANDSHAKING':
      if (e.type === 'hello.ok') return 'RESUMING';
      if (e.type === 'timeout') return 'BACKOFF';
      if (e.type === 'close') return afterClose(e.code);
      return s;
    case 'RESUMING':
      if (e.type === 'resumed') return 'LIVE';
      if (e.type === 'timeout') return 'BACKOFF';
      if (e.type === 'close') return afterClose(e.code);
      return s;
    case 'LIVE':
      if (e.type === 'timeout') return 'BACKOFF';
      if (e.type === 'close') return afterClose(e.code);
      return s;
    case 'BACKOFF':
      return e.type === 'timer' || e.type === 'online' || e.type === 'visible' ? 'CONNECTING' : s;
    case 'AUTH_REQUIRED':
      return e.type === 'signed-in' ? 'CONNECTING' : s;
    case 'SUPERSEDED':
    case 'CLOSED':
      return s;
  }
}

/** `NetStatus.state` of a machine state (§3.7 "Mapping to NetStatus"); null = never shown. */
export function netStateOf(s: SyncState): NetState | null {
  switch (s) {
    case 'LIVE':
      return 'online';
    case 'IDLE':
    case 'CONNECTING':
    case 'HANDSHAKING':
    case 'BACKOFF':
      return 'connecting';
    case 'RESUMING':
      return 'resuming';
    case 'OFFLINE':
      return 'offline';
    case 'AUTH_REQUIRED':
      return 'auth-required';
    case 'SUPERSEDED':
    case 'CLOSING':
    case 'CLOSED':
      return null;
  }
}

/** A socket exists and `hello` was (or is being) exchanged. */
export function isConnected(s: SyncState): boolean {
  return CONNECTED.has(s);
}

/** Ops may be sent and `SYNC_WAIT_MS` waits apply (§3.13.2). */
export function isSyncing(s: SyncState): boolean {
  return s === 'RESUMING' || s === 'LIVE';
}
