/**
 * Boot stages 3 and 4 inside the kernel (boot-and-services.md §3.2): kernel init, then the service
 * manager, with every boot event forwarded to the router. Thread-agnostic (the worker host and the
 * Node tests drive it). No timers here (SVC-10): time comes only from `KernelTimers`, and progress
 * moves only on completion events.
 *
 * The composing host passes `kernelOptions` (the executor transport, the program catalog, the
 * kernel timer heap and the I/O options) and `memory` (the swap devices the `mm` service attaches).
 * Router events reach the process system (`desktop.interactive` grows the executor pool and keeps
 * a warm spare; `interactive` pauses the background band, KPS-11) and the I/O layer (`kernel.io`):
 * connectivity, visibility, the Service Worker and the LOGIN channel. The I/O layer's own
 * messages to the router (`login.state`, `login.result`, `login.session`, …) are posted as is, and
 * its power actions end here: `halt` stops the services and posts `kernel.halted {restart}`.
 */
import type { SvcEvent } from '@plotinium/services';
import { BUILTIN_MANIFEST_FILES, ServiceManager } from '@plotinium/services';
import type { BootProfile, KernelTimers, ServiceName } from '@plotinium/services';

import type { KernelHost } from '../core/host.ts';
import type { IoRouterEvent, PowerAction, RebootNext } from '../core/io/types.ts';
import type { Kernel, KernelOptions } from '../core/kernel.ts';
import { createKernel } from '../core/kernel.ts';
import type { MemoryOptions } from '../core/proc/mm-link.ts';
import { messageOf, subOf } from '../core/klog/format.ts';
import { levelOf } from '../core/klog/records.ts';
import type { KlogRecord } from '../core/klog/records.ts';
import type { KernelToRouter, KlogLine, RouterToKernel } from './router-protocol.ts';
import type { RecoveryAction } from './recovery.ts';
import { runRecovery } from './recovery.ts';
import { WorkerExecutorTransport } from './executors.ts';
import { createServiceRegistry } from './services.ts';

export interface BootSequenceDeps {
  readonly host: KernelHost;
  readonly post: (msg: KernelToRouter) => void;
  readonly timers: KernelTimers;
  /**
   * Legacy probe for hosts without an executor transport (the bare BootSequence tests): spawn
   * executor #1 and resolve once its `hello` matched. Absent: the `sched` service starts executor
   * #1 through the process system (`kernel.proc.startFirstExecutor()`).
   */
  readonly spawnFirstExecutor?: () => Promise<void>;
  /** Everything the host adds to `createKernel` (executors, programs, timers, io). */
  readonly kernelOptions?: Omit<KernelOptions, 'host' | 'ai'>;
  /** The swap devices for the memory manager, awaited by the `mm` service (§3.3 "mm"). */
  readonly memory?: () => Promise<MemoryOptions>;
  /** Called once with the kernel right after kernel init (the worker host keeps it). */
  readonly onKernel?: (kernel: Kernel) => void;
  /** Schedules `cb` once per animation frame (klog batches, ≤ 1 per frame). */
  readonly frame: (cb: () => void) => void;
  /** `__AI__` (C12). */
  readonly ai: boolean;
  /** Per-boot back-off seed. */
  readonly seed?: number;
  /** Service timeout multiplier (1 in release builds; larger on the dev server). */
  readonly timeoutScale?: number;
  /** After a power action stopped the services: release the host's workers (executors, blkio). */
  readonly onHalt?: () => void;
}

/** The URL the router reloads after `reboot` (the boot driver's `?boot=` flags, §3.10). */
export function restartUrl(kind: PowerAction, next: RebootNext): string | null {
  if (kind === 'poweroff') return null;
  return next === 'normal' ? '/' : `/?boot=${next}`;
}

type BootStart = Extract<RouterToKernel, { t: 'boot.start' }>;

interface Latch {
  readonly promise: Promise<void>;
  open(): void;
}

