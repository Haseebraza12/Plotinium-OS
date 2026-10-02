/**
 * Types of the `lockd` client (offline-and-sync.md §3.14; virtual-file-system.md §3.16;
 * syscall-abi.md §4.4.7 `lock.acquire`, `lock.release`, `lock.status`).
 */
import type { Errno } from '@plotinium/protocol';

export type LeaseMode = 'S' | 'X';
export type LeaseScope = 'server' | 'local';

/**
 * The part of the Web Locks API (`navigator.locks`) lockd uses for local advisory locks when the
 * server layer is not available (PVFS-13). A lock is held until the callback's promise settles.
 */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { readonly name: string } | null) => unknown,
  ): Promise<unknown>;
}

/** A `lock.acquire` from a process (the kernel resolved the path and checked permissions). */
export interface AcquireRequest {
  readonly pid: number;
  readonly ino: string;
  readonly mode: LeaseMode;
  readonly wait: boolean;
  /** Only with `wait` (1..600,000 ms). */
  readonly timeoutMs?: number;
  /** Effective uid of the process (`lock.acquire.principal`). */
  readonly principal: number;
}

export type LockResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errno: Errno;
      readonly reason?: string;
      readonly holder?: string;
    };

/**
 * What a process holds. `fence` is null for a local advisory lock (no server fence exists).
 * TODO(protocol): `LockAcquireRet` requires `fence` and `expiresAt`; VFS §3.4.1 lists them as
 * optional for `scope: 'local'`. The kernel maps null to the ABI until the schema allows it.
 */
export interface Grant {
  readonly leaseId: string;
  readonly fence: number | null;
  /** Client-clock epoch ms, null for a local lock. */
  readonly expiresAt: number | null;
  readonly scope: LeaseScope;
}

/** A foreign lease this device knows about (from `lock.denied.holder` or pushes). */
export interface ForeignLease {
  readonly ino: string;
  readonly username: string;
  readonly mode: LeaseMode;
  /** Server-clock epoch ms. */
  readonly expiresAt: number;
}

/** One row of `lsof` lease data (syscall-abi.md §4.4.2 `LeaseInfo` before path resolution). */
export interface LsofLease {
  readonly ino: string;
  readonly mode: LeaseMode;
  readonly scope: LeaseScope;
  /** `pid <n>` holders on this device, or the foreign holder's username. */
  readonly holder: string;
  readonly pids: readonly number[];
  readonly leaseId: string | null;
  readonly fence: number | null;
  /** Client-clock epoch ms of expiry, null for local locks. */
  readonly expiresAt: number | null;
  /** The countdown (from the server time offset measured by `hb.ack`), null for local locks. */
  readonly remainingMs: number | null;
  readonly foreign: boolean;
  /** Our lease was lost (expired while hidden, revoked); writes follow the stale-fence path. */
  readonly lost: boolean;
}

export type LockTopic = 'lock.granted' | 'lock.queued' | 'lock.lost' | 'lock.released';

/** Kernel events of lockd (syscall-abi.md §4.6: `{ino, mode, holder?, fence?, expiresAt?}`). */
export interface LockEvent {
  readonly topic: LockTopic;
  readonly ino: string;
  readonly mode: LeaseMode;
  readonly holder?: string;
  readonly fence?: number;
  readonly expiresAt?: number;
  /** The processes concerned (for `lock.lost`: the holders that turn read-only). */
  readonly pids: readonly number[];
  readonly reason?: string;
}
