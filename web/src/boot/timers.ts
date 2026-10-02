/**
 * The two allowlisted boot-ui timers (boot-and-services.md §5.6, SVC-10; §3.7 and §3.9). Neither
 * reads nor writes boot progress: the countdown only picks the boot-menu entry when the user does
 * nothing, and the watchdog only replaces a silent screen with the stall screen. Every other part
 * of the boot path is event-driven. `tools/boot-timer-allowlist.json` must list this file's two
 * pragma call sites (the spec names wm/boot-ui/menu.ts and watchdog.ts; the driver lives in web/).
 */

/** Injectable platform timers, so tests use a fake clock. */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export const platformTimers = (win: {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (h: number) => void;
  performance: { now(): number };
}): TimerApi => ({
  set: (fn, ms) => win.setTimeout(fn, ms),
  clear: (h) => {
    if (typeof h === 'number') win.clearTimeout(h);
  },
  now: () => win.performance.now(),
});

export interface Countdown {
  /** Stops for good (the first key or pointer press, or a choice). Idempotent. */
  stop(): void;
  readonly running: boolean;
}

/**
 * The boot menu's auto-boot countdown (§3.7: 5 s, only while the menu is open). Ticks once per
 * second from an absolute deadline, so a late timer never stretches it (UIG §5.6).
 */
export function startCountdown(opts: {
  readonly seconds: number;
  readonly timers: TimerApi;
  readonly onTick: (remaining: number) => void;
  readonly onDone: () => void;
}): Countdown {
  const { timers } = opts;
  const deadline = timers.now() + opts.seconds * 1_000;
  let handle: unknown = null;
  let running = true;
  const step = (): void => {
    if (!running) return;
    const left = Math.max(0, deadline - timers.now());
    const whole = Math.ceil(left / 1_000);
    opts.onTick(whole);
    if (left <= 0) {
      running = false;
      opts.onDone();
      return;
    }
    const next = left - (whole - 1) * 1_000;
    handle = timers.set(step, Math.max(1, next)); // boot-timer-allow: menu-countdown
  };
  step();
  return {
    get running() {
      return running;
    },
    stop() {
      if (!running) return;
      running = false;
      if (handle !== null) timers.clear(handle);
    },
  };
}

export interface Watchdog {
  /** A boot event happened: re-arm (asset bytes, stage change, service event, klog line). */
  kick(event: string): void;
  /** The boot waits on the user (menu, login, takeover): no stall can be declared. */
  pause(): void;
  resume(event: string): void;
  /** The boot ended (interactive, panic, recovery console, halted). */
  stop(): void;
}

/**
 * The boot-stall watchdog (§3.9, SVC-18): fires when `limitMs` pass with no boot event while the
 * boot is not waiting on the user, naming the last event and its age.
 */
export function createWatchdog(opts: {
  readonly limitMs: number;
  readonly timers: TimerApi;
  readonly onStall: (lastEvent: string, ageS: number) => void;
}): Watchdog {
  const { timers } = opts;
  let handle: unknown = null;
  let last = 'boot started';
  let lastAt = timers.now();
  let state: 'armed' | 'paused' | 'stopped' = 'armed';
  const disarm = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const fire = (): void => {
    handle = null;
    if (state !== 'armed') return;
    state = 'stopped';
    opts.onStall(last, Math.round((timers.now() - lastAt) / 1_000));
  };
  const arm = (): void => {
    disarm();
    handle = timers.set(fire, opts.limitMs); // boot-timer-allow: stall-watchdog
  };
  arm();
  return {
    kick(event) {
      if (state === 'stopped') return;
      last = event;
      lastAt = timers.now();
      if (state === 'armed') arm();
    },
    pause() {
      if (state !== 'armed') return;
      state = 'paused';
      disarm();
    },
    resume(event) {
      if (state !== 'paused') return;
      state = 'armed';
      last = event;
      lastAt = timers.now();
      arm();
    },
    stop() {
      state = 'stopped';
      disarm();
    },
  };
}
