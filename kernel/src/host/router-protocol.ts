/**
 * Router port messages between the main-thread kernel-link router and the kernel worker
 * (architecture.md §4.2; boot-and-services.md §4.5). Kernel-only channel: it never carries system
 * calls and is never exposed to view code.
 *
 * TODO(protocol): move to protocol/src/host/router.ts as Valibot schemas (C3). Plotinium
 * additions not yet in either spec are marked "local": `takeover.steal` (the "Use here" button of
 * ARC-02), `compositor.attach` (the wm service handshake) and the `lost` takeover state.
 *
 * The I/O layer (kernel/src/core/io) adds its own router messages, carried on the same port:
 *   router → kernel  `net.offline`, `viewport`, `sw` and the LOGIN channel (`login.hello`,
 *                    `login.submit`, `login.guest`, `login.unlock`, `login.logout`) that the
 *                    login screen and the lock screen speak (wm/src/shell `AuthEnv`);
 *   kernel → router  `IoToRouter`: `login.state`, `login.result`, `login.session`,
 *                    `login.loggedOut`, `login.lock`.
 * The worker forwards the first set to `kernel.io.router`, and posts the second set as is.
 */
import type { BootProfile, ServiceName, ServiceState, SwEvent } from '@plotinium/services';

import type { IoRouterEvent, IoToRouter } from '../core/io/types.ts';

/** The login-channel messages of the I/O layer (router → kernel). */
export type LoginRouterMessage = Extract<
  IoRouterEvent,
  { readonly t: 'login.hello' | 'login.submit' | 'login.guest' | 'login.unlock' | 'login.logout' }
>;

/**
 * The desktop host's requests (`host.request` → `host.reply`: the memory budget, the outbox list,
 * file search) and the page's CSP/Trusted Types violation reports (`sec.violation`, logged to
 * klog), router → kernel (kernel/src/core/io/host.ts).
 */
export type HostRouterMessage = Extract<
  IoRouterEvent,
  { readonly t: 'host.request' | 'sec.violation' }
>;

export type KlogLevel = 'info' | 'warn' | 'degraded' | 'fail' | 'panic';

/** One boot-log line; `t` is seconds since t0 (boot-and-services.md §4.5 `KlogLine`). */
export interface KlogLine {
  readonly t: number;
  readonly sub: string;
  readonly level: KlogLevel;
  readonly msg: string;
}

/** POST capability matrix (boot-and-services.md §3.2.1; architecture.md §4.2 `PostReport`). */
export interface CapabilityMatrix {
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly sab: boolean;
  readonly moduleWorkers: boolean;
  readonly indexedDB: boolean;
  readonly webLocks: boolean;
  readonly cryptoSubtle: boolean;
  readonly serviceWorker: boolean;
  readonly serviceWorkerControlled: boolean;
  readonly compressionStream: boolean;
  readonly measureMemory: boolean;
  readonly estimate: { readonly usage: number; readonly quota: number };
}

export interface BootFlags {
  readonly menuNextBoot?: boolean;
}

export interface BootOutcome {
  readonly seq: number;
  readonly outcome: 'interactive' | 'panic' | 'recovery' | 'incomplete' | 'unsupported';
}

export type RouterToKernel =
  | {
      readonly t: 'boot.start';
      readonly t0: number;
      readonly profile: BootProfile;
      readonly verbose: boolean;
      readonly flags: readonly string[];
      readonly caps: CapabilityMatrix;
      readonly preKernelLog: readonly KlogLine[];
    }
  | { readonly t: 'boot.userWait'; readonly phase: 'begin' | 'end'; readonly at: number }
  | { readonly t: 'desktop.interactive'; readonly at: number }
  | { readonly t: 'asset.done'; readonly url: string; readonly bytes: number }
  | { readonly t: 'net.online' }
  | { readonly t: 'visibility'; readonly state: 'hidden' | 'visible' }
  | { readonly t: 'pagehide' }
  | { readonly t: 'persist'; readonly persisted: boolean }
  | { readonly t: 'interactive'; readonly active: boolean }
  | { readonly t: 'frame'; readonly p95Ms: number; readonly loafOver50: number }
  | {
      readonly t: 'recovery.run';
      readonly action:
        | 'fsck'
        | 'fsck-repair'
        | 'clear-cache'
        | 'reset-session'
        | 'restore-manifests'
        | 'bootlog'
        | 'diagnostics';
    }
  // local
  | { readonly t: 'takeover.steal' }
  | { readonly t: 'compositor.attach'; readonly port: MessagePort }
  // the I/O layer (kernel/src/core/io)
  | { readonly t: 'net.offline' }
  | { readonly t: 'viewport'; readonly w: number; readonly h: number; readonly dpr: number }
  | { readonly t: 'sw'; readonly event: SwEvent }
  | LoginRouterMessage
  | HostRouterMessage;

export type KernelToRouter =
  | {
      readonly t: 'loader.config';
      readonly bootFlags: BootFlags;
      readonly recentBoots: readonly BootOutcome[];
      readonly volumeOk: boolean;
    }
  | { readonly t: 'takeover'; readonly state: 'held-elsewhere' | 'granted' | 'lost' }
  | {
      readonly t: 'boot.target';
      readonly target: 'desktop' | 'recovery';
      readonly weights: Readonly<Record<ServiceName, number>>;
    }
  | {
      readonly t: 'svc.event';
      readonly name: ServiceName;
      readonly state: ServiceState;
      readonly at: number;
      readonly label?: string;
      readonly reason?: string;
    }
  | { readonly t: 'asset.done'; readonly url: string; readonly bytes: number }
  | { readonly t: 'klog'; readonly lines: readonly KlogLine[] }
  | {
      readonly t: 'panic';
      readonly kind: 'cycle' | 'manifest' | 'critical' | 'kernel';
      readonly text: string;
      readonly cycle?: readonly string[];
    }
  | { readonly t: 'kernel.ready' }
  | { readonly t: 'kernel.halted'; readonly restart: string | null }
  | { readonly t: 'swRegister' }
  | { readonly t: 'swSkipWaiting' }
  | { readonly t: 'memMeasure' }
  // the I/O layer (kernel/src/core/io): the login screen, the console session, lock, logout
  | IoToRouter;

export const KERNEL_LOCK_NAME = 'plotinium:kernel';

export function isKernelToRouter(x: unknown): x is KernelToRouter {
  return x !== null && typeof x === 'object' && typeof (x as { t?: unknown }).t === 'string';
}
