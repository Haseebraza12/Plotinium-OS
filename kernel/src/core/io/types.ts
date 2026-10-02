/**
 * What `installIo` needs from its host and what it gives back (architecture.md §4.4).
 *
 * kernel/src/core never touches platform globals (§3.7): the worker host passes `indexedDB`,
 * `navigator.storage`, a same-origin `fetch`, `crypto.subtle` and a `MessageChannel` factory in
 * `IoPlatform`; the Node loopback and the tests pass nothing (memory store, no network).
 *
 * Two message sets cross the ROUTER port (kernel-only; never view code) besides the boot ones of
 * host/router-protocol.ts: `IoRouterEvent` (router → kernel: connectivity, visibility, Service
 * Worker events and the LOGIN channel the shell's `AuthEnv` speaks) and `IoToRouter` (kernel →
 * router: the login screen's state and results, the console session, logout).
 */
import type {
  AiServiceName,
  KernelTimers,
  ServiceImpl,
  ServiceManager,
  ServiceName,
  SwEvent,
  SystemPorts,
} from '@plotinium/services';
import type { ArgsOf } from '@plotinium/protocol';
import type { LockManagerLike } from '@plotinium/vfs/locks';
import type { SocketFactory } from '@plotinium/vfs/sync';

import type { FrameScheduler } from '../events/batch.ts';
import type { FsStore, StorageManagerLike } from '../fs/store.ts';
import type { KernelFs } from '../fs/kfs.ts';
import type { HookRegistry } from '../hooks/index.ts';
import type { Caller } from '../ipc/ports.ts';
import type { MemExecutorPort } from '../mm/mm.ts';
import type { RemoteSwap, SwapDevice } from '../mm/swap.ts';
import type { EngineFactory } from '../net/engines.ts';
import type { NetMonitor } from '../net/monitor.ts';
import type { Windows } from '../window/service.ts';
import type { HostQueuedOp, HostReplyValue, HostRequest } from './host.ts';
import type { ChannelFactory, PortLike } from '../window/types.ts';

/** A same-origin fetch (`credentials: 'same-origin'`, the session cookie rides along). */
export type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

export interface IoPlatform {
  /** The worker's `indexedDB`; null or absent: the memory store (tests, no storage). */
  readonly indexedDB?: IDBFactory | null;
  /** `navigator.storage` (estimate, persisted). */
  readonly storage?: StorageManagerLike;
  /** Same-origin fetch for `/api/*` and `/version.json`; absent: no server (offline demo). */
  readonly fetch?: FetchLike;
  /** `location.origin`, for the `/ws` URL. */
  readonly origin?: string;
  /** WebCrypto for the offline verifier (PBKDF2-SHA256, SHA-256). */
  readonly subtle?: SubtleCrypto;
  readonly randomBytes?: (n: number) => Uint8Array;
  /** `() => new MessageChannel()`; absent: windows cannot be created (EAGAIN). */
  readonly channel?: ChannelFactory;
  /** `navigator.onLine` at boot. */
  readonly online?: boolean;
  /** POST: whether Service Workers exist (the `update` service). */
  readonly serviceWorker?: boolean;
  /**
   * Opens the sync WebSocket (vfs `browserSocket` in the worker). With `fetch` and `origin` it
   * links the default sync and lock engines (core/net/factory.ts, UI-006); absent: standalone.
   */
  readonly socket?: SocketFactory;
  /** `navigator.locks` (lockd's local advisory locks while the server layer is down). */
  readonly locks?: LockManagerLike;
  /** The OS time zone (sync's conflicted-copy dates). */
  readonly timeZone?: string;
}

/** One file of the first-boot seed (/bin manifests, man pages, /system/branding, …). */
export interface SeedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Default 0644 (0755 for scripts is the caller's choice). */
  readonly mode?: number;
}

/**
 * Overrides for the process-side actions of the desktop. Every one has a kernel default (the
 * spawner on `kernel.proc`, the kill path, the scheduler's focus boost), so a host passes this
 * only to replace one.
 */
