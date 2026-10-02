/**
 * The main-thread boot driver (boot-and-services.md §3.1–§3.10; architecture.md §3.6). It drives
 * the framework-free ui/ boot kit (@plotinium/ui/boot) from real boot events only:
 *
 *   1. POST: the inlined splash already painted the identity (BOOT-01); probe capabilities, and a
 *      missing required one shows the unsupported screen (SVC-14).
 *   2. Stream the kernel bundle: its bytes drive the asset share of the bar (BOOT-02, §5.5).
 *   3. Start the kernel worker and the kernel-link router; the stage-2 decision may open the boot
 *      menu (Esc, `?boot=menu`, the next-boot flag, or 2 failed boots; 5 s countdown).
 *   4. Progress, the step line, the service count, the orbit ticks and the nucleus flashes move
 *      ONLY on router events (asset bytes, `boot.target`, `svc.event`); V toggles the verbose log
 *      fed by klog batches.
 *   5. A cycle or a failed critical service shows the kernel-panic screen; Recovery boots end on
 *      the recovery console; no boot event for 15 s shows the stall screen (SVC-18).
 *   6. When the `desktop` service starts, the shell hooks (main.ts, assembler-owned) mount the
 *      desktop; the driver then marks `desktop-interactive` (§3.2.4) and hands the screen over.
 *
 * The two timers of the boot path (menu countdown, stall watchdog) live in timers.ts and never
 * touch progress. Everything else here is event-driven (SVC-10).
 */
import type {
  BootStartParams,
  CapabilityMatrix,
  KernelLink,
  KlogLine,
  ProgressSnapshot,
  RouterToKernel,
} from '@plotinium/kernel/host/main';
import { BootProgress, installViewShadows, startKernelLink } from '@plotinium/kernel/host/main';
import type { BootMode, BootSplash, CapabilityRow } from '@plotinium/ui/boot';
import {
  createBootMenu,
  createBootSplash,
  createPanicScreen,
  createUnsupportedScreen,
  Say,
} from '@plotinium/ui/boot';

import type { UpdateController } from '../sw/update.ts';
import { createUpdateController } from '../sw/update.ts';
import type { ServiceRow } from './diagnostics.ts';
import { buildDiagnostics, copyOrDownload, download } from './diagnostics.ts';
import { streamAsset } from './download.ts';
import type { Feed } from './feed.ts';
import { createFeed } from './feed.ts';
import { decideProfile, readUrlBoot, verboseFromKeys } from './flags.ts';
import { localStore, readNextBoot, writeNextBoot } from './next-boot.ts';
import { platformLabel, probeCapabilities } from './probe.ts';
import type { BootRecordDraft, TestHookSources } from './record.ts';
import { installTestHooks, newBootRecord, UserWait } from './record.ts';
import type { RecoveryHandle } from './recovery-console.ts';
import { forwardPlatformEvents, swEvents } from './platform.ts';
import type { MessageScreen } from './screens.ts';
import {
  haltedScreen,
  kernelLoadScreen,
  lostScreen,
  silenceDesktop,
  stallScreen,
  takeoverScreen,
} from './screens.ts';
import type { Countdown } from './timers.ts';
import { createWatchdog, platformTimers, startCountdown } from './timers.ts';
import { scriptUrlFactory } from './trusted.ts';

export type { ServiceRow } from './diagnostics.ts';
export type { Feed } from './feed.ts';

/** Seconds of the boot-menu auto-boot countdown (§3.7). */
export const MENU_COUNTDOWN_S = 5;
/** Boot-stall watchdog limit (§3.9, SVC-18), before the dev-server timeout scale. */
export const STALL_LIMIT_MS = 15_000;
/** sessionStorage key: the panic text carried into the recovery console's reason line. */
export const RECOVERY_REASON_KEY = 'plotinium:recovery-reason';

export type BootProfileName = 'normal' | 'safe' | 'recovery';
export type RebootTarget = 'menu' | 'safe' | 'recovery' | 'verbose' | 'normal';

