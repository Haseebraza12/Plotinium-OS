/**
 * The kernel worker entry (architecture.md §3.6, ARC-02; boot-and-services.md §3.2 stages 2–4).
 *
 * Exactly one kernel per origin: the worker takes Web Lock `plotinium:kernel` with `ifAvailable`;
 * if another tab holds it, the router shows the takeover screen and may ask to steal the lock
 * ("Use here"). A kernel whose lock is stolen stops its services and reports `takeover: lost`.
 *
 * COMPOSITION (the program registry is injected; the kernel never imports apps):
 *
 *   // web/src/kernel.worker.ts
 *   import { startKernelWorker } from '@plotinium/kernel/host/worker';
 *   startKernelWorker({
 *     programs: ALL_MANIFESTS,                 // the /bin/<name>.json manifests (AppManifestInput[])
 *     executorFactory: (i) => new Worker(new URL('./executor.worker.ts', import.meta.url),
 *                                        { type: 'module', name: `executor-${i}` }),
 *     io: { ai, seed, login },                 // the I/O extras only the composing host has
 *   });
 *
 *   // web/src/executor.worker.ts: the executor bundle carries the program LOADERS
 *   import { startExecutor } from '@plotinium/kernel/runtime/executor-entry';
 *   startExecutor({ loaders: PROGRAM_LOADERS }); // manifest.entry → () => import(...)
 *
 * A bare `import '@plotinium/kernel/host/worker'` still boots: when no module called
 * `startKernelWorker` during the synchronous evaluation of the worker's module graph, a microtask
 * starts it with the defaults (no programs, the kernel's own executor bundle).
 *
 * The worker builds ONE kernel timer heap driven by one platform timer (KPS-13), the executor
 * transport over nested module workers (`executor-<i>`), the blkio worker (tier-1 swap) and the
 * `/api/swap` remote tier, and the I/O platform (IndexedDB, storage, same-origin fetch, WebCrypto,
 * MessageChannel) — kernel/src/core never touches these globals itself.
 */
import type { AppManifestInput } from '@plotinium/protocol';
import { DB_NAME } from '@plotinium/vfs';
import { browserSocket } from '@plotinium/vfs/sync';

import { DEV_IDENTITY, detectBrowser, normaliseCores } from '../core/host.ts';
import type { BuildIdentity, KernelHost } from '../core/host.ts';
import type { IoPlatform } from '../core/io/types.ts';
import type { Kernel, KernelIoOptions } from '../core/kernel.ts';
import type { ProgramCatalog } from '../core/programs/catalog.ts';
import { StaticProgramCatalog } from '../core/programs/catalog.ts';
import { defaultHeapFactory } from '../core/sched/scheduler.ts';
import { TimerHeap } from '../core/sched/timers.ts';
import type { BlkioWorkerFactory } from './blkio-host.ts';
import { startBlkioHost } from './blkio-host.ts';
import { BootSequence } from './boot-sequence.ts';
import { BOOT_VOLUME_READ_MS, readBootVolume, readBootVolumeWithin } from './boot-volume.ts';
import { platformClock } from './clock.ts';
import { defaultExecutorFactory, WorkerExecutorTransport } from './executors.ts';
import type { WorkerFactory } from './executors.ts';
import { drivePlatformTimer, kernelTimersOf } from './kernel-timers.ts';
import type { KernelToRouter, RouterToKernel } from './router-protocol.ts';
import { KERNEL_LOCK_NAME } from './router-protocol.ts';

declare const __PLT_IDENTITY__: BuildIdentity | undefined;
declare const __AI__: boolean | undefined;
declare const __PLT_TIMEOUT_SCALE__: number | undefined;

/**
 * The I/O extras only the composing host has: the AI link, the first-boot seed, the login options,
 * the sync/lock engines. The worker fills the platform (IndexedDB, storage, fetch, WebCrypto,
 * MessageChannel), the swap devices, the timers, and the router link (`post`, `halt`: the LOGIN
 * channel and power actions go to the main-thread router, router-protocol.ts).
 */
export type KernelWorkerIo = Omit<
  KernelIoOptions,
  | 'timers'
  | 'memory'
  | 'services'
  | 't0'
  | 'bootFlags'
  | 'verbose'
  | 'requestSwRegister'
  | 'platform'
  | 'post'
  | 'halt'
