/**
 * The main-thread kernel-link router (architecture.md §3.6 and §4.2; boot-and-services.md §3.2,
 * §3.14, §4.5). It owns the router port (the kernel worker itself), turns kernel boot events into
 * truthful progress, forwards platform calls that only a Window can make, marks
 * `desktop-interactive`, and installs the ARC-07 shadows before any app view chunk loads.
 *
 * Only OS code that must be on the main thread lives here (boundary B2): no kernel logic, no
 * Valibot. The router keeps the worker reference in this closure and never hands it to views.
 */
import type { BootProfile, ProgressSnapshot, ServiceName } from '@plotinium/services';
import { BootProgress } from '@plotinium/services';

import type {
  BootFlags,
  BootOutcome,
  CapabilityMatrix,
  KlogLine,
  RouterToKernel,
} from './router-protocol.ts';
import { isKernelToRouter } from './router-protocol.ts';

export type {
  CapabilityMatrix,
  KernelToRouter,
  KlogLine,
  RouterToKernel,
} from './router-protocol.ts';
export { BootProgress } from '@plotinium/services';
export type { BootProfile, ProgressSnapshot } from '@plotinium/services';

export interface LoaderConfig {
  readonly bootFlags: BootFlags;
  readonly recentBoots: readonly BootOutcome[];
  readonly volumeOk: boolean;
}

export interface BootStartParams {
  readonly t0: number;
  readonly profile: BootProfile;
  readonly verbose: boolean;
  readonly flags: readonly string[];
  readonly caps: CapabilityMatrix;
  readonly preKernelLog: readonly KlogLine[];
}

export interface RouterHooks {
  /** `held-elsewhere`: show the takeover screen; `useHere()` steals the lock (ARC-02). */
  readonly onTakeover?: (state: 'held-elsewhere' | 'granted' | 'lost', useHere: () => void) => void;
  /** Decide the profile from the loader config (menu, auto-safe, URL flag, normal; §3.7). */
  readonly decide?: (cfg: LoaderConfig) => BootStartParams | Promise<BootStartParams>;
  readonly onProgress?: (snap: ProgressSnapshot, label: string) => void;
  readonly onKlog?: (lines: readonly KlogLine[]) => void;
  readonly onPanic?: (p: {
    kind: 'cycle' | 'manifest' | 'critical' | 'kernel';
    text: string;
    cycle?: readonly string[];
  }) => void;
  readonly onReady?: () => void;
  readonly onService?: (name: ServiceName, state: string, reason: string | undefined) => void;
  readonly onHalted?: (restart: string | null) => void;
  readonly onSwRegister?: () => void;
}

export interface KernelLinkOptions {
  /** The kernel worker, created by the caller before any shadow is installed. */
  readonly worker: Worker;
  readonly start: BootStartParams;
  /** Σ decoded sizes of the target's boot assets (boot-manifest.json, SVC-15). */
  readonly assetsTotal: number;
  /** A progress model already fed by POST (the kernel download); created here otherwise. */
  readonly progress?: BootProgress;
  readonly hooks?: RouterHooks;
}

export interface KernelLink {
  readonly progress: BootProgress;
  post(msg: RouterToKernel): void;
  /** Hand the compositor's end of a fresh channel to the kernel (the wm service handshake). */
  attachCompositor(port: MessagePort): void;
  /** Main-thread asset bytes (streamed or finished). */
  asset(url: string, bytes: number, done: boolean): void;
  /** The first input-ready frame: rAF, then a MessageChannel hop, then the mark (§3.2.4). */
  markInteractive(): void;
  dispose(): void;
}

