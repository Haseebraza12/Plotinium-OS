/**
 * The retry policy of vfsTxn (DB-03, C7).
 *
 * Spec: specs/09-database/database.md §3.9.2: retryable SQLSTATEs 40001, 40P01, 55P03 (lock_timeout
 * 2 s) and LockSetChanged; at most 5 attempts in total; the delay before attempt n (n >= 2) is
 * random(0, min(250, 10 * 2^n)) ms (full jitter); every attempt is a fresh transaction; the
 * AbortSignal is checked before each attempt and a cancelled op is never retried.
 */
import { RETRYABLE_SQLSTATES, sqlstate } from '../db/errors.ts';
import { LockSetChanged, type Uid } from './types.ts';

export const MAX_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 250;

/** Full-jitter delay in ms before attempt `attempt` (>= 2). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 10 * 2 ** attempt);
  return random() * cap;
}

export interface RetryInfo {
  /** The attempt that just failed (1-based). */
  readonly attempt: number;
  /** '40001' | '40P01' | '55P03' | 'lockset'. */
  readonly cause: string;
  readonly delayMs: number;
}

export interface RetryOptions {
  readonly signal: AbortSignal;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: RetryInfo) => void;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt(n, extraOwners)` until it succeeds, fails with a non-retryable error, or the
 * attempt budget is spent. The LAST error is rethrown unchanged; the caller maps it with toErrno.
 * `extraOwners` accumulates the owners reported by LockSetChanged, so the restarted attempt takes
 * the larger L1 set (database.md §3.8).
 */
export async function runWithRetries<T>(
  attempt: (n: number, extraOwners: readonly Uid[]) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const max = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  let extraOwners: readonly Uid[] = [];
  for (let n = 1; ; n++) {
    options.signal.throwIfAborted(); // a killed op is never (re)started
    try {
      return await attempt(n, extraOwners);
    } catch (e) {
      let cause: string | undefined;
      if (e instanceof LockSetChanged) {
        cause = 'lockset';
        extraOwners = [...new Set([...extraOwners, ...e.owners])].sort((a, b) => a - b);
      } else {
        const code = sqlstate(e);
        if (code !== undefined && RETRYABLE_SQLSTATES.has(code)) cause = code;
      }
      if (cause === undefined || n >= max || options.signal.aborted) throw e;
      const delayMs = backoffMs(n + 1, options.random);
      options.onRetry?.({ attempt: n, cause, delayMs });
      await sleep(delayMs);
    }
  }
}
