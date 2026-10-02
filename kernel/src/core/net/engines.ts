/**
 * The sync and lock engines as the kernel drives them (offline-and-sync.md §3.2; the `syncd` and
 * `lockd` clients of vfs/src/sync and vfs/src/locks).
 *
 * These are STRUCTURAL interfaces. The default factory over vfs's `Syncd` and `Lockd` is
 * ./factory.ts (UI-006), built by `installIo` when the host binds a socket; a host or test may pass
 * its own (`IoDeps.engines`). Without either, `sync` reports DEGRADED "sync client not linked" and
 * locks are local advisory locks (net/locks.ts).
 */
import type { NetStatus } from '@plotinium/protocol';

/** What syncd reports through its host (`SyncHost.status` / `notice`). */
export interface SyncEngineHost {
  /** `net.state` changed (OFF-04). */
  status(status: NetStatus, label: string): void;
  /** A sync notice (rejected, conflict, refetch, …): the kernel maps it to a notification. */
  notice(kind: string, text: string): void;
  /** Rows changed by a sync transaction; the kernel applies them to the tree and publishes. */
  applied?(effect: unknown): void;
}

export interface SyncEngine {
  /** Load the outbox and cursors; no network I/O (§3.2). */
  start(): Promise<void>;
  /** Open the WebSocket (after desktop-interactive). */
  connect(): void;
  kick(): void;
  setOnline(online: boolean): void;
  onVisible(): void;
  status(): { status: NetStatus | null; label: string };
  /** Resolves when the outbox is empty. */
  idle(): Promise<void>;
  /** Flush and close; `reason` is the `bye` the server echoes in its close frame (UI-166). */
  shutdown(reason?: 'shutdown' | 'reboot' | 'logout' | 'takeover' | 'update'): Promise<void>;
}

export interface LockEngineGrant {
  readonly leaseId: string;
  readonly fence: number | null;
  readonly expiresAt: number | null;
  readonly scope: 'server' | 'local';
}

export interface LockEngine {
  acquire(req: {
    readonly pid: number;
    readonly ino: string;
    readonly path: string;
    readonly mode: 'S' | 'X';
    readonly wait: boolean;
    readonly timeoutMs?: number;
    /** Effective uid of the process (`lock.acquire.principal`). */
    readonly principal?: number;
  }): Promise<LockEngineGrant>;
  release(leaseId: string, pid: number): Promise<void>;
  releaseAll(pid: number): void;
  onVisible(): void;
  /** Whether the server layer is engaged (LIVE); false: local advisory locks only. */
  readonly serverEngaged: boolean;
}

export interface EngineSession {
  readonly osSessionId: string;
  readonly loginUid: number;
  readonly kernelEpoch: number;
  readonly url: string;
}

/** Builds the engines for one login session; the host passes it (see the module comment). */
export interface EngineFactory {
  sync(session: EngineSession, host: SyncEngineHost): SyncEngine;
  locks?(sync: SyncEngine): LockEngine;
}
