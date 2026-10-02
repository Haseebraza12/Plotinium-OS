/**
 * Full-jitter back-off (offline-and-sync.md §3.7 rule 1, §5.5; C6, SYN-10). After the n-th
 * consecutive failure (n from 0) wait `random(0, min(CAP, BASE × 2^n))`, BASE 500 ms, CAP 30 s
 * (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). Per close code:
 * 1012 resets the exponent, 1013 waits at least 5 s, 4429 and a pending `throttle` wait at least
 * `retryAfterMs`, 4508 reconnects at once the first time.
 */
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, CLOSE_CODES } from '@plotinium/protocol';

/** Uniform draw in [0, 1). */
export type Rng = () => number;

/** The full-jitter draw alone: `random(0, min(CAP, BASE × 2^n))`. */
export function fullJitter(n: number, rnd: Rng = Math.random): number {
  const exp = Math.max(0, Math.min(n, 30));
  return rnd() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
}

/** §5.5 verbatim: the delay before the next CONNECTING after failure `n` with `closeCode`. */
export function nextDelayMs(
  n: number,
  closeCode: number | null,
  retryAfterMs = 0,
  rnd: Rng = Math.random,
): number {
  if (closeCode === CLOSE_CODES.SLOW_CONSUMER.code && n === 0) return 0;
  const base = closeCode === CLOSE_CODES.SERVICE_RESTART.code ? 0 : n;
  const draw = fullJitter(base, rnd);
  if (closeCode === CLOSE_CODES.TRY_AGAIN_LATER.code) return Math.max(5_000, draw);
  return Math.max(retryAfterMs, draw);
}
