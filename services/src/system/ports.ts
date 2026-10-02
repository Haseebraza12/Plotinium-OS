/**
 * The ports the real system services start through (boot-and-services.md §3.3, §4.2).
 *
 * services/ may import only protocol and dsa (architecture.md §3.7), so every service here is the
 * boot-side policy (labels, log lines, DEGRADED with a reason, self-healing back-off, the user-wait
 * window) over a small port that the kernel implements (kernel/src/core/io). Each port method is
 * one "started means" item of the §3.3 table, so a service's start resolves exactly when its
 * manifest description is true.
 */
import type { BootProfile } from '../types.ts';

// ---------------------------------------------------------------------------------------------
// storage (critical, L1)
// ---------------------------------------------------------------------------------------------

export interface StorageOpened {
  /** `memory` only when the host has no IndexedDB (Node tests, a demo without storage). */
  readonly backend: 'indexeddb' | 'memory';
  /** Why the memory backend was chosen; null for IndexedDB. */
  readonly fallback: string | null;
  readonly schemaVersion: number;
  /** The fencing epoch after this boot's bump (ARC-02, PVFS-03). */
  readonly epoch: number;
  /** No `meta.mkfsDone` yet: the vfs service will run mkfs. */
  readonly firstBoot: boolean;
  /** `navigator.storage.persisted()`; null when the host cannot tell. */
  readonly persisted: boolean | null;
  /** The boot record created in `bootlog` (SVC-09). */
  readonly bootId: string;
}

