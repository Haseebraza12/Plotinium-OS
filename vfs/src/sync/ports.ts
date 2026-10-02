/**
 * Injectable ports of `syncd` and `lockd` (offline-and-sync.md §3.2, SYN-15): the socket, the clock,
 * HTTPS, the random source and the kernel host. The product binds them in the kernel worker; tests
 * bind fakes, so every timer and frame is deterministic.
 */
import type { C2SFrame, C2SType, LeaseRef, NetStatus, S2CFrame } from '@plotinium/protocol';

import type { StoreWrite } from '../ops/plan.ts';
import type {
  HbAckBody,
  HelloOkBody,
  LockFrame,
  OpResultBody,
  SnapshotPage,
  SyncNotice,
} from './types.ts';

/** A cancellable timer. */
export interface Timer {
  cancel(): void;
}

export interface Clock {
  /** Wall clock, epoch ms (clientTime, cursors' updatedAt, conflicted-copy dates). */
  now(): number;
  /** Monotonic ms (`hb.t`, round trips). */
  mono(): number;
  /** Run `fn` once after `ms`. */
  after(ms: number, fn: () => void): Timer;
}

/** The kernel worker's timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  after: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  },
};

/** The part of a WebSocket `syncd` uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  /** `code` 1006 when the upgrade failed or the socket died without a close frame. */
  onClose(code: number, reason: string): void;
}

/** Opens `wss://…/ws`; the product binds `new WebSocket(url)`. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

/** The browser WebSocket, for the kernel worker. */
export function browserSocket(url: string, h: SocketHandlers): SocketLike {
  const ws = new WebSocket(url);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (ev: MessageEvent<unknown>) => {
    if (typeof ev.data === 'string') h.onMessage(ev.data);
  };
  ws.onclose = (ev: CloseEvent) => h.onClose(ev.code, ev.reason);
  return { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) };
}

/** Transport failure of an HTTPS call (no response): the op stays at the head and is resent. */
export class HttpUnavailable extends Error {
  constructor(message = 'network unavailable') {
    super(message);
    this.name = 'HttpUnavailable';
  }
}

/** The HTTPS routes sync uses (backend-api.md §3.6, offline-and-sync.md §4.10). */
export interface SyncHttp {
  /** `GET /api/auth/me`: the HTTP status (401 → AUTH_REQUIRED, §3.7 rule 5). */
  authMe(): Promise<number>;
  /** `GET /api/healthz`, network-only: true when the server answered (§3.7 rule 4). */
  healthz(): Promise<boolean>;
  /** `POST /api/ops/{opId}` with an `OpSubmit` body; resolves with the `op.result` body. */
  postOp(opId: string, body: string): Promise<OpResultBody>;
  /** `PUT /api/blobs/{sha256}`; the binding reads the bytes from the local chunks. */
  putBlob(sha: string): Promise<void>;
  /** One page of `GET /api/sync/snapshot` (`url` from `snapshot.required`, plus `after`). */
  snapshot(url: string, after?: string): Promise<SnapshotPage>;
}

/** What a sync transaction changed, delivered after `oncomplete` (§3.11 phase 3). */
export interface SyncEffect {
  readonly kind: 'ack' | 'conflict' | 'revert' | 'park' | 'remote' | 'snapshot';
  readonly opId?: string;
  /** Row writes in order, for `VfsTree.apply` (the in-memory tree changes only after commit). */
  readonly writes: readonly StoreWrite[];
}

/** The kernel side of syncd. Every method is optional work for the kernel; none may throw. */
export interface SyncHost {
  /** Rows changed by a sync transaction (apply to the tree, publish events with the origin). */
  applied(effect: SyncEffect): void;
  /** `net.state` changed (OFF-04): the kernel publishes it on the bus. */
  status(status: NetStatus, label: string): void;
  notice(notice: SyncNotice): void;
}

/** Decodes one text frame; null for anything that is not a server frame of protocol v1. */
export type FrameDecoder = (raw: string) => S2CFrame | null;

/** The control lane as `lockd` sees it (lockd has no socket of its own, §3.2). */
export interface ControlChannel {
  /** Sends a control frame when the connection is usable; false otherwise. */
  sendControl<T extends Exclude<C2SType, 'op.submit' | 'op.batch'>>(
    t: T,
    body: C2SFrame<T>['body'],
  ): boolean;
  /** An immediate `hb` (visibilitychange, resume; §3.14.7). */
  heartbeatNow(): void;
}

/** The lock client syncd feeds (implemented by `Lockd`). */
export interface LockSyncClient {
  /** `hello.heldLeases` (§3.14.6). */
  heldLeases(): LeaseRef[];
  /** Leases renewed by the next `hb`. */
  heartbeatLeases(): LeaseRef[];
  /** `hello.ok` arrived: kept and lost leases, advertised timers. */
  onHelloOk(ok: HelloOkBody, clientNow: number): void;
  /** The server layer is usable (syncd LIVE) or not (degraded, local advisory locks). */
  onServerAvailable(available: boolean): void;
  onLockFrame(frame: LockFrame): void;
  onHbAck(ack: HbAckBody, clientNow: number, rttMs: number): void;
}
