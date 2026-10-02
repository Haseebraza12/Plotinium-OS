/**
 * The `sync` and `lockd` services' ports (offline-and-sync.md §3.2, §3.7, §3.14; OFF-01, OFF-04).
 *
 * With a sync engine linked (`IoDeps.engines`, the vfs `Syncd`/`Lockd` clients), `sync` loads the
 * outbox without network I/O at start, connects after desktop-interactive and reports LIVE or
 * DEGRADED from the engine's `net.state`. Without one, the local store is authoritative: every
 * mutation still goes through the outbox (so nothing is lost), `sync` is DEGRADED with the queued
 * op count, and locks are local advisory leases.
 */
import type { LockdPort, SyncPort, SyncProbe } from '@plotinium/services';
import type { NetStatus } from '@plotinium/protocol';

import type { Kernel } from '../kernel.ts';
import type { EngineFactory, LockEngine, SyncEngine } from '../net/engines.ts';
import type { NetMonitor } from '../net/monitor.ts';
import type { HomeLink } from './home-link.ts';
import type { ConsoleSession } from './login.ts';

export const NO_ENGINE_REASON = 'sync client not linked';

export interface SyncIoDeps {
  readonly kernel: Kernel;
  readonly net: NetMonitor;
  readonly engines: EngineFactory | undefined;
  readonly origin: string | undefined;
  readonly console: () => ConsoleSession | null;
  readonly epoch: () => number;
  /** Queued outbox ops (a count read from the store when no engine drains them). */
  readonly queued: () => Promise<number>;
  readonly notify: (title: string, body: string, level: 'info' | 'warning' | 'error') => void;
  /**
   * Whether the console user's home is the server's home (home-link.ts, UI-006). The engine is
   * only linked when it is: otherwise every op under the home would be rejected and reverted.
   */
  readonly link?: (s: ConsoleSession) => Promise<HomeLink>;
}

function wsUrl(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

export class SyncIo implements SyncPort {
  private readonly deps: SyncIoDeps;
  private engine: SyncEngine | null = null;
  private locks: LockEngine | null = null;
  private readonly listeners = new Set<(p: SyncProbe) => void>();
  private connectWanted = false;
  private unsub: (() => void) | null = null;
  private starting: Promise<SyncProbe> | null = null;
  private stopped = false;

  constructor(deps: SyncIoDeps) {
    this.deps = deps;
  }

  get syncEngine(): SyncEngine | null {
    return this.engine;
  }

  get lockEngine(): LockEngine | null {
    return this.locks;
  }

  private probeOf(s: NetStatus): SyncProbe {
    if (s.state === 'online') return { live: true, reason: 'live', selfHeals: true };
    const queued = s.queuedOps > 0 ? ` · ${String(s.queuedOps)} queued` : '';
    return { live: false, reason: `${s.state}${queued}`, selfHeals: s.state !== 'auth-required' };
  }

  private noEngineProbe(): SyncProbe {
    const q = this.deps.net.queuedOps;
    return {
      live: false,
      reason: `${NO_ENGINE_REASON}${q > 0 ? ` · ${String(q)} queued` : ''}`,
      selfHeals: false,
    };
  }

  start(): Promise<SyncProbe> {
    this.stopped = false;
    this.starting ??= this.startOnce().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startOnce(): Promise<SyncProbe> {
    const { engines, origin, net } = this.deps;
    try {
      net.setQueued(await this.deps.queued());
    } catch {
      // A count we cannot read is shown as 0; the outbox itself is intact.
    }
    if (this.engine !== null) {
      const st = this.engine.status();
      return st.status === null
        ? { live: false, reason: 'connecting', selfHeals: true }
        : this.probeOf(st.status);
    }
    const s = this.deps.console();
    if (engines === undefined || origin === undefined || s === null || s.mode === 'local') {
      return this.noEngineProbe();
    }
    const link = this.deps.link === undefined ? null : await this.deps.link(s);
    if (link !== null && !link.linked) {
      const q = net.queuedOps;
      return {
        live: false,
        reason: `${link.reason}${q > 0 ? ` · ${String(q)} queued` : ''}`,
        selfHeals: link.selfHeals,
      };
    }
    if (this.stopped) return this.noEngineProbe();
    const kernel = this.deps.kernel;
    const engine = engines.sync(
      {
        // Read at every `hello`: the session service replaces the OS session id after sync
        // started, and the server only accepts ops of the session a connection announced.
        get osSessionId(): string {
          return kernel.osSessionId;
        },
        loginUid: s.uid,
        kernelEpoch: this.deps.epoch(),
        url: wsUrl(origin),
      },
      {
        status: (status) => {
          net.setEngineStatus(status);
          const p = this.probeOf(status);
          for (const l of [...this.listeners]) l(p);
        },
        notice: (kind, text) => {
          this.deps.notify(
            kind === 'rejected' ? 'A change was not saved' : 'Sync',
            text,
            kind === 'rejected' ? 'error' : 'info',
          );
        },
      },
    );
    await engine.start();
    this.engine = engine;
    this.locks = engines.locks?.(engine) ?? null;
    if (this.connectWanted) engine.connect();
    const st = engine.status();
    return st.status === null
      ? { live: false, reason: 'connecting', selfHeals: true }
      : this.probeOf(st.status);
  }

  /** After desktop-interactive (§3.2: no network I/O on the boot path). */
  connect(): void {
    this.connectWanted = true;
    this.engine?.connect();
  }

  retry(): Promise<SyncProbe> {
    const e = this.engine;
    // Not linked yet (the server did not answer, or the home was not verified): try again.
    if (e === null) return this.start();
    e.setOnline(true);
    e.connect();
    const st = e.status();
    return Promise.resolve(
      st.status === null
        ? { live: false, reason: 'connecting', selfHeals: true }
        : this.probeOf(st.status),
    );
  }

  onChange(cb: (p: SyncProbe) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  kick(): void {
    this.engine?.kick();
  }

  setOnline(online: boolean): void {
    this.engine?.setOnline(online);
  }

  onVisible(): void {
    this.engine?.onVisible();
    this.locks?.onVisible();
  }

  /** Flush the outbox (waits up to 3 s for acks, §3.10) and close. */
  async stop(reason: 'shutdown' | 'reboot' | 'logout' = 'shutdown'): Promise<void> {
    this.stopped = true;
    const e = this.engine;
    this.unsub?.();
    this.unsub = null;
    if (e === null) return;
    await e.shutdown(reason);
    this.engine = null;
    this.locks = null;
    this.deps.net.setEngineStatus(null);
  }
}

export class LockdIo implements LockdPort {
  private readonly sync: SyncIo;
  private readonly cbs = new Set<(server: boolean) => void>();
  private last = false;

  constructor(sync: SyncIo) {
    this.sync = sync;
    sync.onChange(() => {
      const now = this.server;
      if (now === this.last) return;
      this.last = now;
      for (const cb of [...this.cbs]) cb(now);
    });
  }

  get server(): boolean {
    return this.sync.lockEngine?.serverEngaged === true;
  }

  start(): Promise<{ readonly server: boolean }> {
    this.last = this.server;
    return Promise.resolve({ server: this.last });
  }

  onServer(cb: (server: boolean) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