export function startKernelLink(opts: KernelLinkOptions): KernelLink {
  const { worker } = opts;
  const hooks = opts.hooks ?? {};
  const progress =
    opts.progress ??
    new BootProgress(opts.start.profile === 'recovery' ? 'recovery' : 'desktop', opts.assetsTotal);
  let label = 'Loading kernel';
  let ready = false;
  let disposed = false;

  const post = (msg: RouterToKernel, transfer: Transferable[] = []): void => {
    if (!disposed) worker.postMessage(msg, transfer);
  };
  const report = (snap: ProgressSnapshot): void => {
    hooks.onProgress?.(snap, label);
  };

  const onMessage = (ev: MessageEvent): void => {
    const msg: unknown = ev.data;
    if (!isKernelToRouter(msg)) return;
    switch (msg.t) {
      case 'takeover':
        hooks.onTakeover?.(msg.state, () => {
          post({ t: 'takeover.steal' });
        });
        return;
      case 'loader.config': {
        const cfg: LoaderConfig = {
          bootFlags: msg.bootFlags,
          recentBoots: msg.recentBoots,
          volumeOk: msg.volumeOk,
        };
        // The boot menu may wait for the user; a failing decision boots Safe (§3.2 stage 2).
        void Promise.resolve()
          .then(() => hooks.decide?.(cfg) ?? opts.start)
          .catch(() => ({
            ...opts.start,
            profile: 'safe' as const,
            flags: [...opts.start.flags, 'loader-fallback'],
          }))
          .then((start) => {
            post({ t: 'boot.start', ...start });
          });
        return;
      }
      case 'boot.target':
        report(
          progress.apply({ t: 'target', target: msg.target, weights: msg.weights, assetsTotal: 0 }),
        );
        return;
      case 'svc.event':
        if (msg.label !== undefined) label = msg.label;
        hooks.onService?.(msg.name, msg.state, msg.reason);
        if (msg.state === 'running' || msg.state === 'degraded')
          report(progress.apply({ t: 'service-done', name: msg.name }));
        else if (msg.label !== undefined) report(progress.snapshot());
        return;
      case 'asset.done':
        report(progress.apply({ t: 'asset-done', url: msg.url, bytes: msg.bytes }));
        return;
      case 'klog':
        hooks.onKlog?.(msg.lines);
        return;
      case 'panic':
        hooks.onPanic?.(
          msg.cycle === undefined
            ? { kind: msg.kind, text: msg.text }
            : { kind: msg.kind, text: msg.text, cycle: msg.cycle },
        );
        return;
      case 'kernel.ready':
        ready = true;
        hooks.onReady?.();
        return;
      case 'kernel.halted':
        hooks.onHalted?.(msg.restart);
        return;
      case 'swRegister':
        hooks.onSwRegister?.();
        return;
      case 'swSkipWaiting':
      case 'memMeasure':
        // TODO(R5): Service Worker update and memory calibration (OFF-05, MEM-01).
        return;
      case 'login.state':
      case 'login.result':
      case 'login.session':
      case 'login.loggedOut':
      case 'login.lock':
      case 'host.reply':
      case 'outbox':
        // The I/O layer's login channel and the desktop host's replies: the shell's login and
        // lock screens and the desktop host read these through their own listener on the worker
        // (the boot driver's `ctx.kernel.onMessage`).
        return;
    }
  };
  const onError = (ev: ErrorEvent): void => {
    if (!ready)
      hooks.onPanic?.({ kind: 'kernel', text: ev.message || 'the kernel worker failed to start' });
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);

  return {
    progress,
    post: (msg) => {
      post(msg);
    },
    attachCompositor: (port) => {
      post({ t: 'compositor.attach', port }, [port]);
    },
    asset: (url, bytes, done) => {
      report(progress.apply({ t: done ? 'asset-done' : 'asset-bytes', url, bytes }));
    },
    markInteractive: () => {
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          ch.port1.close();
          performance.mark('desktop-interactive');
          post({ t: 'desktop.interactive', at: performance.now() });
        };
        ch.port2.postMessage(0);
      });
    },
    dispose: () => {
      disposed = true;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    },
  };
}

const SHADOW_MESSAGE = 'Plotinium: use the system-call interface';

function throwing(): never {
  throw new TypeError(SHADOW_MESSAGE);
}

/**
 * ARC-07 (architecture.md §3.6 rule 4; boot §3.14): after `kernel.ready` and before the first app
 * view chunk import, replace `indexedDB`, `caches`, `navigator.storage.getDirectory` and `Worker`
 * with throwing shadows. Defence in depth only: lint and the chunk scan are the enforceable
 * controls for views. Returns the names shadowed.
 */
export function installViewShadows(win: object): string[] {
  const done: string[] = [];
  const lockOn = (target: object | null | undefined, name: string, label: string): void => {
    if (!target) return;
    try {
      Object.defineProperty(target, name, { get: throwing, set: throwing, configurable: false });
      done.push(label);
    } catch {
      // Already locked or not configurable: nothing more a same-realm shadow can do.
    }
  };
  const w = win as Record<string, unknown>;
  lockOn(win, 'indexedDB', 'indexedDB');
  lockOn(win, 'caches', 'caches');
  lockOn(win, 'Worker', 'Worker');
  const sm = w['StorageManager'];
  if (typeof sm === 'function')
    lockOn(
      (sm as { prototype?: object }).prototype,
      'getDirectory',
      'navigator.storage.getDirectory',
    );
  return done;
}
