/**
 * Back-off schedule for failed non-critical services (boot-and-services.md §5.3, SVC-04):
 * d_n = min(60 000, 500 · 2^(n−1)) ms for attempt n ≥ 1, with equal jitter, so the actual delay
 * is d_n/2 + U·d_n/2 with U uniform in [0, 1): 0.25–0.5 s, 0.5–1 s, 1–2 s, … up to 30–60 s. The
 * random source is seeded per boot so tests can fix it. Every delay is a kernel timer-heap entry.
 */
import { mulberry32 } from '@plotinium/dsa';

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 60_000;

/** The un-jittered schedule d_n. */
export function backoffCeiling(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** The jittered delay for attempt n with `u` in [0, 1). */
export function backoffDelay(attempt: number, u: number): number {
  const d = backoffCeiling(attempt);
  return d / 2 + Math.min(Math.max(u, 0), 1 - Number.EPSILON) * (d / 2);
}

/** A per-boot seeded uniform source. */
export function seededRandom(seed: number): () => number {
  return mulberry32(seed);
}
