/**
 * Connectivity as the desktop shows it (offline-and-sync.md §3.7; OFF-04; syscall-abi.md §4.4.8).
 *
 * One `NetStatus` per kernel, published on the bus as `net.state` whenever it changes: the state
 * (syncd's when a sync engine is linked, else the server's reachability and the auth state), the
 * queued op count, the last ack, and the names of the services that are degraded, failed or
 * blocked right now (tracked from the `svc.*` events).
 */
import type { KEvent, NetStatus } from '@plotinium/protocol';

import type { EventBus, Subscription } from '../events/bus.ts';

/** Lease TTL of the server's lease layer (C6); the demo profile halves it. */
export const LEASE_TTL_MS = 30_000;

export type Reachability = 'online' | 'offline' | 'unknown';

export class NetMonitor {
  private readonly bus: EventBus;
  private readonly sub: Subscription;
  private readonly degraded = new Set<string>();
  private reach: Reachability = 'unknown';
  private authRequired = false;
  private engineStatus: NetStatus | null = null;
  private queued = 0;
  private lastAckAt: number | null = null;
  private serverBuild: string | null = null;
  private last = '';
  private readonly listeners = new Set<(s: NetStatus) => void>();

  constructor(bus: EventBus) {
    this.bus = bus;
    this.sub = bus.subscribe(['svc.*'], {
      cred: { uid: 0, gid: 0, groups: [0] },
      onReady: (s) => {
        this.drain(s.take().events);
      },
    });
  }

  private drain(events: readonly KEvent[]): void {
    let changed = false;
    for (const e of events) {
      if (e.topic === 'svc.degraded' || e.topic === 'svc.failed') {
        if (!this.degraded.has(e.data.name)) changed = true;
        this.degraded.add(e.data.name);
      } else if (e.topic === 'svc.started' || e.topic === 'svc.stopped') {
        if (this.degraded.delete(e.data.name)) changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** The current status (`net.status`). */
  status(): NetStatus {
    const e = this.engineStatus;
    const state: NetStatus['state'] =
      e !== null
        ? e.state
        : this.authRequired && this.reach === 'online'
          ? 'auth-required'
          : this.reach === 'online'
            ? 'online'
            : this.reach === 'offline'
              ? 'offline'
              : 'connecting';
    return {
      state,
      queuedOps: e?.queuedOps ?? this.queued,
      lastAckAt: e?.lastAckAt ?? this.lastAckAt,
      degraded: [...this.degraded].sort().slice(0, 32),
      leaseTtlMs: e?.leaseTtlMs ?? LEASE_TTL_MS,
      serverBuild: e?.serverBuild ?? this.serverBuild,
    };
  }

  get reachability(): Reachability {
    return this.reach;
  }

  /** Browser online/offline, or the outcome of a server request. */
  setReachable(r: Reachability): void {
    if (this.reach === r) return;
    this.reach = r;
    this.publish();
  }

  setAuthRequired(required: boolean): void {
    if (this.authRequired === required) return;
    this.authRequired = required;
    this.publish();
  }

  setServerBuild(build: string | null): void {
    if (this.serverBuild === build) return;
    this.serverBuild = build;
    this.publish();
  }

  /** syncd's own status (OFF-04 source of truth when a sync engine is linked). */
  setEngineStatus(s: NetStatus | null): void {
    this.engineStatus = s;
    this.publish();
  }

  /** Ops waiting in the outbox (without a sync engine nothing drains them). */
  setQueued(n: number): void {
    const q = Math.max(0, Math.floor(n));
    if (q === this.queued) return;
    this.queued = q;
    this.publish();
  }

  get queuedOps(): number {
    return this.engineStatus?.queuedOps ?? this.queued;
  }

  onChange(cb: (s: NetStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Publish `net.state` if anything the desktop shows changed. */
  publish(): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.bus.publish('net.state', s);
    for (const l of [...this.listeners]) l(s);
  }

  dispose(): void {
    this.bus.unsubscribe(this.sub);
    this.listeners.clear();
  }
}
