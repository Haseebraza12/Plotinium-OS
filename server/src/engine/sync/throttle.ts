/**
 * The per-connection frame bucket (offline-and-sync.md §3.9 step 5, §4.5 4429, §4.6 FRAME_BUCKET;
 * backend-api.md §3.9; SYN-06): 50 frames/s with a burst of 200.
 *
 * When the bucket is empty the server sends `throttle {retryAfterMs, scope: 'frames'}` and pauses
 * reading the socket for retryAfterMs; the frame that found the bucket empty is still processed
 * (dropping it would strand an op without a result). Replay traffic (the op lane) is NEVER a
 * reason to disconnect: the credit window already bounds it. Only non-replay abuse closes: a
 * control-lane frame that arrives while a throttle is in force counts as "throttle ignored", and
 * three of those within 10 s close the socket with `bye rate-limited` and 4429.
 */
import { FRAME_BUCKET } from '@plotinium/protocol';

import { take, type Bucket, type BucketSpec } from '../../ratelimit/bucket.ts';
import type { KeyStore } from '../../ratelimit/store.ts';
import type { Clock } from './clock.ts';

export type Admit =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'throttle';
      readonly retryAfterMs: number;
      /** Send a `throttle` frame (once per throttle window, not once per frame). */
      readonly notify: boolean;
    }
  | { readonly kind: 'close'; readonly retryAfterMs: number };

export interface FrameThrottleOptions {
  readonly clock: Clock;
  readonly ratePerSecond?: number;
  readonly burst?: number;
  readonly ignoredLimit?: number;
  readonly ignoredWindowMs?: number;
}

/** A key store with a single bucket: the connection's own. */
class OneBucket implements KeyStore<Bucket> {
  #bucket: Bucket | undefined;
  readonly capacity = 1;

  get(): Bucket | undefined {
    return this.#bucket;
  }

  put(_key: string, value: Bucket): undefined {
    this.#bucket = value;
    return undefined;
  }

  delete(): boolean {
    const had = this.#bucket !== undefined;
    this.#bucket = undefined;
    return had;
  }

  get size(): number {
    return this.#bucket === undefined ? 0 : 1;
  }
}

export class FrameThrottle {
  readonly #clock: Clock;
  readonly #spec: BucketSpec;
  readonly #store = new OneBucket();
  readonly #ignoredLimit: number;
  readonly #ignoredWindowMs: number;
  #throttledUntil = 0;
  #ignored: number[] = [];

  constructor(options: FrameThrottleOptions) {
    this.#clock = options.clock;
    const rate = options.ratePerSecond ?? FRAME_BUCKET.ratePerSecond;
    this.#spec = { ratePerMs: rate / 1000, capacity: options.burst ?? FRAME_BUCKET.burst };
    this.#ignoredLimit = options.ignoredLimit ?? 3;
    this.#ignoredWindowMs = options.ignoredWindowMs ?? 10_000;
  }

  /** One inbound frame on `lane`. */
  admit(lane: 'op' | 'control'): Admit {
    const now = this.#clock.now();
    const inForce = now < this.#throttledUntil;
    if (inForce && lane === 'control') {
      this.#ignored = this.#ignored.filter((t) => now - t < this.#ignoredWindowMs);
      this.#ignored.push(now);
      if (this.#ignored.length >= this.#ignoredLimit) {
        return { kind: 'close', retryAfterMs: Math.max(1, this.#throttledUntil - now) };
      }
    }
    const r = take(this.#store, 'conn', this.#spec, 1, now);
    if (r.ok) return { kind: 'ok' };
    const retryAfterMs = Math.min(60_000, Math.max(1, r.retryAfterMs));
    const notify = !inForce;
    this.#throttledUntil = Math.max(this.#throttledUntil, now + retryAfterMs);
    return { kind: 'throttle', retryAfterMs, notify };
  }
}