export interface ProgressView {
  readonly p: number;
  readonly label: string;
  readonly servicesDone: number;
  readonly servicesTotal: number;
}

/**
 * Everything the shell (login view, desktop, Settings, the tray) may use from the boot driver.
 * System code only (the login view and desktop shell are wm/shell, not app views).
 */
export interface BootContext {
  readonly identity: { readonly version: string; readonly build: string };
  /** The decided profile (final from the stage-2 decision on). */
  profile(): BootProfileName;
  /** Every service and its state, from `svc.event` (Task Manager, the tray's degraded badges). */
  readonly services: Feed<readonly ServiceRow[]>;
  /** Boot progress as the splash shows it (for the login screen's stage line). */
  readonly progress: Feed<ProgressView>;
  /** Service Worker state: `offline-ready` and `restart-to-update` badges (OFF-05). */
  readonly update: UpdateController;
  /** The router port to the kernel, for system messages (login.*, recovery.*, …). */
  readonly kernel: {
    post(msg: RouterToKernel): void;
    /** Every message the kernel posts to the router, including ones the router ignores. */
    onMessage(fn: (msg: unknown) => void): () => void;
  };
  /**
   * The login screen is input-ready (`begin`) or was submitted (`end`): user wait is excluded
   * from boot time and from `login`'s timeout clock (§3.2 stage 5). `begin` also hands over.
   */
  userWait(phase: 'begin' | 'end'): void;
  /** Fade the splash out now (the login view is about to show); progress keeps being tracked. */
  handOver(): void;
  /**
   * The router's last reboot step (§3.10 steps 8–9): SKIP_WAITING when an update waits, then
   * `location.replace`. The kernel's `shutdown`/`reboot` syscalls run steps 1–7 first and end in
   * `kernel.halted {restart}`, which calls this; call it directly only as a fallback.
   */
  reboot(next?: RebootTarget): void;
  /** Settings → System → "Show boot menu on next boot" (one-shot; local fallback, see next-boot.ts). */
  setMenuNextBoot(on: boolean): void;
  menuNextBoot(): boolean;
  /** `window.__plt` sources to fill in (test builds only; null otherwise). */
  readonly testHooks: TestHookSources | null;
}

/** The shell's hooks, implemented by main.ts's desktop-mount section (assembler-owned). */
export interface ShellHooks {
  /**
   * Stage 2, before any service starts: the compositor's end of the wm channel (the kernel gets
   * the other end; the `wm` service is done once it is attached). Create the compositor here.
   */
  attachCompositor?(port: MessagePort, ctx: BootContext): void;
  /**
   * Stage 5: the `login` service started (never in a Recovery boot). Show the login view in
   * `root` (#plt-desktop); call `ctx.userWait('begin')` once it is input-ready (this hands the
   * screen over from the splash and pauses the stall watchdog) and `ctx.userWait('end')` on
   * submit. Optional: a shell may instead show login inside `mountDesktop` while the kernel's
   * `login` service is still the placeholder that does not wait for a user.
   */
  mountLogin?(root: HTMLElement, ctx: BootContext): void | Promise<void>;
  /**
   * The `desktop` service started (§3.2.4): mount the shell into `root` with its event handlers
   * attached, then resolve. The driver marks `desktop-interactive` on the next input-ready frame.
   */
  mountDesktop(root: HTMLElement, ctx: BootContext): void | Promise<void>;
}

export interface DriverEnv {
  readonly win: Window & typeof globalThis;
  readonly identity: { readonly version: string; readonly build: string };
  /** URL of the kernel worker bundle (`kernel.worker.ts?worker&url`). */
  readonly kernelUrl: string;
  /** `PLT_TEST_BUILD=1`: `window.__plt` and `?bootflags=`. */
  readonly testBuild: boolean;
  /** Dev server: no Service Worker, stretched timeouts. */
  readonly dev: boolean;
  /** `__PLT_TIMEOUT_SCALE__` (1 in release builds). */
  readonly timeoutScale: number;
}