export interface ProcLink {
  /** SIGTERM on a window close request, SIGKILL on Force quit (window-manager.md §3.12). */
  signal?(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  /** Start an app for the console user (the dock, launcher, session restore). */
  launch?(app: string, argv: readonly string[], user: { uid: number; gid: number }): void;
  /** Focus moved to `pid` (the scheduler's boost; mm pins it). */
  focus?(pid: number | null): void;
  /** First input per 100 ms on a window of `pid` (activation, pre-empt flag). */
  input?(pid: number): void;
}

/** What the host's AI link can reach once it is built (the kernel file system appears later). */
export interface AiLinkContext {
  /** The kernel's AI seams (@plotinium/kernel/hooks). */
  readonly hooks: HookRegistry;
  /** The mounted file system (null until the `vfs` service started). */
  fs(): KernelFs | null;
  /** The console user's uid (undefined before login). */
  sessionUid(): number | undefined;
  osSessionId(): string;
  online(): boolean;
}

/**
 * The ai/ package as the kernel sees it (C12). The kernel may not import ai/, so web's kernel
 * worker entry builds it with `installAi(...)` from `@plotinium/ai/kernel` and hands over:
 * its four service implementations (they register the `ai.*` calls and the seams themselves at
 * start) and the few kernel-side callbacks. Without a link, or in the `__AI__=false` build, the
 * four services start DEGRADED and every `ai.*` call stays ENOSYS (the litmus build boots).
 */
export interface AiLink {
  readonly services: Readonly<Partial<Record<AiServiceName, ServiceImpl>>>;
  /** The agent `batch` gate (AGT-03): `registerFsSyscalls(…, {verifyPlanToken})`. */
  verifyPlanToken?(caller: Caller, args: ArgsOf<'batch'>): Error | null;
  /** The kill/exit path (AGT-09). */
  onProcessExit?(pid: number): void;
  /** desktop-interactive (the model may load after 2 s more of idle, BOOT-10). */
  desktopInteractive?(): void;
  /** Router input (throttle and idle facts). */
  noteInput?(): void;
}

/** The memory manager's host-side devices (memory-and-paging.md; the blkio worker). */
export interface MemoryLink {
  /** The swap device (blkio: OPFS or IndexedDB); absent: an in-memory device (no persistence). */
  readonly device?: SwapDevice;
  /** Override of the executor page frames (tests); default: `kernel.proc`'s. */
  readonly executor?: MemExecutorPort;
  readonly remote?: RemoteSwap;
  readonly localCap?: number;
  /** A WARN for the boot log (for example the blkio fallback). */
  readonly note?: string;
}

export interface LoginOptions {
  /** User tiles always shown (the seeded accounts); default demo, alice, bob. */
  readonly knownUsers?: readonly string[];
  /** Resume a valid server session without the login screen (§3.2 stage 5 "cached session"). */
  readonly autoResume?: boolean;
  /** Offer the Guest tile (default true). */
  readonly guest?: boolean;
}

export type PowerAction = 'reboot' | 'poweroff';
export type RebootNext = 'normal' | 'menu' | 'safe';

export interface IoDeps {
  readonly platform?: IoPlatform;
  /** The kernel timer heap (services, debounces, request timeouts). */
  readonly timers: KernelTimers;
  /** One callback per animation frame (event batches to the compositor, B2). */
  readonly frame?: FrameScheduler;
  /** The seed of first-boot mkfs besides /system/services and /bin (built in). */
  readonly seed?: () => Promise<readonly SeedFile[]>;
  /** The syncd/lockd clients of vfs/src/sync and vfs/src/locks (see net/engines.ts). */
  readonly engines?: EngineFactory;
  readonly ai?: AiLink | ((ctx: AiLinkContext) => AiLink);
  /** Whether this build has AI at all (`__AI__`, C12); default true. */
  readonly aiEnabled?: boolean;
  readonly memory?: MemoryLink;
  readonly proc?: ProcLink;
  readonly login?: LoginOptions;
  /** The service manager, once built (`bootlog`, `svc.status`, `svc.restart`). */
  readonly services?: () => ServiceManager | null;
  /** Main-thread `performance.timeOrigin` of this boot (boot-log times are seconds since it). */
  readonly t0?: () => number;
  readonly bootFlags?: readonly string[];
  readonly verbose?: boolean;
  /** Ask the router to register the Service Worker. */
  readonly requestSwRegister?: () => void;
  /** Tests: use this store instead of opening IndexedDB. */
  readonly store?: FsStore;
  /** Kernel → router messages of the I/O layer (login screen, console session). */
  readonly post?: (msg: IoToRouter) => void;
  /**
   * After the BOOT-12 steps the kernel owns (layout saved strict, boot record closed): stop the
   * services and end with `kernel.halted {restart}` (the host's boot sequence).
   */
  readonly halt?: (kind: PowerAction, next: RebootNext) => void;
  /** Tests: the login verifier's PBKDF2 iterations. */
  readonly verifierIterations?: number;
}

/** The console user as the shell's `Session` needs it (wm/src/shell/env.ts). */
export interface SessionInfo {
  readonly uid: number;
  readonly user: string;
  readonly kind: 'user' | 'guest' | 'demo';
  readonly home: string;
  /** How the session was established. */
  readonly mode: 'cached' | 'online' | 'offline' | 'guest' | 'local';
}

/** One login tile (ui/src/login `LoginUser`, minus the callbacks). */
export interface LoginViewUser {
  readonly id: string;
  readonly name: string;
  readonly kind: 'user' | 'guest';
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

/** What the login screen renders (`login.state`). */
export interface LoginViewState {
  readonly users: readonly LoginViewUser[];
  /** The server is unreachable: the offline verifier is used (OFF-03). */
  readonly offline: boolean;
  /** The `login` service is waiting for the user right now. */
  readonly waiting: boolean;
  /** Already signed in (a cached server session): the login screen is skipped. */
  readonly session: SessionInfo | null;
  readonly version: string;
  readonly build: string;
}

export type LoginReply =
  | { readonly ok: true; readonly session: SessionInfo }
  | {
      readonly ok: false;
      readonly error: string;
      /** Epoch ms when a rate-limit back-off ends. */
      readonly retryAt?: number;
    };

/** Router events the I/O layer reacts to (the host forwards them). */
export type IoRouterEvent =
  | { readonly t: 'online' }
  | { readonly t: 'offline' }
  | { readonly t: 'visibility'; readonly state: 'hidden' | 'visible' }
  | { readonly t: 'desktop.interactive' }
  | { readonly t: 'sw'; readonly event: SwEvent }
  | { readonly t: 'persist'; readonly persisted: boolean }
  | { readonly t: 'pagehide' }
  | { readonly t: 'viewport'; readonly w: number; readonly h: number; readonly dpr: number }
  /** The login screen mounted: send `login.state`. */
  | { readonly t: 'login.hello' }
  | {
      readonly t: 'login.submit';
      readonly rid: number;
      readonly user: string;
      readonly secret: string;
    }
  | { readonly t: 'login.guest'; readonly rid: number }
  /** The lock screen: verify the console user's password again. */
  | {
      readonly t: 'login.unlock';
      readonly rid: number;
      readonly user: string;
      readonly secret: string;
    }
  | { readonly t: 'login.logout' }
  /** A request of the desktop host, answered with `host.reply` (./host.ts). */
  | { readonly t: 'host.request'; readonly rid: number; readonly req: HostRequest }
  /**
   * A `securitypolicyviolation` the page saw (CSP or Trusted Types): logged to klog, once per
   * directive and sample (security-model.md §3.9: "reported to the kernel log").
   */
  | {
      readonly t: 'sec.violation';
      readonly directive: string;
      readonly disposition: 'enforce' | 'report';
      readonly sample: string;
      readonly source: string;
    };

/** Kernel → router messages of the I/O layer. */
export type IoToRouter =
  | { readonly t: 'login.state'; readonly state: LoginViewState }
  | ({ readonly t: 'login.result'; readonly rid: number } & LoginReply)
  | {
      readonly t: 'login.session';
      readonly session: SessionInfo | null;
      readonly osSessionId: string;
    }
  /** The session ended (logout): the router reloads to the login screen. */
  | { readonly t: 'login.loggedOut' }
  /** `auth.lock` or the menu bar's Lock Screen: the shell shows the lock screen. */
  | { readonly t: 'login.lock' }
  /** The answer to a `host.request`. */
  | {
      readonly t: 'host.reply';
      readonly rid: number;
      readonly ok: true;
      readonly value: HostReplyValue;
    }
  | {
      readonly t: 'host.reply';
      readonly rid: number;
      readonly ok: false;
      readonly errno: string;
      readonly error: string;
    }
  /** The outbox changed: the operations waiting (for the connectivity popover, UI-026). */
  | { readonly t: 'outbox'; readonly ops: readonly HostQueuedOp[]; readonly queued: number };

export interface Io {
  readonly ports: SystemPorts;
  /** The real implementations of storage, mm, vfs, login, session, auth, sync, lockd, ai.*, complete, update. */
  readonly services: ReadonlyMap<ServiceName, ServiceImpl>;
  readonly windows: Windows;
  readonly net: NetMonitor;
  /** The mounted file system (null until the `vfs` service started). */
  fs(): KernelFs | null;
  /** Called once the file system is mounted (at once when it already is). */
  onMounted(cb: (fs: KernelFs) => void): () => void;
  /** This boot's record id (null before `storage` created it). */
  bootId(): string | null;
  /** Bind the compositor port (the router's `compositor.attach`). */
  attachCompositor(port: PortLike): void;
  router(ev: IoRouterEvent): void;
  /** BOOT-12: save the session (strict), flush the boot record. */
  shutdown(kind: 'reboot' | 'poweroff' | 'pagehide'): Promise<void>;
  dispose(): void;
}