function latch(): Latch {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export class BootSequence {
  private readonly deps: BootSequenceDeps;
  private kernelRef: Kernel | null = null;
  private mgr: ServiceManager | null = null;
  private t0 = 0;
  private readonly compositor = latch();
  private readonly interactive = latch();
  private compositorPort: MessagePort | null = null;
  private pendingLines: KlogLine[] = [];
  private frameArmed = false;
  private halting = false;

  constructor(deps: BootSequenceDeps) {
    this.deps = deps;
  }

  get kernel(): Kernel | null {
    return this.kernelRef;
  }

  get services(): ServiceManager | null {
    return this.mgr;
  }

  get compositorLink(): MessagePort | null {
    return this.compositorPort;
  }

  onRouterMessage(msg: RouterToKernel): void {
    switch (msg.t) {
      case 'boot.start':
        this.start(msg);
        return;
      case 'compositor.attach':
        this.compositorPort = msg.port;
        this.kernelRef?.io?.attachCompositor(msg.port);
        this.compositor.open();
        return;
      case 'desktop.interactive':
        this.kernelRef?.proc.setDesktopInteractive(true);
        this.io({ t: 'desktop.interactive' });
        this.interactive.open();
        return;
      case 'interactive':
        // KPS-11: a drag or an animation pauses the background band (≤ 1 s in any 2 s).
        this.kernelRef?.proc.setInteractive(msg.active);
        return;
      case 'net.online':
        this.mgr?.netOnline();
        this.io({ t: 'online' });
        return;
      case 'net.offline':
        this.io({ t: 'offline' });
        return;
      case 'viewport':
        this.io({ t: 'viewport', w: msg.w, h: msg.h, dpr: msg.dpr });
        return;
      case 'sw':
        this.io({ t: 'sw', event: msg.event });
        return;
      case 'login.hello':
      case 'login.submit':
      case 'login.guest':
      case 'login.unlock':
      case 'login.logout':
        if ((this.kernelRef?.io ?? null) === null) {
          // No I/O layer in this build: answer a submit so the login view does not hang.
          if (msg.t === 'login.submit' || msg.t === 'login.guest' || msg.t === 'login.unlock')
            this.deps.post({
              t: 'login.result',
              rid: msg.rid,
              ok: false,
              error: 'the login service is not available',
            });
          return;
        }
        this.io(msg);
        return;
      case 'persist':
        // The I/O layer's storage service reports it once (UI-063); log here only without one.
        if ((this.kernelRef?.io ?? null) === null)
          this.kernelRef?.log(
            'storage',
            msg.persisted ? 'info' : 'warn',
            `persistent storage ${msg.persisted ? 'granted' : 'denied'}`,
          );
        this.io({ t: 'persist', persisted: msg.persisted });
        return;
      case 'visibility':
        this.io({ t: 'visibility', state: msg.state });
        return;
      case 'host.request':
        if ((this.kernelRef?.io ?? null) === null) {
          // No I/O layer in this build: answer, so the desktop host does not wait for nothing.
          this.deps.post({
            t: 'host.reply',
            rid: msg.rid,
            ok: false,
            errno: 'ENOSYS',
            error: 'not available in this build',
          });
          return;
        }
        this.io(msg);
        return;
      case 'sec.violation':
        this.io(msg);
        return;
      case 'pagehide':
        this.io({ t: 'pagehide' });
        return;
      case 'recovery.run':
        // The recovery console's actions (UI-057): answered as klog lines (./recovery.ts).
        void this.recovery(msg.action);
        return;
      case 'boot.userWait':
      case 'asset.done':
      case 'frame':
      case 'takeover.steal':
        // User-wait accounting is the login service's (ctx.userWait); the frame meter belongs to
        // the recovery console; `takeover.steal` is handled by the worker host before it reaches
        // here.
        return;
    }
  }

  /** Run one recovery-console action; every action answers with klog lines. */
  private async recovery(action: RecoveryAction): Promise<void> {
    const kernel = this.kernelRef;
    if (kernel === null) {
      this.deps.post({
        t: 'klog',
        lines: [{ t: 0, sub: action, level: 'warn', msg: `${action}: the kernel is not running` }],
      });
      return;
    }
    const idb = this.deps.kernelOptions?.io?.platform?.indexedDB ?? null;
    await runRecovery(action, {
      store: () => kernel.io?.fs()?.store ?? null,
      log: (sub, level, msg) => {
        kernel.log(sub, level, msg);
      },
      bootId: () => kernel.io?.bootId() ?? 'boot',
      builtinManifests: BUILTIN_MANIFEST_FILES.length,
      requires: () => this.mgr?.requiresMap() ?? null,
      ...(idb === null
        ? {}
        : {
            deleteDatabase: (name: string) =>
              new Promise<void>((resolve, reject) => {
                const r = idb.deleteDatabase(name);
                r.onsuccess = () => {
                  resolve();
                };
                r.onerror = () => {
                  reject(r.error ?? new Error(`cannot delete ${name}`));
                };
              }),
          }),
      reboot: () => {
        this.halt('reboot', 'normal');
      },
      now: () => kernel.host.clock.epochMs(),
    });
  }

  private io(ev: IoRouterEvent): void {
    this.kernelRef?.io?.router(ev);
  }

  private toLine(rec: KlogRecord, epochAtZero: number): KlogLine {
    return {
      t: Math.max(0, (epochAtZero + rec.t - this.t0) / 1_000),
      sub: subOf(rec),
      level: levelOf(rec),
      msg: messageOf(rec),
    };
  }

  private queueLine(line: KlogLine): void {
    this.pendingLines.push(line);
    if (this.frameArmed) return;
    this.frameArmed = true;
    this.deps.frame(() => {
      this.flushLines();
    });
  }

  /** Send the queued klog lines as one batch (also called before a panic, so nothing is lost). */
  flushLines(): void {
    this.frameArmed = false;
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.deps.post({ t: 'klog', lines });
  }

  private start(msg: BootStart): void {
    if (this.kernelRef) return;
    this.t0 = msg.t0;
    const ko = this.deps.kernelOptions ?? {};
    const kernel = createKernel({
      ...ko,
      host: this.deps.host,
      ai: this.deps.ai,
      ...(ko.io === undefined
        ? {}
        : {
            io: {
              ...ko.io,
              // Service Worker support is the router's POST answer (UI-007): a dedicated worker's
              // own navigator has no `serviceWorker` in Chrome, so the worker cannot tell.
              platform: { ...ko.io.platform, serviceWorker: msg.caps.serviceWorker },
              services: () => this.mgr,
              t0: () => this.t0,
              bootFlags: msg.flags,
              verbose: msg.verbose,
              requestSwRegister: () => {
                this.deps.post({ t: 'swRegister' });
              },
              post: (m) => {
                ko.io?.post?.(m);
                this.deps.post(m);
              },
              halt: (kind, next) => {
                ko.io?.halt?.(kind, next);
                this.halt(kind, next);
              },
            },
          }),
    });
    this.kernelRef = kernel;
    this.deps.onKernel?.(kernel);
    // The router hands the compositor port over at stage 2, usually before `boot.start` built the
    // kernel: bind a port that arrived early now, so the window table sees the shell's intents.
    if (this.compositorPort !== null) kernel.io?.attachCompositor(this.compositorPort);
    const epochAtZero = kernel.epochAtZero;
    // The verbose log shows the lines logged before the kernel existed (firmware, loader) first,
    // then kernel init; the pre-kernel lines also enter klog so dmesg and the boot record hold
    // the complete log.
    for (const l of msg.preKernelLog) this.queueLine(l);
    for (const rec of kernel.klog.read()) this.queueLine(this.toLine(rec, epochAtZero));
    for (const l of msg.preKernelLog) {
      kernel.klog.append({
        kind: 'line',
        t: this.t0 + l.t * 1_000 - epochAtZero,
        sub: l.sub,
        level: l.level,
        msg: l.msg,
      });
    }
    kernel.klog.follow((rec) => {
      this.queueLine(this.toLine(rec, epochAtZero));
    });
    kernel.log(
      'kernel',
      'info',
      `boot profile ${msg.profile}${msg.verbose ? ' · verbose' : ''}${msg.flags.length > 0 ? ` · flags ${msg.flags.join(',')}` : ''}`,
    );
    if (!msg.caps.crossOriginIsolated)
      kernel.log('kernel', 'warn', 'pre-emption: message fallback (not cross-origin isolated)');
    this.deps.post({ t: 'kernel.ready' });
    this.startServices(kernel, msg.profile);
  }

  /**
   * BOOT-12 steps the host owns, after the I/O layer saved the session and closed the boot record:
   * stop every service in reverse dependency order, release the workers, and tell the router
   * whether to reload (`reboot`, with the next boot's flags) or show the halted screen.
   */
  halt(kind: PowerAction, next: RebootNext = 'normal'): void {
    if (this.halting) return;
    this.halting = true;
    this.kernelRef?.log(
      'kernel',
      'info',
      `${kind === 'poweroff' ? 'power off' : 'reboot'}: stopping services`,
    );
    const stopping = this.mgr?.stop('shutdown') ?? Promise.resolve();
    void stopping
      .catch(() => undefined)
      .finally(() => {
        this.flushLines();
        try {
          this.deps.onHalt?.();
        } finally {
          this.deps.post({ t: 'kernel.halted', restart: restartUrl(kind, next) });
        }
      });
  }

  private startServices(kernel: Kernel, profile: BootProfile): void {
    const executors = this.deps.kernelOptions?.executors;
    const registry = createServiceRegistry({
      kernel,
      ...(this.deps.spawnFirstExecutor === undefined
        ? {}
        : { spawnFirstExecutor: this.deps.spawnFirstExecutor }),
      ...(this.deps.memory === undefined ? {} : { memory: this.deps.memory }),
      compositorAttached: () => this.compositor.promise,
      desktopInteractive: () => this.interactive.promise,
      requestSwRegister: () => {
        this.deps.post({ t: 'swRegister' });
      },
      ...(executors instanceof WorkerExecutorTransport
        ? { executorCode: () => executors.codeLoaded(0) }
        : {}),
    });
    const mgr = new ServiceManager({
      profile,
      // TODO(R2): Normal boots read /system/services from the boot volume (§3.2.3) once the
      // storage schema exists; until then every boot uses the built-in set.
      files: BUILTIN_MANIFEST_FILES,
      source: 'builtin',
      registry,
      timers: this.deps.timers,
      ...(this.deps.seed === undefined ? {} : { seed: this.deps.seed }),
      ...(this.deps.timeoutScale === undefined ? {} : { timeoutScale: this.deps.timeoutScale }),
      pidFor: (m) =>
        m.name === 'kernel'
          ? kernel.init.pid
          : kernel.procs.createKernelProcess(m.name, 'service', m.priority).pid,
      onEvent: (ev) => {
        this.onSvcEvent(kernel, ev);
      },
      onLog: (line) => {
        kernel.log(line.sub, line.level, line.msg);
      },
      onPanic: (p) => {
        this.flushLines();
        this.deps.post(
          p.cycle === undefined
            ? { t: 'panic', kind: p.kind, text: p.text }
            : { t: 'panic', kind: p.kind, text: p.text, cycle: p.cycle },
        );
      },
    });
    this.mgr = mgr;
    const built = mgr.build();
    if (!built.ok) return;
    this.deps.post({ t: 'boot.target', target: built.target, weights: built.weights });
    mgr.start();
  }

  private onSvcEvent(kernel: Kernel, ev: SvcEvent): void {
    this.deps.post({
      t: 'svc.event',
      name: ev.name,
      state: ev.state,
      at: ev.at,
      ...(ev.label === undefined ? {} : { label: ev.label }),
      ...(ev.reason === undefined ? {} : { reason: ev.reason }),
    });
    const payload = {
      name: ev.name,
      critical: ev.critical,
      ...(ev.reason === undefined ? {} : { error: ev.reason.slice(0, 256) }),
      ...(ev.retryAt === undefined
        ? {}
        : { retryInMs: Math.max(0, Math.round(ev.retryAt - ev.at)) }),
    };
    if (ev.state === 'running') kernel.bus.publish('svc.started', payload);
    else if (ev.state === 'degraded' || ev.state === 'blocked')
      kernel.bus.publish('svc.degraded', payload);
    else if (ev.state === 'failed') kernel.bus.publish('svc.failed', payload);
    else if (ev.state === 'stopped') kernel.bus.publish('svc.stopped', payload);
  }

  /** Names of services in a state, for tests and the router's diagnostics. */
  servicesIn(state: string): ServiceName[] {
    return (this.mgr?.status() ?? []).filter((s) => s.state === state).map((s) => s.name);
  }
}
