/**
 * Injectable time for the sync engine and the lock manager (offline-and-sync.md §3.7, §3.14.5,
 * §5.6). Every timer the engine arms (hello timeout, idle timeout, ping/pong liveness, the lease
 * sweeper, lock waiter timeouts, the broadcaster's gap timer, throttle windows) goes through this
 * interface, so tests drive them with a manual clock instead of real time.
 *
 * The lease DEADLINES themselves come from the database clock (`clock_timestamp()`), which is the
 * only time source for leases (§3.14.2); the process clock only decides when to ask the database.
 */

/** A one-shot timer that can be cancelled; cancelling twice or after it fired is a no-op. */
export interface Timer {
  cancel(): void;
}

export interface Clock {
  /** Wall-clock epoch milliseconds (Date.now semantics). */
  now(): number;
  /** Runs `fn` once after `delayMs` (clamped to >= 0). The timer never keeps the process alive. */
  setTimer(delayMs: number, fn: () => void): Timer;
}

/** The process clock: Date.now and unref'd setTimeout. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs: number, fn: () => void): Timer {
    const handle = setTimeout(fn, Math.max(0, delayMs));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};
