/**
 * The limiter: one bounded key store per class plus the optional global bucket (SRV-09).
 * Denials increment plotinium_rate_limited_total{class}.
 */
import { take, type Bucket, type TakeResult } from './bucket.ts';
import { KEYS_PER_CLASS, RATE_CLASSES, type RateClass, type RateClassName } from './classes.ts';
import { createKeyStore, type KeyStore } from './store.ts';

export interface RateLimiterOptions {
  readonly now?: () => number;
  readonly keysPerClass?: number;
  /** Replaces class specs (load-test profile; never a code path, §3.9). */
  readonly overrides?: Partial<Record<RateClassName, Partial<RateClass>>>;
  readonly onDenied?: (className: RateClassName) => void;
}

export class RateLimiter {
  readonly #stores = new Map<RateClassName, KeyStore<Bucket>>();
  readonly #global = createKeyStore<Bucket>(Object.keys(RATE_CLASSES).length);
  readonly #now: () => number;
  readonly #keysPerClass: number;
  readonly #options: RateLimiterOptions;

  constructor(options: RateLimiterOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#keysPerClass = options.keysPerClass ?? KEYS_PER_CLASS;
  }

  classOf(name: RateClassName): RateClass {
    return { ...RATE_CLASSES[name], ...this.#options.overrides?.[name] };
  }

  /** Takes `cost` tokens for `key` in class `name` (and from the class's global bucket, if any). */
  take(name: RateClassName, key: string, cost = 1): TakeResult {
    const cls = this.classOf(name);
    const now = this.#now();
    if (cls.global !== undefined) {
      const g = take(this.#global, name, cls.global, cost, now);
      if (!g.ok) return this.#deny(name, g);
    }
    const r = take(this.#store(name), key, cls.spec, cost, now);
    return r.ok ? r : this.#deny(name, r);
  }

  keysIn(name: RateClassName): number {
    return this.#stores.get(name)?.size ?? 0;
  }

  #store(name: RateClassName): KeyStore<Bucket> {
    let s = this.#stores.get(name);
    if (s === undefined) {
      s = createKeyStore<Bucket>(this.#keysPerClass);
      this.#stores.set(name, s);
    }
    return s;
  }

  #deny(name: RateClassName, r: TakeResult): TakeResult {
    this.#options.onDenied?.(name);
    return r;
  }
}