export interface StoragePort {
  /** Open `plotinium` at this build's version, migrate, bump the epoch, create the boot record. */
  open(profile: BootProfile): Promise<StorageOpened>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// vfs (critical, L2)
// ---------------------------------------------------------------------------------------------

export interface VfsMounted {
  readonly backend: 'indexeddb' | 'memory';
  /** First-boot mkfs ran (standard hierarchy plus the seed). */
  readonly mkfs: boolean;
  /** Seeded files written by that mkfs (0 when mkfs did not run). */
  readonly seeded: number;
  readonly tmpCleared: number;
  readonly epoch: number;
  readonly users: number;
  /** Recovery mode mounts read-only (SVC-06). */
  readonly readOnly: boolean;
  /** No sync engine: the local store is authoritative (VFS §3.17.2). */
  readonly standalone: boolean;
}

export interface VfsPort {
  mount(profile: BootProfile): Promise<VfsMounted>;
  unmount(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// mm (critical, L2)
// ---------------------------------------------------------------------------------------------

export interface MmStarted {
  readonly budgetBytes: number;
  /** `opfs`, `indexeddb`, `memory` or `none`. */
  readonly swap: string;
  /** Page-out and page-in are available (a swap device and the executor mm frames are linked). */
  readonly paging: boolean;
  /** The `*.tmp` sweep of §3.10.3; null when there is no device. */
  readonly swept: { readonly files: number; readonly bytes: number } | null;
  /** A WARN line to log (for example "accounting only"). */
  readonly note: string | null;
}

export interface MmPort {
  start(profile: BootProfile): Promise<MmStarted>;
  /** The 1 s memory-manager tick (reclaim watermarks, write-behind). */
  tick(): void;
  /** Publish the memory statistics the desktop shows (`mem.pressure`). */
  publish(): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// login (critical, L4, userWait) and session (critical, L5)
// ---------------------------------------------------------------------------------------------

export type AccountKind = 'user' | 'guest' | 'demo' | 'examiner' | 'root';

/** How the session uid was established (boot-and-services.md §3.2 stage 5). */
export type LoginMode = 'cached' | 'online' | 'offline' | 'guest' | 'local';

export interface LoginOutcome {
  readonly uid: number;
  readonly username: string;
  readonly kind: AccountKind;
  readonly mode: LoginMode;
}

export interface LoginPort {
  /** A still-valid session (the server cookie, `GET /api/auth/me`), or null. Never prompts. */
  resume(): Promise<LoginOutcome | null>;
  /**
   * Show the login view (a window owned by the `login` service process `pid`) and resolve once a
   * login succeeded. The wait is user wait.
   */
  prompt(pid: number): Promise<LoginOutcome>;
  /** Make the uid the console user: users mirror, home directory, kernel session. */
  establish(o: LoginOutcome): Promise<{ readonly home: string }>;
  stop(): Promise<void>;
}

export interface SessionRestored {
  readonly osSessionId: string;
  /** Windows in the restored layout (frames queued for their apps). */
  readonly windows: number;
  /** An invalid layout was kept for recovery and a clean session started (stage 6). */
  readonly recovered: boolean;
  readonly source: 'layout' | 'clean';
}

export interface SessionPort {
  restore(profile: BootProfile): Promise<SessionRestored>;
  /** Write the layout now (`strict` at shutdown, BOOT-12). */
  save(durability: 'strict' | 'relaxed'): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// auth, sync, lockd (non-critical, network)
// ---------------------------------------------------------------------------------------------

export type AuthCheck =
  | {
      readonly status: 'ok';
      readonly username: string;
      /** `/version.json` differs from the running build (OFF-05): the update service is told. */
      readonly newer: { readonly version: string; readonly build: string } | null;
    }
  /** An offline or local-guest session: nothing on the server to validate. */
  | { readonly status: 'local'; readonly why: string }
  | { readonly status: 'offline' }
  | { readonly status: 'foreign-server'; readonly name: string }
  | { readonly status: 'auth-required' };

export interface AuthPort {
  /** `/version.json` identity check plus `GET /api/auth/me` (which also slides the session). */
  check(): Promise<AuthCheck>;
  /** The router's `online` event: retry now. Returns the unsubscribe function. */
  onOnline(cb: () => void): () => void;
}

export interface SyncProbe {
  readonly live: boolean;
  /** Tray reason while not live, for example `offline · 3 queued`. */
  readonly reason: string;
  /** false: retrying cannot help (no engine linked, foreign server). */
  readonly selfHeals: boolean;
}

export interface SyncPort {
  start(): Promise<SyncProbe>;
  /** Try to reach LIVE now (reconnect); resolves with the new probe. */
  retry(): Promise<SyncProbe>;
  /** Connection state changes after start. Returns the unsubscribe function. */
  onChange(cb: (p: SyncProbe) => void): () => void;
  /** Flush the outbox (waits up to 3 s for acks, §3.10) and close. */
  stop(): Promise<void>;
}

export interface LockdPort {
  /** Lease table ready; `server` false means local advisory locks only. */
  start(): Promise<{ readonly server: boolean }>;
  onServer(cb: (server: boolean) => void): () => void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// ai.*, complete, update (non-critical)
// ---------------------------------------------------------------------------------------------

export type AiServiceName = 'ai.runtime' | 'ai.indexer' | 'ai.predictor' | 'ai.agent';

export type AiStart =
  | { readonly status: 'running'; readonly detail: string }
  | { readonly status: 'degraded'; readonly reason: string; readonly selfHeals: boolean };

export interface AiPort {
  start(name: AiServiceName, profile: BootProfile): Promise<AiStart>;
  stop(name: AiServiceName): Promise<void>;
}

export interface CompleteStarted {
  readonly cmd: number;
  readonly flag: number;
  readonly hist: number;
  readonly path: number;
}

export interface CompletePort {
  start(): Promise<CompleteStarted>;
  stop(): Promise<void>;
}

export type SwOutcome = 'registered' | 'unsupported' | 'error';
export type SwEvent = 'registered' | 'waiting' | 'activated' | 'error';

export interface UpdatePort {
  /** Ask the router to register the Service Worker (after interactive plus idle). */
  register(): void;
  /** Service Worker events from the router. Returns the unsubscribe function. */
  onEvent(cb: (e: SwEvent) => void): () => void;
  /** Whether the platform has Service Workers at all (POST capability). */
  supported(): boolean;
}

/** Every port the real services need; the kernel's `installIo` builds this object. */
export interface SystemPorts {
  readonly storage: StoragePort;
  readonly vfs: VfsPort;
  readonly mm: MmPort;
  readonly login: LoginPort;
  readonly session: SessionPort;
  readonly auth: AuthPort;
  readonly sync: SyncPort;
  readonly lockd: LockdPort;
  readonly ai: AiPort;
  readonly complete: CompletePort;
  readonly update: UpdatePort;
}
