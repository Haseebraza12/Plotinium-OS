/**
 * The token bucket (backend-api.md §3.9 and §5.2, SRV-09). O(1) time and memory per key.
 *
 * On a request of cost c at time now (ms):
 *   tokens := min(capacity, tokens + (now - last) * rate); last := now
 *   if tokens >= c: tokens -= c and allow; else deny with retryAfterMs = ceil((c - tokens) / rate)
 * A new key starts full. Property (tested with fast-check): in any window of length T the
 * allowed cost is at most capacity + rate * T.
 */
import type { KeyStore } from './store.ts';

export interface Bucket {
  tokens: number;
  last: number;
}

export interface BucketSpec {
  /** Tokens added per millisecond. */
  readonly ratePerMs: number;
  /** Maximum tokens (the burst). */
  readonly capacity: number;
}

export type TakeResult =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

export function take(
  store: KeyStore<Bucket>,
  key: string,
  spec: BucketSpec,
  cost: number,
  now: number,
): TakeResult {
  const b = store.get(key) ?? { tokens: spec.capacity, last: now };
  const elapsed = Math.max(0, now - b.last); // a clock that goes backwards never mints tokens
  b.tokens = Math.min(spec.capacity, b.tokens + elapsed * spec.ratePerMs);
  b.last = Math.max(b.last, now);
  store.put(key, b);
  if (b.tokens >= cost) {
    b.tokens -= cost;
    return { ok: true };
  }
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil((cost - b.tokens) / spec.ratePerMs)) };
}

/** `n` events per `periodMs`, bursting to `capacity`. */
export function perPeriod(n: number, periodMs: number, capacity: number = n): BucketSpec {
  return { ratePerMs: n / periodMs, capacity };
}
