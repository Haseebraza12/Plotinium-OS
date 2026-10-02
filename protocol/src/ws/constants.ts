/**
 * WebSocket protocol v1 constants and close codes (offline-and-sync.md §4.5 and §4.6; C6).
 *
 * The SYN-01/SYN-03 conformance tests compare these tables with the spec. Server-side values that
 * are configuration (for example LEASE_TTL_MS in the demo profile) are the defaults here; the
 * server advertises the values it uses in `hello.ok`.
 */

/** Protocol major version (`v` of every frame). The server accepts N and N−1 (§3.16.3). */
export const PROTO = 1;
/** Largest text frame, in bytes; larger → close 1009 (SYN-01). */
export const MAX_PAYLOAD = 65_536;
/** Largest `op.submit` body sent on the socket; larger → `POST /api/ops/{opId}` (60 KB). */
export const OP_ENVELOPE_MAX = 61_440;
/** Ops per `op.batch` frame (C6). */
export const MAX_BATCH = 32;
/** Ops in flight without an `op.result` (C6; the server may advertise up to 32). */
export const CREDIT_WINDOW = 16;
/** Unacknowledged streamed feed entries per connection. */
export const FEED_WINDOW = 256;
/** Time for the client to send `hello` after `open` (4408 otherwise). */
export const HELLO_TIMEOUT_MS = 5_000;
/** Lease TTL: 30 s default; 15 s in the demo profile; allowed range 15..120 s (C6). */
export const LEASE_TTL_MS = 30_000;
export const LEASE_TTL_DEMO_MS = 15_000;
export const LEASE_TTL_MIN_MS = 15_000;
export const LEASE_TTL_MAX_MS = 120_000;
/** Heartbeat period: TTL / 3 (C6). */
export function hbMs(leaseTtlMs: number): number {
  return Math.floor(leaseTtlMs / 3);
}
/** Client dead-man timer. */
export const DEAD_MAN_MS = 25_000;
/** Server `ws` ping; terminate after one missed pong (socket liveness only, never a lease renewal). */
export const SERVER_PING_MS = 20_000;
/** Full-jitter back-off bounds. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
/** Probe period while OFFLINE. */
export const PROBE_MS = 60_000;
/** A feed gap older than this triggers a `resume`. */
export const FEED_GAP_MS = 2_000;
/** How long bulk ops and agent batches wait for `op.result` online (C6, SYN-07). */
export const SYNC_WAIT_MS = 10_000;
/** Per OS session / connection. */
export const MAX_LEASES = 256;
export const MAX_WATCHES = 256;
/** Server backpressure thresholds on `bufferedAmount` (§4.6.1, SYN-12). */
export const COALESCE_AT = 262_144;
export const CLOSE_AT = 4_194_304;
/** Server frame rate limiter: 50 frames/s with a burst of 200 per connection. */
export const FRAME_BUCKET = { ratePerSecond: 50, burst: 200 } as const;
/** Server feed retention job. */
export const FEED_RETENTION_DAYS = 30;
/** Live entries buffered per streaming connection and owner (§3.8.4). */
export const PENDING_LIVE_MAX = 1_000;

export type CloseReaction =
  | 'closed-or-backoff'
  | 'release-leases'
  | 'backoff'
  | 'backoff-reset'
  | 'backoff-min-5s'
  | 'auth-required'
  | 'superseded'
  | 'backoff-retry-after'
  | 'reconnect-resume';

export interface CloseCodeInfo {
  readonly code: number;
  readonly name: string;
  readonly sentBy: 'either' | 'browser' | 'server';
  readonly reaction: CloseReaction;
}

/** Close codes of §4.5. Close codes are never errnos: they only change `net.state`. */
export const CLOSE_CODES = {
  NORMAL: { code: 1000, name: 'normal', sentBy: 'either', reaction: 'closed-or-backoff' },
  GOING_AWAY: { code: 1001, name: 'going away', sentBy: 'browser', reaction: 'release-leases' },
  POLICY_VIOLATION: { code: 1008, name: 'policy violation', sentBy: 'server', reaction: 'backoff' },
  MESSAGE_TOO_BIG: { code: 1009, name: 'message too big', sentBy: 'server', reaction: 'backoff' },
  SERVICE_RESTART: {
    code: 1012,
    name: 'service restart',
    sentBy: 'server',
    reaction: 'backoff-reset',
  },
  TRY_AGAIN_LATER: {
    code: 1013,
    name: 'try again later',
    sentBy: 'server',
    reaction: 'backoff-min-5s',
  },
  AUTH_REQUIRED: { code: 4401, name: 'auth required', sentBy: 'server', reaction: 'auth-required' },
  TIMEOUT: { code: 4408, name: 'timeout', sentBy: 'server', reaction: 'backoff' },
  SUPERSEDED: { code: 4409, name: 'superseded', sentBy: 'server', reaction: 'superseded' },
  RATE_LIMITED: {
    code: 4429,
    name: 'rate limited',
    sentBy: 'server',
    reaction: 'backoff-retry-after',
  },
  SLOW_CONSUMER: {
    code: 4508,
    name: 'slow consumer',
    sentBy: 'server',
    reaction: 'reconnect-resume',
  },
} as const satisfies Record<string, CloseCodeInfo>;

export type CloseCodeKey = keyof typeof CLOSE_CODES;

export function closeCodeInfo(code: number): CloseCodeInfo | undefined {
  return Object.values(CLOSE_CODES).find((c) => c.code === code);
}
