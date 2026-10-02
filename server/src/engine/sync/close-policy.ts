/**
 * Close codes and what they mean for leases and backpressure (offline-and-sync.md §4.5, §4.6.1,
 * §3.14.5; backend-api.md §3.7, §3.17; SYN-12, SYN-13; VFS-09).
 *
 * Server-initiated closes always send `bye {reason}` first and then close with the code below.
 * The server never closes a socket because of replay traffic (§3.9): replay is throttled instead.
 */
import { CLOSE_AT, CLOSE_CODES, COALESCE_AT, type S2CFrame } from '@plotinium/protocol';

export type ServerByeReason = S2CFrame<'bye'>['body']['reason'];

/** The close code that follows a server `bye {reason}`. */
export const BYE_CLOSE_CODE: Readonly<Record<ServerByeReason, number>> = {
  restart: CLOSE_CODES.SERVICE_RESTART.code, // 1012: graceful shutdown or deploy; fast jittered reconnect
  shutdown: CLOSE_CODES.SERVICE_RESTART.code, // the same drain path as a restart (backend-api.md §3.17)
  revoked: CLOSE_CODES.AUTH_REQUIRED.code, // 4401: session revoked or expired; no automatic retry
  superseded: CLOSE_CODES.SUPERSEDED.code, // 4409: a newer kernel epoch of the same device
  'upgrade-required': CLOSE_CODES.POLICY_VIOLATION.code, // 1008: protocol older than N-1
  'idle-timeout': CLOSE_CODES.TIMEOUT.code, // 4408: no hello within 5 s, or no frame for leaseTtlMs
  'protocol-error': CLOSE_CODES.POLICY_VIOLATION.code, // 1008: three protocol errors within 60 s
  'rate-limited': CLOSE_CODES.RATE_LIMITED.code, // 4429: non-replay abuse, throttle ignored 3x in 10 s
  'slow-consumer': CLOSE_CODES.SLOW_CONSUMER.code, // 4508: bufferedAmount above 4 MiB
  policy: CLOSE_CODES.POLICY_VIOLATION.code, // 1008: a forbidden osSessionId, a foreign op session
};

export type LeaseAction = 'release' | 'keep';

/**
 * §3.14.5: `bye`, or a CLIENT close with 1000 or 1001, releases every lease of the OS session at
 * once. Everything else keeps them until the TTL, so a quick reconnect of the same OS session keeps
 * them (§3.14.6): an abnormal close (1006, dead socket, network loss), and every server-initiated
 * close (1012 restart: leases stay in the database across a deploy; 4401 revocation releases through
 * its own path; 4409 superseded releases through the new epoch's hello; 4508 slow consumer
 * reconnects at once).
 */
export function leaseActionOnClose(c: {
  readonly code: number;
  readonly byeReceived: boolean;
  readonly serverInitiated: boolean;
}): LeaseAction {
  if (c.byeReceived) return 'release';
  if (c.serverInitiated) return 'keep';
  return c.code === CLOSE_CODES.NORMAL.code || c.code === CLOSE_CODES.GOING_AWAY.code
    ? 'release'
    : 'keep';
}

export type SendClass = 'control' | 'feed';
export type SendDecision = 'send' | 'coalesce' | 'close';

/**
 * §4.6.1 backpressure, checked before each send: above COALESCE_AT (256 KiB) live `vfs.changed`
 * entries are not sent (the affected owners resume from the database; nothing is lost because the
 * entries are in `feed`), control replies still are; above CLOSE_AT (4 MiB) the connection is
 * closed with `bye slow-consumer` and 4508.
 */
export function backpressure(bufferedAmount: number, cls: SendClass): SendDecision {
  if (bufferedAmount > CLOSE_AT) return 'close';
  if (bufferedAmount > COALESCE_AT && cls === 'feed') return 'coalesce';
  return 'send';
}