interface BootManifestAsset {
  readonly url: string;
  readonly bytes: number;
}

declare global {
  interface Window {
    __pltKeys?: string[];
    __PLT_BOOT_MANIFEST__?: {
      readonly desktop: readonly BootManifestAsset[];
      readonly recovery?: readonly BootManifestAsset[];
    };
  }
}

type PanicInfo = {
  readonly kind: 'cycle' | 'manifest' | 'critical' | 'kernel';
  readonly text: string;
  readonly cycle?: readonly string[];
};

const STAGE_OF: Readonly<Record<string, number>> = { login: 5, session: 6, desktop: 6 };

function idle(win: Window & typeof globalThis, fn: () => void): void {
  if (typeof win.requestIdleCallback === 'function')
    win.requestIdleCallback(fn, { timeout: 5_000 });
  else queueMicrotask(fn);
}

/** `2026-09-27 09:25:50`: local date and 24-hour time, as the rest of the OS shows them. */
export function clockText(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function safeSession(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

/** Run the boot. Resolves once the boot path is set up (it keeps running on events). */
export async function startBoot(hooks: ShellHooks, env: DriverEnv): Promise<void> {
  const { win } = env;
  const doc = win.document;
  const perf = win.performance;
  const t0 = perf.timeOrigin;
  const since = (): number => perf.now() / 1_000;
  const identity = { version: env.identity.version, build: env.identity.build };
  const bootRoot = doc.getElementById('plt-boot');
  const desktopRoot = doc.getElementById('plt-desktop');
  const keys = win.__pltKeys ?? (win.__pltKeys = []);
  // Platform references captured during POST, before the ARC-07 shadows (§3.14).
  const WorkerCtor = win.Worker;
  const store = localStore(win);
  const session = safeSession(win);
  const timers = platformTimers(win);
  const klogTail: KlogLine[] = [];
  const services = createFeed<readonly ServiceRow[]>([]);
  const progressFeed = createFeed<ProgressView>({
    p: 0,
    label: 'checking system',
    servicesDone: 0,
    servicesTotal: 0,
  });
  const userWait = new UserWait(() => perf.now());
  // One Trusted Types policy for the router's script URLs: the POST probe, the kernel worker and
  // the Service Worker registration (report-only today, SEC-22).
  const scriptUrl = scriptUrlFactory(win);
  const update = createUpdateController({
    container: 'serviceWorker' in win.navigator ? win.navigator.serviceWorker : null,
    swUrl: scriptUrl('/sw.js'),
    replace: (u) => {
      win.location.replace(u);
    },
    idle: (fn) => {
      idle(win, fn);
    },
    timers,
    enabled: !env.dev,
  });
  const go = (url: string): void => {
    update.activateAndReload(url);
  };

  // ---------- the splash (adopts the inlined first paint) ----------
  const inlined = bootRoot?.querySelector<HTMLElement>('.plb-splash') ?? null;
  const splash: BootSplash = createBootSplash({
    ...identity,
    ...(bootRoot !== null && inlined !== null ? { root: bootRoot } : {}),
    onBootMenu: () => {
      if (!decided) keys.push('Escape');
    },
    // The V chip and the V key share one state, so neither gets out of step (UI-067).
    onToggleVerbose: () => {
      setVerbose(!verbose);
    },
  });
  if (inlined === null) (bootRoot ?? doc.body).append(splash.el);
  splash.log.el.dataset['testid'] = 'boot-verbose-log';
  splash.announcer.el.dataset['testid'] = 'boot-status';
  splash.setStage(1);

  const mount = (el: HTMLElement): void => {
    if (bootRoot?.isConnected === true) bootRoot.replaceChildren(el);
    else doc.body.append(el);
  };

  let decided = false;
  let verbose = false;
  let handedOver = false;
  let finished = false;
  let halted = false;
  let profile: BootProfileName = 'normal';
  const setVerbose = (on: boolean): void => {
    if (on === verbose) return;
    verbose = on;
    record.verbose = on;
    splash.setVerbose(on);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'v' || e.key === 'V') {
      splash.setKeyDown('v', true);
      if (!e.repeat) setVerbose(!verbose);
    } else if (e.key === 'Escape' && !decided) splash.setKeyDown('Escape', true);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'v' || e.key === 'V') splash.setKeyDown('v', false);
    else if (e.key === 'Escape') splash.setKeyDown('Escape', false);
  };
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  const detachKeys = (): void => {
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('keyup', onKeyUp);
  };

  const handOver = (): void => {
    if (handedOver) return;
    handedOver = true;
    detachKeys();
    splash.exit('desktop');
    const running = splash.el.getAnimations({ subtree: true }).map((a) => a.finished);
    void Promise.allSettled(running).then(() => {
      splash.destroy();
      if (bootRoot !== null && bootRoot.querySelector('.plb') === null) bootRoot.remove();
    });
  };

  // ---------- stage 1: POST ----------
  const post = probeCapabilities(win, scriptUrl);
  const record: BootRecordDraft = newBootRecord(
    identity,
    win.navigator,
    post.caps.crossOriginIsolated,
    t0,
  );
  const hookSources: TestHookSources | null = env.testBuild ? { record } : null;
  if (hookSources !== null) installTestHooks(win, hookSources);
  let panicInfo: PanicInfo | undefined;
  const diagnostics = (): ReturnType<typeof buildDiagnostics> =>
    buildDiagnostics(
      {
        record,
        caps: post.caps,
        services: services.current(),
        klog: klogTail,
        userAgent: win.navigator.userAgent,
        at: new Date().toISOString(),
        ...(panicInfo === undefined ? {} : { panic: panicInfo }),
      },
      t0,
    );
  const saveDiagnostics = (): void => {
    download(doc, diagnostics());
  };

  if (post.fatal) {
    record.outcome = 'unsupported';
    detachKeys();
    showUnsupported(post.rows);
    return;
  }

  function showUnsupported(rows: readonly CapabilityRow[]): void {
    const screen = createUnsupportedScreen({
      ...identity,
      capabilities: rows,
      platform: platformLabel(win.navigator.userAgent),
      onCopyDiagnostics: () => {
        void copyOrDownload(doc, win.navigator.clipboard, diagnostics()).then((s) => {
          screen.setCopyState(s);
        });
      },
    });
    screen.el.dataset['testid'] = 'boot-unsupported';
    mount(screen.el);
    screen.focus();
    // Focus may scroll the card; the POST title and the failing rows come first.
    screen.el.scrollTop = 0;
  }

  const url = readUrlBoot(win.location, win.history, env.testBuild);
  setVerbose(url.verbose || verboseFromKeys(keys));
  let usage = { usage: 0, quota: 0 };
  void win.navigator.storage.estimate().then(
    (e) => {
      usage = { usage: e.usage ?? 0, quota: e.quota ?? 0 };
      record.env.quotaBytes = usage.quota;
      record.env.usageBytes = usage.usage;
    },
    () => undefined,
  );
  // Never awaited on the boot path (§3.2 stage 1 d).
  const persisted = win.navigator.storage.persist().catch(() => false);
  const preKernelLog: KlogLine[] = [
    {
      t: 0,
      sub: 'firmware',
      level: 'info',
      msg: `Plotinium ${identity.version} · ${post.summary}`,
    },
  ];
  for (const r of post.rows)
    if (r.status === 'degraded')
      preKernelLog.push({
        t: since(),
        sub: 'firmware',
        level: 'warn',
        msg: `WARN ${r.name} unavailable: ${r.fix ?? 'degraded'}`,
      });
  splash.log.append(...preKernelLog);

  // ---------- the stall watchdog (SVC-18) ----------
  const watchdog = createWatchdog({
    limitMs: STALL_LIMIT_MS * env.timeoutScale,
    timers,
    onStall: (lastEvent, ageS) => {
      detachKeys();
      stallScreen(doc, identity, lastEvent, ageS, {
        retry: () => {
          win.location.reload();
        },
        safe: () => {
          go('/?boot=safe');
        },
        diagnostics: saveDiagnostics,
      }).focus();
    },
  });

  // ---------- stage 1 (g): stream the kernel bundle ----------
  const target = url.profile === 'recovery' ? 'recovery' : 'desktop';
  const manifest = win.__PLT_BOOT_MANIFEST__;
  const assets =
    (target === 'recovery' ? manifest?.recovery : undefined) ?? manifest?.desktop ?? [];
  const inlinedTotal = assets.reduce((n, a) => n + a.bytes, 0);
  const progress = new BootProgress(target, inlinedTotal);
  const show = (snap: ProgressSnapshot, label: string): void => {
    const counted =
      snap.servicesTotal > 0
        ? `${label}, ${String(snap.servicesDone)} of ${String(snap.servicesTotal)}`
        : label;
    splash.setProgress(snap.p, counted);
    splash.setStep(label);
    if (snap.servicesTotal > 0) splash.setCount(snap.servicesDone, snap.servicesTotal);
    splash.pulse();
    progressFeed.set({
      p: snap.p,
      label,
      servicesDone: snap.servicesDone,
      servicesTotal: snap.servicesTotal,
    });
  };
  splash.setStep('Loading kernel');
  let bytes: number;
  try {
    bytes = await streamAsset(env.kernelUrl, (n, hint) => {
      const of = inlinedTotal > 0 ? inlinedTotal : hint;
      watchdog.kick('kernel image download');
      show(
        progress.apply({ t: 'asset-bytes', url: env.kernelUrl, bytes: n }),
        `Loading kernel · ${String(Math.round(n / 1_024))}${of === null ? '' : ` of ${String(Math.round(of / 1_024))}`} KB`,
      );
    });
  } catch (e) {
    watchdog.stop();
    detachKeys();
    const text = e instanceof Error ? e.message : String(e);
    record.outcome = 'panic';
    panicInfo = { kind: 'kernel', text: `Could not load the kernel: ${text}` };
    const screen = kernelLoadScreen(doc, identity, text, {
      retry: () => {
        win.location.reload();
      },
      diagnostics: saveDiagnostics,
    });
    screen.focus();
    return;
  }
  if (inlinedTotal === 0) progress.apply({ t: 'assets-total', bytes });
  record.assets = { bytesTotal: inlinedTotal > 0 ? inlinedTotal : bytes, bytesDone: bytes };
  show(progress.apply({ t: 'asset-done', url: env.kernelUrl, bytes }), 'Starting kernel');
  const loaderLine: KlogLine = {
    t: since(),
    sub: 'loader',
    level: 'info',
    msg: `kernel image ${String(Math.round(bytes / 1_024))} KB${post.caps.serviceWorkerControlled ? ' (service worker cache)' : ''}`,
  };
  preKernelLog.push(loaderLine);
  splash.log.append(loaderLine);

  const lineKey = (l: KlogLine): string => `${l.t.toFixed(3)}|${l.sub}|${l.msg}`;
  const echoed = new Set(preKernelLog.map(lineKey));

  // ---------- stage 2: the kernel worker and the router ----------
  const worker = new WorkerCtor(scriptUrl(env.kernelUrl), { type: 'module', name: 'kernel' });
  splash.setStage(2);
  watchdog.kick('kernel worker started');
  const start: BootStartParams = {
    t0,
    profile: url.profile ?? 'normal',
    verbose,
    flags: [...url.flags],
    caps: post.caps,
    preKernelLog,
  };
  let takeover: MessageScreen | null = null;
  let mounted = false;
  let recovery: RecoveryHandle | null = null;
  let panicked = false;

  const ctx: BootContext = {
    identity,
    profile: () => profile,
    services,
    progress: progressFeed,
    update,
    kernel: {
      post: (msg) => {
        link.post(msg);
      },
      onMessage: (fn) => {
        const h = (ev: MessageEvent): void => {
          fn(ev.data);
        };
        worker.addEventListener('message', h);
        return () => {
          worker.removeEventListener('message', h);
        };
      },
    },
    userWait: (phase) => {
      if (phase === 'begin') {
        handOver();
        userWait.begin();
        watchdog.pause();
      } else {
        userWait.end();
        watchdog.resume('login submitted');
      }
      record.userWaitMs = userWait.ms();
      link.post({ t: 'boot.userWait', phase, at: since() });
    },
    handOver,
    reboot: (next) => {
      go(next === undefined || next === 'normal' ? '/' : `/?boot=${next}`);
    },
    setMenuNextBoot: (on) => {
      writeNextBoot(store, on ? { menuNextBoot: true } : {});
    },
    menuNextBoot: () => readNextBoot(store).menuNextBoot === true,
    testHooks: hookSources,
  };

  const showPanic = (p: PanicInfo): void => {
    if (panicked) return;
    panicked = true;
    panicInfo = p;
    watchdog.stop();
    detachKeys();
    record.outcome = 'panic';
    record.panic = {
      kind: p.kind,
      text: p.text,
      ...(p.cycle === undefined ? {} : { cycle: [...p.cycle] }),
    };
    const lines = [
      ...klogTail.slice(-40),
      { t: since(), sub: 'svc', level: 'panic' as const, msg: `KERNEL PANIC: ${p.text}` },
    ];
    // BOOT-08 (§3.6): a failed critical service or kernel start says "could not start", names
    // what failed and offers Retry; a cycle or a bad manifest is a kernel panic (§5.4).
    const retryable = p.kind === 'critical' || p.kind === 'kernel';
    const screen = createPanicScreen({
      ...identity,
      lines,
      ...(p.cycle === undefined ? {} : { cycle: p.cycle }),
      ...(record.bootId === '' ? {} : { bootId: record.bootId }),
      title: p.kind === 'critical' ? 'Plotinium could not start' : 'Kernel panic',
      reason: p.text,
      retry: retryable,
      time: `${clockText(new Date())} · ${since().toFixed(3)} s after start`,
      explanation:
        p.kind === 'cycle'
          ? undefined
          : p.kind === 'critical'
            ? 'A critical system service failed to start, so the boot stopped. Your files are safe.'
            : p.kind === 'manifest'
              ? 'A service manifest is invalid, so the boot stopped. Safe mode ignores edited manifests.'
              : 'The kernel stopped during boot. Your files are safe.',
      onAction: (action) => {
        if (action === 'diagnostics') {
          saveDiagnostics();
          return;
        }
        if (action === 'retry') {
          // Boot again in the same profile (a restart re-runs every start, attempt n + 1).
          screen.setBusy('retry', 'Restarting…');
          go(profile === 'normal' ? '/' : `/?boot=${profile}`);
          return;
        }
        if (action === 'recovery') {
          try {
            session?.setItem(RECOVERY_REASON_KEY, p.text.slice(0, 300));
          } catch {
            // The reason line is a courtesy; recovery works without it.
          }
          screen.setBusy('recovery', 'Rebooting into recovery…');
          go('/?boot=recovery');
        } else {
          screen.setBusy('safe', 'Rebooting in safe mode…');
          go('/?boot=safe');
        }
      },
    });
    screen.el.dataset['testid'] = 'boot-panic';
    mount(screen.el);
    // A failure after the login screen mounted: nothing under the panic takes focus (UI-031).
    silenceDesktop(doc);
    screen.focus();
  };

  const bootMenu = (preselect: 'normal' | 'safe', failedBoots: number): Promise<BootMode> =>
    new Promise((resolve) => {
      let countdown: Countdown | null = null;
      let settled = false;
      splash.exit('menu');
      const done = (mode: BootMode): void => {
        if (settled) return;
        settled = true;
        countdown?.stop();
        menu.destroy();
        splash.el.removeAttribute('data-exit');
        resolve(mode);
      };
      const menu = createBootMenu({
        ...identity,
        selected: preselect,
        failedBoots,
        onChoose: done,
        onClose: () => {
          done('normal');
        },
        onInteract: () => {
          countdown?.stop();
        },
        announce: (text) => {
          splash.announcer.say(text, Say.Stage);
        },
      });
      // Holding Esc (§3.7) keeps repeating: those repeats must not close the menu they opened.
      menu.el.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Escape' && e.repeat) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        true,
      );
      (bootRoot ?? doc.body).append(menu.el);
      menu.focus();
      countdown = startCountdown({
        seconds: MENU_COUNTDOWN_S,
        timers,
        onTick: (left) => {
          menu.setCountdown(left, MENU_COUNTDOWN_S);
        },
        onDone: () => {
          done(menu.selected);
        },
      });
    });

  const openRecovery = async (): Promise<void> => {
    const { openRecoveryConsole, RECOVERY_ANSWER_MS } = await import('./recovery-console.ts');
    let reason: string | undefined;
    try {
      reason = session?.getItem(RECOVERY_REASON_KEY) ?? undefined;
      session?.removeItem(RECOVERY_REASON_KEY);
    } catch {
      reason = undefined;
    }
    const running = services
      .current()
      .filter((s) => s.state === 'running' || s.state === 'degraded')
      .map((s) => (s.name === 'vfs' ? 'vfs · ro' : s.name));
    const mb = Math.round(usage.usage / 1_048_576);
    recovery = openRecoveryConsole({
      doc,
      identity,
      record,
      services: running,
      ...(reason === undefined ? {} : { reason }),
      status: `${win.navigator.onLine ? 'Online' : 'Offline'} · storage ${String(mb)} MB used`,
      post: (msg) => {
        link.post(msg);
      },
      diagnostics: saveDiagnostics,
      reboot: go,
      now: since,
      timers,
      answerMs: RECOVERY_ANSWER_MS * env.timeoutScale,
    });
    handOver();
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    watchdog.stop();
    if (target === 'recovery' || profile === 'recovery') {
      record.outcome = 'recovery';
      detachKeys();
      void openRecovery();
      return;
    }
    record.outcome = 'interactive';
    record.interactiveAt = since();
    record.userWaitMs = userWait.ms();
    record.bootMs = Math.round(record.interactiveAt * 1_000 - record.userWaitMs);
    handOver();
  };

  let loginMounted = false;
  const mountLogin = (): void => {
    if (hooks.mountLogin === undefined || loginMounted || desktopRoot === null) return;
    if (target === 'recovery' || profile === 'recovery') return;
    loginMounted = true;
    void Promise.resolve()
      .then(() => hooks.mountLogin?.(desktopRoot, ctx))
      .catch((e: unknown) => {
        showPanic({
          kind: 'critical',
          text: `login: could not show the login screen: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
  };

  const mountDesktop = (): void => {
    if (mounted || desktopRoot === null) return;
    mounted = true;
    void Promise.resolve()
      .then(() => hooks.mountDesktop(desktopRoot, ctx))
      .then(
        () => {
          link.markInteractive();
        },
        (e: unknown) => {
          showPanic({
            kind: 'critical',
            text: `desktop: could not mount the shell: ${e instanceof Error ? e.message : String(e)}`,
          });
        },
      );
  };

  const link: KernelLink = startKernelLink({
    worker,
    start,
    assetsTotal: inlinedTotal > 0 ? inlinedTotal : bytes,
    progress,
    hooks: {
      onTakeover: (state, useHere) => {
        takeover?.destroy();
        takeover = null;
        if (state === 'held-elsewhere') {
          watchdog.pause();
          takeover = takeoverScreen(doc, identity, useHere);
          takeover.focus();
        } else if (state === 'granted') watchdog.resume('kernel lock granted');
        else {
          halted = true;
          watchdog.stop();
          detachKeys();
          lostScreen(doc, identity, () => {
            win.location.reload();
          }).focus();
        }
      },
      decide: async (cfg) => {
        watchdog.kick('loader.config');
        const local = readNextBoot(store);
        const d = decideProfile(keys, url, cfg, local);
        decided = true;
        splash.setMenuAvailable(false);
        splash.setKeyDown('Escape', false);
        if (url.testFlags.includes('hold-splash')) {
          // Test builds only: keep the splash at its true value for the a11y scan.
          watchdog.stop();
          return new Promise<BootStartParams>(() => undefined);
        }
        let chosen: BootProfileName = d.profile;
        if (d.menu) {
          watchdog.pause();
          userWait.begin();
          const mode = await bootMenu(d.preselect, d.failedBoots);
          userWait.end();
          watchdog.resume('boot menu closed');
          if (mode === 'verbose') setVerbose(true);
          else chosen = mode;
        }
        if (local.menuNextBoot === true) writeNextBoot(store, {});
        profile = chosen;
        record.profile = chosen;
        record.flags = [...d.flags];
        return {
          ...start,
          profile: chosen,
          verbose,
          flags: d.flags,
          caps: { ...post.caps, estimate: usage } satisfies CapabilityMatrix,
        };
      },
      onProgress: (snap, label) => {
        show(snap, label);
        watchdog.kick(label);
        if (snap.p >= 1) finish();
      },
      onKlog: (lines) => {
        klogTail.push(...lines);
        if (klogTail.length > 512) klogTail.splice(0, klogTail.length - 512);
        // The kernel echoes the firmware and loader lines this log already shows (they enter
        // klog for dmesg and the boot record); show each line once.
        const fresh = echoed.size === 0 ? lines : lines.filter((l) => !echoed.delete(lineKey(l)));
        if (fresh.length > 0) splash.log.append(...fresh);
        recovery?.klog(lines);
        const last = lines.at(-1);
        if (last !== undefined) watchdog.kick(`${last.sub}: ${last.msg}`.slice(0, 80));
      },
      onPanic: showPanic,
      onReady: () => {
        splash.setStage(3);
        watchdog.kick('kernel ready');
        void persisted.then((ok) => {
          record.env.persisted = ok;
          link.post({ t: 'persist', persisted: ok });
        });
        // ARC-07 / SVC-16: before any app view chunk can load.
        installViewShadows(win);
        platform.viewport();
      },
      onService: (name, state, reason) => {
        watchdog.kick(`${name} ${state}`);
        if (state === 'starting') splash.setStage(STAGE_OF[name] ?? 4);
        services.set([
          ...services.current().filter((r) => r.name !== name),
          { name, state, ...(reason === undefined ? {} : { reason }) },
        ]);
        if (state === 'running' || state === 'degraded') splash.serviceDone();
        if (name === 'login' && state === 'starting') mountLogin();
        if (name === 'desktop' && state === 'starting') mountDesktop();
      },
      onHalted: (restart) => {
        watchdog.stop();
        if (halted && restart === null) return; // the lost-takeover path already shows its screen
        halted = true;
        if (restart !== null) {
          go(restart);
          return;
        }
        detachKeys();
        // `mounted`: the desktop was up, so a signed-in session was saved on the way down.
        const screen = haltedScreen(
          doc,
          identity,
          () => {
            win.location.replace('/');
          },
          mounted,
        );
        screen.focus();
      },
      onSwRegister: () => {
        void update.register();
      },
    },
  });

  // SYN-15: platform events and the Service Worker lifecycle go to the kernel; it decides.
  const platform = forwardPlatformEvents(win, (m) => {
    link.post(m);
  });
  let swPrev = update.state();
  update.subscribe((next) => {
    for (const event of swEvents(swPrev, next)) link.post({ t: 'sw', event });
    swPrev = next;
  });

  // The wm service waits for the compositor handshake (§3.3): hand the kernel its end now.
  const compositor = new MessageChannel();
  hooks.attachCompositor?.(compositor.port1, ctx);
  link.attachCompositor(compositor.port2);
}
