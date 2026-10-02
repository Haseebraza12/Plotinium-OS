/**
 * Per-connection timers on the server (offline-and-sync.md §3.7 rule 2, §4.5, §4.6;
 * backend-api.md §3.7; SYN-10), all on an injectable Clock:
 *
 *   hello timeout   HELLO_TIMEOUT_MS (5 s) after the upgrade without a `hello`  -> 4408 idle-timeout
 *   idle timeout    no APPLICATION frame for leaseTtlMs                        -> 4408 idle-timeout
 *                   (the client's `hb` every TTL/3 keeps a healthy socket far from it)
 *   liveness ping   a `ws` ping every SERVER_PING_MS (20 s); a socket that missed one pong is
 *                   terminated. Pongs prove only that the socket is alive: the browser answers them
 *                   even when the page is frozen, so they NEVER renew a lease (INV-S8) and never
 *                   reset the idle timeout.
 * The client's own dead-man timer (DEAD_MAN_MS, 25 s without any frame) is fed by `hb.ack`.
 */
import { HELLO_TIMEOUT_MS, LEASE_TTL_MS, SERVER_PING_MS } from '@plotinium/protocol';

import type { Clock, Timer } from './clock.ts';

export interface WatchdogOptions {
  readonly clock: Clock;
  readonly helloTimeoutMs?: number;
  /** leaseTtlMs of the server profile. */
  readonly idleTimeoutMs?: number;
  readonly pingMs?: number;
  /** hello or idle timeout: send `bye idle-timeout` and close 4408. */
  readonly onTimeout: (kind: 'hello' | 'idle') => void;
  /** Sends a `ws` ping. */
  readonly ping: () => void;
  /** A pong was missed: terminate the socket (no close frame; an abnormal close). */
  readonly terminate: () => void;
}

export class ConnectionWatchdog {
  readonly #o: Required<WatchdogOptions>;
  #hello: Timer | undefined;
  #idle: Timer | undefined;
  #ping: Timer | undefined;
  #lastAppFrameAt = 0;
  #awaitingPong = false;
  #stopped = false;

  constructor(options: WatchdogOptions) {
    this.#o = {
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      idleTimeoutMs: LEASE_TTL_MS,
      pingMs: SERVER_PING_MS,
      ...options,
    };
  }

  /** The upgrade completed: arm the hello timer and the ping cycle. */
  start(): void {
    this.#lastAppFrameAt = this.#o.clock.now();
    this.#hello = this.#o.clock.setTimer(this.#o.helloTimeoutMs, () => {
      this.#hello = undefined;
      if (!this.#stopped) this.#o.onTimeout('hello');
    });
    this.#armPing();
  }

  /** A valid `hello` arrived: the hello timer stops and the idle timer starts. */
  helloReceived(): void {
    this.#hello?.cancel();
    this.#hello = undefined;
    this.appFrame();
    this.#armIdle();
  }

  /** Any application frame (not a pong). */
  appFrame(): void {
    this.#lastAppFrameAt = this.#o.clock.now();
  }

  pong(): void {
    this.#awaitingPong = false;
  }

  stop(): void {
    this.#stopped = true;
    this.#hello?.cancel();
    this.#idle?.cancel();
    this.#ping?.cancel();
  }

  #armIdle(): void {
    this.#idle?.cancel();
    const due = this.#lastAppFrameAt + this.#o.idleTimeoutMs;
    this.#idle = this.#o.clock.setTimer(due - this.#o.clock.now(), () => {
      this.#idle = undefined;
      if (this.#stopped) return;
      if (this.#o.clock.now() - this.#lastAppFrameAt >= this.#o.idleTimeoutMs)
        this.#o.onTimeout('idle');
      else this.#armIdle();
    });
  }

  #armPing(): void {
    this.#ping = this.#o.clock.setTimer(this.#o.pingMs, () => {
      this.#ping = undefined;
      if (this.#stopped) return;
      if (this.#awaitingPong) {
        this.#o.terminate();
        return;
      }
      this.#awaitingPong = true;
      this.#o.ping();
      this.#armPing();
    });
  }
}