> & { readonly platform?: Partial<IoPlatform> };

export interface KernelWorkerOptions {
  /** The program registry's manifests (`/bin/<name>.json`); default none (every spawn ENOENT). */
  readonly programs?: ProgramCatalog | readonly AppManifestInput[];
  /** The executor bundle that carries the program loaders (default: the kernel's bare bundle). */
  readonly executorFactory?: WorkerFactory;
  /** The blkio worker (default the kernel's; null: no tier-1 swap device, memory fallback). */
  readonly blkioFactory?: BlkioWorkerFactory | null;
  /** Link the I/O layer with these extras (default: linked with none). */
  readonly io?: KernelWorkerIo | false;
  /** Called once the kernel exists (diagnostics, tests). */
  readonly onKernel?: (kernel: Kernel) => void;
}

interface UaData {
  readonly brands?: readonly { readonly brand: string; readonly version: string }[];
}

let started = false;

function catalogOf(p: KernelWorkerOptions['programs']): ProgramCatalog {
  if (p === undefined) return new StaticProgramCatalog();
  return Array.isArray(p)
    ? new StaticProgramCatalog(p as readonly AppManifestInput[])
    : (p as ProgramCatalog);
}

/** Start the kernel in this dedicated worker. Call exactly once, at module top level. */
export function startKernelWorker(opts: KernelWorkerOptions = {}): void {
  if (started) throw new Error('the kernel worker is already started');
  started = true;

  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const post = (msg: KernelToRouter): void => {
    scope.postMessage(msg);
  };
  const nav = scope.navigator as WorkerNavigator & { userAgentData?: UaData };
  const clock = platformClock(performance);
  const host: KernelHost = {
    clock,
    identity: typeof __PLT_IDENTITY__ === 'undefined' ? DEV_IDENTITY : __PLT_IDENTITY__,
    platform: {
      browser: detectBrowser(nav.userAgentData?.brands, nav.userAgent),
      cores: normaliseCores(nav.hardwareConcurrency),
      crossOriginIsolated: scope.crossOriginIsolated,
    },
  };

  // ONE timer heap, ONE platform timer (KPS-13).
  const heap = new TimerHeap(defaultHeapFactory);
  drivePlatformTimer(heap, clock, {
    set: (fn, ms) => scope.setTimeout(fn, ms),
    clear: (h) => {
      scope.clearTimeout(h as number);
    },
  });
  const timers = kernelTimersOf(heap, () => clock.now());

  const executors = new WorkerExecutorTransport(
    host.platform.crossOriginIsolated,
    opts.executorFactory ?? defaultExecutorFactory,
  );
  const programs = catalogOf(opts.programs);
  const sameOrigin = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(path, { credentials: 'same-origin', ...init });

  let kernelRef: Kernel | null = null;
  const blkio = startBlkioHost({
    ...(opts.blkioFactory === undefined ? {} : { factory: opts.blkioFactory }),
    fetch: sameOrigin,
    onFallback: (why) => {
      kernelRef?.log('mm', 'warn', why);
    },
  });

  const platform: IoPlatform = {
    indexedDB: typeof scope.indexedDB === 'undefined' ? null : scope.indexedDB,
    storage: nav.storage,
    fetch: sameOrigin,
    origin: scope.location.origin,
    subtle: scope.crypto.subtle,
    randomBytes: (n) => scope.crypto.getRandomValues(new Uint8Array(n)),
    channel: () => new MessageChannel(),
    online: nav.onLine,
    // Only a fallback: `boot.start` carries the router's POST answer, which BootSequence uses
    // (UI-007; a dedicated worker's navigator has no `serviceWorker` in Chrome).
    serviceWorker: 'serviceWorker' in nav,
    // The sync engine's WebSocket and lockd's local advisory locks (UI-006).
    ...(typeof WebSocket === 'function' ? { socket: browserSocket } : {}),
    ...(nav.locks === undefined ? {} : { locks: nav.locks }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const io = opts.io === false ? undefined : (opts.io ?? {});
  const frame = (cb: () => void): void => {
    if (typeof scope.requestAnimationFrame === 'function') scope.requestAnimationFrame(() => cb());
    else queueMicrotask(cb);
  };

  const boot = new BootSequence({
    host,
    post,
    timers,
    frame,
    ai: typeof __AI__ === 'undefined' ? true : __AI__,
    seed: Math.floor(clock.epochMs()) >>> 0,
    timeoutScale: typeof __PLT_TIMEOUT_SCALE__ === 'undefined' ? 1 : __PLT_TIMEOUT_SCALE__,
    kernelOptions: {
      timers: heap,
      executors,
      programs,
      ...(io === undefined
        ? {}
        : {
            io: {
              ...io,
              platform: { ...platform, ...io.platform },
              frame,
              memory: {
                device: blkio.device,
                ...(blkio.remote === undefined ? {} : { remote: blkio.remote }),
              },
            },
          }),
    },
    memory: async () => {
      await blkio.device.whenReady();
      return {
        device: blkio.device,
        ...(blkio.remote === undefined ? {} : { remote: blkio.remote }),
        ...(blkio.device.capBytes > 0 ? { localCap: blkio.device.capBytes } : {}),
      };
    },
    onHalt: () => {
      executors.terminateAll();
      blkio.stop();
    },
    onKernel: (k) => {
      kernelRef = k;
      if (blkio.device.note !== null) k.log('mm', 'warn', `swap: ${blkio.device.note}`);
      for (const p of catalogProblems(programs))
        k.log('proc', 'warn', `manifest ${p.name} refused: ${p.why}`);
      opts.onKernel?.(k);
    },
  });

  let granted = false;
  const early: RouterToKernel[] = [];

  function lost(): void {
    granted = false;
    post({ t: 'takeover', state: 'lost' });
    const stopping = boot.services?.stop('shutdown') ?? Promise.resolve();
    void stopping.finally(() => {
      executors.terminateAll();
      blkio.stop();
      post({ t: 'kernel.halted', restart: null });
    });
  }

  /** Request the kernel lock; the callback's pending promise holds it for the kernel's lifetime. */
  function acquire(steal: boolean): Promise<'granted' | 'held-elsewhere'> {
    return new Promise((resolve) => {
      const options: LockOptions = steal ? { steal: true } : { ifAvailable: true };
      nav.locks
        .request(KERNEL_LOCK_NAME, options, (lock) => {
          if (lock === null) {
            resolve('held-elsewhere');
            return undefined;
          }
          resolve('granted');
          return new Promise<void>(() => undefined);
        })
        .catch((e: unknown) => {
          // Stolen by another tab's "Use here" (AbortError): this kernel must stop.
          if (e instanceof DOMException && e.name === 'AbortError' && granted) lost();
        });
    });
  }

  function onGranted(): void {
    granted = true;
    post({ t: 'takeover', state: 'granted' });
    for (const msg of early.splice(0)) boot.onRouterMessage(msg);
    // The stage-2 boot-volume read (§3.2.3; UI-058): boot flags and the last boot outcomes, read
    // only, bounded so the loader never waits on a slow or missing database.
    void readBootVolumeWithin(
      () => readBootVolume(platform.indexedDB, DB_NAME),
      BOOT_VOLUME_READ_MS,
      (fn, ms) => scope.setTimeout(fn, ms),
    ).then((cfg) => {
      post({ t: 'loader.config', ...cfg });
    });
  }

  scope.addEventListener('message', (ev: MessageEvent<RouterToKernel>) => {
    const msg = ev.data;
    if (msg.t === 'takeover.steal') {
      void acquire(true).then((state) => {
        if (state === 'granted') onGranted();
      });
      return;
    }
    if (!granted) {
      early.push(msg);
      return;
    }
    boot.onRouterMessage(msg);
  });

  void acquire(false).then((state) => {
    if (state === 'granted') onGranted();
    else post({ t: 'takeover', state: 'held-elsewhere' });
  });
}

function catalogProblems(c: ProgramCatalog): readonly { name: string; why: string }[] {
  return c instanceof StaticProgramCatalog ? c.problems : [];
}

// A bare `import '@plotinium/kernel/host/worker'` (no explicit start) boots with the defaults.
// Module graphs without top-level await evaluate synchronously, so an importer that calls
// `startKernelWorker` at its top level always runs before this microtask.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  queueMicrotask(() => {
    if (!started) startKernelWorker();
  });
}
